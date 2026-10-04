/** Consultas (React Query sobre os comandos do core) e ações sobre mídias. */
import { QueryClient, useQuery } from "@tanstack/react-query";
import { available as onAndroid } from "@tgcloud/ui/core/android";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { refreshSoon, setRefresher } from "@tgcloud/ui/core/refresh";
import { transfers } from "@tgcloud/ui/core/transfers";
import { api, type Media, type View } from "./api";
import { emptyAll, purgeItems, restoreItems, trashItems } from "./deviceTrash";
import { findLocal } from "./library";
import { withLocal } from "./local";
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

  /** Baixa para o aparelho: Downloads no desktop, pasta escolhida no Android. */
  download(ids: number[], openList = () => nav.closeThen(() => nav.dest("transfers"))) {
    if (onAndroid) void transfers.downloadAndroid(ids, openList);
    else void transfers.download(ids, openList);
    clearSelection();
  },
};
