mod backup;
mod db;
mod device;
mod import;
mod meta;

use std::sync::Arc;

use tauri::{Emitter, Manager, State};
use tokio::sync::Notify;
use tg_app::{AppSpec, Foreign, ForeignVault, VaultView};

use db::{Album, Db, Details, Media, Result, Usage, View};

const SPEC: AppSpec = AppSpec {
    app: "tgphotos",
    name: "TGPhotos",
    about: "Vault do TGPhotos. Não apague nem desafixe a primeira mensagem.",
};

// status, login, vaults, sincronização e transferências.
tg_app::commands!(Db);

#[tauri::command]
async fn list_vaults(app: State<'_, Core>) -> Result<Vec<VaultView>> {
    app.vaults.list().await
}

#[tauri::command]
async fn convert_vault(_id: i64) -> Result<VaultView> {
    Err("o TGPhotos não converte canais de outro formato".into())
}

// ---- biblioteca --------------------------------------------------------------------

#[tauri::command]
fn media_list(app: State<'_, Core>, view: View) -> Result<Vec<Media>> {
    app.vaults.db()?.list(view)
}

#[tauri::command]
fn media_details(app: State<'_, Core>, id: i64) -> Result<Option<Details>> {
    app.vaults.db()?.details(id)
}

#[tauri::command]
fn search(app: State<'_, Core>, text: String) -> Result<Vec<Media>> {
    app.vaults.db()?.search(text.trim(), 500)
}

#[tauri::command]
fn usage(app: State<'_, Core>) -> Result<Usage> {
    app.vaults.db()?.usage()
}

#[tauri::command]
fn set_favorite(app: State<'_, Core>, ids: Vec<i64>, on: bool) -> Result<()> {
    app.vaults.db()?.set_favorite(&ids, on)
}

#[tauri::command]
fn set_archived(app: State<'_, Core>, ids: Vec<i64>, on: bool) -> Result<()> {
    app.vaults.db()?.set_archived(&ids, on)
}

#[tauri::command]
fn trash(app: State<'_, Core>, ids: Vec<i64>) -> Result<()> {
    app.vaults.db()?.set_trashed(&ids, true)
}

#[tauri::command]
fn restore(app: State<'_, Core>, ids: Vec<i64>) -> Result<()> {
    app.vaults.db()?.set_trashed(&ids, false)
}

/// Data da captura em ms (UTC) e o fuso em minutos.
#[tauri::command]
fn set_taken(app: State<'_, Core>, id: i64, taken: i64, tz: Option<i32>) -> Result<()> {
    app.vaults.db()?.set_taken(id, taken, tz)
}

#[tauri::command]
async fn purge(app: State<'_, Core>, ids: Vec<i64>) -> Result<()> {
    let orphans = app.vaults.db()?.purge(&ids)?;
    app.tg.delete(&orphans).await
}

#[tauri::command]
async fn empty_trash(app: State<'_, Core>) -> Result<()> {
    let db = app.vaults.db()?;
    let orphans = db.purge(&db.trashed_ids()?)?;
    app.tg.delete(&orphans).await
}

/// Limpeza ao abrir: o que está na lixeira há mais de 30 dias sai de vez.
#[tauri::command]
async fn housekeep(app: State<'_, Core>) -> Result<usize> {
    let db = app.vaults.db()?;
    let expired = db.expired_ids()?;
    if expired.is_empty() {
        return Ok(0);
    }
    let orphans = db.purge(&expired)?;
    app.tg.delete(&orphans).await?;
    Ok(expired.len())
}

// ---- álbuns -----------------------------------------------------------------------------

#[tauri::command]
fn albums(app: State<'_, Core>) -> Result<Vec<Album>> {
    app.vaults.db()?.albums()
}

#[tauri::command]
fn album_media(app: State<'_, Core>, id: i64) -> Result<Vec<Media>> {
    app.vaults.db()?.album_media(id)
}

#[tauri::command]
fn album_create(app: State<'_, Core>, name: String, ids: Vec<i64>) -> Result<i64> {
    let db = app.vaults.db()?;
    let id = db.album_create(&name)?;
    if !ids.is_empty() {
        db.album_add(id, &ids)?;
    }
    Ok(id)
}

#[tauri::command]
fn album_rename(app: State<'_, Core>, id: i64, name: String) -> Result<()> {
    app.vaults.db()?.album_rename(id, &name)
}

#[tauri::command]
fn album_delete(app: State<'_, Core>, id: i64) -> Result<()> {
    app.vaults.db()?.album_delete(id)
}

#[tauri::command]
fn album_add(app: State<'_, Core>, id: i64, ids: Vec<i64>) -> Result<usize> {
    app.vaults.db()?.album_add(id, &ids)
}

#[tauri::command]
fn album_remove(app: State<'_, Core>, id: i64, ids: Vec<i64>) -> Result<()> {
    app.vaults.db()?.album_remove(id, &ids)
}

#[tauri::command]
fn album_set_cover(app: State<'_, Core>, id: i64, media: i64) -> Result<()> {
    app.vaults.db()?.album_set_cover(id, media)
}

// ---- backup automático ----------------------------------------------------------------

/// Acorda a varredura do desktop (abrir vault, mudar pastas, "fazer agora").
struct BackupKick(Arc<Notify>);

#[tauri::command]
fn backup_folders(app: State<'_, Core>) -> Result<Vec<String>> {
    app.vaults.db()?.backup_folders()
}

#[tauri::command]
fn backup_set_folder(app: State<'_, Core>, kick: State<'_, BackupKick>, path: String, on: bool) -> Result<()> {
    app.vaults.db()?.backup_set_folder(&path, on)?;
    if on {
        kick.0.notify_one();
    }
    Ok(())
}

/// Pastas mostradas na linha do tempo mesmo sem backup.
#[tauri::command]
fn show_folders(app: State<'_, Core>) -> Result<Vec<String>> {
    app.vaults.db()?.show_folders()
}

#[tauri::command]
fn show_set_folder(app: State<'_, Core>, path: String, on: bool) -> Result<()> {
    app.vaults.db()?.show_set_folder(&path, on)
}

/// Desktop: varre as pastas agora.
#[tauri::command]
async fn backup_scan(app: State<'_, Core>) -> Result<backup::Report> {
    let db = app.vaults.db()?;
    let transfers = Arc::clone(&app.transfers);
    tauri::async_runtime::spawn_blocking(move || backup::scan(&db, &transfers)).await.map_err(|e| e.to_string())?
}

/// Android: mídias das pastas escolhidas, listadas pelo MediaStore.
#[tauri::command]
fn backup_enqueue(app: State<'_, Core>, items: Vec<backup::DeviceItem>, force: Option<bool>) -> Result<backup::Report> {
    backup::enqueue(&*app.vaults.db()?, &app.transfers, items, force.unwrap_or(false))
}

/// Desktop: arquivos das pastas de backup que ainda não estão no vault.
#[tauri::command]
async fn backup_local(app: State<'_, Core>) -> Result<Vec<backup::LocalItem>> {
    let db = app.vaults.db()?;
    tauri::async_runtime::spawn_blocking(move || backup::local(&db)).await.map_err(|e| e.to_string())?
}

/// O arquivo local foi apagado/movido no aparelho: deixa de ser "original local".
#[tauri::command]
fn local_forget(app: State<'_, Core>, srcs: Vec<String>) -> Result<()> {
    app.vaults.db()?.backup_forget(&srcs)
}

/// Só arquivos que o app conhece: das pastas de backup ou originais enviados daqui.
fn local_allowed(db: &Db, path: &str) -> bool {
    backup::in_backup_folder(db, path) || db.is_local_src(path)
}

/// Desktop: manda arquivos locais para a lixeira do sistema.
#[tauri::command]
fn local_trash(app: State<'_, Core>, paths: Vec<String>) -> Result<usize> {
    let db = app.vaults.db()?;
    let ok: Vec<String> = paths.into_iter().filter(|p| local_allowed(&db, p) && !p.starts_with("content://")).collect();
    #[cfg(desktop)]
    {
        trash::delete_all(&ok).map_err(|e| e.to_string())?;
        db.backup_forget(&ok)?;
        Ok(ok.len())
    }
    // No Android a exclusão passa pelo sistema (pedido de confirmação do MediaStore).
    #[cfg(mobile)]
    {
        let _ = ok;
        Err("no Android a exclusão passa pelo sistema".into())
    }
}

/// Desktop: abre o arquivo local no app padrão, ou mostra na pasta.
#[tauri::command]
fn local_open(handle: tauri::AppHandle, app: State<'_, Core>, path: String, reveal: bool) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    if !local_allowed(&*app.vaults.db()?, &path) {
        return Err("arquivo fora das pastas conhecidas".into());
    }
    if reveal {
        handle.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
    } else {
        handle.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())
    }
}

/// Situação de cada item do aparelho: 0 = fora do vault, 1 = na fila, 2 = no vault.
#[tauri::command]
fn backup_status(app: State<'_, Core>, srcs: Vec<String>) -> Result<Vec<u8>> {
    app.vaults.db()?.backup_status(&srcs)
}

/// Token da rota `/device` (mídias do aparelho) desta sessão.
struct DeviceToken(String);

#[tauri::command]
fn device_token(token: State<'_, DeviceToken>) -> String {
    token.0.clone()
}

// ---- importar do TGDrive ---------------------------------------------------------------

#[tauri::command]
async fn import_sources(foreign: State<'_, Foreign>) -> Result<Vec<ForeignVault>> {
    foreign.vaults().await
}

#[tauri::command]
async fn import_browse(app: State<'_, Core>, foreign: State<'_, Foreign>, vault: i64, fresh: bool) -> Result<Vec<import::Source>> {
    let db = app.vaults.db()?;
    import::browse(&foreign, &db, vault, fresh).await
}

/// Encaminha os itens escolhidos; progresso pelo evento `import-progress`.
#[tauri::command]
async fn import_run(
    handle: tauri::AppHandle,
    app: State<'_, Core>,
    foreign: State<'_, Foreign>,
    vault: i64,
    uids: Vec<String>,
    album: i64,
) -> Result<import::Report> {
    let db = app.vaults.db()?;
    let progress = |done: usize, total: usize| {
        let _ = handle.emit("import-progress", (done, total));
    };
    import::run(&foreign, &app.tg, &db, vault, &uids, album, progress).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            let api_id = env!("TG_API_ID").parse().expect("TG_API_ID numérico");
            let token = device::token();
            let cell = device::VaultsCell::default();
            let extra = device::router(app.handle().clone(), token.clone(), Arc::clone(&cell), app.path().app_cache_dir()?.join("localthumbs"));
            let core = tg_app::Core::<Db>::start(app, SPEC, api_id, env!("TG_API_HASH"), extra)?;
            let _ = cell.set(Arc::clone(&core.vaults));
            app.manage(DeviceToken(token));
            let kick = Arc::new(Notify::new());
            #[cfg(desktop)]
            backup::spawn_loop(Arc::clone(&core.vaults), Arc::clone(&core.transfers), Arc::clone(&kick));
            // Primeira varredura logo ao subir (o laço dorme 5 min entre rodadas).
            kick.notify_one();
            app.manage(BackupKick(kick));
            app.manage(Foreign::new(Arc::clone(&core.tg), "tgdrive"));
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            send_code,
            sign_in,
            check_password,
            sign_out,
            list_vaults,
            cached_vaults,
            create_vault,
            open_vault,
            unlock_vault,
            rename_vault,
            copy_to_vault,
            copies,
            copies_clear,
            vault_remember_key,
            convert_vault,
            close_vault,
            sync_now,
            kick_sync,
            transfers,
            upload_paths,
            download,
            download_to,
            transfer_pause,
            transfer_resume,
            transfer_cancel,
            transfer_remove,
            transfers_bulk,
            transfer_open,
            upload_uris,
            download_plan,
            download_targets,
            prepare_share,
            media_list,
            media_details,
            search,
            usage,
            set_favorite,
            set_archived,
            trash,
            restore,
            set_taken,
            purge,
            empty_trash,
            housekeep,
            albums,
            album_media,
            album_create,
            album_rename,
            album_delete,
            album_add,
            album_remove,
            album_set_cover,
            backup_folders,
            backup_set_folder,
            backup_scan,
            backup_enqueue,
            backup_status,
            show_folders,
            show_set_folder,
            backup_local,
            local_forget,
            local_trash,
            local_open,
            import_sources,
            device_token,
            import_browse,
            import_run
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o tgphotos");
}
