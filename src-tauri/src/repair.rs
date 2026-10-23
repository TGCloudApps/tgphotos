//! Repair of videos that came in without duration or dimensions (the reader did not
//! understand the file, e.g. fragmented MP4 before it knew how to read the `mehd`).
//! Downloads only the `moov` from Telegram (the video index, a few KB) and re-reads it.
//!
//! Each video is tried once per vault on this device (`video-repair-<vault>.json`);
//! a network failure stops the round without marking anything, and the next one tries again.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};
use tg_core::{Piece, Telegram};

use crate::db::Db;
use crate::meta;

type Res<T> = std::result::Result<T, String>;

/// Largest `moov` worth downloading just for this.
const MAX_MOOV: u64 = 32 << 20;

static BUSY: AtomicBool = AtomicBool::new(false);

async fn range(tg: &Arc<Telegram>, pieces: &[Piece], start: u64, end: u64) -> Res<Vec<u8>> {
    let mut s = std::pin::pin!(tg_core::read_range_with(Arc::clone(tg), pieces.to_vec(), start, end, tg_core::Priority::Background, Default::default()));
    let mut out = Vec::new();
    while let Some(b) = s.next().await {
        out.extend_from_slice(&b.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// The file's `moov` (at the start or the end), walking the top-level boxes.
async fn moov(tg: &Arc<Telegram>, pieces: &[Piece]) -> Res<Option<Vec<u8>>> {
    let total: u64 = pieces.iter().map(|p| p.size).sum();
    let mut off = 0u64;
    for _ in 0..64 {
        if off + 8 > total {
            return Ok(None);
        }
        let h = range(tg, pieces, off, (off + 16).min(total) - 1).await?;
        if h.len() < 8 {
            return Ok(None);
        }
        let mut size = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
        if size == 1 {
            let Some(b) = h.get(8..16) else { return Ok(None) };
            size = u64::from_be_bytes(b.try_into().unwrap());
        } else if size == 0 {
            size = total - off;
        }
        if size < 8 {
            return Ok(None);
        }
        if &h[4..8] == b"moov" {
            if size > MAX_MOOV {
                return Ok(None);
            }
            return Ok(Some(range(tg, pieces, off, (off + size).min(total) - 1).await?));
        }
        off += size;
    }
    Ok(None)
}

fn tried_path(dir: &std::path::Path, vault: &str) -> PathBuf {
    dir.join(format!("video-repair-{vault}.json"))
}

/// Re-reads the video index from Telegram and fills in what is missing. `true` = something changed.
async fn fix(tg: &Arc<Telegram>, db: &Db, id: i64, name: &str, mime: &str) -> Res<bool> {
    let pieces = db.pieces(id)?;
    let Some(bytes) = moov(tg, &pieces).await? else { return Ok(false) };
    let m = meta::read_bytes(&bytes, name, mime, None);
    db.set_video_meta(id, m.duration, m.width, m.height)
}

/// A single video (open in the viewer right now), without waiting for the round.
pub async fn one(handle: &AppHandle, tg: &Arc<Telegram>, vaults: &Arc<tg_app::Vaults<Db>>, id: i64) -> Res<bool> {
    let Some(open) = vaults.current() else { return Ok(false) };
    if vaults.check_write().is_err() {
        return Ok(false);
    }
    let Some((_, name, mime)) = open.db.videos_missing_meta()?.into_iter().find(|x| x.0 == id) else { return Ok(false) };
    let changed = fix(tg, &open.db, id, &name, &mime).await?;
    if changed {
        vaults.kick();
        let _ = handle.emit("index-changed", ());
    }
    Ok(changed)
}

/// One round on the open vault. Returns how many videos gained duration or dimensions.
pub async fn videos(handle: &AppHandle, tg: &Arc<Telegram>, vaults: &Arc<tg_app::Vaults<Db>>) -> Res<usize> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Ok(0);
    }
    let r = run(handle, tg, vaults).await;
    BUSY.store(false, Ordering::SeqCst);
    r
}

async fn run(handle: &AppHandle, tg: &Arc<Telegram>, vaults: &Arc<tg_app::Vaults<Db>>) -> Res<usize> {
    let Some(open) = vaults.current() else { return Ok(0) };
    // The fix becomes an op in the channel: a read-only vault has no way to write.
    if vaults.check_write().is_err() {
        return Ok(0);
    }
    let (db, vault) = (Arc::clone(&open.db), open.vault_id.clone());
    let path = tried_path(vaults.dir(), &vault);
    let mut tried: HashSet<i64> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let todo: Vec<_> = db.videos_missing_meta()?.into_iter().filter(|(id, ..)| !tried.contains(id)).collect();
    let mut fixed = 0;
    for (id, name, mime) in todo {
        if vaults.current().map(|o| o.vault_id.clone()).as_deref() != Some(vault.as_str()) {
            break;
        }
        match fix(tg, &db, id, &name, &mime).await {
            Ok(changed) => fixed += changed as usize,
            // No network, vault locked, FLOOD_WAIT: stop and retry on the next round.
            Err(e) if tg_core::is_network_error(&e) || tg_core::flood_wait(&e).is_some() || tg_core::codes::is(&e, tg_core::codes::VAULT_LOCKED) => break,

            Err(e) => eprintln!("[tgphotos] reparo de vídeo {name}: {e}"),
        }
        tried.insert(id);
        let _ = std::fs::write(&path, serde_json::to_vec(&tried).unwrap_or_default());
    }
    if fixed > 0 {
        vaults.kick();
        let _ = handle.emit("index-changed", ());
    }
    Ok(fixed)
}
