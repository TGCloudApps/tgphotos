/**
 * Unified trash, like Google Photos: moving to the trash removes the photo from the
 * vault and the device together; restoring brings it back to both (on the device, to
 * the same folder); deleting permanently removes it from both.
 *
 * On the device:
 * - Android 11+: system trash (the file stays hidden in the folder, with the same
 *   address, and the system deletes it on its own after 30 days). With "Media
 *   management" (Android 12+) there is no confirmation each time.
 * - Android < 11: no system trash; the app keeps a copy in its own folder
 *   and restores it on restore (becomes a new MediaStore item).
 * - Desktop: operating system trash.
 *
 * Rust stores what went to the device trash and the link with the vault
 * (`device_trash`); here live the system part and the accounting of what is
 * "out of sync" (vault trash and device trash disagreeing — done on
 * another device, or by another app) and of what can "free space".
 */
import { android, available as onAndroid, type MediaState, type TrashRef } from "@tgcloud/ui/core/android";
import { formatSize } from "@tgcloud/ui/core/format";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { refreshSoon } from "@tgcloud/ui/core/refresh";
import { api, type DeviceLink, type DeviceTrash, type DeviceTrashIn, type Media } from "./api";
import { useDevice, type OutOfSync } from "./deviceStore";
import { loadLibrary, localId } from "./library";
import { deviceToken } from "./local";
import { keepThumb, localThumbUrl } from "../shared/LocalThumb";
import { t } from "../i18n";

const DAY = 86_400_000;
/** Same as the vault trash and the system trash. */
const KEEP_DAYS = 30;

const key = (src: string) => src.split("?")[0];

/** Device file (local only, or the original of a vault media item). */
type LocalFile = { src: string; name: string; mime: string; size: number; taken: number };

const fileOf = (m: Media): LocalFile | null => {
  const src = m.uri ?? m.local;
  return src ? { src, name: m.name, mime: m.mime, size: m.size, taken: Math.round(m.taken_at * 1000) } : null;
};

const ref = (r: Pick<DeviceTrash, "src" | "stash" | "folder" | "name" | "mime" | "taken">): TrashRef => ({
  uri: r.src,
  stash: r.stash,
  folder: r.folder,
  name: r.name,
  mime: r.mime,
  taken: r.taken,
});

// ---- what the system does --------------------------------------------------------------

/** Android without full access to media: the file states are not reliable. */
const blind = () => onAndroid && !android.mediaAccess().full;

/** 0 = gone, 1 = on the device, 2 = in the trash (Android; on desktop, 0/1). */
async function states(refs: TrashRef[]): Promise<MediaState[]> {
  if (!refs.length) return [];
  if (onAndroid) return android.mediaStates(refs);
  return (await api.localStates(refs.map((r) => r.uri))) as MediaState[];
}

/** To the device trash; `null` = the person refused (nothing changed). */
async function sysTrash(files: LocalFile[]): Promise<DeviceTrashIn[] | null> {
  if (!files.length) return [];
  if (!onAndroid) {
    await api.localTrash(files.map((f) => f.src));
    return files.map((f) => ({ ...f, src: key(f.src) }));
  }
  // In batches: the request to the system carries all addresses (see DELETE_CHUNK).
  const items: NonNullable<Awaited<ReturnType<typeof android.deviceTrash>>["items"]> = [];
  let error: string | undefined;
  for (let i = 0; i < files.length; i += DELETE_CHUNK) {
    const r = await android.deviceTrash(files.slice(i, i + DELETE_CHUNK).map((f) => f.src));
    items.push(...(r.items ?? []));
    if (r.error) error = r.error;
    if (!r.ok && !r.items?.length) {
      // Refused (or failed): stop here; what is done stays.
      if (!items.length) {
        if (r.error) notify({ text: r.error, tone: "danger" });
        return null;
      }
      break;
    }
  }
  if (error) notify({ text: t("trash.someNotTrashed", { error }), tone: "danger" });
  const done = new Map(items.map((i) => [key(i.uri), i]));
  return files.flatMap((f) => {
    const i = done.get(key(f.src));
    return i ? [{ ...f, src: key(f.src), stash: i.stash ?? null, folder: i.folder ?? "" }] : [];
  });
}

/**
 * Leaves the device trash. `back`: came back (or are no longer there and leave the
 * record); `moved`: came back with another address. `null` = refused.
 */
async function sysRestore(rows: TrashRef[]): Promise<{ back: string[]; moved: [string, string][] } | null> {
  if (!rows.length) return { back: [], moved: [] };
  if (!onAndroid) {
    await api.localRestore(rows.map((r) => r.uri));
    const st = await states(rows);
    const lost = rows.filter((_, i) => st[i] !== 1).length;
    if (lost) notify({ text: t("trash.lost", { n: lost }), tone: "danger" });
    return { back: rows.map((r) => key(r.uri)), moved: [] };
  }
  const items: NonNullable<Awaited<ReturnType<typeof android.deviceRestore>>["items"]> = [];
  let error: string | undefined;
  for (let i = 0; i < rows.length; i += DELETE_CHUNK) {
    const r = await android.deviceRestore(rows.slice(i, i + DELETE_CHUNK));
    items.push(...(r.items ?? []));
    if (r.error) error = r.error;
    if (!r.ok && !r.items?.length) {
      if (!items.length) {
        if (r.error) notify({ text: r.error, tone: "danger" });
        return null;
      }
      break;
    }
  }
  if (error) notify({ text: t("trash.someNotRestored", { error }), tone: "danger" });
  const back: string[] = [];
  const moved: [string, string][] = [];
  for (const i of items) {
    if (i.new) moved.push([key(i.uri), key(i.new)]);
    else back.push(key(i.uri));
  }
  return { back, moved };
}

/**
 * Items per deletion request to the system. The request (and the Android
 * confirmation dialog) carries the whole list of addresses; with thousands it
 * overflows the data limit the system accepts (crash) or the confirmation screen
 * keeps loading forever. In batches, each one confirms and proceeds on its own.
 */
const DELETE_CHUNK = 500;

/**
 * Deletes permanently from the device (`free`: originals outside the trash), in batches.
 * `each` runs after each deleted batch (record what is gone, show
 * progress). Stops at the first refused or failed batch. Returns how many
 * were deleted and whether everything was.
 */
async function sysDeleteParts(refs: TrashRef[], free: boolean, each?: (part: TrashRef[], done: number) => Promise<void> | void): Promise<{ done: number; ok: boolean }> {
  let done = 0;
  for (let i = 0; i < refs.length; i += DELETE_CHUNK) {
    const part = refs.slice(i, i + DELETE_CHUNK);
    if (!onAndroid) {
      const paths = part.map((r) => r.uri);
      await (free ? api.localFree(paths) : api.localPurge(paths));
    } else {
      const r = await android.deviceDelete(part);
      if (!r.ok) {
        if (r.error) notify({ text: r.error, tone: "danger" });
        return { done, ok: false };
      }
    }
    done += part.length;
    await each?.(part, done);
  }
  return { done, ok: true };
}

/** Deletes permanently from the device (`free`: originals outside the trash). `false` = refused (or stopped halfway). */
async function sysDelete(refs: TrashRef[], free = false): Promise<boolean> {
  return (await sysDeleteParts(refs, free)).ok;
}

/** After changing things: local gallery, device trash and vault lists. */
function after() {
  void loadLibrary();
  void loadDevice();
  refreshSoon();
  window.dispatchEvent(new Event("tg-local-changed"));
}

/** Once: suggests "Media management" to avoid confirming every time. */
function suggestManage() {
  if (!onAndroid) return;
  const m = android.manageMedia();
  if (!m.supported || m.granted) return;
  try {
    if (localStorage.getItem("manage-media-asked")) return;
    localStorage.setItem("manage-media-asked", "1");
  } catch {
    return;
  }
  notify({
    text: t("trash.manageHint"),
    tone: "info",
    action: { label: t("trash.allow"), run: () => void android.requestManageMedia() },
  });
}

// ---- state (Trash, out of sync, free space) ---------------------------------------------

function itemOf(r: DeviceTrash, token: string): Media {
  const cover = token ? localThumbUrl(token, r.src) : undefined;
  return {
    id: localId(r.src),
    name: r.name,
    mime: r.mime,
    size: r.size,
    thumb: false,
    duration: null,
    width: null,
    height: null,
    taken_at: r.taken / 1000,
    tz: null,
    favorite: false,
    archived: false,
    trashed_at: r.trashed_at / 1000,
    added_at: r.taken / 1000,
    lat: null,
    lon: null,
    local: null,
    src: cover,
    cover,
    device: true,
  };
}

let loading: Promise<void> | null = null;
let queued: Promise<void> | null = null;

/**
 * Re-reads the device trash and checks with the system: what disappeared (expired,
 * deleted by another app) or came back outside leaves the record; stored copies
 * (Android < 11) and items in the desktop trash expire after 30 days. Requested
 * during a read, it does another one afterwards (the current one may already be stale).
 */
export function loadDevice(): Promise<void> {
  if (loading) {
    queued ??= loading.then(() => {
      queued = null;
      return loadDevice();
    });
    return queued;
  }
  loading = (async () => {
    try {
      let [rows, links] = await Promise.all([api.deviceTrashList(), api.deviceLinks()]);
      const unsure = blind();
      if (onAndroid && !unsure) {
        const st = await states(rows.map(ref));
        const gone = rows.filter((_, i) => st[i] !== 2).map((r) => r.src);
        if (gone.length) {
          await api.deviceTrashRemove(gone);
          rows = rows.filter((_, i) => st[i] === 2);
        }
      }
      const old = rows.filter((r) => (r.stash || !onAndroid) && Date.now() - r.trashed_at > KEEP_DAYS * DAY);
      if (old.length && (await sysDelete(old.map(ref)))) {
        await api.deviceTrashRemove(old.map((r) => r.src));
        rows = rows.filter((r) => !old.includes(r));
      }

      const token = await deviceToken();
      const localOnly = rows.filter((r) => r.media_id == null).map((r) => itemOf(r, token));
      const out: OutOfSync = { vaultOnly: [], deviceOnly: [] };
      let freeable: DeviceLink[] = [];
      if (!unsure) {
        const st = await states(links.map((l) => ({ uri: l.src })));
        out.vaultOnly = links.filter((l, i) => l.trashed && st[i] === 1);
        out.deviceOnly = [
          ...rows
            .filter((r) => r.media_id != null && !r.media_trashed)
            .map((r) => ({ media_id: r.media_id!, src: r.src, name: r.name, mime: r.mime, size: r.size, row: r })),
          ...links.filter((l, i) => !l.trashed && st[i] === 2).map((l) => ({ media_id: l.media_id, src: l.src, name: l.name, mime: l.mime, size: l.size, row: null })),
        ];
        freeable = links.filter((l, i) => !l.trashed && st[i] === 1);
      }
      useDevice.setState({ rows, localOnly, out, freeable, loaded: true });
    } catch (e) {
      console.warn("[tgphotos] lixeira do aparelho", e);
    }
  })().finally(() => (loading = null));
  return loading;
}

let started = false;
/** Checks on open, when returning to the app and when MediaStore changes. */
export function startDevice() {
  if (started) return;
  started = true;
  void loadDevice();
  let timer: number | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void loadDevice(), 800);
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && soon());
  window.addEventListener("tg-media-changed", soon);
}

/** Device trash rows that match the grid ids (vault > 0, device only < 0). */
function rowsFor(ids: number[]): DeviceTrash[] {
  const vault = new Set(ids.filter((i) => i > 0));
  const local = new Set(ids.filter((i) => i < 0));
  return useDevice.getState().rows.filter((r) => (r.media_id != null && vault.has(r.media_id)) || local.has(localId(r.src)));
}

// ---- actions ----------------------------------------------------------------------------

/**
 * Move to the trash (vault and device). Vault media bring the original from this
 * device along; device-only items go to the device trash.
 * `false` if the person refused the system confirmation (nothing changes).
 */
export async function trashItems(items: Media[]): Promise<boolean> {
  if (!items.length) return false;
  try {
    let files = items.map(fileOf).filter((f): f is LocalFile => !!f);
    // Only what is still on the device (original deleted outside: only the vault).
    if (files.length && !blind()) {
      const st = await states(files.map((f) => ({ uri: f.src })));
      files = files.filter((_, i) => st[i] === 1);
    }
    let linked: number[] = [];
    if (files.length) {
      // Device only: the thumbnail is kept so the Trash can show it.
      await Promise.all(items.filter((m) => m.id < 0 && m.uri).map((m) => keepThumb(m.uri!, m.mime)));
      const done = await sysTrash(files);
      if (!done) return false;
      if (done.length) linked = await api.deviceTrashAdd(done);
    }
    const ids = [...new Set([...items.filter((m) => m.id > 0).map((m) => m.id), ...linked])];
    if (ids.length) await api.trash(ids);
    after();
    // Undo: the vault media (including those linked to files) and the device-only items.
    const all = [...ids, ...items.filter((m) => m.id < 0).map((m) => m.id)];
    notify({
      text: t("trash.moved", { n: items.length }),
      tone: "neutral",
      action: { label: t("core.undo"), run: () => void loadDevice().then(() => restoreItems(all)) },
    });
    suggestManage();
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/** Device files (device folder): those with a copy in the vault go to its trash along. */
export async function trashFiles(files: { uri: string; name: string; mime: string; size: number; taken: number }[]): Promise<boolean> {
  return trashItems(
    files.map((f) => ({
      id: localId(f.uri),
      name: f.name,
      mime: f.mime,
      size: f.size,
      thumb: false,
      duration: null,
      width: null,
      height: null,
      taken_at: f.taken / 1000,
      tz: null,
      favorite: false,
      archived: false,
      trashed_at: null,
      added_at: f.taken / 1000,
      lat: null,
      lon: null,
      local: null,
      uri: f.uri,
    })),
  );
}

/** Restore (from the Trash): vault and device. */
export async function restoreItems(ids: number[]): Promise<boolean> {
  try {
    const rows = rowsFor(ids);
    const r = await sysRestore(rows.map(ref));
    if (!r) return false;
    if (r.back.length || r.moved.length) await api.deviceTrashRemove(r.back, r.moved);
    const vault = ids.filter((i) => i > 0);
    if (vault.length) await api.restore(vault);
    after();
    const n = vault.length + rows.filter((r) => r.media_id == null).length;
    notify({ text: t("trash.restored", { n: n || ids.length }), tone: "success" });
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/** Delete forever (from the Trash): vault and device. */
export async function purgeItems(ids: number[]): Promise<boolean> {
  try {
    const rows = rowsFor(ids);
    if (!(await sysDelete(rows.map(ref)))) return false;
    if (rows.length) await api.deviceTrashRemove(rows.map((r) => r.src));
    const vault = ids.filter((i) => i > 0);
    if (vault.length) await api.purge(vault);
    after();
    const n = vault.length + rows.filter((r) => r.media_id == null).length;
    notify({ text: t("trash.purged", { n: n || ids.length }), tone: "neutral" });
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/** Empty the trash: what is in it in the vault and on the device (what is out of sync stays). */
export async function emptyAll(): Promise<boolean> {
  try {
    await loadDevice();
    const rows = useDevice.getState().rows.filter((r) => r.media_id == null || r.media_trashed);
    if (!(await sysDelete(rows.map(ref)))) return false;
    if (rows.length) await api.deviceTrashRemove(rows.map((r) => r.src));
    await api.emptyTrash();
    after();
    notify({ text: t("trash.emptied"), tone: "neutral" });
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/**
 * Free space: deletes from the device the originals already in the vault (they stay
 * on the timeline, coming from the vault). Android: permanently (one confirmation);
 * desktop: system trash.
 */
export async function freeSpace(links: Pick<DeviceLink, "src" | "size">[], onProgress?: (done: number, total: number) => void): Promise<boolean> {
  if (!links.length) return false;
  const size = new Map(links.map((l) => [l.src, l.size]));
  let bytes = 0;
  let done = 0;
  try {
    onProgress?.(0, links.length);
    const r = await sysDeleteParts(
      links.map((l) => ({ uri: l.src })),
      true,
      // Each batch already recorded: if it stops halfway, what is gone does not return to the list.
      async (part, n) => {
        if (onAndroid) await api.localForget(part.map((p) => p.uri));
        bytes += part.reduce((a, p) => a + (size.get(p.uri) ?? 0), 0);
        done = n;
        onProgress?.(n, links.length);
      },
    );
    if (done) after();
    if (!r.ok) {
      notify({
        text: done
          ? t("trash.freedPartial", { n: done, size: formatSize(bytes) })
          : t("trash.freedNone"),
        tone: done ? "info" : "danger",
      });
      return false;
    }
    notify({ text: t("trash.freed", { n: done, size: formatSize(bytes) }), tone: "success" });
    suggestManage();
    return true;
  } catch (e) {
    if (done) after();
    notifyError(e);
    return false;
  }
}

/** Resolve what is out of sync, on one side or the other. */
export const outOfSync = {
  /** In the vault trash, original on the device → original to the trash too. */
  async trashOnDevice(links: DeviceLink[]) {
    try {
      const done = await sysTrash(links.map((l) => ({ src: l.src, name: l.name, mime: l.mime, size: l.size, taken: 0 })));
      if (!done) return false;
      if (done.length) await api.deviceTrashAdd(done);
      after();
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    }
  },
  /** … or remove it from the vault trash. */
  async restoreInVault(links: DeviceLink[]) {
    try {
      await api.restore(links.map((l) => l.media_id));
      after();
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    }
  },
  /** Original in the device trash, media outside the vault trash → return the original. */
  async restoreOnDevice(items: OutOfSync["deviceOnly"]) {
    try {
      const r = await sysRestore(items.map((i) => (i.row ? ref(i.row) : { uri: i.src })));
      if (!r) return false;
      if (r.back.length || r.moved.length) await api.deviceTrashRemove(r.back, r.moved);
      after();
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    }
  },
  /** … or send the vault media item to the trash too. */
  async trashInVault(items: OutOfSync["deviceOnly"]) {
    try {
      // Trash made by another app: it is recorded from now on (restoring brings it back).
      const loose = items.filter((i) => !i.row);
      if (loose.length) await api.deviceTrashAdd(loose.map((l) => ({ src: l.src, name: l.name, mime: l.mime, size: l.size, taken: 0 })));
      await api.trash(items.map((i) => i.media_id));
      after();
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    }
  },
};

export type { DeviceLink };
