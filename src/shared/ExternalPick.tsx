/**
 * Outro app pediu fotos/vídeos (Android: "Escolher foto" → TGPhotos). A
 * mesma escolha da foto do vault (linha do tempo, Álbuns, No aparelho), com
 * o que o pedido aceita (fotos, vídeos) e uma ou várias.
 *
 * Mídia do vault: baixada para o cache (como no "Compartilhar") e entregue
 * pelo FileProvider; mídia do aparelho: entregue pela própria URI (o Kotlin
 * copia). Cancelar (ou o voltar) devolve "cancelado" a quem pediu.
 */
import { useMemo, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { android, type PickRequest } from "@tgcloud/ui/core/android";
import { base } from "@tgcloud/ui/core/base";
import { useBackClose } from "@tgcloud/ui/core/back";
import { errText } from "@tgcloud/ui/core/server";
import { useCurrentVault } from "@tgcloud/ui/core/vault";
import { PickCtx, PickerBody, type Item, type PickRules } from "./PhotoPickerGrid";

/** O pedido aceita este tipo? (sem tipo ou `*\/*`: fotos e vídeos). */
function accepts(mimes: string[]) {
  const list = mimes.filter((m) => m && m !== "*/*");
  return (mime: string) => {
    if (!/^(image|video)\//.test(mime)) return false;
    if (!list.length) return true;
    return list.some((m) => (m.endsWith("/*") ? mime.startsWith(m.slice(0, -1)) : m === mime));
  };
}

export function ExternalPick({ req, touch, onClose }: { req: PickRequest; touch: boolean; onClose: () => void }) {
  const vault = useCurrentVault((s) => s.vault);
  const [chosen, setChosen] = useState<Map<string, Item>>(new Map());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const accept = useMemo(() => accepts(req.mimes), [req.mimes]);

  const cancel = () => {
    android.pickCancel();
    onClose();
  };
  useBackClose(cancel);

  const rules = useMemo<PickRules>(
    () => ({
      accept,
      isPicked: (k) => chosen.has(k),
      onPick: (it) =>
        setChosen((cur) => {
          const next = new Map(req.multiple ? cur : []);
          if (cur.has(it.pick.key)) next.delete(it.pick.key);
          else next.set(it.pick.key, it);
          return next;
        }),
    }),
    [accept, chosen, req.multiple],
  );

  const send = async () => {
    const list = [...chosen.values()];
    setError("");
    const out: { path?: string; uri?: string; mime: string; name: string }[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        setBusy(list.length > 1 ? `Preparando ${i + 1} de ${list.length}…` : "Preparando…");
        if (it.pick.key.startsWith("v:")) out.push({ path: await base.prepareShare(it.m.id), mime: it.m.mime, name: it.m.name });
        else if (it.m.uri) out.push({ uri: it.m.uri, mime: it.m.mime, name: it.m.name });
      }
      android.pickDone(out);
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy("");
    }
  };

  const kinds = useMemo(() => {
    const img = accept("image/jpeg");
    const vid = accept("video/mp4");
    return img && vid ? "fotos e vídeos" : vid ? "vídeos" : "fotos";
  }, [accept]);
  const shown = [...chosen.values()].slice(0, 3);

  return (
    <div className="fixed inset-0 z-[66] flex flex-col bg-canvas anim-sheet" role="dialog" aria-modal="true" aria-label="Escolher para outro app">
      <header className="flex shrink-0 items-center gap-2 px-2 pt-[calc(var(--inset-top,0px)+6px)] pb-1">
        <button type="button" onClick={cancel} className="grid size-11 shrink-0 place-items-center rounded-full text-fg active:bg-s3" aria-label="Cancelar">
          <X size={22} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-heading text-[18px] font-bold tracking-tight text-fg-title">{req.caller ? `Escolher para ${req.caller}` : "Escolher"}</h1>
          <p className="truncate text-[13px] text-fg-2">{req.multiple ? `Toque para marcar ${kinds}` : `Toque para escolher ${kinds === "fotos" ? "uma foto" : kinds === "vídeos" ? "um vídeo" : "uma foto ou vídeo"}`}</p>
        </div>
      </header>

      {vault ? (
        <PickCtx.Provider value={rules}>
          <PickerBody touch={touch} source={{ ...vault, current: true }} />
        </PickCtx.Provider>
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center text-[14px] text-fg-2">Abra um vault para escolher.</div>
      )}

      {(chosen.size > 0 || busy || error) && (
        <div className="glint-top flex shrink-0 items-center gap-3 border-t border-hairline bg-s1 px-3 pt-2.5 pb-[calc(var(--inset-bottom,0px)+10px)] anim-fade">
          {shown.length > 0 && (
            <span className="flex shrink-0 -space-x-3">
              {shown.map((it) => (
                <span key={it.pick.key} className="size-11 overflow-hidden rounded-lg bg-s3 ring-2 ring-s1">
                  {it.pick.preview && <img src={it.pick.preview} alt="" className="size-full object-cover" />}
                </span>
              ))}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {error ? (
              <p className="text-[13px] font-medium text-danger">{error}</p>
            ) : busy ? (
              <p className="flex items-center gap-2 text-[14px] text-fg-2">
                <Loader2 size={15} className="animate-spin" /> {busy}
              </p>
            ) : (
              <p className="text-[14px] font-semibold tabular">{chosen.size === 1 ? "1 escolhida" : `${chosen.size} escolhidas`}</p>
            )}
          </div>
          {chosen.size > 0 && !busy && (
            <button type="button" onClick={() => void send()} className="step flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-brand px-5 text-[15px] font-semibold text-white active:translate-y-px">
              <Check size={18} /> Enviar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
