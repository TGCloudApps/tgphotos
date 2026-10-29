/** Native media drop handling shared by platform shells. */
import { isTauri } from "@tauri-apps/api/core";
import { transfers } from "@tgcloud/ui/core/transfers";
import { useEffect } from "react";
import { create } from "zustand";
import { nav } from "../core/nav";

/** Highlight while system files pass over the window. */
const useDrop = create<{ over: boolean }>(() => ({ over: false }));
export const useOver = () => useDrop((s) => s.over);

/** Drag from the system (native Tauri event, with the paths). */
export function useOsDrop(album: number) {
  useEffect(() => {
    if (!isTauri()) return;
    // Registration is asynchronous: if cleanup arrives first (StrictMode mounts
    // twice), unregister as soon as the promise resolves. Without that, every
    // dropped file would be uploaded twice.
    let off: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const unlisten = await getCurrentWebview().onDragDropEvent(({ payload: p }) => {
        if (p.type === "enter" || p.type === "over") useDrop.setState({ over: true });
        else if (p.type === "leave") useDrop.setState({ over: false });
        else if (p.type === "drop") {
          useDrop.setState({ over: false });
          // With the Google Photos window open, dropped .zip files belong to it, not uploads.
          if (nav.layers().some((l) => l.type === "import-google")) return;
          if (p.paths.length) void transfers.uploadPaths(p.paths, album);
        }
      });
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [album]);
}
