//! Busca inteligente: SigLIP2 ViT-B/32 multilíngue (o do Immich), quantizado.
//! A imagem (miniatura de 480 px, esticada para 256×256) vira um vetor de 768;
//! o texto da busca, outro; a semelhança é o produto escalar dos dois
//! normalizados. Busca em português direto.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};

use super::models::Model;

pub const DIM: usize = 768;
const SIZE: u32 = 256;
const CONTEXT: usize = 64;

/// Sessão do ONNX com pouco paralelismo (economia acima de velocidade).
pub fn session(path: &Path, threads: usize) -> Result<Session, String> {
    let e = |e: ort::Error| e.to_string();
    Session::builder()
        .map_err(e)?
        // `All` (ORT_ENABLE_ALL): no ort rc.13, Level3 é ORT_ENABLE_LAYOUT.
        // No Android a biblioteca vem do Gradle e tem de ser a mesma versão
        // que o ort usa no desktop (1.28): com a 1.22, a sessão era recusada
        // e, passado isso, travava ao abrir o modelo.
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(|x| x.to_string())?
        .with_intra_threads(threads)
        .map_err(|x| x.to_string())?
        .with_inter_threads(1)
        .map_err(|x| x.to_string())?
        .commit_from_file(path)
        .map_err(e)
}

fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

/// O codificador de imagem (fica carregado enquanto a etapa roda).
pub struct Visual {
    session: Mutex<Session>,
}

impl Visual {
    pub fn load(model: &Model) -> Result<Self, String> {
        Ok(Self { session: Mutex::new(session(&model.file("visual.onnx"), 1)?) })
    }

    /// Vetor normalizado de uma imagem (JPEG/PNG/WebP).
    pub fn embed(&self, bytes: &[u8]) -> Result<Vec<f32>, String> {
        let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
        // "squash" (preprocess.json): estica para o quadrado, sem cortar.
        let rgb = img.resize_exact(SIZE, SIZE, image::imageops::FilterType::CatmullRom).to_rgb8();
        let s = SIZE as usize;
        // NCHW; média 0,5 e desvio 0,5: [0, 255] → [-1, 1]
        let mut input = vec![0f32; 3 * s * s];
        for (x, y, p) in rgb.enumerate_pixels() {
            for c in 0..3 {
                input[c * s * s + y as usize * s + x as usize] = p[c] as f32 / 127.5 - 1.0;
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, s, s], input)).map_err(|e| e.to_string())?;
        let mut sess = self.session.lock().unwrap();
        let out = sess.run(ort::inputs!["image" => tensor]).map_err(|e| e.to_string())?;
        let (_, v) = out["embedding"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        Ok(normalize(v.to_vec()))
    }
}

/// O codificador de texto: grande (centenas de MB); carregado na busca e
/// solto depois de um tempo parado.
pub struct Textual {
    inner: Mutex<Option<(Session, Tokenizer, Instant)>>,
}

const IDLE: Duration = Duration::from_secs(120);

impl Default for Textual {
    fn default() -> Self {
        Self::new()
    }
}

impl Textual {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// Solta o modelo se ficou parado (chamado de tempos em tempos).
    pub fn trim(&self) {
        let mut g = self.inner.lock().unwrap();
        if g.as_ref().is_some_and(|(_, _, t)| t.elapsed() > IDLE) {
            *g = None;
        }
    }

    pub fn embed(&self, model: &Model, text: &str) -> Result<Vec<f32>, String> {
        let mut g = self.inner.lock().unwrap();
        if g.is_none() {
            let sess = session(&model.file("textual.onnx"), 2)?;
            let mut tok = Tokenizer::from_file(model.file("tokenizer.json")).map_err(|e| e.to_string())?;
            tok.with_padding(Some(PaddingParams { strategy: PaddingStrategy::Fixed(CONTEXT), pad_id: 0, pad_token: "<pad>".into(), ..Default::default() }));
            tok.with_truncation(Some(TruncationParams { max_length: CONTEXT, ..Default::default() })).map_err(|e| e.to_string())?;
            *g = Some((sess, tok, Instant::now()));
        }
        let (sess, tok, used) = g.as_mut().unwrap();
        *used = Instant::now();
        // Como o Immich ("canonicalize"): sem pontuação, minúsculas.
        let clean: String = text.chars().filter(|c| !c.is_ascii_punctuation()).collect::<String>().to_lowercase();
        let enc = tok.encode(clean.trim(), true).map_err(|e| e.to_string())?;
        let ids: Vec<i32> = enc.get_ids().iter().map(|&i| i as i32).collect();
        let tensor = Tensor::from_array(([1usize, CONTEXT], ids)).map_err(|e| e.to_string())?;
        let out = sess.run(ort::inputs!["text" => tensor]).map_err(|e| e.to_string())?;
        let (_, v) = out["embedding"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        Ok(normalize(v.to_vec()))
    }
}

/// Vetor ⇄ bytes (f16: metade do espaço, sem perda que importe para a busca).
pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| half::f16::from_f32(*x).to_le_bytes()).collect()
}

pub fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(2).map(|c| half::f16::from_le_bytes([c[0], c[1]]).to_f32()).collect()
}

/// Média normalizada (o vetor que representa vários quadros juntos).
pub fn mean(list: &[Vec<f32>]) -> Vec<f32> {
    let mut out = vec![0.0; list.first().map_or(0, |v| v.len())];
    for v in list {
        out.iter_mut().zip(v).for_each(|(o, x)| *o += x);
    }
    normalize(out)
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Com os modelos preparados (target/modelos) e a imagem de teste do
    /// preparo; sem eles, não testa. Mesmo resultado do Python (ordem).
    #[test]
    fn circulo_vermelho() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/modelos/busca-siglip2-b32-256/1");
        let img = std::env::var("TG_TEST_IMAGE").ok();
        let (Ok(raw), Some(img)) = (std::fs::read(dir.join("modelo.json")), img) else { return };
        let meta = serde_json::from_slice(&raw).unwrap();
        let model = Model { meta, dir };
        let iv = Visual::load(&model).unwrap().embed(&std::fs::read(img).unwrap()).unwrap();
        let t = Textual::new();
        let red = dot(&iv, &t.embed(&model, "um círculo vermelho").unwrap());
        let dog = dot(&iv, &t.embed(&model, "um cachorro na praia").unwrap());
        let blue = dot(&iv, &t.embed(&model, "a blue square").unwrap());
        println!("vermelho {red:.4} cachorro {dog:.4} azul {blue:.4}");
        assert!(red > blue && red > dog);
        assert_eq!(from_blob(&to_blob(&iv)).len(), DIM);
    }
}
