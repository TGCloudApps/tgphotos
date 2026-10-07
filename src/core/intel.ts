/**
 * Sinais para o trabalho em segundo plano (Rust, intel): energia do aparelho
 * (Android), uso da tela (rolagem, vídeo tocando: ele dá licença) e o que
 * está na tela (vai para a frente da fila).
 */
import { available as onAndroid } from "@tgcloud/ui/core/android";
import { api } from "./api";

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
  if (onAndroid) {
    sendPower();
    setInterval(sendPower, 60_000);
    document.addEventListener("visibilitychange", sendPower);
  }
}
