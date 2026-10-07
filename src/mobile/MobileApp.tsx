/**
 * Casca do celular: app bar, barra inferior (Fotos · Coleções · Busca),
 * linha do tempo em grade quadrada, toque longo para selecionar e folhas.
 */
import { PeopleScreen, PersonScreen } from "../shared/People";
import { startIntel } from "../core/intel";
import { Sheet } from "@tgcloud/ui/ui/Sheet";
import { IntelSettingsBody } from "../shared/IntelSettings";
import { SearchResults } from "../shared/Search";
import { ExternalPick } from "../shared/ExternalPick";
import { Presence } from "@tgcloud/ui/ui/Presence";
import { getPort } from "@tgcloud/ui/core/server";
import { deviceToken } from "../core/local";
import { PresenceList } from "@tgcloud/ui/ui/Presence";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Clapperboard, CloudUpload, FolderInput, Heart, Images, ImagePlus, Library, MoreVertical, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { uploads, useUploads } from "@tgcloud/ui/core/uploads";
import { TransfersView } from "@tgcloud/ui/ui/Transfers";
import { EmptyState, ErrorState } from "@tgcloud/ui/ui/States";
import { Snackbar } from "@tgcloud/ui/mobile/Snackbar";
import { TransferChip } from "@tgcloud/ui/mobile/TransferChip";
import type { Session } from "@tgcloud/ui/ui/Boot";
import { api, type Media } from "../core/api";
import { actions, refreshSoon, useAlbumMedia, useAlbums, useList } from "../core/data";
import { nav, useLayers, useNav, useRoute, type Dest } from "../core/nav";
import { useSelection } from "../core/select";
import { Collections, albumPeriod } from "../shared/Collections";
import { backupLocal, Viewer } from "../shared/Viewer";
import { findLocal, loadLibrary, merge, mergeTrash, startLibrary, useLibrary } from "../core/library";
import { useDevice } from "../core/deviceStore";
import { startDevice } from "../core/deviceTrash";
import { UpdateBanner } from "@tgcloud/ui/ui/Update";
import { Avatar } from "@tgcloud/ui/ui/Avatar";
import { OutOfSyncBanner } from "../shared/DeviceSync";
import { OfflineBadge } from "@tgcloud/ui/ui/Offline";
import { SendToVault } from "@tgcloud/ui/ui/SendToVault";
import { useLiveTransfers, useTransfers } from "@tgcloud/ui/core/transfers";
import { Timeline } from "../timeline/Timeline";
import { AccountSheet, ActionsSheet, AddSheet, AlbumMenuSheet, DeviceMoveSheet, DeviceRenameSheet, AlbumPickSheet, BackupSheet, ConfirmSheet, FreeSpaceSheet, ImportSheet, NameSheet, OutOfSyncSheet, ReceiveSheet } from "./Sheets";
import { DeviceFolderBar, DeviceFolderScreen, DeviceViewer } from "./Device";
import { ChatList, ChatScreen, useChatTitle } from "../shared/Chats";
import { ScrollPane, scrollToTop } from "../shared/Scroll";
import { Liked, Shorts } from "../shared/Shorts";
import { useCurrentVault } from "@tgcloud/ui/core/vault";
import { FetchDialog } from "../shared/FetchDialog";
import { backupConfigured, markConfigured, startBackup, useBackup } from "../core/backup";

export default function MobileApp({ session }: { session: Session }) {
  const route = useRoute();
  const layers = useLayers();
  const fileInput = useRef<HTMLInputElement>(null);
  const selecting = layers.some((l) => l.type === "selection");
  // Sinais para a análise em segundo plano (energia, uso da tela).
  useEffect(() => startIntel(), []);
  // Outro app pediu fotos ("Escolher foto" → TGPhotos): ao abrir ou já aberto.
  const [pick, setPick] = useState(() => (onAndroid ? android.takePick() : null));
  useEffect(() => {
    if (!onAndroid) return;
    const take = () => setPick(android.takePick());
    window.addEventListener("tg-pick", take);
    return () => window.removeEventListener("tg-pick", take);
  }, []);
  // O vault aberto como origem no seletor de arquivos do sistema.
  useEffect(() => {
    if (!onAndroid) return;
    void deviceToken().then((t) => android.docsReady(getPort(), t, session.vault.id, session.vault.name));
  }, [session.vault.id, session.vault.name]);

  // A seleção do celular vive enquanto a camada "selection" estiver na pilha.
  useEffect(() => {
    if (!selecting) useSelection.getState().clear();
  }, [selecting]);

  // Sair do modo seleção ao desmarcar tudo.
  const count = useSelection((s) => s.ids.size);
  useEffect(() => {
    if (selecting && count === 0 && nav.top("selection")) nav.close();
  }, [selecting, count]);

  useEffect(() => {
    useUploads.setState({ onDone: refreshSoon });
    // Lixeira com mais de 30 dias sai de vez.
    api.housekeep().then((n) => n && refreshSoon()).catch(() => {});
    startBackup();
    startLibrary();
    startDevice();
  }, []);

  // A fila de envios andou (algo subiu): a galeria do aparelho tira o que já está no vault.
  const transfersList = useTransfers((s) => s.list);
  useEffect(() => {
    const t = setTimeout(() => void loadLibrary(), 1500);
    return () => clearTimeout(t);
  }, [transfersList]);

  // "Compartilhar → TGPhotos" de outro app (na abertura ou com o app aberto).
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
      <AppBar />
      <Screen />
      {!selecting && <BottomBar />}
      <Snackbar />
      <Layers fileInput={fileInput} album={album} session={session} />
      <Presence>{pick && <ExternalPick req={pick} touch onClose={() => setPick(null)} />}</Presence>
    </div>
  );
}

// ---- App bar ---------------------------------------------------------------------

const titles: Partial<Record<Dest, string>> = {
  photos: "Fotos",
  collections: "Coleções",
  people: "Pessoas",
  person: "Pessoa",
  liked: "Curtidas",
  favorites: "Favoritos",
  videos: "Vídeos",
  archive: "Arquivo",
  trash: "Lixeira",
  transfers: "Transferências",
  chats: "Importar de chats",
};

function AppBar() {
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

  // Curtas: tela cheia, sem barra.
  if ((route.dest === "shorts" || route.dest === "liked") && !layers.some((l) => l.type === "selection")) return null;

  if (layers.some((l) => l.type === "selection")) {
    const all = [...selected];
    // Na seleção podem vir mídias do aparelho (fora do vault, ids < 0): backup,
    // pasta e lixeira valem para elas; o resto só para as do vault.
    const ids = all.filter((id) => id > 0);
    const local = all.filter((id) => id < 0);
    const inTrash = route.dest === "trash";
    // Ação que consome a seleção: fecha a camada e então roda.
    const then = (fn: () => unknown) => nav.closeThen(() => void fn(), 0);
    return bar(
      <>
        {icon("Cancelar seleção", <X size={22} />, nav.close)}
        <p className="flex-1 text-[18px] font-semibold tabular">{all.length}</p>
        {inTrash ? (
          <>
            {icon("Restaurar", <RotateCcw size={22} />, () => then(() => actions.restore(all)))}
            {icon("Apagar para sempre", <Trash2 size={22} />, () => nav.open({ type: "confirm", action: "purge", ids: all }))}
          </>
        ) : (
          <>
            {local.length > 0 &&
              icon("Fazer backup", <CloudUpload size={22} />, () => then(() => backupLocal(local.map(findLocal).filter((m): m is Media => !!m))))}
            {/* Só do aparelho: gerenciar como uma galeria. */}
            {local.length > 0 &&
              ids.length === 0 &&
              android.canManage() &&
              icon("Mover para pasta", <FolderInput size={22} />, () =>
                nav.replaceTop({ type: "device-move", uris: local.map(findLocal).flatMap((m) => (m?.uri ? [m.uri] : [])) }),
              )}
            {ids.length > 0 && (
              <>
                {icon("Adicionar a um álbum", <ImagePlus size={22} />, () => nav.open({ type: "album-pick", ids }))}
                {icon("Favoritar", <Heart size={22} />, () => then(() => actions.favorite(ids, true)))}
              </>
            )}
            {/* Lixeira unificada: vault e aparelho juntos. */}
            {icon("Mover para a lixeira", <Trash2 size={22} />, () => then(() => actions.trash(all)))}
            {ids.length > 0 && icon("Mais", <MoreVertical size={22} />, () => nav.open({ type: "actions", ids }))}
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
        {icon("Voltar", <ArrowLeft size={22} />, nav.back)}
        <DeviceFolderBar path={route.device ?? ""} />
      </>,
    );

  if (route.dest === "album") {
    const a = albums.find((x) => x.id === route.album);
    return bar(
      <>
        {icon("Voltar", <ArrowLeft size={22} />, nav.back)}
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-[18px] leading-6 font-semibold">{a?.name ?? "Álbum"}</p>
          <p className="truncate text-[12px] text-fg-3 tabular">
            {a ? `${a.count} ${a.count === 1 ? "item" : "itens"}${albumPeriod(a) ? ` · ${albumPeriod(a)}` : ""}` : ""}
          </p>
        </div>
        {icon("Buscar neste álbum", <Search size={22} />, () => nav.searchIn(route.album))}
        {icon("Adicionar fotos", <Plus size={22} />, () => nav.open({ type: "add" }))}
        {icon("Mais opções", <MoreVertical size={22} />, () => nav.open({ type: "album-menu", id: route.album }))}
      </>,
    );
  }

  const root = route.dest === "photos" || route.dest === "collections";
  return bar(
    <>
      {!root && icon("Voltar", <ArrowLeft size={22} />, nav.back)}
      <h1 className={`flex-1 truncate font-heading font-bold tracking-tight text-fg-title ${root ? "pl-4 text-[22px]" : "pl-1 text-[20px]"}`}>{route.dest === "chat" ? chatTitle : titles[route.dest]}</h1>
      <OfflineBadge touch />
      <TransferChip onOpen={() => nav.dest("transfers")} />
      {route.dest === "trash"
        ? icon("Esvaziar lixeira", <Trash2 size={20} />, () => nav.open({ type: "confirm", action: "empty", ids: [] }))
        : route.dest === "photos" && icon("Enviar", <Plus size={24} />, () => nav.open({ type: "add" }))}
      {root && <AccountButton />}
    </>,
  );
}

/** Avatar: conta, vault e transferências; com algo em andamento, um selo. */
function AccountButton() {
  const live = useLiveTransfers();
  return (
    <button onClick={() => nav.open({ type: "account" })} aria-label={live ? `Conta e vault · ${live} transferências em andamento` : "Conta e vault"} className="relative grid size-12 shrink-0 place-items-center rounded-full text-fg active:bg-s3">
      <Avatar size={32} />
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
        placeholder="Buscar por nome, câmera, álbum…"
        enterKeyHint="search"
        className="surface h-11 w-full rounded-xl border border-line bg-s3 pr-11 pl-10 text-[16px] text-fg outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25"
      />
      {text && (
        <button onClick={() => setText("")} className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-fg-2 active:bg-s4" aria-label="Limpar busca">
          <X size={18} />
        </button>
      )}
    </div>
  );
}

// ---- Barra inferior -----------------------------------------------------------------

const destinations: { dest: Dest; label: string; icon: typeof Images }[] = [
  { dest: "photos", label: "Fotos", icon: Images },
  { dest: "shorts", label: "Curtas", icon: Clapperboard },
  { dest: "collections", label: "Coleções", icon: Library },
  { dest: "search", label: "Busca", icon: Search },
];

/** Destinos que pertencem à aba Coleções (a aba fica acesa dentro deles). */
const inCollections: Dest[] = ["people", "person", "collections", "favorites", "videos", "archive", "trash", "transfers", "album", "device", "chats", "chat"];

function BottomBar() {
  const route = useRoute();
  const current = inCollections.includes(route.dest) ? "collections" : route.dest === "liked" ? "shorts" : route.dest;
  return (
    <nav className="glint-top z-20 flex shrink-0 bg-s1 pb-[var(--inset-bottom)]" style={{ height: "calc(var(--bottombar-height) + var(--inset-bottom))" }}>
      {destinations.map(({ dest, label, icon: Icon }) => {
        const on = current === dest;
        return (
          <button
            key={dest}
            // Tocar de novo no destino em que já está: volta ao topo.
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

// ---- Telas ----------------------------------------------------------------------------

/** Curtas em tela cheia (sem barra de cima): o conteúdo começa abaixo da barra de status. */
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
  const key = `${route.dest}:${route.album}:${route.device ?? ""}:${route.person ?? ""}`;
  const transition = usePageTransition(key, route.dest, direction);
  return (
    // A tela que sai fica por baixo um instante, sumindo (ver ui/Presence.tsx).
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
          {route.dest === "archive" && <ListScreen view="archive" />}
          {route.dest === "trash" && <ListScreen view="trash" />}
          {route.dest === "album" && <AlbumScreen id={route.album} />}
          {route.dest === "search" && <SearchScreen text={route.query} album={route.album} />}
          {route.dest === "people" && <PeopleScreen touch />}
          {route.dest === "person" && <PersonScreen key={route.person} uid={route.person ?? ""} touch />}
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
 * Animação da página, decidida só quando a página muda (abrir folha empilha
 * histórico mas não troca a página): trocar de aba = fade through; entrar
 * e sair de álbum/coleção = slide no eixo.
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
  timeline: { icon: Images, title: "Nenhuma foto ainda", text: "Toque em + para enviar fotos e vídeos do aparelho." },
  favorites: { icon: Heart, title: "Nenhum favorito", text: "Toque no coração de uma foto para ela aparecer aqui." },
  videos: { icon: Images, title: "Nenhum vídeo", text: "Os vídeos que você enviar aparecem aqui." },
  archive: { icon: Images, title: "Arquivo vazio", text: "Arquive fotos para tirá-las da linha do tempo sem apagar." },
  trash: { icon: Trash2, title: "Lixeira vazia", text: "O que você excluir fica aqui por 30 dias." },
} as const;

function Grid({ q, empty, top, topHeight }: { q: { data?: Media[]; error: unknown; refetch: () => void; isLoading: boolean }; empty: ReactNode; top?: ReactNode; topHeight?: number }) {
  if (q.error) return <ErrorState touch error={q.error} retry={q.refetch} />;
  if (q.isLoading) return <div className="flex-1" />;
  if (!q.data?.length) return <>{empty}</>;
  return <Timeline items={q.data} touch top={top} topHeight={topHeight} bottom={96} />;
}

function ListScreen({ view }: { view: keyof typeof empties }) {
  const vault = useList(view);
  // Fotos: a galeria do aparelho (fora do vault) entra junto.
  const local = useLibrary((s) => s.items);
  // Lixeira: a do aparelho entra junto (o que não tem cópia no vault).
  const trashed = useDevice((s) => s.localOnly);
  const data = useMemo(
    () => (!vault.data ? vault.data : view === "timeline" ? merge(vault.data, local) : view === "trash" ? mergeTrash(vault.data, trashed) : vault.data),
    [view, vault.data, local, trashed],
  );
  const q = { ...vault, data };
  const e = empties[view];
  const invite = useInvite(view === "timeline");
  const unsynced = useDevice((s) => s.out.vaultOnly.length + s.out.deviceOnly.length) > 0;
  const banner =
    view === "trash" ? (
      <div className="mx-3 mt-1 mb-2 space-y-2">
        <OutOfSyncBanner touch />
        <p className="surface rounded-lg bg-s1 px-3 py-2.5 text-[13px] text-fg-2">Itens na lixeira, aqui e no aparelho, são apagados de vez depois de 30 dias.</p>
      </div>
    ) : invite ? (
      <BackupInvite onClose={invite.dismiss} />
    ) : undefined;
  const topHeight = !banner ? 0 : invite ? 92 : view === "trash" && unsynced ? 128 : 56;
  return (
    <>
      {/* Linha do tempo: avisos que pedem ação ficam fixos no topo. */}
      {view === "timeline" && (
        <div className="mx-3 mb-2 space-y-2 empty:hidden">
          <OutOfSyncBanner touch />
          <UpdateBanner touch />
        </div>
      )}
      {!q.data?.length && banner}
      <Grid q={q} top={banner} topHeight={topHeight} empty={<EmptyState touch icon={e.icon} title={e.title} text={e.text} />} />
    </>
  );
}

/** Convite para ligar o backup, até o usuário passar pela tela de backup ou dispensar. */
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
      <button onClick={() => nav.open({ type: "backup" })} className="min-w-0 flex-1 text-left">
        <p className="text-[14px] font-semibold">Ligar o backup automático</p>
        <p className="text-[12px] text-fg-2">Fotos novas da câmera sobem sozinhas.</p>
      </button>
      <button onClick={onClose} className="grid size-10 shrink-0 place-items-center rounded-full text-fg-3 active:bg-s3" aria-label="Dispensar">
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
          title="Álbum vazio"
          text="Adicione fotos da linha do tempo (toque longo → álbum) ou envie do aparelho."
          action={
            <button onClick={() => nav.open({ type: "add" })} className="step mt-2 flex h-11 items-center gap-2 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white">
              <Plus size={18} /> Adicionar fotos
            </button>
          }
        />
      }
    />
  );
}

function SearchScreen({ text, album }: { text: string; album: number }) {
  return <SearchResults text={text} album={album} touch bottom={96} />;
}

// ---- Camadas ---------------------------------------------------------------------------

function Layers({ fileInput, album, session }: { fileInput: React.RefObject<HTMLInputElement | null>; album: number; session: Session }) {
  const layers = useLayers();
  // Cada camada sai com animação (folha desce, diálogo some) antes de desmontar.
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
          case "intel":
            return (
              <Sheet key={key} title={<p className="text-[16px] font-semibold">Inteligência</p>}>
                <IntelSettingsBody touch />
              </Sheet>
            );
          case "import":
            return <ImportSheet key={key} />;
          case "device-move":
            return <DeviceMoveSheet key={key} uris={l.uris} />;
          case "device-rename":
            return <DeviceRenameSheet key={key} uri={l.uri} name={l.name} />;
          case "send-vault":
            return <SendToVault key={key} ids={l.ids} touch onClose={nav.close} />;
          case "album-menu":
            return <AlbumMenuSheet key={key} id={l.id} />;
          case "out-of-sync":
            return <OutOfSyncSheet key={key} />;
          case "fetch":
            return <FetchDialog key={key} id={l.id} how={l.how} />;
          case "free-space":
            return <FreeSpaceSheet key={key} />;
          default:
            // "details" vive dentro do visualizador; "selection" é só estado.
            return null;
        }
      });
  return <PresenceList items={nodes.filter((n): n is React.ReactElement => !!n).map((n) => ({ key: String(n.key), node: n, instant: /viewer$/.test(String(n.key)) }))} />;
}
