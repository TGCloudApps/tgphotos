//! Local cache of a TGPhotos vault (SQLite). The source of truth is the
//! channel: every mutation writes the row and the op to the queue in the same
//! transaction; ops from other devices arrive through [`Store::apply`] with
//! last-writer-wins per row. Entities (FORMAT.md): `media`, `album` and
//! `album_item` (one per album × media pair, so two devices can change the same
//! album without conflict); for Shorts, `like` (one per media) and `view` (one
//! per media × device: each device writes only its own count, so summing does
//! not lose views).
//!
//! For the UI, media and albums have local integer ids (stable on this device);
//! between devices the identity is the `uid` (ULID).

use tg_core::codes as c;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tg_app::{CopyRow, Item, Library, UploadDone};
use tg_core::hlc::Clock;
use tg_core::sync::{Op, Store};
use tg_core::Piece;
use tokio::sync::Notify;

use crate::meta::{self, Camera};

pub type Result<T> = tg_core::Result<T>;

const MEDIA: &str = "media";
const ALBUM: &str = "album";
const ALBUM_ITEM: &str = "album_item";
const LIKE: &str = "like";
const VIEW: &str = "view";
/// Tombstones stay in the snapshot for 30 days.
const TOMBSTONE_TTL_MS: i64 = 30 * 86_400_000;
/// Items in the trash longer than this are removed for good.
pub const TRASH_RETENTION_MS: i64 = 30 * 86_400_000;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

// ---- what the UI sees ----------------------------------------------------------

/// Media as the UI sees it. Times in seconds.
#[derive(Serialize, Clone, Debug)]
pub struct Media {
    pub id: i64,
    pub name: String,
    pub mime: String,
    pub size: i64,
    /// Has a thumbnail (served at `/thumb/<id>`).
    pub thumb: bool,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// Capture time (UTC, seconds with a ms fraction).
    pub taken_at: f64,
    /// Capture time zone in minutes, when known.
    pub tz: Option<i32>,
    pub favorite: bool,
    pub archived: bool,
    pub trashed_at: Option<i64>,
    pub added_at: i64,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    #[serde(skip)]
    pub uid: String,
    /// Original on this device (uploaded from here: path or URI). The UI
    /// opens it through `/local/<id>`, without the network.
    pub local: Option<String>,
    /// Motion photo: video bytes at the end of the file. `None` = not checked
    /// yet (the UI checks on open and stores it); `Some(0)` = it is not one.
    pub motion: Option<i64>,
}

const COLS: &str = "id, name, mime, size, thumb IS NOT NULL, duration, width, height, taken_at, tz, favorite, archived, trashed_at, added_at, lat, lon, uid, motion";

impl Media {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
            mime: r.get(2)?,
            size: r.get(3)?,
            thumb: r.get(4)?,
            duration: r.get(5)?,
            width: r.get(6)?,
            height: r.get(7)?,
            taken_at: r.get::<_, i64>(8)? as f64 / 1000.0,
            tz: r.get(9)?,
            favorite: r.get(10)?,
            archived: r.get(11)?,
            trashed_at: r.get::<_, Option<i64>>(12)?.map(|t| t / 1000),
            added_at: r.get::<_, i64>(13)? / 1000,
            lat: r.get(14)?,
            lon: r.get(15)?,
            uid: r.get(16)?,
            local: None,
            motion: r.get(17)?,
        })
    }
}

/// Full details (info panel).
#[derive(Serialize, Clone, Debug)]
pub struct Details {
    #[serde(flatten)]
    pub media: Media,
    pub camera: Option<Camera>,
    pub origin: Option<String>,
    pub sha256: Option<String>,
    pub albums: Vec<AlbumRef>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AlbumRef {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Album {
    pub id: i64,
    pub name: String,
    pub count: i64,
    /// Cover media (chosen or the most recent one).
    pub cover: Option<i64>,
    pub created_at: i64,
    pub modified_at: i64,
    /// Photo range (seconds), for the subtitle.
    pub first: Option<i64>,
    pub last: Option<i64>,
}

#[derive(Serialize, Clone, Copy, Default)]
pub struct Usage {
    pub photos: i64,
    pub videos: i64,
    pub bytes: i64,
}

/// Library slices.
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum View {
    /// Timeline: everything except archive and trash.
    Timeline,
    Favorites,
    Videos,
    /// Recently uploaded: everything except archive and trash, by upload order to the vault.
    Recent,
    Archive,
    Trash,
}

// ---- rows as they go to the channel (FORMAT.md). Times in ms. ----------------------

/// Piece as it goes in the index: `{"msg", "size", "n"?}` (`n` = nonce, encrypted vault).
pub type RowPiece = Piece;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MediaRow {
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub pieces: Vec<RowPiece>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<RowPiece>,
    pub taken: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<Camera>,
    /// [lat, lon].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub fav: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed: Option<i64>,
    /// Source folder on the device (e.g. "DCIM/Camera").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    pub added: i64,
    pub mtime: i64,
    /// Motion photo: video bytes at the end of the file (0 = checked, it is not one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion: Option<i64>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AlbumRow {
    pub name: String,
    /// Uid of the cover media.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub ctime: i64,
    pub mtime: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LikeRow {
    pub on: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ViewRow {
    pub media: String,
    pub n: i64,
    pub at: i64,
}

/// Media in the Shorts feed, with views (summed across devices) and like state.
#[derive(Serialize, Clone, Debug)]
pub struct Short {
    #[serde(flatten)]
    pub media: Media,
    pub views: i64,
    pub liked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AlbumItemRow {
    pub album: String,
    pub media: String,
    pub added: i64,
}

/// Uid of `album_item`: deterministic, so two devices that put the same
/// media in the same album converge on the same row.
fn item_uid(album: &str, media: &str) -> String {
    format!("{album}:{media}")
}

// ---- database ------------------------------------------------------------------------

/// Item sent to the device trash (coming from the UI).
#[derive(Deserialize, Debug, Clone)]
pub struct DeviceTrashIn {
    pub src: String,
    pub name: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub size: i64,
    /// Capture time (ms).
    #[serde(default)]
    pub taken: i64,
    /// Relative source folder ("DCIM/Camera"), to restore on Android < 11.
    #[serde(default)]
    pub folder: String,
    /// Copy kept by the app (Android < 11, no system trash).
    #[serde(default)]
    pub stash: Option<String>,
}

/// Device trash row, with the linked vault media (if any).
#[derive(Serialize, Debug, Clone)]
pub struct DeviceTrash {
    pub src: String,
    pub media_id: Option<i64>,
    /// The linked media is in the vault trash.
    pub media_trashed: bool,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub taken: i64,
    pub folder: String,
    pub stash: Option<String>,
    pub trashed_at: i64,
}

/// Original on this device linked to a vault media item.
#[derive(Serialize, Debug, Clone)]
pub struct DeviceLink {
    pub src: String,
    pub media_id: i64,
    /// The media is in the vault trash.
    pub trashed: bool,
    pub size: i64,
    pub name: String,
    pub mime: String,
}

pub struct Db {
    conn: Mutex<Connection>,
    clock: Arc<Clock>,
    /// Woken on every local mutation (the sync loop listens).
    pub changed: Notify,
}

const SCHEMA_VERSION: i32 = 10;

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < SCHEMA_VERSION {
        migrate_tables(conn)?;
    }
    ensure_motion(conn)?;
    if version < SCHEMA_VERSION {
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    }
    Ok(())
}

/// Column added after the table was created. Always check for it, not by
/// version: the database may have been opened by another build of the app
/// and already be at a higher version without the column.
fn ensure_motion(conn: &Connection) -> rusqlite::Result<()> {
    let has: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_table_info('media') WHERE name = 'motion'", [], |r| r.get(0))?;
    if has == 0 {
        conn.execute_batch("ALTER TABLE media ADD COLUMN motion INTEGER;")?;
    }
    Ok(())
}

fn migrate_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS media (
             id INTEGER PRIMARY KEY,
             uid TEXT NOT NULL UNIQUE,
             name TEXT NOT NULL,
             mime TEXT NOT NULL DEFAULT '',
             size INTEGER NOT NULL DEFAULT 0,
             pieces TEXT NOT NULL DEFAULT '[]',
             sha256 TEXT,
             thumb TEXT,
             taken_at INTEGER NOT NULL,
             tz INTEGER,
             width INTEGER,
             height INTEGER,
             duration REAL,
             camera TEXT,
             lat REAL,
             lon REAL,
             favorite INTEGER NOT NULL DEFAULT 0,
             archived INTEGER NOT NULL DEFAULT 0,
             trashed_at INTEGER,
             origin TEXT,
             added_at INTEGER NOT NULL,
             modified_at INTEGER NOT NULL,
             hlc TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS media_taken ON media(taken_at);
         CREATE INDEX IF NOT EXISTS media_sha ON media(sha256);
         -- Backup: recognize what is already in the vault without reading the file.
         CREATE INDEX IF NOT EXISTS media_name_size ON media(name, size);
         CREATE TABLE IF NOT EXISTS albums (
             id INTEGER PRIMARY KEY,
             uid TEXT NOT NULL UNIQUE,
             name TEXT NOT NULL,
             cover_uid TEXT,
             created_at INTEGER NOT NULL,
             modified_at INTEGER NOT NULL,
             hlc TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS album_items (
             uid TEXT PRIMARY KEY,
             album_uid TEXT NOT NULL,
             media_uid TEXT NOT NULL,
             added_at INTEGER NOT NULL,
             hlc TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS album_items_album ON album_items(album_uid);
         CREATE INDEX IF NOT EXISTS album_items_media ON album_items(media_uid);
         CREATE TABLE IF NOT EXISTS tombstones (e TEXT NOT NULL, uid TEXT NOT NULL, hlc TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (e, uid));
         CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, op TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         -- Automatic backup (this device only; it does not go to the channel).
         CREATE TABLE IF NOT EXISTS backup_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
         -- Folders shown on the timeline even without backup (user choice).
         CREATE TABLE IF NOT EXISTS show_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS backup_seen (src TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL);
         -- Local source (without query) → media it became.
         CREATE TABLE IF NOT EXISTS backup_done (src TEXT PRIMARY KEY, media_uid TEXT NOT NULL);
         -- Device trash (this device only): what the app sent to the
         -- system trash (or stashed, on Android < 11) and how to restore it.
         -- Removed from the vault but kept on the device (Delete from vault): the
         -- automatic backup does not upload them again; they appear as not backed up.
         CREATE TABLE IF NOT EXISTS backup_excluded (src TEXT PRIMARY KEY);
         -- Shorts (synced): like per media; views per media × device.
         CREATE TABLE IF NOT EXISTS likes (uid TEXT PRIMARY KEY, liked INTEGER NOT NULL, hlc TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS views (
             uid TEXT PRIMARY KEY,
             media_uid TEXT NOT NULL,
             n INTEGER NOT NULL,
             at INTEGER NOT NULL,
             hlc TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS views_media ON views(media_uid);
         -- Thumbnails replaced by another device (regenerated): their on-disk cache
         -- is stale (this device only).
         CREATE TABLE IF NOT EXISTS thumb_changed (uid TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS device_trash (
             src TEXT PRIMARY KEY,
             media_uid TEXT,
             name TEXT NOT NULL,
             mime TEXT NOT NULL,
             size INTEGER NOT NULL,
             taken INTEGER NOT NULL,
             folder TEXT NOT NULL DEFAULT '',
             stash TEXT,
             trashed_at INTEGER NOT NULL
         );"
    ))
}

fn view_filter(v: View) -> &'static str {
    match v {
        View::Timeline => "trashed_at IS NULL AND archived = 0",
        View::Favorites => "trashed_at IS NULL AND favorite = 1",
        View::Videos => "trashed_at IS NULL AND archived = 0 AND mime LIKE 'video/%'",
        View::Recent => "trashed_at IS NULL AND archived = 0",
        View::Archive => "trashed_at IS NULL AND archived = 1",
        View::Trash => "trashed_at IS NOT NULL",
    }
}

fn pieces_json(pieces: &[Piece]) -> String {
    let list: Vec<RowPiece> = pieces.to_vec();
    serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())
}

/// Messages (pieces and thumbnails) of doomed media that nothing else uses.
const ORPHANS: &str = "WITH refs(id, msg) AS (
         SELECT m.id, json_extract(p.value, '$.msg') FROM media m, json_each(m.pieces) p
         UNION ALL
         SELECT m.id, json_extract(m.thumb, '$.msg') FROM media m WHERE m.thumb IS NOT NULL
     )
     SELECT DISTINCT msg FROM refs WHERE id IN doomed AND msg NOT IN (SELECT msg FROM refs WHERE id NOT IN doomed)";

impl Db {
    pub fn open(path: &Path, clock: Arc<Clock>) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let conn = Connection::open(path).map_err(err)?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
        migrate(&conn).map_err(err)?;
        Ok(Self { conn: Mutex::new(conn), clock, changed: Notify::new() })
    }

    // ---- reads -------------------------------------------------------------------

    fn query(&self, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Media>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(sql).map_err(err)?;
        let rows = stmt.query_map(p, Media::from_row).map_err(err)?;
        let mut list: Vec<Media> = rows.collect::<rusqlite::Result<_>>().map_err(err)?;
        let local = Self::local_srcs(&conn)?;
        for m in &mut list {
            m.local = local.get(&m.uid).cloned();
        }
        Ok(list)
    }

    fn local_srcs(conn: &Connection) -> Result<HashMap<String, String>> {
        let mut stmt = conn.prepare("SELECT media_uid, src FROM backup_done").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    /// Local source of a media item (path or URI), if it was uploaded from here.
    pub fn local_src(&self, id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT d.src FROM backup_done d JOIN media m ON m.uid = d.media_uid WHERE m.id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    /// One view, newest to oldest (trash: by the date it was sent to the trash).
    pub fn list(&self, view: View) -> Result<Vec<Media>> {
        let order = match view {
            View::Trash => "trashed_at DESC",
            View::Recent => "added_at DESC, id DESC",
            _ => "taken_at DESC, id DESC",
        };
        self.query(&format!("SELECT {COLS} FROM media WHERE {} ORDER BY {order}", view_filter(view)), [])
    }

    pub fn get(&self, id: i64) -> Result<Option<Media>> {
        Ok(self.query(&format!("SELECT {COLS} FROM media WHERE id = ?1"), [id])?.pop())
    }

    pub fn details(&self, id: i64) -> Result<Option<Details>> {
        let Some(media) = self.get(id)? else { return Ok(None) };
        let conn = self.conn.lock().unwrap();
        let (camera, origin, sha256): (Option<String>, Option<String>, Option<String>) = conn
            .query_row("SELECT camera, origin, sha256 FROM media WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(err)?;
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.name FROM album_items i JOIN albums a ON a.uid = i.album_uid
                 JOIN media m ON m.uid = i.media_uid WHERE m.id = ?1 ORDER BY a.name COLLATE NOCASE",
            )
            .map_err(err)?;
        let albums = stmt
            .query_map([id], |r| Ok(AlbumRef { id: r.get(0)?, name: r.get(1)? }))
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?;
        Ok(Some(Details {
            media,
            camera: camera.and_then(|c| serde_json::from_str(&c).ok()),
            origin,
            sha256,
            albums,
        }))
    }

    /// Search by name, camera, source folder and album.
    pub fn search(&self, text: &str) -> Result<Vec<Media>> {
        let pattern = format!("%{}%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        self.query(
            &format!(
                "SELECT {COLS} FROM media WHERE trashed_at IS NULL AND (
                     name LIKE ?1 ESCAPE '\\' OR camera LIKE ?1 ESCAPE '\\' OR origin LIKE ?1 ESCAPE '\\'
                     OR uid IN (SELECT i.media_uid FROM album_items i JOIN albums a ON a.uid = i.album_uid WHERE a.name LIKE ?1 ESCAPE '\\')
                 ) ORDER BY taken_at DESC"
            ),
            params![pattern],
        )
    }

    pub fn usage(&self) -> Result<Usage> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(SUM(mime NOT LIKE 'video/%'), 0), COALESCE(SUM(mime LIKE 'video/%'), 0), COALESCE(SUM(size), 0)
             FROM media WHERE trashed_at IS NULL",
            [],
            |r| Ok(Usage { photos: r.get(0)?, videos: r.get(1)?, bytes: r.get(2)? }),
        )
        .map_err(err)
    }

    pub fn albums(&self) -> Result<Vec<Album>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.name, a.created_at, a.modified_at,
                    (SELECT COUNT(*) FROM album_items i JOIN media m ON m.uid = i.media_uid WHERE i.album_uid = a.uid AND m.trashed_at IS NULL),
                    COALESCE(
                      (SELECT m.id FROM media m WHERE m.uid = a.cover_uid AND m.trashed_at IS NULL),
                      (SELECT m.id FROM album_items i JOIN media m ON m.uid = i.media_uid WHERE i.album_uid = a.uid AND m.trashed_at IS NULL ORDER BY m.taken_at DESC LIMIT 1)
                    ),
                    (SELECT MIN(m.taken_at) FROM album_items i JOIN media m ON m.uid = i.media_uid WHERE i.album_uid = a.uid AND m.trashed_at IS NULL),
                    (SELECT MAX(m.taken_at) FROM album_items i JOIN media m ON m.uid = i.media_uid WHERE i.album_uid = a.uid AND m.trashed_at IS NULL)
                 FROM albums a ORDER BY a.modified_at DESC",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Album {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created_at: r.get::<_, i64>(2)? / 1000,
                    modified_at: r.get::<_, i64>(3)? / 1000,
                    count: r.get(4)?,
                    cover: r.get(5)?,
                    first: r.get::<_, Option<i64>>(6)?.map(|t| t / 1000),
                    last: r.get::<_, Option<i64>>(7)?.map(|t| t / 1000),
                })
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn album(&self, id: i64) -> Result<Option<Album>> {
        Ok(self.albums()?.into_iter().find(|a| a.id == id))
    }

    /// Media in an album, oldest to newest.
    pub fn album_media(&self, id: i64) -> Result<Vec<Media>> {
        let cols = COLS.split(", ").map(|c| format!("m.{c}")).collect::<Vec<_>>().join(", ");
        self.query(
            &format!(
                "SELECT {cols} FROM album_items i JOIN media m ON m.uid = i.media_uid JOIN albums a ON a.uid = i.album_uid
                 WHERE a.id = ?1 AND m.trashed_at IS NULL ORDER BY m.taken_at, m.id"
            ),
            [id],
        )
    }

    pub fn pieces(&self, id: i64) -> Result<Vec<Piece>> {
        let conn = self.conn.lock().unwrap();
        let raw: Option<String> = conn.query_row("SELECT pieces FROM media WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(err)?;
        let list: Vec<RowPiece> = serde_json::from_str(&raw.unwrap_or_else(|| "[]".into())).map_err(err)?;
        Ok(list.into_iter().map(|p| p).collect())
    }

    pub fn thumb(&self, id: i64) -> Option<(Piece, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT thumb, uid FROM media WHERE id = ?1", [id], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)))
            .optional()
            .ok()
            .flatten()
            .and_then(|(t, uid)| {
                let p: RowPiece = serde_json::from_str(&t?).ok()?;
                Some((p, uid))
            })
    }

    pub fn sha256(&self, id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT sha256 FROM media WHERE id = ?1", [id], |r| r.get(0)).optional().ok().flatten().flatten()
    }

    /// Vault media with the same name and size (in any state, including
    /// trash): the backup treats it as already uploaded.
    pub fn find_name_size(&self, name: &str, size: i64) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id FROM media WHERE name = ?1 AND size = ?2 LIMIT 1", params![name, size], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn find_sha256(&self, sha256: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id FROM media WHERE sha256 = ?1 LIMIT 1", [sha256], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn uid(&self, id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT uid FROM media WHERE id = ?1", [id], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn id_of_uid(&self, uid: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id FROM media WHERE uid = ?1", [uid], |r| r.get(0)).optional().ok().flatten()
    }

    // ---- local writes (row + op in the queue) ----------------------------------------

    fn media_row(tx: &Transaction, id: i64) -> rusqlite::Result<(String, MediaRow)> {
        tx.query_row(
            "SELECT uid, name, mime, size, pieces, sha256, thumb, taken_at, tz, width, height, duration, camera, lat, lon,
                    favorite, archived, trashed_at, origin, added_at, modified_at, motion FROM media WHERE id = ?1",
            [id],
            |r| {
                let pieces: String = r.get(4)?;
                let (lat, lon): (Option<f64>, Option<f64>) = (r.get(13)?, r.get(14)?);
                Ok((
                    r.get(0)?,
                    MediaRow {
                        name: r.get(1)?,
                        mime: r.get(2)?,
                        size: r.get(3)?,
                        pieces: serde_json::from_str(&pieces).unwrap_or_default(),
                        sha256: r.get(5)?,
                        thumb: r.get::<_, Option<String>>(6)?.and_then(|t| serde_json::from_str(&t).ok()),
                        taken: r.get(7)?,
                        tz: r.get(8)?,
                        w: r.get(9)?,
                        h: r.get(10)?,
                        duration: r.get(11)?,
                        camera: r.get::<_, Option<String>>(12)?.and_then(|c| serde_json::from_str(&c).ok()),
                        gps: lat.zip(lon).map(|(a, b)| [a, b]),
                        fav: r.get(15)?,
                        archived: r.get(16)?,
                        trashed: r.get(17)?,
                        origin: r.get(18)?,
                        added: r.get(19)?,
                        mtime: r.get(20)?,
                        motion: r.get(21)?,
                    },
                ))
            },
        )
    }

    fn album_row(tx: &Transaction, id: i64) -> rusqlite::Result<(String, AlbumRow)> {
        tx.query_row("SELECT uid, name, cover_uid, created_at, modified_at FROM albums WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, AlbumRow { name: r.get(1)?, cover: r.get(2)?, ctime: r.get(3)?, mtime: r.get(4)? }))
        })
    }

    fn enqueue(tx: &Transaction, op: &Op) -> rusqlite::Result<()> {
        tx.execute("INSERT INTO outbox (op) VALUES (?1)", [serde_json::to_string(op).unwrap_or_default()])?;
        Ok(())
    }

    /// Re-emits the whole media `id` as an op (after changing some field).
    fn emit_media(&self, tx: &Transaction, id: i64) -> rusqlite::Result<()> {
        let hlc = self.clock.tick();
        tx.execute("UPDATE media SET hlc = ?2, modified_at = ?3 WHERE id = ?1", params![id, hlc, now_ms()])?;
        let (uid, row) = Self::media_row(tx, id)?;
        Self::enqueue(tx, &Op { e: MEDIA.into(), id: uid, hlc, row: Some(json!(row)), del: false })
    }

    fn emit_album(&self, tx: &Transaction, id: i64) -> rusqlite::Result<()> {
        let hlc = self.clock.tick();
        tx.execute("UPDATE albums SET hlc = ?2, modified_at = ?3 WHERE id = ?1", params![id, hlc, now_ms()])?;
        let (uid, row) = Self::album_row(tx, id)?;
        Self::enqueue(tx, &Op { e: ALBUM.into(), id: uid, hlc, row: Some(json!(row)), del: false })
    }

    fn tombstone(&self, tx: &Transaction, e: &str, uid: &str) -> rusqlite::Result<()> {
        let hlc = self.clock.tick();
        tx.execute("INSERT OR REPLACE INTO tombstones (e, uid, hlc, at) VALUES (?1, ?2, ?3, ?4)", params![e, uid, hlc, now_ms()])?;
        Self::enqueue(tx, &Op { e: e.into(), id: uid.into(), hlc, row: None, del: true })
    }

    fn write<T>(&self, f: impl FnOnce(&Transaction) -> rusqlite::Result<T>) -> Result<T> {
        let out = {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction().map_err(err)?;
            let out = f(&tx).map_err(err)?;
            tx.commit().map_err(err)?;
            out
        };
        self.changed.notify_one();
        Ok(out)
    }

    // ---- Shorts ---------------------------------------------------------------------

    /// Next in the feed: picked randomly among the least viewed (summing
    /// devices), excluding trash and archive, without the ones already shown (`skip`).
    pub fn shorts_next(&self, skip: &[i64], limit: usize) -> Result<Vec<Short>> {
        let skip = serde_json::to_string(skip).unwrap_or_else(|_| "[]".into());
        let list = self.query(
            &format!(
                "SELECT {COLS} FROM media WHERE trashed_at IS NULL AND archived = 0 AND id NOT IN (SELECT value FROM json_each(?1))
                 ORDER BY (SELECT COALESCE(SUM(n), 0) FROM views WHERE media_uid = media.uid), RANDOM() LIMIT ?2"
            ),
            params![skip, limit as i64],
        )?;
        self.with_stats(list)
    }

    /// Views (all devices) and like state of each media item.
    fn with_stats(&self, list: Vec<Media>) -> Result<Vec<Short>> {
        let conn = self.conn.lock().unwrap();
        list.into_iter()
            .map(|m| {
                let views = conn.query_row("SELECT COALESCE(SUM(n), 0) FROM views WHERE media_uid = ?1", [&m.uid], |r| r.get(0)).map_err(err)?;
                let liked = conn.query_row("SELECT liked FROM likes WHERE uid = ?1", [&m.uid], |r| r.get(0)).optional().map_err(err)?.unwrap_or(false);
                Ok(Short { media: m, views, liked })
            })
            .collect()
    }

    /// Like history: from the most recent like to the oldest.
    pub fn shorts_liked(&self) -> Result<Vec<Short>> {
        let list = self.query(
            &format!(
                "SELECT {COLS} FROM media WHERE trashed_at IS NULL AND uid IN (SELECT uid FROM likes WHERE liked = 1)
                 ORDER BY (SELECT hlc FROM likes WHERE likes.uid = media.uid) DESC"
            ),
            [],
        )?;
        self.with_stats(list)
    }

    /// Like in Shorts (does not touch library favorites). Without `sync`
    /// (read-only vault), it stays only on this device.
    pub fn short_like(&self, id: i64, on: bool, sync: bool) -> Result<()> {
        let Some(uid) = self.uid(id) else { return Ok(()) };
        self.write(|tx| {
            let hlc = self.clock.tick();
            tx.execute(
                "INSERT INTO likes (uid, liked, hlc) VALUES (?1, ?2, ?3) ON CONFLICT(uid) DO UPDATE SET liked = excluded.liked, hlc = excluded.hlc",
                params![uid, on, hlc],
            )?;
            if !sync {
                return Ok(());
            }
            Self::enqueue(tx, &Op { e: LIKE.into(), id: uid.clone(), hlc, row: Some(json!(LikeRow { on })), del: false })
        })
    }

    /// One more view from this device. Returns the total (all devices).
    /// Without `sync` (read-only vault), it counts only here.
    pub fn short_view(&self, id: i64, sync: bool) -> Result<i64> {
        let Some(media) = self.uid(id) else { return Ok(0) };
        let uid = format!("{media}.{}", self.clock.device());
        self.write(|tx| {
            let n: i64 = tx.query_row("SELECT n FROM views WHERE uid = ?1", [&uid], |r| r.get(0)).optional()?.unwrap_or(0) + 1;
            let (hlc, at) = (self.clock.tick(), now_ms());
            tx.execute(
                "INSERT INTO views (uid, media_uid, n, at, hlc) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(uid) DO UPDATE SET n = excluded.n, at = excluded.at, hlc = excluded.hlc",
                params![uid, media, n, at, hlc],
            )?;
            if sync {
                Self::enqueue(tx, &Op { e: VIEW.into(), id: uid.clone(), hlc, row: Some(json!(ViewRow { media: media.clone(), n, at })), del: false })?;
            }
            tx.query_row("SELECT COALESCE(SUM(n), 0) FROM views WHERE media_uid = ?1", [&media], |r| r.get(0))
        })
    }

    /// Records an uploaded media item, with metadata read from the file.
    #[allow(clippy::too_many_arguments)]
    pub fn insert(&self, name: &str, mime: &str, size: i64, pieces: &[Piece], sha256: Option<&str>, m: &meta::Meta, origin: Option<&str>) -> Result<Media> {
        let now = now_ms();
        let id = self.write(|tx| {
            tx.execute(
                "INSERT INTO media (uid, name, mime, size, pieces, sha256, taken_at, tz, width, height, duration, camera, lat, lon, origin, added_at, modified_at, hlc, motion)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, '', ?17)",
                params![
                    ulid::Ulid::new().to_string(),
                    name,
                    mime,
                    size,
                    pieces_json(pieces),
                    sha256,
                    m.taken.unwrap_or(now),
                    m.tz,
                    m.width,
                    m.height,
                    m.duration,
                    m.camera.as_ref().and_then(|c| serde_json::to_string(c).ok()),
                    m.gps.map(|g| g.0),
                    m.gps.map(|g| g.1),
                    origin,
                    now,
                    m.motion
                ],
            )?;
            let id = tx.last_insert_rowid();
            self.emit_media(tx, id)?;
            Ok(id)
        })?;
        self.get(id)?.ok_or_else(|| c::code(c::ITEM_NOT_FOUND, "inserção perdida"))

    }

    /// Thumbnail (document in the channel) and, if provided, duration and dimensions.
    pub fn set_thumb(&self, id: i64, thumb: Piece, duration: Option<f64>) -> Result<()> {
        let json = serde_json::to_string(&thumb).map_err(err)?;
        self.write(|tx| {
            tx.execute("UPDATE media SET thumb = ?2, duration = COALESCE(duration, ?3) WHERE id = ?1", params![id, json, duration])?;
            self.emit_media(tx, id)
        })
    }

    /// Videos without duration or dimensions (the reader did not understand the file on upload): id, name, mime type.
    pub fn videos_missing_meta(&self) -> Result<Vec<(i64, String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, mime FROM media WHERE mime LIKE 'video/%' AND trashed_at IS NULL AND (duration IS NULL OR width IS NULL) ORDER BY taken_at DESC")
            .map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    /// Fills only what is missing (duration, dimensions). `true` = something changed.
    pub fn set_video_meta(&self, id: i64, duration: Option<f64>, width: Option<u32>, height: Option<u32>) -> Result<bool> {
        let duration = duration.filter(|d| d.is_finite() && *d > 0.0);
        let (width, height) = if width.is_some() && height.is_some() { (width, height) } else { (None, None) };
        self.write(|tx| {
            let n = tx.execute(
                "UPDATE media SET duration = COALESCE(duration, ?2), width = COALESCE(width, ?3), height = COALESCE(height, ?4)
                 WHERE id = ?1 AND ((duration IS NULL AND ?2 IS NOT NULL) OR (width IS NULL AND ?3 IS NOT NULL))",
                params![id, duration, width, height],
            )?;
            if n > 0 {
                self.emit_media(tx, id)?;
            }
            Ok(n > 0)
        })
    }

    /// Motion photo checked by the UI on open: video bytes (0 = it is not one).
    /// Only writes if it changed, to avoid republishing the row needlessly.
    pub fn set_motion(&self, id: i64, motion: i64) -> Result<()> {
        let motion = motion.max(0);
        self.write(|tx| {
            if tx.execute("UPDATE media SET motion = ?2 WHERE id = ?1 AND (motion IS NULL OR motion != ?2)", params![id, motion])? > 0 {
                self.emit_media(tx, id)?;
            }
            Ok(())
        })
    }

    fn set_flag(&self, ids: &[i64], sql: &str, value: Option<i64>) -> Result<()> {
        self.write(|tx| {
            for id in ids {
                if tx.execute(sql, params![id, value])? > 0 {
                    self.emit_media(tx, *id)?;
                }
            }
            Ok(())
        })
    }

    pub fn set_favorite(&self, ids: &[i64], on: bool) -> Result<()> {
        self.set_flag(ids, "UPDATE media SET favorite = ?2 WHERE id = ?1 AND favorite != ?2", Some(on as i64))
    }

    pub fn set_archived(&self, ids: &[i64], on: bool) -> Result<()> {
        self.set_flag(ids, "UPDATE media SET archived = ?2 WHERE id = ?1 AND archived != ?2", Some(on as i64))
    }

    pub fn set_trashed(&self, ids: &[i64], on: bool) -> Result<()> {
        if on {
            self.set_flag(ids, "UPDATE media SET trashed_at = ?2 WHERE id = ?1 AND trashed_at IS NULL", Some(now_ms()))
        } else {
            self.set_flag(ids, "UPDATE media SET trashed_at = ?2 WHERE id = ?1 AND trashed_at IS NOT NULL", None)
        }
    }

    /// Adjusts the capture date (photos without EXIF, camera with a wrong clock).
    pub fn set_taken(&self, id: i64, taken_ms: i64, tz: Option<i32>) -> Result<()> {
        self.write(|tx| {
            tx.execute("UPDATE media SET taken_at = ?2, tz = ?3 WHERE id = ?1", params![id, taken_ms, tz])?;
            self.emit_media(tx, id)
        })
    }

    /// Fills in the location for items without one (the Google JSON arrived after the photo).
    pub fn set_gps_if_missing(&self, id: i64, lat: f64, lon: f64) -> Result<()> {
        self.write(|tx| {
            let n = tx.execute("UPDATE media SET lat = ?2, lon = ?3 WHERE id = ?1 AND lat IS NULL", params![id, lat, lon])?;
            if n > 0 {
                self.emit_media(tx, id)?;
            }
            Ok(())
        })
    }

    /// Deletes for good. Returns the messages left without media, to remove them from the channel.
    pub fn purge(&self, ids: &[i64]) -> Result<Vec<i32>> {
        self.write(|tx| {
            tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS doomed(id INTEGER PRIMARY KEY); DELETE FROM doomed;")?;
            for id in ids {
                tx.execute("INSERT OR IGNORE INTO doomed VALUES (?1)", [id])?;
            }
            let orphans: Vec<i32> = {
                let mut stmt = tx.prepare(ORPHANS)?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let uids: Vec<String> = {
                let mut stmt = tx.prepare("SELECT uid FROM media WHERE id IN doomed")?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for uid in &uids {
                self.tombstone(tx, MEDIA, uid)?;
                let items: Vec<String> = {
                    let mut stmt = tx.prepare("SELECT uid FROM album_items WHERE media_uid = ?1")?;
                    let rows = stmt.query_map([uid], |r| r.get(0))?;
                    rows.collect::<rusqlite::Result<_>>()?
                };
                for item in items {
                    self.tombstone(tx, ALBUM_ITEM, &item)?;
                }
                tx.execute("DELETE FROM album_items WHERE media_uid = ?1", [uid])?;
            }
            tx.execute("DELETE FROM media WHERE id IN doomed", [])?;
            Ok(orphans)
        })
    }

    pub fn trashed_ids(&self) -> Result<Vec<i64>> {
        Ok(self.list(View::Trash)?.into_iter().map(|m| m.id).collect())
    }

    /// Items in the trash beyond the retention period.
    pub fn expired_ids(&self) -> Result<Vec<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM media WHERE trashed_at IS NOT NULL AND trashed_at < ?1").map_err(err)?;
        let rows = stmt.query_map([now_ms() - TRASH_RETENTION_MS], |r| r.get(0)).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    // ---- albums ---------------------------------------------------------------------

    pub fn album_create(&self, name: &str) -> Result<i64> {
        let name = name.trim();
        if name.is_empty() {
            return Err(c::NAME_REQUIRED.into());
        }
        self.write(|tx| {
            let now = now_ms();
            tx.execute(
                "INSERT INTO albums (uid, name, created_at, modified_at, hlc) VALUES (?1, ?2, ?3, ?3, '')",
                params![ulid::Ulid::new().to_string(), name, now],
            )?;
            let id = tx.last_insert_rowid();
            self.emit_album(tx, id)?;
            Ok(id)
        })
    }

    pub fn album_rename(&self, id: i64, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(c::NAME_REQUIRED.into());
        }
        self.write(|tx| {
            tx.execute("UPDATE albums SET name = ?2 WHERE id = ?1", params![id, name])?;
            self.emit_album(tx, id)
        })
    }

    pub fn album_set_cover(&self, id: i64, media: i64) -> Result<()> {
        self.write(|tx| {
            tx.execute("UPDATE albums SET cover_uid = (SELECT uid FROM media WHERE id = ?2) WHERE id = ?1", params![id, media])?;
            self.emit_album(tx, id)
        })
    }

    /// Deletes the album (the media stays in the library).
    pub fn album_delete(&self, id: i64) -> Result<()> {
        self.write(|tx| {
            let Some(uid): Option<String> = tx.query_row("SELECT uid FROM albums WHERE id = ?1", [id], |r| r.get(0)).optional()? else {
                return Ok(());
            };
            let items: Vec<String> = {
                let mut stmt = tx.prepare("SELECT uid FROM album_items WHERE album_uid = ?1")?;
                let rows = stmt.query_map([&uid], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for item in items {
                self.tombstone(tx, ALBUM_ITEM, &item)?;
            }
            tx.execute("DELETE FROM album_items WHERE album_uid = ?1", [&uid])?;
            self.tombstone(tx, ALBUM, &uid)?;
            tx.execute("DELETE FROM albums WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    /// Adds media to the album; returns how many were added (ones already there stay).
    pub fn album_add(&self, album: i64, media: &[i64]) -> Result<usize> {
        self.write(|tx| {
            let Some(album_uid): Option<String> = tx.query_row("SELECT uid FROM albums WHERE id = ?1", [album], |r| r.get(0)).optional()? else {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            };
            let mut n = 0;
            for id in media {
                let Some(media_uid): Option<String> = tx.query_row("SELECT uid FROM media WHERE id = ?1", [id], |r| r.get(0)).optional()? else {
                    continue;
                };
                let uid = item_uid(&album_uid, &media_uid);
                let hlc = self.clock.tick();
                let added = now_ms();
                if tx.execute(
                    "INSERT OR IGNORE INTO album_items (uid, album_uid, media_uid, added_at, hlc) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![uid, album_uid, media_uid, added, hlc],
                )? == 0
                {
                    continue;
                }
                tx.execute("DELETE FROM tombstones WHERE e = ?1 AND uid = ?2", params![ALBUM_ITEM, uid])?;
                let row = AlbumItemRow { album: album_uid.clone(), media: media_uid, added };
                Self::enqueue(tx, &Op { e: ALBUM_ITEM.into(), id: uid, hlc, row: Some(json!(row)), del: false })?;
                n += 1;
            }
            if n > 0 {
                self.emit_album(tx, album)?;
            }
            Ok(n)
        })
        .map_err(|e| if e.contains("no rows") { c::ALBUM_NOT_FOUND.into()
 } else { e })
    }

    pub fn album_remove(&self, album: i64, media: &[i64]) -> Result<()> {
        self.write(|tx| {
            for id in media {
                let uid: Option<String> = tx
                    .query_row(
                        "SELECT i.uid FROM album_items i JOIN albums a ON a.uid = i.album_uid JOIN media m ON m.uid = i.media_uid
                         WHERE a.id = ?1 AND m.id = ?2",
                        params![album, id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(uid) = uid {
                    self.tombstone(tx, ALBUM_ITEM, &uid)?;
                    tx.execute("DELETE FROM album_items WHERE uid = ?1", [&uid])?;
                }
            }
            self.emit_album(tx, album)
        })
    }
}

// ---- automatic backup (device-local state) --------------------------------------------

impl Db {
    /// Watched folders: absolute paths (desktop) or MediaStore-relative
    /// ("DCIM/Camera", Android).
    pub fn backup_folders(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM backup_folders ORDER BY added_at").map_err(err)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn backup_set_folder(&self, path: &str, on: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        if on {
            conn.execute("INSERT OR IGNORE INTO backup_folders (path, added_at) VALUES (?1, ?2)", params![path, now_ms()])
        } else {
            conn.execute("DELETE FROM backup_folders WHERE path = ?1", [path])
        }
        .map_err(err)?;
        Ok(())
    }

    /// Folders shown on the timeline without backup.
    pub fn show_folders(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM show_folders ORDER BY added_at").map_err(err)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn show_set_folder(&self, path: &str, on: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        if on {
            conn.execute("INSERT OR IGNORE INTO show_folders (path, added_at) VALUES (?1, ?2)", params![path, now_ms()])
        } else {
            conn.execute("DELETE FROM show_folders WHERE path = ?1", [path])
        }
        .map_err(err)?;
        Ok(())
    }

    /// Local gallery folders: backed up or only shown.
    pub fn gallery_folders(&self) -> Result<Vec<String>> {
        let mut all = self.backup_folders()?;
        for f in self.show_folders()? {
            if !all.contains(&f) {
                all.push(f);
            }
        }
        Ok(all)
    }

    /// Status of each source: 0 = not in the vault, 1 = queued, 2 = in the vault.
    pub fn backup_status(&self, srcs: &[String]) -> Result<Vec<u8>> {
        let conn = self.conn.lock().unwrap();
        let mut done = conn
            .prepare("SELECT 1 FROM backup_done d JOIN media m ON m.uid = d.media_uid WHERE d.src = ?1")
            .map_err(err)?;
        let mut seen = conn.prepare("SELECT 1 FROM backup_seen WHERE src = ?1 OR src = ?2").map_err(err)?;
        let mut excluded = conn.prepare("SELECT 1 FROM backup_excluded WHERE src = ?1").map_err(err)?;
        let mut out = Vec::with_capacity(srcs.len());
        for src in srcs {
            let key = src_key(src);
            out.push(if excluded.exists([key]).map_err(err)? {
                0
            } else if done.exists([key]).map_err(err)? {
                2
            } else if seen.exists([src.as_str(), key]).map_err(err)? {
                1
            } else {
                0
            });
        }
        Ok(out)
    }

    /// The source has already gone through this device's automatic backup.
    fn backup_seen(&self, src: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1 FROM backup_seen WHERE src = ?1 OR src = ?2", [src, src_key(src)], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    pub(crate) fn backup_record(&self, src: &str, media: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO backup_done (src, media_uid) SELECT ?1, uid FROM media WHERE id = ?2",
            params![src_key(src), media],
        )
        .map_err(err)?;
        Ok(())
    }

    /// The local file left the device (deleted/moved): forget the source.
    pub fn backup_forget(&self, srcs: &[String]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        for src in srcs {
            tx.execute("DELETE FROM backup_done WHERE src = ?1", [src_key(src)]).map_err(err)?;
            tx.execute("DELETE FROM backup_seen WHERE src = ?1 OR src = ?2", [src.as_str(), src_key(src)]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    // ---- device trash --------------------------------------------------------------------

    /// Records what was sent to the device trash; returns the vault media
    /// that have these originals (the vault goes to the trash along with them).
    pub fn device_trash_add(&self, entries: &[DeviceTrashIn]) -> Result<Vec<i64>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        let mut linked = Vec::new();
        for e in entries {
            let key = src_key(&e.src);
            let media: Option<(String, i64)> = tx
                .query_row("SELECT m.uid, m.id FROM backup_done d JOIN media m ON m.uid = d.media_uid WHERE d.src = ?1", [key], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .map_err(err)?;
            tx.execute(
                "INSERT OR REPLACE INTO device_trash (src, media_uid, name, mime, size, taken, folder, stash, trashed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![key, media.as_ref().map(|m| &m.0), e.name, e.mime, e.size, e.taken, e.folder, e.stash, now_ms()],
            )
            .map_err(err)?;
            linked.extend(media.map(|m| m.1));
        }
        tx.commit().map_err(err)?;
        Ok(linked)
    }

    pub fn device_trash_list(&self) -> Result<Vec<DeviceTrash>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.src, m.id, m.trashed_at IS NOT NULL, t.name, t.mime, t.size, t.taken, t.folder, t.stash, t.trashed_at
                 FROM device_trash t LEFT JOIN media m ON m.uid = t.media_uid ORDER BY t.trashed_at DESC",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(DeviceTrash {
                    src: r.get(0)?,
                    media_id: r.get(1)?,
                    media_trashed: r.get::<_, Option<bool>>(2)?.unwrap_or(false),
                    name: r.get(3)?,
                    mime: r.get(4)?,
                    size: r.get(5)?,
                    taken: r.get(6)?,
                    folder: r.get(7)?,
                    stash: r.get(8)?,
                    trashed_at: r.get(9)?,
                })
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    /// Left the device trash (restored, deleted for good or expired).
    /// `moved`: restored at another address (Android < 11) — the link to the
    /// vault moves to the new one.
    pub fn device_trash_remove(&self, srcs: &[String], moved: &[(String, String)]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        for src in srcs {
            tx.execute("DELETE FROM device_trash WHERE src = ?1", [src_key(src)]).map_err(err)?;
        }
        for (old, new) in moved {
            tx.execute("DELETE FROM device_trash WHERE src = ?1", [src_key(old)]).map_err(err)?;
            tx.execute("UPDATE OR REPLACE backup_done SET src = ?2 WHERE src = ?1", [src_key(old), src_key(new)]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    /// Originals on this device linked to vault media (unified trash,
    /// "out of sync" and "free up space").
    pub fn device_links(&self) -> Result<Vec<DeviceLink>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT d.src, m.id, m.trashed_at IS NOT NULL, m.size, m.name, m.mime
                 FROM backup_done d JOIN media m ON m.uid = d.media_uid
                 WHERE d.src NOT IN (SELECT src FROM device_trash)",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok(DeviceLink { src: r.get(0)?, media_id: r.get(1)?, trashed: r.get(2)?, size: r.get(3)?, name: r.get(4)?, mime: r.get(5)? }))
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn in_device_trash(&self, src: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1 FROM device_trash WHERE src = ?1", [src_key(src)], |_| Ok(())).optional().ok().flatten().is_some()
    }

    /// All known local sources (to validate actions on files).
    pub fn is_local_src(&self, src: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1 FROM backup_done WHERE src = ?1", [src_key(src)], |_| Ok(())).optional().ok().flatten().is_some()
    }

    /// "Delete from vault" while keeping it on the device: the media linked to `src` goes
    /// to the vault trash, the link disappears and the automatic backup does not upload it again.
    /// Returns the media.
    pub fn exclude_from_vault(&self, src: &str) -> Result<Option<i64>> {
        let key = src_key(src);
        let id: Option<i64> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row("SELECT m.id FROM backup_done d JOIN media m ON m.uid = d.media_uid WHERE d.src = ?1", [key], |r| r.get(0))
                .optional()
                .map_err(err)?
        };
        if let Some(id) = id {
            self.set_trashed(&[id], true)?;
        }
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM backup_done WHERE src = ?1", [key]).map_err(err)?;
        conn.execute("INSERT OR IGNORE INTO backup_excluded (src) VALUES (?1)", [key]).map_err(err)?;
        Ok(id)
    }

    /// Manual backup: the file can be uploaded again.
    pub fn backup_include(&self, srcs: &[String]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for s in srcs {
            conn.execute("DELETE FROM backup_excluded WHERE src = ?1", [src_key(s)]).map_err(err)?;
        }
        Ok(())
    }

    pub fn backup_mark_seen(&self, candidates: &[(String, i64, i64)]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        for (src, size, mtime) in candidates {
            tx.execute(
                "INSERT INTO backup_seen (src, size, mtime) VALUES (?1, ?2, ?3)
                 ON CONFLICT(src) DO UPDATE SET size = excluded.size, mtime = excluded.mtime",
                params![src, size, mtime],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    /// Of the candidates (source, size, modification time), the ones that have not
    /// entered the queue on this device yet (or changed since then). Marks the
    /// returned ones as seen.
    pub fn backup_take_new(&self, candidates: &[(String, i64, i64)]) -> Result<Vec<usize>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        let mut out = Vec::new();
        for (i, (src, size, mtime)) in candidates.iter().enumerate() {
            let seen: Option<(i64, i64)> = tx
                .query_row("SELECT size, mtime FROM backup_seen WHERE src = ?1", [src], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .map_err(err)?;
            if seen == Some((*size, *mtime)) {
                continue;
            }
            tx.execute(
                "INSERT INTO backup_seen (src, size, mtime) VALUES (?1, ?2, ?3)
                 ON CONFLICT(src) DO UPDATE SET size = excluded.size, mtime = excluded.mtime",
                params![src, size, mtime],
            )
            .map_err(err)?;
            out.push(i);
        }
        tx.commit().map_err(err)?;
        Ok(out)
    }
}

// ---- what the shared pieces (tg-app) see of this index -------------------------------

impl Library for Db {
    fn open(path: &Path, clock: Arc<Clock>) -> Result<Self> {
        Db::open(path, clock)
    }

    fn changed(&self) -> &Notify {
        &self.changed
    }

    fn item(&self, id: i64) -> Result<Option<Item>> {
        Ok(self.get(id)?.map(|m| Item { id: m.id, name: m.name, is_dir: false, size: m.size, mime: m.mime }))
    }

    fn children(&self, _id: i64) -> Result<Vec<Item>> {
        Ok(Vec::new())
    }

    fn uid(&self, id: i64) -> Option<String> {
        Db::uid(self, id)
    }

    fn id_of_uid(&self, uid: &str) -> Option<i64> {
        Db::id_of_uid(self, uid)
    }

    fn pieces(&self, id: i64) -> Result<Vec<Piece>> {
        Db::pieces(self, id)
    }

    fn sha256(&self, id: i64) -> Option<String> {
        Db::sha256(self, id)
    }

    fn find_sha256(&self, sha256: &str) -> Option<i64> {
        Db::find_sha256(self, sha256)
    }

    fn accepts(&self, name: &str, mime: &str) -> bool {
        is_media(mime) || is_media(&crate::backup::mime_of(name))
    }

    /// Folders become nothing: the contents go to the same destination (album or library).
    fn upload_folder(&self, parent: i64, _name: &str) -> Result<i64> {
        Ok(parent)
    }

    /// `parent` is the destination album (0 = library only).
    fn upload_done(&self, done: UploadDone) -> Result<serde_json::Value> {
        let id = match done.existing {
            // Already in the vault. Uploaded manually: comes back from the trash, if
            // applicable. Automatic backup: stays as is (the trash was a choice).
            Some(existing) => {
                let auto = done.auto || done.src.as_deref().is_some_and(|s| self.backup_seen(s));
                if !auto {
                    self.set_trashed(&[existing], false)?;
                }
                existing
            }
            None => {
                let mime = if is_media(&done.mime) { done.mime.clone() } else { crate::backup::mime_of(&done.name) };
                let file = done.source.as_ref().and_then(|s| s.open().ok());
                // No date in the file (photo that went through Telegram): use the upload date.
                let m = meta::read_with(file, &done.name, &mime, done.taken);
                self.insert(&done.name, &mime, done.size, &done.pieces, done.sha256.as_deref(), &m, done.origin.as_deref())?.id
            }
        };
        if done.parent != 0 && self.album(done.parent)?.is_some() {
            self.album_add(done.parent, &[id])?;
        }
        if let Some(src) = &done.src {
            self.backup_record(src, id)?;
        }
        serde_json::to_value(self.get(id)?).map_err(err)
    }

    fn thumb(&self, id: i64) -> Option<(Piece, String)> {
        Db::thumb(self, id)
    }

    fn set_thumb(&self, id: i64, thumb: Piece, duration: Option<f64>) -> Result<()> {
        Db::set_thumb(self, id, thumb, duration)
    }
    fn copy_out(&self, id: i64) -> Result<Option<CopyRow>> {
        if self.get(id)?.is_none() {
            return Ok(None);
        }
        let row = {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction().map_err(err)?;
            Self::media_row(&tx, id).map_err(err)?.1
        };
        Ok(Some(CopyRow { pieces: row.pieces.clone(), thumb: row.thumb, sha256: row.sha256.clone(), size: row.size, row: json!(row) }))
    }

    /// Media from another vault: same metadata (date, camera, GPS,
    /// favorite…), pieces and thumbnail from the destination. `parent` = album (0 = none).
    fn copy_in(&self, parent: i64, row: serde_json::Value, pieces: &[Piece], thumb: Option<Piece>) -> Result<i64> {
        let mut r: MediaRow = serde_json::from_value(row).map_err(err)?;
        r.pieces = pieces.to_vec();
        r.thumb = thumb;
        r.trashed = None;
        let id = self.write(|tx| {
            tx.execute(
                "INSERT INTO media (uid, name, mime, size, pieces, sha256, thumb, taken_at, tz, width, height, duration, camera, lat, lon,
                                    favorite, archived, trashed_at, origin, added_at, modified_at, hlc, motion)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL, ?18, ?19, ?19, '', ?20)",
                params![
                    ulid::Ulid::new().to_string(),
                    r.name,
                    r.mime,
                    r.size,
                    serde_json::to_string(&r.pieces).unwrap_or_else(|_| "[]".into()),
                    r.sha256,
                    r.thumb.map(|t| serde_json::to_string(&t).unwrap_or_default()),
                    r.taken,
                    r.tz,
                    r.w,
                    r.h,
                    r.duration,
                    r.camera.as_ref().and_then(|c| serde_json::to_string(c).ok()),
                    r.gps.map(|g| g[0]),
                    r.gps.map(|g| g[1]),
                    r.fav,
                    r.archived,
                    r.origin,
                    now_ms(),
                    r.motion
                ],
            )?;
            let id = tx.last_insert_rowid();
            self.emit_media(tx, id)?;
            Ok(id)
        })?;
        if parent != 0 && self.album(parent)?.is_some() {
            self.album_add(parent, &[id])?;
        }
        Ok(id)
    }

    fn thumb_replaced(&self, uid: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM thumb_changed WHERE uid = ?1", [uid]).unwrap_or(0) > 0
    }

    fn thumbs_all(&self) -> Vec<(Piece, String)> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT thumb, uid FROM media WHERE thumb IS NOT NULL") else { return Vec::new() };
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map(|rows| {
                rows.filter_map(|r| r.ok())
                    .filter_map(|(t, uid)| serde_json::from_str::<RowPiece>(&t).ok().map(|p| (p, uid)))
                    .collect()
            })
            .unwrap_or_default()
    }

}

/// MediaStore URI without the query (`?requireOriginal=1` changes with permission).
fn src_key(src: &str) -> &str {
    src.split('?').next().unwrap_or(src)
}

fn is_media(mime: &str) -> bool {
    mime.starts_with("image/") || mime.starts_with("video/")
}

// ---- sync --------------------------------------------------------------------------------

/// Current hlc of a row (live or tombstone).
fn current_hlc(tx: &Transaction, e: &str, uid: &str) -> rusqlite::Result<Option<String>> {
    let table = match e {
        MEDIA => "media",
        ALBUM => "albums",
        LIKE => "likes",
        VIEW => "views",
        _ => "album_items",
    };
    tx.query_row(
        &format!("SELECT hlc FROM {table} WHERE uid = ?2 UNION ALL SELECT hlc FROM tombstones WHERE e = ?1 AND uid = ?2"),
        params![e, uid],
        |r| r.get(0),
    )
    .optional()
}

fn apply_one(tx: &Transaction, op: &Op) -> rusqlite::Result<bool> {
    if !matches!(op.e.as_str(), MEDIA | ALBUM | ALBUM_ITEM | LIKE | VIEW) {
        return Ok(false);
    }
    if current_hlc(tx, &op.e, &op.id)?.as_deref().is_some_and(|h| h >= op.hlc.as_str()) {
        return Ok(false);
    }
    let table = match op.e.as_str() {
        MEDIA => "media",
        ALBUM => "albums",
        LIKE => "likes",
        VIEW => "views",
        _ => "album_items",
    };
    if op.del {
        tx.execute(&format!("DELETE FROM {table} WHERE uid = ?1"), [&op.id])?;
        tx.execute("INSERT OR REPLACE INTO tombstones (e, uid, hlc, at) VALUES (?1, ?2, ?3, ?4)", params![op.e, op.id, op.hlc, now_ms()])?;
        return Ok(true);
    }
    let Some(row) = op.row.clone() else { return Ok(false) };
    match op.e.as_str() {
        MEDIA => {
            let Ok(r) = serde_json::from_value::<MediaRow>(row) else { return Ok(false) };
            // Thumbnail replaced (regenerated on another device): the cache here becomes stale.
            let old: Option<String> = tx.query_row("SELECT thumb FROM media WHERE uid = ?1", [&op.id], |x| x.get(0)).optional()?.flatten();
            let new = r.thumb.as_ref().map(|t| serde_json::to_string(t).unwrap_or_default());
            if old.is_some() && new.is_some() && old != new {
                tx.execute("INSERT OR IGNORE INTO thumb_changed (uid) VALUES (?1)", [&op.id])?;
            }
            tx.execute(
                "INSERT INTO media (uid, name, mime, size, pieces, sha256, thumb, taken_at, tz, width, height, duration, camera, lat, lon,
                                    favorite, archived, trashed_at, origin, added_at, modified_at, hlc, motion)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
                 ON CONFLICT(uid) DO UPDATE SET name = excluded.name, mime = excluded.mime, size = excluded.size,
                   pieces = excluded.pieces, sha256 = excluded.sha256, thumb = excluded.thumb, taken_at = excluded.taken_at,
                   tz = excluded.tz, width = excluded.width, height = excluded.height, duration = excluded.duration,
                   camera = excluded.camera, lat = excluded.lat, lon = excluded.lon, favorite = excluded.favorite,
                   archived = excluded.archived, trashed_at = excluded.trashed_at, origin = excluded.origin,
                   added_at = excluded.added_at, modified_at = excluded.modified_at, hlc = excluded.hlc, motion = excluded.motion",
                params![
                    op.id,
                    r.name,
                    r.mime,
                    r.size,
                    serde_json::to_string(&r.pieces).unwrap_or_else(|_| "[]".into()),
                    r.sha256,
                    r.thumb.map(|t| serde_json::to_string(&t).unwrap_or_default()),
                    r.taken,
                    r.tz,
                    r.w,
                    r.h,
                    r.duration,
                    r.camera.and_then(|c| serde_json::to_string(&c).ok()),
                    r.gps.map(|g| g[0]),
                    r.gps.map(|g| g[1]),
                    r.fav,
                    r.archived,
                    r.trashed,
                    r.origin,
                    r.added,
                    r.mtime,
                    op.hlc,
                    r.motion
                ],
            )?;
        }
        ALBUM => {
            let Ok(r) = serde_json::from_value::<AlbumRow>(row) else { return Ok(false) };
            tx.execute(
                "INSERT INTO albums (uid, name, cover_uid, created_at, modified_at, hlc) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(uid) DO UPDATE SET name = excluded.name, cover_uid = excluded.cover_uid,
                   created_at = excluded.created_at, modified_at = excluded.modified_at, hlc = excluded.hlc",
                params![op.id, r.name, r.cover, r.ctime, r.mtime, op.hlc],
            )?;
        }
        LIKE => {
            let Ok(r) = serde_json::from_value::<LikeRow>(row) else { return Ok(false) };
            tx.execute(
                "INSERT INTO likes (uid, liked, hlc) VALUES (?1, ?2, ?3)
                 ON CONFLICT(uid) DO UPDATE SET liked = excluded.liked, hlc = excluded.hlc",
                params![op.id, r.on, op.hlc],
            )?;
        }
        VIEW => {
            let Ok(r) = serde_json::from_value::<ViewRow>(row) else { return Ok(false) };
            tx.execute(
                "INSERT INTO views (uid, media_uid, n, at, hlc) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(uid) DO UPDATE SET media_uid = excluded.media_uid, n = excluded.n, at = excluded.at, hlc = excluded.hlc",
                params![op.id, r.media, r.n, r.at, op.hlc],
            )?;
        }
        _ => {
            let Ok(r) = serde_json::from_value::<AlbumItemRow>(row) else { return Ok(false) };
            tx.execute(
                "INSERT INTO album_items (uid, album_uid, media_uid, added_at, hlc) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(uid) DO UPDATE SET album_uid = excluded.album_uid, media_uid = excluded.media_uid,
                   added_at = excluded.added_at, hlc = excluded.hlc",
                params![op.id, r.album, r.media, r.added, op.hlc],
            )?;
        }
    }
    tx.execute("DELETE FROM tombstones WHERE e = ?1 AND uid = ?2", params![op.e, op.id])?;
    Ok(true)
}

impl Store for Db {
    fn apply(&self, ops: &[Op]) -> Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        let mut changed = 0;
        for op in ops {
            if apply_one(&tx, op).map_err(err)? {
                changed += 1;
            }
        }
        tx.commit().map_err(err)?;
        Ok(changed)
    }

    fn outbox(&self, limit: usize) -> Result<Vec<(i64, Op)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT seq, op FROM outbox ORDER BY seq LIMIT ?1").map_err(err)?;
        let rows = stmt.query_map([limit as i64], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, raw) = row.map_err(err)?;
            if let Ok(op) = serde_json::from_str::<Op>(&raw) {
                out.push((seq, op));
            }
        }
        Ok(out)
    }

    fn ack(&self, seqs: &[i64]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        for seq in seqs {
            tx.execute("DELETE FROM outbox WHERE seq = ?1", [seq]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    fn export(&self) -> Result<Vec<Op>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        let mut out = Vec::new();
        let ids = |sql: &str| -> rusqlite::Result<Vec<i64>> {
            let mut stmt = tx.prepare(sql)?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect()
        };
        for id in ids("SELECT id FROM albums").map_err(err)? {
            let hlc: String = tx.query_row("SELECT hlc FROM albums WHERE id = ?1", [id], |r| r.get(0)).map_err(err)?;
            let (uid, row) = Self::album_row(&tx, id).map_err(err)?;
            out.push(Op { e: ALBUM.into(), id: uid, hlc, row: Some(json!(row)), del: false });
        }
        for id in ids("SELECT id FROM media").map_err(err)? {
            let hlc: String = tx.query_row("SELECT hlc FROM media WHERE id = ?1", [id], |r| r.get(0)).map_err(err)?;
            let (uid, row) = Self::media_row(&tx, id).map_err(err)?;
            out.push(Op { e: MEDIA.into(), id: uid, hlc, row: Some(json!(row)), del: false });
        }
        {
            let mut stmt = tx.prepare("SELECT uid, album_uid, media_uid, added_at, hlc FROM album_items").map_err(err)?;
            let rows = stmt
                .query_map([], |r| {
                    let row = AlbumItemRow { album: r.get(1)?, media: r.get(2)?, added: r.get(3)? };
                    Ok(Op { e: ALBUM_ITEM.into(), id: r.get(0)?, hlc: r.get(4)?, row: Some(json!(row)), del: false })
                })
                .map_err(err)?;
            for op in rows {
                out.push(op.map_err(err)?);
            }
        }
        {
            let mut stmt = tx.prepare("SELECT uid, liked, hlc FROM likes").map_err(err)?;
            let rows = stmt
                .query_map([], |r| Ok(Op { e: LIKE.into(), id: r.get(0)?, hlc: r.get(2)?, row: Some(json!(LikeRow { on: r.get(1)? })), del: false }))
                .map_err(err)?;
            for op in rows {
                out.push(op.map_err(err)?);
            }
            let mut stmt = tx.prepare("SELECT uid, media_uid, n, at, hlc FROM views").map_err(err)?;
            let rows = stmt
                .query_map([], |r| {
                    let row = ViewRow { media: r.get(1)?, n: r.get(2)?, at: r.get(3)? };
                    Ok(Op { e: VIEW.into(), id: r.get(0)?, hlc: r.get(4)?, row: Some(json!(row)), del: false })
                })
                .map_err(err)?;
            for op in rows {
                out.push(op.map_err(err)?);
            }
        }
        tx.execute("DELETE FROM tombstones WHERE at < ?1", [now_ms() - TOMBSTONE_TTL_MS]).map_err(err)?;
        {
            let mut stmt = tx.prepare("SELECT e, uid, hlc FROM tombstones").map_err(err)?;
            let rows = stmt
                .query_map([], |r| Ok(Op { e: r.get(0)?, id: r.get(1)?, hlc: r.get(2)?, row: None, del: true }))
                .map_err(err)?;
            for op in rows {
                out.push(op.map_err(err)?);
            }
        }
        tx.commit().map_err(err)?;
        Ok(out)
    }

    fn meta(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().ok().flatten()
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(dev: &str) -> Db {
        let dir = std::env::temp_dir().join(format!("tgphotos-test-{dev}-{}", ulid::Ulid::new()));
        Db::open(&dir.join("t.db"), Arc::new(Clock::new(dev))).unwrap()
    }

    fn piece(msg_id: i32) -> Piece {
        Piece::new(msg_id, 10)
    }

    fn photo(d: &Db, name: &str, taken: i64, msg: i32) -> Media {
        let m = meta::Meta { taken: Some(taken), width: Some(4000), height: Some(3000), ..Default::default() };
        d.insert(name, "image/jpeg", 10, &[piece(msg)], Some(&format!("sha{msg}")), &m, None).unwrap()
    }

    /// Passes the whole queue from `from` to `to`, as the channel would.
    fn ship(from: &Db, to: &Db) -> usize {
        let q = from.outbox(10_000).unwrap();
        let ops: Vec<Op> = q.iter().map(|(_, o)| o.clone()).collect();
        from.ack(&q.iter().map(|(s, _)| *s).collect::<Vec<_>>()).unwrap();
        to.apply(&ops).unwrap()
    }

    #[test]
    fn shorts_sync_without_losing_views() {
        let a = db("aaaa");
        let b = db("bbbb");
        let p = photo(&a, "x.jpg", 1, 1);
        let q = photo(&a, "y.jpg", 2, 2);
        ship(&a, &b);
        let pb = b.id_of_uid(&p.uid).unwrap();
        // Both see it at the same time: the counts add up.
        a.short_view(p.id, true).unwrap();
        a.short_view(p.id, true).unwrap();
        b.short_view(pb, true).unwrap();
        b.short_like(pb, true, true).unwrap();
        ship(&a, &b);
        ship(&b, &a);
        let get = |d: &Db, uid: &str| d.shorts_next(&[], 10).unwrap().into_iter().find(|s| s.media.uid == uid).unwrap();
        for d in [&a, &b] {
            let s = get(d, &p.uid);
            assert_eq!((s.views, s.liked), (3, true));
        }
        assert_eq!(a.shorts_liked().unwrap().iter().map(|s| s.media.uid.clone()).collect::<Vec<_>>(), vec![p.uid.clone()]);
        // Liking is not favoriting.
        assert!(!a.get(p.id).unwrap().unwrap().favorite);
        // The least viewed comes first; the snapshot takes everything.
        assert_eq!(a.shorts_next(&[], 1).unwrap()[0].media.uid, q.uid);
        assert!(a.shorts_next(&[q.id], 1).unwrap()[0].media.uid == p.uid);
        let c = db("cccc");
        c.apply(&a.export().unwrap()).unwrap();
        assert_eq!(get(&c, &p.uid).views, 3);
        // Read-only: counts and likes here, nothing goes to the channel queue.
        ship(&c, &a);
        c.short_view(c.id_of_uid(&q.uid).unwrap(), false).unwrap();
        c.short_like(c.id_of_uid(&q.uid).unwrap(), true, false).unwrap();
        assert!(c.outbox(10).unwrap().is_empty());
        assert_eq!((get(&c, &q.uid).views, get(&c, &q.uid).liked), (1, true));
    }

    #[test]
    fn timeline_by_capture_date() {
        let a = db("a");
        photo(&a, "velha.jpg", 1_000_000, 1);
        photo(&a, "nova.jpg", 9_000_000, 2);
        let t = a.list(View::Timeline).unwrap();
        assert_eq!(t.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["nova.jpg", "velha.jpg"]);
        assert_eq!(t[0].taken_at, 9_000.0);
        assert_eq!(t[0].width, Some(4000));
    }

    #[test]
    fn motion_column_returns_even_with_higher_version() {
        let a = db("a");
        {
            let conn = a.conn.lock().unwrap();
            conn.execute_batch("ALTER TABLE media DROP COLUMN motion; PRAGMA user_version = 99;").unwrap();
            migrate(&conn).unwrap();
        }
        let p = photo(&a, "x.jpg", 1, 1);
        assert_eq!(a.get(p.id).unwrap().unwrap().motion, None);
    }

    #[test]
    fn motion_photo_replicates_and_republishes_only_if_changed() {
        let (a, b) = (db("a"), db("b"));
        let p = photo(&a, "mov.jpg", 1_000, 1);
        assert_eq!(p.motion, None);
        a.set_motion(p.id, 2_345_678).unwrap();
        let before = a.outbox(100).unwrap().len();
        a.set_motion(p.id, 2_345_678).unwrap();
        assert_eq!(a.outbox(100).unwrap().len(), before, "igual: não republica");
        let ops: Vec<Op> = a.outbox(100).unwrap().into_iter().map(|(_, o)| o).collect();
        b.apply(&ops).unwrap();
        assert_eq!(b.list(View::Timeline).unwrap()[0].motion, Some(2_345_678));
        a.set_motion(p.id, 0).unwrap();
        assert_eq!(a.get(p.id).unwrap().unwrap().motion, Some(0));
    }

    #[test]
    fn recents_by_send_order() {
        let a = db("a");
        // Uploaded first, but taken later; the second was uploaded last.
        photo(&a, "tirada-hoje.jpg", 9_000_000, 1);
        std::thread::sleep(std::time::Duration::from_millis(5));
        photo(&a, "tirada-antes.jpg", 1_000_000, 2);
        let r = a.list(View::Recent).unwrap();
        assert_eq!(r.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["tirada-antes.jpg", "tirada-hoje.jpg"]);
        let t = a.list(View::Timeline).unwrap();
        assert_eq!(t[0].name, "tirada-hoje.jpg");
    }

    #[test]
    fn batch_archive_and_unarchive_replicate_all_selected_items() {
        let (a, b) = (db("a"), db("b"));
        let ids: Vec<_> = (1..=3).map(|n| photo(&a, &format!("{n}.jpg"), n, n as i32).id).collect();
        photo(&a, "not-selected.jpg", 4, 4);
        a.set_archived(&ids, true).unwrap();
        ship(&a, &b);
        assert_eq!(a.list(View::Archive).unwrap().len(), 3);
        assert_eq!(b.list(View::Archive).unwrap().len(), 3);
        assert_eq!(b.list(View::Timeline).unwrap()[0].name, "not-selected.jpg");
        a.set_archived(&ids, false).unwrap();
        ship(&a, &b);
        assert!(a.list(View::Archive).unwrap().is_empty());
        assert!(b.list(View::Archive).unwrap().is_empty());
        assert_eq!(b.list(View::Timeline).unwrap().len(), 4);
    }

    #[test]
    fn favorites_file_and_trash_replicate() {
        let (a, b) = (db("a"), db("b"));
        let p = photo(&a, "p.jpg", 1, 1);
        let q = photo(&a, "q.jpg", 2, 2);
        let r = photo(&a, "r.jpg", 3, 3);
        a.set_favorite(&[p.id], true).unwrap();
        a.set_archived(&[q.id], true).unwrap();
        a.set_trashed(&[r.id], true).unwrap();
        ship(&a, &b);
        assert_eq!(b.list(View::Favorites).unwrap()[0].name, "p.jpg");
        assert_eq!(b.list(View::Archive).unwrap()[0].name, "q.jpg");
        assert_eq!(b.list(View::Trash).unwrap()[0].name, "r.jpg");
        assert_eq!(b.list(View::Timeline).unwrap().iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["p.jpg"]);
    }

    #[test]
    fn album_converges_between_devices() {
        let (a, b) = (db("a"), db("b"));
        let p = photo(&a, "p.jpg", 1, 1);
        let q = photo(&a, "q.jpg", 2, 2);
        let album = a.album_create("Viagem").unwrap();
        a.album_add(album, &[p.id]).unwrap();
        ship(&a, &b);
        // Both add the same photo and B removes the other: the row is the same (deterministic uid).
        let album_b = b.albums().unwrap()[0].id;
        let q_b = b.id_of_uid(&a.uid(q.id).unwrap()).unwrap();
        let p_b = b.id_of_uid(&a.uid(p.id).unwrap()).unwrap();
        a.album_add(album, &[q.id]).unwrap();
        b.album_add(album_b, &[q_b]).unwrap();
        b.album_remove(album_b, &[p_b]).unwrap();
        ship(&a, &b);
        ship(&b, &a);
        let names = |d: &Db, id| d.album_media(id).unwrap().into_iter().map(|m| m.name).collect::<Vec<_>>();
        assert_eq!(names(&a, album), ["q.jpg"]);
        assert_eq!(names(&b, album_b), ["q.jpg"]);
        assert_eq!(a.albums().unwrap()[0].count, 1);
    }

    #[test]
    fn purge_removes_from_album_and_releases_messages() {
        let (a, b) = (db("a"), db("b"));
        let p = photo(&a, "p.jpg", 1, 5);
        a.set_thumb(p.id, piece(6), None).unwrap();
        let album = a.album_create("X").unwrap();
        a.album_add(album, &[p.id]).unwrap();
        ship(&a, &b);
        let mut orphans = a.purge(&[p.id]).unwrap();
        orphans.sort();
        assert_eq!(orphans, vec![5, 6]);
        ship(&a, &b);
        assert!(b.list(View::Timeline).unwrap().is_empty());
        assert_eq!(b.albums().unwrap()[0].count, 0);
        // Snapshot with tombstones beats old delayed ops.
        let snap = a.export().unwrap();
        let c = db("c");
        c.apply(&snap).unwrap();
        assert!(c.list(View::Timeline).unwrap().is_empty());
        assert_eq!(c.albums().unwrap()[0].name, "X");
    }

    #[test]
    fn last_writer_wins() {
        let (a, b) = (db("a"), db("b"));
        let p = photo(&a, "p.jpg", 1, 1);
        ship(&a, &b);
        let pb = b.list(View::Timeline).unwrap()[0].id;
        a.set_favorite(&[p.id], true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        b.set_archived(&[pb], true).unwrap();
        let from_a: Vec<Op> = a.outbox(100).unwrap().into_iter().map(|(_, o)| o).collect();
        let from_b: Vec<Op> = b.outbox(100).unwrap().into_iter().map(|(_, o)| o).collect();
        a.apply(&from_b).unwrap();
        b.apply(&from_a).unwrap();
        // Whole row by LWW: B's write (newer) wins on both.
        for d in [&a, &b] {
            let m = &d.list(View::Archive).unwrap()[0];
            assert!(m.archived && !m.favorite);
        }
        assert_eq!(b.apply(&from_a).unwrap(), 0);
    }

    #[test]
    fn backup_only_takes_what_is_new_or_changed() {
        let a = db("a");
        let c = |s: &str, size, mtime| (s.to_string(), size, mtime);
        assert_eq!(a.backup_take_new(&[c("/f/a.jpg", 10, 1), c("/f/b.jpg", 20, 1)]).unwrap(), vec![0, 1]);
        assert!(a.backup_take_new(&[c("/f/a.jpg", 10, 1)]).unwrap().is_empty());
        // Edited (size/date changed) enters again; dedup by sha256 decides whether it goes up.
        assert_eq!(a.backup_take_new(&[c("/f/a.jpg", 11, 2), c("/f/b.jpg", 20, 1)]).unwrap(), vec![0]);
        assert_eq!(a.backup_status(&["/f/a.jpg".into(), "/x.jpg".into()]).unwrap(), vec![1, 0]);
        let p = photo(&a, "a.jpg", 1, 1);
        a.backup_record("content://media/1?requireOriginal=1", p.id).unwrap();
        assert_eq!(a.backup_status(&["content://media/1".into()]).unwrap(), vec![2]);
        a.purge(&[p.id]).unwrap();
        assert_eq!(a.backup_status(&["content://media/1".into()]).unwrap(), vec![0]);
        a.backup_set_folder("/f", true).unwrap();
        a.backup_set_folder("/f", true).unwrap();
        assert_eq!(a.backup_folders().unwrap(), ["/f"]);
        a.backup_set_folder("/f", false).unwrap();
        assert!(a.backup_folders().unwrap().is_empty());
    }

    #[test]
    fn encrypted_piece_replicates_with_nonce() {
        let (a, b) = (db("a"), db("b"));
        let enc = Piece { msg_id: 9, size: 100, nonce: Some([7; 16]) };
        let m = meta::Meta { taken: Some(1), ..Default::default() };
        let p = a.insert("x.jpg", "image/jpeg", 100, &[enc], None, &m, None).unwrap();
        ship(&a, &b);
        let pb = b.id_of_uid(&a.uid(p.id).unwrap()).unwrap();
        assert_eq!(b.pieces(pb).unwrap(), vec![enc]);
        // And the snapshot (new device) takes it too.
        let c = db("c");
        c.apply(&a.export().unwrap()).unwrap();
        assert_eq!(c.pieces(c.id_of_uid(&a.uid(p.id).unwrap()).unwrap()).unwrap(), vec![enc]);
    }

    #[test]
    fn copy_to_another_vault_carries_metadata() {
        use tg_app::Library;
        let (a, b) = (db("a"), db("b"));
        let m = meta::Meta { taken: Some(5_000), gps: Some((-23.5, -46.6)), ..Default::default() };
        let p = a.insert("praia.jpg", "image/jpeg", 10, &[piece(1)], Some("sha1"), &m, Some("DCIM/Camera")).unwrap();
        a.set_favorite(&[p.id], true).unwrap();
        let out = a.copy_out(p.id).unwrap().unwrap();
        assert_eq!(out.pieces, vec![piece(1)]);
        let album = b.album_create("Viagem").unwrap();
        let id = b.copy_in(album, out.row, &[piece(77)], Some(piece(78))).unwrap();
        let got = b.get(id).unwrap().unwrap();
        assert_eq!((got.name.as_str(), got.taken_at, got.favorite, got.lat, got.thumb), ("praia.jpg", 5.0, true, Some(-23.5), true));
        assert_eq!(b.pieces(id).unwrap(), vec![piece(77)]);
        assert_ne!(b.uid(id), a.uid(p.id));
        assert_eq!(b.album_media(album).unwrap().len(), 1);
        assert_eq!(b.find_sha256("sha1"), Some(id));
    }

    #[test]
    fn details_and_search() {
        let a = db("a");
        let m = meta::Meta {
            taken: Some(1),
            camera: Some(Camera { make: Some("Google".into()), model: Some("Pixel 8".into()), ..Default::default() }),
            gps: Some((-23.5, -46.6)),
            ..Default::default()
        };
        let p = a.insert("IMG_1.jpg", "image/jpeg", 1, &[piece(1)], None, &m, Some("DCIM/Camera")).unwrap();
        let album = a.album_create("Praia").unwrap();
        a.album_add(album, &[p.id]).unwrap();
        let d = a.details(p.id).unwrap().unwrap();
        assert_eq!(d.camera.unwrap().model.as_deref(), Some("Pixel 8"));
        assert_eq!(d.media.lat, Some(-23.5));
        assert_eq!(d.albums[0].name, "Praia");
        for q in ["pixel", "praia", "camera", "img_1"] {
            assert_eq!(a.search(q).unwrap().len(), 1, "{q}");
        }
    }

    fn done(existing: i64, auto: bool) -> UploadDone {
        UploadDone {
            parent: 0,
            name: "IMG_1.jpg".into(),
            size: 10,
            mime: "image/jpeg".into(),
            pieces: vec![piece(1)],
            sha256: Some("sha1".into()),
            source: None,
            existing: Some(existing),
            origin: None,
            src: Some("content://media/1".into()),
            auto,
            taken: None,
        }
    }

    #[test]
    fn automatic_backup_does_not_take_from_trash() {
        let a = db("lix");
        let m = photo(&a, "IMG_1.jpg", 1_000, 1);
        a.set_trashed(&[m.id], true).unwrap();
        a.upload_done(done(m.id, true)).unwrap();
        assert!(a.get(m.id).unwrap().unwrap().trashed_at.is_some(), "backup automático tirou da lixeira");
        assert_eq!(a.backup_status(&["content://media/1".into()]).unwrap(), vec![2]);
        // Old queue (without the flag), but the source came from backup: it stays.
        a.backup_mark_seen(&[("content://media/1".into(), 10, 0)]).unwrap();
        a.upload_done(done(m.id, false)).unwrap();
        assert!(a.get(m.id).unwrap().unwrap().trashed_at.is_some());
        // Uploaded manually (source the backup never saw): comes back.
        let mut manual = done(m.id, false);
        manual.src = Some("/home/u/IMG_1.jpg".into());
        a.upload_done(manual).unwrap();
        assert!(a.get(m.id).unwrap().unwrap().trashed_at.is_none());
    }

    #[test]
    fn recognizes_by_name_and_size_even_in_trash() {
        let a = db("nome");
        let m = photo(&a, "IMG_1.jpg", 1_000, 1);
        a.set_trashed(&[m.id], true).unwrap();
        assert_eq!(a.find_name_size("IMG_1.jpg", 10), Some(m.id));
        assert_eq!(a.find_name_size("IMG_1.jpg", 11), None);
        assert_eq!(a.find_name_size("IMG_2.jpg", 10), None);
    }

    fn entry(src: &str) -> DeviceTrashIn {
        DeviceTrashIn { src: src.into(), name: "IMG_1.jpg".into(), mime: "image/jpeg".into(), size: 10, taken: 1_000, folder: "DCIM/Camera".into(), stash: None }
    }

    #[test]
    fn device_trash_links_to_vault() {
        let a = db("devtrash");
        let m = photo(&a, "IMG_1.jpg", 1_000, 1);
        a.backup_record("content://media/external/images/media/7?requireOriginal=1", m.id).unwrap();
        // Linked original: shows up in the links.
        let links = a.device_links().unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].media_id, m.id);
        // To the device trash: returns the linked vault media and leaves the links.
        let linked = a.device_trash_add(&[entry("content://media/external/images/media/7"), entry("content://media/external/images/media/8")]).unwrap();
        assert_eq!(linked, vec![m.id]);
        assert!(a.device_links().unwrap().is_empty());
        let rows = a.device_trash_list().unwrap();
        assert_eq!(rows.len(), 2);
        let mine = rows.iter().find(|r| r.src.ends_with("/7")).unwrap();
        assert_eq!(mine.media_id, Some(m.id));
        assert!(!mine.media_trashed);
        assert!(rows.iter().any(|r| r.src.ends_with("/8") && r.media_id.is_none()));
        a.set_trashed(&[m.id], true).unwrap();
        assert!(a.device_trash_list().unwrap().iter().any(|r| r.media_id == Some(m.id) && r.media_trashed));
    }

    #[test]
    fn restore_with_new_address_moves_link() {
        let a = db("devmove");
        let m = photo(&a, "IMG_1.jpg", 1_000, 1);
        a.backup_record("content://media/external/images/media/7", m.id).unwrap();
        a.device_trash_add(&[entry("content://media/external/images/media/7")]).unwrap();
        a.device_trash_remove(&[], &[("content://media/external/images/media/7".into(), "content://media/external/images/media/99".into())]).unwrap();
        assert!(a.device_trash_list().unwrap().is_empty());
        let links = a.device_links().unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].src, "content://media/external/images/media/99");
        assert_eq!(a.local_src(m.id).as_deref(), Some("content://media/external/images/media/99"));
    }
}
