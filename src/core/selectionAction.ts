/** Snapshot a contextual batch before closing menus or clearing selection. */
export function selectionActionIds(selected: ReadonlySet<number>, focused: number): number[] {
  return selected.has(focused) ? [...selected].filter(id => id > 0) : [focused];
}
