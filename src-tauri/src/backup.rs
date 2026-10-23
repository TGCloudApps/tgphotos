//! Automatic backup: whatever appears in the watched folders joins the upload
//! queue on its own.
//!
//! - Desktop: disk folders, scanned when the vault opens and every 5 minutes
//!   (and when the UI asks). Only new or changed files (path +
//!   size + date) come in; the upload still checks the sha256 and does not upload what the
//!   vault already has.
//! - Android: the UI lists the media of the chosen folders through
//!   MediaStore (Kotlin bridge) and sends them to [`enqueue`].
//!
//! A library that already exists (backup done before, another device, app
//! reinstalled): whatever has the same name and size as a vault media item —
//! including in the trash — counts as uploaded and does not even enter the queue. The rest
//! comes in marked as automatic: if the sha256 finds the content in the vault, nothing
//! uploads and nothing leaves the trash.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tg_app::transfers::UriItem;
use tg_app::{Library, Transfers};

use crate::db::{Db, Result};

/// MediaStore media (Android).
#[derive(Deserialize, Clone, Debug)]
pub struct DeviceItem {
    pub uri: String,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mime: String,
    /// Relative folder ("DCIM/Camera").
    #[serde(default)]
    pub path: String,
    /// Modification date (s).
    #[serde(default)]
    pub modified: i64,
}

#[derive(Serialize, Default)]
pub struct Report {
    /// Files that entered the queue now.
    pub queued: usize,
    /// Files seen in the folders.
    pub scanned: usize,
}

/// Android: media listed by the UI.
/// `force`: picked by hand, they come in even if already seen (the sha256 still
/// avoids uploading again what the vault has).
pub fn enqueue(db: &Db, transfers: &Arc<Transfers<Db>>, items: Vec<DeviceItem>, force: bool) -> Result<Report> {
    let scanned = items.len();
    let candidates: Vec<(String, i64, i64)> = items.iter().map(|i| (i.uri.clone(), i.size as i64, i.modified)).collect();
    let fresh = if force {
        db.backup_include(&candidates.iter().map(|c| c.0.clone()).collect::<Vec<_>>())?;
        db.backup_mark_seen(&candidates)?;
        (0..items.len()).collect()
    } else {
        db.backup_take_new(&candidates)?
    };
    // Picked by hand go to the queue anyway (the sha256 sorts it out).
    let fresh = if force { fresh } else { known(db, fresh, |i| (items[i].uri.as_str(), items[i].name.as_str(), items[i].size as i64))? };
    let list: Vec<UriItem> = fresh
        .into_iter()
        .map(|i| {
            let it = &items[i];
            UriItem { uri: it.uri.clone(), name: it.name.clone(), size: it.size, mime: it.mime.clone(), path: it.path.clone() }
        })
        .collect();
    let queued = match (list.is_empty(), force) {
        (true, _) => 0,
        (false, true) => transfers.upload_uris(list, 0)?,
        (false, false) => transfers.backup_uris(list)?,
    };
    Ok(Report { queued, scanned })
}

/// Removes from `fresh` what the vault already has (same name and size), recording the
/// source as uploaded.
fn known<'a>(db: &Db, fresh: Vec<usize>, item: impl Fn(usize) -> (&'a str, &'a str, i64)) -> Result<Vec<usize>> {
    let mut out = Vec::with_capacity(fresh.len());
    let mut skipped = 0;
    for i in fresh {
        let (src, name, size) = item(i);
        match db.find_name_size(name, size) {
            Some(id) => {
                db.backup_record(src, id)?;
                skipped += 1;
            }
            None => out.push(i),
        }
    }
    if skipped > 0 {
        eprintln!("[tgphotos] backup: {skipped} já estavam no vault");
    }
    Ok(out)
}

/// Desktop: scans the watched folders.
pub fn scan(db: &Db, transfers: &Arc<Transfers<Db>>) -> Result<Report> {
    let mut files = Vec::new();
    for folder in db.backup_folders()? {
        walk(db, Path::new(&folder), &mut files, 0);
    }
    let scanned = files.len();
    let candidates: Vec<(String, i64, i64)> = files.iter().map(|(p, size, mtime)| (p.to_string_lossy().to_string(), *size, *mtime)).collect();
    let fresh = db.backup_take_new(&candidates)?;
    let names: Vec<String> = files.iter().map(|(p, _, _)| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).collect();
    let fresh = known(db, fresh, |i| (candidates[i].0.as_str(), names[i].as_str(), files[i].1))?;
    let paths: Vec<PathBuf> = fresh.into_iter().map(|i| files[i].0.clone()).collect();
    let queued = if paths.is_empty() { 0 } else { transfers.backup_paths(paths)? };
    Ok(Report { queued, scanned })
}

/// File from the backup folders that is not in the vault yet (desktop gallery).
#[derive(Serialize)]
pub struct LocalItem {
    /// File path (goes as `uri` to the UI).
    pub uri: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    /// Folder (relative to home, for display).
    pub path: String,
    /// Capture (ms): EXIF/container/name; otherwise the modification time.
    pub taken: i64,
    /// 0 = not in the queue yet, 1 = in the queue / uploading.
    pub status: u8,
}

/// Dates already read (path → (modification, capture)), so files are not reopened on every listing.
static TAKEN: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (i64, i64)>>> = std::sync::LazyLock::new(Default::default);

/// Desktop: what is in the backup folders and has not reached the vault yet.
pub fn local(db: &Db) -> Result<Vec<LocalItem>> {
    let mut files = Vec::new();
    for folder in db.gallery_folders()? {
        walk(db, Path::new(&folder), &mut files, 0);
    }
    let srcs: Vec<String> = files.iter().map(|(p, _, _)| p.to_string_lossy().to_string()).collect();
    let status = db.backup_status(&srcs)?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut out = Vec::new();
    for (((path, size, mtime), src), st) in files.into_iter().zip(srcs).zip(status) {
        if st == 2 {
            continue;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mime = mime_of(&name);
        let cached = TAKEN.lock().unwrap().get(&src).copied();
        let taken = match cached {
            Some((m, t)) if m == mtime => t,
            _ => {
                let t = crate::meta::read(std::fs::File::open(&path).ok(), &name, &mime).taken.unwrap_or(mtime * 1000);
                TAKEN.lock().unwrap().insert(src.clone(), (mtime, t));
                t
            }
        };
        let dir = path.parent().map(|d| home.as_deref().and_then(|h| d.strip_prefix(h).ok()).unwrap_or(d).to_string_lossy().to_string()).unwrap_or_default();
        out.push(LocalItem { uri: src, name, size: size as u64, mime, path: dir, taken, status: st });
    }
    Ok(out)
}

/// The path is inside a gallery folder (backed up or just shown):
/// the `/device` route and the local actions only touch those.
pub fn in_backup_folder(db: &Db, path: &str) -> bool {
    let p = Path::new(path);
    p.is_absolute() && !path.contains("..") && db.gallery_folders().unwrap_or_default().iter().any(|f| p.starts_with(f))
}

/// Media files under `dir` (without following hidden folders; depth limited).
fn walk(db: &Db, dir: &Path, out: &mut Vec<(PathBuf, i64, i64)>, depth: usize) {
    if depth > 12 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let path = entry.path();
        if meta.is_dir() {
            walk(db, &path, out, depth + 1);
        } else if meta.is_file() && meta.len() > 0 {
            let mime = mime_of(&name);
            if db.accepts(&name, &mime) {
                let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or_default();
                out.push((path, meta.len() as i64, mtime));
            }
        }
    }
}

/// Type by extension (`mime_guess` does not know every camera format).
pub fn mime_of(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "dng" => "image/x-adobe-dng",
        "cr2" | "cr3" | "nef" | "arw" | "orf" | "rw2" | "raf" => "image/x-raw",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "3gp" => "video/3gpp",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Desktop: scans when the vault opens and every 5 minutes while the app runs.
#[cfg(desktop)]
pub fn spawn_loop(vaults: Arc<tg_app::Vaults<Db>>, transfers: Arc<Transfers<Db>>, kick: Arc<tokio::sync::Notify>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = kick.notified() => {}
                _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {}
            }
            let Ok(db) = vaults.db() else { continue };
            let transfers = Arc::clone(&transfers);
            match tauri::async_runtime::spawn_blocking(move || scan(&db, &transfers)).await {
                Ok(Ok(r)) if r.queued > 0 => eprintln!("[tgphotos] backup: {} novos de {} arquivos", r.queued, r.scanned),
                Ok(Err(e)) => eprintln!("[tgphotos] backup falhou: {e}"),
                _ => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn types() {
        assert_eq!(super::mime_of("IMG_1.JPG"), "image/jpeg");
        assert_eq!(super::mime_of("a.MOV"), "video/quicktime");
        assert_eq!(super::mime_of("notas.txt"), "application/octet-stream");
    }
}
