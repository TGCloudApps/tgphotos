//! Arquivos locais para o visualizador, com Range (vídeo posiciona):
//!
//! - `/device?uri=…`: mídia do aparelho fora do vault (o WebView não abre
//!   `content://`).
//! - `/local/<id>`: mídia do vault cujo original está neste aparelho (foi
//!   enviada daqui). Abre sem rede e mais rápido; se o arquivo sumiu, cai no
//!   `/f/<id>` (Telegram).
//!
//! Só com o token desta sessão: sem ele, outro app do aparelho poderia ler a
//! galeria pela permissão do TGPhotos.

use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, OnceLock};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use tauri::AppHandle;
use tg_app::Vaults;

use crate::db::Db;

/// Os vaults só existem depois do `Core::start` (que recebe este roteador).
pub type VaultsCell = Arc<OnceLock<Arc<Vaults<Db>>>>;
/// A inteligência de mídia (criada depois do servidor; recortes de rosto).
pub type IntelCell = Arc<OnceLock<Arc<crate::intel::Intel>>>;

/// Maior pedaço por resposta (o player pede o resto em seguida).
const MAX_CHUNK: u64 = 4 << 20;

#[derive(Clone)]
struct Ctx {
    handle: AppHandle,
    token: String,
    vaults: VaultsCell,
    intel: IntelCell,
    thumbs: std::path::PathBuf,
}

#[derive(Deserialize)]
struct Token {
    t: String,
}

#[derive(Deserialize)]
struct Params {
    uri: String,
    t: String,
    #[serde(default)]
    mime: String,
    /// Tamanho pelo MediaStore (alguns provedores não informam).
    #[serde(default)]
    size: u64,
}

pub fn token() -> String {
    ulid::Ulid::new().to_string()
}

pub fn router(handle: AppHandle, token: String, vaults: VaultsCell, intel: IntelCell, thumbs: std::path::PathBuf) -> Router {
    Router::new()
        .route("/device", get(device))
        .route("/local/:id", get(local))
        .route("/localthumb", get(thumb_get).post(thumb_put))
        .route("/docs/list", get(docs_list))
        .route("/face/:id", get(face))
        .with_state(Ctx { handle, token, vaults, intel, thumbs })
}

// ---- miniaturas locais (desktop): geradas pela interface, guardadas em disco ----

#[derive(Deserialize)]
struct ThumbQ {
    t: String,
    src: String,
}

fn thumb_path(dir: &std::path::Path, src: &str) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(src.as_bytes());
    dir.join(format!("{}.jpg", h.iter().take(16).map(|b| format!("{b:02x}")).collect::<String>()))
}

async fn thumb_get(State(ctx): State<Ctx>, Query(q): Query<ThumbQ>) -> Response {
    if q.t != ctx.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    match tokio::fs::read(thumb_path(&ctx.thumbs, &q.src)).await {
        Ok(b) => ([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "max-age=86400")], b).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn thumb_put(State(ctx): State<Ctx>, Query(q): Query<ThumbQ>, body: axum::body::Bytes) -> Response {
    if q.t != ctx.token || body.is_empty() || body.len() > 1 << 20 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let _ = tokio::fs::create_dir_all(&ctx.thumbs).await;
    match tokio::fs::write(thumb_path(&ctx.thumbs, &q.src), &body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// "bytes=a-b" → (a, b inclusivo).
fn range(headers: &HeaderMap, len: u64) -> Option<(u64, u64)> {
    let v = headers.get(header::RANGE)?.to_str().ok()?.strip_prefix("bytes=")?;
    let (a, b) = v.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (a, "") => (a.parse().ok()?, len - 1),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && end < len).then_some((start, end))
}

async fn device(State(ctx): State<Ctx>, Query(p): Query<Params>, headers: HeaderMap) -> Response {
    if p.t != ctx.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Galeria do aparelho (Android) ou arquivo de pasta de backup (desktop).
    let allowed = p.uri.starts_with("content://media/")
        || ctx.vaults.get().and_then(|v| v.db().ok()).is_some_and(|db| crate::backup::in_backup_folder(&db, &p.uri));
    if !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    serve(ctx.handle, p.uri, p.mime, p.size, headers).await.unwrap_or_else(|e| (StatusCode::NOT_FOUND, e).into_response())
}

async fn local(State(ctx): State<Ctx>, Path(id): Path<i64>, Query(q): Query<Token>, headers: HeaderMap) -> Response {
    if q.t != ctx.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let vault = Redirect::temporary(&format!("/f/{id}")).into_response();
    let Some(db) = ctx.vaults.get().and_then(|v| v.db().ok()) else { return vault };
    let (Some(src), Ok(Some(m))) = (db.local_src(id), db.get(id)) else { return vault };
    match serve(ctx.handle, src, m.mime, m.size as u64, headers).await {
        Ok(r) => r,
        // Apagado do aparelho (ou permissão revogada): o vault tem o original.
        Err(_) => vault,
    }
}

async fn serve(handle: AppHandle, src: String, mime: String, size: u64, headers: HeaderMap) -> Result<Response, String> {
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, u64, (u64, u64)), String> {
        let mut f = tg_app::transfers::open_local(&handle, &src)?;
        let len = f.metadata().map(|m| m.len()).ok().filter(|l| *l > 0).unwrap_or(size);
        if len == 0 {
            return Err("arquivo vazio".into());
        }
        let r = range(&headers, len);
        // Com Range (vídeo): pedaços de até 4 MiB. Sem Range (imagem): inteiro.
        let (start, end) = r.map(|(a, b)| (a, b.min(a + MAX_CHUNK - 1))).unwrap_or((0, len - 1));
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; (end - start + 1) as usize];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        Ok((buf, len, (start, end)))
    })
    .await
    .map_err(|e| e.to_string())??;
    let (buf, len, (start, end)) = res;
    let mime = if mime.is_empty() { "application/octet-stream".to_string() } else { mime };
    let whole = start == 0 && end + 1 == len;
    let status = if whole { StatusCode::OK } else { StatusCode::PARTIAL_CONTENT };
    let mut resp = (status, buf).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, mime.parse().unwrap_or(header::HeaderValue::from_static("application/octet-stream")));
    h.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("bytes"));
    h.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    if !whole {
        if let Ok(v) = format!("bytes {start}-{end}/{len}").parse() {
            h.insert(header::CONTENT_RANGE, v);
        }
    }
    Ok(resp)
}

// ---- documentos (Android: o vault como origem no seletor de arquivos) ------------------

#[derive(Deserialize)]
struct DocsQ {
    t: String,
    /// "root", "photos", "m:AAAA-MM", "albums", "a:<id>", "fav".
    dir: String,
}

/// Item como o provedor de documentos do Android lista (pasta ou arquivo `f:<id>`).
#[derive(serde::Serialize)]
struct Doc {
    id: String,
    name: String,
    mime: String,
    size: i64,
    /// ms
    modified: i64,
    thumb: bool,
}

const DIR: &str = "vnd.android.document/directory";

fn dir(id: impl Into<String>, name: impl Into<String>, modified: i64) -> Doc {
    Doc { id: id.into(), name: name.into(), mime: DIR.into(), size: 0, modified, thumb: false }
}

fn file(m: &crate::db::Media) -> Doc {
    Doc { id: format!("f:{}", m.id), name: m.name.clone(), mime: m.mime.clone(), size: m.size, modified: (m.taken_at * 1000.0) as i64, thumb: m.thumb }
}

/// Mês da captura ("2024-05"), no fuso deste aparelho.
fn month(m: &crate::db::Media) -> String {
    use chrono::{Local, TimeZone};
    Local.timestamp_millis_opt((m.taken_at * 1000.0) as i64).single().map(|d| d.format("%Y-%m").to_string()).unwrap_or_else(|| "sem-data".into())
}

/// Lista uma pasta do vault aberto: Fotos (por mês), Álbuns, Favoritos.
async fn docs_list(State(ctx): State<Ctx>, Query(q): Query<DocsQ>) -> Response {
    if q.t != ctx.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(db) = ctx.vaults.get().and_then(|v| v.db().ok()) else { return (StatusCode::SERVICE_UNAVAILABLE, "nenhum vault aberto").into_response() };
    let out = tauri::async_runtime::spawn_blocking(move || -> crate::db::Result<Vec<Doc>> {
        use crate::db::View;
        Ok(match q.dir.as_str() {
            "root" => vec![dir("photos", "Fotos", 0), dir("albums", "Álbuns", 0), dir("fav", "Favoritos", 0)],
            "photos" => {
                let mut months: Vec<(String, i64)> = Vec::new();
                for m in db.list(View::Timeline)? {
                    let k = month(&m);
                    if months.last().map(|x| &x.0) != Some(&k) {
                        months.push((k, (m.taken_at * 1000.0) as i64));
                    }
                }
                months.into_iter().map(|(k, t)| dir(format!("m:{k}"), k, t)).collect()
            }
            "fav" => db.list(View::Favorites)?.iter().map(file).collect(),
            "albums" => db.albums()?.into_iter().map(|a| dir(format!("a:{}", a.id), a.name, a.modified_at)).collect(),
            d if d.starts_with("m:") => db.list(View::Timeline)?.iter().filter(|m| month(m) == d[2..]).map(file).collect(),
            d if d.starts_with("a:") => db.album_media(d[2..].parse().unwrap_or(0))?.iter().map(file).collect(),
            _ => Vec::new(),
        })
    })
    .await;
    match out {
        Ok(Ok(list)) => axum::Json(list).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Recorte do rosto (avatar de pessoa), `/face/<id>?t=`.
///
/// O id do rosto só vale dentro de um vault (e volta a ser usado depois de
/// "Apagar e refazer"): o cache é validado pela identidade do rosto (ETag),
/// nunca reaproveitado só pela URL.
async fn face(State(ctx): State<Ctx>, axum::extract::Path(id): axum::extract::Path<i64>, Query(q): Query<Token>, headers: axum::http::HeaderMap) -> Response {
    use axum::http::header;
    if q.t != ctx.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(intel) = ctx.intel.get() else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    let Ok(tag) = intel.face_key(id) else { return StatusCode::NOT_FOUND.into_response() };
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(tag.as_str()) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, tag), (header::CACHE_CONTROL, "no-cache".to_string())]).into_response();
    }
    match intel.face_crop(id).await {
        Ok(jpeg) => ([(header::CONTENT_TYPE, "image/jpeg".to_string()), (header::CACHE_CONTROL, "no-cache".to_string()), (header::ETAG, tag)], jpeg).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, e).into_response(),
    }
}
