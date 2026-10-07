/**
 * Layout da linha do tempo, calculado inteiro em JS (sem medir o DOM):
 * seções por dia (ou mês, na densidade mais baixa), linhas justificadas no
 * desktop e grade quadrada no celular. Cada bloco tem `y` e altura, então a
 * tela só monta o que está visível e o scrubber sabe onde cada mês começa.
 */
import type { Media } from "../core/api";

export type Mode = { kind: "justified"; rowHeight: number } | { kind: "square"; cols: number };

export type Section = {
  key: string;
  label: string;
  /** Mês da seção ("2024-03"), para o scrubber. */
  month: string;
  items: Media[];
};

export type Cell = { m: Media; x: number; w: number; i: number };

export type Block =
  | { kind: "header"; y: number; h: number; section: Section }
  | { kind: "row"; y: number; h: number; cells: Cell[]; section: Section };

export type MonthMark = { month: string; label: string; year: number; y: number };

export type Layout = { blocks: Block[]; height: number; months: MonthMark[]; order: Media[] };

/** Data no relógio do lugar da captura (fuso do arquivo) ou deste aparelho. */
export function wallClock(m: Pick<Media, "taken_at" | "tz">): Date {
  if (m.tz === null || m.tz === undefined) return new Date(m.taken_at * 1000);
  // Desloca para que os getters locais mostrem a hora do lugar.
  const d = new Date((m.taken_at + m.tz * 60) * 1000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function monthLabel(month: string, withYear = true) {
  const [y, m] = month.split("-").map(Number);
  const name = MONTHS[m - 1];
  return withYear ? `${name[0].toUpperCase()}${name.slice(1)} de ${y}` : `${name[0].toUpperCase()}${name.slice(1)}`;
}

export function dayLabel(d: Date, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (days === 0) return "Hoje";
  if (days === 1) return "Ontem";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  const s = d.toLocaleDateString("pt-BR", opts).replace(/\./g, "").replace(/ de /g, " ");
  return s[0].toUpperCase() + s.slice(1);
}

/** Agrupa (lista já ordenada) por dia ou por mês. */
export function group(items: Media[], by: "day" | "month", now = new Date()): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const m of items) {
    const d = wallClock(m);
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

/** Proporção (largura/altura) com limites, para panoramas e fitas não dominarem. */
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
    // Sem mês (resultados por relevância, sem dias): sem marca no scrubber.
    if (section.month && months[months.length - 1]?.month !== section.month) {
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
 * Linhas justificadas (como Google Fotos/Flickr): enche a linha na altura alvo
 * e escala para fechar a largura. A última linha da seção fica na altura alvo
 * (não estica para preencher).
 */
function justifiedRows(items: Media[], width: number, target: number, gap: number) {
  const rows: { h: number; cells: Cell[] }[] = [];
  let row: Media[] = [];
  let sum = 0;
  const flush = (last: boolean) => {
    if (!row.length) return;
    const free = width - gap * (row.length - 1);
    // Linha cheia: altura que fecha a largura (≤ alvo). Última linha incompleta: altura alvo.
    const full = free / sum <= target || !last;
    const h = full ? free / sum : target;
    let x = 0;
    const cells = row.map((m, j) => {
      // A última célula de uma linha cheia fecha a largura exata (sem sobra de arredondamento).
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

/** Primeiro bloco cujo fim passa de `y` (busca binária). */
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

/** Mês na altura `y` (para o rótulo do scrubber). */
export function monthAt(months: MonthMark[], y: number): MonthMark | undefined {
  let hit = months[0];
  for (const m of months) {
    if (m.y <= y + 1) hit = m;
    else break;
  }
  return hit;
}
