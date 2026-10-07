/**
 * Backend simulado para desenvolver a interface no navegador (`npm run dev`,
 * fora do Tauri). Só é carregado em DEV; não entra no build do app.
 */
import type { Mock } from "@tgcloud/ui/core/server";
import type { Album, Details, Media } from "./api";

const now = Math.floor(Date.now() / 1000);
const day = 86400;
let seq = 1;

// Gerador determinístico (a mesma "biblioteca" a cada recarga).
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const shapes: [number, number][] = [
  [4000, 3000],
  [3000, 4000],
  [4032, 3024],
  [1920, 1080],
  [1080, 1920],
  [3000, 3000],
  [6000, 2000],
];

const media: Media[] = [];
for (let i = 0; i < 420; i++) {
  // Mais fotos recentes; algumas sequências no mesmo dia.
  const age = Math.floor(Math.pow(rand(), 1.6) * 760) * day + Math.floor(rand() * day);
  const video = rand() < 0.08;
  const [w, h] = video ? (rand() < 0.5 ? [1920, 1080] : [1080, 1920]) : shapes[Math.floor(rand() * shapes.length)];
  const t = now - age;
  const d = new Date(t * 1000);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  media.push({
    id: seq++,
    name: video ? `VID_${stamp}_${String(i).padStart(4, "0")}.mp4` : `IMG_${stamp}_${String(i).padStart(4, "0")}.jpg`,
    mime: video ? "video/mp4" : "image/jpeg",
    size: video ? 40_000_000 + Math.floor(rand() * 200_000_000) : 1_200_000 + Math.floor(rand() * 600_000),
    thumb: false,
    duration: video ? 5 + Math.floor(rand() * 180) : null,
    width: w,
    height: h,
    taken_at: t,
    tz: -180,
    favorite: rand() < 0.06,
    archived: rand() < 0.02,
    trashed_at: rand() < 0.015 ? now - Math.floor(rand() * 20) * day : null,
    added_at: t + 3600,
    lat: rand() < 0.4 ? -23.55 + rand() * 0.2 : null,
    local: null,
    lon: null,
  });
  const m = media[media.length - 1];
  if (m.lat !== null) m.lon = -46.63 + rand() * 0.2;
}
media.sort((a, b) => b.taken_at - a.taken_at);

type MockAlbum = { id: number; name: string; cover: number | null; created_at: number; modified_at: number; items: Set<number> };
const shortViews = new Map<number, number>();
const shortLikes = new Set<number>();
const albums: MockAlbum[] = [
  { id: 1, name: "Viagem para a praia", cover: null, created_at: now - 40 * day, modified_at: now - 2 * day, items: new Set(media.slice(20, 48).map((m) => m.id)) },
  { id: 2, name: "Aniversário", cover: null, created_at: now - 200 * day, modified_at: now - 30 * day, items: new Set(media.slice(120, 140).map((m) => m.id)) },
  { id: 3, name: "Rascunhos", cover: null, created_at: now - 5 * day, modified_at: now - 5 * day, items: new Set() },
];

const alive = (m: Media) => !m.trashed_at;
const byView: Record<string, (m: Media) => boolean> = {
  timeline: (m) => alive(m) && !m.archived,
  favorites: (m) => alive(m) && m.favorite,
  videos: (m) => alive(m) && !m.archived && m.mime.startsWith("video/"),
  archive: (m) => alive(m) && m.archived,
  trash: (m) => !!m.trashed_at,
};

function albumView(a: MockAlbum): Album {
  const list = media.filter((m) => a.items.has(m.id) && alive(m));
  return {
    id: a.id,
    name: a.name,
    count: list.length,
    cover: a.cover ?? list[0]?.id ?? null,
    created_at: a.created_at,
    modified_at: a.modified_at,
    first: list.length ? Math.min(...list.map((m) => m.taken_at)) : null,
    last: list.length ? Math.max(...list.map((m) => m.taken_at)) : null,
  };
}

type Args = Record<string, unknown>;
let backupFolders: string[] = [];
const ids = (a: Args) => a.ids as number[];
const each = (a: Args, fn: (m: Media) => void) => media.filter((m) => ids(a).includes(m.id)).forEach(fn);

const vault = { id: 1, name: "Família", title: "Família.tgphotos", valid: true, unsupported: false, legacy: false, created_at: Date.now() - 90 * day * 1000, current: true };

const secret = { id: 2, name: "Documentos", title: "Documentos.tgphotos", valid: true, unsupported: false, legacy: false, encrypted: true, unlocked: false, created_at: Date.now() - 10 * day * 1000, current: false };

const handlers: Record<string, (a: Args) => unknown> = {
  status: () => ({ authorized: true, port: 0, vault: new URLSearchParams(location.search).has("novault") ? null : vault }),
  cached_vaults: () => [],
  list_vaults: () => [vault, secret],
  open_vault: (a) => {
    if (a.id === secret.id && !secret.unlocked) throw new Error("SENHA_NECESSARIA");
    return a.id === secret.id ? secret : vault;
  },
  // Senha simulada: 12345678.
  unlock_vault: (a) => {
    if (a.password !== "12345678") throw new Error("senha incorreta");
    secret.unlocked = true;
    return secret;
  },
  create_vault: () => vault,
  vault_remember_key: (a) => {
    if (a.password !== "12345678") throw new Error("senha incorreta");
  },
  copy_to_vault: () => 1,
  vault_link: (a) => `https://t.me/c/${a.id}/1`,
  delete_vault: () => {},
  local_link: () => {},
  local_relink: () => 0,
  exclude_from_vault: (a) => (a.srcs as string[]).length,
  chat_token: () => "",
  chats: () => ({ chats: [], next: null }),
  chats_search: () => [],
  chat_topics: () => [],
  chat_media: () => ({ items: [], next: null }),
  chat_import: (a) => (a.items as unknown[]).length,
  device_trash_add: () => [],
  device_trash_list: () => [],
  device_trash_remove: () => {},
  device_links: () => [],
  local_states: (a) => (a.paths as string[]).map(() => 1),
  local_restore: (a) => (a.paths as string[]).length,
  local_purge: (a) => (a.paths as string[]).length,
  local_free: (a) => (a.paths as string[]).length,
  copies: () => [],
  copies_clear: () => {},
  rename_vault: (a) => ({ id: a.id, name: String(a.name), title: `${a.name}`, valid: true, unsupported: false, legacy: false, created_at: Date.now(), current: false }),
  close_vault: () => {},
  sync_now: () => ({ pulled: 0, pushed: 0, compacted: false }),
  kick_sync: () => {},
  sign_out: () => {},
  transfers: () => [],
  housekeep: () => 0,
  backup_folders: () => backupFolders,
  backup_set_folder: (a) => {
    backupFolders = a.on ? [...new Set([...backupFolders, String(a.path)])] : backupFolders.filter((f) => f !== a.path);
  },
  backup_scan: () => ({ queued: 0, scanned: 0 }),
  backup_local: () => [],
  backup_enqueue: () => ({ queued: 0, scanned: 0 }),
  import_sources: () => [{ id: 9, name: "Pessoal", title: "Pessoal.tgdrive" }],
  import_browse: () =>
    Array.from({ length: 24 }, (_, i) => ({
      uid: `n${i}`,
      name: `IMG_2023${String((i % 12) + 1).padStart(2, "0")}10_1200${i}.jpg`,
      mime: "image/jpeg",
      size: 2_000_000 + i * 10_000,
      folder: i < 10 ? "Fotos/Viagem" : i < 20 ? "Fotos/2023" : "",
      duration: null,
      mtime: now - i * day,
      have: i % 7 === 0,
    })),
  import_run: (a) => ({ imported: (a.uids as string[]).length, skipped: 0, failed: 0 }),
  media_list: (a) => media.filter(byView[a.view as string]).sort((x, y) => (a.view === "trash" ? (y.trashed_at ?? 0) - (x.trashed_at ?? 0) : 0)),
  media_details: (a): Details | null => {
    const m = media.find((x) => x.id === a.id);
    if (!m) return null;
    return {
      ...m,
      camera: m.mime.startsWith("image/") ? { make: "Google", model: "Pixel 8", f: 1.7, exposure: 1 / 120, iso: 64, focal: 6.9 } : null,
      origin: "DCIM/Camera",
      sha256: null,
      albums: albums.filter((al) => al.items.has(m.id)).map((al) => ({ id: al.id, name: al.name })),
    };
  },
  search: (a) => {
    const q = String(a.text).toLowerCase();
    return media.filter((m) => alive(m) && (m.name.toLowerCase().includes(q) || albums.some((al) => al.items.has(m.id) && al.name.toLowerCase().includes(q))));
  },
  intel_query: (a) => {
    const q = String(a.text).toLowerCase();
    // Com descrição: "acha" metade da biblioteca, em outra ordem (por relevância).
    if (a.semantic && q) return { items: media.filter((m, i) => alive(m) && i % 2 === 0).reverse(), chips: [], semantic: true, semantic_state: null };
    return { items: media.filter((m) => alive(m) && (!q || m.name.toLowerCase().includes(q))), chips: [], semantic: false, semantic_state: { state: "partial", done: 320, total: 1000, model: null } };
  },
  intel_status: () => ({
    settings: { mode: "auto", min_battery: 30, budget: 0.3, search: true, people: true, text: true, places: true, duplicates: true, share: true, share_faces: true },
    running: null,
    hold: null,
    rush: false,
    battery: false,
    stages: [{ stage: "clip", done: 320, total: 1000 }, { stage: "faces", done: 120, total: 1000 }, { stage: "ocr", done: 0, total: 1000 }, { stage: "place", done: 1000, total: 1000 }, { stage: "hash", done: 1000, total: 1000 }],
    models: [
      { stage: "clip", name: "busca-siglip2-b32-256", state: "downloading", done: 120e6, size: 413e6, error: null },
      { stage: "ocr", name: "texto-ppocr5-latin", state: "failed", done: 0, size: 0, error: "catálogo não encontrado" },
    ],
    metered: false,
    encrypted: false,
    packs_waiting: 1,
  }),
  intel_retry: () => {},
  intel_usage: () => ({ models: 448e6, data: 23e6 }),
  intel_reset: () => {},
  people_review: () => [
    { kind: "face", face: 3, media: media[0]?.id ?? 1, person: "P1", name: "Gabi", cover: 1, score: 0.46 },
    { kind: "pair", a: "P1", b: "P2", a_name: "Gabi", b_name: "", a_cover: 1, b_cover: 2, score: 0.47 },
  ],
  review_no: () => {},
  intel_set: () => {},
  people_list: () => [
    { uid: "P1", name: "Gabi", hidden: false, cover: 1, count: 42 },
    { uid: "P2", name: "", hidden: false, cover: 2, count: 1 },
  ],
  dup_groups: () => [
    { key: "g1", kind: "similar", best: media[0]?.id, items: media.slice(0, 3) },
    { key: "g2", kind: "burst", best: media[4]?.id, items: media.slice(3, 5) },
  ],
  // Alguns pontos em São Paulo e no Rio, para ver o mapa no navegador.
  map_points: () => media.slice(0, 80).map((m, i) => [m.id, (i % 3 ? -23.55 : -22.9) + ((i * 7) % 11) * 0.01, (i % 3 ? -46.63 : -43.2) + ((i * 5) % 13) * 0.01]),
  places_list: () => [
    { city: "São Paulo", state: "SP", country: "Brasil", count: 52, cover: media[0]?.id ?? 0 },
    { city: "Rio de Janeiro", state: "RJ", country: "Brasil", count: 28, cover: media[1]?.id ?? 0 },
  ],
  media_intel: () => ({
    place: "São Paulo, Brasil",
    text: "PADARIA SÃO JOÃO",
    faces: [
      { id: 1, x: 0.2, y: 0.2, w: 0.2, h: 0.25, person: "P1", name: "Gabi" },
      { id: 2, x: 0.6, y: 0.3, w: 0.15, h: 0.2, person: null, name: null },
    ],
  }),
  dup_keep: () => {},
  person_media: () => media.slice(0, 30),
  person_faces: () => [1, 2, 3, 4, 5, 6, 7, 8],
  media_faces: () => [],
  intel_power: () => {},
  intel_touch: () => {},
  intel_boost: () => {},
  intel_rush: () => {},
  usage: () => ({
    photos: media.filter((m) => alive(m) && !m.mime.startsWith("video/")).length,
    videos: media.filter((m) => alive(m) && m.mime.startsWith("video/")).length,
    bytes: media.filter(alive).reduce((s, m) => s + m.size, 0),
  }),
  shorts_next: (a) => {
    const skip = new Set(a.skip as number[]);
    return media
      .filter((m) => alive(m) && !m.archived && !skip.has(m.id))
      .map((m) => ({ ...m, views: shortViews.get(m.id) ?? 0, liked: shortLikes.has(m.id) }))
      .sort((x, y) => x.views - y.views || Math.random() - 0.5)
      .slice(0, a.limit as number);
  },
  shorts_liked: () =>
    media
      .filter((m) => alive(m) && shortLikes.has(m.id))
      .map((m) => ({ ...m, views: shortViews.get(m.id) ?? 0, liked: true }))
      .reverse(),
  short_like: (a) => void (a.on ? shortLikes.add(a.id as number) : shortLikes.delete(a.id as number)),
  short_view: (a) => {
    const n = (shortViews.get(a.id as number) ?? 0) + 1;
    shortViews.set(a.id as number, n);
    return n;
  },
  set_favorite: (a) => each(a, (m) => (m.favorite = a.on as boolean)),
  set_archived: (a) => each(a, (m) => (m.archived = a.on as boolean)),
  trash: (a) => each(a, (m) => (m.trashed_at = Math.floor(Date.now() / 1000))),
  restore: (a) => each(a, (m) => (m.trashed_at = null)),
  set_taken: (a) => each({ ids: [a.id] }, (m) => (m.taken_at = (a.taken as number) / 1000)),
  purge: (a) => {
    for (let i = media.length - 1; i >= 0; i--) if (ids(a).includes(media[i].id)) media.splice(i, 1);
  },
  empty_trash: () => {
    for (let i = media.length - 1; i >= 0; i--) if (media[i].trashed_at) media.splice(i, 1);
  },
  albums: () => albums.map(albumView).sort((x, y) => y.modified_at - x.modified_at),
  album_media: (a) => {
    const al = albums.find((x) => x.id === a.id);
    return al ? media.filter((m) => al.items.has(m.id) && alive(m)).sort((x, y) => x.taken_at - y.taken_at) : [];
  },
  album_create: (a) => {
    const id = Math.max(0, ...albums.map((x) => x.id)) + 1;
    albums.push({ id, name: String(a.name), cover: null, created_at: now, modified_at: Math.floor(Date.now() / 1000), items: new Set(ids(a)) });
    return id;
  },
  album_rename: (a) => albums.filter((x) => x.id === a.id).forEach((x) => (x.name = String(a.name))),
  album_delete: (a) => albums.splice(albums.findIndex((x) => x.id === a.id), 1),
  album_add: (a) => {
    const al = albums.find((x) => x.id === a.id)!;
    const before = al.items.size;
    ids(a).forEach((id) => al.items.add(id));
    al.modified_at = Math.floor(Date.now() / 1000);
    return al.items.size - before;
  },
  album_remove: (a) => {
    const al = albums.find((x) => x.id === a.id)!;
    ids(a).forEach((id) => al.items.delete(id));
  },
  album_set_cover: (a) => albums.filter((x) => x.id === a.id).forEach((x) => (x.cover = a.media as number)),
};

async function mockInvoke<T>(cmd: string, args: Args = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 80));
  const h = handlers[cmd];
  if (!h) throw new Error(`mock: comando ${cmd} não simulado`);
  return structuredClone(h(args)) as T;
}

/** Imagem de exemplo (SVG) na proporção da mídia. */
function mockFileUrl(id: number) {
  const m = media.find((x) => x.id === id);
  const [w, h] = m?.width && m.height ? [m.width / 10, m.height / 10] : [400, 300];
  const hue = (id * 67) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},65%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360},60%,22%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.72}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.12}" fill="rgba(255,255,255,.35)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const mock: Mock = {
  invoke: mockInvoke,
  fileUrl: mockFileUrl,
  upload: <T,>(file: File, params: Record<string, string>, onProgress: (sent: number) => void) => {
    let stop = false;
    const promise = new Promise<T>((resolve, reject) => {
      let sent = 0;
      const tick = () => {
        if (stop) return reject(new Error("cancelado"));
        sent = Math.min(file.size, sent + 4 * 1024 * 1024 * 0.2);
        onProgress(sent);
        if (sent < file.size) return void setTimeout(tick, 200);
        const m: Media = {
          id: seq++,
          name: file.name,
          mime: file.type || "image/jpeg",
          size: file.size,
          thumb: false,
          duration: null,
          width: 4000,
          height: 3000,
          taken_at: Math.floor(file.lastModified / 1000),
          tz: null,
          favorite: false,
          archived: false,
          trashed_at: null,
          added_at: Math.floor(Date.now() / 1000),
          lat: null,
          lon: null,
          local: null,
        };
        media.unshift(m);
        media.sort((a, b) => b.taken_at - a.taken_at);
        const album = albums.find((x) => x.id === Number(params.parent));
        album?.items.add(m.id);
        resolve(m as T);
      };
      setTimeout(tick, 200);
    });
    return { promise, abort: () => (stop = true) };
  },
};
