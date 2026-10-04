//! Importar fotos e vídeos de um vault do TGDrive. As linhas `node` do outro
//! app (tgdrive/FORMAT.md) são lidas só para leitura; o que for escolhido é
//! encaminhado para o canal aberto e entra na biblioteca com os metadados
//! lidos do começo do arquivo (EXIF / contêiner de vídeo).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tg_app::Foreign;
use tg_core::{Piece, Telegram};

use crate::db::{Db, Result, RowPiece};
use crate::meta;

/// Linha `node` do TGDrive (só o que a importação usa).
#[derive(Deserialize)]
struct NodeRow {
    parent: Option<String>,
    name: String,
    #[serde(default)]
    dir: bool,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    mime: String,
    #[serde(default)]
    pieces: Vec<RowPiece>,
    #[serde(default)]
    mtime: i64,
    trashed: Option<i64>,
    sha256: Option<String>,
    thumb: Option<RowPiece>,
    duration: Option<f64>,
}

/// Item importável, como a interface vê.
#[derive(Serialize)]
pub struct Source {
    pub uid: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    /// Caminho da pasta no TGDrive ("" = raiz).
    pub folder: String,
    pub duration: Option<f64>,
    /// Modificado (s), para ordenar.
    pub mtime: i64,
    /// O conteúdo já está nesta biblioteca (mesmo sha256).
    pub have: bool,
}

#[derive(Serialize, Default)]
pub struct Report {
    pub imported: usize,
    /// Já estavam na biblioteca (só entraram no álbum, se havia um).
    pub skipped: usize,
    pub failed: usize,
}

fn piece(p: RowPiece) -> Piece {
    p
}

async fn nodes(foreign: &Foreign, vault: i64, fresh: bool) -> Result<HashMap<String, NodeRow>> {
    let rows = foreign.rows(vault, fresh).await?;
    Ok(rows
        .iter()
        .filter(|o| o.e == "node")
        .filter_map(|o| Some((o.id.clone(), serde_json::from_value::<NodeRow>(o.row.clone()?).ok()?)))
        .collect())
}

/// Pasta de um nó ("Fotos/2024"); `None` se alguma pasta acima está na lixeira.
fn folder_of<'a>(nodes: &'a HashMap<String, NodeRow>, mut parent: Option<&'a str>) -> Option<String> {
    let mut parts = Vec::new();
    let mut guard = 0;
    while let Some(uid) = parent {
        let n = nodes.get(uid)?;
        if n.trashed.is_some() || guard > 64 {
            return None;
        }
        parts.push(n.name.as_str());
        parent = n.parent.as_deref();
        guard += 1;
    }
    parts.reverse();
    Some(parts.join("/"))
}

fn media_mime(n: &NodeRow) -> Option<String> {
    let mime = if n.mime.starts_with("image/") || n.mime.starts_with("video/") { n.mime.clone() } else { crate::backup::mime_of(&n.name) };
    (mime.starts_with("image/") || mime.starts_with("video/")).then_some(mime)
}

pub async fn browse(foreign: &Foreign, db: &Db, vault: i64, fresh: bool) -> Result<Vec<Source>> {
    let nodes = nodes(foreign, vault, fresh).await?;
    let mut out: Vec<Source> = nodes
        .iter()
        .filter(|(_, n)| !n.dir && n.trashed.is_none() && !n.pieces.is_empty())
        .filter_map(|(uid, n)| {
            let mime = media_mime(n)?;
            let folder = folder_of(&nodes, n.parent.as_deref())?;
            Some(Source {
                uid: uid.clone(),
                name: n.name.clone(),
                mime,
                size: n.size,
                folder,
                duration: n.duration,
                mtime: n.mtime / 1000,
                have: n.sha256.as_deref().is_some_and(|s| db.find_sha256(s).is_some()),
            })
        })
        .collect();
    out.sort_by(|a, b| a.folder.cmp(&b.folder).then(b.mtime.cmp(&a.mtime)));
    Ok(out)
}

pub async fn run(
    foreign: &Foreign,
    tg: &Telegram,
    db: &Db,
    vault: i64,
    uids: &[String],
    album: i64,
    progress: impl Fn(usize, usize),
) -> Result<Report> {
    let nodes = nodes(foreign, vault, false).await?;
    let from = foreign.channel(vault)?;
    let mut report = Report::default();
    let mut ids = Vec::new();
    for (i, uid) in uids.iter().enumerate() {
        progress(i, uids.len());
        let Some(n) = nodes.get(uid) else {
            report.failed += 1;
            continue;
        };
        let Some(mime) = media_mime(n) else { continue };
        if let Some(existing) = n.sha256.as_deref().and_then(|s| db.find_sha256(s)) {
            db.set_trashed(&[existing], false)?;
            ids.push(existing);
            report.skipped += 1;
            continue;
        }
        let pieces: Vec<Piece> = n.pieces.iter().copied().map(piece).collect();
        let (pieces, thumb) = match foreign.forward(&from, &pieces, n.thumb.map(piece)).await {
            Ok(x) => x,
            Err(e) => {
                eprintln!("[tgphotos] importar {}: {e}", n.name);
                report.failed += 1;
                continue;
            }
        };
        // Metadados do começo do arquivo (EXIF fica no início; vídeo "faststart" também).
        let head = tg.read_piece(&pieces[0], 0).await.ok();
        let m = meta::read_bytes(head.as_deref().unwrap_or_default(), &n.name, &mime, Some(n.mtime));
        let folder = folder_of(&nodes, n.parent.as_deref()).unwrap_or_default();
        let origin = if folder.is_empty() { "TGDrive".to_string() } else { format!("TGDrive/{folder}") };
        let media = db.insert(&n.name, &mime, n.size, &pieces, n.sha256.as_deref(), &m, Some(&origin))?;
        if let Some(t) = thumb {
            db.set_thumb(media.id, t, n.duration.or(m.duration))?;
        }
        ids.push(media.id);
        report.imported += 1;
    }
    if album != 0 && !ids.is_empty() {
        db.album_add(album, &ids)?;
    }
    progress(uids.len(), uids.len());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(parent: Option<&str>, name: &str, dir: bool, mime: &str, trashed: bool) -> NodeRow {
        NodeRow {
            parent: parent.map(String::from),
            name: name.into(),
            dir,
            size: 1,
            mime: mime.into(),
            pieces: vec![RowPiece::new(1, 1)],
            mtime: 0,
            trashed: trashed.then_some(1),
            sha256: None,
            thumb: None,
            duration: None,
        }
    }

    #[test]
    fn caminho_da_pasta_e_lixeira_acima() {
        let mut n = HashMap::new();
        n.insert("a".to_string(), node(None, "Fotos", true, "", false));
        n.insert("b".to_string(), node(Some("a"), "2024", true, "", false));
        n.insert("c".to_string(), node(None, "Velho", true, "", true));
        assert_eq!(folder_of(&n, Some("b")).as_deref(), Some("Fotos/2024"));
        assert_eq!(folder_of(&n, None).as_deref(), Some(""));
        assert_eq!(folder_of(&n, Some("c")), None);
        // Pasta que não existe mais (apagada de vez): fica de fora.
        assert_eq!(folder_of(&n, Some("zz")), None);
    }

    #[test]
    fn so_fotos_e_videos() {
        assert_eq!(media_mime(&node(None, "a.jpg", false, "image/jpeg", false)).as_deref(), Some("image/jpeg"));
        // Tipo genérico no TGDrive, mas a extensão diz que é foto.
        assert_eq!(media_mime(&node(None, "IMG_1.HEIC", false, "application/octet-stream", false)).as_deref(), Some("image/heic"));
        assert_eq!(media_mime(&node(None, "nota.pdf", false, "application/pdf", false)), None);
    }
}
