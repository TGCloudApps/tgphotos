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
}

impl Stage {
    const ALL: [Stage; 2] = [Stage::Place, Stage::Hash];

    fn key(self) -> &'static str {
        match self {
            Stage::Place => "place",
            Stage::Hash => "hash",
        }
    }

    fn weight(self) -> Weight {
        match self {
            Stage::Place | Stage::Hash => Weight::Light,
        }
    }

    /// Modelo do vault público que a etapa precisa (nenhum = algoritmo próprio).
    fn model(self) -> Option<&'static str> {
        match self {
            Stage::Place => Some("lugares-geonames"),
            Stage::Hash => None,
        }
    }

    fn enabled(self, s: &Settings) -> bool {
        match self {
            Stage::Place => s.places,
            Stage::Hash => s.duplicates,
        }
    }

    /// Quais mídias a etapa trata (SQL sobre `media m`).
    fn eligible(self) -> &'static str {
        match self {
            Stage::Place => "m.lat IS NOT NULL AND m.lon IS NOT NULL",
            Stage::Hash => "m.thumb IS NOT NULL",
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
            let model_id = match stage.model() {
                Some(name) => match self.models.get(name, self.gov.may_download()).await {
                    Some(m) => m.id(),
                    None => continue,
                },
                None => format!("{}@1", stage.key()),
            };
            let Some(item) = self.next(&db, stage, &model_id) else { continue };
            *self.hold.lock().unwrap() = None;
            *self.running.lock().unwrap() = Some(stage.key());
            let t0 = Instant::now();
            let ok = match self.process(&db, stage, &item).await {
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

    async fn process(&self, db: &Db, stage: Stage, item: &Item) -> Result<bool, String> {
        match stage {
            Stage::Place => {
                let places = self.places().await.ok_or("base de lugares indisponível")?;
                let (Some(lat), Some(lon)) = (item.lat, item.lon) else { return Ok(false) };
                let Some(p) = places.nearest(lat, lon) else { return Ok(false) };
                db.local(|c| c.execute("INSERT OR REPLACE INTO intel_place (media_uid, city, state, country) VALUES (?1, ?2, ?3, ?4)", params![item.uid, p.city, p.state, p.country]))?;
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
