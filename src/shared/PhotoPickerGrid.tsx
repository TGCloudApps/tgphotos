/**
 * Grade da escolha da foto do vault no TGPhotos: a linha do tempo do app
 * (mesma navegação, densidade, scrubber e geração de miniaturas), em três
 * seções:
 *
 * - Fotos: as do vault escolhido. O aberto vem do índice local (miniaturas
 *   geradas como na linha do tempo); outro vault, lido sem abrir (peek).
 * - Álbuns: os do vault; tocar abre as fotos do álbum.
 * - No aparelho (Android, com permissão de fotos): as pastas; tocar abre.
 */
import { useEffect, useMemo, useState } from "react";
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
/** Mídia na linha do tempo, com a escolha que ela vira. */
type Item = { m: Media; pick: PhotoPick };

const isImage = (m: { mime: string }) => m.mime.startsWith("image/");

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

export function PhotoPickerGrid({ touch, source, picked, onPick }: PhotoGridProps) {
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
        <CurrentPhotos touch={touch} picked={picked} onPick={onPick} />
      ) : (
        <Grid touch={touch} items={fromPeek(source.id, data!.items)} picked={picked} onPick={onPick} empty={`Nenhuma foto em “${source.name}”`} />
      )
    ) : tab === "albums" ? (
      <Collections key="albums" touch={touch} picked={picked} onPick={onPick} load={() => (source.current ? currentAlbums() : Promise.resolve(peekAlbums(source.id, data!)))} empty="Nenhum álbum neste vault" />
    ) : (
      <Collections key="device" touch={touch} picked={picked} onPick={onPick} load={deviceFolders} empty="Nenhuma pasta com fotos no aparelho" />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Seções: o seletor segmentado do app. */}
      <div className={`flex shrink-0 py-2.5 ${touch ? "px-3" : "px-5"}`}>
        <div className="surface flex rounded-lg bg-s1 p-0.5" role="tablist">
          {tabs.map(([t, label, Icon]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex items-center gap-1.5 rounded-md px-3 font-semibold transition-colors ${touch ? "h-9 text-[14px]" : "h-8 text-[13px]"} ${tab === t ? "bg-s4 text-fg" : "text-fg-2 hover:text-fg"}`}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
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
function CurrentPhotos({ touch, picked, onPick }: { touch: boolean; picked: string | null; onPick: (p: PhotoPick) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    let alive = true;
    void api.list("timeline").then((list) => alive && setItems(list.filter(isImage).map(fromVault)));
    return () => {
      alive = false;
    };
  }, []);
  if (!items) return <GridSkeleton touch={touch} label="Lendo as fotos…" />;
  return <Grid touch={touch} items={items} picked={picked} onPick={onPick} empty="Nenhuma foto neste vault" />;
}

/** A linha do tempo do app em modo escolha. */
function Grid({ touch, items, picked, onPick, empty, grouped = true }: { touch: boolean; items: Item[]; picked: string | null; onPick: (p: PhotoPick) => void; empty: string; grouped?: boolean }) {
  const byId = useMemo(() => new Map(items.map((x) => [x.m.id, x])), [items]);
  const media = useMemo(() => items.map((x) => x.m), [items]);
  const pickedId = useMemo(() => items.find((x) => x.pick.key === picked)?.m.id ?? null, [items, picked]);
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
      picked={pickedId}
      onOpenItem={(m) => {
        const it = byId.get(m.id);
        if (it) onPick(it.pick);
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
      open: async () => (await api.albumMedia(a.id)).filter(isImage).map(fromVault),
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
        .filter(isImage)
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
function Collections({ touch, picked, onPick, load, empty }: { touch: boolean; picked: string | null; onPick: (p: PhotoPick) => void; load: () => Promise<Collection[]>; empty: string }) {
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
        {open.items ? <Grid touch={touch} items={open.items} picked={picked} onPick={onPick} empty="Nenhuma foto aqui" /> : <GridSkeleton touch={touch} label="Abrindo…" />}
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
