/**
 * Lixeira unificada, como o Google Fotos: mover para a lixeira tira a foto do
 * vault e do aparelho juntos; restaurar devolve aos dois (no aparelho, para a
 * mesma pasta); apagar de vez apaga dos dois.
 *
 * No aparelho:
 * - Android 11+: lixeira do sistema (o arquivo fica escondido na pasta, com o
 *   mesmo endereço, e o sistema apaga sozinho em 30 dias). Com "Gerenciamento
 *   de mídia" (Android 12+) não há confirmação a cada vez.
 * - Android < 11: sem lixeira do sistema; o app guarda uma cópia na pasta dele
 *   e devolve ao restaurar (vira um item novo do MediaStore).
 * - Desktop: lixeira do sistema operacional.
 *
 * O Rust guarda o que foi para a lixeira do aparelho e a ligação com o vault
 * (`device_trash`); aqui ficam a parte do sistema e as contas do que está
 * "fora de sincronia" (lixeira do vault e do aparelho discordando — feita em
 * outro aparelho, ou por outro app) e do que dá para "liberar espaço".
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

const DAY = 86_400_000;
/** Igual à lixeira do vault e à do sistema. */
const KEEP_DAYS = 30;

const key = (src: string) => src.split("?")[0];
const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** Arquivo do aparelho (só local, ou original de uma mídia do vault). */
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

// ---- o que o sistema faz ---------------------------------------------------------------

/** Android sem acesso total às mídias: o estado dos arquivos não é confiável. */
const blind = () => onAndroid && !android.mediaAccess().full;

/** 0 = sumiu, 1 = no aparelho, 2 = na lixeira (Android; no desktop, 0/1). */
async function states(refs: TrashRef[]): Promise<MediaState[]> {
  if (!refs.length) return [];
  if (onAndroid) return android.mediaStates(refs);
  return (await api.localStates(refs.map((r) => r.uri))) as MediaState[];
}

/** Para a lixeira do aparelho; `null` = a pessoa recusou (nada mudou). */
async function sysTrash(files: LocalFile[]): Promise<DeviceTrashIn[] | null> {
  if (!files.length) return [];
  if (!onAndroid) {
    await api.localTrash(files.map((f) => f.src));
    return files.map((f) => ({ ...f, src: key(f.src) }));
  }
  const r = await android.deviceTrash(files.map((f) => f.src));
  if (!r.ok && !r.items?.length) {
    if (r.error) notify({ text: r.error, tone: "danger" });
    return null;
  }
  if (r.error) notify({ text: `Alguns itens não foram para a lixeira do aparelho: ${r.error}`, tone: "danger" });
  const done = new Map((r.items ?? []).map((i) => [key(i.uri), i]));
  return files.flatMap((f) => {
    const i = done.get(key(f.src));
    return i ? [{ ...f, src: key(f.src), stash: i.stash ?? null, folder: i.folder ?? "" }] : [];
  });
}

/**
 * Sai da lixeira do aparelho. `back`: voltaram (ou não estão mais lá e saem do
 * registro); `moved`: voltaram com outro endereço. `null` = recusou.
 */
async function sysRestore(rows: TrashRef[]): Promise<{ back: string[]; moved: [string, string][] } | null> {
  if (!rows.length) return { back: [], moved: [] };
  if (!onAndroid) {
    await api.localRestore(rows.map((r) => r.uri));
    const st = await states(rows);
    const lost = rows.filter((_, i) => st[i] !== 1).length;
    if (lost) notify({ text: `${plural(lost, "1 arquivo não estava", "arquivos não estavam")} mais na lixeira do sistema`, tone: "danger" });
    return { back: rows.map((r) => key(r.uri)), moved: [] };
  }
  const r = await android.deviceRestore(rows);
  if (!r.ok && !r.items?.length) {
    if (r.error) notify({ text: r.error, tone: "danger" });
    return null;
  }
  if (r.error) notify({ text: `Alguns itens não voltaram para o aparelho: ${r.error}`, tone: "danger" });
  const back: string[] = [];
  const moved: [string, string][] = [];
  for (const i of r.items ?? []) {
    if (i.new) moved.push([key(i.uri), key(i.new)]);
    else back.push(key(i.uri));
  }
  return { back, moved };
}

/** Apaga de vez do aparelho (`free`: originais fora da lixeira). `false` = recusou. */
async function sysDelete(refs: TrashRef[], free = false): Promise<boolean> {
  if (!refs.length) return true;
  if (!onAndroid) {
    const paths = refs.map((r) => r.uri);
    await (free ? api.localFree(paths) : api.localPurge(paths));
    return true;
  }
  const r = await android.deviceDelete(refs);
  if (!r.ok && r.error) notify({ text: r.error, tone: "danger" });
  return r.ok;
}

/** Depois de mexer: galeria local, lixeira do aparelho e listas do vault. */
function after() {
  void loadLibrary();
  void loadDevice();
  refreshSoon();
  window.dispatchEvent(new Event("tg-local-changed"));
}

/** Uma vez: sugere o "Gerenciamento de mídia" para não confirmar a cada vez. */
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
    text: "Para apagar e restaurar sem confirmar toda vez, permita o gerenciamento de mídia",
    tone: "info",
    action: { label: "Permitir", run: () => void android.requestManageMedia() },
  });
}

// ---- estado (Lixeira, fora de sincronia, liberar espaço) -------------------------------

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
 * Relê a lixeira do aparelho e confere com o sistema: o que sumiu (expirou,
 * apagado por outro app) ou voltou por fora sai do registro; cópias guardadas
 * (Android < 11) e itens na lixeira do desktop expiram em 30 dias. Pedida
 * durante uma leitura, faz outra depois (a de agora pode já estar velha).
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
/** Confere ao abrir, ao voltar ao app e quando o MediaStore muda. */
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

/** Linhas da lixeira do aparelho que correspondem aos ids da grade (vault > 0, só do aparelho < 0). */
function rowsFor(ids: number[]): DeviceTrash[] {
  const vault = new Set(ids.filter((i) => i > 0));
  const local = new Set(ids.filter((i) => i < 0));
  return useDevice.getState().rows.filter((r) => (r.media_id != null && vault.has(r.media_id)) || local.has(localId(r.src)));
}

// ---- ações ------------------------------------------------------------------------------

/**
 * Mover para a lixeira (vault e aparelho). Mídias do vault levam junto o
 * original deste aparelho; itens só do aparelho vão para a lixeira dele.
 * `false` se a pessoa recusou a confirmação do sistema (nada muda).
 */
export async function trashItems(items: Media[]): Promise<boolean> {
  if (!items.length) return false;
  try {
    let files = items.map(fileOf).filter((f): f is LocalFile => !!f);
    // Só o que ainda está no aparelho (original apagado por fora: só o vault).
    if (files.length && !blind()) {
      const st = await states(files.map((f) => ({ uri: f.src })));
      files = files.filter((_, i) => st[i] === 1);
    }
    let linked: number[] = [];
    if (files.length) {
      // Só do aparelho: a miniatura fica guardada para a Lixeira mostrar.
      await Promise.all(items.filter((m) => m.id < 0 && m.uri).map((m) => keepThumb(m.uri!, m.mime)));
      const done = await sysTrash(files);
      if (!done) return false;
      if (done.length) linked = await api.deviceTrashAdd(done);
    }
    const ids = [...new Set([...items.filter((m) => m.id > 0).map((m) => m.id), ...linked])];
    if (ids.length) await api.trash(ids);
    after();
    // Desfazer: as mídias do vault (inclusive as ligadas aos arquivos) e os itens só do aparelho.
    const all = [...ids, ...items.filter((m) => m.id < 0).map((m) => m.id)];
    notify({
      text: `${plural(items.length, "Item movido", "itens movidos")} para a lixeira`,
      tone: "neutral",
      action: { label: "Desfazer", run: () => void loadDevice().then(() => restoreItems(all)) },
    });
    suggestManage();
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/** Arquivos do aparelho (pasta do aparelho): os que têm cópia no vault vão para a lixeira dele junto. */
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

/** Restaurar (da Lixeira): vault e aparelho. */
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
    notify({ text: plural(n || ids.length, "Item restaurado", "itens restaurados"), tone: "success" });
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/** Apagar para sempre (da Lixeira): vault e aparelho. */
export async function purgeItems(ids: number[]): Promise<boolean> {
  try {
    const rows = rowsFor(ids);
    if (!(await sysDelete(rows.map(ref)))) return false;
    if (rows.length) await api.deviceTrashRemove(rows.map((r) => r.src));
    const vault = ids.filter((i) => i > 0);
    if (vault.length) await api.purge(vault);
    after();
    const n = vault.length + rows.filter((r) => r.media_id == null).length;
    notify({ text: `${plural(n || ids.length, "Item apagado", "itens apagados")} para sempre`, tone: "neutral" });
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/** Esvaziar a lixeira: o que está nela no vault e no aparelho (o que está fora de sincronia fica). */
export async function emptyAll(): Promise<boolean> {
  try {
    await loadDevice();
    const rows = useDevice.getState().rows.filter((r) => r.media_id == null || r.media_trashed);
    if (!(await sysDelete(rows.map(ref)))) return false;
    if (rows.length) await api.deviceTrashRemove(rows.map((r) => r.src));
    await api.emptyTrash();
    after();
    notify({ text: "Lixeira esvaziada", tone: "neutral" });
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/**
 * Liberar espaço: apaga do aparelho os originais que já estão no vault (ficam
 * na linha do tempo, vindos do vault). Android: de vez (uma confirmação);
 * desktop: lixeira do sistema.
 */
export async function freeSpace(links: Pick<DeviceLink, "src" | "size">[]): Promise<boolean> {
  if (!links.length) return false;
  try {
    if (!(await sysDelete(links.map((l) => ({ uri: l.src })), true))) return false;
    if (onAndroid) await api.localForget(links.map((l) => l.src));
    after();
    const bytes = links.reduce((a, l) => a + l.size, 0);
    notify({ text: `${plural(links.length, "1 item apagado", "itens apagados")} do aparelho · ${formatSize(bytes)} liberados`, tone: "success" });
    suggestManage();
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/** Resolver o que está fora de sincronia, de um lado ou do outro. */
export const outOfSync = {
  /** Na lixeira do vault, original no aparelho → original para a lixeira também. */
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
  /** … ou tirar da lixeira do vault. */
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
  /** Original na lixeira do aparelho, mídia fora da do vault → devolver o original. */
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
  /** … ou mandar a mídia do vault para a lixeira também. */
  async trashInVault(items: OutOfSync["deviceOnly"]) {
    try {
      // Lixeira feita por outro app: passa a constar no registro (restaurar devolve).
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
