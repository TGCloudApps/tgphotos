/**
 * Open with / edit / set as on media that is not on the device yet: download it
 * first (to DCIM/Restored, like any download) showing progress, with cancel;
 * once done, calls the other app.
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
import { t, tc } from "../i18n";

export type FetchHow = "view" | "edit" | "attach";


export function FetchDialog({ id, how }: { id: number; how: FetchHow }) {
  const m = findMedia(id);
  const [dest, setDest] = useState<string | null>(null);
  const [error, setError] = useState("");
  const ran = useRef(false);
  const tr = useTransfers((s) => (dest ? s.list.find((x) => x.kind === "down" && x.dest === dest) : undefined));

  // Starts the download once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p] = await api.downloadPlan([id]);
        if (!p) throw new Error(t("fetch.gone"));
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

  // Done: calls the other app and closes.
  useEffect(() => {
    if (!tr || !m || ran.current) return;
    if (tr.state === "done") {
      ran.current = true;
      nav.closeThen(() => openLocal({ mime: m.mime, uri: tr.dest }, how));
    } else if (tr.state === "error") {
      setError(tr.error ?? t("fetch.failed"));
    }
  }, [tr, m, how]);

  const cancel = () => {
    if (tr && tr.state !== "done") void transfers.cancel(tr);
    nav.close();
  };
  const pct = tr && tr.size ? Math.min(1, tr.done / tr.size) : 0;

  return (
    <Modal touch={false} onClose={cancel} back={false}>
      <p className="text-[16px] font-semibold">{t(`fetch.title.${how}`)}</p>
      <p className="mt-1 truncate text-[13px] text-fg-2">{m?.name ?? t("fetch.media")}</p>
      {error ? (
        <p className="mt-4 text-[13px] font-medium text-danger">{error}</p>
      ) : (
        <>
          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-s3">
            <div className="h-full rounded-full bg-info transition-[width] duration-300" style={{ width: `${pct * 100}%` }} />
          </div>
          <p className="mt-2 flex items-center gap-2 text-[12px] text-fg-3 tabular">
            <Loader2 size={12} className="animate-spin" />
            {t("fetch.progress", { status: tr ? t("fetch.sizeOf", { done: formatSize(tr.done), total: formatSize(tr.size) }) : t("external.preparing"), dir: app.downloads })}
          </p>
        </>
      )}
      <div className="mt-6 flex justify-end">
        <button onClick={cancel} className="h-10 rounded-lg px-4 text-[14px] font-semibold text-fg-2 hover:bg-s3 active:bg-s3">
          {error ? tc("common.close") : tc("common.cancel")}
        </button>
      </div>
    </Modal>
  );
}
