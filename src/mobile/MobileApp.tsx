import { canUseVault } from "@tgcloud/ui/core/vaultPermissions";
/**
 * Mobile shell: app bar, bottom bar (Photos · Collections · Search),
 * square-grid timeline, long press to select and sheets.
 */
import { VaultAvatar } from "@tgcloud/ui/ui/VaultAvatar";
import { ExternalPick } from "../shared/ExternalPick";
import { Presence } from "@tgcloud/ui/ui/Presence";
import { getPort } from "@tgcloud/ui/core/server";
import { deviceToken } from "../core/local";
import { PresenceList } from "@tgcloud/ui/ui/Presence";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Clapperboard, CloudUpload, FolderInput, Heart, Images, ImagePlus, Library, MoreVertical, Plus, RotateCcw, Search, Share2, Trash2, X } from "lucide-react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { uploads, useUploads } from "@tgcloud/ui/core/uploads";
import { TransfersView } from "@tgcloud/ui/ui/Transfers";
import { EmptyState, ErrorState } from "@tgcloud/ui/ui/States";
import { Snackbar } from "@tgcloud/ui/mobile/Snackbar";
import { TransferChip } from "@tgcloud/ui/mobile/TransferChip";
import type { Session } from "@tgcloud/ui/ui/Boot";
import { api, type Media } from "../core/api";
import { actions, findMedia, refreshSoon, useAlbumMedia, useAlbums, useList, useSearch } from "../core/data";
import { nav, useLayers, useNav, useRoute, type Dest } from "../core/nav";
import { useSelection } from "../core/select";
import { Collections, albumPeriod } from "../shared/Collections";
import { backupLocal, shareMany, Viewer } from "../shared/Viewer";
import { findLocal, loadLibrary, merge, mergeTrash, startLibrary, useLibrary } from "../core/library";
import { useDevice } from "../core/deviceStore";
import { startDevice } from "../core/deviceTrash";
import { UpdateBanner } from "@tgcloud/ui/ui/Update";
import { OutOfSyncBanner } from "../shared/DeviceSync";
import { OfflineBadge } from "@tgcloud/ui/ui/Offline";
import { SendToVault } from "@tgcloud/ui/ui/SendToVault";
import { useLiveTransfers, useTransfers } from "@tgcloud/ui/core/transfers";
import { Timeline } from "../timeline/Timeline";
import { AccountSheet, ActionsSheet, AddSheet, AlbumMenuSheet, DeviceMoveSheet, DeviceRenameSheet, AlbumPickSheet, BackupSheet, ConfirmSheet, FreeSpaceSheet, ImportSheet, GoogleImportSheet, NameSheet, OutOfSyncSheet, ReceiveSheet } from "./Sheets";
import { DeviceFolderBar, DeviceFolderScreen, DeviceViewer } from "./Device";
import { ChatList, ChatScreen, useChatTitle } from "../shared/Chats";
import { ScrollPane, scrollToTop } from "../shared/Scroll";
import { Liked, Shorts } from "../shared/Shorts";
import { useCurrentVault } from "@tgcloud/ui/core/vault";
import { FetchDialog } from "../shared/FetchDialog";
import { t, tc } from "../i18n";
import { backupConfigured, markConfigured, startBackup, useBackup } from "../core/backup";

export default function MobileApp({ session }: { session: Session }) {
  const route = useRoute();
  const layers = useLayers();
  const fileInput = useRef<HTMLInputElement>(null);
  const selecting = layers.some((l) => l.type === "selection");
  // Another app asked for photos ("Choose photo" → TGPhotos): on open or already open.
  const [pick, setPick] = useState(() => (onAndroid ? android.takePick() : null));
  useEffect(() => {
    if (!onAndroid) return;
    const take = () => setPick(android.takePick());
    window.addEventListener("tg-pick", take);
    return () => window.removeEventListener("tg-pick", take);
  }, []);
  // The open vault as an origin in the system file picker.
  useEffect(() => {
    if (!onAndroid) return;
    void deviceToken().then((t) => android.docsReady(getPort(), t, session.vault.id, session.vault.name));
  }, [session.vault.id, session.vault.name]);

  // The mobile selection lives while the "selection" layer is on the stack.
  useEffect(() => {
    if (!selecting) useSelection.getState().clear();
  }, [selecting]);

  // Leaves selection mode when everything is deselected.
  const count = useSelection((s) => s.ids.size);
  useEffect(() => {
    if (selecting && count === 0 && nav.top("selection")) nav.close();
  }, [selecting, count]);

  useEffect(() => {
    useUploads.setState({ onDone: refreshSoon });
    // Trash older than 30 days is deleted for good.
    api.housekeep().then((n) => n && refreshSoon()).catch(() => {});
    startBackup();
    startLibrary();
    startDevice();
  }, []);

  // The upload queue moved (something was uploaded): the device gallery drops what is already in the vault.
  const transfersList = useTransfers((s) => s.list);
  useEffect(() => {
    const t = setTimeout(() => void loadLibrary(), 1500);
    return () => clearTimeout(t);
  }, [transfersList]);

  // "Share → TGPhotos" from another app (on open or with the app open).
  useEffect(() => {
    if (!onAndroid) return;
    const take = () => {
      const items = android.takeShared();
      if (items.length) nav.open({ type: "receive", items });
    };
    take();
    window.addEventListener("tg-shared", take);
    return () => window.removeEventListener("tg-shared", take);
  }, []);

  const album = route.dest === "album" ? route.album : 0;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <input
        ref={fileInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) uploads.add(e.target.files, album);
          e.target.value = "";
        }}
      />
      <AppBar session={session} />
      <Screen />
      {!selecting && <BottomBar />}
      <Snackbar />
      <Layers fileInput={fileInput} album={album} session={session} />
      <Presence>{pick && <ExternalPick req={pick} touch onClose={() => setPick(null)} />}</Presence>
    </div>
  );
}

// ---- App bar ----------------------------------------------------------------------------

const titles = (): Partial<Record<Dest, string>> => ({
  photos: t("mobile.title.photos"),
  collections: t("mobile.title.collections"),
  liked: t("mobile.title.liked"),
  favorites: t("mobile.title.favorites"),
  videos: t("mobile.title.videos"),
  recent: t("mobile.title.recent"),
  archive: t("mobile.title.archive"),
  trash: tc("common.trash"),
  transfers: t("mobile.title.transfers"),
  chats: t("mobile.title.chats"),
});

function AppBar({ session }: { session: Session }) {
  const route = useRoute();
  const chatTitle = useChatTitle();
  const layers = useLayers();
  const selected = useSelection((s) => s.ids);
  const { data: albums = [] } = useAlbums();

  const bar = (children: ReactNode, tone = "bg-canvas") => (
    <header className={`relative z-10 flex shrink-0 items-center gap-1 px-1 pt-[var(--inset-top)] ${tone}`} style={{ minHeight: "calc(var(--appbar-height) + var(--inset-top))" }}>
      {children}
    </header>
  );
  const icon = (label: string, node: ReactNode, onClick: () => void) => (
    <button onClick={onClick} className="grid size-12 shrink-0 place-items-center rounded-full text-fg active:bg-s3" aria-label={label}>
      {node}
    </button>
  );

  // Shorts: full screen, no bar.
  if ((route.dest === "shorts" || route.dest === "liked") && !layers.some((l) => l.type === "selection")) return null;

  if (layers.some((l) => l.type === "selection")) {
    const all = [...selected];
    // Device media (outside the vault, ids < 0) can come in the selection: backup,
    // folder and trash apply to them; the rest only to the vault ones.
    const ids = all.filter((id) => id > 0);
    const local = all.filter((id) => id < 0);
    const inTrash = route.dest === "trash";
    // Action that consumes the selection: closes the layer and then runs.
    const then = (fn: () => unknown) => nav.closeThen(() => void fn(), 0);
    return bar(
      <>
        {icon(t("mobile.cancelSelection"), <X size={22} />, nav.close)}
        <p className="flex-1 text-[18px] font-semibold tabular">{all.length}</p>
        {inTrash ? (
          <>
            {(ids.length === 0 || canUseVault("write")) && icon(tc("common.restore"), <RotateCcw size={22} />, () => then(() => actions.restore(all)))}
            {icon(t("mobile.purgeForever"), <Trash2 size={22} />, () => nav.open({ type: "confirm", action: "purge", ids: all }))}
          </>
        ) : (
          <>
            {/* Several at once: the Android picker receives them all. */}
            {icon(tc("common.share"), <Share2 size={22} />, () => then(() => shareMany(all.map((id) => (id < 0 ? findLocal(id) : findMedia(id))).filter((m): m is Media => !!m))))}
            {local.length > 0 &&
              icon(t("mobile.backup"), <CloudUpload size={22} />, () => then(() => backupLocal(local.map(findLocal).filter((m): m is Media => !!m))))}
            {/* Device only: manage as a gallery. */}
            {local.length > 0 &&
              ids.length === 0 &&
              android.canManage() &&
              icon(t("mobile.moveToFolder"), <FolderInput size={22} />, () =>
                nav.replaceTop({ type: "device-move", uris: local.map(findLocal).flatMap((m) => (m?.uri ? [m.uri] : [])) }),
              )}
            {ids.length > 0 && (
              <>
                {icon(t("mobile.addToAlbum"), <ImagePlus size={22} />, () => nav.open({ type: "album-pick", ids }))}
                {canUseVault("write") && icon(tc("common.favorite"), <Heart size={22} />, () => then(() => actions.favorite(ids, true)))}
              </>
            )}
            {/* Unified trash: vault and device together. */}
            {(ids.length === 0 || canUseVault("trash")) && icon(t("mobile.moveToTrash"), <Trash2 size={22} />, () => then(() => actions.trash(all)))}
            {ids.length > 0 && icon(tc("common.more"), <MoreVertical size={22} />, () => nav.open({ type: "actions", ids }))}
          </>
        )}
      </>,
      "bg-s2",
    );
  }

  if (route.dest === "search") return bar(<SearchField />);

  if (route.dest === "device")
    return bar(
      <>
        {icon(tc("common.back"), <ArrowLeft size={22} />, nav.back)}
        <DeviceFolderBar path={route.device ?? ""} />
      </>,
    );

  if (route.dest === "album") {
    const a = albums.find((x) => x.id === route.album);
    return bar(
      <>
        {icon(tc("common.back"), <ArrowLeft size={22} />, nav.back)}
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-[18px] leading-6 font-semibold">{a?.name ?? t("mobile.album")}</p>
          <p className="truncate text-[12px] text-fg-3 tabular">
            {a ? (albumPeriod(a) ? t("mobile.albumSub", { items: tc("common.items", { n: a.count }), period: albumPeriod(a) }) : tc("common.items", { n: a.count })) : ""}
          </p>
        </div>
        {canUseVault("write") && icon(t("mobile.addPhotos"), <Plus size={22} />, () => nav.open({ type: "add" }))}
        {icon(t("mobile.moreOptions"), <MoreVertical size={22} />, () => nav.open({ type: "album-menu", id: route.album }))}
      </>,
    );
  }

  const root = route.dest === "photos" || route.dest === "collections";
  return bar(
    <>
      {!root && icon(tc("common.back"), <ArrowLeft size={22} />, nav.back)}
      <h1 className={`flex-1 truncate font-heading font-bold tracking-tight text-fg-title ${root ? "pl-4 text-[22px]" : "pl-1 text-[20px]"}`}>{route.dest === "chat" ? chatTitle : titles()[route.dest]}</h1>
      <OfflineBadge touch />
      <TransferChip onOpen={() => nav.dest("transfers")} />
      {route.dest === "trash"
        ? canUseVault("trash") && icon(t("mobile.emptyTrash"), <Trash2 size={20} />, () => nav.open({ type: "confirm", action: "empty", ids: [] }))
        : route.dest === "photos" && canUseVault("write") && icon(tc("common.upload"), <Plus size={24} />, () => nav.open({ type: "add" }))}
      {root && <AccountButton session={session} />}
    </>,
  );
}

/** Avatar: account, vault and transfers; with something in progress, a badge. */
/** The open vault photo (the sheet that opens shows the account and switches vault). */
function AccountButton({ session }: { session: Session }) {
  const live = useLiveTransfers();
  // The photo may have changed just now (the session stores the one from open).
  const vault = useCurrentVault((s) => s.vault) ?? session.vault;
  return (
    <button onClick={() => nav.open({ type: "account" })} aria-label={live ? t("mobile.accountLive", { n: live }) : t("mobile.account")} className="relative grid size-12 shrink-0 place-items-center rounded-full text-fg active:bg-s3">
      <VaultAvatar vault={vault} size={32} className="rounded-lg bg-brand text-white" />
      {live > 0 && <span className="absolute top-2.5 right-2.5 size-2.5 rounded-full bg-info ring-2 ring-s1" />}
    </button>
  );
}

function SearchField() {
  const route = useRoute();
  const [text, setText] = useState(route.query);
  useEffect(() => {
    const t = setTimeout(() => nav.search(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="relative mx-3 min-w-0 flex-1">
      <Search size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-fg-3" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("mobile.searchPlaceholder")}
        enterKeyHint="search"
        className="surface h-11 w-full rounded-xl border border-line bg-s3 pr-11 pl-10 text-[16px] text-fg outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25"
      />
      {text && (
        <button onClick={() => setText("")} className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-fg-2 active:bg-s4" aria-label={t("mobile.clearSearch")}>
          <X size={18} />
        </button>
      )}
    </div>
  );
}

// ---- Bottom bar -------------------------------------------------------------------------

const destinations = (): { dest: Dest; label: string; icon: typeof Images }[] => [
  { dest: "photos", label: t("mobile.title.photos"), icon: Images },
  { dest: "shorts", label: t("mobile.tab.shorts"), icon: Clapperboard },
  { dest: "collections", label: t("mobile.title.collections"), icon: Library },
  { dest: "search", label: t("mobile.tab.search"), icon: Search },
];

/** Destinations that belong to the Collections tab (the tab stays lit inside them). */
const inCollections: Dest[] = ["collections", "favorites", "videos", "recent", "archive", "trash", "transfers", "album", "device", "chats", "chat"];

function BottomBar() {
  const route = useRoute();
  const current = inCollections.includes(route.dest) ? "collections" : route.dest === "liked" ? "shorts" : route.dest;
  return (
    <nav className="glint-top z-20 flex shrink-0 bg-s1 pb-[var(--inset-bottom)]" style={{ height: "calc(var(--bottombar-height) + var(--inset-bottom))" }}>
      {destinations().map(({ dest, label, icon: Icon }) => {
        const on = current === dest;
        return (
          <button
            key={dest}
            // Tapping the destination you are already on again: goes back to the top.
            onClick={() => (route.dest === dest && dest !== "search" ? scrollToTop() : dest === "search" ? nav.search(route.dest === "search" ? route.query : "") : nav.dest(dest))}
            className="flex flex-1 flex-col items-center justify-center gap-1"
            aria-current={on ? "page" : undefined}
          >
            <span className={`grid h-8 w-16 place-items-center rounded-full transition-colors ${on ? "bg-brand-soft text-brand" : "text-fg-2"}`}>
              <Icon size={22} strokeWidth={on ? 2.25 : 2} />
            </span>
            <span className={`text-[12px] font-semibold ${on ? "text-fg" : "text-fg-2"}`}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ---- Screens ----------------------------------------------------------------------------

/** Shorts in full screen (no top bar): the content starts below the status bar. */
function ShortsScreen({ liked = false }: { liked?: boolean }) {
  const vault = useCurrentVault((s) => s.vault?.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black pt-[var(--inset-top)]">
      {liked ? <Liked key={vault} touch /> : <Shorts key={vault} touch />}
    </div>
  );
}

function Screen() {
  const route = useRoute();
  const direction = useNav((s) => s.direction);
  const key = `${route.dest}:${route.album}:${route.device ?? ""}`;
  const transition = usePageTransition(key, route.dest, direction);
  return (
    // The screen that leaves stays underneath for an instant, fading (see ui/Presence.tsx).
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PresenceList
        items={[
          {
            key,
            node: (
        <main className={`relative flex min-h-0 flex-1 flex-col bg-canvas ${transition}`}>
          {route.dest === "photos" && <ListScreen view="timeline" />}
          {route.dest === "shorts" && <ShortsScreen />}
          {route.dest === "liked" && <ShortsScreen liked />}
          {route.dest === "favorites" && <ListScreen view="favorites" />}
          {route.dest === "videos" && <ListScreen view="videos" />}
          {route.dest === "recent" && <ListScreen view="recent" />}
          {route.dest === "archive" && <ListScreen view="archive" />}
          {route.dest === "trash" && <ListScreen view="trash" />}
          {route.dest === "album" && <AlbumScreen id={route.album} />}
          {route.dest === "search" && <SearchScreen text={route.query} />}
          {route.dest === "device" && <DeviceFolderScreen path={route.device ?? ""} />}
          {route.dest === "collections" && (
            <ScrollPane>
              <Collections touch />
            </ScrollPane>
          )}
          {route.dest === "chats" && (
            <ScrollPane>
              <ChatList touch />
            </ScrollPane>
          )}
          {route.dest === "chat" && (
            <ScrollPane>
              <ChatScreen touch />
            </ScrollPane>
          )}
          {route.dest === "transfers" && (
            <div className="flex-1 overflow-y-auto pb-24">
              <TransfersView touch />
            </div>
          )}
        </main>
            ),
          },
        ]}
      />
    </div>
  );
}

/**
 * Page animation, decided only when the page changes (opening a sheet stacks
 * history but does not change the page): switching tabs = fade through; entering
 * and leaving an album/collection = slide on the axis.
 */
function usePageTransition(key: string, dest: Dest, direction: 1 | -1) {
  const last = useRef<{ key: string; dest: Dest; cls: string } | null>(null);
  if (last.current?.key !== key) {
    const prev = last.current;
    const tab = (d: Dest) => ((inCollections.includes(d) && d !== "collections") || d === "liked" ? "sub" : d);
    const cls = !prev ? "" : tab(prev.dest) !== "sub" && tab(dest) !== "sub" ? "anim-through" : direction === 1 ? "anim-forward" : "anim-back";
    last.current = { key, dest, cls };
  }
  return last.current.cls;
}

const empties = {
  timeline: Images,
  favorites: Heart,
  videos: Images,
  recent: Images,
  archive: Images,
  trash: Trash2,
} as const;

function Grid({ q, empty, top, topHeight, byAdded }: { byAdded?: boolean; q: { data?: Media[]; error: unknown; refetch: () => void; isLoading: boolean }; empty: ReactNode; top?: ReactNode; topHeight?: number }) {
  if (q.error) return <ErrorState touch error={q.error} retry={q.refetch} />;
  if (q.isLoading) return <div className="flex-1" />;
  if (!q.data?.length) return <>{empty}</>;
  return <Timeline items={q.data} touch top={top} topHeight={topHeight} bottom={96} byAdded={byAdded} />;
}

function ListScreen({ view }: { view: keyof typeof empties }) {
  const vault = useList(view);
  // Photos: the device gallery (outside the vault) comes along.
  const local = useLibrary((s) => s.items);
  // Trash: the device one comes along (what has no copy in the vault).
  const trashed = useDevice((s) => s.localOnly);
  const data = useMemo(
    () => (!vault.data ? vault.data : view === "timeline" ? merge(vault.data, local) : view === "trash" ? mergeTrash(vault.data, trashed) : vault.data),
    [view, vault.data, local, trashed],
  );
  const q = { ...vault, data };
  const e = { icon: empties[view], title: t(`mobile.empty.${view}.title`), text: t(`mobile.empty.${view}.text`) };
  const invite = useInvite(view === "timeline");
  const unsynced = useDevice((s) => s.out.vaultOnly.length + s.out.deviceOnly.length) > 0;
  const banner =
    view === "trash" ? (
      <div className="mx-3 mt-1 mb-2 space-y-2">
        <OutOfSyncBanner touch />
        <p className="surface rounded-lg bg-s1 px-3 py-2.5 text-[13px] text-fg-2">{t("mobile.trashNote")}</p>
      </div>
    ) : invite ? (
      <BackupInvite onClose={invite.dismiss} />
    ) : undefined;
  const topHeight = !banner ? 0 : invite ? 92 : view === "trash" && unsynced ? 128 : 56;
  return (
    <>
      {/* Timeline: notices that call for action stay fixed at the top. */}
      {view === "timeline" && (
        <div className="mx-3 mb-2 space-y-2 empty:hidden">
          <OutOfSyncBanner touch />
          <UpdateBanner touch />
        </div>
      )}
      {!q.data?.length && banner}
      <Grid q={q} top={banner} topHeight={topHeight} byAdded={view === "recent"} empty={<EmptyState touch icon={e.icon} title={e.title} text={e.text} />} />
    </>
  );
}

/** Invite to turn on backup, until the user goes through the backup screen or dismisses it. */
function useInvite(enabled: boolean) {
  const folders = useBackup((s) => s.folders);
  const [dismissed, setDismissed] = useState(() => backupConfigured());
  if (!enabled || !onAndroid || !android.hasMedia() || dismissed || folders.length) return null;
  return {
    dismiss: () => {
      markConfigured();
      setDismissed(true);
    },
  };
}

function BackupInvite({ onClose }: { onClose: () => void }) {
  return (
    <div className="surface mx-3 mt-1 mb-2 flex items-center gap-3 rounded-xl bg-s1 py-3 pr-1 pl-3.5">
      <CloudUpload size={22} className="shrink-0 text-brand" />
      <button disabled={!canUseVault("write")} onClick={() => nav.open({ type: "backup" })} className="min-w-0 flex-1 text-left">
        <p className="text-[14px] font-semibold">{t("mobile.invite.title")}</p>
        <p className="text-[12px] text-fg-2">{t("mobile.invite.text")}</p>
      </button>
      <button onClick={onClose} className="grid size-10 shrink-0 place-items-center rounded-full text-fg-3 active:bg-s3" aria-label={t("mobile.dismiss")}>
        <X size={18} />
      </button>
    </div>
  );
}

function AlbumScreen({ id }: { id: number }) {
  const q = useAlbumMedia(id);
  return (
    <Grid
      q={q}
      empty={
        <EmptyState
          touch
          icon={Images}
          title={t("mobile.emptyAlbum.title")}
          text={t("mobile.emptyAlbum.text")}
          action={
            <button onClick={() => nav.open({ type: "add" })} className="step mt-2 flex h-11 items-center gap-2 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white">
              <Plus size={18} /> {t("mobile.addPhotos")}
            </button>
          }
        />
      }
    />
  );
}

function SearchScreen({ text }: { text: string }) {
  const q = useSearch(text);
  if (!text.trim()) return <EmptyState touch sync={false} icon={Search} title={t("mobile.search.title")} text={t("mobile.search.text")} />;
  return <Grid q={{ ...q, isLoading: q.isLoading && q.fetchStatus !== "idle" }} empty={<EmptyState touch icon={Search} title={t("mobile.search.none")} text={t("mobile.search.noneText", { q: text })} />} />;
}

// ---- Layers -----------------------------------------------------------------------------

function Layers({ fileInput, album, session }: { fileInput: React.RefObject<HTMLInputElement | null>; album: number; session: Session }) {
  const layers = useLayers();
  // Each layer leaves with an animation (sheet slides down, dialog fades) before unmounting.
  const nodes = layers.map((l, i) => {
        const key = `${i}-${l.type}`;
        switch (l.type) {
          case "viewer":
            return <Viewer key={key} layer={l} touch />;
          case "device-viewer":
            return <DeviceViewer key={key} layer={l} />;
          case "add":
            return <AddSheet key={key} fileInput={fileInput} album={album} />;
          case "actions":
            return <ActionsSheet key={key} ids={l.ids} />;
          case "album-pick":
            return <AlbumPickSheet key={key} ids={l.ids} />;
          case "name":
            return <NameSheet key={key} layer={l} />;
          case "confirm":
            return <ConfirmSheet key={key} layer={l} onSignedOut={session.signOut} />;
          case "account":
            return <AccountSheet key={key} session={session} />;
          case "receive":
            return <ReceiveSheet key={key} layer={l} />;
          case "backup":
            return <BackupSheet key={key} />;
          case "import":
            return <ImportSheet key={key} />;
          case "import-google":
            return <GoogleImportSheet key={key} />;
          case "device-move":
            return <DeviceMoveSheet key={key} uris={l.uris} />;
          case "device-rename":
            return <DeviceRenameSheet key={key} uri={l.uri} name={l.name} />;
          case "send-vault":
            return <SendToVault key={key} ids={l.ids} other={l.other} chooseApp={l.chooseApp} touch onClose={nav.close} />;
          case "album-menu":
            return <AlbumMenuSheet key={key} id={l.id} />;
          case "out-of-sync":
            return <OutOfSyncSheet key={key} />;
          case "fetch":
            return <FetchDialog key={key} id={l.id} how={l.how} />;
          case "free-space":
            return <FreeSpaceSheet key={key} />;
          default:
            // "details" lives inside the viewer; "selection" is state only.
            return null;
        }
      });
  return <PresenceList items={nodes.filter((n): n is React.ReactElement => !!n).map((n) => ({ key: String(n.key), node: n, instant: /viewer$/.test(String(n.key)) }))} />;
}
