//! Metadata for photos and videos, read from the local file after the upload:
//!
//! - Image: EXIF (JPEG, HEIF, PNG, WebP, TIFF/RAW) — date with timezone, camera,
//!   lens, exposure, GPS, orientation — and dimensions from the header.
//! - Video (MP4/MOV/3GP): `mvhd` (date, duration), `tkhd` of the video track
//!   (dimensions, rotation), GPS in `udta/©xyz` (Android) and the Apple
//!   keys (`com.apple.quicktime.location.ISO6709` / `.creationdate`).
//! - Without an embedded date: the file name (`IMG_20240131_123456`,
//!   `PXL_…`, `Screenshot_2024-01-31-12-34-56`, `IMG-20240131-WA0001`…) and, at
//!   last, the file modification date.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};

use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Camera {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lens: Option<String>,
    /// Aperture (f/1.8 → 1.8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f: Option<f64>,
    /// Exposure in seconds (1/125 → 0.008).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iso: Option<u32>,
    /// Focal length in mm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal: Option<f64>,
}

impl Camera {
    fn is_empty(&self) -> bool {
        *self == Camera::default()
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Meta {
    /// Capture time (ms since the epoch, UTC).
    pub taken: Option<i64>,
    /// Capture timezone in minutes, when the file says.
    pub tz: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub camera: Option<Camera>,
    pub gps: Option<(f64, f64)>,
    /// Motion photo: video bytes at the end of the file; `Some(0)` = checked, it is not.
    pub motion: Option<i64>,
}

/// Where to look for the XMP (right after the EXIF).
const XMP_HEAD: usize = 128 * 1024;

/// Video bytes embedded (from the end of the file) according to the XMP, unchecked.
pub fn motion_from_xmp(head: &[u8]) -> Option<i64> {
    let text: String = head.iter().map(|&b| b as char).collect();
    // New container: <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="N" .../>
    for part in text.split("<Container:Item").skip(1) {
        let item = part.split('>').next().unwrap_or("");
        if item.contains("Item:Semantic=\"MotionPhoto\"") {
            if let Some(n) = attr(item, "Item:Length") {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }
    // Old: GCamera:MicroVideo="1" GCamera:MicroVideoOffset="N" (from the end of the file).
    if text.contains("GCamera:MicroVideo=\"1\"") {
        return attr(&text, "GCamera:MicroVideoOffset").filter(|n| *n > 0);
    }
    None
}

fn attr(s: &str, name: &str) -> Option<i64> {
    let key = format!("{name}=\"");
    let rest = &s[s.find(&key)? + key.len()..];
    rest.split('"').next()?.parse().ok()
}

/// Motion photo: the XMP points to a video at the end, and it starts with `ftyp`.
fn motion(f: &mut File, len: u64) -> Option<i64> {
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut head = vec![0u8; XMP_HEAD.min(len as usize)];
    f.read_exact(&mut head).ok()?;
    let n = motion_from_xmp(&head).filter(|n| (*n as u64) < len);
    let Some(n) = n else { return Some(0) };
    f.seek(SeekFrom::Start(len - n as u64)).ok()?;
    let mut box_head = [0u8; 12];
    f.read_exact(&mut box_head).ok()?;
    Some(if &box_head[4..8] == b"ftyp" { n } else { 0 })
}

/// Reads what it can from a local file; nothing here fails the upload.
pub fn read(file: Option<File>, name: &str, mime: &str) -> Meta {
    read_with(file, name, mime, None)
}

/// Like [`read`], but with no date in the file or name, `fallback_ms` applies before the
/// modification date (chat media: the file is a freshly downloaded copy).
pub fn read_with(file: Option<File>, name: &str, mime: &str, fallback_ms: Option<i64>) -> Meta {
    let mut m = Meta::default();
    let mut modified = None;
    if let Some(mut f) = file {
        let md = f.metadata().ok();
        modified = md.as_ref().and_then(|md| md.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).filter(|d| d.as_secs() > 0).map(|d| d.as_millis() as i64);
        let len = md.map(|md| md.len()).unwrap_or_default();
        m = probe(&mut f, len, name, mime);
        if mime.eq_ignore_ascii_case("image/jpeg") {
            m.motion = motion(&mut f, len);
        }
    }
    fallback(m, name, fallback_ms.or(modified))
}

/// Like [`read`], from the start of the file already in memory (import: the
/// first part of the document). `fallback_ms` applies with no date in the file or name.
pub fn read_bytes(head: &[u8], name: &str, mime: &str, fallback_ms: Option<i64>) -> Meta {
    let m = probe(&mut std::io::Cursor::new(head), head.len() as u64, name, mime);
    fallback(m, name, fallback_ms)
}

fn probe<R: Read + Seek>(r: &mut R, len: u64, name: &str, mime: &str) -> Meta {
    if mime.starts_with("video/") || is_bmff_video(name) {
        video(r, len).unwrap_or_default()
    } else if mime.starts_with("image/") {
        image(r)
    } else {
        Meta::default()
    }
}

fn fallback(mut m: Meta, name: &str, ms: Option<i64>) -> Meta {
    if m.taken.is_none() {
        m.taken = from_name(name).or(ms);
    }
    m
}

fn is_bmff_video(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [".mp4", ".mov", ".m4v", ".3gp"].iter().any(|e| n.ends_with(e))
}

/// Local time without a timezone → UTC: with the given timezone, or this device's.
fn to_utc(naive: NaiveDateTime, tz: Option<i32>) -> Option<i64> {
    match tz {
        Some(min) => Some(naive.and_utc().timestamp_millis() - min as i64 * 60_000),
        None => Local.from_local_datetime(&naive).earliest().map(|d| d.timestamp_millis()),
    }
}

/// "+03:00" / "-0300" / "Z" → minutes.
fn parse_offset(s: &str) -> Option<i32> {
    let s = s.trim();
    if s == "Z" {
        return Some(0);
    }
    let sign = match s.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits: String = s[1..].chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 4 {
        return None;
    }
    let h: i32 = digits[..2].parse().ok()?;
    let m: i32 = digits[2..].parse().ok()?;
    (h <= 14 && m < 60).then_some(sign * (h * 60 + m))
}

// ---- image -----------------------------------------------------------------

fn image<R: Read + Seek>(f: &mut R) -> Meta {
    let mut m = Meta::default();
    let mut orientation = 1;
    if let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(&mut *f)) {
        use exif::{In, Tag};
        let field = |tag| exif.get_field(tag, In::PRIMARY);
        let text = |tag| {
            field(tag).and_then(|f| match &f.value {
                exif::Value::Ascii(v) => v.first().map(|b| String::from_utf8_lossy(b).trim().trim_end_matches('\0').to_string()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
        };
        let rational = |tag| {
            field(tag).and_then(|f| match &f.value {
                exif::Value::Rational(v) => v.first().filter(|r| r.denom != 0).map(|r| r.to_f64()),
                _ => None,
            })
        };
        let uint = |tag| field(tag).and_then(|f| f.value.get_uint(0));

        let date = text(Tag::DateTimeOriginal).or_else(|| text(Tag::DateTimeDigitized)).or_else(|| text(Tag::DateTime));
        let offset = text(Tag::OffsetTimeOriginal).or_else(|| text(Tag::OffsetTime)).and_then(|s| parse_offset(&s));
        if let Some(naive) = date.and_then(|d| NaiveDateTime::parse_from_str(&d, "%Y:%m:%d %H:%M:%S").ok()) {
            m.taken = to_utc(naive, offset);
            m.tz = offset;
        }

        let camera = Camera {
            make: text(Tag::Make),
            model: text(Tag::Model),
            lens: text(Tag::LensModel),
            f: rational(Tag::FNumber),
            exposure: rational(Tag::ExposureTime),
            iso: uint(Tag::PhotographicSensitivity),
            focal: rational(Tag::FocalLength),
        };
        if !camera.is_empty() {
            m.camera = Some(camera);
        }

        let coord = |tag, reference| -> Option<f64> {
            let v = match &field(tag)?.value {
                exif::Value::Rational(v) if v.len() >= 3 && v.iter().all(|r| r.denom != 0) => v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0,
                _ => return None,
            };
            let negative = text(reference).is_some_and(|r| r.starts_with('S') || r.starts_with('W'));
            Some(if negative { -v } else { v })
        };
        if let (Some(lat), Some(lon)) = (coord(Tag::GPSLatitude, Tag::GPSLatitudeRef), coord(Tag::GPSLongitude, Tag::GPSLongitudeRef)) {
            // 0,0 is the "no GPS" of many devices.
            if (lat != 0.0 || lon != 0.0) && lat.abs() <= 90.0 && lon.abs() <= 180.0 {
                m.gps = Some((lat, lon));
            }
        }
        orientation = uint(Tag::Orientation).unwrap_or(1);
        if let (Some(w), Some(h)) = (uint(Tag::PixelXDimension), uint(Tag::PixelYDimension)) {
            m.width = Some(w);
            m.height = Some(h);
        }
    }
    // The header rules on dimensions (EXIF sometimes stores the camera ones).
    if f.seek(SeekFrom::Start(0)).is_ok() {
        if let Ok(size) = imagesize::reader_size(BufReader::new(&mut *f)) {
            m.width = Some(size.width as u32);
            m.height = Some(size.height as u32);
        }
    }
    // Orientations 5–8 rotate 90°: the displayed image has its sides swapped.
    if (5..=8).contains(&orientation) {
        std::mem::swap(&mut m.width, &mut m.height);
    }
    m
}

// ---- video (ISO BMFF / QuickTime) ----------------------------------------------

/// Largest `moov` worth reading (the sample index of long videos is big).
const MAX_MOOV: u64 = 64 << 20;

/// `fragment_duration` of the mehd (version 1: 64 bits).
fn mehd(h: &[u8]) -> Option<u64> {
    match h.first()? {
        1 if h.len() >= 12 => Some(be64(&h[4..])),
        _ if h.len() >= 8 => Some(be32(&h[4..]) as u64),
        _ => None,
    }
}

fn video<R: Read + Seek>(f: &mut R, len: u64) -> Option<Meta> {
    let moov = find_top(f, len, b"moov")?;
    let mut m = Meta::default();

    if let Some(mvhd) = child(&moov, b"mvhd") {
        let (created, timescale, duration) = match mvhd.first()? {
            1 if mvhd.len() >= 32 => (be64(&mvhd[4..]), be32(&mvhd[20..]) as u64, be64(&mvhd[24..])),
            _ if mvhd.len() >= 20 => (be32(&mvhd[4..]) as u64, be32(&mvhd[12..]) as u64, be32(&mvhd[16..]) as u64),
            _ => (0, 0, 0),
        };
        // Seconds since 1904-01-01 UTC; zero (or before 1970) means "I don't know".
        const EPOCH_1904: u64 = 2_082_844_800;
        if created > EPOCH_1904 {
            m.taken = Some(((created - EPOCH_1904) * 1000) as i64);
        }
        // Fragmented MP4 (screen recording, edited/exported video): the mvhd comes
        // zeroed and the total duration is in the mehd.
        let duration = if duration == 0 { child(&moov, b"mvex").and_then(|x| child(x, b"mehd")).and_then(mehd).unwrap_or(0) } else { duration };
        if timescale > 0 && duration > 0 && duration != u32::MAX as u64 {
            m.duration = Some(duration as f64 / timescale as f64);
        }
    }

    for trak in children(&moov, b"trak") {
        let is_video = child(trak, b"mdia").and_then(|mdia| child(mdia, b"hdlr")).is_some_and(|h| h.len() >= 12 && &h[8..12] == b"vide");
        let Some(tkhd) = child(trak, b"tkhd").filter(|_| is_video) else { continue };
        // Matrix (36 bytes) and 16.16 width/height at the end of the tkhd.
        let n = tkhd.len();
        if n < 84 {
            continue;
        }
        let w = be32(&tkhd[n - 8..]) >> 16;
        let h = be32(&tkhd[n - 4..]) >> 16;
        let matrix = &tkhd[n - 44..n - 8];
        let (a, b) = (be32(&matrix[0..]) as i32, be32(&matrix[4..]) as i32);
        let rotated = a == 0 && b != 0;
        if w > 0 && h > 0 {
            (m.width, m.height) = if rotated { (Some(h), Some(w)) } else { (Some(w), Some(h)) };
            break;
        }
    }

    // Android: udta/©xyz = "+37.3318-122.0312/".
    if let Some(xyz) = child(&moov, b"udta").and_then(|u| child(u, b"\xa9xyz")) {
        if xyz.len() > 4 {
            m.gps = iso6709(&String::from_utf8_lossy(&xyz[4..]));
        }
    }
    // Apple: meta/keys + meta/ilst.
    if let Some(meta) = child(&moov, b"meta") {
        for (key, value) in apple_keys(meta) {
            match key.as_str() {
                "com.apple.quicktime.location.ISO6709" => m.gps = m.gps.or_else(|| iso6709(&value)),
                "com.apple.quicktime.creationdate" => {
                    // "2024-01-31T12:34:56-0300": local time with timezone.
                    if value.len() >= 19 {
                        if let Ok(naive) = NaiveDateTime::parse_from_str(&value[..19], "%Y-%m-%dT%H:%M:%S") {
                            let tz = parse_offset(&value[19..]);
                            if let Some(t) = to_utc(naive, tz) {
                                m.taken = Some(t);
                                m.tz = tz;
                            }
                        }
                    }
                }
                "com.apple.quicktime.make" | "com.apple.quicktime.model" => {
                    let cam = m.camera.get_or_insert_with(Camera::default);
                    if key.ends_with("make") {
                        cam.make = Some(value);
                    } else {
                        cam.model = Some(value);
                    }
                }
                _ => {}
            }
        }
    }
    Some(m)
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn be64(b: &[u8]) -> u64 {
    u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}

/// Finds a top-level box in the file (skipping `mdat` without reading it) and returns the body.
fn find_top<R: Read + Seek>(f: &mut R, len: u64, kind: &[u8; 4]) -> Option<Vec<u8>> {
    let mut pos = 0u64;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos)).ok()?;
        let mut head = [0u8; 16];
        f.read_exact(&mut head[..8]).ok()?;
        let mut size = be32(&head) as u64;
        let mut header = 8;
        if size == 1 {
            f.read_exact(&mut head[8..16]).ok()?;
            size = be64(&head[8..]);
            header = 16;
        } else if size == 0 {
            size = len - pos;
        }
        if size < header {
            return None;
        }
        if &head[4..8] == kind {
            let body = size - header;
            if body > MAX_MOOV {
                return None;
            }
            let mut buf = vec![0u8; body as usize];
            f.read_exact(&mut buf).ok()?;
            return Some(buf);
        }
        pos += size;
    }
    None
}

/// Child boxes (type, body) inside an already read body.
fn boxes(body: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    let mut pos = 0usize;
    std::iter::from_fn(move || {
        if pos + 8 > body.len() {
            return None;
        }
        let mut size = be32(&body[pos..]) as usize;
        let mut header = 8;
        if size == 1 {
            if pos + 16 > body.len() {
                return None;
            }
            size = be64(&body[pos + 8..]) as usize;
            header = 16;
        } else if size == 0 {
            size = body.len() - pos;
        }
        if size < header || pos + size > body.len() {
            return None;
        }
        let item = (&body[pos + 4..pos + 8], &body[pos + header..pos + size]);
        pos += size;
        Some(item)
    })
}

fn child<'a>(body: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(body).find(|(k, _)| *k == kind).map(|(_, b)| b)
}

fn children<'a>(body: &'a [u8], kind: &'a [u8; 4]) -> impl Iterator<Item = &'a [u8]> {
    boxes(body).filter(move |(k, _)| *k == kind).map(|(_, b)| b)
}

/// Apple `meta`: `keys` (names) + `ilst` (values by index, 1-based).
fn apple_keys(meta: &[u8]) -> Vec<(String, String)> {
    // In QuickTime the `meta` has no version/flags; in ISO it does (4 zero bytes).
    let meta = if meta.len() >= 4 && meta[..4] == [0, 0, 0, 0] { &meta[4..] } else { meta };
    let (Some(keys), Some(ilst)) = (child(meta, b"keys"), child(meta, b"ilst")) else { return Vec::new() };
    if keys.len() < 8 {
        return Vec::new();
    }
    let names: Vec<String> = boxes(&keys[8..]).map(|(_, name)| String::from_utf8_lossy(name).to_string()).collect();
    let mut out = Vec::new();
    for (index, item) in boxes(ilst) {
        let i = be32(index) as usize;
        let Some(name) = i.checked_sub(1).and_then(|i| names.get(i)) else { continue };
        // `data`: type (4) + locale (4) + value.
        if let Some(data) = child(item, b"data").filter(|d| d.len() > 8) {
            out.push((name.clone(), String::from_utf8_lossy(&data[8..]).trim_end_matches('\0').to_string()));
        }
    }
    out
}

/// "+37.3318-122.0312+010.000/" → (lat, lon).
fn iso6709(s: &str) -> Option<(f64, f64)> {
    let s = s.trim().trim_end_matches('/');
    let mut parts = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if (c == '+' || c == '-') && !cur.is_empty() {
            parts.push(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    let lat: f64 = parts.first()?.parse().ok()?;
    let lon: f64 = parts.get(1)?.parse().ok()?;
    (lat.abs() <= 90.0 && lon.abs() <= 180.0 && (lat != 0.0 || lon != 0.0)).then_some((lat, lon))
}

// ---- file name ---------------------------------------------------------------

/// Date in the name: 8 digits YYYYMMDD (or YYYY-MM-DD) and, if it comes right after,
/// HHMMSS (or HH-MM-SS / HH.MM.SS). Local time of this device.
fn from_name(name: &str) -> Option<i64> {
    let digits: Vec<(usize, u8)> = name.bytes().enumerate().collect();
    let b = name.as_bytes();
    let num = |from: usize, n: usize| -> Option<u32> {
        let s = b.get(from..from + n)?;
        s.iter().all(u8::is_ascii_digit).then(|| s.iter().fold(0u32, |a, d| a * 10 + (d - b'0') as u32))
    };
    for &(i, _) in &digits {
        // Start of a number (not in the middle of a larger one).
        if i > 0 && b[i - 1].is_ascii_digit() {
            continue;
        }
        let (date, mut j) = if let (Some(y), Some(mo), Some(d)) = (num(i, 4), num(i + 4, 2), num(i + 6, 2)) {
            ((y, mo, d), i + 8)
        } else if let (Some(y), Some(mo), Some(d)) = (num(i, 4), num(i + 5, 2), num(i + 8, 2)) {
            if !matches!(b.get(i + 4), Some(b'-' | b'_' | b'.')) || b.get(i + 7) != b.get(i + 4) {
                continue;
            }
            ((y, mo, d), i + 10)
        } else {
            continue;
        };
        let (y, mo, d) = date;
        if !(1990..=2100).contains(&y) {
            continue;
        }
        let Some(day) = NaiveDate::from_ymd_opt(y as i32, mo, d) else { continue };
        if b.get(j).is_some_and(u8::is_ascii_digit) {
            continue;
        }
        // Separator and time.
        let mut time = (12, 0, 0);
        if matches!(b.get(j), Some(b'_' | b'-' | b' ' | b'T' | b'.')) {
            j += 1;
            if let (Some(h), Some(mi), Some(s)) = (num(j, 2), num(j + 2, 2), num(j + 4, 2)) {
                time = (h, mi, s);
            } else if let (Some(h), Some(mi), Some(s)) = (num(j, 2), num(j + 3, 2), num(j + 6, 2)) {
                if matches!(b.get(j + 2), Some(b'-' | b'.' | b':')) {
                    time = (h, mi, s);
                }
            }
        }
        let naive = day.and_hms_opt(time.0, time.1, time.2).unwrap_or_else(|| day.and_hms_opt(12, 0, 0).unwrap());
        return to_utc(naive, None);
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn motion_photo_from_xmp() {
        let new = br#"<x><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="2345678" Item:Padding="0"/></x>"#;
        assert_eq!(motion_from_xmp(new), Some(2_345_678));
        let old = br#"<x GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="987654"/>"#;
        assert_eq!(motion_from_xmp(old), Some(987_654));
        assert_eq!(motion_from_xmp(b"<x/>"), None);
    }

    use super::*;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
        to_utc(NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, s).unwrap(), None).unwrap()
    }

    #[test]
    fn date_in_name() {
        assert_eq!(from_name("IMG_20240131_123456.jpg"), Some(local(2024, 1, 31, 12, 34, 56)));
        assert_eq!(from_name("PXL_20231225_081500123.mp4"), Some(local(2023, 12, 25, 8, 15, 0)));
        assert_eq!(from_name("Screenshot_2024-02-03-10-20-30.png"), Some(local(2024, 2, 3, 10, 20, 30)));
        assert_eq!(from_name("IMG-20240131-WA0001.jpg"), Some(local(2024, 1, 31, 12, 0, 0)));
        assert_eq!(from_name("2022-06-01 18.30.00.heic"), Some(local(2022, 6, 1, 18, 30, 0)));
        assert_eq!(from_name("foto.jpg"), None);
        assert_eq!(from_name("123456789.jpg"), None);
        assert_eq!(from_name("IMG_99991301.jpg"), None);
    }

    #[test]
    fn timezone_and_coordinates() {
        assert_eq!(parse_offset("-03:00"), Some(-180));
        assert_eq!(parse_offset("+0530"), Some(330));
        assert_eq!(parse_offset("Z"), Some(0));
        assert_eq!(parse_offset("x"), None);
        assert_eq!(iso6709("+37.3318-122.0312+010.000/"), Some((37.3318, -122.0312)));
        assert_eq!(iso6709("-23.5505-046.6333/"), Some((-23.5505, -46.6333)));
        assert_eq!(iso6709("+00.0000+000.0000/"), None);
    }

    #[test]
    fn time_with_timezone_becomes_utc() {
        let naive = NaiveDate::from_ymd_opt(2024, 1, 31).unwrap().and_hms_opt(12, 0, 0).unwrap();
        // 12:00 at -03:00 = 15:00 UTC.
        assert_eq!(to_utc(naive, Some(-180)), Some(naive.and_utc().timestamp_millis() + 3 * 3_600_000));
    }

    /// Minimal MP4: ftyp, mdat and moov with mvhd, a rotated video trak and ©xyz.
    #[test]
    fn video_mp4() {
        fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            v.extend_from_slice(kind);
            v.extend_from_slice(body);
            v
        }
        let mut mvhd = vec![0u8; 100];
        let created = 2_082_844_800u32 + 1_700_000_000; // 2023-11-14 22:13:20 UTC
        mvhd[4..8].copy_from_slice(&created.to_be_bytes());
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&12_500u32.to_be_bytes());
        let mut tkhd = vec![0u8; 84];
        let n = tkhd.len();
        // 90° matrix: a=0, b=0x00010000.
        tkhd[n - 40..n - 36].copy_from_slice(&0x0001_0000u32.to_be_bytes());
        tkhd[n - 8..n - 4].copy_from_slice(&(1920u32 << 16).to_be_bytes());
        tkhd[n - 4..].copy_from_slice(&(1080u32 << 16).to_be_bytes());
        let mut hdlr = vec![0u8; 24];
        hdlr[8..12].copy_from_slice(b"vide");
        let trak = bx(b"trak", &[bx(b"tkhd", &tkhd), bx(b"mdia", &bx(b"hdlr", &hdlr))].concat());
        let mut xyz = vec![0u8, 18, 0x15, 0xc7];
        xyz.extend_from_slice(b"-23.5505-046.6333/");
        let udta = bx(b"udta", &bx(b"\xa9xyz", &xyz));
        let file = [bx(b"ftyp", b"isom\0\0\0\0"), bx(b"mdat", &[0u8; 64]), bx(b"moov", &[bx(b"mvhd", &mvhd), trak, udta].concat())].concat();

        let path = std::env::temp_dir().join(format!("tgphotos-meta-{}.mp4", ulid::Ulid::new()));
        std::fs::write(&path, &file).unwrap();
        let m = read(File::open(&path).ok(), "VID.mp4", "video/mp4");
        let _ = std::fs::remove_file(&path);
        assert_eq!(m.taken, Some(1_700_000_000_000));
        assert_eq!(m.duration, Some(12.5));
        assert_eq!((m.width, m.height), (Some(1080), Some(1920)));
        assert_eq!(m.gps, Some((-23.5505, -46.6333)));

        // Fragmented: zeroed mvhd, the duration in mvex/mehd (15.834 s), and the moov alone
        // (the repair downloads only it) also works.
        let mut mvhd0 = mvhd.clone();
        mvhd0[16..20].copy_from_slice(&0u32.to_be_bytes());
        let mehd = bx(b"mehd", &[0, 0, 0, 0, 0, 0, 0x3d, 0xda]);
        let moov = bx(b"moov", &[bx(b"mvhd", &mvhd0), bx(b"mvex", &mehd)].concat());
        let m = read_bytes(&moov, "VID.mp4", "video/mp4", None);
        assert_eq!(m.duration, Some(15.834));
    }
}
