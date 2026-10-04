/**
 * Abrir com / editar / definir como numa mídia que ainda não está no aparelho:
 * baixa primeiro (para DCIM/Restored, como qualquer download) mostrando o
 * andamento, com cancelar; terminado, chama o outro app.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { android } from "@tgcloud/ui/core/android";
import { app } from "@tgcloud/ui/core/app";
import { formatSize } from "@tgcloud/ui/core/format";
import { errText } from "@tgcloud/ui/core/server";
import { transfers, useTransfers } from "@tgcloud/ui/core/transfers";
import { Modal } from "@tgcloud/ui/ui/VaultDialogs";
import { api } from "../core/api";
import { findMedia } from "../core/data";
import { openLocal } from "../core/localActions";
import { nav } from "../core/nav";

export type FetchHow = "view" | "edit" | "attach";

const verb: Record<FetchHow, string> = { view: "abrir", edit: "editar", attach: "definir como" };

export function FetchDialog({ id, how }: { id: number; how: FetchHow }) {
  const m = findMedia(id);
  const [dest, setDest] = useState<string | null>(null);
  const [error, setError] = useState("");
  const ran = useRef(false);
  const t = useTransfers((s) => (dest ? s.list.find((x) => x.kind === "down" && x.dest === dest) : undefined));

  // Começa o download uma vez.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p] = await api.downloadPlan([id]);
        if (!p) throw new Error("a mídia não existe mais no vault");
        const uri = await android.createMedia([app.downloads, p.dir].filter(Boolean).join("/"), p.name, p.mime);
        await api.downloadTargets([{ id: p.id, dest: uri }]);
        if (alive) setDest(uri);
      } catch (e) {
        if (alive) setError(errText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // Terminou: chama o outro app e fecha.
  useEffect(() => {
    if (!t || !m || ran.current) return;
    if (t.state === "done") {
      ran.current = true;
      nav.closeThen(() => openLocal({ mime: m.mime, uri: t.dest }, how));
    } else if (t.state === "error") {
      setError(t.error ?? "não deu para baixar");
    }
  }, [t, m, how]);

  const cancel = () => {
    if (t && t.state !== "done") void transfers.cancel(t);
    nav.close();
  };
  const pct = t && t.size ? Math.min(1, t.done / t.size) : 0;

  return (
    <Modal touch={false} onClose={cancel}>
      <p className="text-[16px] font-semibold">Baixando para {verb[how]}</p>
      <p className="mt-1 truncate text-[13px] text-fg-2">{m?.name ?? "Mídia"}</p>
      {error ? (
        <p className="mt-4 text-[13px] font-medium text-danger">{error}</p>
      ) : (
        <>
          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-s3">
            <div className="h-full rounded-full bg-info transition-[width] duration-300" style={{ width: `${pct * 100}%` }} />
          </div>
          <p className="mt-2 flex items-center gap-2 text-[12px] text-fg-3 tabular">
            <Loader2 size={12} className="animate-spin" />
            {t ? `${formatSize(t.done)} de ${formatSize(t.size)}` : "Preparando…"} · fica em {app.downloads}
          </p>
        </>
      )}
      <div className="mt-6 flex justify-end">
        <button onClick={cancel} className="h-10 rounded-lg px-4 text-[14px] font-semibold text-fg-2 hover:bg-s3 active:bg-s3">
          {error ? "Fechar" : "Cancelar"}
        </button>
      </div>
    </Modal>
  );
}
