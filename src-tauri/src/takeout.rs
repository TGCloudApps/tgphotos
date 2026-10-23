//! Import a Google Photos takeout (the downloaded .zip files, or the folders already extracted).
//!
//! - The read merges ALL chosen parts: Google splits a photo from its JSON
//!   into different parts, so the matching (photo ↔ JSON) is done after
//!   reading everything.
//! - From the JSON come the photo date, the location, favorite and archived. Folders that are
//!   not "Photos from YYYY" become albums.
//! - The upload runs in the background (one import at a time); the UI
//!   polls `status`. It can stop and continue: what was already uploaded is remembered in
//!   `takeout-<vault>.json` and, either way, the same content (sha256) is never
//!   uploaded twice.

use tg_core::codes as c;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tg_core::Telegram;

use crate::db::Db;
use crate::{backup, meta};

type Res<T> = Result<T, String>;

/// What Google stores for each photo in the JSON next to it.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
struct Side {
    /// Photo time (s, UTC).
    taken: Option<i64>,
    gps: Option<(f64, f64)>,
    favorite: bool,
    archived: bool,
    trashed: bool,
}

#[derive(Clone, Debug)]
enum Src {
    File(PathBuf),
    Zip { zip: usize, name: String },
}

struct Raw {
    folder: String,
    name: String,
    size: u64,
    src: Src,
}

#[derive(Clone, Serialize, Deserialize)]
struct RawSide {
    folder: String,
    file: String,
    title: String,
    side: Side,
}

struct Entry {
    /// "folder/file": identifies the item between one round and another.
    key: String,
    name: String,
    mime: String,
    size: u64,
    src: Src,
    side: Option<Side>,
    /// Album (folder name), if the folder is not "Photos from YYYY".
    album: Option<String>,
    archived_folder: bool,
    edited: bool,
}

/// One entry of the "what you chose" list (a .zip or a folder).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub name: String,
    pub path: String,
    /// "zip" | "pasta"
    pub kind: &'static str,
    pub media: usize,
    pub bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct AlbumInfo {
    pub name: String,
    pub count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub sources: Vec<SourceInfo>,
    pub photos: usize,
    pub videos: usize,
    pub bytes: u64,
    pub albums: Vec<AlbumInfo>,
    pub favorites: usize,
    pub archived: usize,
    pub edited: usize,
    /// Photos/videos without the Google JSON (the date comes from the EXIF or the name).
    pub without_side: usize,
    pub sidecars: usize,
    /// Already in the vault, imported before without the JSON, and whose JSON is in these files.
    pub fixable: usize,
    /// Already imported before (previous round on this vault).
    pub done_before: usize,
    pub first_year: Option<i32>,
    pub last_year: Option<i32>,
}

struct Index {
    zips: Vec<PathBuf>,
    items: Vec<Entry>,
    map: SideMap,
    /// JSONs read (with or without a photo in the same takeout).
    sidecars: usize,
}

// ---- reading -----------------------------------------------------------------

fn lower(s: &str) -> String {
    s.to_lowercase()
}

fn is_gp(name: &str) -> bool {
    matches!(lower(name).as_str(), "google fotos" | "google photos")
}

/// "Takeout/Google Photos/<folder>/<file>" → (folder, file).
fn split_gp(path: &str) -> Option<(String, String)> {
    let comps: Vec<&str> = path.split('/').filter(|c| !c.is_empty()).collect();
    let i = comps.iter().position(|c| is_gp(c))?;
    let rest = &comps[i + 1..];
    (rest.len() == 2).then(|| (rest[0].to_string(), rest[1].to_string()))
}

fn is_media(name: &str) -> bool {
    let m = backup::mime_of(name);
    m.starts_with("image/") || m.starts_with("video/")
}

/// "name(2)" → ("name", 2); without a number, 0.
fn split_dup(stem: &str) -> (&str, u32) {
    if let Some(s) = stem.strip_suffix(')') {
        if let Some(i) = s.rfind('(') {
            if let Ok(n) = s[i + 1..].parse::<u32>() {
                return (&s[..i], n);
            }
        }
    }
    (stem, 0)
}

fn parse_side(j: &serde_json::Value) -> Side {
    let ts = |k: &str| j.get(k).and_then(|v| v.get("timestamp")).and_then(|t| t.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| t.as_i64()));
    let geo = |k: &str| {
        let g = j.get(k)?;
        let (la, lo) = (g.get("latitude")?.as_f64()?, g.get("longitude")?.as_f64()?);
        (la != 0.0 || lo != 0.0).then_some((la, lo))
    };
    let flag = |k: &str| j.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    Side {
        taken: ts("photoTakenTime").filter(|t| *t > 0).or_else(|| ts("creationTime").filter(|t| *t > 0)),
        gps: geo("geoDataExif").or_else(|| geo("geoData")),
        favorite: flag("favorited"),
        archived: flag("archived"),
        trashed: flag("trashed"),
    }
}

fn is_sidecar(file: &str) -> bool {
    let l = lower(file);
    l.ends_with(".json") && !matches!(l.as_str(), "metadados.json" | "metadata.json")
}

fn side_of(folder: &str, file: &str, bytes: &[u8]) -> Option<RawSide> {
    let j: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let title = j.get("title")?.as_str()?.to_string();
    Some(RawSide { folder: folder.to_string(), file: file.to_string(), title, side: parse_side(&j) })
}

#[derive(Default)]
struct Collected {
    zips: Vec<PathBuf>,
    files: Vec<Raw>,
    sides: Vec<RawSide>,
    sources: Vec<SourceInfo>,
}

fn google_dirs(root: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if is_gp(&name) {
        out.push(root.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(root) {
        let mut dirs: Vec<_> = rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).map(|e| e.path()).collect();
        dirs.sort();
        for d in dirs {
            google_dirs(&d, depth - 1, out);
        }
    }
}

impl Collected {
    fn add_dir(&mut self, gdir: &Path) {
        let Ok(rd) = std::fs::read_dir(gdir) else { return };
        for folder in rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()) {
            let fname = folder.file_name().to_string_lossy().to_string();
            let Ok(rd2) = std::fs::read_dir(folder.path()) else { continue };
            for f in rd2.filter_map(|e| e.ok()) {
                let Ok(md) = f.metadata() else { continue };
                if !md.is_file() {
                    continue;
                }
                let n = f.file_name().to_string_lossy().to_string();
                if is_sidecar(&n) {
                    if let Some(s) = std::fs::read(f.path()).ok().and_then(|b| side_of(&fname, &n, &b)) {
                        self.sides.push(s);
                    }
                } else if is_media(&n) {
                    self.files.push(Raw { folder: fname.clone(), name: n, size: md.len(), src: Src::File(f.path()) });
                }
            }
        }
    }

    fn add_zip(&mut self, handle: Option<&AppHandle>, path: &Path) -> Res<()> {
        let f = open_zip_file(handle, path)?;
        let mut ar = zip::ZipArchive::new(f).map_err(|e| c::code(c::INVALID_ZIP, format!("{}: {e}", path.display())))?;
        let zi = self.zips.len();
        self.zips.push(path.to_path_buf());
        for i in 0..ar.len() {
            let (name, size, is_file) = match ar.by_index_raw(i) {
                Ok(e) => (e.name().to_string(), e.size(), e.is_file()),
                Err(_) => continue,
            };
            if !is_file {
                continue;
            }
            let Some((folder, file)) = split_gp(&name) else { continue };
            if is_sidecar(&file) {
                if size > 4 << 20 {
                    continue;
                }
                let mut buf = Vec::new();
                if let Ok(mut e) = ar.by_index(i) {
                    let _ = e.read_to_end(&mut buf);
                }
                if let Some(s) = side_of(&folder, &file, &buf) {
                    self.sides.push(s);
                }
            } else if is_media(&file) {
                self.files.push(Raw { folder, name: file, size, src: Src::Zip { zip: zi, name } });
            }
        }
        Ok(())
    }
}

fn is_uri(p: &Path) -> bool {
    let s = p.to_string_lossy();
    s.starts_with("content://") || s.starts_with("file://")
}

/// Opens the .zip: disk path or Android URI (file picker).
fn open_zip_file(handle: Option<&AppHandle>, path: &Path) -> Res<std::fs::File> {
    match handle {
        Some(h) => tg_app::transfers::open_local(h, &path.to_string_lossy()),
        None => std::fs::File::open(path).map_err(|e| c::code(c::FILE_OPEN_FAILED, format!("{}: {e}", path.display()))),
    }
}

fn collect(handle: Option<&AppHandle>, paths: &[PathBuf], names: &HashMap<String, String>) -> Res<Collected> {
    let mut c = Collected::default();
    for p in paths {
        let (before, bytes_before) = (c.files.len(), c.files.iter().map(|f| f.size).sum::<u64>());
        let name = names.get(p.to_string_lossy().as_ref()).cloned().or_else(|| p.file_name().map(|n| n.to_string_lossy().to_string())).unwrap_or_else(|| p.display().to_string());
        // Android URI: .zip only (there is no real folder to walk).
        let is_zip = is_uri(p) || (p.is_file() && lower(&name).ends_with(".zip"));
        if is_zip {
            c.add_zip(handle, p)?;
        } else if p.is_dir() {
            // A folder with the takeout .zip files (e.g. Downloads) or already extracted.
            let mut zips: Vec<PathBuf> = std::fs::read_dir(p)
                .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|f| f.is_file() && lower(&f.file_name().unwrap_or_default().to_string_lossy()).starts_with("takeout") && lower(&f.to_string_lossy()).ends_with(".zip")).collect())
                .unwrap_or_default();
            zips.sort();
            for z in &zips {
                c.add_zip(handle, z)?;
            }
            let mut gd = Vec::new();
            google_dirs(p, 4, &mut gd);
            for g in &gd {
                c.add_dir(g);
            }
            if zips.is_empty() && gd.is_empty() {
                return Err(c::code(c::NO_TAKEOUT, name));
            }
        } else {
            return Err(c::code(c::NOT_FOLDER_OR_ZIP, name));
        }
        let bytes = c.files.iter().map(|f| f.size).sum::<u64>() - bytes_before;
        c.sources.push(SourceInfo { name, path: p.to_string_lossy().to_string(), kind: if is_zip { "zip" } else { "pasta" }, media: c.files.len() - before, bytes });
    }
    Ok(c)
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Year,
    Album,
    Archive,
    Trash,
    /// Imports, but without an album (profile, videos that failed…).
    Plain,
}

fn is_year_folder(name: &str) -> bool {
    let n = lower(name);
    let tail = n.strip_prefix("fotos de ").or_else(|| n.strip_prefix("photos from "));
    tail.is_some_and(|t| t.len() == 4 && t.chars().all(|c| c.is_ascii_digit()))
}

fn kind_of(folder: &str) -> Kind {
    match lower(folder).as_str() {
        "arquivar" | "arquivo" | "archive" => Kind::Archive,
        "lixeira" | "trash" | "bin" => Kind::Trash,
        "fotos do perfil" | "profile photos" | "vídeos que falharam" | "failed videos" => Kind::Plain,
        _ if is_year_folder(folder) => Kind::Year,
        _ => Kind::Album,
    }
}

/// The Google JSONs, to find the one for each photo (from the current takeout or one already imported).
#[derive(Default)]
struct SideMap {
    /// (folder, title, repetition) → metadata.
    exact: HashMap<(String, String, u32), Side>,
    by_title: HashMap<(String, u32), Vec<Side>>,
}

impl SideMap {
    fn new(sides: Vec<RawSide>) -> Self {
        let mut m = SideMap::default();
        for s in sides {
            let (_, dup) = split_dup(s.file.trim_end_matches(".json").trim_end_matches(".JSON"));
            m.by_title.entry((lower(&s.title), dup)).or_default().push(s.side.clone());
            m.exact.insert((s.folder, lower(&s.title), dup), s.side);
        }
        m
    }

    /// The metadata of "folder/name". `-edited` uses the JSON of the original.
    fn find(&self, folder: &str, name: &str) -> Option<Side> {
        let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
        let stem = stem.strip_suffix("-editado").or_else(|| stem.strip_suffix("-edited")).unwrap_or(stem);
        let (base, dup) = split_dup(stem);
        let title = lower(&format!("{base}.{ext}"));
        self.exact.get(&(folder.to_string(), title.clone(), dup)).cloned().or_else(|| {
            // The same photo in another folder (year and album), if all agree on the date.
            let v = self.by_title.get(&(title, dup))?;
            let first = v.first()?;
            v.iter().all(|s| s.taken == first.taken).then(|| first.clone())
        })
    }
}

fn build(c: Collected) -> Index {
    let sidecars = c.sides.len();
    let map = SideMap::new(c.sides);
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for r in c.files {
        let key = format!("{}/{}", r.folder, r.name);
        if !seen.insert(key.clone()) {
            continue; // the same folder in two parts
        }
        let (stem, _) = r.name.rsplit_once('.').unwrap_or((&r.name, ""));
        let edited = stem.ends_with("-editado") || stem.ends_with("-edited");
        let side = map.find(&r.folder, &r.name);
        let (album, archived_folder) = match kind_of(&r.folder) {
            Kind::Trash => continue,
            Kind::Album => (Some(r.folder.clone()), false),
            Kind::Archive => (None, true),
            Kind::Year | Kind::Plain => (None, false),
        };
        if side.as_ref().is_some_and(|s| s.trashed) {
            continue;
        }
        items.push(Entry { key, mime: backup::mime_of(&r.name), name: r.name, size: r.size, src: r.src, side, album, archived_folder, edited });
    }
    items.sort_by(|a, b| a.key.cmp(&b.key));
    Index { zips: c.zips, items, map, sidecars }
}

/// Items already in the vault that came in without the JSON and whose JSON is now in the index.
fn pending_fixes(ix: &Index, done: &Progress) -> Vec<(String, i64, Side)> {
    let mut v: Vec<_> = done
        .media
        .iter()
        .filter(|(_, d)| !d.side)
        .filter_map(|(key, d)| {
            let (folder, name) = key.split_once('/')?;
            let side = ix.map.find(folder, name).filter(|s| !s.trashed)?;
            Some((key.clone(), d.id, side))
        })
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

fn summarize(ix: &Index, sources: Vec<SourceInfo>, done: &Progress) -> Summary {
    let mut albums: HashMap<&str, usize> = HashMap::new();
    for it in &ix.items {
        if let Some(a) = &it.album {
            *albums.entry(a.as_str()).or_default() += 1;
        }
    }
    let mut albums: Vec<AlbumInfo> = albums.into_iter().map(|(name, count)| AlbumInfo { name: name.to_string(), count }).collect();
    albums.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.cmp(&b.name)));
    let videos = ix.items.iter().filter(|i| i.mime.starts_with("video/")).count();
    let years = ix.items.iter().filter_map(|i| i.side.as_ref()?.taken).map(|t| 1970 + (t / 31_556_952) as i32);
    Summary {
        sources,
        photos: ix.items.len() - videos,
        videos,
        bytes: ix.items.iter().map(|i| i.size).sum(),
        albums,
        favorites: ix.items.iter().filter(|i| i.side.as_ref().is_some_and(|s| s.favorite)).count(),
        archived: ix.items.iter().filter(|i| i.archived_folder || i.side.as_ref().is_some_and(|s| s.archived)).count(),
        edited: ix.items.iter().filter(|i| i.edited).count(),
        without_side: ix.items.iter().filter(|i| i.side.is_none()).count(),
        sidecars: ix.sidecars,
        fixable: pending_fixes(ix, done).len(),
        done_before: ix.items.iter().filter(|i| done.media.contains_key(&i.key)).count(),
        first_year: years.clone().min(),
        last_year: years.max(),
    }
}

// ---- state and execution ---------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
struct Progress {
    /// "folder/file" → vault media.
    media: HashMap<String, Done>,
    /// Album name → vault album.
    albums: HashMap<String, i64>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Done {
    id: i64,
    /// Came in already with the Google JSON (otherwise, a future round fixes the date).
    side: bool,
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Opts {
    /// Do not import the "-edited" copies.
    #[serde(default)]
    pub skip_edited: bool,
    /// Create albums from the folders.
    #[serde(default = "yes")]
    pub albums: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// idle | running | stopping | stopped | done | error
    pub state: &'static str,
    pub total: usize,
    pub done: usize,
    pub reused: usize,
    pub failed: usize,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub current: Option<String>,
    pub error: Option<String>,
    pub errors: Vec<String>,
    pub favorites: usize,
    pub archived: usize,
    pub albums_made: usize,
    pub albums_total: usize,
    /// Items already in the vault that gained date, location and favorites from the JSON.
    pub fixed: usize,
    /// Already imported in previous rounds.
    pub before: usize,
    pub elapsed_ms: u64,
    /// "Organizing albums and favorites…" after the upload.
    pub finishing: bool,
}

#[derive(Default)]
pub struct Takeout {
    index: Mutex<Option<Arc<Index>>>,
    sources: Mutex<Vec<SourceInfo>>,
    status: Arc<Mutex<Status>>,
    stop: Arc<AtomicBool>,
}

fn progress_path(dir: &Path, vault: &str) -> PathBuf {
    dir.join(format!("takeout-{vault}.json"))
}

/// The JSONs of all parts already read on this vault: the photo may come in one part and its JSON in another.
fn sides_path(dir: &Path, vault: &str) -> PathBuf {
    dir.join(format!("takeout-sides-{vault}.json"))
}

/// Merges the stored JSONs with those of the current takeout and stores the result.
fn merge_sides(dir: &Path, vault: &str, fresh: Vec<RawSide>) -> Vec<RawSide> {
    let path = sides_path(dir, vault);
    let mut all: Vec<RawSide> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let known: HashSet<(String, String)> = all.iter().map(|s| (s.folder.clone(), s.file.clone())).collect();
    let new: Vec<RawSide> = fresh.into_iter().filter(|s| !known.contains(&(s.folder.clone(), s.file.clone()))).collect();
    if !new.is_empty() {
        all.extend(new);
        let _ = std::fs::write(&path, serde_json::to_vec(&all).unwrap_or_default());
    }
    all
}

fn load_progress(dir: &Path, vault: &str) -> Progress {
    std::fs::read(progress_path(dir, vault)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

impl Takeout {
    /// Reads what the user chose (without touching Telegram or the vault).
    pub async fn scan(&self, handle: AppHandle, paths: Vec<String>, names: HashMap<String, String>, dir: PathBuf, vault: Option<String>) -> Res<Summary> {
        if self.running() {
            return Err(c::IMPORT_RUNNING.into());
        }
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        let (vault2, dir2) = (vault.clone(), dir.clone());
        let (ix, sources) = tokio::task::spawn_blocking(move || -> Res<_> {
            let mut c = collect(Some(&handle), &paths, &names)?;
            let sources = c.sources.clone();
            let found = c.sides.len();
            if let Some(v) = &vault2 {
                c.sides = merge_sides(&dir2, v, std::mem::take(&mut c.sides));
            }
            let mut ix = build(c);
            ix.sidecars = found;
            Ok((ix, sources))
        })
        .await
        .map_err(|e| e.to_string())??;
        let done = vault.map(|v| load_progress(&dir, &v)).unwrap_or_default();
        if ix.items.is_empty() && pending_fixes(&ix, &done).is_empty() {
            return Err(if ix.sidecars > 0 {
                "esses arquivos só têm as informações do Google (JSON), e nenhuma foto importada antes combina com elas".into()
            } else {
                "não achei fotos nem vídeos do Google Fotos nesses arquivos".into()
            });
        }
        let s = summarize(&ix, sources.clone(), &done);
        *self.index.lock().unwrap() = Some(Arc::new(ix));
        *self.sources.lock().unwrap() = sources;
        Ok(s)
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn running(&self) -> bool {
        matches!(self.status.lock().unwrap().state, "running" | "stopping")
    }

    pub fn stop(&self) {
        if self.running() {
            self.stop.store(true, Ordering::Relaxed);
            self.status.lock().unwrap().state = "stopping";
        }
    }

    /// Goes back to the start (after seeing the result).
    pub fn reset(&self) {
        if !self.running() {
            *self.status.lock().unwrap() = Status::default();
            *self.index.lock().unwrap() = None;
        }
    }

    pub fn start(&self, opts: Opts, handle: AppHandle, tg: Arc<Telegram>, vaults: Arc<tg_app::Vaults<Db>>, transfers: Arc<tg_app::Transfers<Db>>) -> Res<()> {
        if self.running() {
            return Err(c::IMPORT_RUNNING.into());
        }
        let ix = self.index.lock().unwrap().clone().ok_or(c::NO_TAKEOUT)?;
        vaults.check_write().map_err(|e| e.to_string())?;
        let open = vaults.current().ok_or(c::NO_VAULT_OPEN)?;
        self.stop.store(false, Ordering::Relaxed);
        *self.status.lock().unwrap() = Status { state: "running", ..Default::default() };
        let (status, stop) = (Arc::clone(&self.status), Arc::clone(&self.stop));
        tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let r = run(&ix, opts, &handle, &tg, &vaults, &transfers, &open.vault_id, Arc::clone(&open.db), &status, &stop, started).await;
            transfers.external(None);
            let mut s = status.lock().unwrap();
            s.finishing = false;
            s.current = None;
            s.elapsed_ms = started.elapsed().as_millis() as u64;
            match r {
                Ok(stopped) => s.state = if stopped { "stopped" } else { "done" },
                Err(e) => {
                    s.state = "error";
                    s.error = Some(e);
                }
            }
            vaults.kick();
        });
        Ok(())
    }
}

/// Minimum gap between uploads to Telegram, counting the simultaneous ones.
struct Pace(tokio::sync::Mutex<Option<Instant>>);

impl Pace {
    async fn wait(&self) {
        const GAP: std::time::Duration = std::time::Duration::from_millis(600);
        let mut last = self.0.lock().await;
        if let Some(t) = *last {
            let wait = GAP.saturating_sub(t.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        *last = Some(Instant::now());
    }
}

/// `true` = stopped on request; `false` = finished everything.
#[allow(clippy::too_many_arguments)]
async fn run(
    ix: &Arc<Index>,
    opts: Opts,
    handle: &AppHandle,
    tg: &Arc<Telegram>,
    vaults: &Arc<tg_app::Vaults<Db>>,
    transfers: &Arc<tg_app::Transfers<Db>>,
    vault_id: &str,
    db: Arc<Db>,
    status: &Arc<Mutex<Status>>,
    stop: &Arc<AtomicBool>,
    started: Instant,
) -> Res<bool> {
    let dir = vaults.dir().clone();
    let progress = Arc::new(Mutex::new(load_progress(&dir, vault_id)));
    let save = {
        let (progress, path) = (Arc::clone(&progress), progress_path(&dir, vault_id));
        Arc::new(move || {
            let bytes = serde_json::to_vec(&*progress.lock().unwrap()).unwrap_or_default();
            let _ = std::fs::write(&path, bytes);
        })
    };
    let wanted: Vec<usize> = (0..ix.items.len()).filter(|i| !(opts.skip_edited && ix.items[*i].edited)).collect();
    let todo: Vec<usize> = {
        let p = progress.lock().unwrap();
        let mut t: Vec<usize> = wanted.iter().copied().filter(|i| !p.media.contains_key(&ix.items[*i].key)).collect();
        // Smallest first: more media arrive soon, the large ones stay at the end.
        t.sort_by_key(|i| (ix.items[*i].size, *i));
        t
    };
    {
        let mut s = status.lock().unwrap();
        s.total = todo.len();
        s.bytes_total = todo.iter().map(|i| ix.items[*i].size).sum();
        s.before = wanted.len() - todo.len();
    }
    let tmp = std::env::temp_dir().join("tgphotos-takeout");
    let _ = std::fs::create_dir_all(&tmp);
    let gate = Arc::new(tokio::sync::Semaphore::new(2));
    let pace = Arc::new(Pace(tokio::sync::Mutex::new(None)));
    let locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = Arc::default();
    let fatal: Arc<Mutex<Option<String>>> = Arc::default();
    let mut set = tokio::task::JoinSet::new();
    for idx in todo {
        if stop.load(Ordering::Relaxed) || fatal.lock().unwrap().is_some() {
            break;
        }
        let permit = Arc::clone(&gate).acquire_owned().await.map_err(|e| e.to_string())?;
        if stop.load(Ordering::Relaxed) || fatal.lock().unwrap().is_some() {
            break;
        }
        // Switched vault in the middle: stop, otherwise the uploads would go to the wrong channel.
        if vaults.current().map(|o| o.vault_id.clone()).as_deref() != Some(vault_id) {
            *fatal.lock().unwrap() = Some("Você trocou de vault durante a importação. Volte para ele e continue.".into());
            break;
        }
        let (handle, transfers) = (handle.clone(), Arc::clone(transfers));
        let (tg, db, ix, status, progress, save, locks, pace, tmp, stop, fatal) =
            (Arc::clone(tg), Arc::clone(&db), Arc::clone(ix), Arc::clone(status), Arc::clone(&progress), Arc::clone(&save), Arc::clone(&locks), Arc::clone(&pace), tmp.clone(), Arc::clone(stop), Arc::clone(&fatal));
        set.spawn(async move {
            let _permit = permit;
            let e = &ix.items[idx];
            status.lock().unwrap().current = Some(e.name.clone());
            let res = import_one(&handle, &tg, &db, &locks, &pace, &ix, idx, &tmp, &stop).await;
            let mut s = status.lock().unwrap();
            s.elapsed_ms = started.elapsed().as_millis() as u64;
            s.done += 1;
            s.bytes_done += e.size;
            transfers.external(Some((s.bytes_done, s.bytes_total, tg_app::locale::takeout_progress(s.done as usize, s.total as usize))));
            match res {
                Ok((id, uploaded)) => {
                    if !uploaded {
                        s.reused += 1;
                    }
                    drop(s);
                    progress.lock().unwrap().media.insert(e.key.clone(), Done { id, side: e.side.is_some() });
                    if idx % 25 == 0 {
                        save();
                    }
                }
                Err(err) => {
                    if err.contains(c::PASSWORD_REQUIRED) || c::is(&err, c::UPDATE_REQUIRED) || err.contains("somente leitura")
 {
                        *fatal.lock().unwrap() = Some(err.clone());
                    }
                    s.failed += 1;
                    if s.errors.len() < 50 {
                        s.errors.push(format!("{}: {err}", e.key));
                    }
                }
            }
        });
    }
    while set.join_next().await.is_some() {}
    save();
    if let Some(e) = fatal.lock().unwrap().clone() {
        return Err(e);
    }
    let stopped = stop.load(Ordering::Relaxed);
    if stopped {
        return Ok(true);
    }

    // ---- favorites, archived, albums and fixed dates (including previous rounds) ----
    status.lock().unwrap().finishing = true;
    let map = progress.lock().unwrap().media.clone();
    let (mut favorites, mut archived) = (Vec::new(), Vec::new());
    let mut members: HashMap<&str, Vec<i64>> = HashMap::new();
    for i in &wanted {
        let it = &ix.items[*i];
        let Some(d) = map.get(&it.key) else { continue };
        if it.side.as_ref().is_some_and(|s| s.favorite) {
            favorites.push(d.id);
        }
        if it.archived_folder || it.side.as_ref().is_some_and(|s| s.archived) {
            archived.push(d.id);
        }
        if opts.albums {
            if let Some(a) = &it.album {
                members.entry(a.as_str()).or_default().push(d.id);
            }
        }
    }
    if !favorites.is_empty() {
        db.set_favorite(&favorites, true).map_err(|e| e.to_string())?;
    }
    if !archived.is_empty() {
        db.set_archived(&archived, true).map_err(|e| e.to_string())?;
    }
    // Came in before without the JSON (in another round or another part); now it has arrived.
    let (mut fixed, mut fix_fav, mut fix_arch) = (0, Vec::new(), Vec::new());
    let current = progress.lock().unwrap().clone();
    for (key, id, side) in pending_fixes(ix, &current) {
        let mut ok = true;
        if let Some(t) = side.taken {
            ok &= db.set_taken(id, t * 1000, None).is_ok();
        }
        if let Some((la, lo)) = side.gps {
            ok &= db.set_gps_if_missing(id, la, lo).is_ok();
        }
        if side.favorite {
            fix_fav.push(id);
        }
        if side.archived {
            fix_arch.push(id);
        }
        if ok {
            fixed += 1;
            if let Some(d) = progress.lock().unwrap().media.get_mut(&key) {
                d.side = true;
            }
        }
    }
    if !fix_fav.is_empty() {
        db.set_favorite(&fix_fav, true).map_err(|e| e.to_string())?;
    }
    if !fix_arch.is_empty() {
        db.set_archived(&fix_arch, true).map_err(|e| e.to_string())?;
    }
    let mut made = 0;
    let album_count = members.len();
    for (name, ids) in members {
        let existing = progress.lock().unwrap().albums.get(name).copied();
        let added = match existing {
            Some(a) => db.album_add(a, &ids).is_ok(),
            None => false,
        };
        if !added {
            // First time, or the album was deleted later: create it again.
            let a = db.album_create(name).map_err(|e| e.to_string())?;
            progress.lock().unwrap().albums.insert(name.to_string(), a);
            made += 1;
            db.album_add(a, &ids).map_err(|e| e.to_string())?;
        }
    }
    save();
    let mut s = status.lock().unwrap();
    s.favorites = favorites.len();
    s.archived = archived.len();
    s.albums_made = made;
    s.albums_total = album_count;
    s.fixed = fixed;
    Ok(false)
}

/// Takes the file out of the takeout (from the .zip, if that is the case) computing the sha256.
/// Returns the path, the sha256 and whether it is a temporary copy (to delete afterwards).
fn materialize(handle: Option<&AppHandle>, ix: &Index, e: &Entry, tmp: &Path) -> Res<(PathBuf, String, bool)> {
    match &e.src {
        Src::File(p) => {
            let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
            let mut h = Sha256::new();
            let mut buf = vec![0u8; 1 << 20];
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok((p.clone(), hex(&h.finalize()), false))
        }
        Src::Zip { zip, name } => {
            let f = open_zip_file(handle, &ix.zips[*zip])?;
            let mut ar = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
            let mut entry = ar.by_name(name).map_err(|e| e.to_string())?;
            let ext = e.name.rsplit_once('.').map(|(_, x)| x).unwrap_or("bin");
            let out = tmp.join(format!("{}.{ext}", ulid::Ulid::new()));
            let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            let mut h = Sha256::new();
            let mut buf = vec![0u8; 1 << 20];
            let res: Res<()> = (|| loop {
                let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(());
                }
                h.update(&buf[..n]);
                w.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            })();
            if let Err(err) = res {
                let _ = std::fs::remove_file(&out);
                return Err(err);
            }
            Ok((out, hex(&h.finalize()), true))
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Checks the sha256 and uploads to the vault (if it does not have it yet). `true` = uploaded now.
#[allow(clippy::too_many_arguments)]
async fn import_one(
    handle: &AppHandle,
    tg: &Arc<Telegram>,
    db: &Db,
    locks: &Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pace: &Pace,
    ix: &Arc<Index>,
    idx: usize,
    tmp: &Path,
    stop: &AtomicBool,
) -> Res<(i64, bool)> {
    let e = &ix.items[idx];
    if e.size == 0 {
        return Err(c::EMPTY_FILE.into());
    }
    let (ix2, tmp2, h2) = (Arc::clone(ix), tmp.to_path_buf(), handle.clone());
    let (path, sha, temp) = tokio::task::spawn_blocking(move || materialize(Some(&h2), &ix2, &ix2.items[idx], &tmp2)).await.map_err(|e| e.to_string())??;
    let result = upload(tg, db, locks, pace, e, &path, &sha, stop).await;
    if temp {
        let _ = std::fs::remove_file(&path);
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn upload(
    tg: &Arc<Telegram>,
    db: &Db,
    locks: &Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pace: &Pace,
    e: &Entry,
    path: &Path,
    sha: &str,
    stop: &AtomicBool,
) -> Res<(i64, bool)> {
    // One lock per content: the same photo in the year and in the album does not upload twice.
    let lock = Arc::clone(locks.lock().unwrap().entry(sha.to_string()).or_default());
    let _guard = lock.lock().await;
    if let Some(existing) = db.find_sha256(sha) {
        // Was it in the vault trash? It comes back: the takeout is the user's current wish.
        let _ = db.set_trashed(&[existing], false);
        return Ok((existing, false));
    }
    let pieces = retry(stop, || async {
        pace.wait().await;
        let mut reader = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
        tg.upload(&mut reader, e.size).await
    })
    .await?;
    // Date: EXIF → file name → Google's (better than that of the extracted file).
    let taken = e.side.as_ref().and_then(|s| s.taken).map(|s| s * 1000);
    let mut m = meta::read_with(std::fs::File::open(path).ok(), &e.name, &e.mime, taken);
    if m.gps.is_none() {
        m.gps = e.side.as_ref().and_then(|s| s.gps);
    }
    let media = db.insert(&e.name, &e.mime, e.size as i64, &pieces, Some(sha), &m, Some("Google Fotos")).map_err(|e| e.to_string())?;
    Ok((media.id, true))
}

/// Telegram pause (FLOOD_WAIT) waits the requested time; network and transient errors
/// wait 2, 4, 8… s (up to 6 attempts); the rest fails right away.
async fn retry<T, F, Fut>(stop: &AtomicBool, mut f: F) -> Res<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Res<T>>,
{
    let mut tries = 0u32;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                if let Some(secs) = tg_core::flood_wait(&e) {
                    for _ in 0..=secs {
                        if stop.load(Ordering::Relaxed) {
                            return Err(c::CANCELED.into());
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                    continue;
                }
                let transient = tg_core::is_network_error(&e) || e.contains("rpc error 5") || e.contains("FILE_REFERENCE") || e.contains("TIMEOUT");
                if transient && tries < 6 && !stop.load(Ordering::Relaxed) {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_secs(1u64 << tries)).await;
                    continue;
                }
                return Err(e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_inside_zip() {
        assert_eq!(split_gp("Takeout/Google Fotos/Fotos de 2019/a.jpg"), Some(("Fotos de 2019".into(), "a.jpg".into())));
        assert_eq!(split_gp("Takeout/Google Photos/Trip/a.jpg.json"), Some(("Trip".into(), "a.jpg.json".into())));
        assert_eq!(split_gp("Takeout/Google Fotos/a.json"), None);
        assert_eq!(split_gp("Takeout/Outro/x/a.jpg"), None);
    }

    #[test]
    fn repetition_in_name() {
        assert_eq!(split_dup("IMG_1(2)"), ("IMG_1", 2));
        assert_eq!(split_dup("IMG_1"), ("IMG_1", 0));
        assert_eq!(split_dup("a(b)"), ("a(b)", 0));
    }

    #[test]
    fn folders() {
        assert!(is_year_folder("Fotos de 2018"));
        assert!(!is_year_folder("Fotos de viagem"));
        assert!(kind_of("Arquivar") == Kind::Archive);
        assert!(kind_of("Lixeira") == Kind::Trash);
        assert!(kind_of("Aquele dia") == Kind::Album);
        assert!(kind_of("Fotos do perfil") == Kind::Plain);
    }

    fn raw(folder: &str, name: &str) -> Raw {
        Raw { folder: folder.into(), name: name.into(), size: 1, src: Src::File(PathBuf::from(name)) }
    }

    fn rs(folder: &str, file: &str, title: &str, ts: i64, fav: bool) -> RawSide {
        RawSide { folder: folder.into(), file: file.into(), title: title.into(), side: Side { taken: Some(ts), favorite: fav, ..Default::default() } }
    }

    #[test]
    fn json_arriving_later_fixes_what_already_entered() {
        // Part 2: only the JSONs, without the photos (they were in part 1).
        let c = Collected {
            sides: vec![
                rs("Fotos de 2019", "IMG_1.jpg.supplemental-metadata.json", "IMG_1.jpg", 100, true),
                rs("Fotos de 2019", "IMG_2.jpg.supplemental-metad.json", "IMG_2.jpg", 300, false),
            ],
            ..Default::default()
        };
        let ix = build(c);
        assert!(ix.items.is_empty());
        let mut done = Progress::default();
        done.media.insert("Fotos de 2019/IMG_1.jpg".into(), Done { id: 1, side: false });
        done.media.insert("Fotos de 2019/IMG_2-editado.jpg".into(), Done { id: 2, side: false });
        done.media.insert("Fotos de 2019/IMG_3.jpg".into(), Done { id: 3, side: false });
        done.media.insert("Fotos de 2019/IMG_1(1).jpg".into(), Done { id: 4, side: true });
        let f = pending_fixes(&ix, &done);
        // IMG_3 has no JSON; IMG_1(1) was already fixed.
        assert_eq!(f.iter().map(|x| (x.1, x.2.taken)).collect::<Vec<_>>(), vec![(1, Some(100)), (2, Some(300))]);
        assert!(f[0].2.favorite);
    }

    #[test]
    fn json_from_previous_part_applies_to_new_part_photo() {
        let dir = std::env::temp_dir().join(format!("tgphotos-sides-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        // Part 1: the photo and the JSON of IMG_1; the JSON of IMG_2 stayed here, the photo went to part 2.
        let p1 = merge_sides(&dir, "v", vec![rs("Fotos de 2019", "IMG_1.jpg.json", "IMG_1.jpg", 100, false), rs("Fotos de 2019", "IMG_2.jpg.json", "IMG_2.jpg", 200, true)]);
        assert_eq!(p1.len(), 2);
        // Part 2: only the photo IMG_2, without JSON. The stored JSON enters the index.
        let all = merge_sides(&dir, "v", vec![]);
        let ix = build(Collected { files: vec![raw("Fotos de 2019", "IMG_2.jpg")], sides: all, ..Default::default() });
        let it = &ix.items[0];
        assert_eq!(it.side.as_ref().unwrap().taken, Some(200));
        assert!(it.side.as_ref().unwrap().favorite);
        // Reading the same part again does not duplicate.
        assert_eq!(merge_sides(&dir, "v", vec![rs("Fotos de 2019", "IMG_1.jpg.json", "IMG_1.jpg", 100, false)]).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn matches_photo_and_json_across_parts() {
        let c = Collected {
            files: vec![raw("Fotos de 2019", "IMG_1.jpg"), raw("Fotos de 2019", "IMG_1(1).jpg"), raw("Viagem", "IMG_1.jpg"), raw("Fotos de 2019", "IMG_2-editado.jpg"), raw("Lixeira", "X.jpg")],
            sides: vec![
                rs("Fotos de 2019", "IMG_1.jpg.supplemental-metadata.json", "IMG_1.jpg", 100, true),
                rs("Fotos de 2019", "IMG_1.jpg.supplemental-metadata(1).json", "IMG_1.jpg", 200, false),
                rs("Fotos de 2019", "IMG_2.jpg.supplemental-metad.json", "IMG_2.jpg", 300, false),
            ],
            ..Default::default()
        };
        let ix = build(c);
        let by = |k: &str| ix.items.iter().find(|i| i.key == k).unwrap();
        assert_eq!(by("Fotos de 2019/IMG_1.jpg").side.as_ref().unwrap().taken, Some(100));
        assert_eq!(by("Fotos de 2019/IMG_1(1).jpg").side.as_ref().unwrap().taken, Some(200));
        // In the album there is no JSON of its own: it uses the one from the year (same photo, same date).
        assert_eq!(by("Viagem/IMG_1.jpg").side.as_ref().unwrap().taken, Some(100));
        assert_eq!(by("Viagem/IMG_1.jpg").album.as_deref(), Some("Viagem"));
        assert!(by("Fotos de 2019/IMG_2-editado.jpg").edited);
        assert_eq!(by("Fotos de 2019/IMG_2-editado.jpg").side.as_ref().unwrap().taken, Some(300));
        assert!(ix.items.iter().all(|i| !i.key.starts_with("Lixeira")));
    }

    /// With a real takeout: `TAKEOUT_TESTE=/path cargo test --lib takeout_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn takeout_real() {
        let p = std::env::var("TAKEOUT_TESTE").expect("TAKEOUT_TESTE");
        let t = Instant::now();
        let c = collect(None, &[PathBuf::from(p)], &HashMap::new()).unwrap();
        let (n_sides, sources) = (c.sides.len(), c.sources.clone());
        let ix = build(c);
        let s = summarize(&ix, sources, &Progress::default());
        println!("{} itens, {} sem JSON, {} JSONs, {} álbuns, {} favoritas, anos {:?}-{:?} em {:?}", ix.items.len(), s.without_side, n_sides, s.albums.len(), s.favorites, s.first_year, s.last_year, t.elapsed());
        for src in &s.sources {
            println!("  {} {} {} itens {} bytes", src.kind, src.name, src.media, src.bytes);
        }
    }
}
