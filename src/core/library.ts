/**
 * Local gallery on the timeline, like Google Photos: what is not yet in the
 * vault appears alongside what is, with or without network: the folders with
 * backup and those marked "Show in Photos" in the open vault (MediaStore on
 * Android; disk on desktop).
 */
import { create } from "zustand";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { refreshSoon } from "@tgcloud/ui/core/refresh";
import { app } from "@tgcloud/ui/core/app";
import { api, type Media, type Transfer } from "./api";
import { findTrashedLocal } from "./deviceStore";

/** Open device folder (registered by Device.tsx; avoids importing the screen here). */
let folderFinder: (id: number) => Media | undefined = () => undefined;
export const setFolderFinder = (fn: (id: number) => Media | undefined) => (folderFinder = fn);
const findFolderItem = (id: number) => folderFinder(id);
import { deviceToken, deviceUrl } from "./local";

export const useLibrary = create<{ items: Media[] }>(() => ({ items: [] }));

/** Device media (negative ids): on the timeline or in the device trash. */
export const findLocal = (id: number) => useLibrary.getState().items.find((m) => m.id === id) ?? findTrashedLocal(id) ?? findFolderItem(id);

let running: Promise<void> | null = null;

function item(id: number, uri: string, name: string, mime: string, size: number, takenMs: number, duration: number | null, pending: number, src?: string): Media {
  const taken = takenMs / 1000;
  return {
    id,
    name,
    mime,
    size,
    thumb: false,
    duration,
    width: null,
    height: null,
    taken_at: taken,
    tz: null,
    favorite: false,
    archived: false,
    trashed_at: null,
    added_at: taken,
    lat: null,
    lon: null,
    local: null,
    src,
    uri,
    pending,
  };
}

/** Stable (negative) id of a device media item: the MediaStore _ID or the path hash. */
export function localId(src: string): number {
  if (src.startsWith("content://")) {
    const mid = Number(src.split("?")[0].split("/").pop());
    if (Number.isFinite(mid)) return -mid;
  }
  return pathId(src);
}

/** Stable id for a path (desktop): hash of the text, negative. */
function pathId(path: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return -((h >>> 0) % 2_000_000_000) - 1;
}

async function loadAndroid(): Promise<Media[] | null> {
  if (!android.hasMedia()) return null;
  const access = android.mediaAccess();
  if (!access.full && !access.partial) return null;
  // Only what the user chose for this vault: folders with backup and folders
  // marked "Show in Photos" (nothing appears by default, not even the Camera).
  const [backup, shown] = await Promise.all([api.backupFolders().catch(() => [] as string[]), api.showFolders().catch(() => [] as string[])]);
  const folders = [...new Set([...backup, ...shown])];
  if (!folders.length) return [];
  const raw = android.mediaScan(folders);
  const status = raw.length ? await api.backupStatus(raw.map((m) => m.uri)) : [];
  const t = await deviceToken();
  const out: Media[] = [];
  raw.forEach((m, i) => {
    if (status[i] === 2) return; // already in the vault: appears through the vault media item
    // Stable id (the MediaStore _ID): reloading the list does not remount the grid.
    const mid = Number(m.uri.split("?")[0].split("/").pop());
    out.push(
      item(Number.isFinite(mid) ? -mid : -(i + 1), m.uri, m.name, m.mime, m.size, m.taken || m.modified * 1000, m.duration ? m.duration / 1000 : null, status[i] ?? 0, t ? deviceUrl(t, m.uri, m.mime, m.size) : undefined),
    );
  });
  return out;
}

/** Desktop: files from the backup folders still outside the vault. */
async function loadDesktop(): Promise<Media[]> {
  const list = await api.backupLocal();
  const t = await deviceToken();
  return list.map((m) => item(pathId(m.uri), m.uri, m.name, m.mime, m.size, m.taken, null, m.status, t ? deviceUrl(t, m.uri, m.mime, m.size) : undefined));
}

export function loadLibrary(): Promise<void> {
  running ??= (async () => {
    try {
      const items = onAndroid ? await loadAndroid() : await loadDesktop();
      if (items) useLibrary.setState({ items });
    } catch (e) {
      console.warn("[tgphotos] galeria local", e);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Trash: the vault one and the device one (only what has no copy in the vault), by the date they were moved there. */
export function mergeTrash(vault: Media[], local: Media[]): Media[] {
  if (!local.length) return vault;
  return [...vault, ...local].sort((a, b) => (b.trashed_at ?? 0) - (a.trashed_at ?? 0));
}

/** Merges vault and device, from newest to oldest. */
export function merge(vault: Media[], local: Media[]): Media[] {
  if (!local.length) return vault;
  return [...vault, ...local].sort((a, b) => b.taken_at - a.taken_at || b.id - a.id);
}

let started = false;
/** Reloads on open, when returning to the app, with new media and when the upload queue moves. */
export function startLibrary() {
  if (started) return;
  started = true;
  void loadLibrary();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void loadLibrary());
  window.addEventListener("tg-media-changed", () => void loadLibrary());
  // Downloaded before the app stored the link: recognize by name and size.
  if (onAndroid && android.hasMedia() && android.mediaAccess().full) {
    const items = android.mediaScan([app.downloads]);
    if (items.length)
      void api
        .localRelink(items)
        .then((n) => n > 0 && refreshSoon())
        .catch(() => {});
  }
  // Downloaded (DCIM/Restored, Downloads): the media item now has the file here.
  window.addEventListener("tg-download-done", (e) => {
    const { src, dest } = (e as CustomEvent<{ src: string; dest: string }>).detail;
    void api
      .localLink(src, dest)
      .then(() => refreshSoon())
      .catch(() => {});
  });
}

/**
 * Upload state per origin (path/URI without query): "active" while uploading,
 * for the "uploading" badge on the grid.
 */
let lastList: Transfer[] | null = null;
let lastMap = new Map<string, string>();
export function uploadStates(list: Transfer[]) {
  if (list !== lastList) {
    lastList = list;
    lastMap = new Map(list.filter((t) => t.kind === "up").map((t) => [t.src.split("?")[0], t.state]));
  }
  return lastMap;
}
