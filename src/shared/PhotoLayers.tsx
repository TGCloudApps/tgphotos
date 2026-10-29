import { canUseVault, useVaultPermission } from "@tgcloud/ui/core/vaultPermissions";
import { detectShell } from "@tgcloud/ui/core/platform";
import { TVOptions } from "@tgcloud/ui/tv/TVShell";
import { DeviceViewer } from "../mobile/Device";
import { DeviceMoveSheet, DeviceRenameSheet, ReceiveSheet } from "../mobile/Sheets";
import { FetchDialog } from "./FetchDialog";
/** Photo dialogs and the real lightbox, composed by desktop and controller shells. */
import { PresenceList } from "@tgcloud/ui/ui/Presence";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Eye, FolderOpen, FolderPlus, Plus, X } from "lucide-react";
import { notifyError } from "@tgcloud/ui/core/notices";
import { Button, Dialog, Field, IconButton } from "@tgcloud/ui/desktop/ui";
import { loadFolders, runBackup, setFolder, setShown, useBackup } from "../core/backup";
import { actions, useAlbums } from "../core/data";
import { nav, useLayers, type Layer } from "../core/nav";
import { AlbumCover, albumPeriod } from "../shared/Collections";
import { ImportView } from "../shared/Import";
import { GoogleImportView } from "../shared/GoogleImport";
import { SendToVault } from "@tgcloud/ui/ui/SendToVault";
import { FreeSpaceView, OutOfSyncView, type Btn } from "../shared/DeviceSync";
import { Viewer } from "../shared/Viewer";
import { t, tc } from "../i18n";

/** Desktop layers: dialogs and the lightbox (below a dialog opened on it). */
export function PhotoLayers({ onSignedOut }: { onSignedOut: () => void }) {
  const layers = useLayers();
  const top = layers[layers.length - 1];
  const viewer = layers.find((l): l is Extract<Layer, { type: "viewer" }> => l.type === "viewer");
  const deviceViewer = layers.find((l): l is Extract<Layer, { type: "device-viewer" }> => l.type === "device-viewer");
  // Each one leaves with an animation before unmounting.
  const items = [
    ...(deviceViewer ? [{ key: "device-viewer", node: <DeviceViewer layer={deviceViewer} />, instant: true }] : []),
    ...(viewer ? [{ key: "viewer", node: <Viewer layer={viewer} touch={false} />, instant: true }] : []),
    ...(top && top.type !== "viewer" && top.type !== "device-viewer" ? [{ key: `${layers.length}-${top.type}`, node: <PhotoLayer top={top} onSignedOut={onSignedOut} /> }] : []),
  ];
  return <PresenceList items={items} />;
}

function PhotoLayer({ top, onSignedOut }: { top: Layer; onSignedOut: () => void }) {
  switch (top.type) {
    case "fetch": return <FetchDialog id={top.id} how={top.how} />;
    case "receive": return <ReceiveSheet layer={top} />;
    case "device-move": return <DeviceMoveSheet uris={top.uris} />;
    case "device-rename": return <DeviceRenameSheet uri={top.uri} name={top.name} />;
    case "album-pick":
      return <AlbumPickDialog ids={top.ids} />;
    case "name":
      return <NameDialog layer={top} />;
    case "confirm":
      return <ConfirmDialog layer={top} onSignedOut={onSignedOut} />;
    case "backup":
      return <BackupDialog />;
    case "send-vault":
      return <SendToVault ids={top.ids} other={top.other} chooseApp={top.chooseApp} touch={false} onClose={nav.close} />;
    case "out-of-sync":
      return (
        <Dialog onClose={nav.close} width={520}>
          <h2 className="pb-3 text-[16px] font-semibold">{t("dialogs.outOfSync")}</h2>
          <OutOfSyncView button={deskBtn} done={nav.close} />
        </Dialog>
      );
    case "free-space":
      return (
        <Dialog onClose={nav.close} width={460}>
          <h2 className="pb-3 text-[16px] font-semibold">{t("dialogs.freeSpace")}</h2>
          <FreeSpaceView button={deskBtn} done={nav.close} />
        </Dialog>
      );
    case "import":
      if (detectShell() === "tv") return <TVOptions className="tv-import-panel" title={t("dialogs.importDrive")} onClose={nav.close}><ImportView touch={false} /></TVOptions>;
      return (
        <Dialog onClose={nav.close} width={640}>
          <h2 className="pb-3 text-[16px] font-semibold">{t("dialogs.importDrive")}</h2>
          <ImportView touch={false} />
        </Dialog>
      );
    case "import-google":
      if (detectShell() === "tv") return <TVOptions className="tv-import-panel" title={t("desktop.importGoogle")} onClose={nav.close}><GoogleImportView /></TVOptions>;
      return (
        <Dialog onClose={nav.close} width={700}>
          <GoogleImportView />
        </Dialog>
      );
    default:
      return null;
  }
}

/** Closes the dialog; opened from the viewer, it goes back to it. */
function finish(fn: () => unknown) {
  const layers = nav.layers();
  const fromViewer = layers[layers.length - 2]?.type === "viewer";
  nav.closeThen(() => void fn(), fromViewer ? layers.length - 1 : 0);
}

function AlbumPickDialog({ ids }: { ids: number[] }) {
  const canCreateAlbum = useVaultPermission("write");
  const { data: albums = [] } = useAlbums();
  const [filter, setFilter] = useState("");
  const list = albums.filter((a) => a.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Dialog onClose={nav.close} width={440}>
      <h2 className="text-[16px] font-semibold">{t("dialogs.addToAlbum", { n: ids.length })}</h2>
      <Field autoFocus placeholder={t("dialogs.filterAlbums")} value={filter} onChange={(e) => setFilter(e.target.value)} className="mt-4" />
      <div className="-mx-2 mt-3 max-h-[50vh] overflow-y-auto">
        {canCreateAlbum && <button
          onClick={() => nav.replaceTop({ type: "name", mode: "album-new", ids })}
          className="flex h-14 w-full items-center gap-3 rounded-lg px-2 text-left text-[14px] font-semibold text-accent hover:bg-s3"
        >
          <span className="grid size-10 place-items-center rounded-lg bg-brand-soft">
            <Plus size={18} />
          </span>
          {t("dialogs.newAlbum")}
        </button>}
        {list.map((a) => (
          <button disabled={!canUseVault("write")} key={a.id} onClick={() => finish(() => actions.albumAdd(a, ids))} className="flex h-14 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-s3">
            <span className="surface size-10 shrink-0 overflow-hidden rounded-lg bg-s3">
              <AlbumCover album={a} icon={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{a.name}</span>
              <span className="block text-[12px] text-fg-3 tabular">
                {albumPeriod(a) ? t("desktop.albumItemsPeriod", { n: a.count, period: albumPeriod(a) }) : t("desktop.albumItems", { n: a.count })}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={nav.close}>{tc("common.cancel")}</Button>
      </div>
    </Dialog>
  );
}

function NameDialog({ layer }: { layer: Extract<Layer, { type: "name" }> }) {
  const { data: albums = [] } = useAlbums();
  const current = layer.id ? albums.find((a) => a.id === layer.id) : undefined;
  const [name, setName] = useState(current?.name ?? "");
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    if (layer.mode === "album-new") {
      const ids = layer.ids ?? [];
      nav.closeThen(async () => {
        const id = await actions.albumCreate(n, ids).catch(() => 0);
        if (id && !ids.length) nav.album(id);
      }, 0);
    } else if (layer.id) {
      const id = layer.id;
      nav.closeThen(() => void actions.albumRename(id, n).catch(() => { }));
    }
  };
  return (
    <Dialog onClose={nav.close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="text-[16px] font-semibold">{layer.mode === "album-new" ? t("dialogs.newAlbum") : t("dialogs.renameAlbum")}</h2>
        {layer.mode === "album-new" && !!layer.ids?.length && (
          <p className="mt-1 text-[13px] text-fg-2">{t("dialogs.withSelected", { n: layer.ids.length })}</p>
        )}
        <Field autoFocus placeholder={t("dialogs.albumName")} value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} className="mt-4" />
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={nav.close}>{tc("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {layer.mode === "album-new" ? t("dialogs.create") : tc("common.rename")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({ layer, onSignedOut }: { layer: Extract<Layer, { type: "confirm" }>; onSignedOut: () => void }) {
  const n = layer.ids.length;
  const text = {
    purge: {
      title: t("dialogs.purge.title", { n }),
      body: t("dialogs.purge.body"),
      cta: t("dialogs.purge.cta"),
      run: () => actions.purge(layer.ids),
    },
    empty: {
      title: t("dialogs.empty.title"),
      body: t("dialogs.empty.body"),
      cta: t("dialogs.empty.cta"),
      run: () => actions.emptyTrash(),
    },
    "album-delete": {
      title: t("dialogs.albumDelete.title"),
      body: t("dialogs.albumDelete.body"),
      cta: t("dialogs.albumDelete.cta"),
      run: async () => {
        await actions.albumDelete(layer.ids[0]);
        nav.dest("collections");
      },
    },
    signout: {
      title: t("dialogs.signout.title"),
      body: t("dialogs.signout.body"),
      cta: t("dialogs.signout.cta"),
      run: onSignedOut,
    },
  }[layer.action];
  return (
    <Dialog onClose={nav.close} width={420}>
      <h2 className="text-[16px] font-semibold">{text.title}</h2>
      <p className="mt-2 text-[14px] text-fg-2">{text.body}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={nav.close}>{tc("common.cancel")}</Button>
        <Button variant="danger" onClick={() => nav.closeThen(() => void text.run(), 0)}>
          {text.cta}
        </Button>
      </div>
    </Dialog>
  );
}

/** Watched folders: whatever appears in them uploads on its own (every 5 min and on open). */
function BackupDialog() {
  const folders = useBackup((s) => s.folders);
  const shownAll = useBackup((s) => s.shown);
  const shown = shownAll.filter((f) => !folders.includes(f));
  const running = useBackup((s) => s.running);
  useEffect(() => {
    void loadFolders();
  }, []);
  const add = async (backup: boolean) => {
    if (!isTauri()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, title: backup ? t("dialogs.backup.pickBackup") : t("dialogs.backup.pickShown") });
      if (typeof dir === "string") await (backup ? setFolder(dir, true) : setShown(dir, true));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Dialog onClose={nav.close} width={520}>
      <h2 className="text-[16px] font-semibold">{t("dialogs.backup.title")}</h2>
      <p className="mt-1 text-[13px] text-fg-2">
        {t("dialogs.backup.text")}
      </p>
      <div className="surface mt-4 overflow-hidden rounded-xl bg-s2">
        {folders.map((f) => (
          <div key={f} className="flex h-12 items-center gap-3 border-b border-hairline px-3 last:border-0">
            <FolderOpen size={18} className="shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate text-[13px]" title={f}>
              {f}
            </span>
            <IconButton label={t("dialogs.backup.remove")} onClick={() => void setFolder(f, false)}>
              <X />
            </IconButton>
          </div>
        ))}
        {!folders.length && <p className="px-3 py-4 text-[13px] text-fg-3">{t("dialogs.backup.noFolders")}</p>}
      </div>
      <h3 className="mt-6 text-[14px] font-semibold">{t("dialogs.backup.shownTitle")}</h3>
      <p className="mt-1 text-[13px] text-fg-2">{t("dialogs.backup.shownText")}</p>
      <div className="surface mt-3 overflow-hidden rounded-xl bg-s2">
        {shown.map((f) => (
          <div key={f} className="flex h-12 items-center gap-3 border-b border-hairline px-3 last:border-0">
            <Eye size={18} className="shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 truncate text-[13px]" title={f}>
              {f}
            </span>
            <IconButton label={t("dialogs.backup.unshow")} onClick={() => void setShown(f, false)}>
              <X />
            </IconButton>
          </div>
        ))}
        {!shown.length && <p className="px-3 py-4 text-[13px] text-fg-3">{t("dialogs.backup.none")}</p>}
      </div>
      <div className="mt-6 flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button onClick={() => void add(true)}>
            <FolderPlus /> {t("dialogs.backup.addBackup")}
          </Button>
          <Button variant="ghost" onClick={() => void add(false)}>
            <Eye /> {t("dialogs.backup.addShown")}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button onClick={nav.close}>{tc("common.close")}</Button>
          <Button variant="primary" disabled={!folders.length || running} onClick={() => void runBackup(true)}>
            {running ? t("dialogs.backup.checking") : t("dialogs.backup.now")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Dialog buttons for the shared content (DeviceSync). */
const deskBtn: Btn = (label, run, primary, disabled) => (
  <Button key={label} variant={primary ? "primary" : undefined} disabled={disabled} onClick={run}>
    {label}
  </Button>
);
