/**
 * Timeline grid, virtualized: the layout (layout.ts) gives the position of
 * each row and only what is near the screen is mounted. Used by Photos,
 * Favorites, Videos, Archive, albums and search.
 *
 * Mobile: square grid, density by pinch, long press selects.
 * Desktop: justified rows, density by Ctrl+wheel, clicking the circle
 * (or Ctrl+click) selects, Shift+click selects the range.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Check, CircleFadingPlay, Clock, CloudOff, Heart, Loader2, Play } from "lucide-react";
import { Cover } from "./Cover";
import { useTransfers } from "@tgcloud/ui/core/transfers";
import { uploadStates } from "../core/library";
import { formatDuration } from "@tgcloud/ui/core/format";
import { haptic } from "@tgcloud/ui/core/platform";
import { useSrc } from "@tgcloud/ui/core/item";
import { thumbFromVideo, useRequestThumb } from "@tgcloud/ui/core/thumbs";
import type { Media } from "../core/api";
import { nav } from "../core/nav";
import { useSelection } from "../core/select";
import { addedClock, firstVisible, group, layout, wallClock, type Block, type Cell, type Mode } from "./layout";
import { Scrubber } from "./Scrubber";
import { useScrollMemory } from "../shared/Scroll";
import { t, tc } from "../i18n";

// ---- density (per device) ----------------------------------------------------------

const DESK_ROWS = [110, 150, 200, 260, 340];
const TOUCH_COLS = [7, 5, 4, 3, 2];

type Density = { desk: number; touch: number };

function loadDensity(): Density {
  try {
    return { desk: 2, touch: 2, ...JSON.parse(localStorage.getItem("density") ?? "{}") };
  } catch {
    return { desk: 2, touch: 2 };
  }
}

export const useDensity = create<Density>(() => loadDensity());

/** +1 zooms in (larger photos), -1 zooms out. */
export function zoom(touch: boolean, delta: 1 | -1) {
  const key = touch ? "touch" : "desk";
  const max = (touch ? TOUCH_COLS : DESK_ROWS).length - 1;
  const cur = useDensity.getState()[key];
  const next = Math.max(0, Math.min(max, cur + delta));
  if (next === cur) return false;
  useDensity.setState({ [key]: next });
  try {
    localStorage.setItem("density", JSON.stringify(useDensity.getState()));
  } catch {
    /* no storage: applies to this session only */
  }
  return true;
}

// ---- go to a media (date in the lightbox) -------------------------------------------

/** Request to scroll to media `id` (consumed by the timeline that has it). */
export const useJump = create<{ id: number | null; flash: number | null }>(() => ({ id: null, flash: null }));

export function jumpTo(id: number) {
  useJump.setState({ id });
}

// ---- grid --------------------------------------------------------------------------

type Props = {
  items: Media[];
  touch: boolean;
  /** Content above the grid (album title, trash notice…). */
  top?: ReactNode;
  topHeight?: number;
  /** Group by day (default) or a single section without a header (search). */
  grouped?: boolean;
  /** Free space at the end (bottom bar, floating button). */
  bottom?: number;
  onScroll?: (top: number, dir: 1 | -1) => void;
  /** Sections by the upload date to the vault, not the capture date (items already in upload order). */
  byAdded?: boolean;
  /** Opens a media (default: the vault viewer). */
  onOpenItem?: (m: Media, siblings: number[]) => void;
  /**
   * Pick mode (vault photo): tapping calls `onOpenItem`; no selection,
   * long press, video preview or scroll memory. The marked id (or null).
   */
  picked?: number | null | ReadonlySet<number>;
};

// Margin mounted off screen: larger = fewer remounts while scrolling.
const OVERSCAN = 1800;

export function Timeline({ items, touch, top, topHeight = 0, grouped = true, byAdded = false, bottom = 24, onScroll, onOpenItem, picked }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const picking = picked !== undefined;
  // Going back to this screen restores the scroll (see Scroll.tsx).
  useScrollMemory(scroller, !picking);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState({ top: 0, height: 800 });
  const density = useDensity((s) => (touch ? s.touch : s.desk));
  const selecting = useSelection((s) => s.ids.size > 0) && !picking;

  // Desktop: right margin for the scrubber track.
  const pad = touch ? 0 : 16;
  const padRight = touch ? 0 : 60;
  const mode: Mode = touch ? { kind: "square", cols: TOUCH_COLS[density] } : { kind: "justified", rowHeight: DESK_ROWS[density] };
  // Lowest density: sections per month, like Google Photos.
  const byMonth = density === 0;
  const sections = useMemo(
    () => (grouped ? group(items, byMonth ? "month" : "day", new Date(), byAdded ? addedClock : wallClock) : [{ key: "all", label: "", month: "", items }]),
    [items, grouped, byMonth, byAdded],
  );
  const lay = useMemo(
    () =>
      layout(sections, {
        width: width - pad - padRight,
        mode,
        gap: touch ? 2 : 4,
        header: grouped ? (touch ? 44 : 52) : 0,
        top: topHeight,
        sectionGap: touch ? 4 : 8,
      }),
    // `mode` changes together with density/touch.
    [sections, width, density, touch, topHeight, grouped],
  );

  // Container width.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Measures right away (before the first frame): without width, the layout would come out empty.
    setWidth(el.clientWidth);
    setView({ top: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setView({ top: el.scrollTop, height: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Changing the density keeps the same photo at the top of the screen.
  const anchor = useRef<number | null>(null);
  const remember = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const i = firstVisible(lay.blocks, el.scrollTop);
    const b = lay.blocks.slice(i).find((x): x is Extract<Block, { kind: "row" }> => x.kind === "row");
    anchor.current = b?.cells[0]?.m.id ?? null;
  }, [lay]);
  useLayoutEffect(() => {
    const el = scroller.current;
    const id = anchor.current;
    if (!el || id === null) return;
    anchor.current = null;
    const b = lay.blocks.find((x) => x.kind === "row" && x.cells.some((c) => c.m.id === id));
    if (b) el.scrollTop = Math.max(0, b.y - (touch ? 44 : 52));
  }, [lay, touch]);

  // Pinch (mobile) and Ctrl+wheel (desktop).
  const pinch = useRef<{ d: number; done: boolean } | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || touch) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      remember();
      zoom(false, e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [touch, remember]);

  // "Sep 30 ›" in the lightbox: scrolls to the media, centered, and highlights it.
  const jump = useJump((s) => s.id);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (jump === null || !el || !width) return;
    const b = lay.blocks.find((x) => x.kind === "row" && x.cells.some((c) => c.m.id === jump));
    if (!b) return;
    el.scrollTop = Math.max(0, b.y - el.clientHeight / 2 + b.h / 2);
    useJump.setState({ id: null, flash: jump });
    const t = setTimeout(() => useJump.setState({ flash: null }), 1400);
    return () => clearTimeout(t);
  }, [jump, lay, width]);

  const last = useRef(0);
  const visible = useMemo(() => {
    const out: Block[] = [];
    for (let i = firstVisible(lay.blocks, view.top - OVERSCAN); i < lay.blocks.length; i++) {
      const b = lay.blocks[i];
      if (b.y > view.top + view.height + OVERSCAN) break;
      out.push(b);
    }
    return out;
  }, [lay, view]);

  const ids = lay.order;

  // Drag to select (mobile): holds native scrolling while dragging.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !touch) return;
    const index = new Map(lay.order.map((m, i) => [m.id, i]));
    let finger: [number, number] | null = null;
    let raf = 0;
    const apply = () => {
      if (!drag || !finger) return;
      const hit = document.elementFromPoint(finger[0], finger[1])?.closest<HTMLElement>("[data-media-id]");
      const i = hit ? index.get(Number(hit.dataset.mediaId)) : undefined;
      if (i === undefined) return;
      const [a, b] = [Math.min(drag.anchor, i), Math.max(drag.anchor, i)];
      const next = new Set(drag.base);
      for (const m of lay.order.slice(a, b + 1)) {
        if (drag.add) next.add(m.id);
        else next.delete(m.id);
      }
      useSelection.getState().set(next);
    };
    // Near the edge: scrolls by itself (faster the closer it is) and keeps selecting.
    const tick = () => {
      raf = 0;
      if (!drag || !finger) return;
      const r = el.getBoundingClientRect();
      const edge = 80;
      const y = finger[1];
      const speed = y < r.top + edge ? -(r.top + edge - y) / 3 : y > r.bottom - edge ? (y - (r.bottom - edge)) / 3 : 0;
      if (speed) {
        el.scrollTop += Math.max(-28, Math.min(28, speed));
        apply();
        raf = requestAnimationFrame(tick);
      }
    };
    const move = (e: TouchEvent) => {
      if (!drag) return;
      e.preventDefault();
      finger = [e.touches[0].clientX, e.touches[0].clientY];
      apply();
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const end = () => {
      drag = null;
      finger = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      end();
    };
  }, [touch, lay]);
  const open = useCallback(
    (m: Media) => (onOpenItem ? onOpenItem(m, ids.map((x) => x.id)) : nav.open({ type: "viewer", id: m.id, siblings: ids.map((x) => x.id) })),
    [ids, onOpenItem],
  );

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain"
        style={{ touchAction: "pan-y" }}
        onScroll={(e) => {
          // Scrolling is not a long press.
          cancelLongPress();
          const t = e.currentTarget.scrollTop;
          setView({ top: t, height: e.currentTarget.clientHeight });
          onScroll?.(t, t >= last.current ? 1 : -1);
          last.current = t;
        }}
        onTouchStart={(e) => {
          if (e.touches.length === 2) {
            const [a, b] = [e.touches[0], e.touches[1]];
            pinch.current = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), done: false };
          }
        }}
        onTouchMove={(e) => {
          const p = pinch.current;
          if (!p || p.done || e.touches.length !== 2) return;
          const [a, b] = [e.touches[0], e.touches[1]];
          const r = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / p.d;
          if (r > 1.25 || r < 0.8) {
            p.done = true;
            remember();
            if (zoom(true, r > 1 ? 1 : -1)) haptic();
          }
        }}
        onTouchEnd={(e) => {
          if (e.touches.length < 2) pinch.current = null;
        }}
      >
        {top}
        <div className="relative" style={{ height: lay.height - topHeight + bottom }}>
          {width > 0 && visible.map((b) =>
            b.kind === "header" ? (
              <Header key={`h-${b.section.key}`} block={b} touch={touch} pad={pad} padRight={padRight} top={b.y - topHeight} picking={picking} />
            ) : (
              b.cells.map((c) => (
                <Tile
                  key={c.m.id}
                  cell={c}
                  top={b.y - topHeight}
                  left={pad + c.x}
                  h={b.h}
                  touch={touch}
                  selecting={selecting}
                  picking={picking}
                  picked={picking && (picked instanceof Set ? picked.has(c.m.id) : picked === c.m.id)}
                  square={mode.kind === "square"}
                  order={ids}
                  onOpen={open}
                />
              ))
            ),
          )}
        </div>
      </div>
      <Scrubber scroller={scroller} layout={lay} view={view} touch={touch} />
    </div>
  );
}

function Header({ block, touch, pad, padRight, top, picking }: { block: Extract<Block, { kind: "header" }>; touch: boolean; pad: number; padRight: number; top: number; picking: boolean }) {
  const ids = block.section.items.map((m) => m.id);
  const all = useSelection((s) => ids.every((id) => s.ids.has(id)));
  const selecting = useSelection((s) => s.ids.size > 0);
  const toggle = () => {
    if (touch && !nav.top("selection")) nav.open({ type: "selection" });
    useSelection.getState().toggleAll(ids);
  };
  return (
    <div
      className="group absolute inset-x-0 flex items-end"
      style={{ top, height: block.h, paddingLeft: pad + (touch ? 12 : 0), paddingRight: padRight, paddingBottom: touch ? 8 : 10 }}
    >
      {!picking && (selecting || !touch) && (
        <button
          onClick={toggle}
          aria-label={all ? t("timeline.unselectDay") : t("timeline.selectDay")}
          className={`mr-2 grid size-6 place-items-center rounded-full border-2 transition-opacity ${
            all ? "border-brand bg-brand text-white" : "border-fg-3 text-transparent"
          } ${!touch && !selecting && !all ? "opacity-0 group-hover:opacity-100" : ""}`}
        >
          <Check size={14} strokeWidth={3} />
        </button>
      )}
      <p className={`font-semibold text-fg ${touch ? "text-[15px]" : "text-[14px]"}`}>{block.section.label}</p>
    </div>
  );
}

const LONG_PRESS = 450;


/**
 * Pending long press (only one at a time). Scrolling cancels it: when Android
 * takes over native scrolling, `touchmove` events stop arriving, so the timer must be canceled.
 */
let pendingPress: number | null = null;
/**
 * Drag selection (mobile): the long press selects and, without releasing,
 * dragging extends the range (or unmarks it, if it started on a marked item).
 * Near the edge, the grid scrolls by itself.
 */
type Drag = { anchor: number; add: boolean; base: Set<number> };
let drag: Drag | null = null;

/** Hover preview; the read is canceled when it disappears. */
function HoverPreview({ m }: { m: Media }) {
  const src = useSrc(m);
  return (
    <video
      src={src}
      crossOrigin="anonymous"
      autoPlay
      muted
      loop
      playsInline
      onTimeUpdate={m.thumb ? undefined : (e) => thumbFromVideo(m, e.currentTarget)}
      className="pointer-events-none absolute inset-0 size-full object-cover"
    />
  );
}

export function cancelLongPress() {
  if (pendingPress !== null) clearTimeout(pendingPress);
  pendingPress = null;
}

const Tile = memo(function Tile({
  cell,
  top,
  left,
  h,
  touch,
  selecting,
  picking,
  picked,
  square,
  order,
  onOpen,
}: {
  cell: Cell;
  top: number;
  left: number;
  h: number;
  touch: boolean;
  selecting: boolean;
  picking: boolean;
  picked: boolean;
  square: boolean;
  order: Media[];
  onOpen: (m: Media) => void;
}) {
  const m = cell.m;
  const ref = useRef<HTMLDivElement>(null);
  useRequestThumb(m, ref);
  const inSelection = useSelection((s) => s.ids.has(m.id));
  const selected = picking ? picked : inSelection;
  const flash = useJump((s) => s.flash === m.id);
  // Outside the vault: the upload state (queued, waiting for connection, uploading).
  const upState = useTransfers((s) => (m.uri ? uploadStates(s.list).get(m.uri.split("?")[0]) : undefined));
  const upload = upState === "active" ? "active" : upState === "queued" || upState === "waiting" || upState === "paused" ? "pending" : undefined;
  const [preview, setPreview] = useState(false);
  const hover = useRef<number | null>(null);
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
  /** The long press already selected: the synthetic click that follows does not count. */
  const swallow = useRef(false);
  const video = m.mime.startsWith("video/");

  const toggle = () => useSelection.getState().toggle(m.id);
  const range = () => {
    const sel = useSelection.getState();
    const a = order.findIndex((x) => x.id === sel.anchor);
    if (a < 0) return toggle();
    const [i, j] = [Math.min(a, cell.i), Math.max(a, cell.i)];
    sel.set([...sel.ids, ...order.slice(i, j + 1).map((x) => x.id)]);
  };

  return (
    <div
      ref={ref}
      className={`group absolute cursor-pointer overflow-hidden bg-s2 select-none ${square ? "" : "rounded-[4px]"}`}
      data-media-id={m.id}
      style={{ top, left, width: cell.w, height: h, contain: "strict", outline: flash ? "3px solid var(--brand)" : undefined, outlineOffset: -3 }}
      onClick={(e) => {
        if (picking) return onOpen(m);
        if (touch) {
          if (swallow.current) return void (swallow.current = false);
          return selecting ? toggle() : onOpen(m);
        }
        if (e.shiftKey && selecting) return range();
        if (e.ctrlKey || e.metaKey || selecting) return toggle();
        onOpen(m);
      }}
      onContextMenu={(e) => touch && e.preventDefault()}
      onTouchStart={(e) => {
        if (picking) return;
        cancelLongPress();
        swallow.current = false;
        if (e.touches.length > 1) return;
        const t = e.touches[0];
        press.current = { t: 0, x: t.clientX, y: t.clientY };
        pendingPress = window.setTimeout(() => {
          pendingPress = null;
          press.current = null;
          swallow.current = true;
          haptic();
          if (!nav.top("selection")) nav.open({ type: "selection" });
          const base = new Set(useSelection.getState().ids);
          toggle();
          drag = { anchor: cell.i, add: !base.has(m.id), base };
        }, LONG_PRESS);
      }}
      onTouchMove={(e) => {
        const p = press.current;
        if (p && Math.hypot(e.touches[0].clientX - p.x, e.touches[0].clientY - p.y) > 8) {
          cancelLongPress();
          press.current = null;
        }
      }}
      onTouchEnd={() => {
        cancelLongPress();
        press.current = null;
      }}
      onTouchCancel={() => {
        cancelLongPress();
        press.current = null;
        swallow.current = false;
      }}
      onMouseEnter={() => {
        if (!video || touch || picking) return;
        hover.current = window.setTimeout(() => setPreview(true), 500);
      }}
      onMouseLeave={() => {
        if (hover.current) clearTimeout(hover.current);
        setPreview(false);
      }}
    >
      <Cover m={m} selected={selected} />
      {/* The preview also generates the missing thumbnail (the frame comes from it, without downloading again). */}
      {preview && <HoverPreview m={m} />}

      {video && (
        <span className="pointer-events-none absolute top-1.5 right-1.5 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular">
          {m.duration ? formatDuration(m.duration) : null}
          <Play size={10} className="fill-white" />
        </span>
      )}
      {m.id < 0 && !selected && m.pending !== 2 && (
        <span
          className="pointer-events-none absolute right-1.5 bottom-1.5 grid size-6 place-items-center rounded-full bg-black/55"
          title={upload === "active" ? t("timeline.uploading") : upload || m.pending ? t("timeline.backupPending") : t("timeline.noBackup")}
        >
          {upload === "active" ? (
            <Loader2 size={13} className="animate-spin text-white" />
          ) : upload || m.pending ? (
            <Clock size={13} className="text-white" />
          ) : (
            <CloudOff size={13} className="text-white" />
          )}
        </span>
      )}
      {m.motion != null && m.motion > 0 && (
        <CircleFadingPlay size={touch ? 14 : 16} className="pointer-events-none absolute top-1.5 right-1.5 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)]" aria-label={t("timeline.motion")} />
      )}
      {m.favorite && !selecting && (
        <Heart size={touch ? 14 : 16} className="pointer-events-none absolute bottom-1.5 left-1.5 fill-white text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)]" />
      )}

      {!touch && !selected && <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 to-transparent to-30% opacity-0 transition-opacity group-hover:opacity-100" />}
      {/* Selection: circle in the corner (desktop on hover; always in selection mode). */}
      {(picking ? picked : selecting || !touch) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (picking) onOpen(m);
            else if (e.shiftKey && selecting) range();
            else toggle();
          }}
          aria-label={selected ? t("timeline.unselect") : tc("common.select")}
          className={`absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full border-2 transition-opacity ${
            selected ? "border-brand bg-brand text-white" : "border-white/90 bg-black/25 text-transparent"
          } ${!touch && !selecting ? "opacity-0 group-hover:opacity-100" : ""}`}
        >
          <Check size={14} strokeWidth={3} />
        </button>
      )}
    </div>
  );
});
