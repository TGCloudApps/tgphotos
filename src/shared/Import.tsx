import { AppLogo } from "@tgcloud/ui/ui/AppLogo";
import { useVaultPermission } from "@tgcloud/ui/core/vaultPermissions";
import { VaultPermissionNotice } from "@tgcloud/ui/ui/VaultPermissionNotice";
import { detectShell } from "@tgcloud/ui/core/platform";
import { currentVault } from "@tgcloud/ui/core/vault";
/**
 * Import photos and videos from a TGDrive vault: choose the vault, mark
 * folders (or items inside them) and, optionally, a destination album. The
 * files are forwarded between the channels (nothing is downloaded again).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { formatSize } from "@tgcloud/ui/core/format";
import { importSources, runImport, type ForeignVault } from "@tgcloud/ui/core/importer";
import { errText, invoke } from "@tgcloud/ui/core/server";
import { useAlbums } from "../core/data";
import { nav } from "../core/nav";
import { t, tc } from "../i18n";

type Source = { uid: string; name: string; mime: string; size: number; folder: string; duration: number | null; mtime: number; have: boolean };
type Report = { imported: number; skipped: number; failed: number };

export function ImportView({ touch }: { touch: boolean }) {
  const mayWrite = useVaultPermission("write");
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
        // Starts with everything not here yet selected.
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
    if (!mayWrite) return;
    const uids = [...picked];
    const v = vault!;
    nav.closeThen(() => void runImport<Report>("TGDrive", () => invoke<Report>("import_run", { vault: v.id, uids, album })).catch(() => {}));
  };

  const row = touch ? "min-h-14 px-5" : "min-h-11 px-3";
  const text = touch ? "text-[15px]" : "text-[14px]";

  if (error) return <p className={`px-5 py-6 text-danger ${text}`}>{error}</p>;
  if (!vaults) return <Loading touch={touch} text={t("import.searching")} />;
  if (!vaults.length) return <p className={`px-5 py-6 text-fg-2 ${text}`}>{t("import.noVaults")}</p>;

  if (!vault)
    return (
      <div className="pb-2">
        <p className={`px-5 pb-2 text-fg-2 ${touch ? "text-[14px]" : "text-[13px]"}`}>{t("import.whichVault")}</p>
        {vaults.map((v) => (
          <button key={v.id} onClick={() => setVault(v)} className={`flex w-full items-center gap-3 text-left ${row} ${touch ? "active:bg-s4" : "rounded-lg hover:bg-s3"}`}>
            <AppLogo id="tgdrive" size={28} className="shrink-0 text-brand" />
            <span className={`flex-1 truncate font-medium ${text}`}>{v.name}</span>
            <ChevronRight size={18} className="text-fg-3" />
          </button>
        ))}
      </div>
    );

  if (!items) return <Loading touch={touch} text={t("import.reading", { name: vault.name })} />;

  const all = items.filter((i) => !i.have).map((i) => i.uid);
  const bytes = items.filter((i) => picked.has(i.uid)).reduce((s, i) => s + i.size, 0);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-4 space-y-2 rounded-xl border border-hairline bg-s2 p-4">
        <p className="text-sm text-fg-2">{tc("import.flowSource", { name: vault.name })}</p>
        <p className="font-semibold">{tc("import.flowTarget", { name: currentVault()?.name ?? "" })}</p>
        <button type="button" onClick={() => { setVault(null); setError(""); }} className="min-h-10 rounded-lg px-3 font-semibold text-accent hover:bg-s3">{tc("import.changeSource")}</button>
      </div>
      <div className={`flex items-center gap-2 pb-2 ${touch ? "px-5" : "px-1"}`}>
        <p className={`min-w-0 flex-1 text-fg-2 tabular ${touch ? "text-[13px]" : "text-[12px]"}`}>
          {t("import.summary", { n: items.length, folders: t("import.folders", { n: folders.length }) })}
          {items.length - all.length > 0 && ` · ${t("import.alreadyHere", { n: items.length - all.length })}`}
        </p>
        <button onClick={() => toggle(all)} className="rounded-lg px-2 py-1 text-[13px] font-semibold text-accent hover:bg-s3">
          {all.every((u) => picked.has(u)) ? t("import.unmarkAll") : t("import.markAll")}
        </button>
        <button onClick={() => load(true)} className="grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-s3" aria-label={t("import.reload")}>
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
                <Box label={folder || t("import.root")} on={on} some={some} disabled={!uids.length} onClick={() => toggle(uids)} />
                <button
                  onClick={() => setOpen((cur) => (cur.has(folder) ? new Set([...cur].filter((f) => f !== folder)) : new Set([...cur, folder])))}
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
                >
                  <FolderOpen size={18} className="shrink-0 text-fg-3" />
                  <span className={`min-w-0 flex-1 truncate font-medium ${text}`}>{folder || t("import.root")}</span>
                  <span className="text-[12px] text-fg-3 tabular">{list.length}</span>
                  {expanded ? <ChevronDown size={16} className="text-fg-3" /> : <ChevronRight size={16} className="text-fg-3" />}
                </button>
              </div>
              {expanded &&
                list.map((i) => (
                  <div key={i.uid} className={`flex items-center gap-2 ${touch ? "min-h-12 pr-5 pl-12" : "min-h-9 pr-3 pl-10"} ${i.have ? "opacity-50" : ""}`}>
                    <Box label={i.name} on={picked.has(i.uid)} disabled={i.have} onClick={() => toggle([i.uid])} />
                    <span className={`min-w-0 flex-1 truncate ${touch ? "text-[14px]" : "text-[13px]"}`}>{i.name}</span>
                    <span className="text-[12px] text-fg-3 tabular">{i.have ? t("import.itemHere") : formatSize(i.size)}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
      <div className={`flex flex-wrap items-center gap-3 pt-4 ${touch ? "px-5 pb-2" : ""}`}>
        <label className={`flex min-w-0 flex-1 flex-wrap items-center gap-2 text-fg-2 ${touch ? "text-[14px]" : "text-[13px]"}`}>
          {t("import.album")}
          {detectShell() === "tv" ? <div className="flex w-full flex-col gap-2">
            {[{ id: 0, name: t("import.noAlbum") }, ...albums].map(a => <button key={a.id} type="button" aria-pressed={album === a.id} onClick={() => setAlbum(a.id)} className={`flex min-h-12 items-center gap-3 rounded-xl px-4 py-3 text-left ${album === a.id ? "bg-brand-soft text-accent" : "bg-s3"}`}><Check size={20} className={album === a.id ? "" : "opacity-0"} />{a.name}</button>)}
          </div> : <select
            value={album}
            onChange={(e) => setAlbum(Number(e.target.value))}
            className="surface h-9 min-w-0 flex-1 rounded-lg border border-line bg-s3 px-2 text-fg outline-none focus:border-brand"
          >
            <option value={0}>{t("import.noAlbum")}</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>}
        </label>
        <VaultPermissionNotice />
        <button
          disabled={!picked.size || !mayWrite}
          onClick={start}
          className={`step rounded-xl bg-brand px-4 font-semibold text-white disabled:bg-s3 disabled:text-fg-off disabled:shadow-none ${touch ? "h-12 w-full text-[15px]" : "h-9 text-[14px]"}`}
        >
          {bytes > 0 ? t("import.runSize", { n: picked.size, size: formatSize(bytes) }) : t("import.run", { n: picked.size })}
        </button>
      </div>
    </div>
  );
}

function Box({ label, on, some, disabled, onClick }: { label: string; on: boolean; some?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
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
