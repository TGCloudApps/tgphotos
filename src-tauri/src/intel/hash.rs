//! Hash perceptual (dHash de 64 bits) da miniatura: acha a mesma foto
//! recomprimida (WhatsApp, captura) sem modelo nenhum.

/// dHash: reduz para 9×8 em cinza e compara vizinhos na horizontal.
pub fn dhash(jpeg: &[u8]) -> Option<u64> {
    let img = image::load_from_memory(jpeg).ok()?;
    let small = img.resize_exact(9, 8, image::imageops::FilterType::Triangle).to_luma8();
    let mut h = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            let l = small.get_pixel(x, y)[0];
            let r = small.get_pixel(x + 1, y)[0];
            h = (h << 1) | u64::from(l > r);
        }
    }
    Some(h)
}

pub fn distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}
