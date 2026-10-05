/**
 * Originais locais: mídia do vault enviada deste aparelho abre do arquivo
 * local (`/local/<id>`, sem rede; o servidor cai no Telegram se o arquivo
 * sumiu). Mídias do aparelho fora do vault vêm por `/device`.
 */
import { getPort, invoke, vaultScope } from "@tgcloud/ui/core/server";
import type { Media } from "./api";

let token: Promise<string> | null = null;
let tokenValue = "";
export const deviceToken = () =>
  (token ??= invoke<string>("device_token")
    .then((t) => (tokenValue = t))
    .catch(() => ""));
/** Token já conhecido (síncrono; vazio antes da primeira resposta). */
export const tokenNow = () => tokenValue;

/** Põe `src` local nas mídias que têm original aqui. */
export async function withLocal(list: Media[]): Promise<Media[]> {
  if (!list.some((m) => m.local)) return list;
  const t = await deviceToken();
  if (!t) return list;
  // O id é local ao vault: o vault na URL separa os caches ao trocar.
  return list.map((m) => (m.local ? { ...m, src: `http://127.0.0.1:${getPort()}/local/${m.id}?t=${t}&v=${vaultScope()}` } : m));
}

export const deviceUrl = (t: string, uri: string, mime: string, size: number) =>
  `http://127.0.0.1:${getPort()}/device?${new URLSearchParams({ uri, t, mime, size: String(size) })}`;
