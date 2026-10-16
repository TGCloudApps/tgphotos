//! Importar um takeout do Google Fotos (os .zip baixados, ou as pastas já extraídas).
//!
//! - A leitura junta TODAS as partes escolhidas: o Google separa a foto do JSON
//!   dela em partes diferentes, então o casamento (foto ↔ JSON) é feito depois
//!   de ler tudo.
//! - Do JSON vêm a data da foto, o local, favorita e arquivada. Pastas que não
//!   são "Fotos de AAAA" viram álbuns.
//! - O envio roda em segundo plano (uma importação por vez); a interface
//!   consulta `status`. Pode parar e continuar: o que já subiu é lembrado em
//!   `takeout-<vault>.json` e, de qualquer forma, o mesmo conteúdo (sha256) nunca
//!   sobe duas vezes.

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

/// O que o Google guarda de cada foto no JSON ao lado dela.
#[derive(Clone, Default, Debug, PartialEq)]
struct Side {
    /// Momento da foto (s, UTC).
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

struct RawSide {
    folder: String,
    file: String,
    title: String,
    side: Side,
}

struct Entry {
    /// "pasta/arquivo": identifica o item entre uma rodada e outra.
    key: String,
    name: String,
    mime: String,
    size: u64,
    src: Src,
    side: Option<Side>,
    /// Álbum (nome da pasta), se a pasta não é "Fotos de AAAA".
    album: Option<String>,
    archived_folder: bool,
    edited: bool,
}

/// Uma entrada da lista "o que você escolheu" (um .zip ou uma pasta).
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
    /// Fotos/vídeos sem o JSON do Google (a data vem do EXIF ou do nome).
    pub without_side: usize,
    pub sidecars: usize,
    /// Já importadas antes (rodada anterior neste vault).
    pub done_before: usize,
    pub first_year: Option<i32>,
    pub last_year: Option<i32>,
}

struct Index {
    zips: Vec<PathBuf>,
    items: Vec<Entry>,
}

// ---- leitura -----------------------------------------------------------------

fn lower(s: &str) -> String {
    s.to_lowercase()
}

fn is_gp(name: &str) -> bool {
    matches!(lower(name).as_str(), "google fotos" | "google photos")
}

/// "Takeout/Google Fotos/<pasta>/<arquivo>" → (pasta, arquivo).
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

/// "nome(2)" → ("nome", 2); sem número, 0.
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
        let mut ar = zip::ZipArchive::new(f).map_err(|e| format!("{} não é um .zip válido: {e}", path.display()))?;
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

/// Abre o .zip: caminho do disco ou URI do Android (seletor de arquivos).
fn open_zip_file(handle: Option<&AppHandle>, path: &Path) -> Res<std::fs::File> {
    match handle {
        Some(h) => tg_app::transfers::open_local(h, &path.to_string_lossy()),
        None => std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display())),
    }
}

fn collect(handle: Option<&AppHandle>, paths: &[PathBuf], names: &HashMap<String, String>) -> Res<Collected> {
    let mut c = Collected::default();
    for p in paths {
        let (before, bytes_before) = (c.files.len(), c.files.iter().map(|f| f.size).sum::<u64>());
        let name = names.get(p.to_string_lossy().as_ref()).cloned().or_else(|| p.file_name().map(|n| n.to_string_lossy().to_string())).unwrap_or_else(|| p.display().to_string());
        // URI do Android: só .zip (não há pasta de verdade para percorrer).
        let is_zip = is_uri(p) || (p.is_file() && lower(&name).ends_with(".zip"));
        if is_zip {
            c.add_zip(handle, p)?;
        } else if p.is_dir() {
            // Uma pasta com os .zip do takeout (ex.: Downloads) ou já extraída.
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
                return Err(format!("“{name}” não tem um takeout do Google Fotos (procurei .zip do takeout e a pasta Takeout/Google Fotos)"));
            }
        } else {
            return Err(format!("“{name}” não é uma pasta nem um .zip"));
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
    /// Importa, mas sem álbum (perfil, vídeos que falharam…).
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

fn build(c: Collected) -> Index {
    // (pasta, título, repetição) → metadados.
    let mut sides: HashMap<(String, String, u32), Side> = HashMap::new();
    let mut by_title: HashMap<(String, u32), Vec<Side>> = HashMap::new();
    for s in c.sides {
        let (_, dup) = split_dup(s.file.trim_end_matches(".json").trim_end_matches(".JSON"));
        by_title.entry((lower(&s.title), dup)).or_default().push(s.side.clone());
        sides.insert((s.folder, lower(&s.title), dup), s.side);
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for r in c.files {
        let key = format!("{}/{}", r.folder, r.name);
        if !seen.insert(key.clone()) {
            continue; // a mesma pasta em duas partes
        }
        let (stem, ext) = r.name.rsplit_once('.').unwrap_or((&r.name, ""));
        let (stem, edited) = match stem.strip_suffix("-editado").or_else(|| stem.strip_suffix("-edited")) {
            Some(s) => (s, true),
            None => (stem, false),
        };
        let (base, dup) = split_dup(stem);
        let title = lower(&format!("{base}.{ext}"));
        let side = sides.get(&(r.folder.clone(), title.clone(), dup)).cloned().or_else(|| {
            // A mesma foto em outra pasta (ano e álbum), se todas concordam na data.
            let v = by_title.get(&(title.clone(), dup))?;
            let first = v.first()?;
            v.iter().all(|s| s.taken == first.taken).then(|| first.clone())
        });
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
    Index { zips: c.zips, items }
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
        sidecars: 0,
        done_before: ix.items.iter().filter(|i| done.media.contains_key(&i.key)).count(),
        first_year: years.clone().min(),
        last_year: years.max(),
    }
}

// ---- estado e execução ---------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
struct Progress {
    /// "pasta/arquivo" → mídia do vault.
    media: HashMap<String, Done>,
    /// Nome do álbum → álbum do vault.
    albums: HashMap<String, i64>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Done {
    id: i64,
    /// Entrou já com o JSON do Google (senão, uma rodada futura corrige a data).
    side: bool,
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Opts {
    /// Não importar as cópias "-editado".
    #[serde(default)]
    pub skip_edited: bool,
    /// Criar álbuns a partir das pastas.
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
    /// Já importadas em rodadas anteriores.
    pub before: usize,
    pub elapsed_ms: u64,
    /// "Organizando álbuns e favoritas…" depois do envio.
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

fn load_progress(dir: &Path, vault: &str) -> Progress {
    std::fs::read(progress_path(dir, vault)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

impl Takeout {
    /// Lê o que o usuário escolheu (sem tocar no Telegram nem no vault).
    pub async fn scan(&self, handle: AppHandle, paths: Vec<String>, names: HashMap<String, String>, dir: PathBuf, vault: Option<String>) -> Res<Summary> {
        if self.running() {
            return Err("há uma importação em andamento".into());
        }
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        let (ix, sources, sidecars) = tokio::task::spawn_blocking(move || -> Res<_> {
            let c = collect(Some(&handle), &paths, &names)?;
            let (sources, sidecars) = (c.sources.clone(), c.sides.len());
            Ok((build(c), sources, sidecars))
        })
        .await
        .map_err(|e| e.to_string())??;
        if ix.items.is_empty() {
            return Err("não achei fotos nem vídeos do Google Fotos nesses arquivos".into());
        }
        let done = vault.map(|v| load_progress(&dir, &v)).unwrap_or_default();
        let mut s = summarize(&ix, sources.clone(), &done);
        s.sidecars = sidecars;
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

    /// Volta ao começo (depois de ver o resultado).
    pub fn reset(&self) {
        if !self.running() {
            *self.status.lock().unwrap() = Status::default();
            *self.index.lock().unwrap() = None;
        }
    }

    pub fn start(&self, opts: Opts, handle: AppHandle, tg: Arc<Telegram>, vaults: Arc<tg_app::Vaults<Db>>, transfers: Arc<tg_app::Transfers<Db>>) -> Res<()> {
        if self.running() {
            return Err("já há uma importação em andamento".into());
        }
        let ix = self.index.lock().unwrap().clone().ok_or("escolha os arquivos do takeout primeiro")?;
        vaults.check_write().map_err(|e| e.to_string())?;
        let open = vaults.current().ok_or("abra um vault primeiro")?;
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

/// Espaço mínimo entre envios ao Telegram, somando as simultâneas.
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

/// `true` = parou a pedido; `false` = terminou tudo.
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
        // Do menor para o maior: mais mídias chegam logo, as grandes ficam no fim.
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
        // Trocou de vault no meio: parar, senão os envios iriam para o canal errado.
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
            transfers.external(Some((s.bytes_done, s.bytes_total, format!("Importando do Google Fotos: {} de {}", s.done, s.total))));
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
                    if err.contains("SENHA_NECESSARIA") || err.contains("somente leitura") {
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

    // ---- favoritas, arquivadas, álbuns e datas corrigidas (inclui rodadas anteriores) ----
    status.lock().unwrap().finishing = true;
    let map = progress.lock().unwrap().media.clone();
    let (mut favorites, mut archived) = (Vec::new(), Vec::new());
    let mut members: HashMap<&str, Vec<i64>> = HashMap::new();
    let mut fixed = Vec::new();
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
        // Entrou antes sem o JSON; agora ele chegou: a data do Google vale mais que a do arquivo.
        if !d.side {
            if let Some(t) = it.side.as_ref().and_then(|s| s.taken) {
                fixed.push((it.key.clone(), d.id, t * 1000));
            }
        }
    }
    if !favorites.is_empty() {
        db.set_favorite(&favorites, true).map_err(|e| e.to_string())?;
    }
    if !archived.is_empty() {
        db.set_archived(&archived, true).map_err(|e| e.to_string())?;
    }
    for (key, id, ms) in &fixed {
        if db.set_taken(*id, *ms, None).is_ok() {
            if let Some(d) = progress.lock().unwrap().media.get_mut(key) {
                d.side = true;
            }
        }
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
            // Primeira vez, ou o álbum foi apagado depois: cria de novo.
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
    Ok(false)
}

/// Tira o arquivo do takeout (do .zip, se for o caso) calculando o sha256.
/// Devolve o caminho, o sha256 e se é uma cópia temporária (para apagar depois).
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

/// Confere o sha256 e sobe ao vault (se ele ainda não tem). `true` = subiu agora.
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
        return Err("arquivo vazio".into());
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
    // Uma trava por conteúdo: a mesma foto no ano e no álbum não sobe duas vezes.
    let lock = Arc::clone(locks.lock().unwrap().entry(sha.to_string()).or_default());
    let _guard = lock.lock().await;
    if let Some(existing) = db.find_sha256(sha) {
        // Estava na lixeira do vault? Volta: o takeout é a vontade atual do usuário.
        let _ = db.set_trashed(&[existing], false);
        return Ok((existing, false));
    }
    let pieces = retry(stop, || async {
        pace.wait().await;
        let mut reader = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
        tg.upload(&mut reader, e.size).await
    })
    .await?;
    // Data: EXIF → nome do arquivo → a do Google (melhor que a do arquivo extraído).
    let taken = e.side.as_ref().and_then(|s| s.taken).map(|s| s * 1000);
    let mut m = meta::read_with(std::fs::File::open(path).ok(), &e.name, &e.mime, taken);
    if m.gps.is_none() {
        m.gps = e.side.as_ref().and_then(|s| s.gps);
    }
    let media = db.insert(&e.name, &e.mime, e.size as i64, &pieces, Some(sha), &m, Some("Google Fotos")).map_err(|e| e.to_string())?;
    Ok((media.id, true))
}

/// Pausa do Telegram (FLOOD_WAIT) espera o tempo pedido; rede e erros passageiros
/// esperam 2, 4, 8… s (até 6 tentativas); o resto falha na hora.
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
                            return Err("parado".into());
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
    fn caminho_dentro_do_zip() {
        assert_eq!(split_gp("Takeout/Google Fotos/Fotos de 2019/a.jpg"), Some(("Fotos de 2019".into(), "a.jpg".into())));
        assert_eq!(split_gp("Takeout/Google Photos/Trip/a.jpg.json"), Some(("Trip".into(), "a.jpg.json".into())));
        assert_eq!(split_gp("Takeout/Google Fotos/a.json"), None);
        assert_eq!(split_gp("Takeout/Outro/x/a.jpg"), None);
    }

    #[test]
    fn repeticao_no_nome() {
        assert_eq!(split_dup("IMG_1(2)"), ("IMG_1", 2));
        assert_eq!(split_dup("IMG_1"), ("IMG_1", 0));
        assert_eq!(split_dup("a(b)"), ("a(b)", 0));
    }

    #[test]
    fn pastas() {
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
    fn casa_foto_e_json_entre_partes() {
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
        // No álbum não há JSON próprio: usa o do ano (mesma foto, mesma data).
        assert_eq!(by("Viagem/IMG_1.jpg").side.as_ref().unwrap().taken, Some(100));
        assert_eq!(by("Viagem/IMG_1.jpg").album.as_deref(), Some("Viagem"));
        assert!(by("Fotos de 2019/IMG_2-editado.jpg").edited);
        assert_eq!(by("Fotos de 2019/IMG_2-editado.jpg").side.as_ref().unwrap().taken, Some(300));
        assert!(ix.items.iter().all(|i| !i.key.starts_with("Lixeira")));
    }

    /// Com um takeout de verdade: `TAKEOUT_TESTE=/caminho cargo test --lib takeout_real -- --ignored --nocapture`.
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
