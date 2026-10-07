//! Texto nas imagens: PP-OCRv5 mobile (detector DB + reconhecedor latino
//! CTC, que cobre o português). Detecta as regiões de texto, recorta cada uma
//! (caixa alinhada aos eixos, ampliada como o "unclip" do PaddleOCR) e lê.
//! O texto vai para a busca (FTS5).

use std::sync::Mutex;

use image::{imageops::FilterType, RgbImage};
use ort::session::Session;
use ort::value::Tensor;

use super::clip::session;
use super::models::Model;

/// Lado maior da imagem no detector (múltiplo de 32).
const DET_MAX: u32 = 960;
const BIN_THRESH: f32 = 0.3;
const BOX_THRESH: f32 = 0.6;
const UNCLIP: f32 = 1.5;
const REC_H: u32 = 48;
const REC_MAX_W: u32 = 960;
/// Confiança mínima média de uma linha lida.
const MIN_CONF: f32 = 0.6;

pub struct Ocr {
    det: Mutex<Session>,
    rec: Mutex<Session>,
    chars: Vec<String>,
}

impl Ocr {
    pub fn load(model: &Model) -> Result<Self, String> {
        let dict = std::fs::read_to_string(model.file("dicionario.txt")).map_err(|e| e.to_string())?;
        Ok(Self {
            det: Mutex::new(session(&model.file("deteccao.onnx"), 1)?),
            rec: Mutex::new(session(&model.file("reconhecimento.onnx"), 1)?),
            chars: dict.split('\n').map(String::from).collect(),
        })
    }

    /// Texto da imagem, uma linha por região (de cima para baixo).
    pub fn read(&self, bytes: &[u8]) -> Result<String, String> {
        let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?.to_rgb8();
        let mut boxes = self.detect(&img)?;
        boxes.sort_by(|a, b| (a.1 / 10).cmp(&(b.1 / 10)).then(a.0.cmp(&b.0)));
        let mut lines = Vec::new();
        for (x, y, w, h) in boxes {
            let crop = image::imageops::crop_imm(&img, x, y, w, h).to_image();
            if let Some(t) = self.recognize(&crop)? {
                lines.push(t);
            }
        }
        Ok(lines.join("\n"))
    }

    /// Caixas (x, y, largura, altura) das regiões de texto, em pixels da imagem.
    fn detect(&self, img: &RgbImage) -> Result<Vec<(u32, u32, u32, u32)>, String> {
        let (w, h) = img.dimensions();
        let scale = (DET_MAX as f32 / w.max(h) as f32).min(1.0);
        let round = |v: f32| (((v / 32.0).round() as u32) * 32).max(32);
        let (nw, nh) = (round(w as f32 * scale), round(h as f32 * scale));
        let resized = image::imageops::resize(img, nw, nh, FilterType::Triangle);
        let (sw, sh) = (nw as usize, nh as usize);
        // PaddleOCR: canais em BGR, média/desvio do ImageNet na mesma ordem da configuração.
        let mean = [0.485f32, 0.456, 0.406];
        let std = [0.229f32, 0.224, 0.225];
        let mut input = vec![0f32; 3 * sw * sh];
        for (x, y, p) in resized.enumerate_pixels() {
            let bgr = [p[2], p[1], p[0]];
            for c in 0..3 {
                input[c * sw * sh + y as usize * sw + x as usize] = (bgr[c] as f32 / 255.0 - mean[c]) / std[c];
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, sh, sw], input)).map_err(|e| e.to_string())?;
        let mut sess = self.det.lock().unwrap();
        let out = sess.run(ort::inputs!["x" => tensor]).map_err(|e| e.to_string())?;
        let (_, prob) = out[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let prob = prob.to_vec();
        drop(out);
        drop(sess);

        // Componentes conexos do mapa binário → caixa de cada um.
        let mut seen = vec![false; sw * sh];
        let mut boxes = Vec::new();
        let mut stack = Vec::new();
        for start in 0..sw * sh {
            if seen[start] || prob[start] < BIN_THRESH {
                continue;
            }
            let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
            let (mut sum, mut n) = (0f32, 0usize);
            seen[start] = true;
            stack.push(start);
            while let Some(i) = stack.pop() {
                let (x, y) = (i % sw, i / sw);
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
                sum += prob[i];
                n += 1;
                let mut push = |j: usize| {
                    if !seen[j] && prob[j] >= BIN_THRESH {
                        seen[j] = true;
                        stack.push(j);
                    }
                };
                if x > 0 {
                    push(i - 1);
                }
                if x + 1 < sw {
                    push(i + 1);
                }
                if y > 0 {
                    push(i - sw);
                }
                if y + 1 < sh {
                    push(i + sw);
                }
            }
            let (bw, bh) = ((x1 - x0 + 1) as f32, (y1 - y0 + 1) as f32);
            if n < 12 || bw.min(bh) < 3.0 || sum / (n as f32) < BOX_THRESH {
                continue;
            }
            // "unclip": amplia pela razão área/perímetro (o mapa encolhe o texto).
            let d = bw * bh * UNCLIP / (2.0 * (bw + bh));
            let (fx, fy) = (w as f32 / nw as f32, h as f32 / nh as f32);
            let ax = ((x0 as f32 - d) * fx).max(0.0);
            let ay = ((y0 as f32 - d) * fy).max(0.0);
            let bx = ((x1 as f32 + 1.0 + d) * fx).min(w as f32);
            let by = ((y1 as f32 + 1.0 + d) * fy).min(h as f32);
            if bx - ax >= 4.0 && by - ay >= 4.0 {
                boxes.push((ax as u32, ay as u32, (bx - ax) as u32, (by - ay) as u32));
            }
        }
        Ok(boxes)
    }

    /// Lê uma linha recortada (CTC guloso). `None` se a leitura for duvidosa.
    fn recognize(&self, crop: &RgbImage) -> Result<Option<String>, String> {
        let (w, h) = crop.dimensions();
        let nw = ((w as f32 * REC_H as f32 / h as f32).ceil() as u32).clamp(16, REC_MAX_W);
        let resized = image::imageops::resize(crop, nw, REC_H, FilterType::Triangle);
        let (sw, sh) = (nw as usize, REC_H as usize);
        let mut input = vec![0f32; 3 * sw * sh];
        for (x, y, p) in resized.enumerate_pixels() {
            let bgr = [p[2], p[1], p[0]];
            for c in 0..3 {
                input[c * sw * sh + y as usize * sw + x as usize] = (bgr[c] as f32 / 255.0 - 0.5) / 0.5;
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, sh, sw], input)).map_err(|e| e.to_string())?;
        let mut sess = self.rec.lock().unwrap();
        let out = sess.run(ort::inputs!["x" => tensor]).map_err(|e| e.to_string())?;
        let (shape, probs) = out[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let (steps, classes) = (shape[1] as usize, shape[2] as usize);
        let mut text = String::new();
        let (mut conf, mut n, mut last) = (0f32, 0usize, 0usize);
        for t in 0..steps {
            let row = &probs[t * classes..(t + 1) * classes];
            let (best, p) = row.iter().enumerate().fold((0, f32::MIN), |acc, (i, &v)| if v > acc.1 { (i, v) } else { acc });
            // 0 = vazio do CTC; repetidos seguidos contam uma vez.
            if best != 0 && best != last {
                let ch = if best - 1 < self.chars.len() { self.chars[best - 1].as_str() } else { " " };
                text.push_str(ch);
                conf += p;
                n += 1;
            }
            last = best;
        }
        let text = text.trim().to_string();
        if n == 0 || conf / (n as f32) < MIN_CONF || text.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
            return Ok(None);
        }
        Ok(Some(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Com o modelo preparado e TG_TEST_TEXT apontando para uma imagem com
    /// "PADARIA SÃO JOÃO" / "Pão de queijo R$ 4,50" / "Aberto até 22h".
    #[test]
    fn le_a_placa() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/modelos/texto-ppocr5-latin/1");
        let (Ok(raw), Ok(img)) = (std::fs::read(dir.join("modelo.json")), std::env::var("TG_TEST_TEXT")) else { return };
        let ocr = Ocr::load(&Model { meta: serde_json::from_slice(&raw).unwrap(), dir }).unwrap();
        let text = ocr.read(&std::fs::read(img).unwrap()).unwrap();
        println!("{text}");
        let lower = text.to_lowercase();
        assert!(lower.contains("padaria"), "{text}");
        assert!(lower.contains("queijo"), "{text}");
    }
}
