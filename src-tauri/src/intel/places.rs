//! Lugares sem internet: GeoNames cities500 num binário compacto (preparado em
//! scripts/modelos/preparar.py), indexado em células de 1°. Cada foto com GPS
//! ganha a cidade mais próxima, o estado e o país (em português).

use std::collections::HashMap;
use std::path::Path;

pub struct Places {
    texts: Vec<String>,
    /// lat, lon, nome, estado, país
    rows: Vec<(f32, f32, u32, u32, u32)>,
    grid: HashMap<(i16, i16), Vec<u32>>,
}

/// Mais longe que isso da cidade mais próxima: sem lugar (mar, deserto).
const MAX_KM: f32 = 60.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Place {
    pub city: String,
    pub state: String,
    pub country: String,
}

fn cell(lat: f32, lon: f32) -> (i16, i16) {
    (lat.floor() as i16, lon.floor() as i16)
}

impl Places {
    pub fn load(path: &Path) -> Result<Self, String> {
        let b = std::fs::read(path).map_err(|e| e.to_string())?;
        let mut at = 0usize;
        let mut take = |n: usize| -> Result<&[u8], String> {
            let s = b.get(at..at + n).ok_or("lugares.bin truncado")?;
            at += n;
            Ok(s)
        };
        if take(4)? != b"TGL1" {
            return Err("lugares.bin: formato desconhecido".into());
        }
        let u32_ = |s: &[u8]| u32::from_le_bytes(s.try_into().unwrap());
        let n = u32_(take(4)?) as usize;
        let mut texts = Vec::with_capacity(n);
        for _ in 0..n {
            let len = u16::from_le_bytes(take(2)?.try_into().unwrap()) as usize;
            texts.push(String::from_utf8_lossy(take(len)?).into_owned());
        }
        let m = u32_(take(4)?) as usize;
        let mut rows = Vec::with_capacity(m);
        let mut grid: HashMap<(i16, i16), Vec<u32>> = HashMap::new();
        for i in 0..m {
            let r = take(20)?;
            let lat = f32::from_le_bytes(r[0..4].try_into().unwrap());
            let lon = f32::from_le_bytes(r[4..8].try_into().unwrap());
            rows.push((lat, lon, u32_(&r[8..12]), u32_(&r[12..16]), u32_(&r[16..20])));
            grid.entry(cell(lat, lon)).or_default().push(i as u32);
        }
        Ok(Self { texts, rows, grid })
    }

    pub fn nearest(&self, lat: f64, lon: f64) -> Option<Place> {
        let (lat, lon) = (lat as f32, lon as f32);
        let (cy, cx) = cell(lat, lon);
        let mut best: Option<(f32, u32)> = None;
        for dy in -1..=1 {
            for dx in -1..=1 {
                // Longitude dá a volta em ±180.
                let x = ((cx + dx + 180).rem_euclid(360)) - 180;
                for &i in self.grid.get(&(cy + dy, x)).map(|v| v.as_slice()).unwrap_or(&[]) {
                    let r = self.rows[i as usize];
                    let d = km(lat, lon, r.0, r.1);
                    if best.is_none_or(|b| d < b.0) {
                        best = Some((d, i));
                    }
                }
            }
        }
        let (d, i) = best?;
        if d > MAX_KM {
            return None;
        }
        let r = self.rows[i as usize];
        let t = |k: u32| self.texts.get(k as usize).cloned().unwrap_or_default();
        Some(Place { city: t(r.2), state: t(r.3), country: t(r.4) })
    }
}

fn km(lat1: f32, lon1: f32, lat2: f32, lon2: f32) -> f32 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = p2 - p1;
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    6371.0 * 2.0 * a.sqrt().min(1.0).asin()
}

#[cfg(test)]
mod tests {
    /// Com a base preparada (scripts/modelos/preparar.py → target/modelos); sem ela, não testa.
    #[test]
    fn cidades_conhecidas() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/modelos/lugares-geonames/1/lugares.bin");
        let Ok(p) = super::Places::load(&path) else { return };
        let sp = p.nearest(-23.5505, -46.6333).unwrap();
        assert_eq!((sp.city.as_str(), sp.country.as_str()), ("São Paulo", "Brasil"));
        let lisboa = p.nearest(38.7223, -9.1393).unwrap();
        assert_eq!(lisboa.country, "Portugal");
        assert!(p.nearest(0.0, -30.0).is_none(), "meio do Atlântico");
    }
}
