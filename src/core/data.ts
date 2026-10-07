/** Consultas (React Query sobre os comandos do core) e ações sobre mídias. */
import { QueryClient, useQuery } from "@tanstack/react-query";
import { available as onAndroid } from "@tgcloud/ui/core/android";
import { dismiss, notify, notifyError } from "@tgcloud/ui/core/notices";
import { regenerateThumb } from "@tgcloud/ui/core/thumbs";
import { refreshSoon, setRefresher } from "@tgcloud/ui/core/refresh";
import { transfers } from "@tgcloud/ui/core/transfers";
import { api, type Media, type View } from "./api";
import { emptyAll, purgeItems, restoreItems, trashItems } from "./deviceTrash";
import { findLocal } from "./library";
import { withLocal } from "./local";
import { confirmAction } from "@tgcloud/ui/ui/Confirm";
import { currentVault } from "@tgcloud/ui/core/vault";
import { setVaultPhoto } from "@tgcloud/ui/core/vaultPhoto";
import { srcOf } from "@tgcloud/ui/core/item";
import { nav } from "./nav";
import { useSelection } from "./select";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

/** O índice é local (SQLite): depois de qualquer mutação, recarrega tudo. */
export const refresh = () => queryClient.invalidateQueries();
setRefresher(refresh);
export { refreshSoon };

export const useList = (view: View) => useQuery({ queryKey: ["list", view], queryFn: () => api.list(view).then(withLocal) });
export const useAlbums = () => useQuery({ queryKey: ["albums"], queryFn: api.albums });
export const useAlbumMedia = (id: number) => useQuery({ queryKey: ["album", id], queryFn: () => api.albumMedia(id).then(withLocal), enabled: id > 0 });
export const useSearch = (text: string) =>
  useQuery({ queryKey: ["search", text], queryFn: () => api.search(text).then(withLocal), enabled: text.trim().length > 0 });
export const useUsage = () => useQuery({ queryKey: ["usage"], queryFn: api.usage });
export const useDetails = (id: number) => useQuery({ queryKey: ["details", id], queryFn: () => api.details(id) });

/** Acha uma mídia já carregada em qualquer consulta (camadas só guardam o id). */
export function findMedia(id: number): Media | undefined {
  for (const [key, data] of queryClient.getQueriesData<Media[]>({})) {
    if (key[0] === "albums" || !Array.isArray(data)) continue;
    const hit = data.find((m) => m?.id === id);
    if (hit) return hit;
  }
  return undefined;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

async function run<T>(p: Promise<T>) {
  try {
    const r = await p;
    await refresh();
    return r;
  } catch (e) {
    notifyError(e);
    throw e;
  }
}

const clearSelection = () => useSelection.getState().clear();

/** A partir de quantos itens uma ação em massa pede confirmação. */
const MANY = 10;

/** Mídia do vault que não está carregada em nenhuma lista (só o id importa). */
const stub = (id: number): Media => ({
  id,
  name: "",
  mime: "",
  size: 0,
  thumb: false,
  duration: null,
  width: null,
  height: null,
  taken_at: 0,
  tz: null,
  favorite: false,
  archived: false,
  trashed_at: null,
  added_at: 0,
  lat: null,
  lon: null,
  local: null,
});

export const actions = {
  async favorite(ids: number[], on: boolean) {
    await run(api.setFavorite(ids, on));
  },

  async archive(ids: number[], on: boolean) {
    await run(api.setArchived(ids, on));
    clearSelection();
    notify({
      text: on ? `${plural(ids.length, "Item arquivado", "itens arquivados")}` : `${plural(ids.length, "Item voltou", "itens voltaram")} para Fotos`,
      tone: "neutral",
      action: { label: "Desfazer", run: () => void run(api.setArchived(ids, !on)) },
    });
  },

  // Lixeira unificada: vault e aparelho juntos (deviceTrash.ts). Ids < 0 são
  // mídias só do aparelho (na linha do tempo ou na lixeira do aparelho).

  async trash(ids: number[]) {
    const items = ids.map((id) => (id < 0 ? findLocal(id) : (findMedia(id) ?? stub(id)))).filter((m): m is Media => !!m);
    // Gate de ações em massa: muitos itens de uma vez pedem confirmação.
    if (items.length >= MANY) {
      const ok = await confirmAction({
        title: `Mover ${items.length.toLocaleString("pt-BR")} itens para a lixeira?`,
        body: `Saem do vault e, os que estão no aparelho, do aparelho também. Ficam 30 dias na lixeira antes de sumir de vez.`,
        cta: "Mover para a lixeira",
        danger: true,
      });
      if (!ok) return;
    }
    if (await trashItems(items)) clearSelection();
  },

  async restore(ids: number[]) {
    if (await restoreItems(ids)) clearSelection();
  },

  async purge(ids: number[]) {
    if (await purgeItems(ids)) clearSelection();
  },

  emptyTrash: () => emptyAll(),

  async albumCreate(name: string, ids: number[]) {
    const id = await run(api.albumCreate(name, ids));
    clearSelection();
    notify({ text: ids.length ? `Álbum “${name}” criado com ${plural(ids.length, "1 item", "itens")}` : `Álbum “${name}” criado`, tone: "success", action: { label: "Abrir", run: () => nav.album(id) } });
    return id;
  },

  async albumAdd(album: { id: number; name: string }, ids: number[]) {
    const n = await run(api.albumAdd(album.id, ids));
    clearSelection();
    notify({
      text: n ? `${plural(n, "1 item adicionado", "itens adicionados")} a “${album.name}”` : `Já estava em “${album.name}”`,
      tone: "neutral",
      action: { label: "Abrir", run: () => nav.album(album.id) },
    });
  },

  async albumRemove(album: number, ids: number[]) {
    await run(api.albumRemove(album, ids));
    clearSelection();
    notify({
      text: `${plural(ids.length, "Item removido", "itens removidos")} do álbum`,
      tone: "neutral",
      action: { label: "Desfazer", run: () => void run(api.albumAdd(album, ids)) },
    });
  },

  albumRename: (id: number, name: string) => run(api.albumRename(id, name)),

  async albumDelete(id: number) {
    await run(api.albumDelete(id));
    notify({ text: "Álbum apagado. As fotos continuam na biblioteca.", tone: "neutral" });
  },

  async albumCover(id: number, media: number) {
    await run(api.albumSetCover(id, media));
    notify({ text: "Capa do álbum alterada", tone: "success" });
  },

  /** Gera a miniatura de novo (a de agora saiu errada, ex.: preta). */
  async regenThumb(m: Media) {
    const key = notify({ text: "Gerando a miniatura…", tone: "info", sticky: true });
    try {
      await regenerateThumb(m);
      notify({ text: "Miniatura gerada de novo", tone: "success" });
    } catch (e) {
      notifyError(e);
    } finally {
      dismiss(key);
    }
  },

  /** A foto vira a foto do vault (a do canal no Telegram). */
  async vaultPhoto(m: Media) {
    const v = currentVault();
    if (!v) return;
    try {
      const blob = await (await fetch(srcOf(m), { cache: "no-store" })).blob();
      // Passa pelo recorte; cancelar não muda nada.
      if (!(await setVaultPhoto(v.id, blob))) return;
      notify({ text: "Foto do vault alterada", tone: "success" });
    } catch (e) {
      notifyError(e);
    }
  },

  /** Baixa para o aparelho: Downloads no desktop, pasta escolhida no Android. */
  download(ids: number[], openList = () => nav.closeThen(() => nav.dest("transfers"))) {
    if (onAndroid) void transfers.downloadAndroid(ids, openList);
    else void transfers.download(ids, openList);
    clearSelection();
  },
};
