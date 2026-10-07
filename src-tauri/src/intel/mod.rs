//! Inteligência de mídia em segundo plano (docs/inteligencia-de-midia.md).
//!
//! Um trabalhador só, uma mídia por vez, com o governador decidindo se pode
//! rodar e quanto descansar. Cada etapa grava em `intel_done` que já tratou a
//! mídia com tal modelo; o que falta é consultado (mídia nova, sincronizada ou
//! troca de modelo entram sozinhas). A ordem: o que a interface pediu
//! (na tela) primeiro, depois do mais novo para o mais velho.

pub mod governor;
pub mod hash;
pub mod models;
pub mod places;
pub mod clip;
pub mod faces;
pub mod people;
pub mod ocr;
pub mod dups;
pub mod query;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tg_app::Vaults;
use tg_core::Telegram;
use tokio::sync::Notify;

use crate::db::Db;
use governor::{Governor, Hold, Power, Settings, Weight};
use models::Models;

/// Uma etapa da análise.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stage {
    Place,
    Hash,
    Clip,
    Faces,
    Ocr,
}

impl Stage {
    /// Ordem de prioridade: as leves primeiro (terminam rápido e já servem à busca).
    const ALL: [Stage; 5] = [Stage::Place, Stage::Hash, Stage::Clip, Stage::Faces, Stage::Ocr];

    fn key(self) -> &'static str {
        match self {
            Stage::Place => "place",
            Stage::Hash => "hash",
            Stage::Clip => "clip",
            Stage::Faces => "faces",
            Stage::Ocr => "ocr",
        }
    }

    fn weight(self) -> Weight {
        match self {
            Stage::Place | Stage::Hash => Weight::Light,
            Stage::Clip | Stage::Faces | Stage::Ocr => Weight::Heavy,
        }
    }

    /// Modelo do vault público que a etapa precisa (nenhum = algoritmo próprio).
    fn model(self) -> Option<&'static str> {
        match self {
            Stage::Place => Some("lugares-geonames"),
            Stage::Hash => None,
            Stage::Clip => Some("busca-siglip2-b32-256"),
            Stage::Faces => Some("rostos-buffalo-s"),
            Stage::Ocr => Some("texto-ppocr5-latin"),
        }
    }

    fn enabled(self, s: &Settings) -> bool {
        match self {
            Stage::Place => s.places,
            Stage::Hash => s.duplicates,
            Stage::Clip => s.search,
            Stage::Faces => s.people,
            Stage::Ocr => s.text,
        }
    }

    /// Quais mídias a etapa trata (SQL sobre `media m`).
    fn eligible(self) -> &'static str {
        match self {
            Stage::Place => "m.lat IS NOT NULL AND m.lon IS NOT NULL",
            Stage::Hash | Stage::Clip | Stage::Faces => "m.thumb IS NOT NULL",
            // Texto: só fotos (o quadro do vídeo raramente tem texto legível).
            Stage::Ocr => "m.thumb IS NOT NULL AND m.mime LIKE 'image/%'",
        }
    }
}

/// Progresso de uma etapa (a interface mostra "Lugares: 1.200 de 4.300").
#[derive(Serialize, Clone, Debug)]
pub struct StageStatus {
    pub stage: &'static str,
    pub done: i64,
    pub total: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Status {
    pub settings: Settings,
    /// Etapa rodando agora.
    pub running: Option<&'static str>,
    /// Por que está parado (bateria, temperatura…), quando está.
    pub hold: Option<Hold>,
    pub rush: bool,
    pub stages: Vec<StageStatus>,
    pub models: Vec<models::ModelState>,
}

/// Resultado da busca: as mídias e o que foi entendido do texto.
#[derive(Serialize)]
pub struct SearchResult {
    pub items: Vec<crate::db::Media>,
    pub chips: Vec<query::Chip>,
    /// Usou a busca por descrição (modelo instalado e ligado).
    pub semantic: bool,
}

struct Item {
    id: i64,
    uid: String,
    lat: Option<f64>,
    lon: Option<f64>,
}

pub struct Intel {
    vaults: Arc<Vaults<Db>>,
    tg: Arc<Telegram>,
    pub gov: Governor,
    pub models: Models,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    thumbs: PathBuf,
    places: Mutex<Option<Arc<places::Places>>>,
    /// Mídias que a interface pediu primeiro (na tela), uids.
    boost: Mutex<Vec<String>>,
    running: Mutex<Option<&'static str>>,
    /// Codificador de imagem da busca (carregado enquanto há o que processar).
    visual: Mutex<Option<(Arc<clip::Visual>, String)>>,
    textual: Arc<clip::Textual>,
    /// Detector + reconhecedor de rostos (carregados enquanto há o que processar).
    faces: Mutex<Option<Arc<faces::Faces>>>,
    ocr: Mutex<Option<Arc<ocr::Ocr>>>,
    /// Rostos do vault aberto em memória (agrupamento incremental): (vault, rostos).
    face_index: Mutex<Option<(i64, Vec<people::FaceRef>)>>,
    /// Vetores da busca em memória (uid, id, vetor), recarregados quando mudam.
    vectors: Mutex<Option<(i64, Arc<Vec<(i64, Vec<f32>)>>)>>,
    hold: Mutex<Option<Hold>>,
    wake: Notify,
}

impl Intel {
    pub fn new(vaults: Arc<Vaults<Db>>, tg: Arc<Telegram>, data_dir: PathBuf, thumbs: PathBuf) -> Arc<Self> {
        let settings_path = data_dir.join("inteligencia.json");
        let settings = std::fs::read(&settings_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Arc::new(Self {
            models: Models::new(Arc::clone(&tg), &data_dir),
            vaults,
            tg,
            gov: Governor::default(),
            settings: Mutex::new(settings),
            settings_path,
            thumbs,
            places: Mutex::new(None),
            boost: Mutex::new(Vec::new()),
            running: Mutex::new(None),
            visual: Mutex::new(None),
            textual: Arc::new(clip::Textual::new()),
            faces: Mutex::new(None),
            ocr: Mutex::new(None),
            face_index: Mutex::new(None),
            vectors: Mutex::new(None),
            hold: Mutex::new(None),
            wake: Notify::new(),
        })
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn set_settings(&self, s: Settings) {
        let _ = std::fs::write(&self.settings_path, serde_json::to_vec_pretty(&s).unwrap_or_default());
        *self.settings.lock().unwrap() = s;
        self.wake.notify_one();
    }

    pub fn set_power(&self, p: Power) {
        self.gov.set_power(p);
        self.wake.notify_one();
    }

    /// Mídias na tela: vão para a frente da fila.
    pub fn boost(&self, ids: &[i64]) {
        let Ok(db) = self.vaults.db() else { return };
        let uids: Vec<String> = ids.iter().filter_map(|id| db.uid(*id)).collect();
        *self.boost.lock().unwrap() = uids;
        self.wake.notify_one();
    }

    pub fn rush(&self, on: bool) {
        self.gov.rush(on);
        self.wake.notify_one();
    }

    pub fn status(&self) -> Status {
        let settings = self.settings();
        let stages = self.vaults.db().ok().map(|db| Stage::ALL.iter().filter(|s| s.enabled(&settings)).filter_map(|s| counts(&db, *s).ok()).collect()).unwrap_or_default();
        Status {
            settings,
            running: *self.running.lock().unwrap(),
            hold: *self.hold.lock().unwrap(),
            rush: self.gov.rushing(),
            stages,
            models: self.models.states(),
        }
    }

    /// O laço do trabalhador (um por app).
    pub fn spawn(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let pause = me.step().await;
                *me.running.lock().unwrap() = None;
                // Descansa (ou espera ser acordado: configuração, energia, tela).
                let _ = tokio::time::timeout(pause, me.wake.notified()).await;
            }
        });
    }

    /// Uma rodada: acha a próxima mídia de alguma etapa e a trata. Devolve o descanso.
    async fn step(self: &Arc<Self>) -> Duration {
        let Ok(db) = self.vaults.db() else { return Duration::from_secs(15) };
        let settings = self.settings();
        let mut held = None;
        for stage in Stage::ALL {
            if !stage.enabled(&settings) {
                continue;
            }
            if let Some(h) = self.gov.hold(&settings, stage.weight()) {
                held.get_or_insert(h);
                continue;
            }
            let model = match stage.model() {
                Some(name) => match self.models.get(name, self.gov.may_download()).await {
                    Some(m) => Some(m),
                    None => continue,
                },
                None => None,
            };
            let model_id = model.as_ref().map(|m| m.id()).unwrap_or_else(|| format!("{}@1", stage.key()));
            let Some(item) = self.next(&db, stage, &model_id) else { continue };
            *self.hold.lock().unwrap() = None;
            *self.running.lock().unwrap() = Some(stage.key());
            let t0 = Instant::now();
            let ok = match self.process(&db, stage, &item, model.as_deref()).await {
                Ok(ok) => ok,
                Err(e) => {
                    eprintln!("[intel] {} {}: {e}", stage.key(), item.uid);
                    false
                }
            };
            mark(&db, &item.uid, stage, &model_id, ok);
            return self.gov.rest(&settings, t0.elapsed());
        }
        *self.hold.lock().unwrap() = held;
        // Parado: solta os modelos grandes da memória.
        *self.visual.lock().unwrap() = None;
        *self.faces.lock().unwrap() = None;
        *self.ocr.lock().unwrap() = None;
        self.textual.trim();
        // Nada a fazer (ou tudo segurado): olha de novo daqui a pouco.
        Duration::from_secs(if held.is_some() { 30 } else { 60 })
    }

    fn next(&self, db: &Db, stage: Stage, model: &str) -> Option<Item> {
        let boost = serde_json::to_string(&*self.boost.lock().unwrap()).unwrap_or_else(|_| "[]".into());
        let base = format!(
            "SELECT m.id, m.uid, m.lat, m.lon FROM media m WHERE m.trashed_at IS NULL AND {} \
             AND NOT EXISTS (SELECT 1 FROM intel_done d WHERE d.media_uid = m.uid AND d.stage = ?1 AND d.model = ?2)",
            stage.eligible()
        );
        db.local(|c| {
            let row = |r: &rusqlite::Row| Ok(Item { id: r.get(0)?, uid: r.get(1)?, lat: r.get(2)?, lon: r.get(3)? });
            // Na tela primeiro; senão, do mais novo para o mais velho.
            let first = c
                .query_row(&format!("{base} AND m.uid IN (SELECT value FROM json_each(?3)) LIMIT 1"), params![stage.key(), model, boost], row)
                .optional()?;
            match first {
                Some(i) => Ok(Some(i)),
                None => c.query_row(&format!("{base} ORDER BY m.taken_at DESC LIMIT 1"), params![stage.key(), model], row).optional(),
            }
        })
        .ok()
        .flatten()
    }

    async fn process(&self, db: &Db, stage: Stage, item: &Item, model: Option<&models::Model>) -> Result<bool, String> {
        match stage {
            Stage::Place => {
                let places = self.places().await.ok_or("base de lugares indisponível")?;
                let (Some(lat), Some(lon)) = (item.lat, item.lon) else { return Ok(false) };
                let Some(p) = places.nearest(lat, lon) else { return Ok(false) };
                db.local(|c| c.execute("INSERT OR REPLACE INTO intel_place (media_uid, city, state, country) VALUES (?1, ?2, ?3, ?4)", params![item.uid, p.city, p.state, p.country]))?;
                Ok(true)
            }
            Stage::Clip => {
                let model = model.ok_or("sem modelo")?;
                let visual = self.visual(model)?;
                let jpeg = self.thumb(db, item).await?;
                let v = tauri::async_runtime::spawn_blocking(move || visual.embed(&jpeg)).await.map_err(|e| e.to_string())??;
                db.local(|c| c.execute("INSERT OR REPLACE INTO intel_clip (media_uid, model, vec) VALUES (?1, ?2, ?3)", params![item.uid, model.id(), clip::to_blob(&v)]))?;
                Ok(true)
            }
            Stage::Faces => {
                let model = model.ok_or("sem modelo")?;
                let det = {
                    let mut g = self.faces.lock().unwrap();
                    if g.is_none() {
                        *g = Some(Arc::new(faces::Faces::load(model)?));
                    }
                    Arc::clone(g.as_ref().unwrap())
                };
                let jpeg = self.thumb(db, item).await?;
                let (found, w, h) = tauri::async_runtime::spawn_blocking(move || det.analyze(&jpeg)).await.map_err(|e| e.to_string())??;
                if found.is_empty() {
                    return Ok(true);
                }
                let vault = self.vaults.current().map(|o| o.id()).unwrap_or_default();
                let mut index = self.face_index.lock().unwrap();
                if index.as_ref().is_none_or(|(v, _)| *v != vault) {
                    *index = Some((vault, db.local(|c| people::load_all(c))?));
                }
                let list = &mut index.as_mut().unwrap().1;
                db.local(|c| {
                    let tx = c.transaction()?;
                    for f in found {
                        let (fw, fh) = (w as f32, h as f32);
                        tx.execute(
                            "INSERT INTO intel_face (media_uid, x, y, w, h, score, vec) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![item.uid, f.x1 / fw, f.y1 / fh, (f.x2 - f.x1) / fw, (f.y2 - f.y1) / fh, f.score, clip::to_blob(&f.vec)],
                        )?;
                        let id = tx.last_insert_rowid();
                        people::assign(&tx, list, id, f.vec)?;
                    }
                    tx.commit()
                })?;
                Ok(true)
            }
            Stage::Ocr => {
                let model = model.ok_or("sem modelo")?;
                let reader = {
                    let mut g = self.ocr.lock().unwrap();
                    if g.is_none() {
                        *g = Some(Arc::new(ocr::Ocr::load(model)?));
                    }
                    Arc::clone(g.as_ref().unwrap())
                };
                // Texto pequeno se perde na miniatura: o original, quando está neste computador.
                let bytes = match self.local_original(db, &item.uid).await {
                    Some(b) => b,
                    None => self.thumb(db, item).await?,
                };
                let text = tauri::async_runtime::spawn_blocking(move || reader.read(&bytes)).await.map_err(|e| e.to_string())??;
                db.local(|c| {
                    let tx = c.transaction()?;
                    tx.execute("DELETE FROM intel_fts WHERE media_uid = ?1", [&item.uid])?;
                    if !text.trim().is_empty() {
                        tx.execute("INSERT OR REPLACE INTO intel_text (media_uid, text) VALUES (?1, ?2)", params![item.uid, text])?;
                        tx.execute("INSERT INTO intel_fts (media_uid, text) VALUES (?1, ?2)", params![item.uid, text])?;
                    }
                    tx.commit()
                })?;
                Ok(true)
            }
            Stage::Hash => {
                let jpeg = self.thumb(db, item).await?;
                let h = tauri::async_runtime::spawn_blocking(move || hash::dhash(&jpeg)).await.map_err(|e| e.to_string())?.ok_or("miniatura ilegível")?;
                db.local(|c| c.execute("INSERT OR REPLACE INTO intel_hash (media_uid, phash) VALUES (?1, ?2)", params![item.uid, h as i64]))?;
                Ok(true)
            }
        }
    }

    fn visual(&self, model: &models::Model) -> Result<Arc<clip::Visual>, String> {
        let mut g = self.visual.lock().unwrap();
        if let Some((v, id)) = g.as_ref() {
            if *id == model.id() {
                return Ok(Arc::clone(v));
            }
        }
        let v = Arc::new(clip::Visual::load(model)?);
        *g = Some((Arc::clone(&v), model.id()));
        Ok(v)
    }

    /// Busca por descrição ("praia ao pôr do sol"): as mídias mais parecidas,
    /// da melhor para a pior, com a nota. Sem modelo instalado: vazio.
    pub async fn search(&self, text: &str, limit: usize) -> Result<Vec<(i64, f32)>, String> {
        let Some(model) = self.models.get("busca-siglip2-b32-256", false).await else { return Ok(Vec::new()) };
        let db = self.vaults.db()?;
        let vectors = self.vectors(&db, &model.id())?;
        let textual = Arc::clone(&self.textual);
        let text = text.to_string();
        // O codificador de texto é pesado: fora da thread do servidor.
        let q = tauri::async_runtime::spawn_blocking(move || textual.embed(&model, &text))
        .await
        .map_err(|e| e.to_string())??;
        let mut scored: Vec<(i64, f32)> = vectors.iter().map(|(id, v)| (*id, clip::dot(&q, v))).collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.truncate(limit);
        Ok(scored)
    }

    /// A busca da caixa única: filtros do texto (data, lugar, tipo) + álbum da
    /// tela + descrição (SigLIP2) e nomes. Sem texto livre: só os filtros, por data.
    pub async fn query(&self, text: &str, album: Option<i64>) -> Result<SearchResult, String> {
        use rusqlite::types::Value;
        let db = self.vaults.db()?;
        let mut p = query::parse(text, chrono::Local::now().date_naive());

        // Lugares conhecidos (das fotos com GPS) citados no texto.
        let mut where_ = vec!["m.trashed_at IS NULL".to_string()];
        let mut args: Vec<Value> = Vec::new();
        if !p.rest.is_empty() {
            let names: Vec<(String, &'static str)> = db.local(|c| {
                let mut out = Vec::new();
                for col in ["city", "state", "country"] {
                    let mut st = c.prepare(&format!("SELECT DISTINCT {col} FROM intel_place WHERE {col} != ''"))?;
                    let col: &'static str = col;
                    for r in st.query_map([], |r| r.get::<_, String>(0))? {
                        out.push((r?, col));
                    }
                }
                Ok(out)
            })?;
            let mut names: Vec<(String, String, &'static str)> = names.into_iter().map(|(n, c)| (query::fold(&n), n, c)).collect();
            // O nome mais longo primeiro ("São Paulo" antes de "Paulo").
            names.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
            let mut words: Vec<String> = p.rest.split_whitespace().map(String::from).collect();
            for (key, name, col) in names {
                let kw: Vec<&str> = key.split_whitespace().collect();
                if kw.is_empty() {
                    continue;
                }
                let folded: Vec<String> = words.iter().map(|w| query::fold(w).trim_matches(|c: char| !c.is_alphanumeric()).to_string()).collect();
                if let Some(at) = (0..folded.len().saturating_sub(kw.len() - 1)).find(|&i| kw.iter().enumerate().all(|(k, w)| folded.get(i + k).map(|s| s.as_str()) == Some(*w))) {
                    words.drain(at..at + kw.len());
                    where_.push(format!("m.uid IN (SELECT media_uid FROM intel_place WHERE {col} = ?)"));
                    args.push(Value::Text(name.clone()));
                    p.chips.push(query::Chip { kind: "place", label: name });
                }
            }
            p.rest = words.join(" ");
        }
        // Pessoas com nome citadas no texto ("gabi praia").
        if !p.rest.is_empty() {
            let names: Vec<(String, String)> = db.local(|c| {
                let mut st = c.prepare("SELECT uid, name FROM person WHERE name != '' AND hidden = 0")?;
                let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                rows.collect()
            })?;
            let mut names: Vec<(String, String, String)> = names.into_iter().map(|(u, n)| (query::fold(&n), n, u)).collect();
            names.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
            let mut words: Vec<String> = p.rest.split_whitespace().map(String::from).collect();
            for (key, name, uid) in names {
                let kw: Vec<&str> = key.split_whitespace().collect();
                if kw.is_empty() {
                    continue;
                }
                let folded: Vec<String> = words.iter().map(|w| query::fold(w).trim_matches(|c: char| !c.is_alphanumeric()).to_string()).collect();
                if let Some(at) = (0..folded.len().saturating_sub(kw.len() - 1)).find(|&i| kw.iter().enumerate().all(|(k, w)| folded.get(i + k).map(|s| s.as_str()) == Some(*w))) {
                    words.drain(at..at + kw.len());
                    where_.push("m.uid IN (SELECT media_uid FROM intel_face WHERE person_uid = ?)".into());
                    args.push(Value::Text(uid));
                    p.chips.push(query::Chip { kind: "person", label: name });
                }
            }
            p.rest = words.join(" ");
        }
        if let (Some(a), Some(b)) = (p.from, p.to) {
            where_.push("m.taken_at >= ? AND m.taken_at < ?".into());
            args.push(Value::Integer(a));
            args.push(Value::Integer(b));
        }
        if let Some(mo) = p.month {
            where_.push("CAST(strftime('%m', m.taken_at / 1000 + COALESCE(m.tz, 0) * 60, 'unixepoch') AS INTEGER) = ?".into());
            args.push(Value::Integer(mo as i64));
        }
        match p.kind {
            Some("video") => where_.push("m.mime LIKE 'video/%'".into()),
            Some(_) => where_.push("m.mime NOT LIKE 'video/%'".into()),
            None => {}
        }
        if let Some(a) = album {
            where_.push("m.uid IN (SELECT i.media_uid FROM album_items i JOIN albums a ON a.uid = i.album_uid WHERE a.id = ?)".into());
            args.push(Value::Integer(a));
        }

        let rest = p.rest.trim().to_string();
        if rest.is_empty() {
            let sql = format!("SELECT {} FROM media m WHERE {} ORDER BY m.taken_at DESC LIMIT 5000", crate::db::COLS_M, where_.join(" AND "));
            let items = db.query(&sql, rusqlite::params_from_iter(args))?;
            return Ok(SearchResult { items, chips: p.chips, semantic: false });
        }

        // Nome (arquivo, câmera, álbum) vale mais que a descrição; a descrição
        // traz o resto, até onde a nota cai para menos da metade da melhor.
        let mut score: std::collections::HashMap<i64, f32> = std::collections::HashMap::new();
        for m in db.search(&rest, 500)? {
            score.insert(m.id, 10.0);
        }
        // Texto lido nas imagens (FTS5, sem acentos, prefixo).
        let fts: String = rest
            .split_whitespace()
            .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
            .filter(|w| !w.is_empty())
            .map(|w| format!("\"{w}\"*"))
            .collect::<Vec<_>>()
            .join(" ");
        if !fts.is_empty() {
            let hits: Vec<i64> = db
                .local(|c| {
                    let mut st = c.prepare("SELECT m.id FROM intel_fts f JOIN media m ON m.uid = f.media_uid WHERE intel_fts MATCH ?1 LIMIT 500")?;
                    let rows = st.query_map([&fts], |r| r.get(0))?;
                    rows.collect::<rusqlite::Result<Vec<i64>>>()
                })
                .unwrap_or_default();
            for id in hits {
                score.entry(id).or_insert(5.0);
            }
        }
        let semantic = self.settings().search;
        if semantic {
            let found = self.search(&rest, 2000).await.unwrap_or_default();
            if let Some(best) = found.first().map(|x| x.1) {
                for (id, s) in found.into_iter().filter(|x| x.1 >= best * 0.5) {
                    score.entry(id).or_insert(s);
                }
            }
        }
        let ids: Vec<i64> = score.keys().copied().collect();
        where_.push("m.id IN (SELECT value FROM json_each(?))".into());
        args.push(Value::Text(serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into())));
        let sql = format!("SELECT {} FROM media m WHERE {}", crate::db::COLS_M, where_.join(" AND "));
        let mut items = db.query(&sql, rusqlite::params_from_iter(args))?;
        items.sort_by(|a, b| score.get(&b.id).unwrap_or(&0.0).total_cmp(score.get(&a.id).unwrap_or(&0.0)).then(b.taken_at.total_cmp(&a.taken_at)));
        items.truncate(600);
        Ok(SearchResult { items, chips: p.chips, semantic })
    }

    /// Mudou alguma pessoa à mão: o índice em memória relê do banco.
    pub fn people_changed(&self) {
        *self.face_index.lock().unwrap() = None;
    }

    /// Recorte quadrado do rosto (160 px) a partir da miniatura, para avatares.
    pub async fn face_crop(&self, face: i64) -> Result<Vec<u8>, String> {
        let db = self.vaults.db()?;
        let (uid, x, y, w, h, id): (String, f32, f32, f32, f32, i64) = db.local(|c| {
            c.query_row("SELECT f.media_uid, f.x, f.y, f.w, f.h, m.id FROM intel_face f JOIN media m ON m.uid = f.media_uid WHERE f.id = ?1", [face], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })
        })?;
        let jpeg = self.thumb(&db, &Item { id, uid, lat: None, lon: None }).await?;
        tauri::async_runtime::spawn_blocking(move || {
            let img = image::load_from_memory(&jpeg).map_err(|e| e.to_string())?;
            let (iw, ih) = (img.width() as f32, img.height() as f32);
            // Quadrado centrado no rosto, com folga (cabelo, queixo).
            let side = (w * iw).max(h * ih) * 1.6;
            let cx = (x + w / 2.0) * iw;
            let cy = (y + h / 2.0) * ih;
            let x0 = (cx - side / 2.0).clamp(0.0, (iw - side).max(0.0));
            let y0 = (cy - side / 2.0).clamp(0.0, (ih - side).max(0.0));
            let side = side.min(iw).min(ih);
            let crop = img.crop_imm(x0 as u32, y0 as u32, side as u32, side as u32).resize_exact(160, 160, image::imageops::FilterType::CatmullRom).to_rgb8();
            let mut out = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86).encode_image(&crop).map_err(|e| e.to_string())?;
            Ok(out)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Todos os vetores do vault aberto (em memória; recarrega quando o número muda).
    fn vectors(&self, db: &Db, model: &str) -> Result<Arc<Vec<(i64, Vec<f32>)>>, String> {
        let n: i64 = db.local(|c| c.query_row("SELECT COUNT(*) FROM intel_clip WHERE model = ?1", [model], |r| r.get(0)))?;
        if let Some((count, v)) = self.vectors.lock().unwrap().as_ref() {
            if *count == n {
                return Ok(Arc::clone(v));
            }
        }
        let list = db.local(|c| {
            let mut st = c.prepare("SELECT m.id, k.vec FROM intel_clip k JOIN media m ON m.uid = k.media_uid WHERE k.model = ?1 AND m.trashed_at IS NULL")?;
            let rows = st.query_map([model], |r| Ok((r.get::<_, i64>(0)?, clip::from_blob(&r.get::<_, Vec<u8>>(1)?))))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })?;
        let list = Arc::new(list);
        *self.vectors.lock().unwrap() = Some((n, Arc::clone(&list)));
        Ok(list)
    }

    /// O original, se foi enviado deste computador e o arquivo ainda está lá
    /// (Android: o endereço é do MediaStore, não legível daqui; fica a miniatura).
    async fn local_original(&self, db: &Db, uid: &str) -> Option<Vec<u8>> {
        let src: String = db.local(|c| c.query_row("SELECT src FROM backup_done WHERE media_uid = ?1", [uid], |r| r.get(0)).optional()).ok().flatten()?;
        if src.starts_with("content://") {
            return None;
        }
        let meta = tokio::fs::metadata(&src).await.ok()?;
        // Original grande demais não vale a leitura (o detector reduz para 960 px).
        if meta.len() > 40 * 1024 * 1024 {
            return None;
        }
        tokio::fs::read(&src).await.ok()
    }

    async fn places(&self) -> Option<Arc<places::Places>> {
        if let Some(p) = self.places.lock().unwrap().as_ref() {
            return Some(Arc::clone(p));
        }
        let m = self.models.get("lugares-geonames", self.gov.may_download()).await?;
        let path = m.file("lugares.bin");
        let p = tauri::async_runtime::spawn_blocking(move || places::Places::load(&path)).await.ok()?.ok()?;
        let p = Arc::new(p);
        *self.places.lock().unwrap() = Some(Arc::clone(&p));
        Some(p)
    }

    /// A miniatura do vault: do cache em disco; sem ela, do canal (com rede).
    async fn thumb(&self, db: &Db, item: &Item) -> Result<Vec<u8>, String> {
        let path = self.thumbs.join(format!("{}.jpg", item.uid));
        if let Ok(b) = tokio::fs::read(&path).await {
            return Ok(b);
        }
        if !self.vaults.net().online() || !self.gov.may_download() {
            return Err("miniatura fora do cache e sem rede".into());
        }
        let (piece, _) = tg_app::Library::thumb(db, item.id).ok_or("sem miniatura")?;
        let bytes = self.tg.read_blob(piece.msg_id, piece.size).await?;
        let _ = tokio::fs::create_dir_all(&self.thumbs).await;
        let _ = tokio::fs::write(&path, &bytes).await;
        Ok(bytes)
    }
}

fn mark(db: &Db, uid: &str, stage: Stage, model: &str, ok: bool) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default();
    let _ = db.local(|c| {
        c.execute(
            "INSERT OR REPLACE INTO intel_done (media_uid, stage, model, ok, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![uid, stage.key(), model, ok, now],
        )
    });
}

fn counts(db: &Db, stage: Stage) -> crate::db::Result<StageStatus> {
    db.local(|c| {
        let total: i64 = c.query_row(&format!("SELECT COUNT(*) FROM media m WHERE m.trashed_at IS NULL AND {}", stage.eligible()), [], |r| r.get(0))?;
        let done: i64 = c.query_row(
            &format!(
                "SELECT COUNT(*) FROM media m WHERE m.trashed_at IS NULL AND {} AND EXISTS (SELECT 1 FROM intel_done d WHERE d.media_uid = m.uid AND d.stage = ?1)",
                stage.eligible()
            ),
            [stage.key()],
            |r| r.get(0),
        )?;
        Ok(StageStatus { stage: stage.key(), done, total })
    })
}
