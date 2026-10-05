//! Backup automático: o que aparece nas pastas observadas entra na fila de
//! envio sozinho.
//!
//! - Desktop: pastas do disco, varridas ao abrir o vault e a cada 5 minutos
//!   (e quando a interface pede). Só arquivos novos ou alterados (caminho +
//!   tamanho + data) entram; o envio ainda confere o sha256 e não sobe o que o
//!   vault já tem.
//! - Android: a interface lista as mídias das pastas escolhidas pelo
//!   MediaStore (ponte Kotlin) e manda para [`enqueue`].
//!
//! Biblioteca que já existe (backup feito antes, outro aparelho, app
//! reinstalado): o que tem o mesmo nome e tamanho de uma mídia do vault —
//! inclusive na lixeira — conta como enviado e nem entra na fila. O que sobra
//! entra marcado como automático: se o sha256 achar o conteúdo no vault, nada
//! sobe e nada sai da lixeira.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tg_app::transfers::UriItem;
use tg_app::{Library, Transfers};

use crate::db::{Db, Result};

/// Mídia do MediaStore (Android).
#[derive(Deserialize, Clone, Debug)]
pub struct DeviceItem {
    pub uri: String,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mime: String,
    /// Pasta relativa ("DCIM/Camera").
    #[serde(default)]
    pub path: String,
    /// Data de modificação (s).
    #[serde(default)]
    pub modified: i64,
}

#[derive(Serialize)]
pub struct Report {
    /// Arquivos que entraram na fila agora.
    pub queued: usize,
    /// Arquivos vistos nas pastas.
    pub scanned: usize,
}

/// Android: mídias listadas pela interface.
/// `force`: escolhidas à mão, entram mesmo se já foram vistas (o sha256 ainda
/// evita subir de novo o que o vault tem).
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
    // Escolhidas à mão vão para a fila mesmo assim (o sha256 resolve).
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

/// Tira de `fresh` o que o vault já tem (mesmo nome e tamanho), registrando a
/// origem como enviada.
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

/// Desktop: varre as pastas observadas.
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

/// Arquivo das pastas de backup que ainda não está no vault (galeria do desktop).
#[derive(Serialize)]
pub struct LocalItem {
    /// Caminho do arquivo (vai como `uri` para a interface).
    pub uri: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    /// Pasta (relativa à pessoal, para exibir).
    pub path: String,
    /// Captura (ms): EXIF/contêiner/nome; senão a modificação.
    pub taken: i64,
    /// 0 = ainda não entrou na fila, 1 = na fila / enviando.
    pub status: u8,
}

/// Datas já lidas (caminho → (modificação, captura)), para não reabrir arquivos a cada listagem.
static TAKEN: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (i64, i64)>>> = std::sync::LazyLock::new(Default::default);

/// Desktop: o que está nas pastas de backup e ainda não chegou ao vault.
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

/// O caminho está dentro de uma pasta da galeria (com backup ou só mostrada):
/// a rota `/device` e as ações locais só tocam esses.
pub fn in_backup_folder(db: &Db, path: &str) -> bool {
    let p = Path::new(path);
    p.is_absolute() && !path.contains("..") && db.gallery_folders().unwrap_or_default().iter().any(|f| p.starts_with(f))
}

/// Arquivos de mídia sob `dir` (sem seguir pastas ocultas; profundidade limitada).
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

/// Tipo pela extensão (o `mime_guess` não conhece todos os formatos de câmera).
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

/// Desktop: varre ao abrir o vault e a cada 5 minutos enquanto o app roda.
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
    fn tipos() {
        assert_eq!(super::mime_of("IMG_1.JPG"), "image/jpeg");
        assert_eq!(super::mime_of("a.MOV"), "video/quicktime");
        assert_eq!(super::mime_of("notas.txt"), "application/octet-stream");
    }
}
