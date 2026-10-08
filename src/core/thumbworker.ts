/**
 * Trabalhador de miniaturas em segundo plano (docs/inteligencia-de-midia.md
 * §12): gera as miniaturas que faltam no vault (fotos e vídeos), sem esperar
 * a mídia aparecer na tela, e a tira de quadros de cada vídeo. O
 * decodificador de vídeo está aqui na interface; o Rust decide quando e o
 * quê (`/thumbs/next`: energia, a pessoa usando o app, intervalo entre
 * envios, pausa do Telegram) e já gera sozinho as das fotos enviadas daqui.
 * Um item por vez, devagar; só com o app aberto.
 */
import { refreshSoon } from "@tgcloud/ui/core/refresh";
import { fileUrl, getPort, vaultScope } from "@tgcloud/ui/core/server";
import { generateThumb, makeStrip, Paused } from "@tgcloud/ui/core/thumbs";
import { deviceToken } from "./local";

/** Quadros por tira. */
const COUNT = 8;
/** Nada a fazer agora: pergunta de novo depois disso. */
const IDLE_MS = 60_000;
/** Depois de um item (o Rust ainda segura o intervalo entre envios). */
const NEXT_MS = 5_000;
/** Um item não pode prender o trabalhador. */
const TIMEOUT_MS = 90_000;

type Job = { id: number; name: string; mime: string; size: number; local: boolean; thumb: boolean; frames: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function round(): Promise<number> {
  const t = await deviceToken();
  const port = getPort();
  if (!t || !port) return IDLE_MS;
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/thumbs/next?t=${t}`);
  if (res.status !== 200) return IDLE_MS;
  const job = (await res.json()) as Job;
  const fail = (what: "thumb" | "frames") => fetch(`${base}/thumbs/${job.id}/fail?t=${t}&what=${what}`, { method: "POST" }).catch(() => {});
  // Original no aparelho: lido dele, sem rede.
  const src = job.local ? `${base}/local/${job.id}?t=${t}&v=${vaultScope()}` : fileUrl(job.id);

  if (job.thumb) {
    try {
      await withTimeout((signal) => generateThumb({ id: job.id, name: job.name, mime: job.mime, size: job.size, thumb: false, duration: null, src }, signal));
      refreshSoon();
    } catch (e) {
      if (e instanceof Paused) return IDLE_MS;
      console.warn("[miniaturas] miniatura", job.id, e);
      await fail("thumb");
      return NEXT_MS;
    }
    if (!job.frames) {
      await fetch(`${base}/thumbs/${job.id}/done?t=${t}`, { method: "POST" }).catch(() => {});
      return NEXT_MS;
    }
  }

  let strip;
  try {
    strip = await withTimeout((signal) => makeStrip(src, COUNT, signal));
  } catch (e) {
    console.warn("[miniaturas] quadros do vídeo", job.id, e);
    await fail("frames");
    return NEXT_MS;
  }
  const qs = new URLSearchParams({ t, w: String(strip.w), h: String(strip.h), times: strip.times.join(",") });
  const put = await fetch(`${base}/frames/${job.id}?${qs}`, { method: "POST", body: strip.blob });
  // 429: agora não dá para enviar (intervalo, pausa do Telegram); a tira é refeita depois.
  if (put.status === 429) return IDLE_MS;
  if (!put.ok) console.warn("[miniaturas] enviar tira", job.id, await put.text());
  return NEXT_MS;
}

let started = false;
export function startThumbWorker() {
  if (started) return;
  started = true;
  void (async () => {
    // Deixa o app abrir antes.
    await sleep(20_000);
    for (;;) {
      const wait = await round().catch(() => IDLE_MS);
      await sleep(wait);
    }
  })();
}
