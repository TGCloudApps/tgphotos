pub mod backup;
pub mod db;
pub mod intel;
mod device;
mod import;
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
async fn shorts_next(app: State<'_, Core>, skip: Vec<i64>, limit: usize) -> Result<Vec<db::Short>> {
    let db = app.vaults.db()?;
    tauri::async_runtime::spawn_blocking(move || db.shorts_next(&skip, limit)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn shorts_liked(app: State<'_, Core>) -> Result<Vec<db::Short>> {
    app.vaults.db()?.shorts_liked()
}

/// Sem permissão de escrever no vault: curtida e visualização ficam só neste aparelho.
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
    writable(&app)?.set_trashed(&ids, true)
}

#[tauri::command]
fn restore(app: State<'_, Core>, ids: Vec<i64>) -> Result<()> {
    writable(&app)?.set_trashed(&ids, false)
}

/// Data da captura em ms (UTC) e o fuso em minutos.
#[tauri::command]
fn set_taken(app: State<'_, Core>, id: i64, taken: i64, tz: Option<i32>) -> Result<()> {
    writable(&app)?.set_taken(id, taken, tz)
}

#[tauri::command]
async fn purge(app: State<'_, Core>, ids: Vec<i64>) -> Result<()> {
    let orphans = writable(&app)?.purge(&ids)?;
    app.tg.delete(&orphans).await
}

#[tauri::command]
async fn empty_trash(app: State<'_, Core>) -> Result<()> {
    let db = writable(&app)?;
    let orphans = db.purge(&db.trashed_ids()?)?;
    app.tg.delete(&orphans).await
}

/// Limpeza ao abrir: o que está na lixeira há mais de 30 dias sai de vez.
#[tauri::command]
async fn housekeep(app: State<'_, Core>) -> Result<usize> {
    // Só leitura: a limpeza é de quem administra o vault.
    if !app.vaults.can_write() {
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

// ---- backup automático ----------------------------------------------------------------

/// Acorda a varredura do desktop (abrir vault, mudar pastas, "fazer agora").
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
    // Desligou: o que veio dessa pasta e ainda não subiu sai da fila. A origem
    // guardada é relativa (Android: "DCIM/Camera"; desktop: relativa à pasta pessoal).
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let rel = path.strip_prefix(&home).unwrap_or(&path).trim_start_matches(['/', '\\']).replace('\\', "/");
    app.transfers.cancel_auto_from(&rel).await
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
    // Sem permissão, nada é varrido (varrer marca os arquivos como vistos, e
    // eles não subiriam quando a permissão viesse).
    if !app.vaults.can_write() {
        return Ok(backup::Report::default());
    }
    let db = app.vaults.db()?;
    let transfers = Arc::clone(&app.transfers);
    tauri::async_runtime::spawn_blocking(move || backup::scan(&db, &transfers)).await.map_err(|e| e.to_string())?
}

/// Android: mídias das pastas escolhidas, listadas pelo MediaStore.
#[tauri::command]
async fn backup_enqueue(app: State<'_, Core>, items: Vec<backup::DeviceItem>, force: Option<bool>) -> Result<backup::Report> {
    // Sem permissão: o automático não faz nada; o manual explica por quê.
    if !app.vaults.can_write() {
        return if force.unwrap_or(false) { Err(tg_app::vaults::NO_POST.into()) } else { Ok(backup::Report::default()) };
    }
    // Fora da thread principal: milhares de itens não congelam a interface.
    let db = app.vaults.db()?;
    let transfers = Arc::clone(&app.transfers);
    tauri::async_runtime::spawn_blocking(move || backup::enqueue(&db, &transfers, items, force.unwrap_or(false))).await.map_err(|e| e.to_string())?
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
    let db = writable(&app)?;
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
/// Banco do vault aberto para alterar o índice (só com permissão de escrita).
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
    let db = writable(&app)?;
    let progress = |done: usize, total: usize| {
        let _ = handle.emit("import-progress", (done, total));
    };
    import::run(&foreign, &app.tg, &db, vault, &uids, album, progress).await
}

// ---- inteligência de mídia ---------------------------------------------------------------

/// A busca da caixa única (data, lugar, tipo, álbum, descrição, nomes).
#[tauri::command]
async fn intel_query(intel: State<'_, Arc<intel::Intel>>, text: String, album: Option<i64>) -> Result<intel::SearchResult> {
    intel.query(&text, album).await
}

// ---- pessoas -----------------------------------------------------------------------------

#[tauri::command]
fn people_list(app: State<'_, Core>) -> Result<Vec<intel::people::Person>> {
    app.vaults.db()?.local(|c| intel::people::list(c))
}

#[tauri::command]
fn person_media(app: State<'_, Core>, uid: String) -> Result<Vec<Media>> {
    app.vaults.db()?.query(
        &format!("SELECT {} FROM media m WHERE m.trashed_at IS NULL AND m.uid IN (SELECT media_uid FROM intel_face WHERE person_uid = ?1) ORDER BY m.taken_at DESC", db::COLS_M),
        [uid],
    )
}

#[tauri::command]
fn person_rename(app: State<'_, Core>, intel: State<'_, Arc<intel::Intel>>, uid: String, name: String) -> Result<()> {
    app.vaults.db()?.local(|c| intel::people::rename(c, &uid, &name))?;
    intel.people_changed();
    Ok(())
}

#[tauri::command]
fn person_hide(app: State<'_, Core>, uid: String, on: bool) -> Result<()> {
    app.vaults.db()?.local(|c| intel::people::hide(c, &uid, on))
}

#[tauri::command]
fn person_cover(app: State<'_, Core>, uid: String, face: i64) -> Result<()> {
    app.vaults.db()?.local(|c| intel::people::set_cover(c, &uid, face))
}

#[tauri::command]
fn person_merge(app: State<'_, Core>, intel: State<'_, Arc<intel::Intel>>, into: String, from: Vec<String>) -> Result<()> {
    app.vaults.db()?.local(|c| intel::people::merge(c, &into, &from))?;
    intel.people_changed();
    Ok(())
}

#[tauri::command]
fn face_reject(app: State<'_, Core>, intel: State<'_, Arc<intel::Intel>>, face: i64) -> Result<()> {
    app.vaults.db()?.local(|c| intel::people::reject(c, face))?;
    intel.people_changed();
    Ok(())
}

/// Rosto para uma pessoa (`person`) ou uma pessoa nova com `name`.
#[tauri::command]
fn face_put(app: State<'_, Core>, intel: State<'_, Arc<intel::Intel>>, face: i64, person: Option<String>, name: Option<String>) -> Result<String> {
    let uid = app.vaults.db()?.local(|c| intel::people::put(c, face, person.as_deref(), name.as_deref()))?;
    intel.people_changed();
    Ok(uid)
}

#[tauri::command]
fn media_faces(app: State<'_, Core>, id: i64) -> Result<Vec<intel::people::MediaFace>> {
    let db = app.vaults.db()?;
    let Some(uid) = db.uid(id) else { return Ok(Vec::new()) };
    db.local(|c| intel::people::of_media(c, &uid))
}

/// Grupos de duplicatas (fora os que a pessoa decidiu manter).
#[tauri::command]
async fn dup_groups(app: State<'_, Core>) -> Result<Vec<intel::dups::Group>> {
    let db = app.vaults.db()?;
    tauri::async_runtime::spawn_blocking(move || db.local(|c| intel::dups::groups(c))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn dup_keep(app: State<'_, Core>, key: String) -> Result<()> {
    app.vaults.db()?.local(|c| intel::dups::keep(c, &key))
}

#[tauri::command]
fn intel_status(intel: State<'_, Arc<intel::Intel>>) -> intel::Status {
    intel.status()
}

#[tauri::command]
fn intel_set(intel: State<'_, Arc<intel::Intel>>, settings: intel::governor::Settings) {
    intel.set_settings(settings);
}

/// Estado de energia do aparelho (Android, pela ponte; a cada minuto e ao mudar).
#[tauri::command]
fn intel_power(intel: State<'_, Arc<intel::Intel>>, power: intel::governor::Power) {
    intel.set_power(power);
}

/// A pessoa está rolando ou vendo vídeo: os trabalhadores dão licença.
#[tauri::command]
fn intel_touch(intel: State<'_, Arc<intel::Intel>>) {
    intel.gov.touch();
}

/// Mídias na tela vão para a frente da fila.
#[tauri::command]
fn intel_boost(intel: State<'_, Arc<intel::Intel>>, ids: Vec<i64>) {
    intel.boost(&ids);
}

/// "Processar agora": ignora bateria e modo por uma hora (não a temperatura).
#[tauri::command]
fn intel_rush(intel: State<'_, Arc<intel::Intel>>, on: bool) {
    intel.rush(on);
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
            let intel_cell = device::IntelCell::default();
            let extra = device::router(app.handle().clone(), token.clone(), Arc::clone(&cell), Arc::clone(&intel_cell), app.path().app_cache_dir()?.join("localthumbs"));
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
            // Inteligência de mídia: um trabalhador em segundo plano, com orçamento de energia.
            let intel = intel::Intel::new(Arc::clone(&core.vaults), Arc::clone(&core.tg), app.path().app_data_dir()?, app.path().app_cache_dir()?.join("thumbs"));
            intel.spawn();
            let _ = intel_cell.set(Arc::clone(&intel));
            app.manage(intel);
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
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
            intel_status,
            intel_query,
            people_list,
            person_media,
            person_rename,
            person_hide,
            person_cover,
            person_merge,
            face_reject,
            face_put,
            media_faces,
            dup_groups,
            dup_keep,
            intel_set,
            intel_power,
            intel_touch,
            intel_boost,
            intel_rush,
            peek_open,
            me,
            upload_uris,
            download_plan,
            download_targets,
            prepare_share,
            media_list,
            media_details,
            search,
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
            import_run
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o tgphotos");
}
