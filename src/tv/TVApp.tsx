import { VaultPermissionNotice } from "@tgcloud/ui/ui/VaultPermissionNotice";
import { canUseVault, useVaultPermission } from "@tgcloud/ui/core/vaultPermissions";
import { closeMenu } from "@tgcloud/ui/desktop/Menu";
import { AlbumActions, AlbumOptions } from "./AlbumOptions";
import { useControllerProfile } from "@tgcloud/ui/tv/controllerProfile";
import { Presence } from "@tgcloud/ui/ui/Presence";
import { Images, Clapperboard, Library, Search, Settings2, Upload, FolderUp, CloudUpload, HardDriveDownload, RefreshCw, LogOut, Plus, Trash2, ArrowDownUp } from "lucide-react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { getPort } from "@tgcloud/ui/core/server";
import { deviceToken } from "../core/local";
import { ExternalPick } from "../shared/ExternalPick";
import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { TVShell, TVOptions, PadAction, PadButton } from "@tgcloud/ui/tv/TVShell";
import { TVContextMenu } from "@tgcloud/ui/tv/TVContextMenu";
import { controllerAction } from "@tgcloud/ui/tv/events";
import { Toasts } from "@tgcloud/ui/desktop/Toasts";
import { uploads } from "@tgcloud/ui/core/uploads";
import { notifyError } from "@tgcloud/ui/core/notices";
import { OfflineBadge } from "@tgcloud/ui/ui/Offline";
import type { Session } from "@tgcloud/ui/ui/Boot";
import { api } from "../core/api";
import { refresh, useAlbums } from "../core/data";
import { nav, useRoute } from "../core/nav";
import { useSelection } from "../core/select";
import { PhotosContent } from "../shared/PhotosContent";
import { PhotoLayers } from "../shared/PhotoLayers";
import { PhotoSelectionActions } from "../shared/PhotoSelectionActions";
import { usePhotosSession } from "../shared/usePhotosSession";
import { pickNative } from "../shared/pickMedia";
import { useOsDrop, useOver } from "../shared/useMediaDrop";
import { t, tc } from "../i18n";

const destinations = [
  { dest: "photos", icon: Images }, { dest: "shorts", icon: Clapperboard },
  { dest: "collections", icon: Library }, { dest: "search", icon: Search },
] as const;

export default function TVApp({ session }: { session: Session }) {
  const canCreateAlbum = useVaultPermission("write");
  const profile = useControllerProfile();
  const remote = (profile.choice === "auto" ? profile.detected : profile.choice) === "remote";
  const route = useRoute();
  const [externalPick, setExternalPick] = useState(() => onAndroid ? android.takePick() : null);
  useEffect(() => {
    if (!onAndroid) return;
    const takePick = () => setExternalPick(android.takePick());
    const receive = () => { const items = android.takeShared(); if (items.length) nav.open({ type: "receive", items }); };
    receive();
    void deviceToken().then(token => android.docsReady(getPort(), token, session.vault.id, session.vault.name));
    window.addEventListener("tg-pick", takePick); window.addEventListener("tg-shared", receive);
    return () => { window.removeEventListener("tg-pick", takePick); window.removeEventListener("tg-shared", receive); };
  }, [session.vault.id, session.vault.name]);
  const input = useRef<HTMLInputElement>(null);
  const [tools, showTools] = useState(false);
  const [uploadChoice, showUploadChoice] = useState(false);
  const [selectionActions, showSelectionActions] = useState(false);
  const selected = useSelection(s => s.ids);
  const feed = route.dest === "shorts" || (route.dest === "liked" && route.at !== undefined);
  const album = route.dest === "album" ? route.album : 0;
  const albums = useAlbums();
  const activeAlbum = albums.data?.find(a => a.id === album);
  const [albumOptions, showAlbumOptions] = useState(false);
  const over = useOver();
  usePhotosSession();
  useOsDrop(album);
  const pick = (folder: boolean) => { if (!canUseVault("write")) return; if (isTauri()) void pickNative(folder, album); else if (input.current) { if (folder) input.current.setAttribute("webkitdirectory", ""); else input.current.removeAttribute("webkitdirectory"); input.current.click(); } };
  const back = () => { if (nav.layers().length) nav.close(); else if (selected.size) useSelection.getState().clear(); else if (route.dest !== "photos") nav.back(); };
  const focused = useRef<HTMLElement | null>(null);
  const dispatch = (key: string) => controllerAction(focused.current, key);
  return <div className="tv-photos tv-feature-shell" onFocusCapture={e => { const tile = (e.target as HTMLElement).closest<HTMLElement>("[data-tv-item]"); if (tile) focused.current = tile; }}>
    <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={e => { if (e.target.files?.length) uploads.add(e.target.files, album); e.target.value = ""; }} />
    <TVShell onOpenTransfers={() => nav.dest("transfers")} title="TGPhotos" primaryLabel={feed ? tc("tv.playPause") : route.dest === "chat" ? tc("common.select") : tc("common.open")} section={album ? albums.data?.find(a => a.id === album)?.name : t(`desktop.dest.${route.dest}`)} onBack={back} onSwitchVault={session.switchVault} contentClass="tv-feature-content" navigation={<>
      {destinations.map(({ dest, icon: Icon }) => <button key={dest} aria-current={route.dest === dest || (dest === "collections" && !["photos", "shorts", "search", "liked"].includes(route.dest)) || (dest === "shorts" && route.dest === "liked") ? "page" : undefined} onClick={() => nav.dest(dest)}><Icon />{t(`desktop.dest.${dest}`)}</button>)}
      {activeAlbum && <><hr /><button onClick={() => showAlbumOptions(true)}><Library />{tc("tv.albumOptions")}</button></>}
      <hr /><button onClick={() => showTools(true)}><Settings2 />{tc("tv.libraryTools")}</button>
    </>} commands={<>{route.dest !== "transfers" && <>{!remote && !feed && !["collections", "chats", "chat", "transfers"].includes(route.dest) && <span className="tv-command" data-tv-hint><PadButton code="LB" /><PadButton code="RB" /><span>{tc("tv.days")}</span></span>}<PadAction code="X" onClick={() => dispatch("x")}>{feed ? t("shorts.like") : tc("common.select")}</PadAction>{feed && <PadAction code="Y" onClick={() => dispatch("y")}>{tc("tv.sound")}</PadAction>}{!feed && selected.size > 0 && <PadAction code="Y" onClick={() => showSelectionActions(true)}>{t("desktop.selected", { n: selected.size })}</PadAction>}</>}</>}>
      <VaultPermissionNotice /><div className="tv-feature-status"><OfflineBadge touch={false} />{route.dest === "search" && <input aria-label={t("desktop.searchPlaceholder")} placeholder={t("desktop.searchPlaceholder")} value={route.query} onChange={e => nav.search(e.target.value)} />}</div>
      <PhotosContent key={`${route.dest}:${album}:${route.device ?? ""}`} pick={pick} over={over} />
    </TVShell>
    <Presence>{tools && <TVOptions title={tc("tv.libraryTools")} onClose={() => showTools(false)}><div className="tv-library-tools" onClick={e => { if ((e.target as HTMLElement).closest("button")) showTools(false); }}><button onClick={() => nav.dest("transfers")}><ArrowDownUp />{t("desktop.dest.transfers")}</button>      <hr /><button disabled={!canUseVault("write")} onClick={() => showUploadChoice(true)}><Upload />{tc("common.upload")}</button>
      <button disabled={!canUseVault("write")} onClick={() => nav.open({ type: "backup" })}><CloudUpload />{t("desktop.backup")}</button><button disabled={!canUseVault("write")} onClick={() => nav.open({ type: "import" })}><HardDriveDownload />{t("desktop.importDrive")}</button><button disabled={!canUseVault("write")} onClick={() => nav.open({ type: "import-google" })}><Images />{t("desktop.importGoogle")}</button>
      {canCreateAlbum && <button onClick={() => nav.open({ type: "name", mode: "album-new", ids: [] })}><Plus />{t("collections.newAlbum")}</button>}

      {route.dest === "trash" && <button disabled={!canUseVault("trash")} onClick={() => nav.open({ type: "confirm", action: "empty", ids: [] })}><Trash2 />{t("desktop.emptyTrash")}</button>}
      <button onClick={() => void api.syncNow().then(refresh).catch(notifyError)}><RefreshCw />{t("desktop.syncNow")}</button><button onClick={() => nav.open({ type: "confirm", action: "signout", ids: [] })}><LogOut />{tc("common.signOut")}</button></div></TVOptions>}</Presence>
    <Presence>{albumOptions && activeAlbum && <AlbumOptions album={activeAlbum} onClose={() => showAlbumOptions(false)} />}</Presence>
    <Presence>{uploadChoice && <TVOptions title={tc("common.upload")} onClose={() => showUploadChoice(false)}><div className="tv-library-tools"><button disabled={!canUseVault("write")} onClick={() => { showUploadChoice(false); pick(false); }}><Images />{t("desktop.uploadMedia")}</button><button disabled={!canUseVault("write")} onClick={() => { showUploadChoice(false); pick(true); }}><FolderUp />{t("desktop.uploadFolder")}</button></div></TVOptions>}</Presence>
    {externalPick && <ExternalPick req={externalPick} touch={false} onClose={() => setExternalPick(null)} />}
    <PhotoLayers onSignedOut={session.signOut} />
    <TVContextMenu sectionLabel={activeAlbum ? tc("tv.mediaSection") : undefined}>{activeAlbum && <><hr /><h3 className="tv-menu-section-title">{tc("tv.albumOptions")} · {activeAlbum.name}</h3><AlbumActions album={activeAlbum} onClose={closeMenu} /></>}</TVContextMenu>
    <Toasts onOpenTransfers={() => nav.dest("transfers")} />
    <Presence>{selectionActions && <TVOptions title={t("desktop.selected", { n: selected.size })} onClose={() => showSelectionActions(false)}><div onClick={e => { if ((e.target as HTMLElement).closest("button")) showSelectionActions(false); }}><PhotoSelectionActions ids={[...selected]} controller /></div></TVOptions>}</Presence>
  </div>;
}
