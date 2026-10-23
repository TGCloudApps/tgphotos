/**
 * Timeline layout, computed entirely in JS (without measuring the DOM):
 * sections per day (or month, at the lowest density), justified rows on the
 * desktop and a square grid on mobile. Each block has `y` and height, so the
 * screen only mounts what is visible and the scrubber knows where each month starts.
 */
import type { Media } from "../core/api";
import { fmtDate, fmtDateParts, monthName } from "@tgcloud/ui/i18n";
import { tc } from "../i18n";

export type Mode = { kind: "justified"; rowHeight: number } | { kind: "square"; cols: number };

export type Section = {
  key: string;
  label: string;
  /** Section month ("2024-03"), for the scrubber. */
  month: string;
  items: Media[];
};

export type Cell = { m: Media; x: number; w: number; i: number };

export type Block =
  | { kind: "header"; y: number; h: number; section: Section }
  | { kind: "row"; y: number; h: number; cells: Cell[]; section: Section };

export type MonthMark = { month: string; label: string; year: number; y: number };

export type Layout = { blocks: Block[]; height: number; months: MonthMark[]; order: Media[] };

/** Date on the capture location's clock (the file's timezone) or this device's. */
export function wallClock(m: Pick<Media, "taken_at" | "tz">): Date {
  if (m.tz === null || m.tz === undefined) return new Date(m.taken_at * 1000);
  // Shifts so the local getters show the location's time.
  const d = new Date((m.taken_at + m.tz * 60) * 1000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export function monthLabel(month: string, withYear = true) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  const s = withYear ? fmtDateParts(d, { month: "long", year: "numeric" }) : monthName(m - 1);
  return s[0].toUpperCase() + s.slice(1);
}

export function dayLabel(d: Date, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (days === 0) return tc("common.today");
  if (days === 1) return tc("common.yesterday");
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  const s = fmtDate(d, opts);
  return s[0].toUpperCase() + s.slice(1);
}

/** Upload day to the vault, on this device's clock (the user sees "Today" for what was uploaded today). */
export const addedClock = (m: Pick<Media, "added_at">) => new Date(m.added_at * 1000);

/** Groups (already ordered list) by day or month; `date` is each item's date (default: the capture one). */
export function group(items: Media[], by: "day" | "month", now = new Date(), date: (m: Media) => Date = wallClock): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const m of items) {
    const d = date(m);
    const key = by === "day" ? dayKey(d) : monthKey(d);
    if (!cur || cur.key !== key) {
      const month = monthKey(d);
      const label = by === "day" ? dayLabel(d, now) : monthLabel(month, d.getFullYear() !== now.getFullYear());
      cur = { key, label, month, items: [] };
      out.push(cur);
    }
    cur.items.push(m);
  }
  return out;
}

/** Aspect ratio (width/height) with limits, so panoramas and strips do not dominate. */
export function ratioOf(m: Pick<Media, "width" | "height">) {
  if (!m.width || !m.height) return 1;
  return Math.min(2.5, Math.max(0.5, m.width / m.height));
}

export type LayoutOpts = { width: number; mode: Mode; gap: number; header: number; top?: number; sectionGap?: number };

export function layout(sections: Section[], o: LayoutOpts): Layout {
  const blocks: Block[] = [];
  const months: MonthMark[] = [];
  const order: Media[] = [];
  let y = o.top ?? 0;
  const width = Math.max(1, o.width);
  for (const section of sections) {
    if (months[months.length - 1]?.month !== section.month) {
      const [year] = section.month.split("-").map(Number);
      months.push({ month: section.month, label: monthLabel(section.month), year, y });
    }
    blocks.push({ kind: "header", y, h: o.header, section });
    y += o.header;
    const rows = o.mode.kind === "square" ? squareRows(section.items, width, o.mode.cols, o.gap) : justifiedRows(section.items, width, o.mode.rowHeight, o.gap);
    for (const row of rows) {
      for (const c of row.cells) {
        c.i = order.length;
        order.push(c.m);
      }
      blocks.push({ kind: "row", y, h: row.h, cells: row.cells, section });
      y += row.h + o.gap;
    }
    y += o.sectionGap ?? 0;
  }
  return { blocks, height: y, months, order };
}

function squareRows(items: Media[], width: number, cols: number, gap: number) {
  const size = (width - gap * (cols - 1)) / cols;
  const rows: { h: number; cells: Cell[] }[] = [];
  for (let i = 0; i < items.length; i += cols) {
    rows.push({
      h: size,
      cells: items.slice(i, i + cols).map((m, j) => ({ m, x: j * (size + gap), w: size, i: 0 })),
    });
  }
  return rows;
}

/**
 * Justified rows (like Google Photos/Flickr): fills the row at the target height
 * and scales to close the width. The last row of the section stays at the target
 * height (does not stretch to fill).
 */
function justifiedRows(items: Media[], width: number, target: number, gap: number) {
  const rows: { h: number; cells: Cell[] }[] = [];
  let row: Media[] = [];
  let sum = 0;
  const flush = (last: boolean) => {
    if (!row.length) return;
    const free = width - gap * (row.length - 1);
    // Full row: height that closes the width (≤ target). Last incomplete row: target height.
    const full = free / sum <= target || !last;
    const h = full ? free / sum : target;
    let x = 0;
    const cells = row.map((m, j) => {
      // The last cell of a full row closes the exact width (without rounding leftovers).
      const w = full && j === row.length - 1 ? width - x : ratioOf(m) * h;
      const cell = { m, x, w, i: 0 };
      x += w + gap;
      return cell;
    });
    rows.push({ h, cells });
    row = [];
    sum = 0;
  };
  for (const m of items) {
    row.push(m);
    sum += ratioOf(m);
    if (sum * target + gap * (row.length - 1) >= width) flush(false);
  }
  flush(true);
  return rows;
}

/** First block whose end passes `y` (binary search). */
export function firstVisible(blocks: Block[], y: number) {
  let lo = 0;
  let hi = blocks.length - 1;
  let ans = blocks.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].y + blocks[mid].h >= y) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

/** Month at height `y` (for the scrubber label). */
export function monthAt(months: MonthMark[], y: number): MonthMark | undefined {
  let hit = months[0];
  for (const m of months) {
    if (m.y <= y + 1) hit = m;
    else break;
  }
  return hit;
}
