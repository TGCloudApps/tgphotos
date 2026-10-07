//! Modelos da inteligência de mídia: vêm do vault público do TGDrive
//! (`@TGCloudOpenVault`, pasta `modelos/`), são baixados sob demanda e
//! conferidos pelo SHA-256 do `modelo.json`. Ficam em `<dados>/modelos/<nome>/<versão>/`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tg_app::public_vault::PublicVault;
use tg_core::Telegram;

/// @ do canal público (vault do TGDrive) com os modelos.
pub const CHANNEL: &str = "TGCloudOpenVault";
const ROOT: &str = "modelos";

#[derive(Deserialize, Clone, Debug)]
struct Entry {
    nome: String,
    versao: u32,
}

#[derive(Deserialize, Clone, Debug)]
struct Catalog {
    modelos: Vec<Entry>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct FileMeta {
    pub nome: String,
    pub tamanho: u64,
    pub sha256: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ModelMeta {
    pub nome: String,
    pub versao: u32,
    pub arquivos: Vec<FileMeta>,
    /// O resto do `modelo.json` (dimensão, tamanho da imagem…), por modelo.
    #[serde(flatten)]
    pub info: serde_json::Map<String, serde_json::Value>,
}

/// Um modelo pronto no disco.
#[derive(Clone, Debug)]
pub struct Model {
    pub meta: ModelMeta,
    pub dir: PathBuf,
}

impl Model {
    pub fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Identidade gravada em `intel_done.model` (trocar de versão = refazer).
    pub fn id(&self) -> String {
        format!("{}@{}", self.meta.nome, self.meta.versao)
    }
}

/// Estado de um modelo para a interface.
#[derive(Serialize, Clone, Debug)]
pub struct ModelState {
    pub name: String,
    /// absent | downloading | ready | failed
    pub state: &'static str,
    pub done: u64,
    pub size: u64,
    pub error: Option<String>,
}

pub struct Models {
    vault: PublicVault,
    pub(crate) dir: PathBuf,
    ready: Mutex<HashMap<String, Arc<Model>>>,
    progress: Mutex<HashMap<String, ModelState>>,
    /// Um download por vez.
    gate: tokio::sync::Mutex<()>,
    /// Falhou há pouco: não tenta de novo sozinho por um tempo (a pessoa pode pedir).
    failed_at: Mutex<HashMap<String, std::time::Instant>>,
}

/// Depois de uma falha, espera isso antes de tentar baixar de novo sozinho.
const RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(600);

impl Models {
    pub fn new(tg: Arc<Telegram>, data_dir: &Path) -> Self {
        Self {
            vault: PublicVault::new(tg, CHANNEL),
            dir: data_dir.join("modelos"),
            ready: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            gate: tokio::sync::Mutex::new(()),
            failed_at: Mutex::new(HashMap::new()),
        }
    }

    /// Estado de um modelo para a interface (sem nada ainda: "absent").
    pub fn state(&self, name: &str) -> ModelState {
        if self.installed(name).is_some() {
            return ModelState { name: name.into(), state: "ready", done: 0, size: 0, error: None };
        }
        self.progress.lock().unwrap().get(name).cloned().unwrap_or(ModelState { name: name.into(), state: "absent", done: 0, size: 0, error: None })
    }

    /// "Tentar de novo": esquece as falhas recentes.
    pub fn retry(&self) {
        self.failed_at.lock().unwrap().clear();
        self.progress.lock().unwrap().retain(|_, s| s.state != "failed");
    }

    fn set(&self, s: ModelState) {
        self.progress.lock().unwrap().insert(s.name.clone(), s);
    }

    /// Versão já instalada (sem rede), se houver: offline-first.
    fn installed(&self, name: &str) -> Option<Arc<Model>> {
        if let Some(m) = self.ready.lock().unwrap().get(name) {
            return Some(Arc::clone(m));
        }
        let mut versions: Vec<u32> = std::fs::read_dir(self.dir.join(name)).ok()?.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok()).collect();
        versions.sort_unstable();
        for v in versions.into_iter().rev() {
            let dir = self.dir.join(name).join(v.to_string());
            let Ok(raw) = std::fs::read(dir.join("modelo.json")) else { continue };
            let Ok(meta) = serde_json::from_slice::<ModelMeta>(&raw) else { continue };
            // Instalado = todos os arquivos com o tamanho certo (o hash foi conferido ao baixar).
            if meta.arquivos.iter().all(|f| std::fs::metadata(dir.join(&f.nome)).map(|m| m.len() == f.tamanho).unwrap_or(false)) {
                let m = Arc::new(Model { meta, dir });
                self.ready.lock().unwrap().insert(name.to_string(), Arc::clone(&m));
                self.set(ModelState { name: name.into(), state: "ready", done: 0, size: 0, error: None });
                return Some(m);
            }
        }
        None
    }

    /// O modelo, baixando se preciso (`may_download` falso: só o instalado).
    pub async fn get(&self, name: &str, may_download: bool) -> Option<Arc<Model>> {
        if let Some(m) = self.installed(name) {
            return Some(m);
        }
        if !may_download {
            return None;
        }
        if self.failed_at.lock().unwrap().get(name).is_some_and(|t| t.elapsed() < RETRY_AFTER) {
            return None;
        }
        let _one = self.gate.lock().await;
        if let Some(m) = self.installed(name) {
            return Some(m);
        }
        match self.download(name).await {
            Ok(m) => Some(m),
            Err(e) => {
                eprintln!("[intel] modelo {name}: {e}");
                self.failed_at.lock().unwrap().insert(name.to_string(), std::time::Instant::now());
                self.set(ModelState { name: name.into(), state: "failed", done: 0, size: 0, error: Some(e) });
                None
            }
        }
    }

    async fn download(&self, name: &str) -> tg_core::Result<Arc<Model>> {
        let files = self.vault.files().await?;
        let find = |path: &str| files.iter().find(|f| f.path.trim_start_matches('/') == path || f.path.ends_with(&format!("/{path}")) || f.path == path).cloned();
        let cat_file = find(&format!("{ROOT}/catalogo.json")).ok_or("catálogo de modelos não encontrado")?;
        let tmp = self.dir.join(".tmp");
        tokio::fs::create_dir_all(&tmp).await.map_err(|e| e.to_string())?;
        let cat_path = tmp.join("catalogo.json");
        self.vault.download(&cat_file, &cat_path, |_| {}).await?;
        let cat: Catalog = serde_json::from_slice(&tokio::fs::read(&cat_path).await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let entry = cat.modelos.iter().find(|m| m.nome == name).ok_or_else(|| format!("{name} não está no catálogo"))?;
        let base = format!("{ROOT}/{name}/{}", entry.versao);
        let dir = self.dir.join(name).join(entry.versao.to_string());
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let meta_file = find(&format!("{base}/modelo.json")).ok_or("modelo.json não encontrado")?;
        let meta_tmp = tmp.join(format!("{name}.json"));
        self.vault.download(&meta_file, &meta_tmp, |_| {}).await?;
        let meta: ModelMeta = serde_json::from_slice(&tokio::fs::read(&meta_tmp).await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let size: u64 = meta.arquivos.iter().map(|f| f.tamanho).sum();
        let mut done = 0u64;
        for f in &meta.arquivos {
            let dest = dir.join(&f.nome);
            if std::fs::metadata(&dest).map(|m| m.len() == f.tamanho).unwrap_or(false) {
                done += f.tamanho;
                continue;
            }
            let src = find(&format!("{base}/{}", f.nome)).ok_or_else(|| format!("{} não encontrado no vault", f.nome))?;
            let base_done = done;
            self.vault
                .download(&src, &dest, |n| self.set(ModelState { name: name.into(), state: "downloading", done: base_done + n, size, error: None }))
                .await?;
            let hash = hash_file(&dest).await?;
            if hash != f.sha256 {
                let _ = tokio::fs::remove_file(&dest).await;
                return Err(format!("{}: conteúdo diferente do esperado", f.nome));
            }
            done += f.tamanho;
        }
        // Por último: o modelo.json marca a pasta como completa.
        tokio::fs::rename(&meta_tmp, dir.join("modelo.json")).await.map_err(|e| e.to_string())?;
        let m = Arc::new(Model { meta, dir });
        self.ready.lock().unwrap().insert(name.to_string(), Arc::clone(&m));
        self.set(ModelState { name: name.into(), state: "ready", done: size, size, error: None });
        Ok(m)
    }
}

async fn hash_file(p: &Path) -> tg_core::Result<String> {
    let p = p.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || -> tg_core::Result<String> {
        use std::io::Read;
        let mut f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
