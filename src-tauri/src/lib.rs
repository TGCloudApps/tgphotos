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

/// Download terminado (DCIM/Restored): a mídia passa a ter o arquivo local
/// (abre sem rede, opções nativas, não pede para baixar de novo).
#[tauri::command]
fn local_link(app: State<'_, Core>, uid: String, src: String) -> Result<()> {
    let db = app.vaults.db()?;
    let id = db.id_of_uid(&uid).ok_or("mídia não encontrada")?;
    db.backup_record(&src, id)
}

/// Arquivos baixados antes (DCIM/Restored): os que batem em nome e tamanho com
/// uma mídia do vault viram o original local dela. Devolve quantos ligou.
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

/// "Excluir do vault" pela pasta do aparelho: a mídia vai para a lixeira do
/// vault e o arquivo fica (sem vínculo, fora do backup automático).
#[tauri::command]
fn exclude_from_vault(app: State<'_, Core>, srcs: Vec<String>) -> Result<usize> {
    let db = app.vaults.db()?;
    let mut n = 0;
    for s in srcs {
        if db.exclude_from_vault(&s)?.is_some() {
            n += 1;
        }
    }
    Ok(n)
}

/// O arquivo local foi apagado/movido no aparelho: deixa de ser "original local".
#[tauri::command]
fn local_forget(app: State<'_, Core>, srcs: Vec<String>) -> Result<()> {
    app.vaults.db()?.backup_forget(&srcs)
}

/// Só arquivos que o app conhece: das pastas de backup, originais enviados
/// daqui ou o que ele mesmo mandou para a lixeira.
fn local_allowed(db: &Db, path: &str) -> bool {
    backup::in_backup_folder(db, path) || db.is_local_src(path) || db.in_device_trash(path)
}

fn desktop_paths(db: &Db, paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| !p.starts_with("content://") && local_allowed(db, p)).collect()
}

// ---- lixeira do aparelho (lixeira unificada com a do vault) ----------------------------
//
// O que vai para a lixeira no app vai junto para a do aparelho (Android:
// lixeira do sistema; Android < 11: cópia guardada pelo app; desktop: lixeira
// do sistema operacional) e volta junto ao restaurar. A interface faz a parte
// do sistema e registra aqui.

/// Registra o que foi para a lixeira do aparelho; devolve as mídias do vault
/// ligadas a esses originais (vão para a lixeira do vault junto).
#[tauri::command]
fn device_trash_add(app: State<'_, Core>, entries: Vec<db::DeviceTrashIn>) -> Result<Vec<i64>> {
    app.vaults.db()?.device_trash_add(&entries)
}

#[tauri::command]
fn device_trash_list(app: State<'_, Core>) -> Result<Vec<db::DeviceTrash>> {
    app.vaults.db()?.device_trash_list()
}

/// Saíram da lixeira do aparelho; `moved`: restaurados com outro endereço.
#[tauri::command]
fn device_trash_remove(app: State<'_, Core>, srcs: Vec<String>, moved: Option<Vec<(String, String)>>) -> Result<()> {
    app.vaults.db()?.device_trash_remove(&srcs, &moved.unwrap_or_default())
}

/// Originais deste aparelho ligados a mídias do vault.
#[tauri::command]
fn device_links(app: State<'_, Core>) -> Result<Vec<db::DeviceLink>> {
    app.vaults.db()?.device_links()
}

/// Desktop: 1 = o arquivo existe, 0 = sumiu.
#[tauri::command]
fn local_states(paths: Vec<String>) -> Vec<u8> {
    paths.iter().map(|p| u8::from(!p.starts_with("content://") && std::path::Path::new(p).is_file())).collect()
}

/// Desktop: manda arquivos locais para a lixeira do sistema (o vínculo com o
/// vault fica, para restaurar).
#[tauri::command]
fn local_trash(app: State<'_, Core>, paths: Vec<String>) -> Result<usize> {
    let ok = desktop_paths(&*app.vaults.db()?, paths);
    #[cfg(desktop)]
    {
        trash::delete_all(&ok).map_err(|e| e.to_string())?;
        Ok(ok.len())
    }
    // No Android a exclusão passa pelo sistema (pedido de confirmação do MediaStore).
    #[cfg(mobile)]
    {
        let _ = ok;
        Err("no Android a exclusão passa pelo sistema".into())
    }
}

/// Liberar espaço (desktop): originais que já estão no vault vão para a
/// lixeira do sistema e deixam de ser "original local".
#[tauri::command]
fn local_free(app: State<'_, Core>, paths: Vec<String>) -> Result<usize> {
    let db = app.vaults.db()?;
    let ok = desktop_paths(&db, paths);
    #[cfg(desktop)]
    {
        trash::delete_all(&ok).map_err(|e| e.to_string())?;
        db.backup_forget(&ok)?;
        Ok(ok.len())
    }
    #[cfg(mobile)]
    {
        let _ = ok;
        Err("no Android a exclusão passa pelo sistema".into())
    }
}

/// Itens da lixeira do sistema operacional que vieram destes caminhos (o mais
/// recente de cada um).
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

/// Desktop: devolve da lixeira do sistema para o lugar de origem.
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
        Err("restaure pela lixeira do sistema".into())
    }
}

/// Desktop: apaga de vez da lixeira do sistema.
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

// ---- importar de chats ------------------------------------------------------------------
//
// Lista de conversas, tópicos e fotos/vídeos de um chat (tg_core::chats); o que
// for escolhido entra na fila de envios (baixa e reenvia ao vault).

/// Erro de rede/pausa do Telegram também avisa o estado de conexão.
fn chat_err(app: &Core, e: String) -> String {
    if !app.vaults.net().flood(&e) {
        app.vaults.net().report(&e);
    }
    e
}

/// Token das rotas `/chat/*` (foto do chat, miniaturas) desta sessão.
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

/// Fotos e vídeos do chat (ou tópico), abaixo da mensagem `before` (0 = do começo).
#[tauri::command]
async fn chat_media(app: State<'_, Core>, chat: String, topic: Option<i32>, before: i32) -> Result<tg_core::chats::MediaPage> {
    let chat = tg_core::chats::ChatRef::parse(&chat)?;
    app.tg.chat_media(&chat, topic, before).await.map_err(|e| chat_err(&app, e))
}

/// Escolhidas: entram na fila de envios; `title` (nome do chat) fica como origem.
#[tauri::command]
fn chat_import(app: State<'_, Core>, items: Vec<tg_app::transfers::ChatImport>, title: String) -> Result<usize> {
    app.transfers.import_chat(items, &title)
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
            vault_link,
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
            import_run
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o tgphotos");
}
