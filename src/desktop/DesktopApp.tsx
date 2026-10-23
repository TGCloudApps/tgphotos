/**
 * Desktop shell: sidebar, top bar (search or selection actions),
 * justified timeline with scrubber, keyboard shortcuts and dragging from the
 * system to upload.
 */
import { createElement as h, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  ChevronsUpDown,
  CloudUpload,
  Download,
  FolderUp,
  HardDriveDownload,
  Heart,
  HeartOff,
  ImagePlus,
  Images,
  Library,
  LogOut,
  Pencil,
  RefreshCw,
  Repeat,
  RotateCcw,
  Search,
  Send,
  Trash2,
  Upload,
  Video,
  X,
  Clapperboard,
  Clock,
  Languages,
} from "lucide-react";
import { formatSize } from "@tgcloud/ui/core/format";
import { LanguagePicker } from "@tgcloud/ui/ui/LanguagePicker";
import { Dialog } from "@tgcloud/ui/desktop/ui";
import { t, tc } from "../i18n";
import { notifyError } from "@tgcloud/ui/core/notices";
import { isLive, transfers, useTransfers } from "@tgcloud/ui/core/transfers";
import { uploads, useUploads } from "@tgcloud/ui/core/uploads";
import { app } from "@tgcloud/ui/core/app";
import { ContextMenu, closeMenu, openMenu, useMenu } from "@tgcloud/ui/desktop/Menu";
import { Toasts } from "@tgcloud/ui/desktop/Toasts";
import { Button, IconButton } from "@tgcloud/ui/desktop/ui";
import { EmptyState, ErrorState } from "@tgcloud/ui/ui/States";
import { TransfersView } from "@tgcloud/ui/ui/Transfers";
import type { Session } from "@tgcloud/ui/ui/Boot";
import { api, type Media } from "../core/api";
import { actions, findMedia, refresh, refreshSoon, useAlbumMedia, useAlbums, useList, useSearch, useUsage } from "../core/data";
import { nav, useLayers, useRoute, type Dest } from "../core/nav";
import { useSelection } from "../core/select";
import { Collections, albumPeriod } from "../shared/Collections";
import { Liked, Shorts } from "../shared/Shorts";
import { useCurrentVault } from "@tgcloud/ui/core/vault";
import { Timeline } from "../timeline/Timeline";
import { DeskLayers } from "./Dialogs";
import { findLocal, loadLibrary, merge, mergeTrash, startLibrary, useLibrary } from "../core/library";
import { useDevice } from "../core/deviceStore";
import { startDevice } from "../core/deviceTrash";
import { UpdateBanner } from "@tgcloud/ui/ui/Update";
import { Avatar } from "@tgcloud/ui/ui/Avatar";
import { VaultAvatar } from "@tgcloud/ui/ui/VaultAvatar";
import { useMe } from "@tgcloud/ui/core/me";
import { OutOfSyncBanner } from "../shared/DeviceSync";
import { ChatList, ChatScreen, useChatTitle } from "../shared/Chats";
import { ScrollPane, scrollToTop } from "../shared/Scroll";
import { backupLocal } from "../shared/Viewer";
import { OfflineBadge } from "@tgcloud/ui/ui/Offline";
import { startBackup, useBackup } from "../core/backup";

/** Extensions accepted in the native picker. */
const MEDIA_EXT = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "dng", "raw", "cr2", "nef", "arw", "mp4", "mov", "m4v", "3gp", "mkv", "webm", "avi"];

export default function DesktopApp({ session }: { session: Session }) {
  const route = useRoute();
  const fileInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const album = route.dest === "album" ? route.album : 0;

  useEffect(() => {
    useUploads.setState({ onDone: refreshSoon });
    // Trash older than 30 days is deleted for good.
    api.housekeep().then((n) => n && refreshSoon()).catch(() => {});
    startBackup();
    startLibrary();
    startDevice();
  }, []);

  // The upload queue moved: what was uploaded leaves the local gallery (becomes vault media).
  const transfersList = useTransfers((s) => s.list);
  useEffect(() => {
    const t = setTimeout(() => void loadLibrary(), 1500);
    return () => clearTimeout(t);
  }, [transfersList]);

  // Changing screens clears the selection.
  useEffect(() => useSelection.getState().clear(), [route.dest, route.album]);

  const pick = (folder: boolean) => {
    if (!isTauri()) return fileInput.current?.click();
    void pickNative(folder, album);
  };

  useShortcuts(searchRef, pick);
  useOsDrop(album);

  return (
    <div className="desk flex h-full bg-canvas">
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
      <Sidebar session={session} pick={pick} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar searchRef={searchRef} pick={pick} />
        <Content pick={pick} />
      </div>
      <ContextMenu />
      <DeskLayers onSignedOut={session.signOut} />
      <Toasts onOpenTransfers={() => nav.dest("transfers")} />
      <LanguageDialog />
    </div>
  );
}

// ---- sidebar ----------------------------------------------------------------------------

function Sidebar({ session, pick }: { session: Session; pick: (folder: boolean) => void }) {
  const route = useRoute();
  const { data: usage } = useUsage();
  const me = useMe((s) => s.me);
  const vault = useCurrentVault((s) => s.vault);
  const live = useTransfers((s) => s.list.filter(isLive).length);
  const signOut = () => nav.open({ type: "confirm", action: "signout", ids: [] });

  return (
    <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-hairline bg-s1">
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left + 8, r.bottom, [
            { label: t("desktop.switchVault"), icon: h(Repeat), run: session.switchVault },
            { label: t("desktop.syncNow"), icon: h(RefreshCw), run: () => void api.syncNow().then(() => refresh()).catch(notifyError) },
            { label: t("desktop.language"), icon: h(Languages), run: () => useLangDialog.setState({ open: true }) },
            "sep",
            { label: t("desktop.signOut"), icon: h(LogOut), danger: true, run: signOut },
          ]);
        }}
        className="mx-2 mt-2 mb-1 flex h-12 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-s3"
        title={t("desktop.openVault")}
      >
        <VaultAvatar vault={vault ?? session.vault} size={28} className="step rounded-lg bg-brand text-white" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-5 font-bold tracking-tight">{session.vault.name}</p>
          <p className="text-[11px] leading-4 font-medium text-fg-3">{app.name}</p>
        </div>
        <ChevronsUpDown size={16} className="shrink-0 text-fg-3" />
      </button>

      <div className="px-3 pb-3">
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom + 4, [
              { label: t("desktop.uploadMedia"), icon: h(Upload), shortcut: "Mod+U", run: () => pick(false) },
              { label: t("desktop.uploadFolder"), icon: h(FolderUp), run: () => pick(true) },
              "sep",
              { label: t("desktop.importDrive"), icon: h(HardDriveDownload), run: () => nav.open({ type: "import" }) },
              { label: t("desktop.importGoogle"), icon: h(Images), run: () => nav.open({ type: "import-google" }) },
            ]);
          }}
          className="step flex h-10 w-full items-center gap-2 rounded-lg bg-brand px-3.5 text-[14px] font-semibold text-white hover:brightness-110 active:translate-y-0.5 active:shadow-none"
        >
          <Upload size={18} /> {t("desktop.upload")}
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3">
        <NavItem dest="photos" icon={<Images />} label={t("desktop.dest.photos")} active={route.dest === "photos"} />
        <NavItem dest="shorts" icon={<Clapperboard />} label={t("desktop.dest.shorts")} active={route.dest === "shorts" || route.dest === "liked"} />
        <NavItem dest="search" icon={<Search />} label={t("desktop.dest.search")} active={route.dest === "search"} />
        <NavItem dest="collections" icon={<Library />} label={t("desktop.dest.collections")} active={route.dest === "collections" || route.dest === "album"} />
        <div className="my-2 h-px bg-hairline" />
        <NavItem dest="favorites" icon={<Heart />} label={t("desktop.dest.favorites")} active={route.dest === "favorites"} />
        <NavItem dest="recent" icon={<Clock />} label={t("desktop.dest.recent")} active={route.dest === "recent"} />
        <NavItem dest="videos" icon={<Video />} label={t("desktop.dest.videos")} active={route.dest === "videos"} />
        <NavItem dest="archive" icon={<Archive />} label={t("desktop.dest.archive")} active={route.dest === "archive"} />
        <NavItem dest="trash" icon={<Trash2 />} label={t("desktop.dest.trash")} active={route.dest === "trash"} />
        <div className="my-2 h-px bg-hairline" />
        <NavItem dest="transfers" icon={<ArrowDownUp />} label={t("desktop.dest.transfers")} active={route.dest === "transfers"} badge={live || undefined} />
        <BackupItem />
      </nav>

      <div className="border-t border-hairline p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
          <Avatar size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-fg">{me?.name || t("desktop.account")}</p>
            <p className="truncate text-[12px] text-fg-3 tabular">
              {usage
                ? t("desktop.usage", { photos: t("desktop.photosCount", { n: usage.photos }), videos: t("desktop.videosCount", { n: usage.videos }), size: formatSize(usage.bytes) })
                : "…"}
            </p>
          </div>
          <button title={t("desktop.signOut")} aria-label={t("desktop.signOut")} onClick={signOut} className="grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-s3 hover:text-fg">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavItem({ dest, icon, label, active, badge }: { dest: Dest; icon: ReactNode; label: string; active: boolean; badge?: number }) {
  return (
    <button
      // Clicking the destination you are already on again: goes back to the top.
      onClick={() => (active && dest !== "search" ? scrollToTop() : dest === "search" ? nav.search("") : nav.dest(dest))}
      className={`relative flex h-[34px] shrink-0 items-center gap-3 rounded-lg px-2.5 text-[14px] font-medium transition-colors duration-[120ms] [&>svg]:size-[18px] ${
        active ? "bg-brand-soft text-fg [&>svg]:text-brand" : "text-fg-2 hover:bg-s3 hover:text-fg"
      }`}
    >
      {active && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand" />}
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {badge && <span className="rounded-full bg-info-soft px-1.5 text-[11px] font-semibold text-info tabular">{badge}</span>}
    </button>
  );
}

function BackupItem() {
  const folders = useBackup((s) => s.folders.length);
  const running = useBackup((s) => s.running);
  return (
    <button
      onClick={() => nav.open({ type: "backup" })}
      className="flex h-[34px] shrink-0 items-center gap-3 rounded-lg px-2.5 text-[14px] font-medium text-fg-2 transition-colors duration-[120ms] hover:bg-s3 hover:text-fg [&>svg]:size-[18px]"
    >
      <CloudUpload className={running ? "animate-pulse text-brand" : undefined} />
      <span className="flex-1 text-left">{t("desktop.backup")}</span>
      <span className="text-[11px] font-semibold text-fg-3 tabular">{folders ? t("desktop.backupFolders", { n: folders }) : t("desktop.backupOff")}</span>
    </button>
  );
}

// ---- top bar ----------------------------------------------------------------------------

const title = (d: Dest) => t(`desktop.dest.${d}`);

function TopBar({ searchRef, pick }: { searchRef: React.RefObject<HTMLInputElement | null>; pick: (folder: boolean) => void }) {
  const route = useRoute();
  const chatTitle = useChatTitle();
  const selected = useSelection((s) => s.ids);
  const { data: albums = [] } = useAlbums();

  if (selected.size) return <SelectionBar ids={[...selected]} />;

  const a = route.dest === "album" ? albums.find((x) => x.id === route.album) : undefined;
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline px-4">
      {route.dest === "album" ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <IconButton label={t("desktop.backShortcut")} onClick={nav.back}>
            <X />
          </IconButton>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold">{a?.name ?? t("desktop.dest.album")}</h1>
            <p className="truncate text-[12px] text-fg-3 tabular">{a ? (albumPeriod(a) ? t("desktop.albumItemsPeriod", { n: a.count, period: albumPeriod(a) }) : t("desktop.albumItems", { n: a.count })) : ""}</p>
          </div>
          <div className="ml-2 flex items-center gap-1">
            <Button variant="ghost" onClick={() => pick(false)}>
              <ImagePlus /> {t("desktop.addPhotos")}
            </Button>
            <IconButton label={t("desktop.renameAlbum")} onClick={() => nav.open({ type: "name", mode: "album-rename", id: route.album })}>
              <Pencil />
            </IconButton>
            <IconButton label={t("desktop.deleteAlbum")} onClick={() => nav.open({ type: "confirm", action: "album-delete", ids: [route.album] })}>
              <Trash2 />
            </IconButton>
          </div>
        </div>
      ) : (
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{route.dest === "chat" ? chatTitle : title(route.dest)}</h1>
      )}
      {route.dest === "trash" && (
        <Button variant="ghost" onClick={() => nav.open({ type: "confirm", action: "empty", ids: [] })}>
          <Trash2 /> {t("desktop.emptyTrash")}
        </Button>
      )}
      <OfflineBadge touch={false} />
      <SearchBox inputRef={searchRef} initial={route.dest === "search" ? route.query : ""} />
    </header>
  );
}

function SearchBox({ inputRef, initial }: { inputRef: React.RefObject<HTMLInputElement | null>; initial: string }) {
  const [text, setText] = useState(initial);
  const route = useRoute();
  const typed = useRef(false);
  useEffect(() => {
    if (route.dest !== "search") setText("");
  }, [route.dest]);
  useEffect(() => {
    if (!typed.current) return;
    const t = setTimeout(() => nav.search(text), 200);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="relative w-[340px] shrink-0">
      <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-3" />
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => {
          typed.current = true;
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setText("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={t("desktop.searchPlaceholder")}
        className="surface h-9 w-full rounded-lg border border-line bg-s2 pr-3 pl-9 text-[14px] text-fg outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25"
      />
    </div>
  );
}

function SelectionBar({ ids: all }: { ids: number[] }) {
  // Files from the backup folders that have not uploaded yet (ids < 0): backup and trash apply to them.
  const ids = all.filter((id) => id > 0);
  const local = all.filter((id) => id < 0).map(findLocal).filter((m): m is Media => !!m);
  const route = useRoute();
  const clear = () => useSelection.getState().clear();
  const inTrash = route.dest === "trash";
  const album = route.dest === "album" ? route.album : 0;
  const items = ids.map(findMedia).filter((m): m is Media => !!m);
  const allFav = items.length > 0 && items.every((m) => m.favorite);
  const archived = route.dest === "archive";
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-hairline bg-s2 px-4">
      <IconButton label={t("desktop.clearSelection")} onClick={clear}>
        <X />
      </IconButton>
      {local.length > 0 && (
        <Button
          variant="ghost"
          onClick={() => {
            void backupLocal(local);
            clear();
          }}
        >
          <CloudUpload /> {t("desktop.backupN", { n: local.length })}
        </Button>
      )}
      {local.length > 0 && ids.length === 0 && !inTrash && (
        <IconButton label={t("desktop.trashShortcut")} onClick={() => void actions.trash(all)}>
          <Trash2 />
        </IconButton>
      )}
      <p className="ml-1 flex-1 text-[15px] font-semibold tabular">
        {t("desktop.selected", { n: all.length })}
      </p>
      {inTrash ? (
        <>
          <Button variant="ghost" onClick={() => void actions.restore(all)}>
            <RotateCcw /> {tc("common.restore")}
          </Button>
          <Button variant="ghost" onClick={() => nav.open({ type: "confirm", action: "purge", ids: all })}>
            <Trash2 /> {t("desktop.purge")}
          </Button>
        </>
      ) : ids.length > 0 && (
        <>
          <IconButton label={allFav ? tc("common.unfavorite") : tc("common.favorite")} onClick={() => void actions.favorite(ids, !allFav)}>
            {allFav ? <HeartOff /> : <Heart />}
          </IconButton>
          <IconButton label={t("desktop.sendVault")} onClick={() => nav.open({ type: "send-vault", ids })}>
            <Send />
          </IconButton>
          <IconButton label={t("desktop.addToAlbum")} onClick={() => nav.open({ type: "album-pick", ids })}>
            <ImagePlus />
          </IconButton>
          <IconButton label={t("desktop.downloadShortcut")} onClick={() => actions.download(ids)}>
            <Download />
          </IconButton>
          {album > 0 && (
            <IconButton label={t("desktop.removeFromAlbum")} onClick={() => void actions.albumRemove(album, ids)}>
              <X />
            </IconButton>
          )}
          <IconButton label={archived ? t("desktop.unarchive") : t("desktop.archive")} onClick={() => void actions.archive(ids, !archived)}>
            {archived ? <ArchiveRestore /> : <Archive />}
          </IconButton>
          <IconButton label={t("desktop.trashShortcut")} onClick={() => void actions.trash(all)}>
            <Trash2 />
          </IconButton>
        </>
      )}
    </header>
  );
}

// ---- content ----------------------------------------------------------------------------

function Content({ pick }: { pick: (folder: boolean) => void }) {
  const route = useRoute();
  const over = useOver();
  const vault = useCurrentVault((s) => s.vault?.id);
  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {route.dest === "photos" && <ListPane view="timeline" pick={pick} />}
      {route.dest === "shorts" && <Shorts key={vault} touch={false} />}
      {route.dest === "liked" && <Liked key={vault} touch={false} />}
      {route.dest === "favorites" && <ListPane view="favorites" pick={pick} />}
      {route.dest === "videos" && <ListPane view="videos" pick={pick} />}
      {route.dest === "recent" && <ListPane view="recent" pick={pick} />}
      {route.dest === "archive" && <ListPane view="archive" pick={pick} />}
      {route.dest === "trash" && <ListPane view="trash" pick={pick} />}
      {route.dest === "album" && <AlbumPane id={route.album} pick={pick} />}
      {route.dest === "search" && <SearchPane text={route.query} />}
      {route.dest === "collections" && (
        <ScrollPane>
          <Collections touch={false} />
        </ScrollPane>
      )}
      {route.dest === "chats" && (
        <ScrollPane>
          <ChatList touch={false} />
        </ScrollPane>
      )}
      {route.dest === "chat" && (
        <ScrollPane>
          <ChatScreen touch={false} />
        </ScrollPane>
      )}
      {route.dest === "transfers" && (
        <div className="flex-1 overflow-y-auto px-4">
          <TransfersView touch={false} />
        </div>
      )}
      {over && (
        <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-2xl border-2 border-dashed border-brand bg-brand-soft/40 text-[14px] font-semibold text-fg">
          {route.dest === "album" ? t("desktop.dropToAlbum") : t("desktop.dropMedia")}
        </div>
      )}
    </main>
  );
}

type Q = { data?: Media[]; error: unknown; refetch: () => void; isLoading: boolean };

function Grid({ q, empty, byAdded }: { q: Q; empty: ReactNode; byAdded?: boolean }) {
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  if (q.isLoading) return <div className="flex-1" />;
  if (!q.data?.length) return <>{empty}</>;
  return <Timeline items={q.data} touch={false} byAdded={byAdded} />;
}

const empties = { timeline: Images, favorites: Heart, videos: Video, recent: Clock, archive: Archive, trash: Trash2 } as const;

function ListPane({ view, pick }: { view: keyof typeof empties; pick: (folder: boolean) => void }) {
  const e = { icon: empties[view], title: t(`desktop.empty.${view}.title`), text: t(`desktop.empty.${view}.text`) };
  const vault = useList(view);
  // Photos: what is in the backup folders and has not uploaded yet comes along.
  const local = useLibrary((s) => s.items);
  // Trash: the computer's trash comes along (what has no copy in the vault).
  const trashed = useDevice((s) => s.localOnly);
  const data = useMemo(
    () => (!vault.data ? vault.data : view === "timeline" ? merge(vault.data, local) : view === "trash" ? mergeTrash(vault.data, trashed) : vault.data),
    [view, vault.data, local, trashed],
  );
  const grid = (
    <Grid
      q={{ ...vault, data }}
      byAdded={view === "recent"}
      empty={
        <EmptyState
          icon={e.icon}
          title={e.title}
          text={e.text}
          action={
            view === "timeline" ? (
              <Button variant="primary" onClick={() => pick(false)}>
                <Upload /> {t("desktop.uploadMediaCta")}
              </Button>
            ) : undefined
          }
        />
      }
    />
  );
  if (view !== "trash" && view !== "timeline") return grid;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Notices that call for action: fixed above the grid (out of sync, update). */}
      <div className="mx-auto w-full max-w-[880px] space-y-2 px-6 pt-3 empty:hidden">
        <OutOfSyncBanner touch={false} />
        {view === "timeline" && <UpdateBanner touch={false} />}
      </div>
      {grid}
    </div>
  );
}

function AlbumPane({ id, pick }: { id: number; pick: (folder: boolean) => void }) {
  return (
    <Grid
      q={useAlbumMedia(id)}
      empty={
        <EmptyState
          icon={Images}
          title={t("desktop.emptyAlbum.title")}
          text={t("desktop.emptyAlbum.text")}
          action={
            <Button variant="primary" onClick={() => pick(false)}>
              <ImagePlus /> {t("desktop.addPhotos")}
            </Button>
          }
        />
      }
    />
  );
}

function SearchPane({ text }: { text: string }) {
  const q = useSearch(text);
  if (!text.trim()) return <EmptyState sync={false} icon={Search} title={t("desktop.search.title")} text={t("desktop.search.text")} />;
  return <Grid q={{ ...q, isLoading: q.isLoading && q.fetchStatus !== "idle" }} empty={<EmptyState icon={Search} title={t("desktop.search.none")} text={t("desktop.search.noneText", { q: text })} />} />;
}

// ---- keyboard, picker and dragging ------------------------------------------------------

function useShortcuts(searchRef: React.RefObject<HTMLInputElement | null>, pick: (folder: boolean) => void) {
  const layers = useLayers();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        return e.key === "ArrowLeft" ? nav.back() : nav.forward();
      }
      if (useMenu.getState().at) return;
      if (layers.length) {
        if (e.key === "Escape" && !typing) nav.close();
        return;
      }
      if (typing) return;
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      const sel = useSelection.getState();
      const ids = [...sel.ids];
      const route = nav.route();
      if ((mod && k === "k") || e.key === "/") return run(() => searchRef.current?.focus());
      if (mod && k === "u") return run(() => pick(false));
      if (e.key === "Escape" && ids.length) return run(sel.clear);
      if (!ids.length) return;
      if (mod && k === "d") return run(() => actions.download(ids));
      if (e.key === "Delete") return run(() => (route.dest === "trash" ? nav.open({ type: "confirm", action: "purge", ids }) : void actions.trash(ids)));
      if (k === "f" && !mod) {
        const all = ids.map(findMedia).every((m) => m?.favorite);
        return run(() => void actions.favorite(ids, !all));
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) nav.back();
      if (e.button === 4) nav.forward();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [layers, searchRef, pick]);
  useEffect(() => closeMenu, []);
}

async function pickNative(directory: boolean, album: number) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: !directory,
    directory,
    title: directory ? t("desktop.pickFolder") : t("desktop.pickMedia"),
    filters: directory ? undefined : [{ name: t("desktop.mediaFilter"), extensions: MEDIA_EXT }],
  });
  if (!picked) return;
  void transfers.uploadPaths(Array.isArray(picked) ? picked : [picked], album);
}

/** Language choice (vault menu → Language…). */
const useLangDialog = create<{ open: boolean }>(() => ({ open: false }));

function LanguageDialog() {
  const open = useLangDialog((s) => s.open);
  if (!open) return null;
  const close = () => useLangDialog.setState({ open: false });
  return (
    <Dialog onClose={close} width={400}>
      <h2 className="pb-3 text-[16px] font-semibold">{tc("common.language")}</h2>
      <LanguagePicker touch={false} />
      <div className="mt-4 flex justify-end">
        <Button onClick={close}>{tc("common.close")}</Button>
      </div>
    </Dialog>
  );
}

/** Highlight while system files pass over the window. */
const useDrop = create<{ over: boolean }>(() => ({ over: false }));
const useOver = () => useDrop((s) => s.over);

/** Drag from the system (native Tauri event, with the paths). */
function useOsDrop(album: number) {
  useEffect(() => {
    if (!isTauri()) return;
    // Registration is asynchronous: if cleanup arrives first (StrictMode mounts
    // twice), unregister as soon as the promise resolves. Without that, every
    // dropped file would be uploaded twice.
    let off: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const unlisten = await getCurrentWebview().onDragDropEvent(({ payload: p }) => {
        if (p.type === "enter" || p.type === "over") useDrop.setState({ over: true });
        else if (p.type === "leave") useDrop.setState({ over: false });
        else if (p.type === "drop") {
          useDrop.setState({ over: false });
          // With the Google Photos window open, dropped .zip files belong to it, not uploads.
          if (nav.layers().some((l) => l.type === "import-google")) return;
          if (p.paths.length) void transfers.uploadPaths(p.paths, album);
        }
      });
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [album]);
}
