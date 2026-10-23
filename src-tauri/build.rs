// Embeds the application's MTProto credentials (api_id/api_hash) at compile
// time, read from `config/telegram.local.toml` (gitignored) or from the environment.
fn main() {
    println!("cargo:rerun-if-changed=../config/telegram.local.toml");
    println!("cargo:rerun-if-env-changed=TG_API_ID");
    println!("cargo:rerun-if-env-changed=TG_API_HASH");

    let (mut id, mut hash) = (
        std::env::var("TG_API_ID").ok(),
        std::env::var("TG_API_HASH").ok(),
    );
    if id.is_none() || hash.is_none() {
        if let Ok(content) = std::fs::read_to_string("../config/telegram.local.toml") {
            for line in content.lines() {
                let Some((k, v)) = line.split_once('=') else { continue };
                let v = v.trim().trim_matches('"').to_string();
                match k.trim() {
                    "api_id" => id = Some(v),
                    "api_hash" => hash = Some(v),
                    _ => {}
                }
            }
        }
    }
    let id = id.expect("TG_API_ID ausente (config/telegram.local.toml ou env)");
    let hash = hash.expect("TG_API_HASH ausente (config/telegram.local.toml ou env)");
    println!("cargo:rustc-env=TG_API_ID={id}");
    println!("cargo:rustc-env=TG_API_HASH={hash}");

    tauri_build::build()
}
