import { canUseVault } from "@tgcloud/ui/core/vaultPermissions";
import { detectShell } from "@tgcloud/ui/core/platform";
/**
 * Import from Google Photos (takeout). Three moments in a single window:
 *  1. choose the .zip files downloaded from takeout (or drag them here; also accepts the folder);
 *  2. review the summary (what was found, what is missing) and adjust;
 *  3. follow the import, which runs in the background and survives closing the window.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  Archive,
  CalendarRange,
  CircleCheck,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileArchive,
  FolderOpen,
  Heart,
  HardDrive,
  Images,
  Library,
  Loader2,
  Pause,
  Play,
  Plus,
  TriangleAlert,
  Video,
  X,
} from "lucide-react";
import { formatSize } from "@tgcloud/ui/core/format";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { mocked } from "@tgcloud/ui/core/server";
import { notifyError } from "@tgcloud/ui/core/notices";
import { Button, IconButton } from "@tgcloud/ui/desktop/ui";
import { nav } from "../core/nav";
import { isRunning, takeout, useTakeout, watchTakeout, type TakeoutStatus, type TakeoutSummary } from "../core/takeout";
import { Switch } from "./Switch";
import { fmtNumber } from "@tgcloud/ui/i18n";
import { rich, t, tc } from "../i18n";

/** Mobile: the layout is touch-based (tall buttons, no drag and drop). */
const Touch = createContext(false);
const useTouch = () => useContext(Touch);

/** Window (desktop) or sheet (mobile, tall and wide) button. */
function Act({ children, onClick, variant, disabled }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "ghost"; disabled?: boolean }) {
  const touch = useTouch();
  if (!touch)
    return (
      <Button variant={variant} onClick={onClick} disabled={disabled}>
        {children}
      </Button>
    );
  const look = { primary: "step bg-brand text-white", secondary: "surface bg-s3 text-fg", ghost: "text-fg-2" }[variant ?? "secondary"];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-semibold active:brightness-90 disabled:bg-s3 disabled:text-fg-off disabled:shadow-none [&>svg]:size-5 ${look}`}
    >
      {children}
    </button>
  );
}

/** Footer always visible (the window or sheet scrolls over it). */
function Footer({ note, children }: { note?: string; children: ReactNode }) {
  const touch = useTouch();
  return (
    <div className={`sticky bottom-0 z-10 -mx-1 bg-s2 px-1 pt-4 pb-1 ${touch ? "flex flex-col gap-2" : "mt-2 flex items-center justify-between gap-3"}`}>
      {note && <p className={`min-w-0 text-[12px] leading-4 text-fg-3 ${touch ? "order-last text-center" : ""}`}>{note}</p>}
      <div className={`flex shrink-0 gap-2 ${touch ? "flex-col-reverse" : "ml-auto"}`}>{children}</div>
    </div>
  );
}

const TAKEOUT_URL = "https://takeout.google.com/";
const n = (v: number) => fmtNumber(v);

async function openExternal(url: string) {
  if (isTauri()) await (await import("@tauri-apps/plugin-opener")).openUrl(url);
  else window.open(url, "_blank", "noopener");
}

/** "2 h 10 min", "8 min", "40 s". */
function span(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("google.duration.s", { s });
  const m = Math.round(s / 60);
  if (m < 60) return t("google.duration.m", { m });
  const h = Math.floor(m / 60);
  return m % 60 ? t("google.duration.hm", { h, m: m % 60 }) : t("google.duration.h", { h });
}

export function GoogleImportView({ touch = false }: { touch?: boolean }) {
  const status = useTakeout((s) => s.status);
  const [paths, setPaths] = useState<string[]>([]);
  const [summary, setSummary] = useState<TakeoutSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [opts, setOpts] = useState({ albums: true, skipEdited: false });
  const [starting, setStarting] = useState(false);

  // Follows while the window is open (the progress notice stays for when it closes).
  useEffect(() => {
    useTakeout.setState((s) => ({ viewing: s.viewing + 1 }));
    watchTakeout();
    return () => useTakeout.setState((s) => ({ viewing: s.viewing - 1 }));
  }, []);

  const scan = useCallback(async (list: string[]) => {
    if (!list.length) {
      setPaths([]);
      setSummary(null);
      return;
    }
    setScanning(true);
    setError("");
    try {
      const s = await takeout.scan(list, pickedNames());
      setPaths(list);
      setSummary(s);
    } catch (e) {
      setError(takeout.errText(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const add = useCallback(
    (more: string[]) => {
      const next = [...new Set([...paths, ...more])];
      void scan(next);
    },
    [paths, scan],
  );

  const busy = isRunning(status);
  const result = status.state === "done" || status.state === "stopped" || status.state === "error";
  const phase = busy || result ? "run" : summary ? "review" : "pick";

  const start = async () => {
    if (!canUseVault("write")) return;
    setStarting(true);
    try {
      await takeout.start(opts);
    } catch (e) {
      notifyError(e);
    } finally {
      setStarting(false);
    }
  };

  // Drop system files onto the window.
  const [over, setOver] = useState(false);
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    if (!isTauri() || phase === "run") return;
    let off: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent(({ payload: p }) => {
        if (p.type === "enter" || p.type === "over") setOver(true);
        else if (p.type === "leave") setOver(false);
        else if (p.type === "drop") {
          setOver(false);
          if (p.paths.length) addRef.current(p.paths);
        }
      });
      if (disposed) un();
      else off = un;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [phase]);

  return (
    <Touch.Provider value={touch}>
    <div className={detectShell() === "tv" ? "tv-google-import" : touch ? "px-5 pb-3" : "-mr-2 max-h-[calc(100vh-8rem)] overflow-y-auto pr-2"}>
      <Header phase={phase} status={status} />
      {phase === "pick" && <Pick over={over} scanning={scanning} error={error} onAdd={add} />}
      {phase === "review" && summary && (
        <Review
          summary={summary}
          scanning={scanning}
          error={error}
          opts={opts}
          setOpts={setOpts}
          starting={starting}
          onAdd={add}
          onRemove={(p) => void scan(paths.filter((x) => x !== p))}
          onStart={() => void start()}
          over={over}
        />
      )}
      {phase === "run" && (
        <Run
          status={status}
          onResume={() => void start()}
          onAgain={() => {
            void takeout.reset();
            setSummary(null);
            setPaths([]);
          }}
        />
      )}
    </div>
    </Touch.Provider>
  );
}

function Header({ phase, status }: { phase: "pick" | "review" | "run"; status: TakeoutStatus }) {
  const title =
    phase === "pick"
      ? t("google.title.pick")
      : phase === "review"
        ? t("google.title.review")
        : status.state === "done"
          ? t("google.title.done")
          : status.state === "stopped"
            ? t("google.title.stopped")
            : status.state === "error"
              ? t("google.title.error")
              : status.state === "stopping"
                ? t("google.title.stopping")
                : t("google.title.running");
  const sub =
    phase === "pick"
      ? t("google.sub.pick")
      : phase === "review"
        ? t("google.sub.review")
        : isRunning(status)
          ? t("google.sub.running")
          : "";
  return (
    <div className="flex items-start gap-3 pb-4">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
        {phase === "run" && status.state === "done" ? <CircleCheck size={24} /> : <Images size={24} />}
      </span>
      <div className="min-w-0">
        <h2 className="text-[17px] leading-6 font-semibold">{title}</h2>
        {sub && <p className="text-[13px] leading-5 text-fg-2">{sub}</p>}
      </div>
    </div>
  );
}

// ---- 1. pick -------------------------------------------------------------------------

/** Display name of the files chosen on Android (the URI does not carry the name). */
const names = new Map<string, string>();
export const pickedNames = () => Object.fromEntries(names);

async function pickFiles(directory: boolean): Promise<string[]> {
  if (onAndroid) {
    const files = await android.pickFiles();
    for (const f of files) names.set(f.uri, f.name);
    return files.map((f) => f.uri);
  }
  if (!isTauri()) return mocked() ? [directory ? "/mock/Downloads" : `/mock/takeout-20261015T173816Z-1-00${Math.ceil(Math.random() * 9)}.zip`] : [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open(
    directory
      ? { directory: true, title: t("google.pickFolderTitle") }
      : { multiple: true, title: t("google.pickFilesTitle"), filters: [{ name: t("google.filterName"), extensions: ["zip"] }] },
  );
  return r == null ? [] : Array.isArray(r) ? r : [r];
}

function Pick({ over, scanning, error, onAdd }: { over: boolean; scanning: boolean; error: string; onAdd: (p: string[]) => void }) {
  const touch = useTouch();
  const choose = async (dir: boolean) => {
    try {
      const p = await pickFiles(dir);
      if (p.length) onAdd(p);
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <div>
      <div
        className={`flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-9 text-center transition-colors ${
          over ? "border-brand bg-brand-soft" : "border-line bg-s1"
        }`}
      >
        {scanning ? (
          <>
            <Loader2 size={34} className="animate-spin text-brand" />
            <p className="mt-3 text-[15px] font-semibold">{t("google.scanning")}</p>
            <p className="mt-1 text-[13px] text-fg-2">{t("google.scanningText")}</p>
          </>
        ) : (
          <>
            <FileArchive size={38} className={over ? "text-brand" : "text-fg-3"} />
            <p className="mt-3 text-[15px] font-semibold">{over ? t("google.dropToAdd") : touch || detectShell() === "tv" ? t("google.chooseZips") : t("google.dragZips")}</p>
            <p className="mt-1 max-w-[420px] text-[13px] text-fg-2">{t("google.noExtract")}</p>
            <div className={`mt-5 flex justify-center gap-2 ${touch ? "w-full flex-col" : "flex-wrap"}`}>
              <Act variant="primary" onClick={() => void choose(false)}>
                <FileArchive /> {t("google.pickZips")}
              </Act>
              {!touch && (
                <Act onClick={() => void choose(true)}>
                  <FolderOpen /> {t("google.pickFolder")}
                </Act>
              )}
            </div>
            {touch && <p className="mt-3 text-[12px] text-fg-3">{t("google.readInPlace")}</p>}
          </>
        )}
      </div>
      {error && <Banner tone="danger" icon={<TriangleAlert />} text={error} />}

      <div className="surface mt-4 rounded-xl bg-s1 p-4">
        <p className="text-[13px] font-semibold">{t("google.howTitle")}</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] leading-5 text-fg-2">
          <li>{rich("google.how1", { b: (x) => <span className="font-medium text-fg">{x}</span> })}</li>
          <li>{t("google.how2")}</li>
          <li>{t("google.how3")}</li>
        </ol>
        <button onClick={() => void openExternal(TAKEOUT_URL)} className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-accent hover:underline">
          {t("google.openTakeout")} <ExternalLink size={14} />
        </button>
      </div>
    </div>
  );
}

// ---- 2. review -----------------------------------------------------------------------

function Review({
  summary: s,
  scanning,
  error,
  opts,
  setOpts,
  starting,
  onAdd,
  onRemove,
  onStart,
  over,
}: {
  summary: TakeoutSummary;
  scanning: boolean;
  error: string;
  opts: { albums: boolean; skipEdited: boolean };
  setOpts: (o: { albums: boolean; skipEdited: boolean }) => void;
  starting: boolean;
  onAdd: (p: string[]) => void;
  onRemove: (path: string) => void;
  onStart: () => void;
  over: boolean;
}) {
  const [showAlbums, setShowAlbums] = useState(false);
  const total = s.photos + s.videos;
  const edited = opts.skipEdited ? s.edited : 0;
  const todo = Math.max(0, total - edited - s.doneBefore);
  const onlyInfo = total === 0;
  const period = s.firstYear && s.lastYear ? (s.firstYear === s.lastYear ? String(s.firstYear) : `${s.firstYear} – ${s.lastYear}`) : "—";
  const more = async (dir: boolean) => {
    try {
      const p = await pickFiles(dir);
      if (p.length) onAdd(p);
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <div className={`relative ${over ? "rounded-2xl ring-2 ring-brand" : ""}`}>
      {/* what was chosen */}
      <div className="surface overflow-hidden rounded-xl bg-s1">
        {s.sources.map((src) => (
          <div key={src.path} className="flex h-11 items-center gap-3 border-b border-hairline px-3 last:border-0">
            {src.kind === "zip" ? <FileArchive size={18} className="shrink-0 text-brand" /> : <FolderOpen size={18} className="shrink-0 text-brand" />}
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={src.path}>
              {src.name}
            </span>
            <span className="text-[12px] text-fg-3 tabular">
              {t("google.sourceInfo", { n: src.media, size: formatSize(src.bytes) })}
            </span>
            <IconButton label={t("google.removeSource")} onClick={() => onRemove(src.path)} disabled={scanning}>
              <X />
            </IconButton>
          </div>
        ))}
        <div className="flex items-center gap-1 px-2 py-1.5">
          <Button variant="ghost" onClick={() => void more(false)} disabled={scanning}>
            <Plus /> {t("google.addParts")}
          </Button>
          {!onAndroid && (
            <Button variant="ghost" onClick={() => void more(true)} disabled={scanning}>
              <FolderOpen /> {t("google.folder")}
            </Button>
          )}
          {scanning && (
            <span className="ml-auto flex items-center gap-2 pr-2 text-[12px] text-fg-2">
              <Loader2 size={14} className="animate-spin" /> {t("google.readingShort")}
            </span>
          )}
        </div>
      </div>
      {error && <Banner tone="danger" icon={<TriangleAlert />} text={error} />}

      {/* numbers */}
      <div className={`mt-4 grid grid-cols-3 gap-2 ${onlyInfo ? "hidden" : ""}`}>
        <Stat icon={<Images />} label={t("google.stat.photos")} value={n(s.photos)} />
        <Stat icon={<Video />} label={t("google.stat.videos")} value={n(s.videos)} />
        <Stat icon={<HardDrive />} label={t("google.stat.size")} value={formatSize(s.bytes)} />
        <Stat icon={<Library />} label={t("google.stat.albums")} value={n(s.albums.length)} />
        <Stat icon={<Heart />} label={t("google.stat.favorites")} value={n(s.favorites)} />
        <Stat icon={<CalendarRange />} label={t("google.stat.period")} value={period} />
      </div>

      {/* warnings */}
      {s.withoutSide > 0 && (
        <Banner
          tone="warning"
          icon={<TriangleAlert />}
          title={t("google.withoutSide", { n: s.withoutSide })}
          text={t("google.withoutSideText")}
        />
      )}
      {s.fixable > 0 && (
        <Banner
          tone="info"
          icon={<CircleCheck />}
          title={t("google.fixable", { n: s.fixable })}
          text={t("google.fixableText")}
        />
      )}
      {s.doneBefore > 0 && (
        <Banner tone="info" icon={<CircleCheck />} text={t("google.doneBefore", { n: s.doneBefore })} />
      )}

      {/* options */}
      <div className="surface mt-4 overflow-hidden rounded-xl bg-s1">
        <Option
          on={opts.albums}
          onChange={(v) => setOpts({ ...opts, albums: v })}
          title={t("google.optAlbums")}
          text={s.albums.length ? t("google.optAlbumsText", { n: s.albums.length }) : t("google.noAlbums")}
          disabled={!s.albums.length}
        />
        {s.edited > 0 && (
          <Option
            on={opts.skipEdited}
            onChange={(v) => setOpts({ ...opts, skipEdited: v })}
            title={t("google.optSkipEdited")}
            text={t("google.optSkipEditedText", { n: s.edited })}
          />
        )}
      </div>

      {opts.albums && s.albums.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowAlbums((v) => !v)} className="flex items-center gap-1 rounded-lg px-1 py-1 text-[13px] font-semibold text-fg-2 hover:text-fg">
            {showAlbums ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {t("google.showAlbums")}
          </button>
          {showAlbums && (
            <div className="surface mt-1 max-h-40 overflow-y-auto rounded-xl bg-s1">
              {s.albums.map((a) => (
                <div key={a.name} className="flex h-9 items-center gap-2 border-b border-hairline px-3 text-[13px] last:border-0">
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="text-fg-3 tabular">{n(a.count)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Footer note={t("google.reviewNote")}>
        <Act onClick={nav.close}>{tc("common.cancel")}</Act>
        <Act variant="primary" disabled={!canUseVault("write") || scanning || starting || (todo === 0 && s.fixable === 0)} onClick={onStart}>
          {starting ? <Loader2 className="animate-spin" /> : null}
          {todo === 0 ? (s.fixable > 0 ? t("google.fixN", { n: s.fixable }) : t("google.nothing")) : t("google.importN", { n: todo })}
        </Act>
      </Footer>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="surface flex items-center gap-3 rounded-xl bg-s1 px-3 py-2.5">
      <span className="text-brand [&>svg]:size-[18px]">{icon}</span>
      <div className="min-w-0">
        <p className="truncate text-[15px] leading-5 font-semibold tabular">{value}</p>
        <p className="text-[11px] leading-4 text-fg-3">{label}</p>
      </div>
    </div>
  );
}

function Option({ on, onChange, title, text, disabled }: { on: boolean; onChange: (v: boolean) => void; title: string; text: string; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className="flex w-full items-center gap-3 border-b border-hairline px-3.5 py-3 text-left last:border-0 hover:bg-s3 disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="block text-[12px] text-fg-3">{text}</span>
      </span>
      <Switch on={on && !disabled} />
    </button>
  );
}

function Banner({ tone, icon, title, text }: { tone: "warning" | "danger" | "info"; icon: ReactNode; title?: string; text: string }) {
  const look = { warning: "border-warning/30 bg-warning-soft text-warning", danger: "border-danger/30 bg-danger/10 text-danger", info: "border-brand/25 bg-brand-soft text-brand" }[tone];
  return (
    <div className={`mt-4 flex gap-3 rounded-xl border px-3.5 py-3 ${look}`}>
      <span className="mt-0.5 shrink-0 [&>svg]:size-[18px]">{icon}</span>
      <div className="min-w-0 text-[13px] leading-5 text-fg">
        {title && <p className="font-semibold">{title}</p>}
        <p className={title ? "text-fg-2" : ""}>{text}</p>
      </div>
    </div>
  );
}

// ---- 3. importing / result ------------------------------------------------------------

/** Smoothed speed (bytes/s) from the progress. */
function useSpeed(bytes: number, live: boolean) {
  const ref = useRef<{ t: number; b: number; v: number }>({ t: performance.now(), b: bytes, v: 0 });
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!live) return;
    const now = performance.now();
    const p = ref.current;
    const dt = (now - p.t) / 1000;
    if (dt < 1.5) return;
    const inst = Math.max(0, (bytes - p.b) / dt);
    const next = p.v ? p.v * 0.7 + inst * 0.3 : inst;
    ref.current = { t: now, b: bytes, v: next };
    setV(next);
  }, [bytes, live]);
  return v;
}

function Run({ status: s, onResume, onAgain }: { status: TakeoutStatus; onResume: () => void; onAgain: () => void }) {
  const live = isRunning(s);
  const speed = useSpeed(s.bytesDone, live);
  const frac = s.bytesTotal ? Math.min(1, s.bytesDone / s.bytesTotal) : s.total ? s.done / s.total : 0;
  const eta = speed > 50_000 ? ((s.bytesTotal - s.bytesDone) / speed) * 1000 : 0;
  const imported = s.done - s.failed - s.reused;
  const [errs, setErrs] = useState(false);

  if (live)
    return (
      <div>
        <div className="surface rounded-xl bg-s1 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[28px] leading-8 font-semibold tabular">{Math.round(frac * 100)}%</p>
            <p className="text-[13px] text-fg-2 tabular">
              {t("google.ofTotal", { done: n(s.done), total: n(s.total) })}
            </p>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-s4">
            <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${frac * 100}%` }} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-3 tabular">
            <span>
              {t("google.ofTotal", { done: formatSize(s.bytesDone), total: formatSize(s.bytesTotal) })}
            </span>
            {speed > 1024 && <span>{formatSize(speed)}/s</span>}
            {eta > 0 && <span>{t("google.eta", { time: span(eta) })}</span>}
            {s.reused > 0 && <span>{t("google.reused", { n: s.reused })}</span>}
            {s.failed > 0 && <span className="text-danger">{t("google.failed", { n: s.failed })}</span>}
          </div>
          <p className="mt-3 flex items-center gap-2 truncate text-[12px] text-fg-2">
            <Loader2 size={13} className="shrink-0 animate-spin text-brand" />
            <span className="truncate">{s.state === "stopping" ? t("google.stopping") : s.finishing ? t("google.finishing") : (s.current ?? t("google.preparing"))}</span>
          </p>
        </div>
        <Footer note={onAndroid ? t("google.pauseNoteAndroid") : t("google.pauseNote")}>
          <Act onClick={nav.close}>{tc("common.close")}</Act>
          <Act disabled={s.state === "stopping"} onClick={() => void takeout.stop()}>
            <Pause /> {tc("common.pause")}
          </Act>
        </Footer>
      </div>
    );

  const failedBox = s.errors.length > 0 && (
    <div className="mt-3">
      <button onClick={() => setErrs((v) => !v)} className="flex items-center gap-1 text-[13px] font-semibold text-fg-2 hover:text-fg">
        {errs ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {t("google.showErrors", { n: s.failed })}
      </button>
      {errs && (
        <div className="surface mt-1 max-h-36 overflow-y-auto rounded-xl bg-s1 p-2 text-[12px] leading-5 text-fg-2">
          {s.errors.map((e, i) => (
            <p key={i} className="break-all">
              {e}
            </p>
          ))}
          {s.failed > s.errors.length && <p className="text-fg-3">{t("google.moreErrors", { n: s.failed - s.errors.length })}</p>}
        </div>
      )}
    </div>
  );

  if (s.state === "done")
    return (
      <div>
        <div className="grid grid-cols-3 gap-2">
          {(s.total > 0 || s.fixed === 0) && <Stat icon={<Images />} label={t("google.stat.imported", { n: imported })} value={n(Math.max(0, imported))} />}
          {s.fixed > 0 && <Stat icon={<CalendarRange />} label={t("google.stat.fixed", { n: s.fixed })} value={n(s.fixed)} />}
          <Stat icon={<Library />} label={t("google.stat.albumsMade", { n: s.albumsMade })} value={n(s.albumsMade)} />
          <Stat icon={<Heart />} label={t("google.stat.favorites")} value={n(s.favorites)} />
          {s.reused > 0 && <Stat icon={<CircleCheck />} label={t("google.stat.reused")} value={n(s.reused)} />}
          {s.archived > 0 && <Stat icon={<Archive />} label={t("google.stat.archived")} value={n(s.archived)} />}
          {s.before > 0 && <Stat icon={<Play />} label={t("google.stat.before")} value={n(s.before)} />}
        </div>
        {s.failed > 0 && <Banner tone="danger" icon={<TriangleAlert />} title={t("google.notImported", { n: s.failed })} text={t("google.notImportedText")} />}
        {failedBox}
        <Footer>
          <Act variant="ghost" onClick={onAgain}>
            {t("google.another")}
          </Act>
          <Act variant="primary" onClick={() => nav.closeThen(() => nav.dest("recent"))}>
            {t("google.seeImported")}
          </Act>
        </Footer>
      </div>
    );

  if (s.state === "stopped")
    return (
      <div>
        <div className="surface rounded-xl bg-s1 p-4">
          <p className="text-[14px] font-medium tabular">
            {t("google.stoppedAt", { done: n(s.done), total: n(s.total), bytesDone: formatSize(s.bytesDone), bytesTotal: formatSize(s.bytesTotal) })}
          </p>
          <p className="mt-1 text-[13px] text-fg-2">{t("google.stoppedText")}</p>
        </div>
        {failedBox}
        <Footer>
          <Act onClick={nav.close}>{tc("common.close")}</Act>
          <Act variant="primary" onClick={onResume}>
            <Play /> {t("google.continue")}
          </Act>
        </Footer>
      </div>
    );

  // error
  return (
    <div>
      <Banner tone="danger" icon={<TriangleAlert />} title={t("google.cantContinue")} text={s.error ?? t("google.unknownError")} />
      {s.done > 0 && <p className="mt-3 text-[13px] text-fg-2 tabular">{t("google.importedBefore", { n: s.done - s.failed })}</p>}
      {failedBox}
      <Footer>
        <Act onClick={nav.close}>{tc("common.close")}</Act>
        <Act variant="primary" onClick={onResume}>
          <Play /> {tc("common.retry")}
        </Act>
      </Footer>
    </div>
  );
}
