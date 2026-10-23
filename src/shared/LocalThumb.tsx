/**
 * Thumbnail of a local file (desktop): backup folder not uploaded yet, or a
 * local original without a thumbnail in the vault. Comes from the disk cache;
 * if absent, it is generated here (video frame / downscaled image) and stored.
 * Does not depend on the network.
 */
import { useEffect, useState } from "react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { getPort } from "@tgcloud/ui/core/server";
import { makeThumb } from "@tgcloud/ui/core/thumbs";
import { deviceToken, deviceUrl } from "../core/local";
import { DeviceThumb } from "./DeviceThumb";

/** Files with a ready thumbnail (so they do not flicker on remount). */
export const ready = new Set<string>();
export const failed = new Set<string>();
/** Waiting its turn, per file; the most recent goes first (it is the one on screen). */
const queue = new Map<string, () => Promise<void>>();
let running = 0;

function pump() {
  while (running < 2 && queue.size) {
    const [src, job] = [...queue].pop()!;
    queue.delete(src);
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

export const localThumbUrl = (t: string, src: string) => `http://127.0.0.1:${getPort()}/localthumb?${new URLSearchParams({ t, src })}`;

/** Ongoing generations: a remount just waits for the same one. */
const waiting = new Map<string, (() => void)[]>();

/**
 * Generates (in the queue) and calls `done` when ready. Returns the cancel
 * function: with nobody else waiting while still queued, generation does not happen.
 */
export function generateLocal(src: string, mime: string, done: () => void): () => void {
  const cancel = () => {
    const list = waiting.get(src);
    if (!list) return;
    const i = list.indexOf(done);
    if (i >= 0) list.splice(i, 1);
    if (!list.length && queue.delete(src)) waiting.delete(src);
  };
  const list = waiting.get(src);
  if (list) {
    list.push(done);
    return cancel;
  }
  waiting.set(src, [done]);
  queue.set(src, async () => {
    try {
      const t = await deviceToken();
      const { blob } = await makeThumb(deviceUrl(t, src, mime, 0), mime.startsWith("video/"));
      const r = await fetch(localThumbUrl(t, src), { method: "POST", body: blob });
      if (!r.ok) throw new Error(await r.text());
      ready.add(src);
      for (const fn of waiting.get(src) ?? []) fn();
    } catch (e) {
      console.warn("[tgphotos] miniatura local", src, e);
      failed.add(src);
    } finally {
      waiting.delete(src);
    }
  });
  pump();
  return cancel;
}

/**
 * Keeps the thumbnail of a device file before it goes out of view (to the
 * trash): the app Trash keeps showing it. Key: the source without the query,
 * as the device trash records it.
 */
export async function keepThumb(src: string, mime: string): Promise<void> {
  const key = src.split("?")[0];
  const t = await deviceToken();
  if (!t) return;
  try {
    if (onAndroid) {
      const data = await android.deviceThumb(src, 480);
      if (!data) return;
      const blob = await (await fetch(data)).blob();
      await fetch(localThumbUrl(t, key), { method: "POST", body: blob });
      return;
    }
    if (ready.has(key)) return;
    // Generation gives no failure notice: do not hold up the trash for it.
    await Promise.race([new Promise<void>((resolve) => generateLocal(key, mime, resolve)), new Promise((r) => setTimeout(r, 8000))]);
  } catch (e) {
    console.warn("[tgphotos] miniatura para a lixeira", src, e);
  }
}

export function LocalThumb({ src, mime }: { src: string; mime: string }) {
  const [token, setToken] = useState("");
  const [rev, setRev] = useState(0);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void deviceToken().then(setToken);
  }, []);
  if (!token || (missing && !ready.has(src))) return <div className="size-full bg-s3" />;
  return (
    <img
      key={rev}
      src={localThumbUrl(token, src) + (rev ? `&v=${rev}` : "")}
      alt=""
      draggable={false}
      decoding={ready.has(src) ? "sync" : "async"}
      className="size-full object-cover"
      onLoad={() => ready.add(src)}
      onError={() => {
        if (failed.has(src)) return setMissing(true);
        setMissing(true);
        generateLocal(src, mime, () => {
          setMissing(false);
          setRev(Date.now());
        });
      }}
    />
  );
}

/** Local thumbnail: the system one on Android, the one generated here on desktop. */
export function LocalCover({ uri, mime }: { uri: string; mime: string }) {
  return onAndroid ? <DeviceThumb uri={uri} /> : <LocalThumb src={uri} mime={mime} />;
}
