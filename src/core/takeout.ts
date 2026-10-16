/**
 * Importar do Google Fotos (takeout): estado da importação que roda no Rust.
 * O Rust faz tudo em segundo plano; aqui só se consulta o andamento (a cada
 * ~0,7 s enquanto roda) e, com a janela fechada, o aviso com progresso.
 */
import { create } from "zustand";
import { dismiss, notify } from "@tgcloud/ui/core/notices";
import { refreshSoon } from "@tgcloud/ui/core/refresh";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { errText, getPort, invoke } from "@tgcloud/ui/core/server";

export type TakeoutSource = { name: string; path: string; kind: "zip" | "pasta"; media: number; bytes: number };
export type TakeoutSummary = {
  sources: TakeoutSource[];
  photos: number;
  videos: number;
  bytes: number;
  albums: { name: string; count: number }[];
  favorites: number;
  archived: number;
  edited: number;
  withoutSide: number;
  sidecars: number;
  doneBefore: number;
  firstYear: number | null;
  lastYear: number | null;
};
export type TakeoutStatus = {
  state: "idle" | "running" | "stopping" | "stopped" | "done" | "error";
  total: number;
  done: number;
  reused: number;
  failed: number;
  bytesTotal: number;
  bytesDone: number;
  current: string | null;
  error: string | null;
  errors: string[];
  favorites: number;
  archived: number;
  albumsMade: number;
  albumsTotal: number;
  before: number;
  elapsedMs: number;
  finishing: boolean;
};
export type TakeoutOpts = { skipEdited: boolean; albums: boolean };

const idle: TakeoutStatus = {
  state: "idle", total: 0, done: 0, reused: 0, failed: 0, bytesTotal: 0, bytesDone: 0, current: null, error: null,
  errors: [], favorites: 0, archived: 0, albumsMade: 0, albumsTotal: 0, before: 0, elapsedMs: 0, finishing: false,
};

export const isRunning = (s: TakeoutStatus) => s.state === "running" || s.state === "stopping";

export const useTakeout = create<{ status: TakeoutStatus; viewing: number }>(() => ({ status: idle, viewing: 0 }));

const NOTICE = 2_000_000;
let timer: ReturnType<typeof setInterval> | undefined;
let last: TakeoutStatus["state"] = "idle";

async function poll() {
  let s: TakeoutStatus;
  try {
    s = await invoke<TakeoutStatus>("takeout_status");
  } catch {
    return;
  }
  useTakeout.setState({ status: s });
  const viewing = useTakeout.getState().viewing > 0;
  if (isRunning(s)) {
    if (!viewing)
      notify({
        key: NOTICE,
        text: s.finishing ? "Google Fotos: organizando álbuns e favoritas…" : `Importando do Google Fotos: ${s.done} de ${s.total}`,
        tone: "info",
        progress: s.total ? s.done / s.total : 0,
        sticky: true,
        global: true,
      });
    else dismiss(NOTICE);
    return;
  }
  clearInterval(timer);
  timer = undefined;
  dismiss(NOTICE);
  refreshSoon();
  // Terminou com a janela fechada: avisa com o resumo.
  if (!viewing && (last === "running" || last === "stopping")) {
    if (s.state === "done") notify({ text: `Google Fotos: ${s.done - s.failed} ${s.done - s.failed === 1 ? "item importado" : "itens importados"}${s.failed ? ` · ${s.failed} com erro` : ""}`, tone: s.failed ? "danger" : "success", global: true });
    else if (s.state === "error") notify({ text: `Importação do Google Fotos parou: ${s.error ?? "erro"}`, tone: "danger", global: true });
    else if (s.state === "stopped") notify({ text: `Importação do Google Fotos pausada em ${s.done} de ${s.total}`, tone: "neutral", global: true });
  }
  last = s.state;
}

/** Começa a acompanhar (ao abrir a janela ou ao iniciar a importação). */
export function watchTakeout() {
  void poll().then(() => {
    if (!timer && isRunning(useTakeout.getState().status)) {
      last = "running";
      timer = setInterval(() => void poll(), 700);
    }
  });
}

export const takeout = {
  scan: (paths: string[], names: Record<string, string> = {}) => invoke<TakeoutSummary>("takeout_scan", { paths, names }),
  async start(opts: TakeoutOpts) {
    await invoke("takeout_start", { opts });
    // Android: o serviço em primeiro plano segura o processo (tela apagada, app minimizado).
    if (onAndroid) android.startTransfers(getPort());
    last = "running";
    useTakeout.setState({ status: { ...idle, state: "running" } });
    clearInterval(timer);
    timer = setInterval(() => void poll(), 700);
    void poll();
  },
  stop: () => invoke("takeout_stop").then(() => poll()),
  async reset() {
    await invoke("takeout_reset");
    useTakeout.setState({ status: idle });
    last = "idle";
  },
  errText,
};
