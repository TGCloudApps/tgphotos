//! Energia no desktop (no Android, a interface informa pela ponte). Notebook:
//! bateria e carregador lidos do sistema; computador sem bateria: "na tomada"
//! sempre, e a interface esconde as opções de bateria.

use super::governor::Power;

/// Estado atual; `None` = sem bateria (computador de mesa) ou não deu para ler.
#[cfg(target_os = "linux")]
pub fn read() -> Option<Power> {
    let dir = std::fs::read_dir("/sys/class/power_supply").ok()?;
    let mut battery = None;
    let mut online = false;
    for e in dir.flatten() {
        let p = e.path();
        let kind = std::fs::read_to_string(p.join("type")).unwrap_or_default();
        match kind.trim() {
            "Battery" => {
                // Bateria de periférico (mouse, fone) não conta.
                if std::fs::read_to_string(p.join("scope")).is_ok_and(|s| s.trim() == "Device") {
                    continue;
                }
                let cap: u8 = std::fs::read_to_string(p.join("capacity")).ok()?.trim().parse().ok()?;
                let status = std::fs::read_to_string(p.join("status")).unwrap_or_default();
                battery = Some((cap, matches!(status.trim(), "Charging" | "Full" | "Not charging")));
            }
            "Mains" | "USB" => online |= std::fs::read_to_string(p.join("online")).is_ok_and(|s| s.trim() == "1"),
            _ => {}
        }
    }
    let (cap, charging) = battery?;
    Some(Power { charging: charging || online, battery: cap, ..Power::default() })
}

#[cfg(target_os = "windows")]
pub fn read() -> Option<Power> {
    #[repr(C)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }
    extern "system" {
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }
    let mut s = SystemPowerStatus { ac_line_status: 255, battery_flag: 255, battery_life_percent: 255, system_status_flag: 0, battery_life_time: 0, battery_full_life_time: 0 };
    // SAFETY: estrutura do tamanho e layout que a API espera.
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
        return None;
    }
    // 128 = sem bateria; 255 = desconhecido.
    if s.battery_flag & 128 != 0 || s.battery_flag == 255 || s.battery_life_percent > 100 {
        return None;
    }
    Some(Power { charging: s.ac_line_status == 1, battery: s.battery_life_percent, saver: s.system_status_flag & 1 != 0, ..Power::default() })
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub fn read() -> Option<Power> {
    None
}
