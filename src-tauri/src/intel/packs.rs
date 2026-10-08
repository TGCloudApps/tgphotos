//! Pacotes de análise (docs/inteligencia-de-midia.md §9.2): o que um aparelho
//! já analisou vai ao vault num arquivo compactado (cifrado no vault cifrado),
//! e os outros aparelhos importam em vez de refazer. Uma entidade
//! `intel_pack` no índice aponta para cada arquivo.
//!
//! Vão os resultados que dependem da imagem (hash, vetor da busca, texto lido,
//! rostos). Lugares não: saem da localização, rápido e sem rede.

use std::collections::BTreeMap;
use std::io::{Read, Write};

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tg_core::Piece;

pub const ENTITY: &str = "intel_pack";
/// Mídias por pacote (no máximo).
pub const MAX_ITEMS: usize = 2000;

/// Linha da entidade: onde está o arquivo e com quais modelos foi feito.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PackRow {
    pub piece: Piece,
    /// Mídias no pacote.
    pub n: i64,
    /// Etapa → modelo (ex.: "clip" → "busca-siglip2-b32-256@1").
    pub models: BTreeMap<String, String>,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct Entry {
    m: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hash: Option<i64>,
    /// Vetor f16 (como no banco), em base64.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    clip: Option<String>,
    /// Vetores de cada quadro da tira (vídeos).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    clipf: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    /// `Some(vazio)` = analisada, sem rostos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    faces: Option<Vec<FaceEntry>>,
}

#[derive(Serialize, Deserialize)]
struct FaceEntry {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    s: f32,
    v: String,
    /// Quadro da tira (vídeos).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    f: Option<i64>,
}

#[derive(Serialize, Deserialize)]
struct Body {
    models: BTreeMap<String, String>,
    items: Vec<Entry>,
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Etapas que viajam (as que usam a imagem).
pub const STAGES: [&str; 4] = ["hash", "clip", "ocr", "faces"];

/// Mídias já analisadas que ainda não estão em nenhum pacote (por etapa e modelo).
pub fn pending(c: &Connection, faces: bool) -> rusqlite::Result<i64> {
    c.query_row(
        "SELECT COUNT(DISTINCT d.media_uid) FROM intel_done d JOIN media m ON m.uid = d.media_uid
         WHERE d.ok = 1 AND d.stage IN ('hash', 'clip', 'ocr', 'faces') AND (?1 OR d.stage <> 'faces')
           AND NOT EXISTS (SELECT 1 FROM intel_packed p WHERE p.media_uid = d.media_uid AND p.stage = d.stage AND p.model = d.model)",
        [faces],
        |r| r.get(0),
    )
}

/// Monta um pacote com o que falta (até `MAX_ITEMS` mídias). `None` = nada a enviar.
/// Devolve o arquivo compactado, os modelos e as (mídia, etapa, modelo) cobertas.
pub fn build(c: &Connection, faces: bool) -> rusqlite::Result<Option<(Vec<u8>, BTreeMap<String, String>, Vec<(String, String, String)>, i64)>> {
    let mut st = c.prepare(
        "SELECT d.media_uid, d.stage, d.model FROM intel_done d JOIN media m ON m.uid = d.media_uid
         WHERE d.ok = 1 AND d.stage IN ('hash', 'clip', 'ocr', 'faces') AND (?1 OR d.stage <> 'faces')
           AND NOT EXISTS (SELECT 1 FROM intel_packed p WHERE p.media_uid = d.media_uid AND p.stage = d.stage AND p.model = d.model)
         ORDER BY d.media_uid",
    )?;
    let rows: Vec<(String, String, String)> = st.query_map([faces], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    if rows.is_empty() {
        return Ok(None);
    }
    // Um modelo por etapa no pacote: o mais frequente (o atual).
    let mut freq: BTreeMap<(String, String), usize> = BTreeMap::new();
    for (_, s, m) in &rows {
        *freq.entry((s.clone(), m.clone())).or_default() += 1;
    }
    let mut models: BTreeMap<String, String> = BTreeMap::new();
    for ((s, m), n) in &freq {
        let best = freq.iter().filter(|((s2, _), _)| s2 == s).map(|(_, n2)| *n2).max().unwrap_or(0);
        if *n == best {
            models.entry(s.clone()).or_insert_with(|| m.clone());
        }
    }
    let mut items: BTreeMap<String, Entry> = BTreeMap::new();
    let mut covered = Vec::new();
    for (uid, stage, model) in rows {
        if models.get(&stage) != Some(&model) {
            continue;
        }
        if !items.contains_key(&uid) && items.len() >= MAX_ITEMS {
            continue;
        }
        let e = items.entry(uid.clone()).or_insert_with(|| Entry { m: uid.clone(), ..Default::default() });
        match stage.as_str() {
            "hash" => e.hash = c.query_row("SELECT phash FROM intel_hash WHERE media_uid = ?1", [&uid], |r| r.get(0)).optional()?,
            "clip" => {
                e.clip = c.query_row("SELECT vec FROM intel_clip WHERE media_uid = ?1", [&uid], |r| r.get::<_, Vec<u8>>(0)).optional()?.map(|v| B64.encode(v));
                let mut fs = c.prepare_cached("SELECT vec FROM intel_clip_frame WHERE media_uid = ?1 ORDER BY idx")?;
                let list: Vec<String> = fs.query_map([&uid], |r| Ok(B64.encode(r.get::<_, Vec<u8>>(0)?)))?.collect::<rusqlite::Result<_>>()?;
                e.clipf = (!list.is_empty()).then_some(list);
            }
            "ocr" => e.text = Some(c.query_row("SELECT text FROM intel_text WHERE media_uid = ?1", [&uid], |r| r.get(0)).optional()?.unwrap_or_default()),
            _ => {
                let mut fs = c.prepare_cached("SELECT x, y, w, h, score, vec, frame FROM intel_face WHERE media_uid = ?1")?;
                let list = fs
                    .query_map([&uid], |r| Ok(FaceEntry { x: r.get(0)?, y: r.get(1)?, w: r.get(2)?, h: r.get(3)?, s: r.get(4)?, v: B64.encode(r.get::<_, Vec<u8>>(5)?), f: r.get(6)? }))?
                    .collect::<rusqlite::Result<_>>()?;
                e.faces = Some(list);
            }
        }
        covered.push((uid, stage, model));
    }
    let n = items.len() as i64;
    let body = Body { models: models.clone(), items: items.into_values().collect() };
    let json = serde_json::to_vec(&body).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&json).and_then(|_| Ok(())).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let bytes = gz.finish().map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    Ok(Some((bytes, models, covered, n)))
}

/// Marca como já enviadas (ou recebidas): não entram em outro pacote.
pub fn mark_packed(c: &Connection, covered: &[(String, String, String)]) -> rusqlite::Result<()> {
    let mut st = c.prepare_cached("INSERT OR IGNORE INTO intel_packed (media_uid, stage, model) VALUES (?1, ?2, ?3)")?;
    for (m, s, model) in covered {
        st.execute(params![m, s, model])?;
    }
    Ok(())
}

/// Importa um pacote baixado. Só preenche o que este aparelho ainda não
/// analisou (qualquer modelo). Devolve (mídias, rostos novos com id).
pub fn import(c: &mut Connection, bytes: &[u8]) -> Result<(usize, Vec<(i64, String, (f32, f32, f32, f32), Vec<f32>)>), String> {
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(bytes).read_to_end(&mut json).map_err(|e| e.to_string())?;
    let body: Body = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut n = 0;
    let mut new_faces = Vec::new();
    {
        let exists = |uid: &str| tx.query_row("SELECT 1 FROM media WHERE uid = ?1", [uid], |_| Ok(())).optional().map(|o| o.is_some());
        let done = |uid: &str, stage: &str| tx.query_row("SELECT 1 FROM intel_done WHERE media_uid = ?1 AND stage = ?2", params![uid, stage], |_| Ok(())).optional().map(|o| o.is_some());
        for e in &body.items {
            if !exists(&e.m).map_err(|e| e.to_string())? {
                continue;
            }
            let mut any = false;
            for stage in STAGES {
                let Some(model) = body.models.get(stage) else { continue };
                let has = match stage {
                    "hash" => e.hash.is_some(),
                    "clip" => e.clip.is_some(),
                    "ocr" => e.text.is_some(),
                    _ => e.faces.is_some(),
                };
                if !has || done(&e.m, stage).map_err(|e| e.to_string())? {
                    continue;
                }
                let r: rusqlite::Result<()> = (|| {
                    match stage {
                        "hash" => {
                            tx.execute("INSERT OR REPLACE INTO intel_hash (media_uid, phash) VALUES (?1, ?2)", params![e.m, e.hash])?;
                        }
                        "clip" => {
                            let v = B64.decode(e.clip.as_deref().unwrap_or_default()).unwrap_or_default();
                            tx.execute("INSERT OR REPLACE INTO intel_clip (media_uid, model, vec) VALUES (?1, ?2, ?3)", params![e.m, model, v])?;
                            tx.execute("DELETE FROM intel_clip_frame WHERE media_uid = ?1", [&e.m])?;
                            for (i, f) in e.clipf.iter().flatten().enumerate() {
                                let v = B64.decode(f).unwrap_or_default();
                                tx.execute("INSERT INTO intel_clip_frame (media_uid, idx, vec) VALUES (?1, ?2, ?3)", params![e.m, i as i64, v])?;
                            }
                        }
                        "ocr" => {
                            let t = e.text.as_deref().unwrap_or_default();
                            tx.execute("DELETE FROM intel_fts WHERE media_uid = ?1", [&e.m])?;
                            if !t.trim().is_empty() {
                                tx.execute("INSERT OR REPLACE INTO intel_text (media_uid, text) VALUES (?1, ?2)", params![e.m, t])?;
                                tx.execute("INSERT INTO intel_fts (media_uid, text) VALUES (?1, ?2)", params![e.m, t])?;
                            }
                        }
                        _ => {
                            for f in e.faces.as_deref().unwrap_or_default() {
                                let v = B64.decode(&f.v).unwrap_or_default();
                                tx.execute(
                                    "INSERT INTO intel_face (media_uid, x, y, w, h, score, vec, frame) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                                    params![e.m, f.x, f.y, f.w, f.h, f.s, v, f.f],
                                )?;
                                new_faces.push((tx.last_insert_rowid(), e.m.clone(), (f.x, f.y, f.w, f.h), super::clip::from_blob(&v)));
                            }
                        }
                    }
                    tx.execute(
                        "INSERT OR REPLACE INTO intel_done (media_uid, stage, model, ok, at) VALUES (?1, ?2, ?3, 1, ?4)",
                        params![e.m, stage, model, now],
                    )?;
                    tx.execute("INSERT OR IGNORE INTO intel_packed (media_uid, stage, model) VALUES (?1, ?2, ?3)", params![e.m, stage, model])?;
                    Ok(())
                })();
                r.map_err(|e| e.to_string())?;
                any = true;
            }
            if any {
                n += 1;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok((n, new_faces))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE media (uid TEXT PRIMARY KEY);
             CREATE TABLE intel_done (media_uid TEXT, stage TEXT, model TEXT, ok INTEGER, at INTEGER, PRIMARY KEY (media_uid, stage));
             CREATE TABLE intel_hash (media_uid TEXT PRIMARY KEY, phash INTEGER);
             CREATE TABLE intel_clip (media_uid TEXT PRIMARY KEY, model TEXT, vec BLOB);
             CREATE TABLE intel_clip_frame (media_uid TEXT, idx INTEGER, vec BLOB, PRIMARY KEY (media_uid, idx));
             CREATE TABLE intel_text (media_uid TEXT PRIMARY KEY, text TEXT);
             CREATE VIRTUAL TABLE intel_fts USING fts5(media_uid UNINDEXED, text);
             CREATE TABLE intel_face (id INTEGER PRIMARY KEY, media_uid TEXT, x REAL, y REAL, w REAL, h REAL, score REAL, vec BLOB, person_uid TEXT, manual INTEGER DEFAULT 0, rejected TEXT, frame INTEGER);
             CREATE TABLE intel_packed (media_uid TEXT, stage TEXT, model TEXT, PRIMARY KEY (media_uid, stage, model));
             INSERT INTO media VALUES ('a'), ('b');",
        )
        .unwrap();
        c
    }

    #[test]
    fn pacote_vai_e_volta() {
        let pc = schema();
        pc.execute_batch(
            "INSERT INTO intel_done VALUES ('a', 'clip', 'busca@1', 1, 0), ('a', 'faces', 'rostos@1', 1, 0), ('b', 'faces', 'rostos@1', 1, 0), ('b', 'ocr', 'texto@1', 1, 0);
             INSERT INTO intel_clip VALUES ('a', 'busca@1', x'0102');
             INSERT INTO intel_face (media_uid, x, y, w, h, score, vec) VALUES ('a', 0.1, 0.2, 0.1, 0.1, 0.9, x'003c');
             INSERT INTO intel_text VALUES ('b', 'PADARIA');",
        )
        .unwrap();
        assert_eq!(pending(&pc, true).unwrap(), 2);
        assert_eq!(pending(&pc, false).unwrap(), 2, "sem rostos: a (busca) e b (texto)");
        let (bytes, models, covered, n) = build(&pc, true).unwrap().unwrap();
        assert_eq!((n, covered.len(), models.len()), (2, 4, 3));
        mark_packed(&pc, &covered).unwrap();
        assert_eq!(pending(&pc, true).unwrap(), 0);

        // Celular: já analisou a busca de 'a' sozinho; o resto vem do pacote.
        let mut phone = schema();
        phone.execute_batch("INSERT INTO intel_done VALUES ('a', 'clip', 'busca@1', 1, 0); INSERT INTO intel_clip VALUES ('a', 'busca@1', x'0909');").unwrap();
        let (n, faces) = import(&mut phone, &bytes).unwrap();
        assert_eq!((n, faces.len()), (2, 1));
        let v: Vec<u8> = phone.query_row("SELECT vec FROM intel_clip WHERE media_uid = 'a'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, vec![9, 9], "o que já foi feito aqui fica");
        let done: i64 = phone.query_row("SELECT COUNT(*) FROM intel_done", [], |r| r.get(0)).unwrap();
        assert_eq!(done, 4);
        let hits: i64 = phone.query_row("SELECT COUNT(*) FROM intel_fts WHERE intel_fts MATCH 'padaria'", [], |r| r.get(0)).unwrap();
        assert_eq!(hits, 1);
        assert_eq!(pending(&phone, true).unwrap(), 1, "só a busca de 'a', feita no celular");
    }
}
