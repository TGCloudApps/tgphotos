import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { configureApp } from "@tgcloud/ui/core/app";
import { nav } from "./core/nav";
import { localSource } from "./core/local";
import { PhotoPickerGrid } from "./shared/PhotoPickerGrid";
import { installMock } from "@tgcloud/ui/core/server";
import { Images } from "lucide-react";
import App from "./App";
import "./index.css";

// Downloads como o Google Fotos: direto na galeria, em DCIM/Restored.
configureApp({ id: "tgphotos", name: "TGPhotos", icon: Images, what: "fotos e vídeos", downloads: "DCIM/Restored",
  openMedia: (id) => nav.open({ type: "viewer", id, siblings: [id] }),
  // Foto do vault: escolhida na linha do tempo do app (com álbuns e pastas do aparelho).
  photoGrid: PhotoPickerGrid,
  // Miniatura do vault a partir do que está no aparelho, sem baixar.
  localSource,
});

/** Fora do Tauri (só em `npm run dev`), os comandos caem no backend simulado. */
if (!isTauri() && import.meta.env.DEV) installMock((await import("./core/mock")).mock);

// Insets do sistema vindos do MainActivity (Android edge-to-edge): viram
// --inset-* no CSS. Fora do Android ficam no env(safe-area-inset-*).
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
