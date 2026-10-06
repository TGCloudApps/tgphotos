/**
 * Pastas do aparelho (Android, MediaStore), como no Google Fotos: todas
 * aparecem em Coleções, com ou sem backup. Dentro de uma pasta: as mídias do
 * aparelho, a marca do que ainda não está no vault, o backup da pasta
 * (liga/desliga) e o backup de itens escolhidos à mão.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { Calendar, Check, Clock, CloudOff, CloudUpload, ExternalLink, FolderInput, FolderOpen, Image as ImageIcon, Images, Info, Pencil, Play, Share2, TextCursorInput, Trash2, X } from "lucide-react";
import { formatSize } from "@tgcloud/ui/core/format";
import { haptic } from "@tgcloud/ui/core/platform";
import { Lightbox, type LightboxMenuItem } from "@tgcloud/ui/media/Lightbox";
import type { MediaItem } from "@tgcloud/ui/core/item";
import { android, type DeviceFolder, type DeviceMedia, type MediaAccess } from "@tgcloud/ui/core/android";
import { formatDuration } from "@tgcloud/ui/core/format";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { confirmBig, useTransfers } from "@tgcloud/ui/core/transfers";
import { api } from "../core/api";
import { loadFolders, setFolder, setShown, useBackup } from "../core/backup";
import { nav, useLayers, type Layer } from "../core/nav";
import { Switch } from "../shared/Switch";
import { DeviceThumb } from "../shared/DeviceThumb";
import { deviceToken, deviceUrl } from "../core/local";
import { openLocal } from "../core/localActions";
import { trashFiles } from "../core/deviceTrash";
import { refresh } from "../core/data";
import { localId, setFolderFinder } from "../core/library";
import { Timeline } from "../timeline/Timeline";
import type { Media } from "../core/api";

/** Pastas do aparelho (lidas ao abrir Coleções; a listagem é rápida). */
export const useDevice = create<{ access: MediaAccess | null; folders: DeviceFolder[] }>(() => ({ access: null, folders: [] }));

export function loadDevice() {
  const access = android.mediaAccess();
  useDevice.setState({ access, folders: access.full || access.partial ? android.mediaFolders() : [] });
  void loadFolders();
}

// ---- seção em Coleções -------------------------------------------------------------------

export function DeviceFolders() {
  const { access, folders } = useDevice();
  const on = useBackup((s) => s.folders);
  useEffect(loadDevice, []);
  if (!access) return null;

  return (
    <>
      <div className="mt-6 mb-3 flex items-center justify-between">
        <h2 className="pl-1 text-[17px] font-semibold">No dispositivo</h2>
      </div>
      {!access.full && !access.partial ? (
        <button
          onClick={async () => {
            await android.requestMedia();
            loadDevice();
          }}
          className="surface flex w-full items-center gap-3 rounded-xl bg-s1 px-4 py-3.5 text-left active:bg-s3"
        >
          <Images size={22} className="shrink-0 text-brand" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">Mostrar as pastas do aparelho</span>
            <span className="block text-[13px] text-fg-2">Permita o acesso às fotos para ver e fazer backup delas.</span>
          </span>
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-x-2.5 gap-y-3.5">
          {folders.map((f) => {
            const backed = on.includes(f.path);
            return (
              <button key={f.path} onClick={() => nav.device(f.path)} className="min-w-0 text-left">
                <div className="surface relative aspect-square overflow-hidden rounded-xl bg-s2">
                  {f.cover && <DeviceThumb uri={f.cover} size={240} />}
                  {!backed && (
                    <span className="absolute right-1.5 bottom-1.5 grid size-6 place-items-center rounded-full bg-black/55">
                      <CloudOff size={14} className="text-white" />
                    </span>
                  )}
                </div>
                <p className="mt-1.5 truncate text-[14px] font-semibold">{f.name}</p>
                <p className="truncate text-[12px] text-fg-3 tabular">{f.count.toLocaleString("pt-BR")}</p>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---- visualizador de mídias do aparelho ---------------------------------------------------

/** Mídia do aparelho no formato do lightbox (id negativo: nunca colide com o vault). */
export type DeviceItem = MediaItem & { uri: string; taken: number; path: string; raw: DeviceMedia };


/** Itens da pasta aberta (o visualizador acha por id). */
export const useDeviceItems = create<{ list: DeviceItem[]; status: Map<string, number> }>(() => ({ list: [], status: new Map() }));
/** Pelo id da grade (o mesmo da galeria local: o _ID do MediaStore). */
export const findDevice = (id: number) => useDeviceItems.getState().list.find((m) => m.id === id);

/** Item da pasta como mídia da galeria (seleção, lixeira e backup acham por id). */
function deviceMedia(m: DeviceItem): Media {
  const status = useDeviceItems.getState().status.get(m.uri) ?? 0;
  return {
    ...(m as unknown as Media),
    taken_at: m.taken / 1000,
    added_at: m.taken / 1000,
    tz: null,
    width: null,
    height: null,
    favorite: false,
    archived: false,
    trashed_at: null,
    lat: null,
    lon: null,
    local: null,
    pending: status,
  };
}
setFolderFinder((id) => {
  const d = findDevice(id);
  return d ? deviceMedia(d) : undefined;
});

function toItems(list: DeviceMedia[], t: string): DeviceItem[] {
  return list.map((m) => ({
    id: localId(m.uri),
    name: m.name,
    mime: m.mime,
    size: m.size,
    thumb: false,
    duration: m.duration ? m.duration / 1000 : null,
    src: deviceUrl(t, m.uri, m.mime, m.size),
    uri: m.uri,
    taken: m.taken || m.modified * 1000,
    path: m.path,
    raw: m,
  }));
}

/** "Excluir do vault": a mídia vai para a lixeira do vault; o arquivo fica (e sai do backup automático). */
async function excludeFromVault(uri: string) {
  try {
    await api.excludeFromVault([uri]);
    useDeviceItems.setState((s) => ({ status: new Map([...s.status, [uri, 0]]) }));
    void refresh();
    notify({ text: "Excluído do vault. O arquivo continua no aparelho.", tone: "neutral" });
  } catch (e) {
    notifyError(e);
  }
}

async function backupItems(list: DeviceMedia[]) {
  if (!(await confirmBig(list.length))) return;
  try {
    const r = await api.backupEnqueue(list, true);
    notify({ text: `${r.queued} ${r.queued === 1 ? "item" : "itens"} na fila de envio`, tone: "info", action: { label: "Ver", run: () => nav.dest("transfers") } });
    useDeviceItems.setState((s) => ({ status: new Map([...s.status, ...list.map((i) => [i.uri, Math.max(s.status.get(i.uri) ?? 0, 1)] as [string, number])]) }));
  } catch (e) {
    notifyError(e);
  }
}

export function DeviceViewer({ layer }: { layer: Extract<Layer, { type: "device-viewer" }> }) {
  const layers = useLayers();
  const top = layers[layers.length - 1]?.type;
  const status = useDeviceItems((s) => s.status);
  return (
    <Lightbox<DeviceItem>
      id={layer.id}
      siblings={layer.siblings}
      find={findDevice}
      touch
      active={top === "device-viewer"}
      onGo={(id, siblings) => nav.replaceTop({ type: "device-viewer", id, siblings })}
      onClose={nav.close}
      infoTouch={top === "details"}
      openInfoTouch={() => nav.open({ type: "details", id: layer.id })}
      menuTouch={top === "viewer-menu"}
      openMenuTouch={() => nav.open({ type: "viewer-menu" })}
      onSave={() => {}}
      subtitle={(m) => {
        const d = new Date(m.taken);
        const s = status.get(m.uri) ?? 0;
        return `${d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" }).replace(/\./g, "")} · ${s === 2 ? "no vault" : s === 1 ? "na fila" : "sem backup"}`;
      }}
      actions={() => null}
      heading={(m) => {
        const d = new Date(m.taken);
        const s = status.get(m.uri) ?? 0;
        return {
          title: d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).replace(/ de /g, " "),
          subtitle: `${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · ${s === 2 ? "no vault" : s === 1 ? "na fila" : "sem backup"}`,
        };
      }}
      quick={(m): LightboxMenuItem[] => [
        { label: "Compartilhar", icon: <Share2 />, run: () => void android.shareUri(m.uri, m.mime) },
        // Só sem backup nenhum (na fila, enviando ou já no vault: o título diz).
        ...((status.get(m.uri) ?? 0) !== 0 ? [] : [{ label: "Backup", icon: <CloudUpload />, run: () => void backupItems([m.raw]) }]),
        { label: "Lixeira", icon: <Trash2 />, run: () => void trashFiles([{ uri: m.uri, name: m.name, mime: m.mime, size: m.size, taken: m.taken }]).then((ok) => ok && nav.close()) },
        { label: "Info", icon: <Info />, run: () => nav.open({ type: "details", id: m.id }) },
      ]}
      menu={(m): LightboxMenuItem[] => [
        // No vault: dá para tirar de lá e manter o arquivo aqui.
        ...((status.get(m.uri) ?? 0) === 2 ? [{ label: "Excluir do vault", hint: "fica no aparelho", icon: <CloudOff />, run: () => void excludeFromVault(m.uri) }] : []),
        { label: "Abrir com…", icon: <ExternalLink />, run: () => openLocal(m, "view") },
        { label: "Editar em outro app…", icon: <Pencil />, run: () => openLocal(m, "edit") },
        ...(m.mime.startsWith("image/") ? [{ label: "Definir como…", icon: <ImageIcon />, run: () => openLocal(m, "attach") }] : []),
        ...(android.canManage()
          ? [
              { label: "Mover para pasta…", icon: <FolderInput />, run: () => nav.open({ type: "device-move", uris: [m.uri] }) },
              { label: "Renomear…", icon: <TextCursorInput />, run: () => nav.open({ type: "device-rename", uri: m.uri, name: m.name }) },
            ]
          : []),
      ]}
      info={(m) => <DeviceInfo item={m} />}
    />
  );
}

function DeviceInfo({ item }: { item: DeviceItem }) {
  const d = new Date(item.taken);
  const rows: [React.ReactNode, string, string][] = [
    [<Calendar key="c" />, d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }), d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })],
    [<ImageIcon key="i" />, item.name, [formatSize(item.size), item.duration ? formatDuration(item.duration) : ""].filter(Boolean).join(" · ")],
    [<FolderOpen key="f" />, "No aparelho", item.path || "raiz"],
  ];
  return (
    <div>
      {rows.map(([icon, title, sub]) => (
        <div key={title} className="flex gap-3.5 py-2.5">
          <span className="mt-0.5 shrink-0 text-fg-3 [&>svg]:size-5">{icon}</span>
          <div className="min-w-0">
            <p className="font-medium break-all text-fg">{title}</p>
            <p className="mt-0.5 text-fg-2 tabular">{sub}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- pasta do aparelho ------------------------------------------------------------------------

/** Estado da tela (a app bar lê daqui). */
export const useDeviceFolder = create<{ count: number; missing: number }>(() => ({ count: 0, missing: 0 }));

export function DeviceFolderBar({ path }: { path: string }) {
  const { count, missing } = useDeviceFolder();
  const name = path.split("/").pop() || "Raiz";
  return (
    <>
      <div className="min-w-0 flex-1 px-1">
        <p className="truncate text-[18px] leading-6 font-semibold">{name}</p>
        <p className="truncate text-[12px] text-fg-3 tabular">
          {count.toLocaleString("pt-BR")} {count === 1 ? "item" : "itens"}
          {missing > 0 && ` · ${missing.toLocaleString("pt-BR")} sem backup`}
        </p>
      </div>
    </>
  );
}

const COLS = 4;
const GAP = 2;
const OVERSCAN = 600;

export function DeviceFolderScreen({ path }: { path: string }) {
  const [items, setItems] = useState<DeviceMedia[] | null>(null);
  const status = useDeviceItems((s) => s.status);
  const setStatus = (m: Map<string, number>) => useDeviceItems.setState({ status: m });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(0);
  const [view, setView] = useState({ top: 0, height: 800 });
  const scroller = useRef<HTMLDivElement>(null);
  const transfers = useTransfers((s) => s.list);

  const [rev, setRev] = useState(0);
  useEffect(() => {
    // Excluiu/moveu/renomeou (aqui ou no visualizador), ou o sistema avisou: relê a pasta.
    const again = () => setRev((n) => n + 1);
    window.addEventListener("tg-local-changed", again);
    window.addEventListener("tg-media-changed", again);
    return () => {
      window.removeEventListener("tg-local-changed", again);
      window.removeEventListener("tg-media-changed", again);
    };
  }, []);
  useEffect(() => {
    // Listagem síncrona na ponte: deixa a tela pintar antes.
    const t = setTimeout(() => {
      const list = android.mediaScan([path]);
      list.sort((a, b) => (b.taken || b.modified * 1000) - (a.taken || a.modified * 1000));
      setItems(list);
      setPicked((cur) => new Set([...cur].filter((u) => list.some((i) => i.uri === u))));
      void deviceToken().then((t) => useDeviceItems.setState({ list: toItems(list, t) }));
    }, 0);
    return () => clearTimeout(t);
  }, [path, rev]);

  // Situação de cada item (relê quando a fila de envios muda).
  useEffect(() => {
    if (!items?.length) return;
    const t = setTimeout(() => {
      api
        .backupStatus(items.map((i) => i.uri))
        .then((s) => setStatus(new Map(items.map((i, k) => [i.uri, s[k]]))))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [items, transfers]);

  const missing = useMemo(() => (items ?? []).filter((i) => !status.get(i.uri)).length, [items, status]);
  useEffect(() => useDeviceFolder.setState({ count: items?.length ?? 0, missing }), [items, missing]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setView({ top: el.scrollTop, height: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const backup = async (list: DeviceMedia[]) => {
    setPicked(new Set());
    await backupItems(list);
  };
  const press = useRef<number | null>(null);
  const pressAt = useRef<[number, number]>([0, 0]);
  const swallow = useRef(false);
  const open = (i: number) => {
    const ids = (items ?? []).map((m) => localId(m.uri));
    nav.open({ type: "device-viewer", id: ids[i], siblings: ids });
  };

  const size = width > 0 ? (width - GAP * (COLS - 1)) / COLS : 0;
  const rows = items ? Math.ceil(items.length / COLS) : 0;
  const first = size ? Math.max(0, Math.floor((view.top - OVERSCAN) / (size + GAP))) : 0;
  const last = size ? Math.min(rows, Math.ceil((view.top + view.height + OVERSCAN) / (size + GAP))) : 0;
  const toggle = (uri: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });

  // Grade simples ou linha do tempo (como Fotos), escolha lembrada.
  const [asTimeline, setAsTimeline] = useState(() => {
    try {
      return localStorage.getItem("device-view") === "timeline";
    } catch {
      return false;
    }
  });
  const switchView = (on: boolean) => {
    setAsTimeline(on);
    try {
      localStorage.setItem("device-view", on ? "timeline" : "grid");
    } catch {
      /* só nesta visita */
    }
  };
  const media = useDeviceItems((s) => s.list);
  const asMedia = useMemo(() => media.map(deviceMedia), [media, status]);

  const backupOn = useBackup((s) => s.folders.includes(path));
  const shownOn = useBackup((s) => s.shown.includes(path));
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* O que esta pasta faz neste vault. */}
      <div className="surface mx-3 mt-1 mb-2 overflow-hidden rounded-xl bg-s1">
        <button onClick={() => void setFolder(path, !backupOn)} className="flex min-h-14 w-full items-center gap-3 px-4 text-left active:bg-s3" aria-pressed={backupOn}>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium">Backup automático</span>
            <span className="block text-[12px] text-fg-3">Fotos e vídeos novos sobem sozinhos para este vault.</span>
          </span>
          <Switch on={backupOn} touch />
        </button>
        <div className="mx-4 h-px bg-hairline" />
        <button
          disabled={backupOn}
          onClick={() => void setShown(path, !shownOn)}
          className="flex min-h-14 w-full items-center gap-3 px-4 text-left active:bg-s3 disabled:active:bg-transparent"
          aria-pressed={backupOn || shownOn}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium">Mostrar em Fotos</span>
            <span className="block text-[12px] text-fg-3">{backupOn ? "Com backup, a pasta já aparece em Fotos." : "Aparece na linha do tempo mesmo sem backup."}</span>
          </span>
          <span className={backupOn ? "opacity-50" : undefined}>
            <Switch on={backupOn || shownOn} touch />
          </span>
        </button>
      </div>
      <div className="mx-3 mb-2 flex justify-end">
        <div className="surface flex rounded-lg bg-s1 p-0.5" role="tablist">
          {(
            [
              [false, "Grade"],
              [true, "Linha do tempo"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={label}
              role="tab"
              aria-selected={asTimeline === v}
              onClick={() => switchView(v)}
              className={`h-8 rounded-md px-3 text-[13px] font-semibold ${asTimeline === v ? "bg-s4 text-fg" : "text-fg-2"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {asTimeline ? (
        items === null ? (
          <p className="px-5 py-6 text-[14px] text-fg-3">Lendo a pasta…</p>
        ) : items.length === 0 ? (
          <p className="px-5 py-6 text-[14px] text-fg-3">Nenhuma foto ou vídeo nesta pasta.</p>
        ) : (
          <Timeline items={asMedia} touch bottom={96} onOpenItem={(m, siblings) => nav.open({ type: "device-viewer", id: m.id, siblings })} />
        )
      ) : (
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(e) => {
          // Rolando não é toque longo (o Android para de mandar touchmove ao rolar).
          if (press.current) clearTimeout(press.current);
          press.current = null;
          setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight });
        }}
      >
        {items === null && <p className="px-5 py-6 text-[14px] text-fg-3">Lendo a pasta…</p>}
        {items?.length === 0 && <p className="px-5 py-6 text-[14px] text-fg-3">Nenhuma foto ou vídeo nesta pasta.</p>}
        {/* Com a barra de ação aberta, o fim da grade não fica embaixo dela. */}
        <div className="relative" style={{ height: rows * (size + GAP) + (picked.size ? 80 : 0) }}>
          {size > 0 &&
            items?.slice(first * COLS, last * COLS).map((m, k) => {
              const i = first * COLS + k;
              const s = status.get(m.uri) ?? 0;
              const on = picked.has(m.uri);
              return (
                <button
                  key={m.uri}
                  data-media-id={localId(m.uri)}
                  onClick={() => {
                    if (swallow.current) return void (swallow.current = false);
                    if (picked.size) toggle(m.uri);
                    else open(i);
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  onTouchStart={(e) => {
                    swallow.current = false;
                    if (press.current) clearTimeout(press.current);
                    if (e.touches.length > 1) return;
                    pressAt.current = [e.touches[0].clientX, e.touches[0].clientY];
                    press.current = window.setTimeout(() => {
                      press.current = null;
                      swallow.current = true;
                      haptic();
                      toggle(m.uri);
                    }, 450);
                  }}
                  onTouchMove={(e) => {
                    const [x, y] = pressAt.current;
                    if (!press.current || Math.hypot(e.touches[0].clientX - x, e.touches[0].clientY - y) < 10) return;
                    clearTimeout(press.current);
                    press.current = null;
                  }}
                  onTouchEnd={() => {
                    if (press.current) clearTimeout(press.current);
                    press.current = null;
                  }}
                  className="absolute overflow-hidden bg-s2"
                  style={{ top: Math.floor(i / COLS) * (size + GAP), left: (i % COLS) * (size + GAP), width: size, height: size }}
                >
                  <div className="size-full transition-transform duration-150" style={{ transform: on ? "scale(0.86)" : undefined, borderRadius: on ? 8 : 0, overflow: "hidden" }}>
                    <DeviceThumb uri={m.uri} />
                  </div>
                  {m.mime.startsWith("video/") && (
                    <span className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular">
                      {m.duration ? formatDuration(m.duration / 1000) : null}
                      <Play size={10} className="fill-white" />
                    </span>
                  )}
                  {s !== 2 && !on && (
                    <span className="absolute right-1.5 bottom-1.5 grid size-6 place-items-center rounded-full bg-black/55" title={s === 1 ? "Na fila" : "Sem backup"}>
                      {s === 1 ? <Clock size={13} className="text-white" /> : <CloudOff size={13} className="text-white" />}
                    </span>
                  )}
                  {(on || picked.size > 0) && (
                    <span className={`absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full border-2 ${on ? "border-brand bg-brand text-white" : "border-white/90 bg-black/25 text-transparent"}`}>
                      <Check size={14} strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </div>
      )}

      {/* Backup dos itens escolhidos. */}
      {picked.size > 0 && (
        <div className="floating absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-2xl bg-s3 p-2">
          <button onClick={() => setPicked(new Set())} className="grid size-11 shrink-0 place-items-center rounded-xl text-fg-2 active:bg-s4" aria-label="Cancelar seleção">
            <X size={20} />
          </button>
          {android.canManage() && (
            <button onClick={() => nav.open({ type: "device-move", uris: [...picked] })} className="grid size-11 shrink-0 place-items-center rounded-xl text-fg active:bg-s4" aria-label="Mover para pasta">
              <FolderInput size={20} />
            </button>
          )}
          <button
            onClick={() =>
              void trashFiles((items ?? []).filter((i) => picked.has(i.uri)).map((i) => ({ ...i, taken: i.taken || i.modified * 1000 }))).then((ok) => ok && setPicked(new Set()))
            }
            className="grid size-11 shrink-0 place-items-center rounded-xl text-fg active:bg-s4"
            aria-label="Mover para a lixeira"
          >
            <Trash2 size={20} />
          </button>
          <button
            onClick={() => void backup((items ?? []).filter((i) => picked.has(i.uri)))}
            className="step h-11 flex-1 rounded-xl bg-brand text-[15px] font-semibold text-white active:translate-y-0.5"
          >
            Fazer backup de {picked.size}
          </button>
        </div>
      )}
    </div>
  );
}
