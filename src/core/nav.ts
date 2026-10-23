/**
 * TGPhotos routes and layers on top of the common Navigator: changing destination,
 * opening an album and opening a layer (viewer, sheet, dialog, selection) stack;
 * back closes the top layer or returns to the previous screen.
 */
import { createNav } from "@tgcloud/ui/core/nav";
import type { PickedFile } from "@tgcloud/ui/core/android";

export type Dest = "shorts" | "liked" | "photos" | "collections" | "search" | "favorites" | "videos" | "recent" | "archive" | "trash" | "transfers" | "album" | "device" | "chats" | "chat";

/**
 * `device`: device folder (MediaStore relative path) on the "device" route.
 * `chat`/`topic`: conversation (Rust key) and forum topic on the "chat" route.
 * `at`: on the "liked" route, the position open in the likes feed (absent = the grid).
 */
export type Route = { dest: Dest; album: number; query: string; device?: string; chat?: string; topic?: number; at?: number };

export type Layer =
  | { type: "viewer"; id: number; siblings: number[] }
  /** Device media (outside the vault); negative ids, from the open folder. */
  | { type: "device-viewer"; id: number; siblings: number[] }
  | { type: "details"; id: number }
  /** Viewer ⋮ menu on mobile. */
  | { type: "viewer-menu" }
  | { type: "selection" }
  | { type: "add" }
  | { type: "actions"; ids: number[] }
  | { type: "album-pick"; ids: number[] }
  | { type: "name"; mode: "album-new" | "album-rename"; id?: number; ids?: number[] }
  | { type: "confirm"; action: "purge" | "empty" | "signout" | "album-delete"; ids: number[] }
  | { type: "account" }
  /** Send (copy) to another vault. */
  | { type: "send-vault"; ids: number[] }
  | { type: "album-menu"; id: number }
  /** Device photos: move to another folder, rename. */
  | { type: "device-move"; uris: string[] }
  | { type: "device-rename"; uri: string; name: string }
  /** Vault trash and device trash disagreeing: choose which side wins. */
  | { type: "out-of-sync" }
  /** Download before opening with / editing / setting as (vault-only media). */
  | { type: "fetch"; id: number; how: "view" | "edit" | "attach" }
  /** Delete from the device the originals that are already in the vault. */
  | { type: "free-space" }
  | { type: "backup" }
  | { type: "import" }
  /** Import a Google Photos takeout (desktop only). */
  | { type: "import-google" }
  | { type: "receive"; items: PickedFile[] };

const ROOT: Route = { dest: "photos", album: 0, query: "" };
const DESTS = ["shorts", "liked", "photos", "collections", "search", "favorites", "videos", "recent", "archive", "trash", "transfers", "album", "device", "chats", "chat"];

function fromHash(hash: string): Route {
  const c = hash.match(/^#\/chat\/([^/]+)(?:\/(\d+))?$/);
  if (c) return { dest: "chat", album: 0, query: "", chat: decodeURIComponent(c[1]), topic: c[2] ? Number(c[2]) : undefined };
  const d = hash.match(/^#\/device\/(.*)$/);
  if (d) return { dest: "device", album: 0, query: "", device: decodeURIComponent(d[1]) };
  const m = hash.match(/^#\/([a-z]+)(?:\/(\d+))?/);
  if (!m || !DESTS.includes(m[1])) return ROOT;
  const dest = m[1] as Dest;
  if (dest === "liked") return { dest, album: 0, query: "", at: m[2] ? Number(m[2]) : undefined };
  if (dest === "album") return m[2] ? { dest, album: Number(m[2]), query: "" } : ROOT;
  if (dest === "device" || dest === "chat") return ROOT;
  return { dest, album: 0, query: "" };
}

const hashOf = (r: Route) =>
  r.dest === "liked" && r.at !== undefined
    ? `#/liked/${r.at}`
    : r.dest === "album"
    ? `#/album/${r.album}`
    : r.dest === "device"
      ? `#/device/${encodeURIComponent(r.device ?? "")}`
      : r.dest === "chat"
        ? `#/chat/${encodeURIComponent(r.chat ?? "")}${r.topic ? `/${r.topic}` : ""}`
        : `#/${r.dest}`;

const sameRoute = (a: Route, b: Route) =>
  a.dest === b.dest && a.album === b.album && a.query === b.query && a.device === b.device && a.chat === b.chat && a.topic === b.topic && a.at === b.at;

const core = createNav<Route, Layer>({ root: ROOT, parse: fromHash, hash: hashOf, same: sameRoute });

export const useNav = core.useNav;
export const useRoute = core.useRoute;
export const useLayers = core.useLayers;

export const nav = {
  ...core.nav,

  go(route: Partial<Route>) {
    core.nav.go({ ...ROOT, ...route });
  },

  dest(dest: Dest) {
    nav.go({ dest });
  },

  album(id: number) {
    nav.go({ dest: "album", album: id });
  },

  /** Conversation (import from chats); `topic`: a forum topic. */
  chat(key: string, topic?: number) {
    nav.go({ dest: "chat", chat: key, topic });
  },

  /** Device folder (Android). */
  device(path: string) {
    nav.go({ dest: "device", device: path });
  },

  /** Search: replaces the entry when already searching (typing does not stack). */
  search(query: string) {
    const cur = useNav.getState().entry;
    if (cur.route.dest === "search" && cur.layers.length === 0) core.nav.replace({ ...cur, route: { ...cur.route, query } });
    else core.nav.push({ route: { ...ROOT, dest: "search", query }, layers: [] });
  },
};
