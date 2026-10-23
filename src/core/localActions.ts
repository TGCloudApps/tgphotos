/**
 * Manage local photos like a gallery: delete, move to another folder, rename,
 * open with another app. Applies to what is only on the device and to the local
 * original of a vault media item.
 *
 * Android: through MediaStore, with the system confirmation. Desktop: operating
 * system trash and the default app.
 */
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { api, type Media } from "./api";
import { freeSpace, trashItems } from "./deviceTrash";
import { loadLibrary } from "./library";
import { t } from "../i18n";

/** What the actions need from an item (timeline media or device folder media). */
type Local = Pick<Media, "mime"> & { uri?: string; local?: string | null };

/** Local file of the media item (device only, or original uploaded from here). */
export const localOf = (m: Local) => m.uri ?? m.local ?? null;

/** Tells the open screens (device folder) that local content changed. */
const changed = () => window.dispatchEvent(new Event("tg-local-changed"));


/**
 * Delete through the gallery: unified trash (vault and device together; restoring
 * brings both back — see deviceTrash.ts). Returns whether it worked.
 */
export const deleteLocal = (list: Media[]) => trashItems(list);

/** "Delete from device" for vault media: only the copy here goes (like freeing space). */
export const freeLocal = (list: Media[]) => freeSpace(list.flatMap((m) => (m.local ? [{ src: m.local, size: m.size }] : [])));

export async function moveLocal(srcs: string[], folder: string) {
  try {
    const r = await android.deviceMove(srcs, folder);
    if (!r.ok) {
      if (r.error) notify({ text: r.error, tone: "danger" });
      return;
    }
    // Same MediaStore item in another folder: only the listing changes.
    void loadLibrary();
    changed();
    notify({ text: t("core.movedTo", { n: srcs.length, folder: folder.split("/").pop() ?? folder }), tone: "neutral" });
  } catch (e) {
    notifyError(e);
  }
}

export async function renameLocal(src: string, name: string) {
  try {
    const r = await android.deviceRename(src, name);
    if (!r.ok) {
      if (r.error) notify({ text: r.error, tone: "danger" });
      return;
    }
    void loadLibrary();
    changed();
  } catch (e) {
    notifyError(e);
  }
}

/** Open with another app / edit / set as (Android); default app or folder (desktop). */
export function openLocal(m: Local, how: "view" | "edit" | "attach" | "reveal") {
  const src = localOf(m);
  if (!src) return;
  if (onAndroid) {
    if (!android.deviceIntent(src, m.mime, how === "reveal" ? "view" : how)) notify({ text: t("core.noAppAccepted"), tone: "danger" });
    return;
  }
  void api.localOpen(src, how === "reveal").catch(notifyError);
}
