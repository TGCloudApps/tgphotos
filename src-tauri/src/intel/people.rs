//! Pessoas: agrupamento incremental dos rostos (como o Immich, derivado do
//! DBSCAN) e o que a pessoa decide (nome, mesclar, ocultar, "não é ela").
//!
//! Rosto novo entra numa pessoa se rostos parecidos (semelhança ≥ `SAME`) já
//! são dela; sem pessoa por perto, uma pessoa nova nasce só quando há pelo
//! menos `MIN_FACES` rostos parecidos soltos. O que a pessoa decidiu à mão
//! nunca é desfeito pelo automático.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::clip::{dot, from_blob};

/// Semelhança mínima (1 − distância máxima de 0,5 do Immich).
pub const SAME: f32 = 0.5;
pub const MIN_FACES: usize = 3;

/// Um rosto no índice em memória.
pub struct FaceRef {
    pub id: i64,
    pub person: Option<String>,
    pub rejected: Option<String>,
    pub vec: Vec<f32>,
}

pub fn load_all(c: &Connection) -> rusqlite::Result<Vec<FaceRef>> {
    let mut st = c.prepare("SELECT id, person_uid, rejected, vec FROM intel_face")?;
    let rows = st.query_map([], |r| Ok(FaceRef { id: r.get(0)?, person: r.get(1)?, rejected: r.get(2)?, vec: from_blob(&r.get::<_, Vec<u8>>(3)?) }))?;
    rows.collect()
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default()
}

/// Decide a pessoa de um rosto recém-detectado (e talvez de vizinhos soltos).
/// Atualiza o banco e o índice em memória.
pub fn assign(c: &Connection, index: &mut Vec<FaceRef>, new_id: i64, vec: Vec<f32>) -> rusqlite::Result<()> {
    let near: Vec<(usize, f32)> = index.iter().enumerate().filter(|(_, f)| f.id != new_id).map(|(i, f)| (i, dot(&vec, &f.vec))).filter(|(_, s)| *s >= SAME).collect();
    // Pessoa mais votada entre os vizinhos (desempate: o mais parecido).
    let mut votes: HashMap<&str, (usize, f32)> = HashMap::new();
    for (i, s) in &near {
        if let Some(p) = index[*i].person.as_deref() {
            let e = votes.entry(p).or_insert((0, 0.0));
            e.0 += 1;
            e.1 = e.1.max(*s);
        }
    }
    let best = votes.into_iter().max_by(|a, b| a.1 .0.cmp(&b.1 .0).then(a.1 .1.total_cmp(&b.1 .1))).map(|(p, _)| p.to_string());
    let person = match best {
        Some(p) => Some(p),
        None if near.len() + 1 >= MIN_FACES => {
            // Pessoa nova (sem nome) com este rosto e os vizinhos soltos.
            let uid = ulid::Ulid::new().to_string();
            c.execute("INSERT INTO person (uid, created_at) VALUES (?1, ?2)", params![uid, now()])?;
            for (i, _) in &near {
                let f = &mut index[*i];
                if f.person.is_none() && f.rejected.as_deref() != Some(uid.as_str()) {
                    c.execute("UPDATE intel_face SET person_uid = ?2 WHERE id = ?1 AND person_uid IS NULL", params![f.id, uid])?;
                    f.person = Some(uid.clone());
                }
            }
            Some(uid)
        }
        None => None,
    };
    if let Some(p) = &person {
        c.execute("UPDATE intel_face SET person_uid = ?2 WHERE id = ?1", params![new_id, p])?;
    }
    index.push(FaceRef { id: new_id, person, rejected: None, vec });
    Ok(())
}

/// Pessoa na lista (com nome primeiro, por número de fotos).
#[derive(Serialize, Clone, Debug)]
pub struct Person {
    pub uid: String,
    pub name: String,
    pub hidden: bool,
    /// Rosto da capa (para `/face/<id>`).
    pub cover: Option<i64>,
    /// Fotos em que aparece.
    pub count: i64,
}

pub fn list(c: &Connection) -> rusqlite::Result<Vec<Person>> {
    let mut st = c.prepare(
        "SELECT p.uid, p.name, p.hidden,
            COALESCE(p.cover_face, (SELECT f.id FROM intel_face f WHERE f.person_uid = p.uid ORDER BY f.score * f.w DESC LIMIT 1)),
            (SELECT COUNT(DISTINCT f.media_uid) FROM intel_face f JOIN media m ON m.uid = f.media_uid WHERE f.person_uid = p.uid AND m.trashed_at IS NULL) AS n
         FROM person p WHERE n > 0
         ORDER BY p.name = '', n DESC",
    )?;
    let rows = st.query_map([], |r| Ok(Person { uid: r.get(0)?, name: r.get(1)?, hidden: r.get(2)?, cover: r.get(3)?, count: r.get(4)? }))?;
    rows.collect()
}

pub fn rename(c: &Connection, uid: &str, name: &str) -> rusqlite::Result<()> {
    c.execute("UPDATE person SET name = ?2 WHERE uid = ?1", params![uid, name.trim()])?;
    Ok(())
}

pub fn hide(c: &Connection, uid: &str, on: bool) -> rusqlite::Result<()> {
    c.execute("UPDATE person SET hidden = ?2 WHERE uid = ?1", params![uid, on])?;
    Ok(())
}

pub fn set_cover(c: &Connection, uid: &str, face: i64) -> rusqlite::Result<()> {
    c.execute("UPDATE person SET cover_face = ?2 WHERE uid = ?1", params![uid, face])?;
    Ok(())
}

/// Junta `from` em `into` (os rostos passam; as outras pessoas somem). O nome
/// fica o de `into`; sem nome, herda o primeiro nome de `from`.
pub fn merge(c: &mut Connection, into: &str, from: &[String]) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    for f in from.iter().filter(|f| f.as_str() != into) {
        tx.execute("UPDATE intel_face SET person_uid = ?1 WHERE person_uid = ?2", params![into, f])?;
        let name: Option<String> = tx.query_row("SELECT name FROM person WHERE uid = ?1", [f], |r| r.get(0)).optional()?;
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            tx.execute("UPDATE person SET name = ?2 WHERE uid = ?1 AND name = ''", params![into, n])?;
        }
        tx.execute("DELETE FROM person WHERE uid = ?1", [f])?;
    }
    tx.commit()
}

/// "Não é esta pessoa": solta o rosto e lembra (o automático não volta a pôr).
pub fn reject(c: &Connection, face: i64) -> rusqlite::Result<()> {
    c.execute("UPDATE intel_face SET rejected = person_uid, person_uid = NULL, manual = 1 WHERE id = ?1", [face])?;
    Ok(())
}

/// Atribuir à mão (`person` vazio + `name` = pessoa nova com esse nome).
pub fn put(c: &Connection, face: i64, person: Option<&str>, name: Option<&str>) -> rusqlite::Result<String> {
    let uid = match person {
        Some(p) => p.to_string(),
        None => {
            let uid = ulid::Ulid::new().to_string();
            c.execute("INSERT INTO person (uid, name, created_at) VALUES (?1, ?2, ?3)", params![uid, name.unwrap_or("").trim(), now()])?;
            uid
        }
    };
    c.execute("UPDATE intel_face SET person_uid = ?2, manual = 1, rejected = NULL WHERE id = ?1", params![face, uid])?;
    Ok(uid)
}

/// Rosto de uma foto (para a sobreposição no visualizador).
#[derive(Serialize, Clone, Debug)]
pub struct MediaFace {
    pub id: i64,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub person: Option<String>,
    pub name: Option<String>,
}

/// Rostos de uma pessoa (aba "Rostos": tirar os errados, escolher a capa).
pub fn faces_of(c: &Connection, uid: &str) -> rusqlite::Result<Vec<i64>> {
    let mut st = c.prepare(
        "SELECT f.id FROM intel_face f JOIN media m ON m.uid = f.media_uid
         WHERE f.person_uid = ?1 AND m.trashed_at IS NULL ORDER BY f.manual, f.score * f.w DESC LIMIT 2000",
    )?;
    let rows = st.query_map([uid], |r| r.get(0))?;
    rows.collect()
}

pub fn of_media(c: &Connection, media_uid: &str) -> rusqlite::Result<Vec<MediaFace>> {
    let mut st = c.prepare(
        "SELECT f.id, f.x, f.y, f.w, f.h, f.person_uid, p.name FROM intel_face f LEFT JOIN person p ON p.uid = f.person_uid
         WHERE f.media_uid = ?1 ORDER BY f.x",
    )?;
    let rows = st.query_map([media_uid], |r| Ok(MediaFace { id: r.get(0)?, x: r.get(1)?, y: r.get(2)?, w: r.get(3)?, h: r.get(4)?, person: r.get(5)?, name: r.get(6)? }))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(seed: f32) -> Vec<f32> {
        // Vetores unitários: mesmo "seed" = mesma pessoa (com ruído pequeno).
        let mut x: Vec<f32> = (0..8).map(|i| ((i as f32 + seed) * 1.7).sin()).collect();
        let n = x.iter().map(|a| a * a).sum::<f32>().sqrt();
        x.iter_mut().for_each(|a| *a /= n);
        x
    }

    #[test]
    fn nasce_com_tres_e_junta_o_quarto() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE intel_face (id INTEGER PRIMARY KEY, media_uid TEXT, x REAL, y REAL, w REAL, h REAL, score REAL, vec BLOB, person_uid TEXT, manual INTEGER DEFAULT 0, rejected TEXT);
             CREATE TABLE person (uid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, cover_face INTEGER, created_at INTEGER NOT NULL);",
        )
        .unwrap();
        let mut idx = Vec::new();
        let add = |c: &Connection, idx: &mut Vec<FaceRef>, id: i64, vec: Vec<f32>| {
            c.execute("INSERT INTO intel_face (id, media_uid, x, y, w, h, score, vec) VALUES (?1, 'm', 0, 0, 0, 0, 1, x'')", [id]).unwrap();
            assign(c, idx, id, vec).unwrap();
        };
        add(&c, &mut idx, 1, v(0.0));
        add(&c, &mut idx, 2, v(0.01));
        assert!(idx.iter().all(|f| f.person.is_none()), "dois rostos ainda não fazem uma pessoa");
        add(&c, &mut idx, 3, v(0.02));
        let p = idx[2].person.clone().unwrap();
        assert!(idx.iter().all(|f| f.person.as_deref() == Some(p.as_str())));
        add(&c, &mut idx, 4, v(0.015));
        assert_eq!(idx[3].person.as_deref(), Some(p.as_str()));
        add(&c, &mut idx, 5, v(3.0));
        assert!(idx[4].person.is_none(), "outra pessoa não entra");
    }
}
