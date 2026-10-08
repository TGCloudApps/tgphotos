//! Tiras de quadros dos vídeos (docs/inteligencia-de-midia.md §12): a
//! interface tira alguns quadros espalhados pelo vídeo (o decodificador está
//! lá), monta uma tira só (um JPEG, quadros lado a lado) e o Rust a sobe ao
//! vault. Uma entidade `frames` por vídeo (uid = o da mídia) aponta para ela;
//! qualquer aparelho gera, todos usam. A análise do vídeo passa a olhar a tira
//! em vez de um quadro só.

use serde::{Deserialize, Serialize};
use tg_core::Piece;

pub const ENTITY: &str = "frames";
/// Quadros por tira (no máximo).
pub const MAX_FRAMES: usize = 8;
/// Tira maior que isso não é uma tira.
pub const MAX_BYTES: usize = 2 << 20;

/// Linha da entidade: onde está a tira e como fatiá-la.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FramesRow {
    pub piece: Piece,
    /// Tamanho de cada quadro (todos iguais, lado a lado na horizontal).
    pub w: u32,
    pub h: u32,
    /// Instante de cada quadro no vídeo, em segundos.
    pub times: Vec<f32>,
}

/// Confere a tira enviada pela interface (dimensões batem com os quadros).
pub fn check(jpeg: &[u8], w: u32, h: u32, n: usize) -> Result<(), String> {
    if n == 0 || n > MAX_FRAMES || w == 0 || h == 0 || jpeg.len() > MAX_BYTES {
        return Err("tira inválida".into());
    }
    let img = image::load_from_memory(jpeg).map_err(|e| e.to_string())?;
    if img.width() != w * n as u32 || img.height() != h {
        return Err(format!("tira de {}×{}, esperado {}×{}", img.width(), img.height(), w * n as u32, h));
    }
    Ok(())
}

/// Os quadros da tira, cada um em JPEG (o que os modelos recebem).
pub fn split(jpeg: &[u8], w: u32, h: u32) -> Result<Vec<Vec<u8>>, String> {
    let img = image::load_from_memory(jpeg).map_err(|e| e.to_string())?;
    let n = (img.width() / w.max(1)).min(MAX_FRAMES as u32);
    (0..n)
        .map(|i| {
            let frame = img.crop_imm(i * w, 0, w, h.min(img.height())).to_rgb8();
            let mut out = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&frame).map_err(|e| e.to_string())?;
            Ok(out)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fatia_a_tira() {
        let strip = image::RgbImage::from_fn(30, 8, |x, _| image::Rgb([(x / 10 * 100) as u8, 0, 0]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95).encode_image(&strip).unwrap();
        check(&jpeg, 10, 8, 3).unwrap();
        assert!(check(&jpeg, 10, 8, 2).is_err());
        let parts = split(&jpeg, 10, 8).unwrap();
        assert_eq!(parts.len(), 3);
        let last = image::load_from_memory(&parts[2]).unwrap().to_rgb8();
        assert_eq!((last.width(), last.height()), (10, 8));
        assert!(last.get_pixel(5, 4)[0] > 150);
    }
}
