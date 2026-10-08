/**
 * Sinais para o trabalho em segundo plano (Rust, intel): energia do aparelho
 * (Android), uso da tela (rolagem, vídeo tocando: ele dá licença) e o que
 * está na tela (vai para a frente da fila).
 */
import { available as onAndroid } from "@tgcloud/ui/core/android";
import { useQuery } from "@tanstack/react-query";
import { api, type IntelStatus } from "./api";
import { startFrames } from "./frames";

type Bridge = { powerState?: () => string };
const bridge = (window as unknown as { TGAndroid?: Bridge }).TGAndroid;

let lastTouch = 0;
/** A pessoa está usando a tela (rolagem, vídeo): no máximo um aviso a cada 3 s. */
export function intelTouch() {
  const now = Date.now();
  if (now - lastTouch < 3000) return;
  lastTouch = now;
  void api.intelTouch().catch(() => {});
}

let boostTimer: number | null = null;
let pending: number[] = [];
/** Ids na tela: a fila trata estes primeiro (agrupado, a cada 2 s). */
export function intelBoost(ids: number[]) {
  pending = ids.filter((id) => id > 0).slice(0, 200);
  if (boostTimer) return;
  boostTimer = window.setTimeout(() => {
    boostTimer = null;
    void api.intelBoost(pending).catch(() => {});
  }, 2000);
}

function sendPower() {
  if (!bridge?.powerState) return;
  try {
    void api.intelPower(JSON.parse(bridge.powerState())).catch(() => {});
  } catch {
    /* ponte antiga */
  }
}

let started = false;
export function startIntel() {
  if (started) return;
  started = true;
  window.addEventListener("tg-media-busy", intelTouch);
  startFrames();
  if (onAndroid) {
    sendPower();
    setInterval(sendPower, 60_000);
    document.addEventListener("visibilitychange", sendPower);
  }
}

/**
 * Andamento geral da análise (recursos ligados), para o indicador no item
 * "Inteligência": `null` quando está tudo em dia ou nada ligado.
 */
export function intelProgress(st: IntelStatus | undefined): number | null {
  if (!st) return null;
  const on = st.stages.filter((s) => s.total > 0 && STAGE_SETTING[s.stage] && st.settings[STAGE_SETTING[s.stage]]);
  const total = on.reduce((n, s) => n + s.total, 0);
  const done = on.reduce((n, s) => n + Math.min(s.done, s.total), 0);
  if (!total || done >= total) return null;
  return Math.floor((done / total) * 100);
}

const STAGE_SETTING: Record<string, "search" | "people" | "text" | "places" | "duplicates" | "frames"> = { frames: "frames", clip: "search", faces: "people", ocr: "text", place: "places", hash: "duplicates" };

/** Status da análise, atualizado devagar (o indicador não precisa de pressa). */
export function useIntelProgress() {
  const { data } = useQuery({ queryKey: ["intel-status"], queryFn: api.intelStatus, refetchInterval: 15_000 });
  return intelProgress(data);
}
