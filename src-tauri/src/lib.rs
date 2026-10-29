pub mod backup;
pub mod db;
mod device;
mod import;
mod repair;
mod takeout;
pub mod meta;

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

// status, login, vaults, sync and transfers.
tg_app::commands!(Db);

#[tauri::command]
async fn list_vaults(app: State<'_, Core>) -> Result<Vec<VaultView>> {
    app.vaults.list().await
}

#[tauri::command]
async fn convert_vault(_id: i64) -> Result<VaultView> {
    Err(tg_core::codes::FOREIGN_VAULT.into())
}

// ---- library --------------------------------------------------------------------

#[tauri::command]
fn media_list(app: State<'_, Core>, view: View) -> Result<Vec<Media>> {
    app.vaults.db()?.list(view)
}

#[tauri::command]
fn media_details(app: State<'_, Core>, id: i64) -> Result<Option<Details>> {
    app.vaults.db()?.details(id)
}

/// The UI checked when opening whether the photo is "motion" (video bytes at the end; 0 = it is not).
#[tauri::command]
fn media_set_motion(app: State<'_, Core>, id: i64, length: i64) -> Result<()> {
    app.vaults.db()?.set_motion(id, length)
}

#[tauri::command]
fn search(app: State<'_, Core>, text: String) -> Result<Vec<Media>> {
    app.vaults.db()?.search(text.trim())
}

#[tauri::command]
fn usage(app: State<'_, Core>) -> Result<Usage> {
    app.vaults.db()?.usage()
}

#[tauri::command]
async fn shorts_next(app: State<'_, Core>, skip: Vec<i64>, limit: usize) -> Result<Vec<db::Short>> {
    let db = app.vaults.db()?;
    tauri::async_runtime::spawn_blocking(move || db.shorts_next(&skip, limit)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn shorts_liked(app: State<'_, Core>) -> Result<Vec<db::Short>> {
    app.vaults.db()?.shorts_liked()
}

/// Without write permission on the vault: like and view stay on this device only.
#[tauri::command]
fn short_like(app: State<'_, Core>, id: i64, on: bool) -> Result<()> {
    app.vaults.db()?.short_like(id, on, app.vaults.can_write())
}

#[tauri::command]
fn short_view(app: State<'_, Core>, id: i64) -> Result<i64> {
    app.vaults.db()?.short_view(id, app.vaults.can_write())
}

#[tauri::command]
fn set_favorite(app: State<'_, Core>, ids: Vec<i64>, on: bool) -> Result<()> {
    writable(&app)?.set_favorite(&ids, on)
}

#[tauri::command]
fn set_archived(app: State<'_, Core>, ids: Vec<i64>, on: bool) -> Result<()> {
    writable(&app)?.set_archived(&ids, on)
}

#[tauri::command]
fn trash(app: State<'_, Core>, ids: Vec<i64>) -> Result<()> {
    app.vaults.check_trash()?;
    writable(&app)?.set_trashed(&ids, true)
}

#[tauri::command]
fn restore(app: State<'_, Core>, ids: Vec<i64>) -> Result<()> {
    writable(&app)?.set_trashed(&ids, false)
}

/// Capture date in ms (UTC) and the timezone in minutes.
#[tauri::command]
fn set_taken(app: State<'_, Core>, id: i64, taken: i64, tz: Option<i32>) -> Result<()> {
    writable(&app)?.set_taken(id, taken, tz)
}

#[tauri::command]
async fn purge(app: State<'_, Core>, ids: Vec<i64>) -> Result<()> {
    app.vaults.check_trash()?;
    let orphans = writable(&app)?.purge(&ids)?;
    app.tg.delete(&orphans).await
}

#[tauri::command]
async fn empty_trash(app: State<'_, Core>) -> Result<()> {
    app.vaults.check_trash()?;
    let db = writable(&app)?;
    let orphans = db.purge(&db.trashed_ids()?)?;
    app.tg.delete(&orphans).await
}

/// Cleanup when opening: whatever has been in the trash for more than 30 days goes for good.
#[tauri::command]
async fn housekeep(app: State<'_, Core>) -> Result<usize> {
    // Read-only: the cleanup belongs to whoever administers the vault.
    if app.vaults.check_trash().is_err() {
        return Ok(0);
    }
    let db = app.vaults.db()?;
    let expired = db.expired_ids()?;
    if expired.is_empty() {
        return Ok(0);
    }
    let orphans = db.purge(&expired)?;
    app.tg.delete(&orphans).await?;
    Ok(expired.len())
}

// ---- albums -----------------------------------------------------------------------------

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
    let db = writable(&app)?;
    let id = db.album_create(&name)?;
    if !ids.is_empty() {
        db.album_add(id, &ids)?;
    }
    Ok(id)
}

#[tauri::command]
fn album_rename(app: State<'_, Core>, id: i64, name: String) -> Result<()> {
    writable(&app)?.album_rename(id, &name)
}

#[tauri::command]
fn album_delete(app: State<'_, Core>, id: i64) -> Result<()> {
    writable(&app)?.album_delete(id)
}

#[tauri::command]
fn album_add(app: State<'_, Core>, id: i64, ids: Vec<i64>) -> Result<usize> {
    writable(&app)?.album_add(id, &ids)
}

#[tauri::command]
fn album_remove(app: State<'_, Core>, id: i64, ids: Vec<i64>) -> Result<()> {
    writable(&app)?.album_remove(id, &ids)
}

#[tauri::command]
fn album_set_cover(app: State<'_, Core>, id: i64, media: i64) -> Result<()> {
    writable(&app)?.album_set_cover(id, media)
}

// ---- automatic backup ----------------------------------------------------------------

/// Wakes the desktop scan (open vault, change folders, "do it now").
struct BackupKick(Arc<Notify>);

#[tauri::command]
fn backup_folders(app: State<'_, Core>) -> Result<Vec<String>> {
    app.vaults.db()?.backup_folders()
}

#[tauri::command]
async fn backup_set_folder(app: State<'_, Core>, kick: State<'_, BackupKick>, path: String, on: bool) -> Result<usize> {
    if on {
        app.vaults.check_post()?;
    }
    app.vaults.db()?.backup_set_folder(&path, on)?;
    if on {
        kick.0.notify_one();
        return Ok(0);
    }
    // Turned off: whatever came from that folder and has not been uploaded yet leaves the queue. The stored
    // source is relative (Android: "DCIM/Camera"; desktop: relative to the home folder).
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let rel = path.strip_prefix(&home).unwrap_or(&path).trim_start_matches(['/', '\\']).replace('\\', "/");
    app.transfers.cancel_auto_from(&rel).await
}

/// Folders shown in the timeline even without backup.
#[tauri::command]
fn show_folders(app: State<'_, Core>) -> Result<Vec<String>> {
    app.vaults.db()?.show_folders()
}

#[tauri::command]
fn show_set_folder(app: State<'_, Core>, path: String, on: bool) -> Result<()> {
    app.vaults.db()?.show_set_folder(&path, on)
}

/// Desktop: scans the folders now.
#[tauri::command]
async fn backup_scan(app: State<'_, Core>) -> Result<backup::Report> {
    // Without permission nothing is scanned (scanning marks the files as seen, and
    // they would not be uploaded when the permission came).
    if app.vaults.check_trash().is_err() {
        return Ok(backup::Report::default());
    }
    let db = app.vaults.db()?;
    let transfers = Arc::clone(&app.transfers);
    tauri::async_runtime::spawn_blocking(move || backup::scan(&db, &transfers)).await.map_err(|e| e.to_string())?
}

/// Android: media from the chosen folders, listed by MediaStore.
#[tauri::command]
async fn backup_enqueue(app: State<'_, Core>, items: Vec<backup::DeviceItem>, force: Option<bool>) -> Result<backup::Report> {
    // Without permission: the automatic does nothing; the manual explains why.
    if app.vaults.check_trash().is_err() {
        return if force.unwrap_or(false) { Err(tg_app::vaults::NO_POST.into()) } else { Ok(backup::Report::default()) };
    }
    // Off the main thread: thousands of items do not freeze the UI.
    let db = app.vaults.db()?;
    let transfers = Arc::clone(&app.transfers);
    tauri::async_runtime::spawn_blocking(move || backup::enqueue(&db, &transfers, items, force.unwrap_or(false))).await.map_err(|e| e.to_string())?
}

/// Desktop: files from the backup folders that are not in the vault yet.
#[tauri::command]
async fn backup_local(app: State<'_, Core>) -> Result<Vec<backup::LocalItem>> {
    let db = app.vaults.db()?;
    tauri::async_runtime::spawn_blocking(move || backup::local(&db)).await.map_err(|e| e.to_string())?
}

/// Download finished (DCIM/Restored): the media now has the local file
/// (opens without network, native options, does not ask to download again).
#[tauri::command]
fn local_link(app: State<'_, Core>, uid: String, src: String) -> Result<()> {
    let db = app.vaults.db()?;
    let id = db.id_of_uid(&uid).ok_or(tg_core::codes::ITEM_NOT_FOUND)?;
    db.backup_record(&src, id)
}

/// Files downloaded before (DCIM/Restored): those matching a vault media item by name and
/// size become its local original. Returns how many it linked.
#[tauri::command]
fn local_relink(app: State<'_, Core>, items: Vec<backup::DeviceItem>) -> Result<usize> {
    let db = app.vaults.db()?;
    let mut n = 0;
    for i in items {
        if db.is_local_src(&i.uri) {
            continue;
        }
        if let Some(id) = db.find_name_size(&i.name, i.size as i64) {
            db.backup_record(&i.uri, id)?;
            n += 1;
        }
    }
    Ok(n)
}

/// "Delete from vault" through the device folder: the media goes to the vault
/// trash and the file stays (unlinked, out of the automatic backup).
#[tauri::command]
fn exclude_from_vault(app: State<'_, Core>, srcs: Vec<String>) -> Result<usize> {
    let db = writable(&app)?;
    let mut n = 0;
    for s in srcs {
        if db.exclude_from_vault(&s)?.is_some() {
            n += 1;
        }
    }
    Ok(n)
}

/// The local file was deleted/moved on the device: it is no longer a "local original".
#[tauri::command]
fn local_forget(app: State<'_, Core>, srcs: Vec<String>) -> Result<()> {
    app.vaults.db()?.backup_forget(&srcs)
}

/// Only files the app knows: from the backup folders, originals uploaded
/// from here or what it itself sent to the trash.
/// Open vault database for changing the index (write permission only).
fn writable(app: &Core) -> Result<Arc<Db>> {
    app.vaults.check_write()?;
    app.vaults.db()
}

fn local_allowed(db: &Db, path: &str) -> bool {
    backup::in_backup_folder(db, path) || db.is_local_src(path) || db.in_device_trash(path)
}

fn desktop_paths(db: &Db, paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| !p.starts_with("content://") && local_allowed(db, p)).collect()
}

// ---- device trash (unified with the vault's) ----------------------------
//
// Whatever goes to the trash in the app also goes to the device trash (Android:
// system trash; Android < 11: copy kept by the app; desktop: operating system
// trash) and comes back with the restore. The UI does the system
// part and records it here.

/// Records what went to the device trash; returns the vault media
/// linked to those originals (they go to the vault trash along with them).
#[tauri::command]
fn device_trash_add(app: State<'_, Core>, entries: Vec<db::DeviceTrashIn>) -> Result<Vec<i64>> {
    app.vaults.db()?.device_trash_add(&entries)
}

#[tauri::command]
fn device_trash_list(app: State<'_, Core>) -> Result<Vec<db::DeviceTrash>> {
    app.vaults.db()?.device_trash_list()
}

/// Left the device trash; `moved`: restored with another address.
#[tauri::command]
fn device_trash_remove(app: State<'_, Core>, srcs: Vec<String>, moved: Option<Vec<(String, String)>>) -> Result<()> {
    app.vaults.db()?.device_trash_remove(&srcs, &moved.unwrap_or_default())
}

/// Originals on this device linked to vault media.
#[tauri::command]
fn device_links(app: State<'_, Core>) -> Result<Vec<db::DeviceLink>> {
    app.vaults.db()?.device_links()
}

/// Desktop: 1 = the file exists, 0 = gone.
#[tauri::command]
fn local_states(paths: Vec<String>) -> Vec<u8> {
    paths.iter().map(|p| u8::from(!p.starts_with("content://") && std::path::Path::new(p).is_file())).collect()
}

/// Desktop: sends local files to the system trash (the link with the
/// vault stays, for restoring).
#[tauri::command]
async fn local_trash(app: State<'_, Core>, paths: Vec<String>) -> Result<usize> {
    let ok = desktop_paths(&*app.vaults.db()?, paths);
    #[cfg(target_os = "linux")]
    if tg_app::native::in_flatpak() {
        for path in &ok {
            tg_app::native::trash_file(path).await?;
        }
        return Ok(ok.len());
    }
    #[cfg(desktop)]
    {
        trash::delete_all(&ok).map_err(|e| e.to_string())?;
        Ok(ok.len())
    }
    // On Android the deletion goes through the system (MediaStore confirmation request).
    #[cfg(mobile)]
    {
        let _ = ok;
        Err(tg_core::codes::ANDROID_SYSTEM_DELETE.into())
    }
}

/// Free up space (desktop): originals that are already in the vault go to the
/// system trash and are no longer a "local original".
#[tauri::command]
async fn local_free(app: State<'_, Core>, paths: Vec<String>) -> Result<usize> {
    let db = app.vaults.db()?;
    let ok = desktop_paths(&db, paths);
    #[cfg(target_os = "linux")]
    if tg_app::native::in_flatpak() {
        for path in &ok {
            tg_app::native::trash_file(path).await?;
            db.backup_forget(&[path.clone()])?;
        }
        return Ok(ok.len());
    }
    #[cfg(desktop)]
    {
        trash::delete_all(&ok).map_err(|e| e.to_string())?;
        db.backup_forget(&ok)?;
        Ok(ok.len())
    }
    #[cfg(mobile)]
    {
        let _ = ok;
        Err(tg_core::codes::ANDROID_SYSTEM_DELETE.into())
    }
}

/// Items in the operating system trash that came from these paths (the most
/// recent of each).
#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android"))))]
fn os_trashed(paths: &[String]) -> Result<Vec<trash::TrashItem>> {
    let wanted: std::collections::HashSet<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
    let mut best: std::collections::HashMap<std::path::PathBuf, trash::TrashItem> = std::collections::HashMap::new();
    for item in trash::os_limited::list().map_err(|e| e.to_string())? {
        let path = item.original_path();
        if !wanted.contains(&path) {
            continue;
        }
        if best.get(&path).is_none_or(|b| item.time_deleted > b.time_deleted) {
            best.insert(path, item);
        }
    }
    Ok(best.into_values().collect())
}

/// Desktop: returns from the system trash to the original place.
#[tauri::command]
fn local_restore(app: State<'_, Core>, paths: Vec<String>) -> Result<usize> {
    let ok = desktop_paths(&*app.vaults.db()?, paths);
    #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android"))))]
    {
        let items = os_trashed(&ok)?;
        let n = items.len();
        trash::os_limited::restore_all(items).map_err(|e| e.to_string())?;
        Ok(n)
    }
    #[cfg(not(any(target_os = "windows", all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android")))))]
    {
        let _ = ok;
        Err(tg_core::codes::code(tg_core::codes::ANDROID_SYSTEM_DELETE, "restaure pela lixeira do sistema"))
    }
}

/// Desktop: deletes for good from the system trash.
#[tauri::command]
fn local_purge(app: State<'_, Core>, paths: Vec<String>) -> Result<usize> {
    let ok = desktop_paths(&*app.vaults.db()?, paths);
    #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android"))))]
    {
        let items = os_trashed(&ok)?;
        let n = items.len();
        trash::os_limited::purge_all(items).map_err(|e| e.to_string())?;
        Ok(n)
    }
    #[cfg(not(any(target_os = "windows", all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android")))))]
    {
        let _ = ok;
        Ok(0)
    }
}

/// Desktop: opens the local file in the default app, or shows it in the folder.
#[tauri::command]
async fn local_open(handle: tauri::AppHandle, app: State<'_, Core>, path: String, reveal: bool) -> Result<()> {
    if !local_allowed(&*app.vaults.db()?, &path) {
        return Err(tg_core::codes::PATH_NOT_ALLOWED.into())
;
    }
    tg_app::native::open_path(&handle, &path, reveal).await
}

/// State of each device item: 0 = outside the vault, 1 = in the queue, 2 = in the vault.
#[tauri::command]
fn backup_status(app: State<'_, Core>, srcs: Vec<String>) -> Result<Vec<u8>> {
    app.vaults.db()?.backup_status(&srcs)
}

// ---- importing from chats ------------------------------------------------------------------
//
// List of conversations, topics and photos/videos of a chat (tg_core::chats); whatever
// is chosen enters the upload queue (downloads and re-uploads to the vault).

/// Network error/Telegram pause also reports the connection state.
fn chat_err(app: &Core, e: String) -> String {
    if !app.vaults.net().flood(&e) {
        app.vaults.net().report(&e);
    }
    e
}

/// Token of the `/chat/*` routes (chat photo, thumbnails) of this session.
#[tauri::command]
fn chat_token(app: State<'_, Core>) -> String {
    app.chat_token.clone()
}

#[tauri::command]
async fn chats(app: State<'_, Core>, cursor: Option<String>) -> Result<tg_core::chats::ChatPage> {
    app.tg.chats(cursor.as_deref()).await.map_err(|e| chat_err(&app, e))
}

#[tauri::command]
async fn chats_search(app: State<'_, Core>, q: String) -> Result<Vec<tg_core::chats::ChatInfo>> {
    app.tg.search_chats(q.trim()).await.map_err(|e| chat_err(&app, e))
}

#[tauri::command]
async fn chat_topics(app: State<'_, Core>, chat: String) -> Result<Vec<tg_core::chats::Topic>> {
    let chat = tg_core::chats::ChatRef::parse(&chat)?;
    app.tg.topics(&chat).await.map_err(|e| chat_err(&app, e))
}

/// Photos and videos of the chat (or topic), below the `before` message (0 = from the start).
#[tauri::command]
async fn chat_media(app: State<'_, Core>, chat: String, topic: Option<i32>, before: i32) -> Result<tg_core::chats::MediaPage> {
    let chat = tg_core::chats::ChatRef::parse(&chat)?;
    app.tg.chat_media(&chat, topic, before).await.map_err(|e| chat_err(&app, e))
}

/// Chosen: they enter the upload queue; `title` (chat name) stays as the source.
#[tauri::command]
fn chat_import(app: State<'_, Core>, items: Vec<tg_app::transfers::ChatImport>, title: String) -> Result<usize> {
    app.transfers.import_chat(items, &title)
}

/// Token of the `/device` route (device media) of this session.
struct DeviceToken(String);

#[tauri::command]
fn device_token(token: State<'_, DeviceToken>) -> String {
    token.0.clone()
}

// ---- importing from TGDrive ---------------------------------------------------------------

#[tauri::command]
async fn import_sources(foreign: State<'_, Foreign>) -> Result<Vec<ForeignVault>> {
    foreign.vaults().await
}

#[tauri::command]
async fn import_browse(app: State<'_, Core>, foreign: State<'_, Foreign>, vault: i64, fresh: bool) -> Result<Vec<import::Source>> {
    let db = app.vaults.db()?;
    import::browse(&foreign, &db, vault, fresh).await
}

/// Forwards the chosen items; progress through the `import-progress` event.
#[tauri::command]
async fn import_run(
    handle: tauri::AppHandle,
    app: State<'_, Core>,
    foreign: State<'_, Foreign>,
    vault: i64,
    uids: Vec<String>,
    album: i64,
) -> Result<import::Report> {
    let db = writable(&app)?;
    let progress = |done: usize, total: usize| {
        let _ = handle.emit("import-progress", (done, total));
    };
    import::run(&foreign, &app.tg, &db, vault, &uids, album, progress).await
}

// ---- importing from Google Photos (takeout) -----------------------------------------------

/// Reads the chosen .zip files / folders and summarizes what is in them (nothing is uploaded).
#[tauri::command]
async fn takeout_scan(
    handle: tauri::AppHandle,
    app: State<'_, Core>,
    takeout: State<'_, takeout::Takeout>,
    paths: Vec<String>,
    names: std::collections::HashMap<String, String>,
) -> Result<takeout::Summary> {
    let vault = app.vaults.current().map(|o| o.vault_id.clone());
    Ok(takeout.scan(handle, paths, names, app.vaults.dir().clone(), vault).await?)
}

#[tauri::command]
fn takeout_start(handle: tauri::AppHandle, app: State<'_, Core>, takeout: State<'_, takeout::Takeout>, opts: takeout::Opts) -> Result<()> {
    Ok(takeout.start(opts, handle, Arc::clone(&app.tg), Arc::clone(&app.vaults), Arc::clone(&app.transfers))?)
}

/// Repairs videos without duration/dimensions (in the background; one round at a time).
#[tauri::command]
async fn video_repair(handle: tauri::AppHandle, app: State<'_, Core>) -> Result<usize> {
    Ok(repair::videos(&handle, &app.tg, &app.vaults).await?)
}

/// The open video has no duration/dimensions: repairs it now.
#[tauri::command]
async fn video_repair_one(handle: tauri::AppHandle, app: State<'_, Core>, id: i64) -> Result<bool> {
    Ok(repair::one(&handle, &app.tg, &app.vaults, id).await?)
}

#[tauri::command]
fn takeout_status(takeout: State<'_, takeout::Takeout>) -> takeout::Status {
    takeout.status()
}

#[tauri::command]
fn takeout_stop(takeout: State<'_, takeout::Takeout>) {
    takeout.stop()
}

#[tauri::command]
fn takeout_reset(takeout: State<'_, takeout::Takeout>) {
    takeout.reset()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tg_core::log::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_tg_controller::init())
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
            // First scan right at startup (the loop sleeps 5 min between rounds).
            kick.notify_one();
            app.manage(BackupKick(kick));
            app.manage(takeout::Takeout::default());
            app.manage(Foreign::new(Arc::clone(&core.tg), "tgdrive"));
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_environment, startup_window, startup_update, window_menu,
            status,
            client_log,
            set_locale,
            send_code,
            resend_code,
            password_hint,
            sign_in,
            check_password,
            sign_out,
            list_vaults,
            cached_vaults,
            create_vault,
            open_vault,
            unlock_vault,
            rename_vault,
            vault_link,
            cross_destinations,
            cross_locations,
            cross_create_folder,
            cross_send,
            vault_invite_candidate,
            vault_contacts,
            vault_member_photo,
            vault_access,
            vault_members,
            vault_member_change,
            delete_vault,
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
            open_release,
            open_external_url,
            peek_open,
            me,
            upload_uris,
            download_plan,
            download_targets,
            prepare_share,
            media_list,
            media_details,
            search,
            media_set_motion,
            usage,
            set_favorite,
            shorts_next,
            short_like,
            shorts_liked,
            short_view,
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
            local_link,
            local_relink,
            exclude_from_vault,
            local_trash,
            local_free,
            local_restore,
            local_purge,
            local_states,
            local_open,
            device_trash_add,
            device_trash_list,
            device_trash_remove,
            device_links,
            import_sources,
            device_token,
            chat_token,
            chats,
            chats_search,
            chat_topics,
            chat_media,
            chat_import,
            import_browse,
            import_run,
            takeout_scan,
            takeout_start,
            takeout_status,
            takeout_stop,
            takeout_reset,
            video_repair,
            video_repair_one
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o tgphotos");
}
