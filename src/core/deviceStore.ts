/**
 * Estado da lixeira do aparelho (ver deviceTrash.ts), à parte para a galeria
 * local e o visualizador acharem os itens sem importar a lógica toda.
 */
import { create } from "zustand";
import type { DeviceLink, DeviceTrash, Media } from "./api";

export type OutOfSync = {
  /** Na lixeira do vault, mas o original continua no aparelho. */
  vaultOnly: DeviceLink[];
  /** No vault, mas o original está na lixeira do aparelho (registro do app, ou lixeira feita por outro app). */
  deviceOnly: { media_id: number; src: string; name: string; mime: string; size: number; row: DeviceTrash | null }[];
};

export type DeviceState = {
  /** Linhas da lixeira do aparelho que continuam lá. */
  rows: DeviceTrash[];
  /** Itens só do aparelho na lixeira, prontos para a grade (ids negativos). */
  localOnly: Media[];
  out: OutOfSync;
  /** Originais com cópia no vault (fora da lixeira) que podem sair do aparelho. */
  freeable: DeviceLink[];
  loaded: boolean;
};

export const useDevice = create<DeviceState>(() => ({ rows: [], localOnly: [], out: { vaultOnly: [], deviceOnly: [] }, freeable: [], loaded: false }));

/** Item só do aparelho na lixeira, pelo id da grade. */
export const findTrashedLocal = (id: number) => useDevice.getState().localOnly.find((m) => m.id === id);
