/**
 * Local originals: a vault media item uploaded from this device opens from the
 * local file (`/local/<id>`, no network; the server falls back to Telegram if the
 * file is gone). Device media outside the vault comes through `/device`.
 */
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import type { LocalSource } from "@tgcloud/ui/core/app";
import type { MediaItem } from "@tgcloud/ui/core/item";
import { getPort, invoke, vaultScope } from "@tgcloud/ui/core/server";
import type { Media } from "./api";

let token: Promise<string> | null = null;
let tokenValue = "";
export const deviceToken = () =>
  (token ??= invoke<string>("device_token")
    .then((t) => (tokenValue = t))
    .catch(() => ""));
/** Token already known (synchronous; empty before the first reply). */
export const tokenNow = () => tokenValue;

/** Sets a local `src` on the media items that have an original here. */
export async function withLocal(list: Media[]): Promise<Media[]> {
  if (!list.some((m) => m.local)) return list;
  const t = await deviceToken();
  if (!t) return list;
  // The id is local to the vault: the vault in the URL splits the caches when switching.
  return list.map((m) => (m.local ? { ...m, src: `http://127.0.0.1:${getPort()}/local/${m.id}?t=${t}&v=${vaultScope()}` } : m));
}

export const deviceUrl = (t: string, uri: string, mime: string, size: number) =>
  `http://127.0.0.1:${getPort()}/device?${new URLSearchParams({ uri, t, mime, size: String(size) })}`;

/**
 * What the device already has of a vault media item uploaded from here, so the
 * vault thumbnail does not download from Telegram: the system thumbnail (Android)
 * or the one stored on disk (desktop), and the local original.
 */
export async function localSource(n: MediaItem): Promise<LocalSource | null> {
  const m = n as Media;
  if (!m.local || m.id < 0) return null;
  const t = await deviceToken();
  if (!t) return null;
  let thumb: Blob | undefined;
  try {
    const url = onAndroid ? await android.deviceThumb(m.local, 480) : `http://127.0.0.1:${getPort()}/localthumb?${new URLSearchParams({ t, src: m.local })}`;
    const res = url ? await fetch(url) : null;
    if (res?.ok) thumb = await res.blob();
  } catch {
    /* no local thumbnail: the original will do */
  }
  return { thumb, original: `http://127.0.0.1:${getPort()}/local/${m.id}?t=${t}&v=${vaultScope()}` };
}
