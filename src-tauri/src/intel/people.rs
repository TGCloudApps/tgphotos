//! Pessoas: agrupamento incremental dos rostos (como o Immich, derivado do
//! DBSCAN) e o que a pessoa decide (nome, mesclar, ocultar, "não é ela").
//!
//! Rosto novo entra numa pessoa se rostos parecidos (semelhança ≥ `SAME`) já
//! são dela; sem pessoa por perto, uma pessoa nova nasce só quando há pelo
//! menos `MIN_FACES` rostos parecidos soltos. O que a pessoa decidiu à mão
//! nunca é desfeito pelo automático.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

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

/// Segunda passada sobre os rostos soltos (o `assign` decide cada rosto uma
/// vez só, na chegada, e a ordem deixa sobras):
/// 1. rosto solto parecido (≥ `SAME`) com rostos de uma pessoa entra nela;
/// 2. cadeias de rostos soltos parecidos (vizinho de vizinho) com pelo menos
///    `MIN_FACES` rostos viram uma pessoa nova.
///
/// Só mexe em rostos soltos; o que já tem pessoa (e o que foi decidido à mão)
/// fica. Devolve quantos rostos ganharam pessoa.
pub fn recluster(c: &mut Connection) -> rusqlite::Result<usize> {
    let index = load_all(c)?;
    // Os mais novos primeiro, com teto (o custo é soltos × todos).
    let loose: Vec<usize> = index.iter().enumerate().filter(|(_, f)| f.person.is_none()).map(|(i, _)| i).rev().take(4000).collect();
    if loose.is_empty() {
        return Ok(0);
    }
    let tx = c.transaction()?;
    let mut changed = 0;
    let mut still = Vec::new();
    // 1. Junta à pessoa mais votada entre os vizinhos com pessoa.
    for &i in &loose {
        let f = &index[i];
        let mut votes: HashMap<&str, (usize, f32)> = HashMap::new();
        for g in &index {
            let Some(p) = g.person.as_deref() else { continue };
            if f.rejected.as_deref() == Some(p) {
                continue;
            }
            let s = dot(&f.vec, &g.vec);
            if s >= SAME {
                let e = votes.entry(p).or_insert((0, 0.0));
                e.0 += 1;
                e.1 = e.1.max(s);
            }
        }
        match votes.into_iter().max_by(|a, b| a.1 .0.cmp(&b.1 .0).then(a.1 .1.total_cmp(&b.1 .1))) {
            Some((p, _)) => {
                tx.execute("UPDATE intel_face SET person_uid = ?2 WHERE id = ?1 AND person_uid IS NULL", params![f.id, p])?;
                changed += 1;
            }
            None => still.push(i),
        }
    }
    // 2. Componentes ligados entre os que sobraram (união e busca).
    let mut parent: Vec<usize> = (0..still.len()).collect();
    fn find(p: &mut [usize], mut x: usize) -> usize {
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    for a in 0..still.len() {
        for b in a + 1..still.len() {
            if dot(&index[still[a]].vec, &index[still[b]].vec) >= SAME {
                let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                if ra != rb {
                    parent[ra] = rb;
                }
            }
        }
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for a in 0..still.len() {
        let root = find(&mut parent, a);
        groups.entry(root).or_default().push(still[a]);
    }
    for members in groups.values().filter(|m| m.len() >= MIN_FACES) {
        let uid = ulid::Ulid::new().to_string();
        tx.execute("INSERT INTO person (uid, created_at) VALUES (?1, ?2)", params![uid, now()])?;
        for &i in members {
            tx.execute("UPDATE intel_face SET person_uid = ?2 WHERE id = ?1 AND person_uid IS NULL", params![index[i].id, uid])?;
            changed += 1;
        }
    }
    tx.commit()?;
    Ok(changed)
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
    merge_in(&tx, into, from)?;
    tx.commit()
}

fn merge_in(tx: &Connection, into: &str, from: &[String]) -> rusqlite::Result<()> {
    for f in from.iter().filter(|f| f.as_str() != into) {
        tx.execute("UPDATE intel_face SET person_uid = ?1 WHERE person_uid = ?2", params![into, f])?;
        let name: Option<String> = tx.query_row("SELECT name FROM person WHERE uid = ?1", [f], |r| r.get(0)).optional()?;
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            tx.execute("UPDATE person SET name = ?2 WHERE uid = ?1 AND name = ''", params![into, n])?;
        }
        tx.execute("DELETE FROM person WHERE uid = ?1", [f])?;
    }
    Ok(())
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

// ---- sincronização (entidade `person` no vault) -------------------------------------------
//
// Cada aparelho analisa as próprias fotos, então os agrupamentos automáticos
// têm uids diferentes. O que viaja é a decisão da pessoa: o nome, ocultar, a
// capa, e "âncoras" — a caixa de alguns rostos dela (e dos que "não são ela")
// em fotos do vault. Quem recebe acha o rosto na mesma foto pela posição e
// junta o agrupamento local a essa pessoa. Nenhum vetor de rosto sai do aparelho.
// Pessoas sem nome e sem decisão não viajam.

pub const ENTITY: &str = "person";

/// Rosto de uma foto, pela posição (a detecção é a mesma em todo aparelho).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Anchor {
    pub m: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PersonRow {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub cover: Option<Anchor>,
    /// Rostos que são dela (os marcados à mão primeiro).
    #[serde(default)]
    pub faces: Vec<Anchor>,
    /// Rostos que a pessoa disse que não são ela.
    #[serde(default)]
    pub not: Vec<Anchor>,
    #[serde(default)]
    pub ctime: i64,
}

/// Rostos que servem de âncora (no máximo).
const ANCHORS: usize = 24;

fn r3(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}

fn anchors(c: &Connection, sql: &str, uid: &str) -> rusqlite::Result<Vec<Anchor>> {
    let mut st = c.prepare(sql)?;
    let rows = st.query_map([uid], |r| Ok(Anchor { m: r.get(0)?, x: r3(r.get(1)?), y: r3(r.get(2)?), w: r3(r.get(3)?), h: r3(r.get(4)?) }))?;
    rows.collect()
}

/// O que viaja desta pessoa; `None` = nada a sincronizar (sem nome nem decisão, ou não existe).
pub fn row_of(c: &Connection, uid: &str) -> rusqlite::Result<Option<PersonRow>> {
    let Some((name, hidden, cover, ctime)): Option<(String, bool, Option<i64>, i64)> =
        c.query_row("SELECT name, hidden, cover_face, created_at FROM person WHERE uid = ?1", [uid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional()?
    else {
        return Ok(None);
    };
    let manual: bool = c.query_row("SELECT EXISTS (SELECT 1 FROM intel_face WHERE (person_uid = ?1 OR rejected = ?1) AND manual = 1)", [uid], |r| r.get(0))?;
    if name.is_empty() && !hidden && !manual {
        return Ok(None);
    }
    let faces = anchors(
        c,
        &format!("SELECT media_uid, x, y, w, h FROM intel_face WHERE person_uid = ?1 ORDER BY manual DESC, score * w DESC LIMIT {ANCHORS}"),
        uid,
    )?;
    let not = anchors(c, "SELECT media_uid, x, y, w, h FROM intel_face WHERE rejected = ?1 LIMIT 200", uid)?;
    let cover = match cover {
        Some(id) => c
            .query_row("SELECT media_uid, x, y, w, h FROM intel_face WHERE id = ?1", [id], |r| Ok(Anchor { m: r.get(0)?, x: r3(r.get(1)?), y: r3(r.get(2)?), w: r3(r.get(3)?), h: r3(r.get(4)?) }))
            .optional()?,
        None => None,
    };
    Ok(Some(PersonRow { name, hidden, cover, faces, not, ctime }))
}

/// Guarda as âncoras (também para rostos que este aparelho ainda não analisou).
pub fn save_anchors(c: &Connection, uid: &str, row: &PersonRow) -> rusqlite::Result<()> {
    c.execute("DELETE FROM person_anchor WHERE person_uid = ?1", [uid])?;
    for (a, neg) in row.faces.iter().map(|a| (a, false)).chain(row.not.iter().map(|a| (a, true))) {
        c.execute(
            "INSERT INTO person_anchor (person_uid, media_uid, x, y, w, h, neg) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![uid, a.m, a.x, a.y, a.w, a.h, neg],
        )?;
    }
    Ok(())
}

/// Centro a no máximo isso (relativo à foto) = o mesmo rosto.
const NEAR: f32 = 0.03;

fn same_box(a: (f32, f32, f32, f32), b: (f32, f32, f32, f32)) -> Option<f32> {
    let d = ((a.0 + a.2 / 2.0) - (b.0 + b.2 / 2.0)).hypot((a.1 + a.3 / 2.0) - (b.1 + b.3 / 2.0));
    (d < NEAR).then_some(d)
}

/// Rosto local que corresponde à âncora.
fn find_face(c: &Connection, a: &Anchor) -> rusqlite::Result<Option<i64>> {
    let mut st = c.prepare("SELECT id, x, y, w, h FROM intel_face WHERE media_uid = ?1")?;
    let rows = st.query_map([&a.m], |r| Ok((r.get::<_, i64>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))))?;
    let mut best: Option<(i64, f32)> = None;
    for row in rows {
        let (id, b) = row?;
        if let Some(d) = same_box((a.x, a.y, a.w, a.h), b) {
            if best.is_none_or(|(_, bd)| d < bd) {
                best = Some((id, d));
            }
        }
    }
    Ok(best.map(|(id, _)| id))
}

/// Aplica o que veio de outro aparelho.
pub fn apply_row(c: &Connection, uid: &str, row: &PersonRow) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO person (uid, name, hidden, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(uid) DO UPDATE SET name = excluded.name, hidden = excluded.hidden",
        params![uid, row.name.trim(), row.hidden, row.ctime],
    )?;
    save_anchors(c, uid, row)?;
    let mut st = c.prepare("SELECT media_uid, x, y, w, h, neg FROM person_anchor WHERE person_uid = ?1")?;
    let list: Vec<(Anchor, bool)> = st
        .query_map([uid], |r| Ok((Anchor { m: r.get(0)?, x: r.get(1)?, y: r.get(2)?, w: r.get(3)?, h: r.get(4)? }, r.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (a, neg) in list {
        let Some(face) = find_face(c, &a)? else { continue };
        if neg {
            c.execute("UPDATE intel_face SET rejected = ?2, person_uid = CASE WHEN person_uid = ?2 THEN NULL ELSE person_uid END, manual = 1 WHERE id = ?1", params![face, uid])?;
            continue;
        }
        // O agrupamento local desse rosto, se é automático e sem nome, vira esta pessoa.
        let other: Option<(String, String)> = c
            .query_row("SELECT p.uid, p.name FROM intel_face f JOIN person p ON p.uid = f.person_uid WHERE f.id = ?1", [face], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((o, name)) = other {
            if o != uid && name.is_empty() {
                merge_in(c, uid, &[o])?;
            }
        }
        c.execute("UPDATE intel_face SET person_uid = ?2, manual = 1, rejected = NULL WHERE id = ?1", params![face, uid])?;
    }
    let cover = match &row.cover {
        Some(a) => find_face(c, a)?,
        None => None,
    };
    c.execute("UPDATE person SET cover_face = ?2 WHERE uid = ?1", params![uid, cover])?;
    Ok(())
}

/// Pessoa apagada em outro aparelho (mesclada): os rostos dela ficam soltos.
pub fn apply_delete(c: &Connection, uid: &str) -> rusqlite::Result<()> {
    c.execute("UPDATE intel_face SET person_uid = NULL WHERE person_uid = ?1", [uid])?;
    c.execute("DELETE FROM person WHERE uid = ?1", [uid])?;
    c.execute("DELETE FROM person_anchor WHERE person_uid = ?1", [uid])?;
    Ok(())
}

/// Rosto recém-detectado que outro aparelho já decidiu: (pessoa, "não é ela").
pub fn anchored(c: &Connection, media: &str, b: (f32, f32, f32, f32)) -> rusqlite::Result<Option<(String, bool)>> {
    let mut st = c.prepare("SELECT person_uid, x, y, w, h, neg FROM person_anchor WHERE media_uid = ?1")?;
    let rows = st.query_map([media], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?), r.get::<_, bool>(5)?)))?;
    for row in rows {
        let (p, a, neg) = row?;
        if same_box(a, b).is_some() && c.query_row("SELECT EXISTS (SELECT 1 FROM person WHERE uid = ?1)", [&p], |r| r.get::<_, bool>(0))? {
            return Ok(Some((p, neg)));
        }
    }
    Ok(None)
}

// ---- revisão ("É a Gabi?", "São a mesma pessoa?") --------------------------------------------

/// Faixa de dúvida: parecido, mas abaixo do que o automático aceita sozinho.
const MAYBE: f32 = 0.38;
/// Duas pessoas com rostos tão parecidos assim talvez sejam uma só.
const SAME_PERSON: f32 = 0.45;

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Review {
    /// Rosto solto que parece ser de uma pessoa com nome.
    Face { face: i64, media: i64, person: String, name: String, cover: Option<i64>, score: f32 },
    /// Dois rostos soltos que parecem a mesma pessoa (ainda sem grupo).
    Loose { a: i64, b: i64, score: f32 },
    /// Duas pessoas que talvez sejam a mesma.
    Pair { a: String, b: String, a_name: String, b_name: String, a_cover: Option<i64>, b_cover: Option<i64>, score: f32 },
}

/// Perguntas para a pessoa, das mais prováveis para as menos (no máximo `limit`).
pub fn review(c: &Connection, limit: usize) -> rusqlite::Result<Vec<Review>> {
    let index = load_all(c)?;
    let people = list(c)?;
    let visible: HashMap<&str, &Person> = people.iter().filter(|p| !p.hidden).map(|p| (p.uid.as_str(), p)).collect();
    // Amostra de rostos de cada pessoa (os primeiros bastam para comparar).
    let mut sample: HashMap<&str, Vec<&FaceRef>> = HashMap::new();
    for f in &index {
        if let Some(p) = f.person.as_deref().filter(|p| visible.contains_key(p)) {
            let v = sample.entry(p).or_default();
            if v.len() < 30 {
                v.push(f);
            }
        }
    }
    let best = |vec: &[f32], of: &[&FaceRef]| of.iter().map(|g| dot(vec, &g.vec)).fold(f32::MIN, f32::max);
    let mut out = Vec::new();

    // Rostos soltos perto de alguém com nome.
    let media_of: HashMap<i64, (String, i64)> = {
        let mut st = c.prepare("SELECT f.id, f.media_uid, m.id FROM intel_face f JOIN media m ON m.uid = f.media_uid WHERE f.person_uid IS NULL AND m.trashed_at IS NULL")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let skipped: std::collections::HashSet<(i64, String)> = {
        let mut st = c.prepare("SELECT a, b FROM review_no")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?.parse().unwrap_or(-1), r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for f in index.iter().filter(|f| f.person.is_none() && media_of.contains_key(&f.id)).rev().take(3000) {
        let mut top: Option<(&str, f32)> = None;
        for (p, faces) in &sample {
            if f.rejected.as_deref() == Some(*p) || skipped.contains(&(f.id, p.to_string())) {
                continue;
            }
            let s = best(&f.vec, faces);
            if s >= MAYBE && top.is_none_or(|(_, t)| s > t) {
                top = Some((p, s));
            }
        }
        if let Some((p, s)) = top {
            let person = visible[p];
            out.push(Review::Face { face: f.id, media: media_of[&f.id].1, person: p.to_string(), name: person.name.clone(), cover: person.cover, score: s });
        }
    }

    // Rostos soltos sem ninguém parecido o bastante: pares entre eles (o
    // automático só cria pessoa com 3 rostos).
    let asked: std::collections::HashSet<i64> = out.iter().filter_map(|r| if let Review::Face { face, .. } = r { Some(*face) } else { None }).collect();
    let rest: Vec<&FaceRef> = index.iter().filter(|f| f.person.is_none() && media_of.contains_key(&f.id) && !asked.contains(&f.id)).rev().take(1500).collect();
    let mut paired = std::collections::HashSet::new();
    for (i, f) in rest.iter().enumerate() {
        if paired.contains(&f.id) {
            continue;
        }
        let best_pair = rest[i + 1..]
            .iter()
            .filter(|g| !paired.contains(&g.id))
            .map(|g| (g, dot(&f.vec, &g.vec)))
            .filter(|(g, s)| *s >= MAYBE + 0.04 && !skipped.contains(&(-1, pair_key(&format!("f{}", f.id), &format!("f{}", g.id)))))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((g, s)) = best_pair {
            paired.insert(f.id);
            paired.insert(g.id);
            out.push(Review::Loose { a: f.id, b: g.id, score: s });
        }
    }

    // Pares de pessoas parecidas.
    let keys: Vec<&str> = sample.keys().copied().collect();
    for (i, a) in keys.iter().enumerate() {
        for b in &keys[i + 1..] {
            let (pa, pb) = (visible[a], visible[b]);
            let (x, y) = if a < b { (*a, *b) } else { (*b, *a) };
            if skipped.contains(&(-1, format!("{x}|{y}"))) {
                continue;
            }
            let s = sample[a].iter().map(|f| best(&f.vec, &sample[b])).fold(f32::MIN, f32::max);
            if s >= SAME_PERSON {
                out.push(Review::Pair { a: a.to_string(), b: b.to_string(), a_name: pa.name.clone(), b_name: pb.name.clone(), a_cover: pa.cover, b_cover: pb.cover, score: s });
            }
        }
    }
    let score = |r: &Review| match r {
        Review::Face { score, .. } | Review::Pair { score, .. } | Review::Loose { score, .. } => *score,
    };
    out.sort_by(|a, b| score(b).total_cmp(&score(a)));
    out.truncate(limit);
    Ok(out)
}

fn pair_key(a: &str, b: &str) -> String {
    if a < b {
        format!("{a}|{b}")
    } else {
        format!("{b}|{a}")
    }
}

/// "Não" numa pergunta: não pergunta de novo.
pub fn review_no(c: &Connection, face: Option<i64>, a: &str, b: &str) -> rusqlite::Result<()> {
    let (x, y) = match face {
        Some(f) => (f.to_string(), a.to_string()),
        None => ("-1".to_string(), pair_key(a, b)),
    };
    c.execute("INSERT OR IGNORE INTO review_no (a, b) VALUES (?1, ?2)", params![x, y])?;
    Ok(())
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

    fn schema() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE intel_face (id INTEGER PRIMARY KEY, media_uid TEXT, x REAL, y REAL, w REAL, h REAL, score REAL, vec BLOB, person_uid TEXT, manual INTEGER DEFAULT 0, rejected TEXT);
             CREATE TABLE person (uid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, cover_face INTEGER, created_at INTEGER NOT NULL);
             CREATE TABLE person_anchor (person_uid TEXT, media_uid TEXT, x REAL, y REAL, w REAL, h REAL, neg INTEGER);",
        )
        .unwrap();
        c
    }

    #[test]
    fn nome_viaja_por_ancoras() {
        // Dois aparelhos: o mesmo rosto nas mesmas fotos, agrupado com uids diferentes.
        let (a, b) = (schema(), schema());
        for (c, p, dx) in [(&a, "PA", 0.0), (&b, "PB", 0.004)] {
            c.execute("INSERT INTO person (uid, created_at) VALUES (?1, 0)", [p]).unwrap();
            for m in ["m1", "m2", "m3"] {
                c.execute("INSERT INTO intel_face (media_uid, x, y, w, h, score, vec, person_uid) VALUES (?1, ?2, 0.2, 0.1, 0.1, 0.9, x'', ?3)", params![m, 0.3 + dx, p]).unwrap();
            }
            // Outro rosto na m1, longe: não é tocado.
            c.execute("INSERT INTO intel_face (media_uid, x, y, w, h, score, vec) VALUES ('m1', 0.8, 0.8, 0.1, 0.1, 0.9, x'')", []).unwrap();
        }
        assert!(row_of(&a, "PA").unwrap().is_none(), "sem nome nem decisão não viaja");
        rename(&a, "PA", "Gabi").unwrap();
        let row = row_of(&a, "PA").unwrap().unwrap();
        apply_row(&b, "PA", &row).unwrap();
        let n: i64 = b.query_row("SELECT COUNT(*) FROM intel_face WHERE person_uid = 'PA'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
        assert!(b.query_row("SELECT 1 FROM person WHERE uid = 'PB'", [], |_| Ok(())).optional().unwrap().is_none(), "o agrupamento local virou a Gabi");
        let name: String = b.query_row("SELECT name FROM person WHERE uid = 'PA'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Gabi");
        // Rosto ainda não analisado em B: a âncora decide quando ele chegar.
        assert_eq!(anchored(&b, "m2", (0.301, 0.2, 0.1, 0.1)).unwrap(), Some(("PA".into(), false)));
        assert_eq!(anchored(&b, "m2", (0.6, 0.6, 0.1, 0.1)).unwrap(), None);
    }

    #[test]
    fn reagrupa_soltos() {
        let mut c = schema();
        c.execute("INSERT INTO person (uid, created_at) VALUES ('P', 0)", []).unwrap();
        let put = |c: &Connection, id: i64, v: Vec<f32>, p: Option<&str>| {
            c.execute("INSERT INTO intel_face (id, media_uid, x, y, w, h, score, vec, person_uid) VALUES (?1, 'm', 0, 0, 0.1, 0.1, 1, ?2, ?3)", params![id, super::super::clip::to_blob(&v), p]).unwrap();
        };
        // Pessoa P e um rosto solto parecido com ela (ficou solto pela ordem).
        put(&c, 1, v(0.0), Some("P"));
        put(&c, 2, v(0.01), None);
        // Três soltos de outra pessoa: nasce uma pessoa nova.
        put(&c, 3, v(3.0), None);
        put(&c, 4, v(3.01), None);
        put(&c, 5, v(3.02), None);
        // Um par só: continua solto (vira pergunta na revisão).
        put(&c, 6, v(6.0), None);
        put(&c, 7, v(6.01), None);
        assert_eq!(recluster(&mut c).unwrap(), 4);
        let of = |id: i64| c.query_row("SELECT person_uid FROM intel_face WHERE id = ?1", [id], |r| r.get::<_, Option<String>>(0)).unwrap();
        assert_eq!(of(2).as_deref(), Some("P"));
        assert!(of(3).is_some() && of(3) == of(4) && of(4) == of(5) && of(3).as_deref() != Some("P"));
        assert!(of(6).is_none() && of(7).is_none());
    }
}
