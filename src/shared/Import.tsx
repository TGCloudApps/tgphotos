/**
 * Importar fotos e vídeos de um vault do TGDrive: escolher o vault, marcar
 * pastas (ou itens dentro delas) e, se quiser, um álbum de destino. Os
 * arquivos são encaminhados entre os canais (nada é baixado de novo).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, FolderOpen, HardDrive, Loader2, RefreshCw } from "lucide-react";
import { formatSize } from "@tgcloud/ui/core/format";
import { importSources, runImport, type ForeignVault } from "@tgcloud/ui/core/importer";
import { errText, invoke } from "@tgcloud/ui/core/server";
import { useAlbums } from "../core/data";
import { nav } from "../core/nav";

type Source = { uid: string; name: string; mime: string; size: number; folder: string; duration: number | null; mtime: number; have: boolean };
type Report = { imported: number; skipped: number; failed: number };

export function ImportView({ touch }: { touch: boolean }) {
  const [vaults, setVaults] = useState<ForeignVault[] | null>(null);
  const [vault, setVault] = useState<ForeignVault | null>(null);
  const [items, setItems] = useState<Source[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [album, setAlbum] = useState(0);
  const { data: albums = [] } = useAlbums();

  useEffect(() => {
    importSources()
      .then((v) => {
        setVaults(v);
        if (v.length === 1) setVault(v[0]);
      })
      .catch((e) => setError(errText(e)));
  }, []);

  const load = (fresh: boolean) => {
    if (!vault) return;
    setItems(null);
    setError("");
    invoke<Source[]>("import_browse", { vault: vault.id, fresh })
      .then((list) => {
        setItems(list);
        // Começa com tudo que ainda não está aqui marcado.
        setPicked(new Set(list.filter((i) => !i.have).map((i) => i.uid)));
      })
      .catch((e) => setError(errText(e)));
  };
  useEffect(() => load(false), [vault]);

  const folders = useMemo(() => {
    const m = new Map<string, Source[]>();
    for (const i of items ?? []) m.set(i.folder, [...(m.get(i.folder) ?? []), i]);
    return [...m.entries()];
  }, [items]);

  const toggle = (uids: string[]) =>
    setPicked((cur) => {
      const next = new Set(cur);
      const all = uids.every((u) => next.has(u));
      for (const u of uids) {
        if (all) next.delete(u);
        else next.add(u);
      }
      return next;
    });

  const start = () => {
    const uids = [...picked];
    const v = vault!;
    nav.closeThen(() => void runImport<Report>("TGDrive", () => invoke<Report>("import_run", { vault: v.id, uids, album })).catch(() => {}));
  };

  const row = touch ? "min-h-14 px-5" : "min-h-11 px-3";
  const text = touch ? "text-[15px]" : "text-[14px]";

  if (error) return <p className={`px-5 py-6 text-danger ${text}`}>{error}</p>;
  if (!vaults) return <Loading touch={touch} text="Procurando vaults do TGDrive…" />;
  if (!vaults.length) return <p className={`px-5 py-6 text-fg-2 ${text}`}>Nenhum vault do TGDrive nesta conta.</p>;

  if (!vault)
    return (
      <div className="pb-2">
        <p className={`px-5 pb-2 text-fg-2 ${touch ? "text-[14px]" : "text-[13px]"}`}>De qual vault do TGDrive?</p>
        {vaults.map((v) => (
          <button key={v.id} onClick={() => setVault(v)} className={`flex w-full items-center gap-3 text-left ${row} ${touch ? "active:bg-s4" : "rounded-lg hover:bg-s3"}`}>
            <HardDrive size={20} className="shrink-0 text-brand" />
            <span className={`flex-1 truncate font-medium ${text}`}>{v.name}</span>
            <ChevronRight size={18} className="text-fg-3" />
          </button>
        ))}
      </div>
    );

  if (!items) return <Loading touch={touch} text={`Lendo o índice de “${vault.name}”…`} />;

  const all = items.filter((i) => !i.have).map((i) => i.uid);
  const bytes = items.filter((i) => picked.has(i.uid)).reduce((s, i) => s + i.size, 0);

  return (
    <div className="flex min-h-0 flex-col">
      <div className={`flex items-center gap-2 pb-2 ${touch ? "px-5" : "px-1"}`}>
        <p className={`min-w-0 flex-1 text-fg-2 tabular ${touch ? "text-[13px]" : "text-[12px]"}`}>
          {items.length} fotos e vídeos em {folders.length} {folders.length === 1 ? "pasta" : "pastas"}
          {items.length - all.length > 0 && ` · ${items.length - all.length} já estão aqui`}
        </p>
        <button onClick={() => toggle(all)} className="rounded-lg px-2 py-1 text-[13px] font-semibold text-accent hover:bg-s3">
          {all.every((u) => picked.has(u)) ? "Desmarcar tudo" : "Marcar tudo"}
        </button>
        <button onClick={() => load(true)} className="grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-s3" aria-label="Ler de novo">
          <RefreshCw size={15} />
        </button>
      </div>
      <div className={`min-h-0 overflow-y-auto ${touch ? "max-h-[48vh]" : "max-h-[52vh] rounded-xl bg-s2 surface"}`}>
        {folders.map(([folder, list]) => {
          const uids = list.filter((i) => !i.have).map((i) => i.uid);
          const on = uids.length > 0 && uids.every((u) => picked.has(u));
          const some = uids.some((u) => picked.has(u));
          const expanded = open.has(folder);
          return (
            <div key={folder} className="border-b border-hairline last:border-0">
              <div className={`flex items-center gap-2 ${row}`}>
                <Box on={on} some={some} disabled={!uids.length} onClick={() => toggle(uids)} />
                <button
                  onClick={() => setOpen((cur) => (cur.has(folder) ? new Set([...cur].filter((f) => f !== folder)) : new Set([...cur, folder])))}
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
                >
                  <FolderOpen size={18} className="shrink-0 text-fg-3" />
                  <span className={`min-w-0 flex-1 truncate font-medium ${text}`}>{folder || "Raiz do Drive"}</span>
                  <span className="text-[12px] text-fg-3 tabular">{list.length}</span>
                  {expanded ? <ChevronDown size={16} className="text-fg-3" /> : <ChevronRight size={16} className="text-fg-3" />}
                </button>
              </div>
              {expanded &&
                list.map((i) => (
                  <div key={i.uid} className={`flex items-center gap-2 ${touch ? "min-h-12 pr-5 pl-12" : "min-h-9 pr-3 pl-10"} ${i.have ? "opacity-50" : ""}`}>
                    <Box on={picked.has(i.uid)} disabled={i.have} onClick={() => toggle([i.uid])} />
                    <span className={`min-w-0 flex-1 truncate ${touch ? "text-[14px]" : "text-[13px]"}`}>{i.name}</span>
                    <span className="text-[12px] text-fg-3 tabular">{i.have ? "já está aqui" : formatSize(i.size)}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
      <div className={`flex flex-wrap items-center gap-3 pt-4 ${touch ? "px-5 pb-2" : ""}`}>
        <label className={`flex min-w-0 flex-1 items-center gap-2 text-fg-2 ${touch ? "text-[14px]" : "text-[13px]"}`}>
          Álbum
          <select
            value={album}
            onChange={(e) => setAlbum(Number(e.target.value))}
            className="surface h-9 min-w-0 flex-1 rounded-lg border border-line bg-s3 px-2 text-fg outline-none focus:border-brand"
          >
            <option value={0}>Nenhum (só a biblioteca)</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!picked.size}
          onClick={start}
          className={`step rounded-xl bg-brand px-4 font-semibold text-white disabled:bg-s3 disabled:text-fg-off disabled:shadow-none ${touch ? "h-12 w-full text-[15px]" : "h-9 text-[14px]"}`}
        >
          Importar {picked.size} {picked.size === 1 ? "item" : "itens"}
          {bytes > 0 && ` · ${formatSize(bytes)}`}
        </button>
      </div>
    </div>
  );
}

function Box({ on, some, disabled, onClick }: { on: boolean; some?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      aria-pressed={on}
      className={`grid size-5 shrink-0 place-items-center rounded-md border-2 transition-colors disabled:opacity-40 ${
        on ? "border-brand bg-brand text-white" : some ? "border-brand text-brand" : "border-fg-3 text-transparent"
      }`}
    >
      {on ? <Check size={13} strokeWidth={3} /> : some ? <span className="h-0.5 w-2.5 rounded bg-brand" /> : null}
    </button>
  );
}

function Loading({ touch, text }: { touch: boolean; text: string }) {
  return (
    <p className={`flex items-center gap-2 px-5 py-6 text-fg-2 ${touch ? "text-[14px]" : "text-[13px]"}`}>
      <Loader2 size={16} className="animate-spin" /> {text}
    </p>
  );
}
