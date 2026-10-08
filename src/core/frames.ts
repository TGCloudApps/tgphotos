/**
 * Trabalhador de tiras de quadros dos vídeos (docs/inteligencia-de-midia.md
 * §12). O decodificador de vídeo está aqui na interface, então os quadros
 * saem daqui; o Rust decide quando e qual vídeo (`/frames/next`: energia, a
 * pessoa usando o app, intervalo entre envios, pausa do Telegram) e sobe a
 * tira ao vault. Um vídeo por vez, devagar; só com o app aberto.
 */
import { makeStrip } from "@tgcloud/ui/core/thumbs";
import { fileUrl, getPort, vaultScope } from "@tgcloud/ui/core/server";
import { deviceToken } from "./local";

/** Quadros por tira. */
const COUNT = 8;
/** Nada a fazer agora: pergunta de novo depois disso. */
const IDLE_MS = 60_000;
/** Depois de uma tira (o Rust ainda segura o intervalo entre envios). */
const NEXT_MS = 5_000;
/** Uma tira não pode prender o trabalhador. */
const TIMEOUT_MS = 90_000;

type Job = { id: number; local: boolean; duration: number | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function round(): Promise<number> {
  const t = await deviceToken();
  const port = getPort();
  if (!t || !port) return IDLE_MS;
  const base = `http://127.0.0.1:${port}/frames`;
  const res = await fetch(`${base}/next?t=${t}`);
  if (res.status !== 200) return IDLE_MS;
  const job = (await res.json()) as Job;
  // Original no aparelho: lido dele, sem rede.
  const url = job.local ? `http://127.0.0.1:${port}/local/${job.id}?t=${t}&v=${vaultScope()}` : fileUrl(job.id);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let strip;
  try {
    strip = await makeStrip(url, COUNT, ctrl.signal);
  } catch (e) {
    console.warn("[frames] quadros do vídeo", job.id, e);
    await fetch(`${base}/${job.id}/fail?t=${t}`, { method: "POST" }).catch(() => {});
    return NEXT_MS;
  } finally {
    clearTimeout(timer);
  }
  const qs = new URLSearchParams({ t, w: String(strip.w), h: String(strip.h), times: strip.times.join(",") });
  const put = await fetch(`${base}/${job.id}?${qs}`, { method: "POST", body: strip.blob });
  // 429: agora não dá para enviar (intervalo, pausa do Telegram); a tira é refeita depois.
  if (put.status === 429) return IDLE_MS;
  if (!put.ok) console.warn("[frames] enviar tira", job.id, await put.text());
  return NEXT_MS;
}

let started = false;
export function startFrames() {
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
