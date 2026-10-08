//! Cache local de um vault do TGPhotos (SQLite). A fonte da verdade é o
//! canal: cada mutação grava a linha e a op na fila, na mesma transação; ops de
//! outros aparelhos entram por [`Store::apply`] com last-writer-wins por linha.
//! Entidades (FORMAT.md): `media`, `album` e `album_item` (um por par álbum ×
//! mídia, para dois aparelhos mexerem no mesmo álbum sem conflito); dos Curtas,
//! `like` (uma por mídia) e `view` (uma por mídia × aparelho: cada aparelho só
//! escreve a própria contagem, então somar não perde visualizações).
//!
//! Para a interface, mídias e álbuns têm ids inteiros locais (estáveis neste
//! aparelho); entre aparelhos a identidade é o `uid` (ULID).

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
const PERSON: &str = crate::intel::people::ENTITY;
const PACK: &str = crate::intel::packs::ENTITY;
const FRAMES: &str = crate::intel::frames::ENTITY;
/// Tombstones ficam no snapshot por 30 dias.
const TOMBSTONE_TTL_MS: i64 = 30 * 86_400_000;
/// Itens na lixeira há mais que isso saem de vez.
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

// ---- o que a interface vê ------------------------------------------------------

/// Mídia como a interface vê. Tempos em segundos.
#[derive(Serialize, Clone, Debug)]
pub struct Media {
    pub id: i64,
    pub name: String,
    pub mime: String,
    pub size: i64,
    /// Tem miniatura (servida em `/thumb/<id>`).
    pub thumb: bool,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// Captura (UTC, segundos com fração de ms).
    pub taken_at: f64,
    /// Fuso da captura em minutos, quando conhecido.
    pub tz: Option<i32>,
    pub favorite: bool,
    pub archived: bool,
    pub trashed_at: Option<i64>,
    pub added_at: i64,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    #[serde(skip)]
    pub uid: String,
    /// Original neste aparelho (enviado daqui: caminho ou URI). A interface
    /// abre pelo `/local/<id>`, sem rede.
    pub local: Option<String>,
}

pub(crate) const COLS: &str = "id, name, mime, size, thumb IS NOT NULL, duration, width, height, taken_at, tz, favorite, archived, trashed_at, added_at, lat, lon, uid";
/// As mesmas colunas com o apelido `m` (consultas com junções).
pub(crate) const COLS_M: &str = "m.id, m.name, m.mime, m.size, m.thumb IS NOT NULL, m.duration, m.width, m.height, m.taken_at, m.tz, m.favorite, m.archived, m.trashed_at, m.added_at, m.lat, m.lon, m.uid";

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
        })
    }
}

/// Ficha completa (painel de informações).
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
    /// Mídia da capa (escolhida ou a mais recente).
    pub cover: Option<i64>,
    pub created_at: i64,
    pub modified_at: i64,
    /// Período das fotos (segundos), para o subtítulo.
    pub first: Option<i64>,
    pub last: Option<i64>,
}

#[derive(Serialize, Clone, Copy, Default)]
pub struct Usage {
    pub photos: i64,
    pub videos: i64,
    pub bytes: i64,
}

/// Recortes da biblioteca.
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum View {
    /// Linha do tempo: tudo menos arquivo e lixeira.
    Timeline,
    Favorites,
    Videos,
    Archive,
    Trash,
}

// ---- linhas como vão para o canal (FORMAT.md). Tempos em ms. ------------------------

/// Peça como vai no índice: `{"msg", "size", "n"?}` (`n` = nonce, vault cifrado).
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
    /// Pasta de origem no aparelho (ex.: "DCIM/Camera").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    pub added: i64,
    pub mtime: i64,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AlbumRow {
    pub name: String,
    /// Uid da mídia da capa.
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

/// Mídia no feed dos Curtas, com as visualizações (somadas entre aparelhos) e a curtida.
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

/// Uid de `album_item`: determinístico, para dois aparelhos que põem a mesma
/// mídia no mesmo álbum convergirem na mesma linha.
fn item_uid(album: &str, media: &str) -> String {
    format!("{album}:{media}")
}

// ---- banco ---------------------------------------------------------------------------

/// Item mandado para a lixeira do aparelho (vindo da interface).
#[derive(Deserialize, Debug, Clone)]
pub struct DeviceTrashIn {
    pub src: String,
    pub name: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub size: i64,
    /// Captura (ms).
    #[serde(default)]
    pub taken: i64,
    /// Pasta relativa de origem ("DCIM/Camera"), para restaurar no Android < 11.
    #[serde(default)]
    pub folder: String,
    /// Cópia guardada pelo app (Android < 11, sem lixeira do sistema).
    #[serde(default)]
    pub stash: Option<String>,
}

/// Linha da lixeira do aparelho, com a mídia do vault ligada (se houver).
#[derive(Serialize, Debug, Clone)]
pub struct DeviceTrash {
    pub src: String,
    pub media_id: Option<i64>,
    /// A mídia ligada está na lixeira do vault.
    pub media_trashed: bool,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub taken: i64,
    pub folder: String,
    pub stash: Option<String>,
    pub trashed_at: i64,
}

/// Original deste aparelho ligado a uma mídia do vault.
#[derive(Serialize, Debug, Clone)]
pub struct DeviceLink {
    pub src: String,
    pub media_id: i64,
    /// A mídia está na lixeira do vault.
    pub trashed: bool,
    pub size: i64,
    pub name: String,
    pub mime: String,
}

pub struct Db {
    conn: Mutex<Connection>,
    clock: Arc<Clock>,
    /// Acordado a cada mutação local (o laço de sincronização escuta).
    pub changed: Notify,
    /// Sobe quando pessoas chegam de outro aparelho (o índice de rostos relê).
    pub people_rev: std::sync::atomic::AtomicU64,
    /// Miniatura nova ou refeita: acorda a inteligência.
    pub intel_wake: Notify,
}

const SCHEMA_VERSION: i32 = 14;

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
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
         -- Backup: reconhecer o que já está no vault sem ler o arquivo.
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
         -- Backup automático (só deste aparelho; não vai para o canal).
         CREATE TABLE IF NOT EXISTS backup_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
         -- Pastas mostradas na linha do tempo mesmo sem backup (escolha do usuário).
         CREATE TABLE IF NOT EXISTS show_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS backup_seen (src TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL);
         -- Origem local (sem query) → mídia em que virou.
         CREATE TABLE IF NOT EXISTS backup_done (src TEXT PRIMARY KEY, media_uid TEXT NOT NULL);
         -- Lixeira do aparelho (só deste aparelho): o que o app mandou para a
         -- lixeira do sistema (ou guardou, no Android < 11) e como restaurar.
         -- Tirados do vault mas mantidos no aparelho (Excluir do vault): o
         -- backup automático não os reenvia; aparecem como sem backup.
         CREATE TABLE IF NOT EXISTS backup_excluded (src TEXT PRIMARY KEY);
         -- Curtas (sincronizam): curtida por mídia; visualizações por mídia × aparelho.
         CREATE TABLE IF NOT EXISTS likes (uid TEXT PRIMARY KEY, liked INTEGER NOT NULL, hlc TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS views (
             uid TEXT PRIMARY KEY,
             media_uid TEXT NOT NULL,
             n INTEGER NOT NULL,
             at INTEGER NOT NULL,
             hlc TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS views_media ON views(media_uid);
         -- Miniaturas trocadas por outro aparelho (regeradas): o cache em disco
         -- delas está velho (só deste aparelho).
         CREATE TABLE IF NOT EXISTS thumb_changed (uid TEXT PRIMARY KEY);
         -- Inteligência de mídia (ver docs/inteligencia-de-midia.md), só deste
         -- aparelho: o que cada etapa já fez (com qual modelo) e os resultados.
         CREATE TABLE IF NOT EXISTS intel_done (
             media_uid TEXT NOT NULL,
             stage TEXT NOT NULL,
             model TEXT NOT NULL,
             ok INTEGER NOT NULL,
             at INTEGER NOT NULL,
             PRIMARY KEY (media_uid, stage)
         );
         CREATE TABLE IF NOT EXISTS intel_place (media_uid TEXT PRIMARY KEY, city TEXT NOT NULL, state TEXT NOT NULL, country TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS intel_place_city ON intel_place(city);
         CREATE TABLE IF NOT EXISTS intel_hash (media_uid TEXT PRIMARY KEY, phash INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS intel_clip (media_uid TEXT PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
         CREATE TABLE IF NOT EXISTS intel_tag (media_uid TEXT NOT NULL, tag TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (media_uid, tag));
         CREATE TABLE IF NOT EXISTS intel_text (media_uid TEXT PRIMARY KEY, text TEXT NOT NULL);
         CREATE VIRTUAL TABLE IF NOT EXISTS intel_fts USING fts5(media_uid UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');
         -- Rostos: caixa relativa (0–1) na miniatura; pessoa atribuída (auto ou
         -- à mão); `rejected` = pessoa que a pessoa disse que não é.
         CREATE TABLE IF NOT EXISTS intel_face (
             id INTEGER PRIMARY KEY,
             media_uid TEXT NOT NULL,
             x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
             score REAL NOT NULL,
             vec BLOB NOT NULL,
             person_uid TEXT,
             manual INTEGER NOT NULL DEFAULT 0,
             rejected TEXT
         );
         -- Grupos de duplicatas que a pessoa decidiu manter (chave = uids ordenados).
         CREATE TABLE IF NOT EXISTS dup_keep (key TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS person (
             uid TEXT PRIMARY KEY,
             name TEXT NOT NULL DEFAULT '',
             hidden INTEGER NOT NULL DEFAULT 0,
             cover_face INTEGER,
             created_at INTEGER NOT NULL
         );
         -- Pessoas que viajam pelo vault (com nome ou decisão): a linha como foi enviada.
         CREATE TABLE IF NOT EXISTS person_sync (uid TEXT PRIMARY KEY, hlc TEXT NOT NULL, row TEXT NOT NULL);
         -- Rostos decididos (de qualquer aparelho), pela posição na foto.
         CREATE TABLE IF NOT EXISTS person_anchor (
             person_uid TEXT NOT NULL, media_uid TEXT NOT NULL,
             x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, neg INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS person_anchor_media ON person_anchor(media_uid);
         CREATE INDEX IF NOT EXISTS person_anchor_person ON person_anchor(person_uid);
         -- Perguntas da revisão respondidas com “não”.
         -- Pacotes de análise no vault (de qualquer aparelho) e se já foram importados aqui.
         CREATE TABLE IF NOT EXISTS intel_pack (uid TEXT PRIMARY KEY, hlc TEXT NOT NULL, row TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0);
         -- (mídia, etapa, modelo) que já estão em algum pacote: não vão de novo.
         CREATE TABLE IF NOT EXISTS intel_packed (media_uid TEXT NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (media_uid, stage, model));
         CREATE TABLE IF NOT EXISTS review_no (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
         -- Tira de quadros de cada vídeo (entidade `frames`, uid = o da mídia).
         CREATE TABLE IF NOT EXISTS frames (media_uid TEXT PRIMARY KEY, hlc TEXT NOT NULL, row TEXT NOT NULL);
         -- Vetores da busca de cada quadro da tira (o principal fica em intel_clip).
         CREATE TABLE IF NOT EXISTS intel_clip_frame (media_uid TEXT NOT NULL, idx INTEGER NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (media_uid, idx));
         CREATE INDEX IF NOT EXISTS intel_face_media ON intel_face(media_uid);
         CREATE INDEX IF NOT EXISTS intel_face_person ON intel_face(person_uid);
         -- Linhas de entidades que esta versão não conhece (de uma versão mais
         -- nova do app): guardadas como vieram e devolvidas no snapshot, para
         -- uma compactação feita aqui não apagá-las do vault.
         CREATE TABLE IF NOT EXISTS extra_rows (e TEXT NOT NULL, uid TEXT NOT NULL, hlc TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (e, uid));
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
         );
         PRAGMA user_version = {SCHEMA_VERSION};"
    ))?;
    // Rosto achado num quadro da tira (NULL = na miniatura): o recorte e as
    // caixas no visualizador precisam saber de onde veio.
    let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('intel_face') WHERE name = 'frame'", [], |r| r.get(0))?;
    if !has {
        conn.execute_batch("ALTER TABLE intel_face ADD COLUMN frame INTEGER;")?;
    }
    Ok(())
}

fn view_filter(v: View) -> &'static str {
    match v {
        View::Timeline => "trashed_at IS NULL AND archived = 0",
        View::Favorites => "trashed_at IS NULL AND favorite = 1",
        View::Videos => "trashed_at IS NULL AND archived = 0 AND mime LIKE 'video/%'",
        View::Archive => "trashed_at IS NULL AND archived = 1",
        View::Trash => "trashed_at IS NOT NULL",
    }
}

fn pieces_json(pieces: &[Piece]) -> String {
    let list: Vec<RowPiece> = pieces.to_vec();
    serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())
}

/// Mensagens (peças e miniaturas) de mídias condenadas que nenhuma outra usa.
const ORPHANS: &str = "WITH refs(id, msg) AS (
         SELECT m.id, json_extract(p.value, '$.msg') FROM media m, json_each(m.pieces) p
         UNION ALL
         SELECT m.id, json_extract(m.thumb, '$.msg') FROM media m WHERE m.thumb IS NOT NULL
         UNION ALL
         SELECT m.id, json_extract(f.row, '$.piece.msg') FROM media m JOIN frames f ON f.media_uid = m.uid
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
        Ok(Self { conn: Mutex::new(conn), clock, changed: Notify::new(), people_rev: Default::default(), intel_wake: Notify::new() })
    }

    // ---- leitura -----------------------------------------------------------------

    pub(crate) fn query(&self, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Media>> {
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

    /// Origem local de uma mídia (caminho ou URI), se ela foi enviada daqui.
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

    /// Um recorte, do mais recente ao mais antigo (lixeira: pela data de envio à lixeira).
    pub fn list(&self, view: View) -> Result<Vec<Media>> {
        let order = if matches!(view, View::Trash) { "trashed_at DESC" } else { "taken_at DESC, id DESC" };
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

    /// Busca por nome, câmera, pasta de origem e álbum.
    pub fn search(&self, text: &str, limit: i64) -> Result<Vec<Media>> {
        let pattern = format!("%{}%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        self.query(
            &format!(
                "SELECT {COLS} FROM media WHERE trashed_at IS NULL AND (
                     name LIKE ?1 ESCAPE '\\' OR camera LIKE ?1 ESCAPE '\\' OR origin LIKE ?1 ESCAPE '\\'
                     OR uid IN (SELECT i.media_uid FROM album_items i JOIN albums a ON a.uid = i.album_uid WHERE a.name LIKE ?1 ESCAPE '\\')
                 ) ORDER BY taken_at DESC LIMIT ?2"
            ),
            params![pattern, limit],
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

    /// Mídias de um álbum, da mais antiga à mais recente.
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

    /// Mídia do vault com o mesmo nome e tamanho (em qualquer estado, inclusive
    /// na lixeira): o backup a considera já enviada.
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

    // ---- escrita local (linha + op na fila) ------------------------------------------

    fn media_row(tx: &Transaction, id: i64) -> rusqlite::Result<(String, MediaRow)> {
        tx.query_row(
            "SELECT uid, name, mime, size, pieces, sha256, thumb, taken_at, tz, width, height, duration, camera, lat, lon,
                    favorite, archived, trashed_at, origin, added_at, modified_at FROM media WHERE id = ?1",
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

    /// Re-emite a mídia `id` inteira como op (depois de mudar algum campo).
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

    /// Envia ao vault o estado atual destas pessoas (nome, decisões); quem
    /// deixou de existir ou de ter decisão vira tombstone.
    pub fn emit_people(&self, uids: &[String]) -> Result<()> {
        use crate::intel::people;
        self.write(|tx| {
            for uid in uids {
                match people::row_of(tx, uid)? {
                    Some(row) => {
                        let hlc = self.clock.tick();
                        people::save_anchors(tx, uid, &row)?;
                        let json = json!(row);
                        tx.execute("INSERT OR REPLACE INTO person_sync (uid, hlc, row) VALUES (?1, ?2, ?3)", params![uid, hlc, json.to_string()])?;
                        tx.execute("DELETE FROM tombstones WHERE e = ?1 AND uid = ?2", params![PERSON, uid])?;
                        Self::enqueue(tx, &Op { e: PERSON.into(), id: uid.clone(), hlc, row: Some(json), del: false })?;
                    }
                    None => {
                        if tx.execute("DELETE FROM person_sync WHERE uid = ?1", [uid])? > 0 {
                            tx.execute("DELETE FROM person_anchor WHERE person_uid = ?1", [uid])?;
                            self.tombstone(tx, PERSON, uid)?;
                        }
                    }
                }
            }
            Ok(())
        })
    }

    /// Registra um pacote de análise enviado por este aparelho (já "importado"
    /// aqui) e marca o que ele cobre.
    pub fn emit_pack(&self, row: &crate::intel::packs::PackRow, covered: &[(String, String, String)]) -> Result<()> {
        self.write(|tx| {
            let uid = ulid::Ulid::new().to_string();
            let hlc = self.clock.tick();
            let json = json!(row);
            tx.execute("INSERT INTO intel_pack (uid, hlc, row, imported) VALUES (?1, ?2, ?3, 1)", params![uid, hlc, json.to_string()])?;
            crate::intel::packs::mark_packed(tx, covered)?;
            Self::enqueue(tx, &Op { e: PACK.into(), id: uid, hlc, row: Some(json), del: false })
        })
    }

    /// Registra a tira de quadros de um vídeo (gerada aqui). A análise do
    /// vídeo, feita num quadro só, refaz com a tira.
    pub fn emit_frames(&self, media_uid: &str, row: &crate::intel::frames::FramesRow) -> Result<()> {
        self.write(|tx| {
            let hlc = self.clock.tick();
            let json = json!(row);
            tx.execute("INSERT OR REPLACE INTO frames (media_uid, hlc, row) VALUES (?1, ?2, ?3)", params![media_uid, hlc, json.to_string()])?;
            intel_forget(tx, media_uid)?;
            Self::enqueue(tx, &Op { e: FRAMES.into(), id: media_uid.into(), hlc, row: Some(json), del: false })
        })?;
        self.people_rev.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.intel_wake.notify_one();
        Ok(())
    }

    /// A tira de quadros do vídeo, se já existe.
    pub fn frames_of(&self, media_uid: &str) -> Option<crate::intel::frames::FramesRow> {
        let row: String = self.local(|c| c.query_row("SELECT row FROM frames WHERE media_uid = ?1", [media_uid], |r| r.get(0)).optional()).ok().flatten()?;
        serde_json::from_str(&row).ok()
    }

    /// Acesso direto ao banco local (módulo `intel`: tabelas só deste aparelho, sem ops).
    pub(crate) fn local<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T> {
        let mut conn = self.conn.lock().unwrap();
        f(&mut conn).map_err(err)
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

    // ---- Curtas ---------------------------------------------------------------------

    /// Próximas do feed: sorteadas entre as menos vistas (somando os
    /// aparelhos), fora da lixeira e do arquivo, sem as já mostradas (`skip`).
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

    /// Visualizações (todos os aparelhos) e curtida de cada mídia.
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

    /// Histórico de curtidas: da curtida mais recente para a mais antiga.
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

    /// Curtida dos Curtas (não mexe nos favoritos da biblioteca). Sem `sync`
    /// (vault só de leitura), fica só neste aparelho.
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

    /// Mais uma visualização deste aparelho. Devolve o total (todos os aparelhos).
    /// Sem `sync` (vault só de leitura), conta só aqui.
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

    /// Registra uma mídia enviada, com os metadados lidos do arquivo.
    #[allow(clippy::too_many_arguments)]
    pub fn insert(&self, name: &str, mime: &str, size: i64, pieces: &[Piece], sha256: Option<&str>, m: &meta::Meta, origin: Option<&str>) -> Result<Media> {
        let now = now_ms();
        let id = self.write(|tx| {
            tx.execute(
                "INSERT INTO media (uid, name, mime, size, pieces, sha256, taken_at, tz, width, height, duration, camera, lat, lon, origin, added_at, modified_at, hlc)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, '')",
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
                    now
                ],
            )?;
            let id = tx.last_insert_rowid();
            self.emit_media(tx, id)?;
            Ok(id)
        })?;
        self.get(id)?.ok_or_else(|| "inserção perdida".into())
    }

    /// Miniatura (documento no canal) e, se veio, a duração e as dimensões.
    pub fn set_thumb(&self, id: i64, thumb: Piece, duration: Option<f64>) -> Result<()> {
        let json = serde_json::to_string(&thumb).map_err(err)?;
        self.write(|tx| {
            // Miniatura refeita: a análise feita na antiga não vale mais.
            let uid: String = tx.query_row("SELECT uid FROM media WHERE id = ?1", [id], |r| r.get(0))?;
            intel_forget(tx, &uid)?;
            tx.execute("UPDATE media SET thumb = ?2, duration = COALESCE(duration, ?3) WHERE id = ?1", params![id, json, duration])?;
            self.emit_media(tx, id)
        })?;
        // A inteligência já pode analisar esta mídia (e relê os rostos em memória).
        self.people_rev.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.intel_wake.notify_one();
        Ok(())
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

    /// Ajusta a data da captura (fotos sem EXIF, câmera com relógio errado).
    pub fn set_taken(&self, id: i64, taken_ms: i64, tz: Option<i32>) -> Result<()> {
        self.write(|tx| {
            tx.execute("UPDATE media SET taken_at = ?2, tz = ?3 WHERE id = ?1", params![id, taken_ms, tz])?;
            self.emit_media(tx, id)
        })
    }

    /// Apaga de vez. Devolve as mensagens que ficaram sem mídia, para sair do canal.
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
                if tx.execute("DELETE FROM frames WHERE media_uid = ?1", [uid])? > 0 {
                    self.tombstone(tx, FRAMES, uid)?;
                }
            }
            tx.execute("DELETE FROM media WHERE id IN doomed", [])?;
            Ok(orphans)
        })
    }

    pub fn trashed_ids(&self) -> Result<Vec<i64>> {
        Ok(self.list(View::Trash)?.into_iter().map(|m| m.id).collect())
    }

    /// Itens na lixeira além da retenção.
    pub fn expired_ids(&self) -> Result<Vec<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM media WHERE trashed_at IS NOT NULL AND trashed_at < ?1").map_err(err)?;
        let rows = stmt.query_map([now_ms() - TRASH_RETENTION_MS], |r| r.get(0)).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    // ---- álbuns ---------------------------------------------------------------------

    pub fn album_create(&self, name: &str) -> Result<i64> {
        let name = name.trim();
        if name.is_empty() {
            return Err("nome vazio".into());
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
            return Err("nome vazio".into());
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

    /// Apaga o álbum (as mídias ficam na biblioteca).
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

    /// Põe mídias no álbum; devolve quantas entraram (as que já estavam ficam).
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
        .map_err(|e| if e.contains("no rows") { "álbum não encontrado".into() } else { e })
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

// ---- backup automático (estado local do aparelho) -------------------------------------

impl Db {
    /// Pastas observadas: caminhos absolutos (desktop) ou relativos do
    /// MediaStore ("DCIM/Camera", Android).
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

    /// Pastas mostradas na linha do tempo sem backup.
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

    /// Pastas da galeria local: com backup ou só mostradas.
    pub fn gallery_folders(&self) -> Result<Vec<String>> {
        let mut all = self.backup_folders()?;
        for f in self.show_folders()? {
            if !all.contains(&f) {
                all.push(f);
            }
        }
        Ok(all)
    }

    /// Situação de cada origem: 0 = não está no vault, 1 = na fila, 2 = no vault.
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

    /// A origem já passou pelo backup automático deste aparelho.
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

    /// O arquivo local saiu do aparelho (apagado/movido): esquece a origem.
    pub fn backup_forget(&self, srcs: &[String]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        for src in srcs {
            tx.execute("DELETE FROM backup_done WHERE src = ?1", [src_key(src)]).map_err(err)?;
            tx.execute("DELETE FROM backup_seen WHERE src = ?1 OR src = ?2", [src.as_str(), src_key(src)]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    // ---- lixeira do aparelho -------------------------------------------------------------

    /// Registra o que foi para a lixeira do aparelho; devolve as mídias do vault
    /// que têm esses originais (o vault vai para a lixeira junto).
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

    /// Saíram da lixeira do aparelho (restaurados, apagados de vez ou expirados).
    /// `moved`: restaurados com outro endereço (Android < 11) — o vínculo com o
    /// vault passa para o novo.
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

    /// Originais deste aparelho ligados a mídias do vault (lixeira unificada,
    /// "fora de sincronia" e "liberar espaço").
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

    /// Todas as origens locais conhecidas (para validar ações em arquivos).
    pub fn is_local_src(&self, src: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1 FROM backup_done WHERE src = ?1", [src_key(src)], |_| Ok(())).optional().ok().flatten().is_some()
    }

    /// Marca como vistos sem filtrar (backup pedido à mão).
    /// "Excluir do vault" mantendo no aparelho: a mídia ligada a `src` vai
    /// para a lixeira do vault, o vínculo some e o backup automático não reenvia.
    /// Devolve a mídia.
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

    /// Backup pedido à mão: o arquivo volta a poder subir.
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

    /// Dos candidatos (origem, tamanho, data de modificação), os que ainda não
    /// entraram na fila neste aparelho (ou mudaram desde então). Marca os
    /// devolvidos como vistos.
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

// ---- o que as peças comuns (tg-app) enxergam deste índice ---------------------------

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

    /// Pastas não viram nada: o conteúdo vai para o mesmo destino (álbum ou biblioteca).
    fn upload_folder(&self, parent: i64, _name: &str) -> Result<i64> {
        Ok(parent)
    }

    /// `parent` é o álbum de destino (0 = só a biblioteca).
    fn upload_done(&self, done: UploadDone) -> Result<serde_json::Value> {
        let id = match done.existing {
            // Já estava no vault. Enviado à mão: volta da lixeira, se for o
            // caso. Backup automático: fica como está (a lixeira foi escolha).
            // (Filas anteriores à marca `auto`: origem vista pelo backup também conta.)
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
                // Sem data no arquivo (foto que passou pelo Telegram): a de envio a ele.
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

    /// Mídia vinda de outro vault: mesmos metadados (data, câmera, GPS,
    /// favorito…), peças e miniatura do destino. `parent` = álbum (0 = nenhum).
    fn copy_in(&self, parent: i64, row: serde_json::Value, pieces: &[Piece], thumb: Option<Piece>) -> Result<i64> {
        let mut r: MediaRow = serde_json::from_value(row).map_err(err)?;
        r.pieces = pieces.to_vec();
        r.thumb = thumb;
        r.trashed = None;
        let id = self.write(|tx| {
            tx.execute(
                "INSERT INTO media (uid, name, mime, size, pieces, sha256, thumb, taken_at, tz, width, height, duration, camera, lat, lon,
                                    favorite, archived, trashed_at, origin, added_at, modified_at, hlc)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL, ?18, ?19, ?19, '')",
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
                    now_ms()
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

/// URI do MediaStore sem a query (`?requireOriginal=1` muda conforme a permissão).
fn src_key(src: &str) -> &str {
    src.split('?').next().unwrap_or(src)
}

fn is_media(mime: &str) -> bool {
    mime.starts_with("image/") || mime.starts_with("video/")
}

// ---- sincronização ----------------------------------------------------------------------

/// Esquece a análise de uma mídia feita na miniatura (trocada): as etapas
/// que usam a imagem refazem. Rostos voltam a ter nome pelas âncoras.
fn intel_forget(tx: &Transaction, uid: &str) -> rusqlite::Result<()> {
    for sql in [
        "DELETE FROM intel_done WHERE media_uid = ?1 AND stage IN ('hash', 'clip', 'faces', 'ocr')",
        "DELETE FROM intel_hash WHERE media_uid = ?1",
        "DELETE FROM intel_clip WHERE media_uid = ?1",
        "DELETE FROM intel_clip_frame WHERE media_uid = ?1",
        "DELETE FROM intel_tag WHERE media_uid = ?1",
        "DELETE FROM intel_text WHERE media_uid = ?1",
        "DELETE FROM intel_fts WHERE media_uid = ?1",
        "UPDATE person SET cover_face = NULL WHERE cover_face IN (SELECT id FROM intel_face WHERE media_uid = ?1)",
        "DELETE FROM intel_face WHERE media_uid = ?1",
        // O que vier da nova análise vai em outro pacote.
        "DELETE FROM intel_packed WHERE media_uid = ?1",
    ] {
        tx.execute(sql, [uid])?;
    }
    Ok(())
}

/// Hlc atual de uma linha (viva ou tombstone).
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

/// Entidade desconhecida: guarda como veio (last-writer-wins, como as outras).
fn apply_extra(tx: &Transaction, op: &Op) -> rusqlite::Result<bool> {
    let cur: Option<String> = tx
        .query_row(
            "SELECT hlc FROM extra_rows WHERE e = ?1 AND uid = ?2 UNION ALL SELECT hlc FROM tombstones WHERE e = ?1 AND uid = ?2",
            params![op.e, op.id],
            |r| r.get(0),
        )
        .optional()?;
    if cur.as_deref().is_some_and(|h| h >= op.hlc.as_str()) {
        return Ok(false);
    }
    if op.del {
        tx.execute("DELETE FROM extra_rows WHERE e = ?1 AND uid = ?2", params![op.e, op.id])?;
        tx.execute("INSERT OR REPLACE INTO tombstones (e, uid, hlc, at) VALUES (?1, ?2, ?3, ?4)", params![op.e, op.id, op.hlc, now_ms()])?;
    } else if let Some(row) = &op.row {
        tx.execute(
            "INSERT OR REPLACE INTO extra_rows (e, uid, hlc, row) VALUES (?1, ?2, ?3, ?4)",
            params![op.e, op.id, op.hlc, row.to_string()],
        )?;
        tx.execute("DELETE FROM tombstones WHERE e = ?1 AND uid = ?2", params![op.e, op.id])?;
    }
    Ok(false)
}

/// Pessoa (nome e decisões) de outro aparelho.
fn apply_person(tx: &Transaction, op: &Op) -> rusqlite::Result<bool> {
    use crate::intel::people;
    let cur: Option<String> = tx
        .query_row("SELECT hlc FROM person_sync WHERE uid = ?1 UNION ALL SELECT hlc FROM tombstones WHERE e = ?2 AND uid = ?1", params![op.id, PERSON], |r| r.get(0))
        .optional()?;
    if cur.as_deref().is_some_and(|h| h >= op.hlc.as_str()) {
        return Ok(false);
    }
    if op.del {
        people::apply_delete(tx, &op.id)?;
        tx.execute("DELETE FROM person_sync WHERE uid = ?1", [&op.id])?;
        tx.execute("INSERT OR REPLACE INTO tombstones (e, uid, hlc, at) VALUES (?1, ?2, ?3, ?4)", params![PERSON, op.id, op.hlc, now_ms()])?;
        return Ok(true);
    }
    let Some(row) = op.row.clone() else { return Ok(false) };
    let Ok(r) = serde_json::from_value::<people::PersonRow>(row.clone()) else { return Ok(false) };
    people::apply_row(tx, &op.id, &r)?;
    tx.execute("INSERT OR REPLACE INTO person_sync (uid, hlc, row) VALUES (?1, ?2, ?3)", params![op.id, op.hlc, row.to_string()])?;
    tx.execute("DELETE FROM tombstones WHERE e = ?1 AND uid = ?2", params![PERSON, op.id])?;
    Ok(true)
}

/// Pacote de análise de outro aparelho (importado depois, pela inteligência).
fn apply_pack(tx: &Transaction, op: &Op) -> rusqlite::Result<bool> {
    let cur: Option<String> = tx
        .query_row("SELECT hlc FROM intel_pack WHERE uid = ?1 UNION ALL SELECT hlc FROM tombstones WHERE e = ?2 AND uid = ?1", params![op.id, PACK], |r| r.get(0))
        .optional()?;
    if cur.as_deref().is_some_and(|h| h >= op.hlc.as_str()) {
        return Ok(false);
    }
    if op.del {
        tx.execute("DELETE FROM intel_pack WHERE uid = ?1", [&op.id])?;
        tx.execute("INSERT OR REPLACE INTO tombstones (e, uid, hlc, at) VALUES (?1, ?2, ?3, ?4)", params![PACK, op.id, op.hlc, now_ms()])?;
        return Ok(true);
    }
    let Some(row) = &op.row else { return Ok(false) };
    tx.execute(
        "INSERT INTO intel_pack (uid, hlc, row) VALUES (?1, ?2, ?3) ON CONFLICT(uid) DO UPDATE SET hlc = excluded.hlc, row = excluded.row",
        params![op.id, op.hlc, row.to_string()],
    )?;
    Ok(true)
}

/// Tira de quadros de outro aparelho: a análise do vídeo refaz com ela.
fn apply_frames(tx: &Transaction, op: &Op) -> rusqlite::Result<bool> {
    let cur: Option<String> = tx
        .query_row("SELECT hlc FROM frames WHERE media_uid = ?1 UNION ALL SELECT hlc FROM tombstones WHERE e = ?2 AND uid = ?1", params![op.id, FRAMES], |r| r.get(0))
        .optional()?;
    if cur.as_deref().is_some_and(|h| h >= op.hlc.as_str()) {
        return Ok(false);
    }
    if op.del {
        tx.execute("DELETE FROM frames WHERE media_uid = ?1", [&op.id])?;
        tx.execute("INSERT OR REPLACE INTO tombstones (e, uid, hlc, at) VALUES (?1, ?2, ?3, ?4)", params![FRAMES, op.id, op.hlc, now_ms()])?;
        return Ok(true);
    }
    let Some(row) = &op.row else { return Ok(false) };
    tx.execute(
        "INSERT INTO frames (media_uid, hlc, row) VALUES (?1, ?2, ?3) ON CONFLICT(media_uid) DO UPDATE SET hlc = excluded.hlc, row = excluded.row",
        params![op.id, op.hlc, row.to_string()],
    )?;
    tx.execute("DELETE FROM tombstones WHERE e = ?1 AND uid = ?2", params![FRAMES, op.id])?;
    intel_forget(tx, &op.id)?;
    Ok(true)
}

fn apply_one(tx: &Transaction, op: &Op) -> rusqlite::Result<bool> {
    if op.e == FRAMES {
        return apply_frames(tx, op);
    }
    if op.e == PACK {
        return apply_pack(tx, op);
    }
    if op.e == PERSON {
        return apply_person(tx, op);
    }
    if !matches!(op.e.as_str(), MEDIA | ALBUM | ALBUM_ITEM | LIKE | VIEW) {
        return apply_extra(tx, op);
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
            // Miniatura trocada (regerada em outro aparelho): o cache daqui fica velho.
            let old: Option<String> = tx.query_row("SELECT thumb FROM media WHERE uid = ?1", [&op.id], |x| x.get(0)).optional()?.flatten();
            let new = r.thumb.as_ref().map(|t| serde_json::to_string(t).unwrap_or_default());
            if old.is_some() && new.is_some() && old != new {
                tx.execute("INSERT OR IGNORE INTO thumb_changed (uid) VALUES (?1)", [&op.id])?;
                // A análise foi feita na miniatura velha: refaz.
                intel_forget(tx, &op.id)?;
            }
            tx.execute(
                "INSERT INTO media (uid, name, mime, size, pieces, sha256, thumb, taken_at, tz, width, height, duration, camera, lat, lon,
                                    favorite, archived, trashed_at, origin, added_at, modified_at, hlc)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
                 ON CONFLICT(uid) DO UPDATE SET name = excluded.name, mime = excluded.mime, size = excluded.size,
                   pieces = excluded.pieces, sha256 = excluded.sha256, thumb = excluded.thumb, taken_at = excluded.taken_at,
                   tz = excluded.tz, width = excluded.width, height = excluded.height, duration = excluded.duration,
                   camera = excluded.camera, lat = excluded.lat, lon = excluded.lon, favorite = excluded.favorite,
                   archived = excluded.archived, trashed_at = excluded.trashed_at, origin = excluded.origin,
                   added_at = excluded.added_at, modified_at = excluded.modified_at, hlc = excluded.hlc",
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
                    op.hlc
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
        let mut wake = false;
        for op in ops {
            if apply_one(&tx, op).map_err(err)? {
                changed += 1;
                if op.e == PERSON {
                    self.people_rev.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                // Mídia ou miniatura nova de outro aparelho: a inteligência já pode olhar.
                if op.e == MEDIA || op.e == PACK || op.e == FRAMES {
                    wake = true;
                }
                if op.e == FRAMES {
                    self.people_rev.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
        }
        tx.commit().map_err(err)?;
        if wake {
            self.intel_wake.notify_one();
        }
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
        {
            let mut stmt = tx.prepare("SELECT uid, hlc, row FROM intel_pack").map_err(err)?;
            let rows = stmt
                .query_map([], |r| {
                    let row: String = r.get(2)?;
                    Ok(Op { e: PACK.into(), id: r.get(0)?, hlc: r.get(1)?, row: serde_json::from_str(&row).ok(), del: false })
                })
                .map_err(err)?;
            for op in rows {
                out.push(op.map_err(err)?);
            }
        }
        {
            let mut stmt = tx.prepare("SELECT media_uid, hlc, row FROM frames").map_err(err)?;
            let rows = stmt
                .query_map([], |r| {
                    let row: String = r.get(2)?;
                    Ok(Op { e: FRAMES.into(), id: r.get(0)?, hlc: r.get(1)?, row: serde_json::from_str(&row).ok(), del: false })
                })
                .map_err(err)?;
            for op in rows {
                out.push(op.map_err(err)?);
            }
        }
        {
            let mut stmt = tx.prepare("SELECT uid, hlc, row FROM person_sync").map_err(err)?;
            let rows = stmt
                .query_map([], |r| {
                    let row: String = r.get(2)?;
                    Ok(Op { e: PERSON.into(), id: r.get(0)?, hlc: r.get(1)?, row: serde_json::from_str(&row).ok(), del: false })
                })
                .map_err(err)?;
            for op in rows {
                out.push(op.map_err(err)?);
            }
        }
        {
            let mut stmt = tx.prepare("SELECT e, uid, hlc, row FROM extra_rows").map_err(err)?;
            let rows = stmt
                .query_map([], |r| {
                    let row: String = r.get(3)?;
                    Ok(Op { e: r.get(0)?, id: r.get(1)?, hlc: r.get(2)?, row: serde_json::from_str(&row).ok(), del: false })
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

    /// Passa toda a fila de `from` para `to`, como o canal faria.
    fn ship(from: &Db, to: &Db) -> usize {
        let q = from.outbox(10_000).unwrap();
        let ops: Vec<Op> = q.iter().map(|(_, o)| o.clone()).collect();
        from.ack(&q.iter().map(|(s, _)| *s).collect::<Vec<_>>()).unwrap();
        to.apply(&ops).unwrap()
    }

    #[test]
    fn entidade_desconhecida_volta_no_snapshot() {
        let a = db("aaaa");
        let op = Op { e: "futuro".into(), id: "x1".into(), hlc: "1790000000000-0000-zzzz".into(), row: Some(json!({"k": 1})), del: false };
        a.apply(&[op.clone()]).unwrap();
        let out = a.export().unwrap();
        let back = out.iter().find(|o| o.e == "futuro").unwrap();
        assert_eq!((back.id.as_str(), back.row.as_ref().unwrap()["k"].as_i64()), ("x1", Some(1)));
        // Versão mais velha da mesma linha não sobrescreve.
        a.apply(&[Op { hlc: "1780000000000-0000-zzzz".into(), row: Some(json!({"k": 0})), ..op }]).unwrap();
        assert_eq!(a.export().unwrap().iter().find(|o| o.e == "futuro").unwrap().row.as_ref().unwrap()["k"].as_i64(), Some(1));
    }

    #[test]
    fn curtas_sincronizam_sem_perder_visualizacoes() {
        let a = db("aaaa");
        let b = db("bbbb");
        let p = photo(&a, "x.jpg", 1, 1);
        let q = photo(&a, "y.jpg", 2, 2);
        ship(&a, &b);
        let pb = b.id_of_uid(&p.uid).unwrap();
        // Os dois veem ao mesmo tempo: as contagens somam.
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
        // Curtir não é favoritar.
        assert!(!a.get(p.id).unwrap().unwrap().favorite);
        // A menos vista vem primeiro; o snapshot leva tudo.
        assert_eq!(a.shorts_next(&[], 1).unwrap()[0].media.uid, q.uid);
        assert!(a.shorts_next(&[q.id], 1).unwrap()[0].media.uid == p.uid);
        let c = db("cccc");
        c.apply(&a.export().unwrap()).unwrap();
        assert_eq!(get(&c, &p.uid).views, 3);
        // Só leitura: conta e curte aqui, nada vai para a fila do canal.
        ship(&c, &a);
        c.short_view(c.id_of_uid(&q.uid).unwrap(), false).unwrap();
        c.short_like(c.id_of_uid(&q.uid).unwrap(), true, false).unwrap();
        assert!(c.outbox(10).unwrap().is_empty());
        assert_eq!((get(&c, &q.uid).views, get(&c, &q.uid).liked), (1, true));
    }

    #[test]
    fn linha_do_tempo_por_data_de_captura() {
        let a = db("a");
        photo(&a, "velha.jpg", 1_000_000, 1);
        photo(&a, "nova.jpg", 9_000_000, 2);
        let t = a.list(View::Timeline).unwrap();
        assert_eq!(t.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["nova.jpg", "velha.jpg"]);
        assert_eq!(t[0].taken_at, 9_000.0);
        assert_eq!(t[0].width, Some(4000));
    }

    #[test]
    fn favoritos_arquivo_e_lixeira_replicam() {
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
    fn album_converge_entre_aparelhos() {
        let (a, b) = (db("a"), db("b"));
        let p = photo(&a, "p.jpg", 1, 1);
        let q = photo(&a, "q.jpg", 2, 2);
        let album = a.album_create("Viagem").unwrap();
        a.album_add(album, &[p.id]).unwrap();
        ship(&a, &b);
        // Os dois põem a mesma foto e B tira a outra: a linha é a mesma (uid determinístico).
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
    fn purge_tira_do_album_e_libera_mensagens() {
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
        // Snapshot com tombstones vence ops antigas atrasadas.
        let snap = a.export().unwrap();
        let c = db("c");
        c.apply(&snap).unwrap();
        assert!(c.list(View::Timeline).unwrap().is_empty());
        assert_eq!(c.albums().unwrap()[0].name, "X");
    }

    #[test]
    fn ultimo_a_escrever_vence() {
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
        // Linha inteira por LWW: a escrita de B (mais nova) vence nos dois.
        for d in [&a, &b] {
            let m = &d.list(View::Archive).unwrap()[0];
            assert!(m.archived && !m.favorite);
        }
        assert_eq!(b.apply(&from_a).unwrap(), 0);
    }

    #[test]
    fn backup_so_pega_o_que_e_novo_ou_mudou() {
        let a = db("a");
        let c = |s: &str, size, mtime| (s.to_string(), size, mtime);
        assert_eq!(a.backup_take_new(&[c("/f/a.jpg", 10, 1), c("/f/b.jpg", 20, 1)]).unwrap(), vec![0, 1]);
        assert!(a.backup_take_new(&[c("/f/a.jpg", 10, 1)]).unwrap().is_empty());
        // Editado (mudou tamanho/data) entra de novo; o dedup por sha256 decide se sobe.
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
    fn peca_cifrada_replica_com_o_nonce() {
        let (a, b) = (db("a"), db("b"));
        let enc = Piece { msg_id: 9, size: 100, nonce: Some([7; 16]) };
        let m = meta::Meta { taken: Some(1), ..Default::default() };
        let p = a.insert("x.jpg", "image/jpeg", 100, &[enc], None, &m, None).unwrap();
        ship(&a, &b);
        let pb = b.id_of_uid(&a.uid(p.id).unwrap()).unwrap();
        assert_eq!(b.pieces(pb).unwrap(), vec![enc]);
        // E o snapshot (aparelho novo) também leva.
        let c = db("c");
        c.apply(&a.export().unwrap()).unwrap();
        assert_eq!(c.pieces(c.id_of_uid(&a.uid(p.id).unwrap()).unwrap()).unwrap(), vec![enc]);
    }

    #[test]
    fn copia_para_outro_vault_leva_os_metadados() {
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
    fn detalhes_e_busca() {
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
            assert_eq!(a.search(q, 10).unwrap().len(), 1, "{q}");
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
    fn backup_automatico_nao_tira_da_lixeira() {
        let a = db("lix");
        let m = photo(&a, "IMG_1.jpg", 1_000, 1);
        a.set_trashed(&[m.id], true).unwrap();
        a.upload_done(done(m.id, true)).unwrap();
        assert!(a.get(m.id).unwrap().unwrap().trashed_at.is_some(), "backup automático tirou da lixeira");
        assert_eq!(a.backup_status(&["content://media/1".into()]).unwrap(), vec![2]);
        // Fila antiga (sem a marca), mas a origem veio do backup: fica.
        a.backup_mark_seen(&[("content://media/1".into(), 10, 0)]).unwrap();
        a.upload_done(done(m.id, false)).unwrap();
        assert!(a.get(m.id).unwrap().unwrap().trashed_at.is_some());
        // Enviado à mão (origem que o backup nunca viu): volta.
        let mut manual = done(m.id, false);
        manual.src = Some("/home/u/IMG_1.jpg".into());
        a.upload_done(manual).unwrap();
        assert!(a.get(m.id).unwrap().unwrap().trashed_at.is_none());
    }

    #[test]
    fn reconhece_por_nome_e_tamanho_mesmo_na_lixeira() {
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
    fn lixeira_do_aparelho_liga_ao_vault() {
        let a = db("devtrash");
        let m = photo(&a, "IMG_1.jpg", 1_000, 1);
        a.backup_record("content://media/external/images/media/7?requireOriginal=1", m.id).unwrap();
        // Original ligado: aparece nos vínculos.
        let links = a.device_links().unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].media_id, m.id);
        // Para a lixeira do aparelho: devolve a mídia do vault ligada e sai dos vínculos.
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
    fn restaurar_com_endereco_novo_move_o_vinculo() {
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
