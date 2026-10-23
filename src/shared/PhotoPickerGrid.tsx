/**
 * Picker grid in TGPhotos (vault photo; photos for another app): the app timeline
 * (same navigation, density, scrubber and thumbnail generation), in three
 * sections:
 *
 * - Photos: those of the chosen vault. The open one comes from the local index
 *   (thumbnails generated as in the timeline); another vault, read without opening (peek).
 * - Albums: those of the vault; tapping opens the album photos.
 * - On device (Android, with photo permission): the folders; tapping opens.
 *
 * What counts as picked and what tapping does come from `PickCtx` (one photo
 * for the vault; one or several, photos and/or videos, for another app).
 */
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
import { fmtNumber } from "@tgcloud/ui/i18n";
import { t, tc } from "../i18n";

type Tab = "photos" | "albums" | "device";

/** A collection (album or folder) in the list. */
type Collection = { key: string; name: string; count: number; cover: React.ReactNode; open: () => Promise<Item[]> };
/**
 * Media in the timeline, with the pick it becomes. Key: `v:<id>` (open vault),
 * `d:<uri>` (device), `<vault>:<uid>` (another vault).
 */
export type Item = { m: Media; pick: PhotoPick };

/** How to pick: what it accepts, what is picked and the tap. */
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

/** Media of the open vault. */
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
 * Photo from another vault: its own ids (positive, this grid only) and the
 * ready cover (`cover`) — the timeline does not ask the open vault for a thumbnail.
 */
function fromPeek(vault: number, items: PeekItem[]): Item[] {
  return items.map((it, i) => ({
    m: { ...blank(i + 1, it.name, it.mime, it.date), thumb: true, cover: peekThumbUrl(vault, it.uid) },
    pick: peekPick(vault, it),
  }));
}

/** Vault photo: a single photo, images only. */
export function PhotoPickerGrid({ touch, source, picked, onPick }: PhotoGridProps) {
  const rules = useMemo<PickRules>(() => ({ accept: (m) => m.startsWith("image/"), isPicked: (k) => k === picked, onPick: (it) => onPick(it.pick) }), [picked, onPick]);
  return (
    <PickCtx.Provider value={rules}>
      <PickerBody touch={touch} source={source} />
    </PickCtx.Provider>
  );
}

/** Sections (Photos, Albums, On device) and each one's grid. */
export function PickerBody({ touch, source }: { touch: boolean; source: PhotoGridProps["source"] }) {
  const [tab, setTab] = useState<Tab>("photos");
  const deviceOk = useMemo(() => {
    if (!onAndroid || !android.hasMedia()) return false;
    const a = android.mediaAccess();
    return a.full || a.partial;
  }, []);
  // The open vault comes from the local index; the others, read without opening.
  const peek = usePeek(source, !source.current);

  const tabs: [Tab, string, typeof Images][] = [
    ["photos", t("picker.photos"), Images],
    ["albums", t("picker.albums"), Library],
    ...(deviceOk ? ([["device", t("picker.device"), Folder]] as [Tab, string, typeof Images][]) : []),
  ];

  const body = (data: PeekVault | null) =>
    tab === "photos" ? (
      source.current ? (
        <CurrentPhotos touch={touch} />
      ) : (
        <Grid touch={touch} items={fromPeek(source.id, data!.items)} empty={t("picker.noPhotosIn", { name: source.name })} />
      )
    ) : tab === "albums" ? (
      <Collections key="albums" touch={touch} load={() => (source.current ? currentAlbums() : Promise.resolve(peekAlbums(source.id, data!)))} empty={t("picker.noAlbums")} />
    ) : (
      <Collections key="device" touch={touch} load={deviceFolders} empty={t("picker.noFolders")} />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sections: the app segmented selector. */}
      <div className={`flex shrink-0 py-2.5 ${touch ? "px-3" : "px-5"}`}>
        <div className="surface flex rounded-lg bg-s1 p-0.5" role="tablist">
          {tabs.map(([k, label, Icon]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`flex items-center gap-1.5 rounded-md px-3 font-semibold transition-colors ${touch ? "h-9 text-[14px]" : "h-8 text-[13px]"} ${tab === k ? "bg-s4 text-fg" : "text-fg-2 hover:text-fg"}`}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
      </div>
      {/* Device folders do not depend on the vault (nor on its password). */}
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

/** Photos of the open vault (local index). */
function CurrentPhotos({ touch }: { touch: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    let alive = true;
    void api.list("timeline").then((list) => alive && setItems(list.map(fromVault)));
    return () => {
      alive = false;
    };
  }, []);
  if (!items) return <GridSkeleton touch={touch} label={t("picker.readingPhotos")} />;
  return <Grid touch={touch} items={items} empty={t("picker.noPhotos")} />;
}

/** The app timeline in pick mode. */
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
          <p className="mt-1 text-[13px] text-fg-2">{t("picker.chooseOther")}</p>
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

// ---- albums and folders ----------------------------------------------------------------

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
          // Already on the device: no backup badge (pending 2) in the picker.
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

/** Album/folder list (cover, name, count); tapping opens the photos. */
function Collections({ touch, load, empty }: { touch: boolean; load: () => Promise<Collection[]>; empty: string }) {
  const [list, setList] = useState<Collection[] | null>(null);
  const [open, setOpen] = useState<{ c: Collection; items: Item[] | null } | null>(null);
  // One read per mount (each section has its own, via `key`).
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
          <span className="text-[12px] font-medium text-fg-3 tabular">{fmtNumber(open.c.count)}</span>
        </button>
        {open.items ? <Grid touch={touch} items={open.items} empty={t("picker.noPhotosHere")} /> : <GridSkeleton touch={touch} label={t("picker.opening")} />}
      </div>
    );

  if (!list) return <GridSkeleton touch={touch} label={t("picker.reading")} />;
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
            <p className="text-[12px] text-fg-3 tabular">{tc("common.items", { n: c.count })}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
