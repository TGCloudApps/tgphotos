//! Governador de energia: antes de cada item, diz se pode rodar e quanto
//! descansar depois. Economia acima de velocidade (docs/inteligencia-de-midia.md §3.3).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Quanto custa uma etapa: as leves (lugares, hash) rodam com bateria mesmo
/// abaixo do limite; as pesadas (modelos) seguem o modo.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Weight {
    Light,
    Heavy,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Roda também na bateria (acima do limite), acelera carregando.
    #[default]
    Auto,
    /// Só com o carregador ligado.
    Charging,
    Paused,
}

/// Estado do aparelho, informado pela interface (Android: ponte; desktop: padrão "na tomada").
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Power {
    pub charging: bool,
    /// 0–100.
    pub battery: u8,
    /// Modo economia do sistema.
    #[serde(default)]
    pub saver: bool,
    /// Android `PowerManager.getThermalStatus`: 0 nenhum … 6 desligando. ≥ 2 (moderado) pausa.
    #[serde(default)]
    pub thermal: u8,
    /// Rede medida (dados móveis): nada de baixar modelo nem mídia.
    #[serde(default)]
    pub metered: bool,
}

impl Default for Power {
    fn default() -> Self {
        Self { charging: true, battery: 100, saver: false, thermal: 0, metered: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub mode: Mode,
    /// Abaixo disso (sem carregar), as etapas pesadas param.
    pub min_battery: u8,
    /// Fração de um núcleo ao longo do tempo (0.1–1.0).
    pub budget: f32,
    pub search: bool,
    pub people: bool,
    pub text: bool,
    pub places: bool,
    pub duplicates: bool,
    /// Miniaturas que faltam (fotos e vídeos) e tiras de quadros dos vídeos:
    /// vêm antes da análise.
    #[serde(alias = "frames")]
    pub thumbs: bool,
    /// Envia o que foi analisado aqui para os outros aparelhos (pacotes no vault).
    pub share: bool,
    /// Inclui os dados de rosto nos pacotes (no vault não cifrado, ficam legíveis no canal).
    pub share_faces: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { mode: Mode::Auto, min_battery: 30, budget: 0.3, search: true, people: true, text: true, places: true, duplicates: true, thumbs: true, share: true, share_faces: true }
    }
}

/// Por que não está rodando (a interface mostra).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Hold {
    Paused,
    NotCharging,
    LowBattery,
    Saver,
    Hot,
    InUse,
}

pub struct Governor {
    pub power: Mutex<Power>,
    /// A pessoa está rolando a grade / vendo vídeo: pausa um pouco.
    busy_until: Mutex<Instant>,
    /// "Processar agora": ignora bateria e modo (não a temperatura) até lá.
    rush_until: Mutex<Option<Instant>>,
}

impl Default for Governor {
    fn default() -> Self {
        Self { power: Mutex::new(Power::default()), busy_until: Mutex::new(Instant::now()), rush_until: Mutex::new(None) }
    }
}

impl Governor {
    pub fn set_power(&self, p: Power) {
        *self.power.lock().unwrap() = p;
    }

    /// A interface está em uso pesado (rolagem, vídeo): pausa por alguns segundos.
    pub fn touch(&self) {
        *self.busy_until.lock().unwrap() = Instant::now() + Duration::from_secs(8);
    }

    pub fn rush(&self, on: bool) {
        *self.rush_until.lock().unwrap() = on.then(|| Instant::now() + Duration::from_secs(3600));
    }

    pub fn rushing(&self) -> bool {
        self.rush_until.lock().unwrap().is_some_and(|t| t > Instant::now())
    }

    /// Pode rodar uma etapa deste peso agora? `None` = pode.
    pub fn hold(&self, s: &Settings, weight: Weight) -> Option<Hold> {
        let p = *self.power.lock().unwrap();
        if p.thermal >= 2 {
            return Some(Hold::Hot);
        }
        if *self.busy_until.lock().unwrap() > Instant::now() {
            return Some(Hold::InUse);
        }
        if self.rushing() {
            return None;
        }
        match s.mode {
            Mode::Paused => return Some(Hold::Paused),
            Mode::Charging if !p.charging => return Some(Hold::NotCharging),
            _ => {}
        }
        if weight == Weight::Heavy && !p.charging {
            if p.saver {
                return Some(Hold::Saver);
            }
            if p.battery < s.min_battery {
                return Some(Hold::LowBattery);
            }
        }
        None
    }

    /// Descanso depois de um item que levou `took`: mantém o uso médio no
    /// orçamento. Carregando (ou "processar agora"), o orçamento dobra.
    pub fn rest(&self, s: &Settings, took: Duration) -> Duration {
        let p = *self.power.lock().unwrap();
        let mut budget = s.budget.clamp(0.05, 1.0);
        if p.charging || self.rushing() {
            budget = (budget * 2.0).min(1.0);
        }
        let rest = took.mul_f32((1.0 - budget) / budget);
        rest.max(Duration::from_millis(20))
    }

    pub fn may_download(&self) -> bool {
        !self.power.lock().unwrap().metered
    }
}
