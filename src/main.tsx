import { invoke } from "@tgcloud/ui/core/server";
import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { configureApp } from "@tgcloud/ui/core/app";
import { nav } from "./core/nav";
import { localSource } from "./core/local";
import { api } from "./core/api";
import { refreshSoon } from "@tgcloud/ui/core/refresh";
import { PhotoPickerGrid } from "./shared/PhotoPickerGrid";
import { installMock } from "@tgcloud/ui/core/server";
import { Images } from "lucide-react";
import App from "./App";
import "./index.css";

// Downloads like Google Photos: straight into the gallery, in DCIM/Restored.
configureApp({ id: "tgphotos", name: "TGPhotos", icon: Images, content: "media", downloads: "DCIM/Restored",
  openMedia: (id) => nav.open({ type: "viewer", id, siblings: [id] }),
  // Vault photo: picked on the app timeline (with albums and device folders).
  photoGrid: PhotoPickerGrid,
  // Vault thumbnail from what is already on the device, without downloading.
  localSource,
  // Motion photo checked when opening: writes to the vault (badge on the grid, no re-read).
  onMotion: (n, length) => void api.setMotion(n.id, length).then(() => refreshSoon()).catch(() => {}),
  // Video without duration opened: Rust re-reads its index on Telegram (a few KB).
  onVideoOpen: (n) => void invoke<boolean>("video_repair_one", { id: n.id }).then((ok) => ok && refreshSoon()).catch(() => {}),
});

/** Outside Tauri (only under `npm run dev`), commands fall back to the mock backend. */
if (!isTauri() && import.meta.env.DEV) installMock((await import("./core/mock")).mock);

// System insets from MainActivity (Android edge-to-edge): they become
// --inset-* in the CSS. Outside Android they stay in env(safe-area-inset-*).
type Insets = { top: number; right: number; bottom: number; left: number; ime: number };
const applyInsets = (i: Insets) => {
  const s = document.documentElement.style;
  s.setProperty("--inset-top", `${i.top}px`);
  s.setProperty("--inset-right", `${i.right}px`);
  s.setProperty("--inset-bottom", `${i.bottom}px`);
  s.setProperty("--inset-left", `${i.left}px`);
  s.setProperty("--inset-ime", `${i.ime}px`);
};
const bridge = (window as unknown as { TGInsets?: { get(): string } }).TGInsets;
if (bridge) applyInsets(JSON.parse(bridge.get()));
window.addEventListener("tg-insets", (e) => applyInsets((e as CustomEvent<Insets>).detail));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
