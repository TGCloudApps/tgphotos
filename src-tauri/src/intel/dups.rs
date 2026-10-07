//! Duplicatas em três níveis (docs/inteligencia-de-midia.md §7): idênticas
//! (SHA-256), quase idênticas (dHash, a mesma foto recomprimida) e parecidas
//! (vetor da busca, dentro de 10 minutos: rajada da mesma cena). Cada grupo
//! sugere a melhor; "manter todas" fica lembrado.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

use super::clip::{dot, from_blob};
use super::hash::distance;

const HASH_MAX: u32 = 6;
const BURST_MS: i64 = 10 * 60 * 1000;
const BURST_SIM: f32 = 0.97;

#[derive(Serialize, Clone, Debug)]
pub struct Group {
    /// Uids ordenados (para lembrar a decisão).
    pub key: String,
    /// exact | similar | burst
    pub kind: &'static str,
    pub ids: Vec<i64>,
    /// A sugerida para ficar.
    pub best: i64,
}

struct Row {
    id: i64,
    uid: String,
    sha: Option<String>,
    taken: i64,
    pixels: i64,
    fav: bool,
    albums: i64,
    added: i64,
}

/// União-busca simples.
fn find(p: &mut [usize], mut i: usize) -> usize {
    while p[i] != i {
        p[i] = p[p[i]];
        i = p[i];
    }
    i
}

pub fn groups(c: &Connection) -> rusqlite::Result<Vec<Group>> {
    let mut st = c.prepare(
        "SELECT m.id, m.uid, m.sha256, m.taken_at, COALESCE(m.width * m.height, 0), m.favorite,
            (SELECT COUNT(*) FROM album_items i WHERE i.media_uid = m.uid), m.added_at
         FROM media m WHERE m.trashed_at IS NULL ORDER BY m.taken_at",
    )?;
    let rows: Vec<Row> = st
        .query_map([], |r| Ok(Row { id: r.get(0)?, uid: r.get(1)?, sha: r.get(2)?, taken: r.get(3)?, pixels: r.get(4)?, fav: r.get(5)?, albums: r.get(6)?, added: r.get(7)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let at: HashMap<&str, usize> = rows.iter().enumerate().map(|(i, r)| (r.uid.as_str(), i)).collect();
    let mut parent: Vec<usize> = (0..rows.len()).collect();
    let mut kind: Vec<&'static str> = vec!["burst"; rows.len()];
    let join = |p: &mut Vec<usize>, a: usize, b: usize| {
        let (ra, rb) = (find(p, a), find(p, b));
        if ra != rb {
            p[rb] = ra;
        }
    };

    // 1. Idênticas.
    let mut by_sha: HashMap<&str, usize> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        if let Some(s) = r.sha.as_deref() {
            match by_sha.get(s) {
                Some(&j) => {
                    join(&mut parent, j, i);
                    kind[i] = "exact";
                    kind[j] = "exact";
                }
                None => {
                    by_sha.insert(s, i);
                }
            }
        }
    }
    // 2. Quase idênticas (dHash).
    let mut hashes: Vec<(usize, u64)> = Vec::new();
    {
        let mut st = c.prepare("SELECT media_uid, phash FROM intel_hash")?;
        for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (uid, h) = r?;
            if let Some(&i) = at.get(uid.as_str()) {
                hashes.push((i, h as u64));
            }
        }
    }
    for a in 0..hashes.len() {
        for b in a + 1..hashes.len() {
            if distance(hashes[a].1, hashes[b].1) <= HASH_MAX {
                let (i, j) = (hashes[a].0, hashes[b].0);
                join(&mut parent, i, j);
                for k in [i, j] {
                    if kind[k] != "exact" {
                        kind[k] = "similar";
                    }
                }
            }
        }
    }
    // 3. Rajadas parecidas (só vizinhas no tempo).
    let mut vecs: Vec<(usize, Vec<f32>)> = Vec::new();
    {
        let mut st = c.prepare("SELECT media_uid, vec FROM intel_clip")?;
        for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))? {
            let (uid, v) = r?;
            if let Some(&i) = at.get(uid.as_str()) {
                vecs.push((i, from_blob(&v)));
            }
        }
    }
    vecs.sort_by_key(|(i, _)| rows[*i].taken);
    for a in 0..vecs.len() {
        for b in a + 1..vecs.len() {
            if rows[vecs[b].0].taken - rows[vecs[a].0].taken > BURST_MS {
                break;
            }
            if dot(&vecs[a].1, &vecs[b].1) >= BURST_SIM {
                join(&mut parent, vecs[a].0, vecs[b].0);
            }
        }
    }

    let kept: std::collections::HashSet<String> = {
        let mut st = c.prepare("SELECT key FROM dup_keep")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut sets: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..rows.len() {
        let r = find(&mut parent, i);
        sets.entry(r).or_default().push(i);
    }
    let rank = |r: &Row| (r.fav, r.albums, r.pixels, -r.added);
    let mut out: Vec<Group> = sets
        .into_values()
        .filter(|m| m.len() > 1)
        .map(|m| {
            let mut uids: Vec<&str> = m.iter().map(|&i| rows[i].uid.as_str()).collect();
            uids.sort_unstable();
            let k = if m.iter().any(|&i| kind[i] == "exact") {
                "exact"
            } else if m.iter().any(|&i| kind[i] == "similar") {
                "similar"
            } else {
                "burst"
            };
            let best = *m.iter().max_by_key(|&&i| rank(&rows[i])).unwrap();
            Group { key: uids.join(","), kind: k, ids: m.iter().map(|&i| rows[i].id).collect(), best: rows[best].id }
        })
        .filter(|g| !kept.contains(&g.key))
        .collect();
    // Mais recentes primeiro.
    let taken: HashMap<i64, i64> = rows.iter().map(|r| (r.id, r.taken)).collect();
    out.sort_by_key(|g| std::cmp::Reverse(g.ids.iter().filter_map(|id| taken.get(id)).max().copied().unwrap_or(0)));
    Ok(out)
}

pub fn keep(c: &Connection, key: &str) -> rusqlite::Result<()> {
    c.execute("INSERT OR IGNORE INTO dup_keep (key) VALUES (?1)", [key])?;
    Ok(())
}
