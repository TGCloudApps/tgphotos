/**
 * Galeria local na linha do tempo, como o Google Fotos: o que ainda não está
 * no vault aparece junto com o que está, com ou sem rede: as pastas com
 * backup e as marcadas "Mostrar em Fotos" no vault aberto (MediaStore no
 * Android; disco no desktop).
 */
import { create } from "zustand";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { api, type Media, type Transfer } from "./api";
import { findTrashedLocal } from "./deviceStore";
import { deviceToken, deviceUrl } from "./local";

export const useLibrary = create<{ items: Media[] }>(() => ({ items: [] }));

/** Mídia do aparelho (ids negativos): na linha do tempo ou na lixeira do aparelho. */
export const findLocal = (id: number) => useLibrary.getState().items.find((m) => m.id === id) ?? findTrashedLocal(id);

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

/** Id estável (negativo) de uma mídia do aparelho: o _ID do MediaStore ou o hash do caminho. */
export function localId(src: string): number {
  if (src.startsWith("content://")) {
    const mid = Number(src.split("?")[0].split("/").pop());
    if (Number.isFinite(mid)) return -mid;
  }
  return pathId(src);
}

/** Id estável para um caminho (desktop): hash do texto, negativo. */
function pathId(path: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return -((h >>> 0) % 2_000_000_000) - 1;
}

async function loadAndroid(): Promise<Media[] | null> {
  if (!android.hasMedia()) return null;
  const access = android.mediaAccess();
  if (!access.full && !access.partial) return null;
  // Só o que o usuário escolheu para este vault: pastas com backup e pastas
  // marcadas "Mostrar em Fotos" (nada aparece por padrão, nem a Câmera).
  const [backup, shown] = await Promise.all([api.backupFolders().catch(() => [] as string[]), api.showFolders().catch(() => [] as string[])]);
  const folders = [...new Set([...backup, ...shown])];
  if (!folders.length) return [];
  const raw = android.mediaScan(folders);
  const status = raw.length ? await api.backupStatus(raw.map((m) => m.uri)) : [];
  const t = await deviceToken();
  const out: Media[] = [];
  raw.forEach((m, i) => {
    if (status[i] === 2) return; // já no vault: aparece pela mídia do vault
    // Id estável (o _ID do MediaStore): recarregar a lista não remonta a grade.
    const mid = Number(m.uri.split("?")[0].split("/").pop());
    out.push(
      item(Number.isFinite(mid) ? -mid : -(i + 1), m.uri, m.name, m.mime, m.size, m.taken || m.modified * 1000, m.duration ? m.duration / 1000 : null, status[i] ?? 0, t ? deviceUrl(t, m.uri, m.mime, m.size) : undefined),
    );
  });
  return out;
}

/** Desktop: arquivos das pastas de backup ainda fora do vault. */
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

/** Lixeira: a do vault e a do aparelho (só o que não tem cópia no vault), pela data em que foram para lá. */
export function mergeTrash(vault: Media[], local: Media[]): Media[] {
  if (!local.length) return vault;
  return [...vault, ...local].sort((a, b) => (b.trashed_at ?? 0) - (a.trashed_at ?? 0));
}

/** Junta vault e aparelho, do mais recente ao mais antigo. */
export function merge(vault: Media[], local: Media[]): Media[] {
  if (!local.length) return vault;
  return [...vault, ...local].sort((a, b) => b.taken_at - a.taken_at || b.id - a.id);
}

let started = false;
/** Recarrega ao abrir, ao voltar ao app, com mídia nova e quando a fila de envios anda. */
export function startLibrary() {
  if (started) return;
  started = true;
  void loadLibrary();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void loadLibrary());
  window.addEventListener("tg-media-changed", () => void loadLibrary());
}

/**
 * Estado de envio por origem (caminho/URI sem query): "active" enquanto sobe,
 * para o selo de "enviando" na grade.
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
