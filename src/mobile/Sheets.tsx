import { useVaultPermission } from "@tgcloud/ui/core/vaultPermissions";
import { VaultPermissionNotice } from "@tgcloud/ui/ui/VaultPermissionNotice";
import { openVaultMembers, VaultMembersGate } from "@tgcloud/ui/core/vaultManagement";
import { Users } from "lucide-react";
/** Mobile sheets (Navigator layers: back closes them). */
import { VaultAvatar } from "@tgcloud/ui/ui/VaultAvatar";
import { useCurrentVault } from "@tgcloud/ui/core/vault";
import { useEffect, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Globe,
  ArrowDownUp,
  ArchiveRestore,
  CloudUpload,
  Download,
  FolderOpen,
  FolderPlus,
  FolderUp,
  HardDriveDownload,
  ImagePlus,
  Images,
  LogOut,
  MapPinOff,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  Send,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { fmtNumber, fmtSize } from "@tgcloud/ui/i18n";
import { LanguagePicker } from "@tgcloud/ui/ui/LanguagePicker";
import { t, tc } from "../i18n";
import { notifyError } from "@tgcloud/ui/core/notices";
import { transfers, useLiveTransfers } from "@tgcloud/ui/core/transfers";
import { app } from "@tgcloud/ui/core/app";
import { Sheet, SheetButton, SheetItem } from "@tgcloud/ui/ui/Sheet";
import type { Session } from "@tgcloud/ui/ui/Boot";
import { api } from "../core/api";
import { actions, findMedia, refresh, useAlbums, useUsage } from "../core/data";
import { nav, useRoute, type Layer } from "../core/nav";
import { AlbumCover, albumPeriod } from "../shared/Collections";
import { Switch } from "../shared/Switch";
import { ImportView } from "../shared/Import";
import { GoogleImportView } from "../shared/GoogleImport";
import { moveLocal, renameLocal } from "../core/localActions";
import { loadFolders, markConfigured, runBackup, setFolder, useBackup } from "../core/backup";
import { FreeSpaceView, OutOfSyncView, type Btn } from "../shared/DeviceSync";
import type { DeviceFolder, MediaAccess } from "@tgcloud/ui/core/android";

/**
 * Closes the sheet and runs `fn`. Opened from the viewer, it goes back to it;
 * opened from the selection, it closes the selection too (the action already
 * consumed the items).
 */
function finish(fn: () => unknown) {
  const layers = nav.layers();
  const fromViewer = layers[layers.length - 2]?.type === "viewer";
  nav.closeThen(() => void fn(), fromViewer ? layers.length - 1 : 0);
}

/** Sheet buttons for the shared content (DeviceSync). */
const sheetBtn: Btn = (label, run, primary, disabled) => (
  <SheetButton key={label} primary={primary} disabled={disabled} onClick={run}>
    {label}
  </SheetButton>
);

export function OutOfSyncSheet() {
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{t("sheets.outOfSync")}</p>}>
      <div className="px-5 pb-3">
        <OutOfSyncView button={sheetBtn} done={nav.close} />
      </div>
    </Sheet>
  );
}

export function FreeSpaceSheet() {
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{t("sheets.freeSpace")}</p>}>
      <div className="px-5 pb-3">
        <FreeSpaceView button={sheetBtn} done={nav.close} />
      </div>
    </Sheet>
  );
}

/** Send: system picker (photos and videos only) or a whole folder. */
export function AddSheet({ fileInput, album }: { fileInput: React.RefObject<HTMLInputElement | null>; album: number }) {
  const pick = (folder: boolean) =>
    nav.closeThen(async () => {
      if (!onAndroid) return fileInput.current?.click();
      try {
        const items = folder ? await android.pickFolder() : await android.pickMedia();
        await transfers.uploadUris(items, album);
      } catch (e) {
        notifyError(e);
      }
    });
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{album ? t("sheets.addToAlbum") : t("sheets.sendToApp")}</p>}>
      <VaultPermissionNotice />
      <SheetItem capability="write" icon={<ImagePlus />} onClick={() => pick(false)}>
        {t("sheets.photosVideos")}
      </SheetItem>
      {onAndroid && (
        <SheetItem capability="write" icon={<FolderUp />} hint={t("sheets.wholeFolderHint")} onClick={() => pick(true)}>
          {t("sheets.wholeFolder")}
        </SheetItem>
      )}
      <SheetItem icon={<MessagesSquare />} hint={t("sheets.fromChatHint")} onClick={() => nav.closeThen(() => nav.dest("chats"), 0)}>
        {t("sheets.fromChat")}
      </SheetItem>
    </Sheet>
  );
}

/** More actions on the selection (or the item open in the viewer). */
export function ActionsSheet({ ids }: { ids: number[] }) {
  const route = useRoute();
  const album = route.dest === "album" ? route.album : 0;
  const single = ids.length === 1 ? findMedia(ids[0]) : undefined;
  const archived = route.dest === "archive" || !!single?.archived;
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{ids.length === 1 && single?.name ? single.name : tc("common.items", { n: ids.length })}</p>}>
      <SheetItem icon={<Download />} onClick={() => finish(() => actions.download(ids))}>
        {tc("common.download")}
      </SheetItem>
      <SheetItem capability="write" icon={<Images />} onClick={() => nav.replaceTop({ type: "album-pick", ids })}>
        {t("mobile.addToAlbum")}
      </SheetItem>
      {/* Goes back to the selection afterwards (it continues, to do more things). */}
      <SheetItem icon={<Send />} onClick={() => nav.replaceTop({ type: "send-vault", ids, other: true })}>
        {tc("cross.title", { app: "TGDrive" })}
      </SheetItem>
      <SheetItem icon={<Send />} onClick={() => nav.replaceTop({ type: "send-vault", ids })}>
        {t("sheets.sendOtherVault")}
      </SheetItem>
      {album > 0 && single && (
        <SheetItem capability="write" icon={<Star />} onClick={() => finish(() => actions.albumCover(album, single.id))}>
          {t("sheets.useAsCover")}
        </SheetItem>
      )}
      {album > 0 && (
        <SheetItem capability="write" icon={<X />} onClick={() => finish(() => actions.albumRemove(album, ids))}>
          {t("sheets.removeFromAlbum")}
        </SheetItem>
      )}
      {archived ? (
        <SheetItem capability="write" icon={<ArchiveRestore />} onClick={() => finish(() => actions.archive(ids, false))}>
          {t("sheets.unarchive")}
        </SheetItem>
      ) : (
        <SheetItem capability="write" icon={<Archive />} onClick={() => finish(() => actions.archive(ids, true))}>
          {t("sheets.archive")}
        </SheetItem>
      )}
    </Sheet>
  );
}

/** Choose the destination album (or create one with the selection). */
export function AlbumPickSheet({ ids }: { ids: number[] }) {
  const canCreateAlbum = useVaultPermission("write");
  const { data: albums = [] } = useAlbums();
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{t("sheets.addItemsTo", { n: ids.length })}</p>}>
      {canCreateAlbum && <SheetItem capability="write" icon={<Plus />} onClick={() => nav.replaceTop({ type: "name", mode: "album-new", ids })}>
        {t("sheets.newAlbum")}
      </SheetItem>}
      <div className="max-h-[50vh] overflow-y-auto">
        {albums.map((a) => (
          <button
            key={a.id}
            onClick={() => finish(() => actions.albumAdd(a, ids))}
            className="flex min-h-16 w-full items-center gap-4 px-5 text-left active:bg-s4"
          >
            <span className="surface size-12 shrink-0 overflow-hidden rounded-lg bg-s3">
              <AlbumCover album={a} icon={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">{a.name}</span>
              <span className="block text-[12px] text-fg-3 tabular">
                {albumPeriod(a) ? t("mobile.albumSub", { items: tc("common.items", { n: a.count }), period: albumPeriod(a) }) : tc("common.items", { n: a.count })}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function NameSheet({ layer }: { layer: Extract<Layer, { type: "name" }> }) {
  const { data: albums = [] } = useAlbums();
  const current = layer.id ? albums.find((a) => a.id === layer.id) : undefined;
  const [name, setName] = useState(current?.name ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (layer.mode === "album-new") {
        const ids = layer.ids ?? [];
        // Closes everything (including the selection) and opens the new album.
        nav.closeThen(async () => {
          const id = await actions.albumCreate(name.trim(), ids).catch(() => 0);
          if (id && !ids.length) nav.album(id);
        }, 0);
      } else if (layer.id) {
        await actions.albumRename(layer.id, name.trim());
        nav.close();
      }
    } catch {
      setBusy(false);
    }
  };
  return (
    <Sheet>
      <form
        className="px-5 pt-2 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-[18px] font-semibold">{layer.mode === "album-new" ? t("sheets.newAlbum") : t("sheets.renameAlbum")}</p>
        {layer.mode === "album-new" && !!layer.ids?.length && (
          <p className="mt-1 text-[13px] text-fg-2">{t("sheets.withSelected", { n: layer.ids.length })}</p>
        )}
        <input
          autoFocus
          value={name}
          placeholder={t("sheets.albumName")}
          onChange={(e) => setName(e.target.value)}
          className="surface mt-4 h-12 w-full rounded-xl border border-line bg-s3 px-4 text-[16px] outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25"
        />
        <div className="mt-5 flex gap-3">
          <SheetButton onClick={nav.close}>{tc("common.cancel")}</SheetButton>
          <SheetButton type="submit" primary disabled={!name.trim() || busy}>
            {layer.mode === "album-new" ? tc("common.create") : tc("common.save")}
          </SheetButton>
        </div>
      </form>
    </Sheet>
  );
}

export function ConfirmSheet({ layer, onSignedOut }: { layer: Extract<Layer, { type: "confirm" }>; onSignedOut: () => void }) {
  const n = layer.ids.length;
  const text = {
    purge: {
      title: t("sheets.purge.title", { n }),
      body: t("sheets.purge.body"),
      cta: t("sheets.purge.cta"),
      run: () => actions.purge(layer.ids),
    },
    empty: {
      title: t("sheets.empty.title"),
      body: t("sheets.empty.body"),
      cta: t("sheets.empty.cta"),
      run: () => actions.emptyTrash(),
    },
    "album-delete": {
      title: t("sheets.albumDelete.title"),
      body: t("sheets.albumDelete.body"),
      cta: t("sheets.albumDelete.cta"),
      run: async () => {
        await actions.albumDelete(layer.ids[0]);
        nav.dest("collections");
      },
    },
    signout: {
      title: t("sheets.signout.title"),
      body: t("sheets.signout.body"),
      cta: tc("common.signOut"),
      run: onSignedOut,
    },
  }[layer.action];
  return (
    <Sheet>
      <div className="px-5 pt-2 pb-3">
        <p className="text-[18px] font-semibold">{text.title}</p>
        <p className="mt-2 text-[14px] text-fg-2">{text.body}</p>
        <div className="mt-6 flex gap-3">
          <SheetButton onClick={nav.close}>{tc("common.cancel")}</SheetButton>
          <SheetButton primary danger onClick={() => nav.closeThen(() => void text.run(), 0)}>
            {text.cta}
          </SheetButton>
        </div>
      </div>
    </Sheet>
  );
}

export function AccountSheet({ session }: { session: Session }) {
  const { data: usage } = useUsage();
  // The photo may have changed just now (the session stores the one from open).
  const vault = useCurrentVault((s) => s.vault);
  const live = useLiveTransfers();
  // Language: the same sheet switches to the language list (back returns to the account).
  const [lang, setLang] = useState(false);
  if (lang)
    return (
      <Sheet
        title={
          <div className="-ml-3 flex items-center gap-1">
            <button onClick={() => setLang(false)} className="grid size-10 shrink-0 place-items-center rounded-full text-fg active:bg-s3" aria-label={tc("common.back")}>
              <ArrowLeft size={22} />
            </button>
            <p className="text-[16px] font-semibold">{tc("common.language")}</p>
          </div>
        }
      >
        <LanguagePicker touch onChange={() => setLang(false)} />
      </Sheet>
    );
  return (
    <Sheet
      title={
        <div className="flex items-center gap-3">
          <VaultAvatar vault={vault ?? session.vault} size={40} className="step rounded-xl bg-brand text-white" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{session.vault.name}</p>
            <p className="text-[12px] text-fg-3 tabular">
              {usage ? t("sheets.usage", { photos: t("sheets.photos", { n: usage.photos }), videos: t("sheets.videos", { n: usage.videos }), size: fmtSize(usage.bytes) }) : "…"}
            </p>
          </div>
        </div>
      }
    >
      <VaultMembersGate><SheetItem icon={<Users />} onClick={() => nav.closeThen(openVaultMembers)}>
        {tc("members.title")}
      </SheetItem></VaultMembersGate>
      <SheetItem icon={<Repeat />} onClick={() => nav.closeThen(session.switchVault)}>
        {t("sheets.switchVault")}
      </SheetItem>
      {/* Transfers through the avatar (no item in the bottom bar). */}
      <SheetItem icon={<ArrowDownUp />} hint={live ? t("sheets.liveHint", { n: live }) : undefined} onClick={() => nav.closeThen(() => nav.dest("transfers"))}>
        {t("mobile.title.transfers")}
      </SheetItem>
      {onAndroid && (
        <SheetItem capability="write" icon={<CloudUpload />} onClick={() => nav.replaceTop({ type: "backup" })}>
          {t("sheets.autoBackup")}
        </SheetItem>
      )}
      <SheetItem capability="write" icon={<HardDriveDownload />} onClick={() => nav.replaceTop({ type: "import" })}>
        {t("sheets.importDrive")}
      </SheetItem>
      <SheetItem capability="write" icon={<Images />} onClick={() => nav.replaceTop({ type: "import-google" })}>
        {t("sheets.importGoogle")}
      </SheetItem>
      <SheetItem
        icon={<RefreshCw />}
        onClick={() =>
          nav.closeThen(() =>
            api
              .syncNow()
              .then(() => refresh())
              .catch(notifyError),
          )
        }
      >
        {t("sheets.syncNow")}
      </SheetItem>
      <SheetItem icon={<Globe />} onClick={() => setLang(true)}>
        {tc("common.language")}
      </SheetItem>
      <SheetItem icon={<LogOut />} danger onClick={() => nav.replaceTop({ type: "confirm", action: "signout", ids: [] })}>
        {t("sheets.signOutAccount")}
      </SheetItem>
    </Sheet>
  );
}

/** "Share → TGPhotos" from another app. */
export function ReceiveSheet({ layer }: { layer: Extract<Layer, { type: "receive" }> }) {
  const media = layer.items.filter((i) => /^(image|video)\//.test(i.mime));
  const skipped = layer.items.length - media.length;
  const n = media.length;
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{n === 1 ? t("sheets.receiveOne", { name: media[0].name, app: app.name }) : t("sheets.receiveMany", { n, app: app.name })}</p>}>
      <div className="px-5 pb-2">
        {skipped > 0 && <p className="mb-3 text-[13px] text-fg-2">{t("sheets.skipped", { n: skipped })}</p>}
        <div className="flex gap-3 pt-1">
          <SheetButton onClick={nav.close}>{tc("common.cancel")}</SheetButton>
          <SheetButton primary disabled={!n} onClick={() => nav.closeThen(() => void transfers.uploadUris(media, 0))}>
            {tc("common.upload")}
          </SheetButton>
        </div>
      </div>
    </Sheet>
  );
}

/** Automatic backup (Android): access to the device media and folders. */
export function BackupSheet() {
  const [access, setAccess] = useState<MediaAccess>(() => android.mediaAccess());
  const [manage, setManage] = useState(() => android.manageMedia());
  const [folders, setFolders] = useState<DeviceFolder[]>([]);
  const on = useBackup((s) => s.folders);
  const running = useBackup((s) => s.running);
  const allowed = access.full || access.partial;

  useEffect(() => {
    markConfigured();
    void loadFolders();
  }, []);
  useEffect(() => {
    if (allowed) setFolders(android.mediaFolders());
  }, [allowed]);

  const ask = async () => setAccess(await android.requestMedia());

  return (
    <Sheet title={<p className="text-[16px] font-semibold">{t("sheets.autoBackup")}</p>}>
      <div className="px-5 pb-2">
        <p className="text-[14px] text-fg-2">{t("sheets.backup.intro")}</p>
        {!allowed && (
          <div className="mt-4">
            <SheetButton primary onClick={ask}>
              {t("sheets.backup.allow")}
            </SheetButton>
          </div>
        )}
        {access.partial && (
          <p className="surface mt-3 rounded-lg bg-s3 px-3 py-2.5 text-[13px] text-fg-2">
            {t("sheets.backup.partial")}{" "}
            <button onClick={ask} className="font-semibold text-accent">
              {t("sheets.backup.allowAll")}
            </button>
          </p>
        )}
        {allowed && !access.location && (
          <p className="mt-3 flex items-start gap-2 text-[13px] text-fg-3">
            <MapPinOff size={16} className="mt-0.5 shrink-0" /> {t("sheets.backup.noLocation")}
          </p>
        )}
        {/* Unified trash: Android confirms each deletion, unless the app manages media. */}
        {allowed && manage.supported && (
          <button
            onClick={() => void android.requestManageMedia().then(setManage)}
            className="surface mt-3 flex w-full items-center gap-3 rounded-xl bg-s3 px-3.5 py-3 text-left active:bg-s4"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">{t("sheets.backup.manage")}</span>
              <span className="block text-[12px] text-fg-2">
                {manage.granted ? t("sheets.backup.manageOn") : t("sheets.backup.manageOff")}
              </span>
            </span>
            <Switch on={manage.granted} touch />
          </button>
        )}
      </div>
      {allowed && (
        <>
          <p className="px-5 pt-3 pb-1 text-[12px] font-semibold tracking-wide text-fg-3 uppercase">{t("sheets.backup.folders")}</p>
          <div className="max-h-[45vh] overflow-y-auto">
            {folders.map((f) => {
              const active = on.includes(f.path);
              return (
                <button key={f.path} onClick={() => void setFolder(f.path, !active)} className="flex min-h-16 w-full items-center gap-4 px-5 text-left active:bg-s4">
                  <span className={`surface grid size-12 shrink-0 place-items-center rounded-lg ${active ? "bg-brand-soft text-brand" : "bg-s3 text-fg-3"}`}>
                    <FolderUp size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{f.name}</span>
                    <span className="block truncate text-[12px] text-fg-3 tabular">
                      {fmtNumber(f.count)} · {f.path || t("sheets.backup.root")}
                    </span>
                  </span>
                  <Switch on={active} touch />
                </button>
              );
            })}
            {!folders.length && <p className="px-5 py-4 text-[14px] text-fg-3">{t("sheets.backup.none")}</p>}
          </div>
          <div className="flex gap-3 px-5 pt-3 pb-2">
            <SheetButton primary disabled={!on.length || running} onClick={() => void runBackup(true)}>
              {running ? t("sheets.backup.checking") : t("sheets.backup.now")}
            </SheetButton>
          </div>
        </>
      )}
    </Sheet>
  );
}

export function ImportSheet() {
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{t("sheets.importDrive")}</p>}>
      <ImportView touch />
    </Sheet>
  );
}

export function GoogleImportSheet() {
  return (
    <Sheet>
      <GoogleImportView touch />
    </Sheet>
  );
}

/** ⋮ menu of the open album. */
export function AlbumMenuSheet({ id }: { id: number }) {
  const { data: albums = [] } = useAlbums();
  const a = albums.find((x) => x.id === id);
  return (
    <Sheet title={<p className="truncate text-[16px] font-semibold">{a?.name ?? t("mobile.album")}</p>}>
      <SheetItem icon={<ImagePlus />} onClick={() => nav.replaceTop({ type: "add" })}>
        {t("mobile.addPhotos")}
      </SheetItem>
      <SheetItem capability="write" icon={<Pencil />} onClick={() => nav.replaceTop({ type: "name", mode: "album-rename", id })}>
        {tc("common.rename")}
      </SheetItem>
      <SheetItem capability="write" icon={<Trash2 />} danger onClick={() => nav.replaceTop({ type: "confirm", action: "album-delete", ids: [id] })}>
        {t("sheets.deleteAlbum")}
      </SheetItem>
    </Sheet>
  );
}

/** Move device photos to another folder (or a new one, in Pictures). */
export function DeviceMoveSheet({ uris }: { uris: string[] }) {
  const folders = android.mediaFolders();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const go = (folder: string) => nav.closeThen(() => void moveLocal(uris, folder));
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{t("sheets.moveItemsTo", { n: uris.length })}</p>}>
      {creating ? (
        <form
          className="px-5 pt-1 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) go(`Pictures/${name.trim()}`);
          }}
        >
          <input
            autoFocus
            value={name}
            placeholder={t("sheets.folderName")}
            onChange={(e) => setName(e.target.value.replace(/[/\\]/g, ""))}
            className="surface h-12 w-full rounded-xl border border-line bg-s3 px-4 text-[16px] outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25"
          />
          <p className="mt-2 text-[12px] text-fg-3">{t("sheets.folderAt", { name: name.trim() || "…" })}</p>
          <div className="mt-4 flex gap-3">
            <SheetButton onClick={() => setCreating(false)}>{tc("common.back")}</SheetButton>
            <SheetButton type="submit" primary disabled={!name.trim()}>
              {tc("common.move")}
            </SheetButton>
          </div>
        </form>
      ) : (
        <>
          <SheetItem icon={<FolderPlus />} onClick={() => setCreating(true)}>
            {tc("common.newFolder")}
          </SheetItem>
          <div className="max-h-[50vh] overflow-y-auto">
            {folders.map((f) => (
              <SheetItem key={f.path} icon={<FolderOpen />} hint={fmtNumber(f.count)} onClick={() => go(f.path)}>
                {f.name}
              </SheetItem>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Rename a device photo (the extension stays). */
export function DeviceRenameSheet({ uri, name: initial }: { uri: string; name: string }) {
  const dot = initial.lastIndexOf(".");
  const ext = dot > 0 ? initial.slice(dot) : "";
  const [name, setName] = useState(dot > 0 ? initial.slice(0, dot) : initial);
  return (
    <Sheet>
      <form
        className="px-5 pt-2 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (n) nav.closeThen(() => void renameLocal(uri, n + ext));
        }}
      >
        <p className="text-[18px] font-semibold">{tc("common.rename")}</p>
        <div className="mt-4 flex items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.replace(/[/\\]/g, ""))}
            onFocus={(e) => e.target.select()}
            className="surface h-12 min-w-0 flex-1 rounded-xl border border-line bg-s3 px-4 text-[16px] outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/25"
          />
          {ext && <span className="text-[15px] text-fg-3">{ext}</span>}
        </div>
        <div className="mt-5 flex gap-3">
          <SheetButton onClick={nav.close}>{tc("common.cancel")}</SheetButton>
          <SheetButton type="submit" primary disabled={!name.trim()}>
            {tc("common.save")}
          </SheetButton>
        </div>
      </form>
    </Sheet>
  );
}
