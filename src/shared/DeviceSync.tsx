/**
 * Device trash in the UI: warning and resolution of what is "out of sync"
 * (vault trash and this device's trash disagreeing) and "free up space".
 * The shells put the content in a sheet (mobile) or dialog (desktop).
 */
import { useState, type ReactNode } from "react";
import { HardDriveUpload, RefreshCwOff } from "lucide-react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { formatSize } from "@tgcloud/ui/core/format";
import { thumbUrl } from "@tgcloud/ui/core/thumbs";
import { useDevice } from "../core/deviceStore";
import { freeSpace, outOfSync } from "../core/deviceTrash";
import { nav } from "../core/nav";
import { fmtNumber } from "@tgcloud/ui/i18n";
import { rich, t, tc } from "../i18n";

/** Shell button: label, action and whether it is the primary one. */
export type Btn = (label: string, run: () => void, primary?: boolean, disabled?: boolean) => ReactNode;

/** In Trash: how many items are out of sync, with the shortcut to resolve. */
export function OutOfSyncBanner({ touch }: { touch: boolean }) {
  const n = useDevice((s) => s.out.vaultOnly.length + s.out.deviceOnly.length);
  if (!onAndroid || !n) return null;
  return (
    <button
      onClick={() => nav.open({ type: "out-of-sync" })}
      className={`surface flex w-full items-center gap-3 rounded-xl border border-hairline bg-s2 text-left ${touch ? "min-h-14 px-3.5 py-2.5 active:brightness-110" : "min-h-12 px-3.5 py-2 hover:brightness-110"}`}
    >
      <RefreshCwOff size={20} className="shrink-0 text-fg-2" />
      <span className="min-w-0 flex-1">
        <span className={`block font-semibold text-fg ${touch ? "text-[14px]" : "text-[13px]"}`}>{t("deviceSync.banner", { n })}</span>
        <span className="block text-[12px] text-fg-2">{t("deviceSync.bannerText")}</span>
      </span>
      <span className="shrink-0 text-[13px] font-semibold text-accent">{t("deviceSync.resolve")}</span>
    </button>
  );
}

/** A few vault thumbnails (the ones that exist). */
function Strip({ ids }: { ids: number[] }) {
  const shown = ids.slice(0, 6);
  return (
    <div className="mt-2 flex gap-1.5">
      {shown.map((id) => (
        <div key={id} className="size-11 shrink-0 overflow-hidden rounded-md bg-s3">
          <img src={thumbUrl(id)} alt="" className="size-full object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
        </div>
      ))}
      {ids.length > shown.length && <div className="grid size-11 shrink-0 place-items-center rounded-md bg-s3 text-[12px] font-semibold text-fg-2 tabular">+{ids.length - shown.length}</div>}
    </div>
  );
}

function Group({ title, text, ids, children }: { title: string; text: string; ids: number[]; children: ReactNode }) {
  return (
    <section className="surface rounded-xl bg-s3 p-3.5">
      <p className="text-[14px] font-semibold">{title}</p>
      <p className="mt-0.5 text-[12px] text-fg-2">{text}</p>
      <Strip ids={ids} />
      <div className="mt-3 flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

/** Both sides of the disagreement, each with its two exits. */
export function OutOfSyncView({ button, done }: { button: Btn; done: () => void }) {
  const { vaultOnly, deviceOnly } = useDevice((s) => s.out);
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<boolean>) => () => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  if (!vaultOnly.length && !deviceOnly.length) {
    return (
      <>
        <p className="text-[14px] text-fg-2">{t("deviceSync.inSync")}</p>
        <div className="mt-4 flex justify-end">{button(tc("common.close"), done, true)}</div>
      </>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-fg-2">
        {t("deviceSync.explain")}
      </p>
      {vaultOnly.length > 0 && (
        <Group
          title={t("deviceSync.vaultOnly", { n: vaultOnly.length })}
          text={t("deviceSync.vaultOnlyText")}
          ids={vaultOnly.map((l) => l.media_id)}
        >
          {button(t("deviceSync.trashOnDevice"), act(() => outOfSync.trashOnDevice(vaultOnly)), true, busy)}
          {button(t("deviceSync.restoreInVault"), act(() => outOfSync.restoreInVault(vaultOnly)), false, busy)}
        </Group>
      )}
      {deviceOnly.length > 0 && (
        <Group
          title={t("deviceSync.deviceOnly", { n: deviceOnly.length })}
          text={t("deviceSync.deviceOnlyText")}
          ids={deviceOnly.map((i) => i.media_id)}
        >
          {button(t("deviceSync.restoreOnDevice"), act(() => outOfSync.restoreOnDevice(deviceOnly)), true, busy)}
          {button(t("deviceSync.trashInVault"), act(() => outOfSync.trashInVault(deviceOnly)), false, busy)}
        </Group>
      )}
    </div>
  );
}

/** Collections: shortcut to free up space when there are originals already in the vault. */
export function FreeSpaceEntry({ touch }: { touch: boolean }) {
  const free = useDevice((s) => s.freeable);
  if (!free.length) return null;
  const bytes = free.reduce((a, l) => a + l.size, 0);
  return (
    <button
      onClick={() => nav.open({ type: "free-space" })}
      className={`surface flex items-center gap-3 rounded-xl bg-s1 px-3.5 text-left ${touch ? "col-span-2 min-h-14 py-2 active:bg-s3" : "min-h-12 py-1.5 hover:bg-s3"}`}
    >
      <HardDriveUpload size={20} className="shrink-0 text-brand" />
      <span className="min-w-0">
        <span className={`block font-semibold text-fg ${touch ? "text-[15px]" : "text-[14px]"}`}>{t("deviceSync.freeSpace")}</span>
        <span className="block truncate text-[12px] text-fg-2 tabular">{t("deviceSync.inVault", { size: formatSize(bytes) })}</span>
      </span>
    </button>
  );
}

/** Delete from the device the originals already in the vault. */
export function FreeSpaceView({ button, done }: { button: Btn; done: () => void }) {
  const free = useDevice((s) => s.freeable);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const bytes = free.reduce((a, l) => a + l.size, 0);
  // Many items: Android confirms in batches of 500, unless media management is enabled.
  const manage = onAndroid ? android.manageMedia() : null;
  const askEach = !!manage?.supported && !manage.granted && free.length > 500;
  if (!free.length) {
    return (
      <>
        <p className="text-[14px] text-fg-2">{t("deviceSync.nothingToFree")}</p>
        <div className="mt-4 flex justify-end">{button(tc("common.close"), done, true)}</div>
      </>
    );
  }
  return (
    <>
      <p className="text-[14px] text-fg-2">
        {rich("deviceSync.freeText", { b: (s) => <b className="text-fg">{s}</b> }, { n: free.length, size: formatSize(bytes) })}
      </p>
      <p className="mt-2 text-[13px] text-fg-3">
        {onAndroid ? t("deviceSync.androidGone") : t("deviceSync.systemTrash")}
      </p>
      {askEach && (
        <p className="mt-2 text-[13px] text-fg-3">
          {t("deviceSync.askEach", { n: 500 })}{" "}
          <button type="button" onClick={() => void android.requestManageMedia()} className="font-semibold text-accent">
            {t("deviceSync.allowAll")}
          </button>
        </p>
      )}
      {progress && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-s4">
            <div className="h-full bg-brand transition-[width] duration-200" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <p className="mt-1.5 text-[12px] text-fg-2 tabular">
            {t("deviceSync.progress", { done: fmtNumber(progress.done), total: fmtNumber(progress.total) })}
          </p>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        {button(tc("common.cancel"), done, false, busy)}
        {button(
          busy ? t("deviceSync.freeing") : t("deviceSync.freeN", { size: formatSize(bytes) }),
          () => {
            setBusy(true);
            void freeSpace(free, (n, total) => setProgress({ done: n, total })).then((ok) => {
              setBusy(false);
              setProgress(null);
              if (ok) done();
            });
          },
          true,
          busy,
        )}
      </div>
    </>
  );
}
