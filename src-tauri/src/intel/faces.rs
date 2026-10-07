//! Rostos: InsightFace buffalo_s (o "pequeno" do Immich). Detecção com SCRFD
//! (caixa + 5 pontos), alinhamento pelos 5 pontos no gabarito do ArcFace
//! (112×112) e vetor de reconhecimento de 512 posições (MobileFaceNet).
//! Mesmo pipeline do insightface (scrfd.py / face_align.py).

use std::sync::Mutex;

use image::{imageops::FilterType, RgbImage};
use ort::session::Session;
use ort::value::Tensor;

use super::clip::session;
use super::models::Model;

const DET: u32 = 640;
const STRIDES: [u32; 3] = [8, 16, 32];
const ANCHORS: usize = 2;
/// Pontuação mínima da detecção (o Immich recomenda a partir de 0,5).
pub const MIN_SCORE: f32 = 0.6;
const NMS_IOU: f32 = 0.4;
/// Rosto menor que isso (px na imagem analisada) não reconhece bem.
pub const MIN_SIDE: f32 = 24.0;
/// Maior lado da imagem analisada.
const MAX_SIDE: u32 = 1600;

/// Gabarito dos 5 pontos (olhos, nariz, cantos da boca) no recorte 112×112.
const ARCFACE: [[f32; 2]; 5] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

#[derive(Clone, Debug)]
pub struct Face {
    /// Caixa em pixels da imagem analisada.
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub score: f32,
    pub kps: [[f32; 2]; 5],
    /// Vetor normalizado (512).
    pub vec: Vec<f32>,
}

pub struct Faces {
    det: Mutex<Session>,
    rec: Mutex<Session>,
}

impl Faces {
    pub fn load(model: &Model) -> Result<Self, String> {
        Ok(Self { det: Mutex::new(session(&model.file("deteccao.onnx"), 1)?), rec: Mutex::new(session(&model.file("reconhecimento.onnx"), 1)?) })
    }

    /// Rostos de uma imagem (JPEG/PNG/WebP), com o vetor de cada um.
    pub fn analyze(&self, bytes: &[u8]) -> Result<(Vec<Face>, u32, u32), String> {
        let mut img = image::load_from_memory(bytes).map_err(|e| e.to_string())?.to_rgb8();
        // Original grande: 1600 px bastam para o recorte do rosto (112 px) sair nítido.
        if img.width().max(img.height()) > MAX_SIDE {
            let k = MAX_SIDE as f32 / img.width().max(img.height()) as f32;
            img = image::imageops::resize(&img, (img.width() as f32 * k) as u32, (img.height() as f32 * k) as u32, image::imageops::FilterType::Triangle);
        }
        let (w, h) = img.dimensions();
        let mut faces = self.detect(&img)?;
        // Tamanho mínimo relativo à miniatura de 480 px (vale para qualquer resolução).
        let min = MIN_SIDE * w.max(h) as f32 / 480.0;
        faces.retain(|f| f.x2 - f.x1 >= min && f.y2 - f.y1 >= min);
        for f in &mut faces {
            let crop = align(&img, &f.kps);
            f.vec = self.embed(&crop)?;
        }
        Ok((faces, w, h))
    }

    fn detect(&self, img: &RgbImage) -> Result<Vec<Face>, String> {
        let (w, h) = img.dimensions();
        // Cabe em 640×640 mantendo a proporção, encostado no canto (como o scrfd.py).
        let ratio = h as f32 / w as f32;
        let (nw, nh) = if ratio > 1.0 { ((DET as f32 / ratio) as u32, DET) } else { (DET, (DET as f32 * ratio) as u32) };
        let scale = nh as f32 / h as f32;
        let resized = image::imageops::resize(img, nw.max(1), nh.max(1), FilterType::Triangle);
        let s = DET as usize;
        let mut input = vec![0f32; 3 * s * s];
        // Fundo preto normalizado: (0 - 127,5) / 128.
        input.iter_mut().for_each(|v| *v = -127.5 / 128.0);
        for (x, y, p) in resized.enumerate_pixels() {
            for c in 0..3 {
                input[c * s * s + y as usize * s + x as usize] = (p[c] as f32 - 127.5) / 128.0;
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, s, s], input)).map_err(|e| e.to_string())?;
        let mut sess = self.det.lock().unwrap();
        // Entrada dos dois modelos do buffalo_s: "input.1".
        let out = sess.run(ort::inputs!["input.1" => tensor]).map_err(|e| e.to_string())?;
        // Saídas na ordem: notas (8, 16, 32), caixas (8, 16, 32), pontos (8, 16, 32).
        let mut tensors = Vec::new();
        for i in 0..9 {
            let (_, v) = out[i].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            tensors.push(v.to_vec());
        }
        let mut found = Vec::new();
        for (k, stride) in STRIDES.iter().enumerate() {
            let (scores, boxes, kps) = (&tensors[k], &tensors[k + 3], &tensors[k + 6]);
            let fw = (DET / stride) as usize;
            for (i, &score) in scores.iter().enumerate() {
                if score < MIN_SCORE {
                    continue;
                }
                let cell = i / ANCHORS;
                let cx = (cell % fw) as f32 * *stride as f32;
                let cy = (cell / fw) as f32 * *stride as f32;
                let st = *stride as f32;
                let b = &boxes[i * 4..i * 4 + 4];
                let mut f = Face {
                    x1: (cx - b[0] * st) / scale,
                    y1: (cy - b[1] * st) / scale,
                    x2: (cx + b[2] * st) / scale,
                    y2: (cy + b[3] * st) / scale,
                    score,
                    kps: [[0.0; 2]; 5],
                    vec: Vec::new(),
                };
                for p in 0..5 {
                    f.kps[p] = [(cx + kps[i * 10 + p * 2] * st) / scale, (cy + kps[i * 10 + p * 2 + 1] * st) / scale];
                }
                found.push(f);
            }
        }
        Ok(nms(found))
    }

    fn embed(&self, crop: &RgbImage) -> Result<Vec<f32>, String> {
        let s = 112usize;
        let mut input = vec![0f32; 3 * s * s];
        for (x, y, p) in crop.enumerate_pixels() {
            for c in 0..3 {
                input[c * s * s + y as usize * s + x as usize] = (p[c] as f32 - 127.5) / 127.5;
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, s, s], input)).map_err(|e| e.to_string())?;
        let mut sess = self.rec.lock().unwrap();
        // Entrada dos dois modelos do buffalo_s: "input.1".
        let out = sess.run(ort::inputs!["input.1" => tensor]).map_err(|e| e.to_string())?;
        let (_, v) = out[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let mut v = v.to_vec();
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
        v.iter_mut().for_each(|x| *x /= n);
        Ok(v)
    }
}

fn nms(mut faces: Vec<Face>) -> Vec<Face> {
    faces.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep: Vec<Face> = Vec::new();
    for f in faces {
        if keep.iter().all(|k| iou(k, &f) <= NMS_IOU) {
            keep.push(f);
        }
    }
    keep
}

fn iou(a: &Face, b: &Face) -> f32 {
    let ix = (a.x2.min(b.x2) - a.x1.max(b.x1)).max(0.0);
    let iy = (a.y2.min(b.y2) - a.y1.max(b.y1)).max(0.0);
    let inter = ix * iy;
    let area = |f: &Face| (f.x2 - f.x1) * (f.y2 - f.y1);
    inter / (area(a) + area(b) - inter).max(1e-6)
}

/// Transformação de semelhança (rotação + escala + translação) que leva os 5
/// pontos ao gabarito (Umeyama, sem reflexão), e o recorte 112×112 por ela.
fn align(img: &RgbImage, kps: &[[f32; 2]; 5]) -> RgbImage {
    let n = 5.0;
    let (mut sx, mut sy, mut dx, mut dy) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..5 {
        sx += kps[i][0];
        sy += kps[i][1];
        dx += ARCFACE[i][0];
        dy += ARCFACE[i][1];
    }
    let (sx, sy, dx, dy) = (sx / n, sy / n, dx / n, dy / n);
    // Para 2D: a = Σ(s·d)/Σ|s|², b = Σ(s×d)/Σ|s|² (pontos centrados).
    let (mut num_a, mut num_b, mut den) = (0.0, 0.0, 0.0);
    for i in 0..5 {
        let (px, py) = (kps[i][0] - sx, kps[i][1] - sy);
        let (qx, qy) = (ARCFACE[i][0] - dx, ARCFACE[i][1] - dy);
        num_a += px * qx + py * qy;
        num_b += px * qy - py * qx;
        den += px * px + py * py;
    }
    let (a, b) = (num_a / den.max(1e-6), num_b / den.max(1e-6));
    // destino = [a -b; b a]·(origem - centro_o) + centro_d → inversa para amostrar.
    let det = a * a + b * b;
    let (ia, ib) = (a / det, -b / det);
    let mut out = RgbImage::new(112, 112);
    let (w, h) = (img.width() as f32, img.height() as f32);
    for y in 0..112u32 {
        for x in 0..112u32 {
            let (qx, qy) = (x as f32 - dx, y as f32 - dy);
            let px = ia * qx - ib * qy + sx;
            let py = ib * qx + ia * qy + sy;
            if px < 0.0 || py < 0.0 || px >= w - 1.0 || py >= h - 1.0 {
                continue;
            }
            let (x0, y0) = (px.floor(), py.floor());
            let (fx, fy) = (px - x0, py - y0);
            let at = |xx: f32, yy: f32| img.get_pixel(xx as u32, yy as u32);
            let (p00, p10, p01, p11) = (at(x0, y0), at(x0 + 1.0, y0), at(x0, y0 + 1.0), at(x0 + 1.0, y0 + 1.0));
            let mut px_out = [0u8; 3];
            for c in 0..3 {
                let v = p00[c] as f32 * (1.0 - fx) * (1.0 - fy) + p10[c] as f32 * fx * (1.0 - fy) + p01[c] as f32 * (1.0 - fx) * fy + p11[c] as f32 * fx * fy;
                px_out[c] = v.round().clamp(0.0, 255.0) as u8;
            }
            out.put_pixel(x, y, image::Rgb(px_out));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Com o modelo preparado e retratos de domínio público em TG_TEST_FACES
    /// (Neil_Armstrong.jpg, Neil_Armstrong_pose.jpg, Buzz_Aldrin.jpg).
    #[test]
    fn mesma_pessoa_mais_perto() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/modelos/rostos-buffalo-s/1");
        let (Ok(raw), Ok(faces_dir)) = (std::fs::read(dir.join("modelo.json")), std::env::var("TG_TEST_FACES")) else { return };
        let model = Model { meta: serde_json::from_slice(&raw).unwrap(), dir };
        let f = Faces::load(&model).unwrap();
        let one = |name: &str| {
            let (faces, w, h) = f.analyze(&std::fs::read(Path::new(&faces_dir).join(name)).unwrap()).unwrap();
            println!("{name}: {} rosto(s) em {w}×{h}, nota {:.2}, caixa {:.0},{:.0}–{:.0},{:.0}", faces.len(), faces[0].score, faces[0].x1, faces[0].y1, faces[0].x2, faces[0].y2);
            faces.into_iter().next().unwrap().vec
        };
        let (a1, a2, b) = (one("Neil_Armstrong.jpg"), one("Neil_Armstrong_pose.jpg"), one("Buzz_Aldrin.jpg"));
        let dot = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(p, q)| p * q).sum::<f32>();
        println!("Armstrong×Armstrong {:.3} · Armstrong×Aldrin {:.3}", dot(&a1, &a2), dot(&a1, &b));
        assert!(dot(&a1, &a2) > dot(&a1, &b) + 0.15);
    }
}
