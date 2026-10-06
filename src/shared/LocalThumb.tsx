/**
 * Miniatura de um arquivo local (desktop): pasta de backup ainda não enviada,
 * ou original local sem miniatura no vault. Sai do cache em disco; se não
 * houver, é gerada aqui (quadro do vídeo / imagem reduzida) e guardada. Não
 * depende de rede.
 */
import { useEffect, useState } from "react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { getPort } from "@tgcloud/ui/core/server";
import { makeThumb } from "@tgcloud/ui/core/thumbs";
import { deviceToken, deviceUrl } from "../core/local";
import { DeviceThumb } from "./DeviceThumb";

/** Arquivos com miniatura pronta (para não piscar ao remontar). */
export const ready = new Set<string>();
export const failed = new Set<string>();
/** Esperando a vez, por arquivo; o mais recente sai primeiro (é o que está na tela). */
const queue = new Map<string, () => Promise<void>>();
let running = 0;

function pump() {
  while (running < 2 && queue.size) {
    const [src, job] = [...queue].pop()!;
    queue.delete(src);
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

export const localThumbUrl = (t: string, src: string) => `http://127.0.0.1:${getPort()}/localthumb?${new URLSearchParams({ t, src })}`;

/** Gerações em andamento: quem remonta só espera a mesma. */
const waiting = new Map<string, (() => void)[]>();

/**
 * Gera (na fila) e chama `done` quando pronta. Devolve o cancelamento: sem
 * mais ninguém esperando e ainda na fila, a geração não acontece.
 */
export function generateLocal(src: string, mime: string, done: () => void): () => void {
  const cancel = () => {
    const list = waiting.get(src);
    if (!list) return;
    const i = list.indexOf(done);
    if (i >= 0) list.splice(i, 1);
    if (!list.length && queue.delete(src)) waiting.delete(src);
  };
  const list = waiting.get(src);
  if (list) {
    list.push(done);
    return cancel;
  }
  waiting.set(src, [done]);
  queue.set(src, async () => {
    try {
      const t = await deviceToken();
      const { blob } = await makeThumb(deviceUrl(t, src, mime, 0), mime.startsWith("video/"));
      const r = await fetch(localThumbUrl(t, src), { method: "POST", body: blob });
      if (!r.ok) throw new Error(await r.text());
      ready.add(src);
      for (const fn of waiting.get(src) ?? []) fn();
    } catch (e) {
      console.warn("[tgphotos] miniatura local", src, e);
      failed.add(src);
    } finally {
      waiting.delete(src);
    }
  });
  pump();
  return cancel;
}

/**
 * Guarda a miniatura de um arquivo do aparelho antes de ele sair de vista (vai
 * para a lixeira): a Lixeira do app continua mostrando. Chave: a origem sem
 * a query, como a lixeira do aparelho registra.
 */
export async function keepThumb(src: string, mime: string): Promise<void> {
  const key = src.split("?")[0];
  const t = await deviceToken();
  if (!t) return;
  try {
    if (onAndroid) {
      const data = await android.deviceThumb(src, 480);
      if (!data) return;
      const blob = await (await fetch(data)).blob();
      await fetch(localThumbUrl(t, key), { method: "POST", body: blob });
      return;
    }
    if (ready.has(key)) return;
    // A geração não avisa quando falha: não segura a lixeira por isso.
    await Promise.race([new Promise<void>((resolve) => generateLocal(key, mime, resolve)), new Promise((r) => setTimeout(r, 8000))]);
  } catch (e) {
    console.warn("[tgphotos] miniatura para a lixeira", src, e);
  }
}

export function LocalThumb({ src, mime }: { src: string; mime: string }) {
  const [token, setToken] = useState("");
  const [rev, setRev] = useState(0);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void deviceToken().then(setToken);
  }, []);
  if (!token || (missing && !ready.has(src))) return <div className="size-full bg-s3" />;
  return (
    <img
      key={rev}
      src={localThumbUrl(token, src) + (rev ? `&v=${rev}` : "")}
      alt=""
      draggable={false}
      decoding={ready.has(src) ? "sync" : "async"}
      className="size-full object-cover"
      onLoad={() => ready.add(src)}
      onError={() => {
        if (failed.has(src)) return setMissing(true);
        setMissing(true);
        generateLocal(src, mime, () => {
          setMissing(false);
          setRev(Date.now());
        });
      }}
    />
  );
}

/** Miniatura local: a do sistema no Android, a gerada aqui no desktop. */
export function LocalCover({ uri, mime }: { uri: string; mime: string }) {
  return onAndroid ? <DeviceThumb uri={uri} /> : <LocalThumb src={uri} mime={mime} />;
}
