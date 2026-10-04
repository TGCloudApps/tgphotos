/**
 * Casca do desktop: barra lateral, barra de topo (busca ou ações da seleção),
 * linha do tempo justificada com scrubber, atalhos de teclado e arrastar do
 * sistema para enviar.
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
} from "lucide-react";
import { formatSize } from "@tgcloud/ui/core/format";
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
import { Timeline } from "../timeline/Timeline";
import { DeskLayers } from "./Dialogs";
import { findLocal, loadLibrary, merge, mergeTrash, startLibrary, useLibrary } from "../core/library";
import { useDevice } from "../core/deviceStore";
import { startDevice } from "../core/deviceTrash";
import { OutOfSyncBanner } from "../shared/DeviceSync";
import { ChatList, ChatScreen, useChatTitle } from "../shared/Chats";
import { backupLocal } from "../shared/Viewer";
import { OfflineBadge } from "@tgcloud/ui/ui/Offline";
import { startBackup, useBackup } from "../core/backup";

/** Extensões aceitas no seletor nativo. */
const MEDIA_EXT = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "dng", "raw", "cr2", "nef", "arw", "mp4", "mov", "m4v", "3gp", "mkv", "webm", "avi"];

export default function DesktopApp({ session }: { session: Session }) {
  const route = useRoute();
  const fileInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const album = route.dest === "album" ? route.album : 0;

  useEffect(() => {
    useUploads.setState({ onDone: refreshSoon });
    // Lixeira com mais de 30 dias sai de vez.
    api.housekeep().then((n) => n && refreshSoon()).catch(() => {});
    startBackup();
    startLibrary();
    startDevice();
  }, []);

  // A fila de envios andou: o que subiu sai da galeria local (vira mídia do vault).
  const transfersList = useTransfers((s) => s.list);
  useEffect(() => {
    const t = setTimeout(() => void loadLibrary(), 1500);
    return () => clearTimeout(t);
  }, [transfersList]);

  // Trocar de tela limpa a seleção.
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
    </div>
  );
}

// ---- barra lateral -----------------------------------------------------------------------

function Sidebar({ session, pick }: { session: Session; pick: (folder: boolean) => void }) {
  const route = useRoute();
  const { data: usage } = useUsage();
  const live = useTransfers((s) => s.list.filter(isLive).length);
  const signOut = () => nav.open({ type: "confirm", action: "signout", ids: [] });

  return (
    <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-hairline bg-s1">
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left + 8, r.bottom, [
            { label: "Trocar de vault…", icon: h(Repeat), run: session.switchVault },
            { label: "Sincronizar agora", icon: h(RefreshCw), run: () => void api.syncNow().then(() => refresh()).catch(notifyError) },
            "sep",
            { label: "Sair da conta", icon: h(LogOut), danger: true, run: signOut },
          ]);
        }}
        className="mx-2 mt-2 mb-1 flex h-12 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-s3"
        title="Vault aberto"
      >
        <div className="step grid size-7 shrink-0 place-items-center rounded-lg bg-brand text-white">
          <app.icon size={15} />
        </div>
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
              { label: "Fotos e vídeos…", icon: h(Upload), shortcut: "Mod+U", run: () => pick(false) },
              { label: "Pasta…", icon: h(FolderUp), run: () => pick(true) },
              "sep",
              { label: "Importar do TGDrive…", icon: h(HardDriveDownload), run: () => nav.open({ type: "import" }) },
            ]);
          }}
          className="step flex h-10 w-full items-center gap-2 rounded-lg bg-brand px-3.5 text-[14px] font-semibold text-white hover:brightness-110 active:translate-y-0.5 active:shadow-none"
        >
          <Upload size={18} /> Enviar
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3">
        <NavItem dest="photos" icon={<Images />} label="Fotos" active={route.dest === "photos"} />
        <NavItem dest="search" icon={<Search />} label="Busca" active={route.dest === "search"} />
        <NavItem dest="collections" icon={<Library />} label="Coleções" active={route.dest === "collections" || route.dest === "album"} />
        <div className="my-2 h-px bg-hairline" />
        <NavItem dest="favorites" icon={<Heart />} label="Favoritos" active={route.dest === "favorites"} />
        <NavItem dest="videos" icon={<Video />} label="Vídeos" active={route.dest === "videos"} />
        <NavItem dest="archive" icon={<Archive />} label="Arquivo" active={route.dest === "archive"} />
        <NavItem dest="trash" icon={<Trash2 />} label="Lixeira" active={route.dest === "trash"} />
        <div className="my-2 h-px bg-hairline" />
        <NavItem dest="transfers" icon={<ArrowDownUp />} label="Transferências" active={route.dest === "transfers"} badge={live || undefined} />
        <BackupItem />
      </nav>

      <div className="border-t border-hairline p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-fg tabular">
              {usage ? `${usage.photos.toLocaleString("pt-BR")} fotos · ${usage.videos.toLocaleString("pt-BR")} vídeos` : "…"}
            </p>
            <p className="text-[12px] text-fg-3 tabular">{usage ? `${formatSize(usage.bytes)} · sem limite` : ""}</p>
          </div>
          <button title="Sair da conta" aria-label="Sair da conta" onClick={signOut} className="grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-s3 hover:text-fg">
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
      onClick={() => (dest === "search" ? nav.search("") : nav.dest(dest))}
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
      <span className="flex-1 text-left">Backup automático</span>
      <span className="text-[11px] font-semibold text-fg-3 tabular">{folders ? `${folders} ${folders === 1 ? "pasta" : "pastas"}` : "desligado"}</span>
    </button>
  );
}

// ---- barra de topo -------------------------------------------------------------------------

const titles: Record<Dest, string> = {
  photos: "Fotos",
  collections: "Coleções",
  search: "Busca",
  favorites: "Favoritos",
  videos: "Vídeos",
  archive: "Arquivo",
  trash: "Lixeira",
  transfers: "Transferências",
  album: "Álbum",
  device: "No dispositivo",
  chats: "Importar de chats",
  chat: "Chat",
};

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
          <IconButton label="Voltar (Alt+←)" onClick={nav.back}>
            <X />
          </IconButton>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold">{a?.name ?? "Álbum"}</h1>
            <p className="truncate text-[12px] text-fg-3 tabular">{a ? `${a.count} ${a.count === 1 ? "item" : "itens"}${albumPeriod(a) ? ` · ${albumPeriod(a)}` : ""}` : ""}</p>
          </div>
          <div className="ml-2 flex items-center gap-1">
            <Button variant="ghost" onClick={() => pick(false)}>
              <ImagePlus /> Adicionar fotos
            </Button>
            <IconButton label="Renomear álbum" onClick={() => nav.open({ type: "name", mode: "album-rename", id: route.album })}>
              <Pencil />
            </IconButton>
            <IconButton label="Apagar álbum" onClick={() => nav.open({ type: "confirm", action: "album-delete", ids: [route.album] })}>
              <Trash2 />
            </IconButton>
          </div>
        </div>
      ) : (
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{route.dest === "chat" ? chatTitle : titles[route.dest]}</h1>
      )}
      {route.dest === "trash" && (
        <Button variant="ghost" onClick={() => nav.open({ type: "confirm", action: "empty", ids: [] })}>
          <Trash2 /> Esvaziar lixeira
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
        placeholder="Buscar fotos (Ctrl+K)"
        className="surface h-9 w-full rounded-lg border border-line bg-s2 pr-3 pl-9 text-[14px] text-fg outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25"
      />
    </div>
  );
}

function SelectionBar({ ids: all }: { ids: number[] }) {
  // Arquivos das pastas de backup que ainda não subiram (ids < 0): backup e lixeira valem para eles.
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
      <IconButton label="Limpar seleção (Esc)" onClick={clear}>
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
          <CloudUpload /> Fazer backup de {local.length}
        </Button>
      )}
      {local.length > 0 && ids.length === 0 && !inTrash && (
        <IconButton label="Mover para a lixeira (Delete)" onClick={() => void actions.trash(all)}>
          <Trash2 />
        </IconButton>
      )}
      <p className="ml-1 flex-1 text-[15px] font-semibold tabular">
        {all.length} {all.length === 1 ? "selecionado" : "selecionados"}
      </p>
      {inTrash ? (
        <>
          <Button variant="ghost" onClick={() => void actions.restore(all)}>
            <RotateCcw /> Restaurar
          </Button>
          <Button variant="ghost" onClick={() => nav.open({ type: "confirm", action: "purge", ids: all })}>
            <Trash2 /> Apagar para sempre
          </Button>
        </>
      ) : ids.length > 0 && (
        <>
          <IconButton label={allFav ? "Desfavoritar" : "Favoritar"} onClick={() => void actions.favorite(ids, !allFav)}>
            {allFav ? <HeartOff /> : <Heart />}
          </IconButton>
          <IconButton label="Enviar para outro vault" onClick={() => nav.open({ type: "send-vault", ids })}>
            <Send />
          </IconButton>
          <IconButton label="Adicionar a um álbum" onClick={() => nav.open({ type: "album-pick", ids })}>
            <ImagePlus />
          </IconButton>
          <IconButton label="Baixar (Ctrl+D)" onClick={() => actions.download(ids)}>
            <Download />
          </IconButton>
          {album > 0 && (
            <IconButton label="Remover do álbum" onClick={() => void actions.albumRemove(album, ids)}>
              <X />
            </IconButton>
          )}
          <IconButton label={archived ? "Desarquivar" : "Arquivar"} onClick={() => void actions.archive(ids, !archived)}>
            {archived ? <ArchiveRestore /> : <Archive />}
          </IconButton>
          <IconButton label="Mover para a lixeira (Delete)" onClick={() => void actions.trash(all)}>
            <Trash2 />
          </IconButton>
        </>
      )}
    </header>
  );
}

// ---- conteúdo --------------------------------------------------------------------------------

function Content({ pick }: { pick: (folder: boolean) => void }) {
  const route = useRoute();
  const over = useOver();
  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {route.dest === "photos" && <ListPane view="timeline" pick={pick} />}
      {route.dest === "favorites" && <ListPane view="favorites" pick={pick} />}
      {route.dest === "videos" && <ListPane view="videos" pick={pick} />}
      {route.dest === "archive" && <ListPane view="archive" pick={pick} />}
      {route.dest === "trash" && <ListPane view="trash" pick={pick} />}
      {route.dest === "album" && <AlbumPane id={route.album} pick={pick} />}
      {route.dest === "search" && <SearchPane text={route.query} />}
      {route.dest === "collections" && (
        <div className="flex-1 overflow-y-auto">
          <Collections touch={false} />
        </div>
      )}
      {route.dest === "chats" && (
        <div className="flex-1 overflow-y-auto">
          <ChatList touch={false} />
        </div>
      )}
      {route.dest === "chat" && (
        <div className="flex-1 overflow-y-auto">
          <ChatScreen touch={false} />
        </div>
      )}
      {route.dest === "transfers" && (
        <div className="flex-1 overflow-y-auto px-4">
          <TransfersView touch={false} />
        </div>
      )}
      {over && (
        <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-2xl border-2 border-dashed border-brand bg-brand-soft/40 text-[14px] font-semibold text-fg">
          Solte para enviar {route.dest === "album" ? "para o álbum" : "fotos e vídeos"}
        </div>
      )}
    </main>
  );
}

type Q = { data?: Media[]; error: unknown; refetch: () => void; isLoading: boolean };

function Grid({ q, empty }: { q: Q; empty: ReactNode }) {
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  if (q.isLoading) return <div className="flex-1" />;
  if (!q.data?.length) return <>{empty}</>;
  return <Timeline items={q.data} touch={false} />;
}

const empties = {
  timeline: { icon: Images, title: "Nenhuma foto ainda", text: "Arraste fotos e vídeos para cá ou use Enviar." },
  favorites: { icon: Heart, title: "Nenhum favorito", text: "Marque o coração de uma foto (tecla F) para ela aparecer aqui." },
  videos: { icon: Video, title: "Nenhum vídeo", text: "Os vídeos que você enviar aparecem aqui." },
  archive: { icon: Archive, title: "Arquivo vazio", text: "Arquive fotos para tirá-las da linha do tempo sem apagar." },
  trash: { icon: Trash2, title: "Lixeira vazia", text: "O que você excluir fica aqui por 30 dias." },
} as const;

function ListPane({ view, pick }: { view: keyof typeof empties; pick: (folder: boolean) => void }) {
  const e = empties[view];
  const vault = useList(view);
  // Fotos: o que está nas pastas de backup e ainda não subiu entra junto.
  const local = useLibrary((s) => s.items);
  // Lixeira: a do computador entra junto (o que não tem cópia no vault).
  const trashed = useDevice((s) => s.localOnly);
  const data = useMemo(
    () => (!vault.data ? vault.data : view === "timeline" ? merge(vault.data, local) : view === "trash" ? mergeTrash(vault.data, trashed) : vault.data),
    [view, vault.data, local, trashed],
  );
  const grid = (
    <Grid
      q={{ ...vault, data }}
      empty={
        <EmptyState
          icon={e.icon}
          title={e.title}
          text={e.text}
          action={
            view === "timeline" ? (
              <Button variant="primary" onClick={() => pick(false)}>
                <Upload /> Enviar fotos e vídeos
              </Button>
            ) : undefined
          }
        />
      }
    />
  );
  if (view !== "trash") return grid;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-[880px] px-6 pt-3 empty:hidden">
        <OutOfSyncBanner touch={false} />
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
          title="Álbum vazio"
          text="Selecione fotos na linha do tempo e use Adicionar a um álbum, ou envie direto para cá."
          action={
            <Button variant="primary" onClick={() => pick(false)}>
              <ImagePlus /> Adicionar fotos
            </Button>
          }
        />
      }
    />
  );
}

function SearchPane({ text }: { text: string }) {
  const q = useSearch(text);
  if (!text.trim()) return <EmptyState sync={false} icon={Search} title="Buscar fotos" text="Por nome do arquivo, modelo da câmera, nome do álbum ou pasta de origem." />;
  return <Grid q={{ ...q, isLoading: q.isLoading && q.fetchStatus !== "idle" }} empty={<EmptyState icon={Search} title="Nada encontrado" text={`Nenhuma foto combina com “${text}”.`} />} />;
}

// ---- teclado, seletor e arrastar ------------------------------------------------------------------

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
    title: directory ? "Enviar pasta" : "Enviar fotos e vídeos",
    filters: directory ? undefined : [{ name: "Fotos e vídeos", extensions: MEDIA_EXT }],
  });
  if (!picked) return;
  void transfers.uploadPaths(Array.isArray(picked) ? picked : [picked], album);
}

/** Destaque enquanto arquivos do sistema passam por cima da janela. */
const useDrop = create<{ over: boolean }>(() => ({ over: false }));
const useOver = () => useDrop((s) => s.over);

/** Arrastar do sistema (evento nativo do Tauri, com os caminhos). */
function useOsDrop(album: number) {
  useEffect(() => {
    if (!isTauri()) return;
    // O registro é assíncrono: se a limpeza chegar antes (StrictMode monta duas
    // vezes), desregistra assim que a promessa resolver. Sem isso cada arquivo
    // solto seria enviado duas vezes.
    let off: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const unlisten = await getCurrentWebview().onDragDropEvent(({ payload: p }) => {
        if (p.type === "enter" || p.type === "over") useDrop.setState({ over: true });
        else if (p.type === "leave") useDrop.setState({ over: false });
        else if (p.type === "drop") {
          useDrop.setState({ over: false });
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
