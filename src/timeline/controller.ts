import type { Layout } from "./layout";

/** Navigate adjacent virtual rows first, then align within that row. */
export function controllerNeighbour(lay: Layout, id: number, key: string): number | undefined {
  const rows = lay.blocks.filter(b => b.kind === "row");
  const rowIndex = rows.findIndex(row => row.cells.some(c => c.m.id === id));
  if (rowIndex < 0) return rows[0]?.cells[0]?.m.id;
  const row = rows[rowIndex];
  const index = row.cells.findIndex(c => c.m.id === id);
  const sign = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
  if (key === "ArrowLeft" || key === "ArrowRight") return row.cells[index + sign]?.m.id;
  const next = rows[rowIndex + sign];
  if (!next) return undefined;
  const current = row.cells[index];
  const center = current.x + current.w / 2;
  return next.cells.reduce<typeof current | undefined>((best, cell) =>
    !best || Math.abs(cell.x + cell.w / 2 - center) < Math.abs(best.x + best.w / 2 - center) ? cell : best,
  undefined)?.m.id;
}
