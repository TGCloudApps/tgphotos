/**
 * Capa de um tile da linha do tempo, sem piscar:
 *
 * - Cadeia de fontes: miniatura do vault (cache em disco, vale offline) →
 *   miniatura local (do sistema no Android, gerada aqui no desktop) → o
 *   próprio arquivo, se for imagem pequena. Falhou uma, tenta a próxima.
 * - Troca sem quadro vazio: a imagem atual fica até a próxima estar
 *   decodificada (ex.: a miniatura do vault acabou de ser gerada).
 */
import { useEffect, useState } from "react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { fileUrl } from "@tgcloud/ui/core/server";
import { thumbUrl } from "@tgcloud/ui/core/thumbs";
import type { Media } from "../core/api";
import { deviceToken, tokenNow } from "../core/local";
import { failed as localFailed, generateLocal, localThumbUrl, ready as localReady } from "../shared/LocalThumb";

/** Já decodificadas nesta sessão: remontar mostra na hora. */
const decoded = new Set<string>();
/** Fontes que falharam (não tentar de novo nesta sessão). */
const broken = new Set<string>();

/** Miniatura local (URL), `null` enquanto resolve, `""` se não há. */
function useLocal(uri: string | null, mime: string, misses: number): string | null {
  const [url, setUrl] = useState<string | null>(() => {
    if (!uri) return "";
    if (onAndroid) return android.deviceThumbNow(uri) || null;
    const t = tokenNow();
    if (!t) return null;
    return localFailed.has(uri) ? "" : localThumbUrl(t, uri);
  });
  useEffect(() => {
    if (!uri || url !== null) return;
    let alive = true;
    if (onAndroid) void android.deviceThumb(uri).then((u) => alive && setUrl(u));
    else void deviceToken().then((t) => alive && setUrl(t ? localThumbUrl(t, uri) : ""));
    return () => {
      alive = false;
    };
  }, [uri, url]);
  // Desktop: miniatura ainda não gerada → gera e recarrega.
  useEffect(() => {
    if (onAndroid || !uri || !url || !broken.has(url) || localReady.has(uri)) return;
    let alive = true;
    generateLocal(uri, mime, () => alive && setUrl(`${url.split("&v=")[0]}&v=${Date.now()}`));
    return () => {
      alive = false;
    };
  }, [uri, url, mime, misses]);
  return url;
}

function sources(m: Media, local: string | null): (string | null)[] {
  const small = m.mime.startsWith("image/") && m.size < 2 * 1024 * 1024 && !/heic|heif/.test(m.mime) ? (m.src ?? (m.id > 0 ? fileUrl(m.id) : null)) : null;
  // `null` = ainda resolvendo: espera antes de pular para a próxima.
  return m.thumb ? [thumbUrl(m.id), local, small] : [local, small];
}

export function Cover({ m, selected }: { m: Media; selected: boolean }) {
  const localUri = m.uri ?? m.local ?? null;
  const [skip, setSkip] = useState(0);
  // Só busca a local se ela pode ser usada (sem miniatura do vault, ou ela falhou).
  const wantLocal = !!localUri && (!m.thumb || skip > 0);
  const local = useLocal(wantLocal ? localUri : null, m.mime, skip);
  const list = sources(m, wantLocal ? local : "");
  let url: string | null = null;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s === null) break; // resolvendo
    if (s && !broken.has(s)) {
      url = s;
      break;
    }
  }

  // Mostrada: só troca quando a nova estiver decodificada.
  const [shown, setShown] = useState<string | null>(() => (url && decoded.has(url) ? url : null));
  useEffect(() => {
    if (!url || url === shown) return;
    if (decoded.has(url)) return setShown(url);
    let alive = true;
    const img = new Image();
    img.src = url;
    img
      .decode()
      .then(() => {
        decoded.add(url);
        if (alive) setShown(url);
      })
      .catch(() => {
        broken.add(url);
        if (alive) setSkip((n) => n + 1);
      });
    return () => {
      alive = false;
    };
  }, [url, shown]);

  const style = { transform: selected ? "scale(0.88)" : undefined, borderRadius: selected ? 8 : undefined };
  if (!shown) return <div className="size-full bg-s3 transition-transform duration-200" style={style} />;
  return <img src={shown} alt="" draggable={false} decoding="sync" className="size-full object-cover transition-transform duration-200" style={style} />;
}
