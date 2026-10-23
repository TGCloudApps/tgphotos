/**
 * Device trash state (see deviceTrash.ts), kept apart so the local gallery
 * and the viewer can find the items without importing all the logic.
 */
import { create } from "zustand";
import type { DeviceLink, DeviceTrash, Media } from "./api";

export type OutOfSync = {
  /** In the vault trash, but the original is still on the device. */
  vaultOnly: DeviceLink[];
  /** In the vault, but the original is in the device trash (recorded by the app, or trashed by another app). */
  deviceOnly: { media_id: number; src: string; name: string; mime: string; size: number; row: DeviceTrash | null }[];
};

export type DeviceState = {
  /** Device trash rows that are still there. */
  rows: DeviceTrash[];
  /** Device-only items in the trash, ready for the grid (negative ids). */
  localOnly: Media[];
  out: OutOfSync;
  /** Originals with a copy in the vault (outside the trash) that can leave the device. */
  freeable: DeviceLink[];
  loaded: boolean;
};

export const useDevice = create<DeviceState>(() => ({ rows: [], localOnly: [], out: { vaultOnly: [], deviceOnly: [] }, freeable: [], loaded: false }));

/** Device-only item in the trash, by grid id. */
export const findTrashedLocal = (id: number) => useDevice.getState().localOnly.find((m) => m.id === id);
