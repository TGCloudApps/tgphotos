/**
 * Grade de escolha no TGPhotos (foto do vault; fotos para outro app): a linha do tempo do app
 * (mesma navegação, densidade, scrubber e geração de miniaturas), em três
 * seções:
 *
 * - Fotos: as do vault escolhido. O aberto vem do índice local (miniaturas
 *   geradas como na linha do tempo); outro vault, lido sem abrir (peek).
 * - Álbuns: os do vault; tocar abre as fotos do álbum.
 * - No aparelho (Android, com permissão de fotos): as pastas; tocar abre.
 *
 * O que conta como escolhido e o que tocar faz vêm do `PickCtx` (uma foto
 * para o vault; uma ou várias, fotos e/ou vídeos, para outro app).
 */
import { Tabs } from "@tgcloud/ui/ui/Tabs";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Folder, ImageOff, Images, Library } from "lucide-react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { srcOf } from "@tgcloud/ui/core/item";
import { thumbUrl } from "@tgcloud/ui/core/thumbs";
import { peekThumbUrl, type PeekItem, type PeekVault, type PhotoGridProps, type PhotoPick } from "@tgcloud/ui/core/vaultPhoto";
import { GridSkeleton, PeekGate, peekPick, usePeek } from "@tgcloud/ui/ui/VaultPhotoPicker";
import { api, type Media } from "../core/api";
import { deviceToken, deviceUrl } from "../core/local";
import { localId } from "../core/library";
import { Timeline } from "../timeline/Timeline";
import { DeviceThumb } from "./DeviceThumb";

type Tab = "photos" | "albums" | "device";

/** Uma coleção (álbum ou pasta) na lista. */
type Collection = { key: string; name: string; count: number; cover: React.ReactNode; open: () => Promise<Item[]> };
/**
 * Mídia na linha do tempo, com a escolha que ela vira. Chave: `v:<id>` (vault
 * aberto), `d:<uri>` (aparelho), `<vault>:<uid>` (outro vault).
 */
export type Item = { m: Media; pick: PhotoPick };

/** Como escolher: o que aceita, o que está escolhido e o toque. */
export type PickRules = { accept: (mime: string) => boolean; isPicked: (key: string) => boolean; onPick: (it: Item) => void };
export const PickCtx = createContext<PickRules>({ accept: () => true, isPicked: () => false, onPick: () => {} });

const blank = (id: number, name: string, mime: string, taken: number): Media => ({
  id,
  name,
  mime,
  size: 0,
  thumb: false,
  duration: null,
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
});

/** Mídia do vault aberto. */
const fromVault = (m: Media): Item => ({
  m,
  pick: {
    key: `v:${m.id}`,
    name: m.name,
    preview: m.thumb ? thumbUrl(m.id) : null,
    load: async () => (await fetch(srcOf(m), { cache: "no-store" })).blob(),
  },
});

/**
 * Foto de outro vault: ids próprios (positivos, só desta grade) e a capa
 * pronta (`cover`) — a linha do tempo não pede miniatura ao vault aberto.
 */
function fromPeek(vault: number, items: PeekItem[]): Item[] {
  return items.map((it, i) => ({
    m: { ...blank(i + 1, it.name, it.mime, it.date), thumb: true, cover: peekThumbUrl(vault, it.uid) },
    pick: peekPick(vault, it),
  }));
}

/** Foto do vault: uma foto, só imagens. */
export function PhotoPickerGrid({ touch, source, picked, onPick }: PhotoGridProps) {
  const rules = useMemo<PickRules>(() => ({ accept: (m) => m.startsWith("image/"), isPicked: (k) => k === picked, onPick: (it) => onPick(it.pick) }), [picked, onPick]);
  return (
    <PickCtx.Provider value={rules}>
      <PickerBody touch={touch} source={source} />
    </PickCtx.Provider>
  );
}

/** Seções (Fotos, Álbuns, No aparelho) e a grade de cada uma. */
export function PickerBody({ touch, source }: { touch: boolean; source: PhotoGridProps["source"] }) {
  const [tab, setTab] = useState<Tab>("photos");
  const deviceOk = useMemo(() => {
    if (!onAndroid || !android.hasMedia()) return false;
    const a = android.mediaAccess();
    return a.full || a.partial;
  }, []);
  // O vault aberto vem do índice local; os outros, lidos sem abrir.
  const peek = usePeek(source, !source.current);

  const tabs: [Tab, string, typeof Images][] = [
    ["photos", "Fotos", Images],
    ["albums", "Álbuns", Library],
    ...(deviceOk ? ([["device", "No aparelho", Folder]] as [Tab, string, typeof Images][]) : []),
  ];

  const body = (data: PeekVault | null) =>
    tab === "photos" ? (
      source.current ? (
        <CurrentPhotos touch={touch} />
      ) : (
        <Grid touch={touch} items={fromPeek(source.id, data!.items)} empty={`Nenhuma foto em “${source.name}”`} />
      )
    ) : tab === "albums" ? (
      <Collections key="albums" touch={touch} load={() => (source.current ? currentAlbums() : Promise.resolve(peekAlbums(source.id, data!)))} empty="Nenhum álbum neste vault" />
    ) : (
      <Collections key="device" touch={touch} load={deviceFolders} empty="Nenhuma pasta com fotos no aparelho" />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Seções: o seletor segmentado do app. */}
      <div className={`flex shrink-0 py-2.5 ${touch ? "px-3" : "px-5"}`}>
        <Tabs touch={touch} value={tab} onChange={setTab} tabs={tabs.map(([t, label, Icon]) => ({ key: t, label, icon: <Icon /> }))} />
      </div>
      {/* Pastas do aparelho não dependem do vault (nem da senha dele). */}
      {tab === "device" || source.current ? (
        body(null)
      ) : (
        <PeekGate touch={touch} source={source} peek={peek}>
          {(data) => body(data)}
        </PeekGate>
      )}
    </div>
  );
}

/** Fotos do vault aberto (índice local). */
function CurrentPhotos({ touch }: { touch: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    let alive = true;
    void api.list("timeline").then((list) => alive && setItems(list.map(fromVault)));
    return () => {
      alive = false;
    };
  }, []);
  if (!items) return <GridSkeleton touch={touch} label="Lendo as fotos…" />;
  return <Grid touch={touch} items={items} empty="Nenhuma foto neste vault" />;
}

/** A linha do tempo do app em modo escolha. */
function Grid({ touch, items: all, empty, grouped = true }: { touch: boolean; items: Item[]; empty: string; grouped?: boolean }) {
  const { accept, isPicked, onPick } = useContext(PickCtx);
  const items = useMemo(() => all.filter((x) => accept(x.m.mime)), [all, accept]);
  const byId = useMemo(() => new Map(items.map((x) => [x.m.id, x])), [items]);
  const media = useMemo(() => items.map((x) => x.m), [items]);
  const pickedIds = useMemo(() => new Set(items.filter((x) => isPicked(x.pick.key)).map((x) => x.m.id)), [items, isPicked]);
  if (!items.length)
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <ImageOff size={36} className="mx-auto text-fg-3" strokeWidth={1.5} />
          <p className="mt-3 text-[15px] font-semibold">{empty}</p>
          <p className="mt-1 text-[13px] text-fg-2">Escolha outra fonte ou a galeria.</p>
        </div>
      </div>
    );
  return (
    <Timeline
      items={media}
      touch={touch}
      grouped={grouped}
      bottom={24}
      picked={pickedIds}
      onOpenItem={(m) => {
        const it = byId.get(m.id);
        if (it) onPick(it);
      }}
    />
  );
}

// ---- álbuns e pastas -------------------------------------------------------------------

async function currentAlbums(): Promise<Collection[]> {
  const albums = await api.albums();
  return albums
    .filter((a) => a.count > 0)
    .map((a) => ({
      key: `a:${a.id}`,
      name: a.name,
      count: a.count,
      cover: a.cover ? <img src={thumbUrl(a.cover)} alt="" loading="lazy" draggable={false} className="size-full object-cover" /> : null,
      open: async () => (await api.albumMedia(a.id)).map(fromVault),
    }));
}

function peekAlbums(vault: number, data: PeekVault): Collection[] {
  const byUid = new Map(data.items.map((it) => [it.uid, it]));
  return data.albums.map((a) => {
    const items = a.items.map((u) => byUid.get(u)).filter((x): x is PeekItem => !!x);
    const first = items.find((x) => x.thumb);
    return {
      key: `p:${a.uid}`,
      name: a.name,
      count: items.length,
      cover: first ? <img src={peekThumbUrl(vault, first.uid)} alt="" loading="lazy" draggable={false} className="size-full object-cover" /> : null,
      open: async () => fromPeek(vault, items),
    };
  });
}

async function deviceFolders(): Promise<Collection[]> {
  const t = await deviceToken();
  return android.mediaFolders().map((f) => ({
    key: `d:${f.path}`,
    name: f.name,
    count: f.count,
    cover: f.cover ? <DeviceThumb uri={f.cover} size={320} className="size-full object-cover" /> : null,
    open: async () =>
      android
        .mediaScan([f.path])
        .sort((a, b) => (b.taken || b.modified * 1000) - (a.taken || a.modified * 1000))
        .map((d) => {
          const src = deviceUrl(t, d.uri, d.mime, d.size);
          // Já no aparelho: sem selo de backup (pending 2) na escolha.
          const m: Media = { ...blank(localId(d.uri), d.name, d.mime, (d.taken || d.modified * 1000) / 1000), size: d.size, src, uri: d.uri, pending: 2 };
          return {
            m,
            pick: {
              key: `d:${d.uri}`,
              name: d.name,
              preview: android.deviceThumbNow(d.uri) || null,
              load: async () => (await fetch(src, { cache: "no-store" })).blob(),
            },
          };
        }),
  }));
}

/** Lista de álbuns/pastas (capa, nome, quantidade); tocar abre as fotos. */
function Collections({ touch, load, empty }: { touch: boolean; load: () => Promise<Collection[]>; empty: string }) {
  const [list, setList] = useState<Collection[] | null>(null);
  const [open, setOpen] = useState<{ c: Collection; items: Item[] | null } | null>(null);
  // Uma leitura por montagem (cada seção tem a sua, por `key`).
  useEffect(() => {
    let alive = true;
    void load().then((l) => alive && setList(l));
    return () => {
      alive = false;
    };
  }, []);

  if (open)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button type="button" onClick={() => setOpen(null)} className={`flex shrink-0 items-center gap-2 text-left font-semibold hover:bg-s2 ${touch ? "h-12 px-3 text-[15px]" : "h-10 px-5 text-[14px]"}`}>
          <ArrowLeft size={18} className="text-fg-2" />
          <span className="truncate">{open.c.name}</span>
          <span className="text-[12px] font-medium text-fg-3 tabular">{open.c.count.toLocaleString("pt-BR")}</span>
        </button>
        {open.items ? <Grid touch={touch} items={open.items} empty="Nenhuma foto aqui" /> : <GridSkeleton touch={touch} label="Abrindo…" />}
      </div>
    );

  if (!list) return <GridSkeleton touch={touch} label="Lendo…" />;
  if (!list.length)
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <Library size={36} className="mx-auto text-fg-3" strokeWidth={1.5} />
          <p className="mt-3 text-[15px] font-semibold">{empty}</p>
        </div>
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-6">
      <div className={`grid gap-x-3 gap-y-4 ${touch ? "grid-cols-2 px-3" : "grid-cols-[repeat(auto-fill,minmax(160px,1fr))] px-5"}`}>
        {list.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => {
              setOpen({ c, items: null });
              void c.open().then((items) => setOpen((cur) => (cur?.c.key === c.key ? { c, items } : cur)));
            }}
            className="group text-left"
          >
            <div className="surface aspect-square overflow-hidden rounded-xl bg-s2 transition-transform group-active:scale-[0.98]">
              {c.cover ?? (
                <span className="grid size-full place-items-center text-fg-3">
                  <Images size={28} />
                </span>
              )}
            </div>
            <p className="mt-2 truncate text-[14px] font-semibold">{c.name}</p>
            <p className="text-[12px] text-fg-3 tabular">{c.count.toLocaleString("pt-BR")} {c.count === 1 ? "item" : "itens"}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
