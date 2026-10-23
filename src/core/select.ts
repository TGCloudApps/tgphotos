/** Media selection (batch). On mobile it lives while the "selection" layer exists. */
import { create } from "zustand";

type Selection = {
  ids: Set<number>;
  /** Anchor for Shift+click. */
  anchor: number | null;
  set: (ids: Iterable<number>, anchor?: number | null) => void;
  toggle: (id: number) => void;
  /** Toggles a whole group (day). */
  toggleAll: (ids: number[]) => void;
  clear: () => void;
};

export const useSelection = create<Selection>((set) => ({
  ids: new Set(),
  anchor: null,
  set: (ids, anchor) => set((s) => ({ ids: new Set(ids), anchor: anchor === undefined ? s.anchor : anchor })),
  toggle: (id) =>
    set((s) => {
      const ids = new Set(s.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ids, anchor: id };
    }),
  toggleAll: (list) =>
    set((s) => {
      const ids = new Set(s.ids);
      const all = list.every((id) => ids.has(id));
      for (const id of list) {
        if (all) ids.delete(id);
        else ids.add(id);
      }
      return { ids };
    }),
  clear: () => set({ ids: new Set(), anchor: null }),
}));
