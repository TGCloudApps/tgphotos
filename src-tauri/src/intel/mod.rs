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
pub mod power;
pub mod clip;
pub mod faces;
pub mod people;
pub mod ocr;
pub mod dups;
pub mod packs;
pub mod frames;
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
            // Com miniatura no vault, ou foto com o original neste aparelho
            // (analisada dele, sem precisar subir nada antes).
            // Vídeo com tira de quadros também.
            Stage::Hash | Stage::Clip | Stage::Faces => {
                "(m.thumb IS NOT NULL OR (m.mime LIKE 'image/%' AND EXISTS (SELECT 1 FROM backup_done b WHERE b.media_uid = m.uid))
                  OR EXISTS (SELECT 1 FROM frames f WHERE f.media_uid = m.uid))"
            }
            // Texto: fotos, e vídeos pela tira de quadros (um quadro só raramente
            // tem texto legível).
            Stage::Ocr => "((m.mime LIKE 'image/%' AND (m.thumb IS NOT NULL OR EXISTS (SELECT 1 FROM backup_done b WHERE b.media_uid = m.uid)))
                            OR EXISTS (SELECT 1 FROM frames f WHERE f.media_uid = m.uid))",
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
    /// Há bateria (celular, notebook): a interface mostra as opções de bateria.
    pub battery: bool,
    pub stages: Vec<StageStatus>,
    /// Modelo de cada recurso ligado (para a interface dizer "baixando", "falhou"…).
    pub models: Vec<FeatureModel>,
    /// Rede medida: downloads esperam o Wi-Fi.
    pub metered: bool,
    /// Vault cifrado (os pacotes de análise vão cifrados).
    pub encrypted: bool,
    /// Pacotes de outros aparelhos ainda por importar.
    pub packs_waiting: i64,
}

/// Intervalo mínimo entre envios da inteligência ao canal (miniatura ou
/// pacote): ~180 por hora no máximo, longe do que o Telegram pune.
const UPLOAD_GAP: Duration = Duration::from_secs(20);
/// Pacote de análise: um retrato periódico do que foi analisado desde o
/// último, mesmo com a análise ainda em andamento (~6 mensagens por hora).
const PACK_EVERY: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize, Clone, Debug)]
pub struct Usage {
    pub models: u64,
    pub data: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct FeatureModel {
    /// Etapa (clip, faces, ocr, place).
    pub stage: &'static str,
    #[serde(flatten)]
    pub model: models::ModelState,
}

/// Vetores da busca em memória: (id da mídia, vetor).
type Vectors = Arc<Vec<(i64, Vec<f32>)>>;

/// Resultado da busca: as mídias e o que foi entendido do texto.
#[derive(Serialize)]
pub struct SearchResult {
    pub items: Vec<crate::db::Media>,
    pub chips: Vec<query::Chip>,
    /// Usou a busca por descrição (modelo instalado e ligado).
    pub semantic: bool,
    /// Por que a busca por descrição está incompleta (a interface explica).
    pub semantic_state: Option<SemanticState>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SemanticState {
    /// off (desligada) | model (modelo não está pronto) | partial (análise pela metade) | error (falhou)
    pub state: &'static str,
    pub done: i64,
    pub total: i64,
    pub model: Option<models::ModelState>,
    pub error: Option<String>,
}

/// Vídeo para o trabalhador de tiras da interface.
#[derive(Serialize)]
pub struct FramesJob {
    pub id: i64,
    /// Original neste aparelho (a interface lê dele, sem rede).
    pub local: bool,
    pub duration: Option<f64>,
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
    face_index: Mutex<Option<((i64, u64), Vec<people::FaceRef>)>>,
    /// Vetores da busca em memória (uid, id, vetor), recarregados quando mudam.
    vectors: Mutex<Option<(i64, Vectors)>>,
    hold: Mutex<Option<Hold>>,
    wake: Notify,
    has_battery: std::sync::atomic::AtomicBool,
    /// Rostos novos desde o último reagrupamento (começa ligado: arruma o que já existe).
    faces_dirty: std::sync::atomic::AtomicBool,
    /// Para ler originais do Android (`content://`), pelo plugin de arquivos.
    pub handle: std::sync::OnceLock<tauri::AppHandle>,
    /// Mídias cuja miniatura não deu para gerar daqui nesta execução.
    thumb_failed: Mutex<std::collections::HashSet<i64>>,
    /// Vaults em que as falhas já voltaram para a fila nesta execução.
    retried: Mutex<std::collections::HashSet<i64>>,
    /// Próximo horário em que a inteligência pode enviar algo ao canal.
    next_upload: Mutex<Instant>,
    /// Último pacote de análise enviado (espera juntar mais antes do próximo).
    last_pack: Mutex<Option<Instant>>,
    /// Vídeos cuja tira de quadros não deu para gerar nesta execução.
    frames_failed: Mutex<std::collections::HashSet<i64>>,
    /// Pacotes que falharam ao baixar agora há pouco (uid → quando).
    pack_failed: Mutex<std::collections::HashMap<String, Instant>>,
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
            has_battery: std::sync::atomic::AtomicBool::new(false),
            faces_dirty: std::sync::atomic::AtomicBool::new(true),
            last_pack: Mutex::new(None),
            next_upload: Mutex::new(Instant::now()),
            retried: Mutex::new(std::collections::HashSet::new()),
            handle: std::sync::OnceLock::new(),
            thumb_failed: Mutex::new(std::collections::HashSet::new()),
            pack_failed: Mutex::new(std::collections::HashMap::new()),
            frames_failed: Mutex::new(std::collections::HashSet::new()),
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
        self.has_battery.store(true, std::sync::atomic::Ordering::Relaxed);
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

    /// "Tentar de novo" os modelos que falharam.
    pub fn retry_models(&self) {
        self.models.retry();
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
            battery: self.has_battery.load(std::sync::atomic::Ordering::Relaxed),
            stages,
            models: Stage::ALL
                .iter()
                .filter(|s| s.enabled(&self.settings()))
                .filter_map(|s| Some(FeatureModel { stage: s.key(), model: self.models.state(s.model()?) }))
                .collect(),
            metered: !self.gov.may_download(),
            encrypted: self.tg.encrypted(),
            packs_waiting: self.vaults.db().ok().and_then(|d| d.local(|c| c.query_row("SELECT COUNT(*) FROM intel_pack WHERE imported = 0", [], |r| r.get(0))).ok()).unwrap_or(0),
        }
    }

    /// O laço do trabalhador (um por app).
    pub fn spawn(self: &Arc<Self>) {
        // Desktop: bateria do notebook lida do sistema a cada minuto (sem
        // bateria, fica "na tomada"). No Android, a interface informa.
        #[cfg(not(target_os = "android"))]
        {
            let me = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                loop {
                    if let Some(p) = tauri::async_runtime::spawn_blocking(power::read).await.ok().flatten() {
                        me.set_power(p);
                    }
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            });
        }
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let pause = me.step().await;
                *me.running.lock().unwrap() = None;
                // Descansa (ou espera ser acordado: configuração, energia, tela, miniatura nova).
                let db = me.vaults.db().ok();
                let thumb = async {
                    match &db {
                        Some(d) => d.intel_wake.notified().await,
                        None => std::future::pending().await,
                    }
                };
                let _ = tokio::time::timeout(pause, async {
                    tokio::select! {
                        _ = me.wake.notified() => {}
                        _ = thumb => {}
                    }
                })
                .await;
            }
        });
    }

    /// Uma rodada: acha a próxima mídia de alguma etapa e a trata. Devolve o descanso.
    async fn step(self: &Arc<Self>) -> Duration {
        let Ok(db) = self.vaults.db() else { return Duration::from_secs(15) };
        let settings = self.settings();
        // Uma vez por abertura do vault: o que falhou volta para a fila (a
        // falha pode ter sido do app, já corrigida, e não da foto).
        let vault = self.vaults.current().map(|o| o.id()).unwrap_or_default();
        if self.retried.lock().unwrap().insert(vault) {
            if let Ok(n) = db.local(|c| c.execute("DELETE FROM intel_done WHERE ok = 0", [])) {
                if n > 0 {
                    eprintln!("[intel] {n} análises que falharam voltam para a fila");
                }
            }
        }
        // Antes de analisar: o que outro aparelho já analisou (evita refazer).
        if let Some(pause) = self.import_pack(&db).await {
            return pause;
        }
        // Retrato periódico do que já foi analisado, sem esperar a fila esvaziar.
        if let Some(pause) = self.send_pack(&db, &settings).await {
            return pause;
        }

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
        // Fila de rostos vazia e rostos novos desde a última vez: reagrupa os soltos.
        if held.is_none() && settings.people && self.faces_dirty.swap(false, std::sync::atomic::Ordering::Relaxed) {
            let d = Arc::clone(&db);
            match tauri::async_runtime::spawn_blocking(move || d.local(|c| people::recluster(c))).await {
                Ok(Ok(n)) if n > 0 => {
                    eprintln!("[intel] reagrupados: {n} rostos");
                    *self.face_index.lock().unwrap() = None;
                }
                Ok(Err(e)) => eprintln!("[intel] reagrupar: {e}"),
                _ => {}
            }
        }
        // Fila vazia: sobe as miniaturas que faltam no vault, devagar — ver
        // `may_upload`.
        if held.is_none() {
            if let Some(pause) = self.share_thumb(&db).await {
                return pause;
            }
        }
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
                // Vídeo com tira: um vetor por quadro (a busca vale o melhor) e,
                // como principal, a média (duplicatas comparam o vídeo todo).
                if let Some(frames) = self.frames(db, &item.uid).await? {
                    let vecs = tauri::async_runtime::spawn_blocking(move || frames.iter().map(|f| visual.embed(f)).collect::<Result<Vec<_>, _>>())
                        .await
                        .map_err(|e| e.to_string())??;
                    let main = clip::mean(&vecs);
                    db.local(|c| {
                        let tx = c.transaction()?;
                        tx.execute("INSERT OR REPLACE INTO intel_clip (media_uid, model, vec) VALUES (?1, ?2, ?3)", params![item.uid, model.id(), clip::to_blob(&main)])?;
                        tx.execute("DELETE FROM intel_clip_frame WHERE media_uid = ?1", [&item.uid])?;
                        for (i, v) in vecs.iter().enumerate() {
                            tx.execute("INSERT INTO intel_clip_frame (media_uid, idx, vec) VALUES (?1, ?2, ?3)", params![item.uid, i as i64, clip::to_blob(v)])?;
                        }
                        tx.commit()
                    })?;
                    return Ok(true);
                }
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
                // Rostos com o quadro de onde vieram (None = a própria imagem) e o
                // tamanho dela.
                let found: Vec<(Option<i64>, faces::Face, u32, u32)> = if let Some(frames) = self.frames(db, &item.uid).await? {
                    // Vídeo com tira: todos os quadros, cada pessoa uma vez por
                    // vídeo (o mesmo rosto em vários quadros não vira vários rostos).
                    tauri::async_runtime::spawn_blocking(move || {
                        let mut out: Vec<(Option<i64>, faces::Face, u32, u32)> = Vec::new();
                        for (i, f) in frames.iter().enumerate() {
                            let (list, w, h) = det.analyze(f)?;
                            for face in list {
                                match out.iter_mut().find(|(_, o, _, _)| clip::dot(&o.vec, &face.vec) >= people::SAME) {
                                    Some(o) if o.1.score < face.score => *o = (Some(i as i64), face, w, h),
                                    Some(_) => {}
                                    None => out.push((Some(i as i64), face, w, h)),
                                }
                            }
                        }
                        Ok::<_, String>(out)
                    })
                    .await
                    .map_err(|e| e.to_string())??
                } else {
                    // O original (quando está neste aparelho) dá rostos mais nítidos que a miniatura de 480 px.
                    let original = self.local_original(db, &item.uid).await;
                    let found = match original {
                        Some(bytes) => {
                            let d = Arc::clone(&det);
                            tauri::async_runtime::spawn_blocking(move || d.analyze(&bytes)).await.map_err(|e| e.to_string())?.ok()
                        }
                        None => None,
                    };
                    let (found, w, h) = match found {
                        Some(f) => f,
                        None => {
                            let jpeg = self.thumb(db, item).await?;
                            tauri::async_runtime::spawn_blocking(move || det.analyze(&jpeg)).await.map_err(|e| e.to_string())??
                        }
                    };
                    found.into_iter().map(|f| (None, f, w, h)).collect()
                };
                if found.is_empty() {
                    return Ok(true);
                }
                self.faces_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
                let vault = (self.vaults.current().map(|o| o.id()).unwrap_or_default(), db.people_rev.load(std::sync::atomic::Ordering::Relaxed));
                let mut index = self.face_index.lock().unwrap();
                if index.as_ref().is_none_or(|(v, _)| *v != vault) {
                    *index = Some((vault, db.local(|c| people::load_all(c))?));
                }
                let list = &mut index.as_mut().unwrap().1;
                db.local(|c| {
                    let tx = c.transaction()?;
                    for (frame, f, w, h) in found {
                        let (fw, fh) = (w as f32, h as f32);
                        tx.execute(
                            "INSERT INTO intel_face (media_uid, x, y, w, h, score, vec, frame) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                            params![item.uid, f.x1 / fw, f.y1 / fh, (f.x2 - f.x1) / fw, (f.y2 - f.y1) / fh, f.score, clip::to_blob(&f.vec), frame],
                        )?;
                        let id = tx.last_insert_rowid();
                        // Outro aparelho já decidiu este rosto: vale a decisão.
                        let b = (f.x1 / fw, f.y1 / fh, (f.x2 - f.x1) / fw, (f.y2 - f.y1) / fh);
                        match people::anchored(&tx, &item.uid, b)? {
                            Some((p, false)) => {
                                tx.execute("UPDATE intel_face SET person_uid = ?2, manual = 1 WHERE id = ?1", params![id, p])?;
                                list.push(people::FaceRef { id, person: Some(p), rejected: None, vec: f.vec });
                            }
                            Some((p, true)) => {
                                tx.execute("UPDATE intel_face SET rejected = ?2, manual = 1 WHERE id = ?1", params![id, p])?;
                                people::assign(&tx, list, id, f.vec)?;
                            }
                            None => people::assign(&tx, list, id, f.vec)?,
                        }
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
                let text = if let Some(frames) = self.frames(db, &item.uid).await? {
                    // Vídeo: o texto de cada quadro, sem repetir o que já foi lido.
                    tauri::async_runtime::spawn_blocking(move || {
                        let mut parts: Vec<String> = Vec::new();
                        for f in &frames {
                            let t = reader.read(f)?;
                            let t = t.trim();
                            if !t.is_empty() && !parts.iter().any(|p| p == t) {
                                parts.push(t.to_string());
                            }
                        }
                        Ok::<_, String>(parts.join("\n"))
                    })
                    .await
                    .map_err(|e| e.to_string())??
                } else {
                    // Texto pequeno se perde na miniatura: o original, quando está neste computador.
                    let bytes = match self.local_original(db, &item.uid).await {
                        Some(b) => b,
                        None => self.thumb(db, item).await?,
                    };
                    tauri::async_runtime::spawn_blocking(move || reader.read(&bytes)).await.map_err(|e| e.to_string())??
                };
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
                // Vídeo com tira: o hash da tira toda (vídeos que só começam
                // iguais deixam de parecer duplicatas).
                let jpeg = match self.strip(db, &item.uid).await? {
                    Some((j, _)) => j,
                    None => self.thumb(db, item).await?,
                };
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
        let Some(model) = self.models.get("busca-siglip2-b32-256", false).await else { return Err("o modelo da busca por descrição não está neste aparelho".into()) };
        let db = self.vaults.db()?;
        let vectors = self.vectors(&db, &model.id())?;
        let textual = Arc::clone(&self.textual);
        let text = text.to_string();
        // O codificador de texto é pesado: fora da thread do servidor.
        let q = tauri::async_runtime::spawn_blocking(move || textual.embed(&model, &text))
        .await
        .map_err(|e| e.to_string())??;
        // Uma nota por mídia: a melhor (vídeos têm um vetor por quadro).
        let mut best: std::collections::HashMap<i64, f32> = std::collections::HashMap::new();
        for (id, v) in vectors.iter() {
            let s = clip::dot(&q, v);
            best.entry(*id).and_modify(|b| *b = b.max(s)).or_insert(s);
        }
        let mut scored: Vec<(i64, f32)> = best.into_iter().collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        scored.truncate(limit);
        Ok(scored)
    }

    /// A busca da caixa única: filtros do texto (data, lugar, tipo) + álbum da
    /// tela + descrição (SigLIP2) e nomes. Sem texto livre: só os filtros, por data.
    /// A busca da caixa única. `semantic` falso: só filtros, nomes e texto lido
    /// (rápido, primeira fase); verdadeiro: com a descrição (SigLIP2).
    pub async fn query(&self, text: &str, album: Option<i64>, semantic: bool) -> Result<SearchResult, String> {
        let db = self.vaults.db()?;
        let plan = plan(&db, text, album)?;
        let use_semantic = semantic && self.settings().search && !plan.rest.is_empty();
        // Uma falha aqui não pode virar "nada encontrado" calado: vai para o log
        // e para a tela (no Android, o log aparece como RustStdoutStderr).
        let mut failed = None;
        let found = if use_semantic {
            match self.search(&plan.rest, 2000).await {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("[intel] busca por descrição: {e}");
                    failed = Some(e);
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        let mut out = run(&db, plan, found, use_semantic && failed.is_none())?;
        out.semantic_state = match failed {
            Some(e) => Some(SemanticState { state: "error", done: 0, total: 0, model: None, error: Some(e) }),
            None => self.semantic_state(&db),
        };
        Ok(out)
    }

    /// Por que a busca por descrição não cobre tudo ainda (`None` = cobre).
    fn semantic_state(&self, db: &Db) -> Option<SemanticState> {
        if !self.settings().search {
            return Some(SemanticState { state: "off", done: 0, total: 0, model: None, error: None });
        }
        let model = self.models.state("busca-siglip2-b32-256");
        if model.state != "ready" {
            return Some(SemanticState { state: "model", done: 0, total: 0, model: Some(model), error: None });
        }
        let c = counts(db, Stage::Clip).ok()?;
        (c.done < c.total).then_some(SemanticState { state: "partial", done: c.done, total: c.total, model: None, error: None })
    }

    /// Espaço usado: modelos baixados e resultados da análise deste vault.
    pub fn usage(&self) -> Result<Usage, String> {
        fn size(p: &std::path::Path) -> u64 {
            match std::fs::metadata(p) {
                Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|d| d.flatten().map(|e| size(&e.path())).sum()).unwrap_or(0),
                Ok(m) => m.len(),
                Err(_) => 0,
            }
        }
        let data = self.vaults.db()?.local(|c| {
            c.query_row(
                "SELECT (SELECT COALESCE(SUM(length(vec)), 0) FROM intel_clip)
                      + (SELECT COALESCE(SUM(length(vec)) + COUNT(*) * 48, 0) FROM intel_face)
                      + (SELECT COALESCE(SUM(length(text)) * 2, 0) FROM intel_text)
                      + (SELECT COUNT(*) * 64 FROM intel_done)",
                [],
                |r| r.get::<_, i64>(0),
            )
        })?;
        Ok(Usage { models: size(&self.models.dir), data })
    }

    /// "Apagar e refazer": tira os resultados deste vault (não os modelos) e a
    /// análise recomeça. Nomes de pessoas voltam pelas âncoras.
    pub fn reset(&self) -> Result<(), String> {
        self.vaults.db()?.local(|c| {
            c.execute_batch(
                "DELETE FROM intel_done; DELETE FROM intel_place; DELETE FROM intel_hash; DELETE FROM intel_clip; DELETE FROM intel_clip_frame;
                 DELETE FROM intel_tag; DELETE FROM intel_text; DELETE FROM intel_fts; DELETE FROM intel_face;
                 DELETE FROM review_no; DELETE FROM person WHERE uid NOT IN (SELECT uid FROM person_sync);
                 DELETE FROM intel_packed;
                 UPDATE person SET cover_face = NULL;",
            )
        })?;
        *self.face_index.lock().unwrap() = None;
        *self.vectors.lock().unwrap() = None;
        self.wake.notify_one();
        Ok(())
    }

    /// Importa um pacote de análise de outro aparelho, se houver. `Some` = fez algo.
    async fn import_pack(&self, db: &Arc<Db>) -> Option<Duration> {
        if !self.vaults.net().online() || !self.gov.may_download() {
            return None;
        }
        let failed: Vec<String> = {
            let mut f = self.pack_failed.lock().unwrap();
            f.retain(|_, t| t.elapsed() < Duration::from_secs(600));
            f.keys().cloned().collect()
        };
        let (uid, row): (String, String) = db
            .local(|c| {
                c.query_row(
                    "SELECT uid, row FROM intel_pack WHERE imported = 0 AND uid NOT IN (SELECT value FROM json_each(?1)) ORDER BY uid LIMIT 1",
                    [serde_json::to_string(&failed).unwrap_or_default()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
            })
            .ok()
            .flatten()?;
        *self.running.lock().unwrap() = Some("pack-in");
        let Ok(pack) = serde_json::from_str::<packs::PackRow>(&row) else {
            let _ = db.local(|c| c.execute("UPDATE intel_pack SET imported = 2 WHERE uid = ?1", [&uid]));
            return Some(Duration::from_millis(200));
        };
        let bytes = match self.tg.read_blob(pack.piece.msg_id, pack.piece.size).await {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[intel] pacote {uid}: {e}");
                self.pack_failed.lock().unwrap().insert(uid, Instant::now());
                return Some(Duration::from_secs(5));
            }
        };
        let d = Arc::clone(db);
        let res = tauri::async_runtime::spawn_blocking(move || {
            let (n, faces) = d.local(|c| Ok(packs::import(c, &bytes))).map_err(|e| e.to_string())??;
            // Rostos que outro aparelho já decidiu (âncoras): vale a decisão.
            d.local(|c| {
                for (id, media, b, _) in &faces {
                    match people::anchored(c, media, *b)? {
                        Some((p, false)) => {
                            c.execute("UPDATE intel_face SET person_uid = ?2, manual = 1 WHERE id = ?1", params![id, p])?;
                        }
                        Some((p, true)) => {
                            c.execute("UPDATE intel_face SET rejected = ?2, manual = 1 WHERE id = ?1", params![id, p])?;
                        }
                        None => {}
                    }
                }
                Ok(())
            })?;
            Ok::<_, String>((n, faces.len()))
        })
        .await;
        match res {
            Ok(Ok((n, f))) => {
                eprintln!("[intel] pacote importado: {n} mídias, {f} rostos");
                let _ = db.local(|c| c.execute("UPDATE intel_pack SET imported = 1 WHERE uid = ?1", [&uid]));
                *self.vectors.lock().unwrap() = None;
                *self.face_index.lock().unwrap() = None;
                if f > 0 {
                    self.faces_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
            Ok(Err(e)) => {
                eprintln!("[intel] pacote {uid}: {e}");
                let _ = db.local(|c| c.execute("UPDATE intel_pack SET imported = 2 WHERE uid = ?1", [&uid]));
            }
            Err(e) => eprintln!("[intel] pacote {uid}: {e}"),
        }
        Some(Duration::from_millis(500))
    }

    /// Envia um pacote com o que este aparelho analisou e ainda não foi a
    /// nenhum, no máximo um a cada `PACK_EVERY`. `Some` = enviou.
    async fn send_pack(&self, db: &Arc<Db>, s: &Settings) -> Option<Duration> {
        if !s.share || !self.gov.may_download() {
            return None;
        }
        let pending = db.local(|c| packs::pending(c, s.share_faces)).ok()?;
        // Cada pacote é uma mensagem no canal: um retrato a cada tanto tempo.
        let last = *self.last_pack.lock().unwrap();
        let due = pending > 0 && last.map_or(true, |t| t.elapsed() >= PACK_EVERY);
        if !due || !self.may_upload() {
            return None;
        }
        *self.running.lock().unwrap() = Some("pack-out");
        let faces = s.share_faces;
        let d = Arc::clone(db);
        let built = tauri::async_runtime::spawn_blocking(move || d.local(|c| packs::build(c, faces))).await.ok()?.ok()??;
        let (bytes, models, covered, n) = built;
        *self.last_pack.lock().unwrap() = Some(Instant::now());
        let piece = match self.tg.send_blob(bytes, "").await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[intel] enviar pacote: {e}");
                self.upload_failed(&e);
                return None;
            }
        };
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default();
        match db.emit_pack(&packs::PackRow { piece, n, models, at }, &covered) {
            Ok(()) => eprintln!("[intel] pacote enviado: {n} mídias"),
            Err(e) => {
                eprintln!("[intel] registrar pacote: {e}");
                let _ = self.tg.delete(&[piece.msg_id]).await;
            }
        }
        Some(UPLOAD_GAP)
    }

    /// Mudou alguma pessoa à mão: o índice em memória relê do banco.
    pub fn people_changed(&self) {
        *self.face_index.lock().unwrap() = None;
    }

    /// Recorte quadrado do rosto (160 px) a partir da miniatura, para avatares.
    /// Identidade do rosto para o cache (o id é só deste vault e volta a ser
    /// usado depois de "Apagar e refazer"): vault + foto + posição.
    pub fn face_key(&self, face: i64) -> Result<String, String> {
        let vault = self.vaults.current().map(|o| o.id()).unwrap_or_default();
        let (uid, x, y): (String, f32, f32) =
            self.vaults.db()?.local(|c| c.query_row("SELECT media_uid, x, y FROM intel_face WHERE id = ?1", [face], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))))?;
        Ok(format!("\"{vault}-{uid}-{:.4}-{:.4}\"", x, y))
    }

    pub async fn face_crop(&self, face: i64) -> Result<Vec<u8>, String> {
        let db = self.vaults.db()?;
        let (uid, x, y, w, h, id, frame): (String, f32, f32, f32, f32, i64, Option<i64>) = db.local(|c| {
            c.query_row("SELECT f.media_uid, f.x, f.y, f.w, f.h, m.id, f.frame FROM intel_face f JOIN media m ON m.uid = f.media_uid WHERE f.id = ?1", [face], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })
        })?;
        // Rosto achado num quadro da tira: recorta daquele quadro.
        let jpeg = match frame {
            Some(i) => self.frames(&db, &uid).await?.and_then(|mut f| (i >= 0 && (i as usize) < f.len()).then(|| f.swap_remove(i as usize))).ok_or("quadro do vídeo indisponível")?,
            None => self.thumb(&db, &Item { id, uid, lat: None, lon: None }).await?,
        };
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
    fn vectors(&self, db: &Db, model: &str) -> Result<Vectors, String> {
        let n: i64 = db.local(|c| {
            c.query_row("SELECT (SELECT COUNT(*) FROM intel_clip WHERE model = ?1) + (SELECT COUNT(*) FROM intel_clip_frame)", [model], |r| r.get(0))
        })?;
        if let Some((count, v)) = self.vectors.lock().unwrap().as_ref() {
            if *count == n {
                return Ok(Arc::clone(v));
            }
        }
        let list = db.local(|c| {
            // Vídeo com tira: os vetores dos quadros também (a busca fica com o melhor).
            let mut st = c.prepare(
                "SELECT m.id, k.vec FROM intel_clip k JOIN media m ON m.uid = k.media_uid WHERE k.model = ?1 AND m.trashed_at IS NULL
                 UNION ALL
                 SELECT m.id, f.vec FROM intel_clip_frame f JOIN intel_clip k ON k.media_uid = f.media_uid JOIN media m ON m.uid = f.media_uid
                 WHERE k.model = ?1 AND m.trashed_at IS NULL",
            )?;
            let rows = st.query_map([model], |r| Ok((r.get::<_, i64>(0)?, clip::from_blob(&r.get::<_, Vec<u8>>(1)?))))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })?;
        let list = Arc::new(list);
        *self.vectors.lock().unwrap() = Some((n, Arc::clone(&list)));
        Ok(list)
    }

    /// O original, se foi enviado deste computador e o arquivo ainda está lá
    /// (Android: o endereço é do MediaStore, não legível daqui; fica a miniatura).
    /// Envios da inteligência ao canal (miniaturas, pacotes): um por vez, com
    /// intervalo mínimo, nunca durante a pausa pedida pelo Telegram
    /// (FLOOD_WAIT) e só com rede. Marca o próximo horário livre.
    fn may_upload(&self) -> bool {
        let net = self.vaults.net();
        if !self.vaults.can_write() || !net.online() || net.flood_until().is_some() {
            return false;
        }
        let mut next = self.next_upload.lock().unwrap();
        if Instant::now() < *next {
            return false;
        }
        *next = Instant::now() + UPLOAD_GAP;
        true
    }

    /// Erro de um envio: FLOOD_WAIT vira pausa de todos os envios (tg-app);
    /// queda de rede marca offline.
    fn upload_failed(&self, e: &str) {
        let net = self.vaults.net();
        if !net.flood(e) {
            net.report(e);
        }
    }

    /// Sobe ao vault a miniatura de uma foto enviada daqui que ainda não tem
    /// (os outros aparelhos precisam dela). A análise daqui não depende disto.
    async fn share_thumb(&self, db: &Arc<Db>) -> Option<Duration> {
        if !self.may_upload() {
            return None;
        }
        let failed = serde_json::to_string(&*self.thumb_failed.lock().unwrap()).unwrap_or_else(|_| "[]".into());
        let (id, uid): (i64, String) = db
            .local(|c| {
                c.query_row(
                    "SELECT m.id, m.uid FROM media m JOIN backup_done b ON b.media_uid = m.uid
                     WHERE m.thumb IS NULL AND m.trashed_at IS NULL AND m.mime LIKE 'image/%'
                       AND m.id NOT IN (SELECT value FROM json_each(?1))
                     ORDER BY m.taken_at DESC LIMIT 1",
                    [failed],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
            })
            .ok()
            .flatten()?;
        let fail = |e: String| {
            eprintln!("[intel] miniatura {uid}: {e}");
            self.thumb_failed.lock().unwrap().insert(id);
            Some(Duration::from_millis(200))
        };
        // A da análise, se já foi feita (cache); senão, do original.
        let cached = self.thumbs.join(format!("{uid}.jpg"));
        let jpeg = match tokio::fs::read(&cached).await {
            Ok(j) => j,
            Err(_) => {
                let Some(bytes) = self.local_original(db, &uid).await else { return fail("original fora do aparelho".into()) };
                match tauri::async_runtime::spawn_blocking(move || tg_app::routes::render_thumb(&bytes)).await {
                    Ok(Ok(j)) => j,
                    Ok(Err(e)) => return fail(e),
                    Err(e) => return fail(e.to_string()),
                }
            }
        };
        // Outro aparelho pode ter feito enquanto isso.
        if tg_app::Library::thumb(&**db, id).is_some() {
            return Some(Duration::from_millis(100));
        }
        let piece = match self.tg.send_blob(jpeg.clone(), "").await {
            Ok(p) => p,
            Err(e) => {
                self.upload_failed(&e);
                return Some(UPLOAD_GAP);
            }
        };
        if let Err(e) = db.set_thumb(id, piece, None) {
            let _ = self.tg.delete(&[piece.msg_id]).await;
            return fail(e);
        }
        let _ = tokio::fs::create_dir_all(&self.thumbs).await;
        let _ = tokio::fs::write(&cached, &jpeg).await;
        // O próximo só depois do intervalo (a fila de análise vem antes).
        Some(UPLOAD_GAP)
    }

    /// Próximo vídeo para o trabalhador de tiras da interface, se agora é
    /// hora: análise ligada, energia permitindo (e a pessoa sem usar o app), o
    /// envio liberado. Primeiro os vídeos com original no aparelho (sem rede);
    /// os outros só fora da rede medida (baixam trechos do vídeo).
    pub fn frames_next(&self) -> Option<FramesJob> {
        let s = self.settings();
        if !(s.search || s.people || s.text || s.duplicates) || self.gov.hold(&s, Weight::Heavy).is_some() {
            return None;
        }
        let net = self.vaults.net();
        if !self.vaults.can_write() || !net.online() || net.flood_until().is_some() || Instant::now() < *self.next_upload.lock().unwrap() {
            return None;
        }
        let db = self.vaults.db().ok()?;
        let failed = serde_json::to_string(&*self.frames_failed.lock().unwrap()).unwrap_or_else(|_| "[]".into());
        let remote = self.gov.may_download();
        db.local(|c| {
            c.query_row(
                "SELECT m.id, EXISTS (SELECT 1 FROM backup_done b WHERE b.media_uid = m.uid) AS here, m.duration FROM media m
                 WHERE m.mime LIKE 'video/%' AND m.trashed_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM frames f WHERE f.media_uid = m.uid)
                   AND m.id NOT IN (SELECT value FROM json_each(?1))
                   AND (?2 OR here)
                 ORDER BY here DESC, m.taken_at DESC LIMIT 1",
                params![failed, remote],
                |r| Ok(FramesJob { id: r.get(0)?, local: r.get(1)?, duration: r.get(2)? }),
            )
            .optional()
        })
        .ok()
        .flatten()
    }

    /// A interface não conseguiu tirar os quadros: não tenta de novo nesta execução.
    pub fn frames_fail(&self, id: i64) {
        self.frames_failed.lock().unwrap().insert(id);
    }

    /// Tira pronta (vinda da interface): sobe ao vault e registra. `Err(None)`
    /// = agora não pode enviar (intervalo, pausa do Telegram): tentar depois.
    pub async fn frames_put(&self, id: i64, jpeg: Vec<u8>, w: u32, h: u32, times: Vec<f32>) -> Result<(), Option<String>> {
        let db = self.vaults.db().map_err(Some)?;
        let uid = db.uid(id).ok_or_else(|| Some("mídia não encontrada".to_string()))?;
        if let Err(e) = frames::check(&jpeg, w, h, times.len()) {
            self.frames_fail(id);
            return Err(Some(e));
        }
        if db.frames_of(&uid).is_some() {
            return Ok(());
        }
        if !self.may_upload() {
            return Err(None);
        }
        let piece = match self.tg.send_blob(jpeg.clone(), "").await {
            Ok(p) => p,
            Err(e) => {
                self.upload_failed(&e);
                return Err(None);
            }
        };
        let _ = tokio::fs::create_dir_all(&self.thumbs).await;
        let _ = tokio::fs::write(self.thumbs.join(format!("{uid}.frames.jpg")), &jpeg).await;
        if let Err(e) = db.emit_frames(&uid, &frames::FramesRow { piece, w, h, times }) {
            let _ = self.tg.delete(&[piece.msg_id]).await;
            return Err(Some(e));
        }
        eprintln!("[intel] tira de quadros enviada: {uid}");
        Ok(())
    }

    async fn local_original(&self, db: &Db, uid: &str) -> Option<Vec<u8>> {
        let src: String = db.local(|c| c.query_row("SELECT src FROM backup_done WHERE media_uid = ?1", [uid], |r| r.get(0)).optional()).ok().flatten()?;
        if src.starts_with("content://") {
            // Android: pelo plugin de arquivos (a permissão é a do backup).
            let handle = self.handle.get()?.clone();
            return tauri::async_runtime::spawn_blocking(move || {
                use std::io::Read;
                let file = tg_app::transfers::open_local(&handle, &src).ok()?;
                let mut out = Vec::new();
                file.take(40 * 1024 * 1024 + 1).read_to_end(&mut out).ok()?;
                (out.len() <= 40 * 1024 * 1024).then_some(out)
            })
            .await
            .ok()
            .flatten();
        }
        let meta = tokio::fs::metadata(&src).await.ok()?;
        // Original grande demais não vale a leitura (o detector reduz para 960 px).
        if meta.len() > 40 * 1024 * 1024 {
            return None;
        }
        tokio::fs::read(&src).await.ok()
    }

    /// A tira de quadros do vídeo (JPEG) e a linha dela: do cache em disco;
    /// sem ele, do canal (com rede). `None` = o vídeo não tem tira.
    async fn strip(&self, db: &Db, uid: &str) -> Result<Option<(Vec<u8>, frames::FramesRow)>, String> {
        let Some(row) = db.frames_of(uid) else { return Ok(None) };
        let path = self.thumbs.join(format!("{uid}.frames.jpg"));
        if let Ok(b) = tokio::fs::read(&path).await {
            return Ok(Some((b, row)));
        }
        if !self.vaults.net().online() || !self.gov.may_download() {
            return Err("tira de quadros fora do cache e sem rede".into());
        }
        let bytes = self.tg.read_blob(row.piece.msg_id, row.piece.size).await?;
        let _ = tokio::fs::create_dir_all(&self.thumbs).await;
        let _ = tokio::fs::write(&path, &bytes).await;
        Ok(Some((bytes, row)))
    }

    /// Os quadros da tira, um JPEG cada. `None` = o vídeo não tem tira.
    async fn frames(&self, db: &Db, uid: &str) -> Result<Option<Vec<Vec<u8>>>, String> {
        let Some((jpeg, row)) = self.strip(db, uid).await? else { return Ok(None) };
        let list = tauri::async_runtime::spawn_blocking(move || frames::split(&jpeg, row.w, row.h)).await.map_err(|e| e.to_string())??;
        Ok((!list.is_empty()).then_some(list))
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
        // Sem miniatura no vault: do original deste aparelho, só no cache local
        // (subir para o vault é outra coisa, com calma: `share_thumb`).
        if tg_app::Library::thumb(db, item.id).is_none() {
            let bytes = self.local_original(db, &item.uid).await.ok_or("sem miniatura e sem o original aqui")?;
            let jpeg = tauri::async_runtime::spawn_blocking(move || tg_app::routes::render_thumb(&bytes)).await.map_err(|e| e.to_string())??;
            let _ = tokio::fs::create_dir_all(&self.thumbs).await;
            let _ = tokio::fs::write(&path, &jpeg).await;
            return Ok(jpeg);
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

/// O que a busca entendeu do texto e os filtros em SQL (sem a descrição).
pub(crate) struct Plan {
    chips: Vec<query::Chip>,
    where_: Vec<String>,
    args: Vec<rusqlite::types::Value>,
    /// O que sobrou para nomes, texto lido e descrição.
    pub(crate) rest: String,
}

pub(crate) fn plan(db: &Db, text: &str, album: Option<i64>) -> Result<Plan, String> {
    use rusqlite::types::Value;
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
                let text = words.drain(at..at + kw.len()).collect::<Vec<_>>().join(" ");
                where_.push(format!("m.uid IN (SELECT media_uid FROM intel_place WHERE {col} = ?)"));
                args.push(Value::Text(name.clone()));
                p.chips.push(query::Chip { kind: "place", label: name, text });
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
                let text = words.drain(at..at + kw.len()).collect::<Vec<_>>().join(" ");
                where_.push("m.uid IN (SELECT media_uid FROM intel_face WHERE person_uid = ?)".into());
                args.push(Value::Text(uid));
                p.chips.push(query::Chip { kind: "person", label: name, text });
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

    Ok(Plan { chips: p.chips, where_, args, rest: p.rest.trim().to_string() })
}

/// Executa o plano: sem texto livre, só os filtros por data; com texto, nome
/// (10) > texto lido (5) > descrição (a nota do modelo, até metade da melhor).
/// Quanto o nome do arquivo ou o texto lido somam à semelhança (SigLIP2: as
/// semelhanças ficam em torno de -0,1 a 0,2; isto só desempata).
const LITERAL_NUDGE: f32 = 0.015;

pub(crate) fn run(db: &Db, plan: Plan, found: Vec<(i64, f32)>, semantic: bool) -> Result<SearchResult, String> {
    use rusqlite::types::Value;
    let Plan { chips, mut where_, mut args, rest } = plan;
    if rest.is_empty() {
        let sql = format!("SELECT {} FROM media m WHERE {} ORDER BY m.taken_at DESC LIMIT 5000", crate::db::COLS_M, where_.join(" AND "));
        let items = db.query(&sql, rusqlite::params_from_iter(args))?;
        return Ok(SearchResult { items, chips, semantic: false, semantic_state: None });
    }
    // Nome do arquivo e texto lido (OCR).
    let mut literal: Vec<i64> = db.search(&rest, 500)?.into_iter().map(|m| m.id).collect();
    // A expressão inteira, na ordem ("pôr do sol"), não cada palavra solta:
    // "por", "do" e "sol" aparecem em qualquer texto.
    let words: Vec<String> = rest.split_whitespace().map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>()).filter(|w| !w.is_empty()).collect();
    let fts = if words.is_empty() { String::new() } else { format!("\"{}\"*", words.join(" ")) };
    if !fts.is_empty() {
        literal.extend(
            db.local(|c| {
                let mut st = c.prepare("SELECT m.id FROM intel_fts f JOIN media m ON m.uid = f.media_uid WHERE intel_fts MATCH ?1 LIMIT 500")?;
                let rows = st.query_map([&fts], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<Vec<i64>>>()
            })
            .unwrap_or_default(),
        );
    }
    let mut score: std::collections::HashMap<i64, f32> = std::collections::HashMap::new();
    if semantic && !found.is_empty() {
        // Como o Immich: ordem pela semelhança entre o texto e a imagem, sem
        // corte. Nome e texto lido só desempatam (um empurrão pequeno), nunca
        // passam na frente de uma foto que de fato mostra o que foi descrito.
        for (id, s) in &found {
            score.insert(*id, *s);
        }
        let floor = found.last().map(|x| x.1).unwrap_or(0.0);
        for id in literal {
            let base = score.get(&id).copied().unwrap_or(floor);
            score.insert(id, base + LITERAL_NUDGE);
        }
    } else {
        // Sem a busca por descrição: nome do arquivo primeiro, depois o texto lido.
        for (k, id) in literal.into_iter().enumerate() {
            score.entry(id).or_insert(1.0 / (1.0 + k as f32));
        }
    }
    let ids: Vec<i64> = score.keys().copied().collect();
    where_.push("m.id IN (SELECT value FROM json_each(?))".into());
    args.push(Value::Text(serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into())));
    let sql = format!("SELECT {} FROM media m WHERE {}", crate::db::COLS_M, where_.join(" AND "));
    let mut items = db.query(&sql, rusqlite::params_from_iter(args))?;
    items.sort_by(|a, b| score.get(&b.id).unwrap_or(&0.0).total_cmp(score.get(&a.id).unwrap_or(&0.0)).then(b.taken_at.total_cmp(&a.taken_at)));
    // Por semelhança não há corte (como no Immich), mas o fim da lista já é
    // ruído: as mais parecidas bastam.
    items.truncate(if semantic { 300 } else { 600 });
    Ok(SearchResult { items, chips, semantic, semantic_state: None })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tg_core::hlc::Clock;

    fn db() -> Db {
        let dir = std::env::temp_dir().join(format!("tgphotos-intel-{}", ulid::Ulid::new()));
        Db::open(&dir.join("t.db"), Arc::new(Clock::new("t"))).unwrap()
    }

    #[test]
    fn buscas_sem_modelo() {
        let d = db();
        let m = crate::meta::Meta { taken: Some(1_680_000_000_000), ..Default::default() };
        let a = d.insert("praia.jpg", "image/jpeg", 10, &[tg_core::Piece::new(1, 10)], Some("s1"), &m, None).unwrap();
        d.insert("video.mp4", "video/mp4", 10, &[tg_core::Piece::new(2, 10)], Some("s2"), &m, None).unwrap();
        d.local(|c| c.execute("INSERT INTO intel_place (media_uid, city, state, country) VALUES (?1, 'Salvador', 'Bahia', 'Brasil')", [&a.uid])).unwrap();
        d.local(|c| c.execute("INSERT INTO intel_fts (media_uid, text) VALUES (?1, 'Padaria São João')", [&a.uid])).unwrap();
        for (q, n) in [("praia", 1), ("salvador", 1), ("2023", 2), ("vídeos", 1), ("padaria", 1), ("março de 2023 fotos", 1), ("qualquer coisa", 0), ("", 2), ("a", 1)] {
            let r = run(&d, plan(&d, q, None).unwrap(), Vec::new(), false).unwrap_or_else(|e| panic!("{q:?}: {e}"));
            assert_eq!(r.items.len(), n, "{q:?} → {:?}", r.items.iter().map(|m| &m.name).collect::<Vec<_>>());
        }
    }
}
