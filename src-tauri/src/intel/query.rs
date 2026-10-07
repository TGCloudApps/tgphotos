//! A busca numa caixa só: "gabi praia março de 2023 vídeos". Do texto saem
//! filtros (data, lugar, tipo; o álbum vem da tela) e o que sobra vai para a
//! busca por descrição (SigLIP2) e para os nomes (arquivo, câmera, álbum).
//! Devolve também o que foi entendido, para a interface mostrar como chips.

use chrono::{Datelike, Duration, Local, NaiveDate, TimeZone};
use serde::Serialize;

/// O que a busca entendeu (chips na interface).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Chip {
    /// date | place | kind | album | person
    pub kind: &'static str,
    pub label: String,
    /// O trecho do texto que virou este chip (tirar o chip = tirar o trecho).
    pub text: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    /// Intervalo da captura (ms, UTC).
    pub from: Option<i64>,
    pub to: Option<i64>,
    /// Mês em qualquer ano (1–12), quando o ano não foi dito.
    pub month: Option<u32>,
    /// "image" | "video"
    pub kind: Option<&'static str>,
    pub chips: Vec<Chip>,
    /// O resto, para a busca por descrição e por nome.
    pub rest: String,
}

/// Minúsculas e sem acentos (comparar o que a pessoa digita com nomes de lugar).
pub fn fold(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            c => c,
        })
        .collect()
}

const MONTHS: [(&str, &str); 12] = [
    ("janeiro", "jan"),
    ("fevereiro", "fev"),
    ("marco", "mar"),
    ("abril", "abr"),
    ("maio", "mai"),
    ("junho", "jun"),
    ("julho", "jul"),
    ("agosto", "ago"),
    ("setembro", "set"),
    ("outubro", "out"),
    ("novembro", "nov"),
    ("dezembro", "dez"),
];
const MONTH_NAMES: [&str; 12] = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

fn ms(d: NaiveDate) -> i64 {
    Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).earliest().map(|t| t.timestamp_millis()).unwrap_or(0)
}

fn month_range(y: i32, m: u32) -> (i64, i64) {
    let a = NaiveDate::from_ymd_opt(y, m, 1).unwrap();
    let b = if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) }.unwrap();
    (ms(a), ms(b))
}

/// Lê data e tipo do texto. `today` vem de fora (testes).
pub fn parse(text: &str, today: NaiveDate) -> Parsed {
    let mut p = Parsed::default();
    let words: Vec<String> = text.split_whitespace().map(String::from).collect();
    let folded: Vec<String> = words.iter().map(|w| fold(w).trim_matches(|c: char| !c.is_alphanumeric()).to_string()).collect();
    let mut used = vec![false; words.len()];
    let set_range = |p: &mut Parsed, a: i64, b: i64, label: String, text: String| {
        p.from = Some(a);
        p.to = Some(b);
        p.chips.push(Chip { kind: "date", label, text });
    };
    let span = |a: usize, b: usize| words[a..=b.min(words.len() - 1)].join(" ");

    // Expressões de duas palavras primeiro ("ano passado", "mês passado"…).
    for i in 0..folded.len() {
        if used[i] {
            continue;
        }
        let w = folded[i].as_str();
        let next = folded.get(i + 1).map(|s| s.as_str()).unwrap_or("");
        let two = |used: &mut Vec<bool>| {
            used[i] = true;
            if i + 1 < used.len() {
                used[i + 1] = true;
            }
        };
        match (w, next) {
            ("hoje", _) => {
                used[i] = true;
                set_range(&mut p, ms(today), ms(today + Duration::days(1)), "Hoje".into(), span(i, i));
            }
            ("ontem", _) => {
                used[i] = true;
                set_range(&mut p, ms(today - Duration::days(1)), ms(today), "Ontem".into(), span(i, i));
            }
            ("semana", "passada") => {
                two(&mut used);
                let start = today - Duration::days(today.weekday().num_days_from_monday() as i64 + 7);
                set_range(&mut p, ms(start), ms(start + Duration::days(7)), "Semana passada".into(), span(i, i + 1));
            }
            ("mes", "passado") => {
                two(&mut used);
                let (y, m) = if today.month() == 1 { (today.year() - 1, 12) } else { (today.year(), today.month() - 1) };
                let (a, b) = month_range(y, m);
                set_range(&mut p, a, b, "Mês passado".into(), span(i, i + 1));
            }
            ("ano", "passado") => {
                two(&mut used);
                let y = today.year() - 1;
                set_range(&mut p, ms(NaiveDate::from_ymd_opt(y, 1, 1).unwrap()), ms(NaiveDate::from_ymd_opt(y + 1, 1, 1).unwrap()), y.to_string(), span(i, i + 1));
            }
            ("este" | "esse", "ano") => {
                two(&mut used);
                let y = today.year();
                set_range(&mut p, ms(NaiveDate::from_ymd_opt(y, 1, 1).unwrap()), ms(today + Duration::days(1)), y.to_string(), span(i, i + 1));
            }
            _ => {}
        }
    }

    // Mês (com ou sem ano) e ano sozinho.
    let year_at = |j: usize, used: &Vec<bool>| -> Option<i32> {
        let y: i32 = folded.get(j)?.parse().ok()?;
        ((1900..=2100).contains(&y) && !used[j]).then_some(y)
    };
    if p.from.is_none() {
        for i in 0..folded.len() {
            if used[i] {
                continue;
            }
            let Some(m) = MONTHS.iter().position(|(full, short)| folded[i] == *full || folded[i] == *short) else { continue };
            // "março de 2023", "março 2023"
            let year = if folded.get(i + 1).map(|s| s.as_str()) == Some("de") { year_at(i + 2, &used).map(|y| (y, i + 2)) } else { year_at(i + 1, &used).map(|y| (y, i + 1)) };
            // "mar" sozinho é ambíguo (praia "mar"): só vale como mês com o ano junto.
            if year.is_none() && folded[i].len() <= 3 {
                continue;
            }
            used[i] = true;
            let name = MONTH_NAMES[m];
            match year {
                Some((y, j)) => {
                    used[j] = true;
                    if j == i + 2 {
                        used[i + 1] = true;
                    }
                    let (a, b) = month_range(y, m as u32 + 1);
                    set_range(&mut p, a, b, format!("{name} de {y}"), span(i, j));
                }
                None => {
                    p.month = Some(m as u32 + 1);
                    p.chips.push(Chip { kind: "date", label: format!("{name} (todo ano)"), text: span(i, i) });
                }
            }
            break;
        }
    }
    if p.from.is_none() {
        for i in 0..folded.len() {
            if let Some(y) = year_at(i, &used) {
                used[i] = true;
                set_range(&mut p, ms(NaiveDate::from_ymd_opt(y, 1, 1).unwrap()), ms(NaiveDate::from_ymd_opt(y + 1, 1, 1).unwrap()), y.to_string(), span(i, i));
                break;
            }
        }
    }

    // Tipo.
    for i in 0..folded.len() {
        if used[i] {
            continue;
        }
        let kind = match folded[i].as_str() {
            "video" | "videos" | "filme" | "filmes" => Some(("video", "Vídeos")),
            "foto" | "fotos" | "imagem" | "imagens" => Some(("image", "Fotos")),
            _ => None,
        };
        if let Some((k, label)) = kind {
            used[i] = true;
            p.kind = Some(k);
            p.chips.push(Chip { kind: "kind", label: label.into(), text: span(i, i) });
        }
    }

    // Palavras de ligação soltas não vão para a busca ("de", "em", "no"…).
    const STOP: [&str; 12] = ["de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas", "e", "com"];
    let rest: Vec<&str> = words.iter().zip(&used).zip(&folded).filter(|((_, u), _)| !**u).map(|((w, _), f)| (w.as_str(), f.as_str())).filter(|(_, f)| !f.is_empty()).map(|(w, _)| w).collect();
    let rest: Vec<&str> = {
        let only_stop = rest.iter().all(|w| STOP.contains(&fold(w).as_str()));
        if only_stop { Vec::new() } else { rest }
    };
    p.rest = rest.join(" ");
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, dd).unwrap()
    }

    #[test]
    fn datas_e_tipos() {
        let today = d(2026, 10, 7);
        let p = parse("praia março de 2023", today);
        assert_eq!(p.rest, "praia");
        assert_eq!(p.from, Some(month_range(2023, 3).0));
        assert_eq!(p.chips[0].label, "março de 2023");

        let p = parse("vídeos do ano passado", today);
        assert_eq!(p.kind, Some("video"));
        assert_eq!(p.chips.iter().find(|c| c.kind == "date").unwrap().label, "2025");
        assert_eq!(p.rest, "");

        let p = parse("aniversário dezembro", today);
        assert_eq!((p.month, p.rest.as_str()), (Some(12), "aniversário"));

        // "mar" sem ano é a palavra, não o mês.
        let p = parse("pôr do sol no mar", today);
        assert_eq!((p.month, p.from, p.rest.as_str()), (None, None, "pôr do sol no mar"));

        let p = parse("ontem", today);
        assert_eq!(p.to.unwrap() - p.from.unwrap(), 86_400_000);
    }
}
