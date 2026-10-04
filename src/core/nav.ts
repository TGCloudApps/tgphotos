/**
 * Rotas e camadas do TGPhotos sobre o Navigator comum: trocar de destino,
 * abrir álbum e abrir camada (visualizador, folha, diálogo, seleção) empilham;
 * o voltar fecha a camada de cima ou volta à tela anterior.
 */
import { createNav } from "@tgcloud/ui/core/nav";
import type { PickedFile } from "@tgcloud/ui/core/android";

export type Dest = "photos" | "collections" | "search" | "favorites" | "videos" | "archive" | "trash" | "transfers" | "album" | "device" | "chats" | "chat";

/**
 * `device`: pasta do aparelho (caminho relativo do MediaStore) na rota "device".
 * `chat`/`topic`: conversa (chave do Rust) e tópico de fórum na rota "chat".
 */
export type Route = { dest: Dest; album: number; query: string; device?: string; chat?: string; topic?: number };

export type Layer =
  | { type: "viewer"; id: number; siblings: number[] }
  /** Mídia do aparelho (fora do vault); ids negativos, da pasta aberta. */
  | { type: "device-viewer"; id: number; siblings: number[] }
  | { type: "details"; id: number }
  /** Menu ⋮ do visualizador no celular. */
  | { type: "viewer-menu" }
  | { type: "selection" }
  | { type: "add" }
  | { type: "actions"; ids: number[] }
  | { type: "album-pick"; ids: number[] }
  | { type: "name"; mode: "album-new" | "album-rename"; id?: number; ids?: number[] }
  | { type: "confirm"; action: "purge" | "empty" | "signout" | "album-delete"; ids: number[] }
  | { type: "account" }
  /** Enviar (copiar) para outro vault. */
  | { type: "send-vault"; ids: number[] }
  | { type: "album-menu"; id: number }
  /** Fotos do aparelho: mover para outra pasta, renomear. */
  | { type: "device-move"; uris: string[] }
  | { type: "device-rename"; uri: string; name: string }
  /** Lixeira do vault e a do aparelho discordando: escolher qual lado vale. */
  | { type: "out-of-sync" }
  /** Baixar antes de abrir com / editar / definir como (mídia só no vault). */
  | { type: "fetch"; id: number; how: "view" | "edit" | "attach" }
  /** Apagar do aparelho os originais que já estão no vault. */
  | { type: "free-space" }
  | { type: "backup" }
  | { type: "import" }
  | { type: "receive"; items: PickedFile[] };

const ROOT: Route = { dest: "photos", album: 0, query: "" };
const DESTS = ["photos", "collections", "search", "favorites", "videos", "archive", "trash", "transfers", "album", "device", "chats", "chat"];

function fromHash(hash: string): Route {
  const c = hash.match(/^#\/chat\/([^/]+)(?:\/(\d+))?$/);
  if (c) return { dest: "chat", album: 0, query: "", chat: decodeURIComponent(c[1]), topic: c[2] ? Number(c[2]) : undefined };
  const d = hash.match(/^#\/device\/(.*)$/);
  if (d) return { dest: "device", album: 0, query: "", device: decodeURIComponent(d[1]) };
  const m = hash.match(/^#\/([a-z]+)(?:\/(\d+))?/);
  if (!m || !DESTS.includes(m[1])) return ROOT;
  const dest = m[1] as Dest;
  if (dest === "album") return m[2] ? { dest, album: Number(m[2]), query: "" } : ROOT;
  if (dest === "device" || dest === "chat") return ROOT;
  return { dest, album: 0, query: "" };
}

const hashOf = (r: Route) =>
  r.dest === "album"
    ? `#/album/${r.album}`
    : r.dest === "device"
      ? `#/device/${encodeURIComponent(r.device ?? "")}`
      : r.dest === "chat"
        ? `#/chat/${encodeURIComponent(r.chat ?? "")}${r.topic ? `/${r.topic}` : ""}`
        : `#/${r.dest}`;

const sameRoute = (a: Route, b: Route) =>
  a.dest === b.dest && a.album === b.album && a.query === b.query && a.device === b.device && a.chat === b.chat && a.topic === b.topic;

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

  /** Conversa (importar de chats); `topic`: tópico de um fórum. */
  chat(key: string, topic?: number) {
    nav.go({ dest: "chat", chat: key, topic });
  },

  /** Pasta do aparelho (Android). */
  device(path: string) {
    nav.go({ dest: "device", device: path });
  },

  /** Busca: substitui a entrada quando já está buscando (digitar não empilha). */
  search(query: string) {
    const cur = useNav.getState().entry;
    if (cur.route.dest === "search" && cur.layers.length === 0) core.nav.replace({ ...cur, route: { ...cur.route, query } });
    else core.nav.push({ route: { ...ROOT, dest: "search", query }, layers: [] });
  },
};
