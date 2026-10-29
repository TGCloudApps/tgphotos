import { canUseVault } from "@tgcloud/ui/core/vaultPermissions";
/** Queries (React Query over the core commands) and actions on media. */
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
import { t, tc } from "../i18n";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

/** The index is local (SQLite): after any mutation, reload everything. */
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

/** Finds a media item already loaded in any query (layers only keep the id). */
export function findMedia(id: number): Media | undefined {
  for (const [key, data] of queryClient.getQueriesData<Media[]>({})) {
    if (key[0] === "albums" || !Array.isArray(data)) continue;
    const hit = data.find((m) => m?.id === id);
    if (hit) return hit;
  }
  return undefined;
}


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

/** From how many items a bulk action asks for confirmation. */
const MANY = 10;

/** Vault media not loaded in any list (only the id matters). */
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
    if (!canUseVault("write")) return;
    await run(api.setFavorite(ids, on));
  },

  async archive(ids: number[], on: boolean) {
    if (!canUseVault("write")) return;
    await run(api.setArchived(ids, on));
    clearSelection();
    notify({
      text: on ? t("core.archived", { n: ids.length }) : t("core.unarchived", { n: ids.length }),
      tone: "neutral",
      action: { label: t("core.undo"), run: () => void run(api.setArchived(ids, !on)) },
    });
  },

  // Unified trash: vault and device together (deviceTrash.ts). Ids < 0 are
  // device-only media (on the timeline or in the device trash).

  async trash(ids: number[]) {
    const items = ids.map((id) => (id < 0 ? findLocal(id) : (findMedia(id) ?? stub(id)))).filter((m): m is Media => !!m);
    // Bulk action gate: many items at once ask for confirmation.
    if (items.length >= MANY) {
      const ok = await confirmAction({
        title: t("core.trashTitle", { n: items.length }),
        body: t("core.trashBody"),
        cta: t("core.trashCta"),
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
    notify({ text: ids.length ? t("core.albumCreatedWith", { name, n: ids.length }) : t("core.albumCreated", { name }), tone: "success", action: { label: tc("common.open"), run: () => nav.album(id) } });
    return id;
  },

  async albumAdd(album: { id: number; name: string }, ids: number[]) {
    if (!canUseVault("write")) return;
    const n = await run(api.albumAdd(album.id, ids));
    clearSelection();
    notify({
      text: n ? t("core.albumAdded", { n, name: album.name }) : t("core.albumAlready", { name: album.name }),
      tone: "neutral",
      action: { label: tc("common.open"), run: () => nav.album(album.id) },
    });
  },

  async albumRemove(album: number, ids: number[]) {
    if (!canUseVault("write")) return;
    await run(api.albumRemove(album, ids));
    clearSelection();
    notify({
      text: t("core.albumRemoved", { n: ids.length }),
      tone: "neutral",
      action: { label: t("core.undo"), run: () => void run(api.albumAdd(album, ids)) },
    });
  },

  albumRename: (id: number, name: string) => run(api.albumRename(id, name)),

  async albumDelete(id: number) {
    if (!canUseVault("write")) return;
    await run(api.albumDelete(id));
    notify({ text: t("core.albumDeleted"), tone: "neutral" });
  },

  async albumCover(id: number, media: number) {
    if (!canUseVault("write")) return;
    await run(api.albumSetCover(id, media));
    notify({ text: t("core.albumCover"), tone: "success" });
  },

  /** Regenerates the thumbnail (the current one came out wrong, e.g. black). */
  async regenThumb(m: Media) {
    const key = notify({ text: t("core.thumbGenerating"), tone: "info", sticky: true });
    try {
      await regenerateThumb(m);
      notify({ text: t("core.thumbDone"), tone: "success" });
    } catch (e) {
      notifyError(e);
    } finally {
      dismiss(key);
    }
  },

  /** The photo becomes the vault photo (the one in the Telegram channel). */
  async vaultPhoto(m: Media) {
    const v = currentVault();
    if (!v) return;
    try {
      const blob = await (await fetch(srcOf(m), { cache: "no-store" })).blob();
      // Goes through the crop; canceling changes nothing.
      if (!(await setVaultPhoto(v.id, blob))) return;
      notify({ text: t("core.vaultPhoto"), tone: "success" });
    } catch (e) {
      notifyError(e);
    }
  },

  /** Downloads to the device: Downloads on desktop, chosen folder on Android. */
  download(ids: number[], openList = () => nav.closeThen(() => nav.dest("transfers"))) {
    if (onAndroid) void transfers.downloadAndroid(ids, openList);
    else void transfers.download(ids, openList);
    clearSelection();
  },
};
