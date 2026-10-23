/**
 * Shorts: vertical feed with the vault media, one per screen.
 *
 * - Main feed: infinite; the order comes from Rust (random among the least
 *   viewed, summing across devices).
 * - Likes: grid of what was liked (most recent like to the oldest); tapping
 *   opens the same feed with only the likes, starting from it.
 * - Views count on their own: photo after 2 s on screen; video past half
 *   (or 10 s). Once per display.
 * - Liking is Shorts-only (syncs through the vault); does not touch favorites.
 * - Only the on-screen media and its neighbors exist in the DOM; video only plays on the active one.
 * - Its own HUD (no native controls): tap pauses, double tap likes.
 */
import { Presence } from "@tgcloud/ui/ui/Presence";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CalendarDays, Lock, Clapperboard, Eye, Heart, Maximize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { formatDate, formatDuration } from "@tgcloud/ui/core/format";
import { srcOf, useSrc } from "@tgcloud/ui/core/item";
import { useNet } from "@tgcloud/ui/core/net";
import { notifyError } from "@tgcloud/ui/core/notices";
import { haptic } from "@tgcloud/ui/core/platform";
import { requestThumb, thumbFromVideo, thumbUrl, useRequestThumb } from "@tgcloud/ui/core/thumbs";
import { useThumbRev } from "@tgcloud/ui/core/server";
import { EmptyState, ErrorState } from "@tgcloud/ui/ui/States";
import { api, type Short } from "../core/api";
import { queryClient } from "../core/data";
import { nav, useLayers, useRoute } from "../core/nav";
import { Cover } from "../timeline/Cover";
import { jumpTo } from "../timeline/Timeline";
import { useCurrentVault } from "@tgcloud/ui/core/vault";
import { fmtNumber } from "@tgcloud/ui/i18n";
import { rich, t, tc } from "../i18n";

const BATCH = 12;
/** Recent ids the shuffle avoids (the rest can return: the feed never ends). */
const RECENT = 300;
const PHOTO_VIEW_MS = 2000;
const compact = { format: (n: number) => fmtNumber(n, { notation: "compact" }) };
const RED = "fill-[#fe2c55] text-[#fe2c55]";

const MUTE_KEY = "shorts-muted";
function savedMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Where each feed was (going to the timeline and back remounts the screen): the
 * main one keeps the shuffled list; the likes one, the position.
 */
const kept: { vault?: number; items: Short[]; at: number } = { items: [], at: 0 };
const likedKept = { from: -1, at: 0 };

const useLiked = () => useQuery({ queryKey: ["liked"], queryFn: api.shortsLiked });

/** Takes the media to the timeline (Photos; Archive if it was archived) and highlights it. */
function showInTimeline(m: Short) {
  nav.dest(m.archived ? "archive" : "photos");
  jumpTo(m.id);
}

/** Like and view with optimistic update on the list that owns the items. */
function useStats(setItems: (fn: (old: Short[]) => Short[]) => void) {
  const patch = useCallback((id: number, p: Partial<Short>) => setItems((old) => old.map((m) => (m.id === id ? { ...m, ...p } : m))), [setItems]);
  const like = useCallback(
    async (m: Short, on: boolean) => {
      patch(m.id, { liked: on });
      try {
        await api.shortLike(m.id, on);
        void queryClient.invalidateQueries({ queryKey: ["liked"] });
      } catch (e) {
        patch(m.id, { liked: !on });
        notifyError(e);
      }
    },
    [patch],
  );
  const view = useCallback(
    async (m: Short) => {
      try {
        patch(m.id, { views: await api.shortView(m.id) });
      } catch {
        /* a lost count does not hurt the feed */
      }
    },
    [patch],
  );
  return { like, view };
}

// ---- main feed ---------------------------------------------------------------------

const PRIVACY_KEY = "shorts-privacy-seen";
function seenPrivacy() {
  try {
    return localStorage.getItem(PRIVACY_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * First time in Shorts: "view" and "like" sound like a social network; here
 * they are not public. Explains who sees them (and, in a read-only vault, that
 * they stay on this device only).
 */
function PrivacyNotice({ touch, onClose }: { touch: boolean; onClose: () => void }) {
  const readOnly = useCurrentVault((s) => s.vault?.can_post === false);
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 p-5 anim-fade" role="dialog" aria-modal="true" aria-labelledby="shorts-privacy">
      <div className="surface w-full max-w-sm rounded-2xl bg-s1 p-6 text-fg">
        <div className="grid size-12 place-items-center rounded-xl bg-brand-soft text-brand">
          <Lock size={24} />
        </div>
        <h2 id="shorts-privacy" className="mt-4 font-heading text-[20px] leading-7 font-bold text-fg-title">
          {t("shorts.privacyTitle")}
        </h2>
        <p className="mt-2 text-[14px] text-fg-2">
          {rich("shorts.privacyBody", { b: (s) => <b className="text-fg">{s}</b> })}
        </p>
        {readOnly && <p className="mt-2 text-[13px] text-fg-3">{t("shorts.privacyReadOnly")}</p>}
        <p className="mt-2 text-[13px] text-fg-3">{t("shorts.privacyFavorites")}</p>
        <button type="button" autoFocus onClick={onClose} className={`step mt-6 w-full rounded-lg bg-brand font-semibold text-white ${touch ? "h-12 text-[16px]" : "h-10 text-[14px]"}`}>
          {t("shorts.gotIt")}
        </button>
      </div>
    </div>
  );
}

/** Shorts video without a thumbnail captured so far: the queue generates one. */
const SHORT_THUMB_MS = 5000;

export function Shorts({ touch }: { touch: boolean }) {
  const [privacy, setPrivacy] = useState(() => !seenPrivacy());
  const closePrivacy = () => {
    setPrivacy(false);
    try {
      localStorage.setItem(PRIVACY_KEY, "1");
    } catch {
      /* shows again next time */
    }
  };
  const notice = <Presence>{privacy && <PrivacyNotice touch={touch} onClose={closePrivacy} />}</Presence>;
  const vault = useCurrentVault((s) => s.vault?.id);
  if (kept.vault !== vault) Object.assign(kept, { vault, items: [], at: 0 });
  const [items, setItems] = useState<Short[]>(() => kept.items);
  kept.items = items;
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const loading = useRef(false);
  const list = useRef<Short[]>([]);
  list.current = items;
  const syncing = useNet((s) => s.syncing);
  const stats = useStats(setItems);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const cur = list.current;
      let next = await api.shortsNext(cur.slice(-RECENT).map((m) => m.id), BATCH);
      // Vault smaller than the window: release the already seen ones (except the on-screen one).
      if (!next.length && cur.length) next = await api.shortsNext(cur.slice(-1).map((m) => m.id), BATCH);
      setItems((old) => [...old, ...next]);
      setError(null);
      setDone(true);
    } catch (e) {
      setError(e);
    } finally {
      loading.current = false;
    }
  }, []);

  // Empty vault on open: tries again when syncing finishes.
  useEffect(() => {
    if (!items.length) void load();
  }, [load, syncing, items.length]);

  const header = (
    <>
      <span className="pl-2 font-heading text-[20px] font-bold tracking-tight text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)]">{t("shorts.title")}</span>
      <LikedChip touch={touch} />
    </>
  );

  if (!items.length) {
    if (error) return <ErrorState error={error} retry={() => void load()} touch={touch} />;
    if (!done) return <div className="flex-1 bg-black" />;
    return (
      <div className="relative grid flex-1 place-items-center bg-black">
        {notice}
        <TopBar>{header}</TopBar>
        <EmptyState icon={Clapperboard} title={t("shorts.emptyTitle")} text={t("shorts.emptyText")} touch={touch} />
      </div>
    );
  }
  const near = (i: number) => {
    kept.at = i;
    if (i >= list.current.length - 4) void load();
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {notice}
      <Feed touch={touch} items={items} start={kept.at} header={header} onLike={stats.like} onView={stats.view} onNear={near} paused={privacy} />
    </div>
  );
}

/** Likes shortcut at the top of the feed, with thumbnails of the latest ones. */
function LikedChip({ touch }: { touch: boolean }) {
  const { data = [] } = useLiked();
  const last = data.slice(0, 3);
  return (
    <button
      type="button"
      onClick={() => nav.dest("liked")}
      className={`flex items-center gap-2 rounded-full bg-black/35 pr-3 pl-1.5 font-semibold text-white backdrop-blur ${touch ? "h-10 text-[14px]" : "h-9 text-[13px] hover:bg-black/50"}`}
      aria-label={data.length ? t("shorts.likedCount", { n: data.length }) : t("shorts.liked")}
    >
      {last.length ? (
        <span className="flex -space-x-2">
          {last.map((m) => (
            <ChipThumb key={m.id} m={m} />
          ))}
        </span>
      ) : (
        <Heart size={16} className="ml-1.5 fill-white" />
      )}
      {t("shorts.liked")}
      {data.length > 0 && <span className="text-white/70 tabular">{compact.format(data.length)}</span>}
    </button>
  );
}

function ChipThumb({ m }: { m: Short }) {
  const ref = useRef<HTMLSpanElement>(null);
  useRequestThumb(m, ref);
  return (
    <span ref={ref} className="size-6 overflow-hidden rounded-full ring-2 ring-black/60">
      <Cover m={m} selected={false} />
    </span>
  );
}

function TopBar({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-between gap-2 bg-gradient-to-b from-black/50 to-transparent px-2 [&>*]:pointer-events-auto">
      {children}
    </div>
  );
}

// ---- likes -------------------------------------------------------------------------

/** "liked" route: the grid; with `at`, the likes feed starting from that one. */
export function Liked({ touch }: { touch: boolean }) {
  const route = useRoute();
  return route.at === undefined ? <LikedGrid touch={touch} /> : <LikedFeed touch={touch} start={route.at} />;
}

function LikedGrid({ touch }: { touch: boolean }) {
  const q = useLiked();
  const back = (
    <button type="button" onClick={() => nav.back()} className="grid size-11 shrink-0 place-items-center rounded-full text-white hover:bg-white/10 active:bg-white/15" aria-label={t("shorts.backToShorts")}>
      <ArrowLeft size={22} />
    </button>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black text-white">
      <header className="flex h-14 shrink-0 items-center gap-1 px-1">
        {back}
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-[20px] leading-6 font-bold tracking-tight">{t("shorts.liked")}</h1>
          {!!q.data?.length && <p className="text-[12px] text-white/60 tabular">{t("shorts.likedSummary", { n: q.data.length })}</p>}
        </div>
      </header>
      {q.error ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} touch={touch} />
      ) : !q.data ? (
        <div className="flex-1" />
      ) : !q.data.length ? (
        <div className="grid flex-1 place-items-center">
          <EmptyState icon={Heart} title={t("shorts.noLikes")} text={t("shorts.noLikesText")} touch={touch} sync={false} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={`grid gap-0.5 ${touch ? "grid-cols-3 pb-24" : "grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1 px-4 pb-6"}`}>
            {q.data.map((m, i) => (
              <LikedTile key={m.id} m={m} touch={touch} onOpen={() => nav.go({ dest: "liked", at: i })} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LikedTile({ m, touch, onOpen }: { m: Short; touch: boolean; onOpen: () => void }) {
  const video = m.mime.startsWith("video/");
  // No thumbnail in the vault (video never seen in the timeline): generates when it appears.
  const ref = useRef<HTMLButtonElement>(null);
  useRequestThumb(m, ref);
  return (
    <button ref={ref} type="button" onClick={onOpen} className={`group relative aspect-[9/16] overflow-hidden bg-white/5 ${touch ? "" : "rounded-md"}`} aria-label={m.name}>
      <Cover m={m} selected={false} />
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 to-transparent" />
      {video && m.duration ? (
        <span className="absolute top-1.5 right-1.5 rounded bg-black/55 px-1 text-[11px] font-semibold text-white tabular">{formatDuration(m.duration)}</span>
      ) : null}
      <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 text-[12px] font-semibold text-white tabular drop-shadow">
        <Eye size={13} /> {compact.format(m.views)}
      </span>
      {!touch && <span className="absolute inset-0 bg-white/0 transition-colors group-hover:bg-white/10" />}
    </button>
  );
}

/** Likes as a feed. The list stays still while it is open (unliking does not skip the screen). */
function LikedFeed({ touch, start }: { touch: boolean; start: number }) {
  const q = useLiked();
  const [items, setItems] = useState<Short[] | null>(null);
  useEffect(() => {
    if (!items && q.data) setItems(q.data);
  }, [items, q.data]);
  const set = useCallback((fn: (old: Short[]) => Short[]) => setItems((old) => (old ? fn(old) : old)), []);
  const stats = useStats(set);
  // Back from the timeline: where it stopped, not where it entered.
  const from = likedKept.from === start ? likedKept.at : start;
  const [active, setActive] = useState(from);
  const near = useCallback(
    (i: number) => {
      Object.assign(likedKept, { from: start, at: i });
      setActive(i);
    },
    [start],
  );
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} touch={touch} />;
  if (!items) return <div className="flex-1 bg-black" />;
  const header = (
    <>
      <button type="button" onClick={() => nav.back()} className="flex h-10 items-center gap-1 rounded-full pr-3 pl-1.5 font-semibold text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)] hover:bg-white/10" aria-label={t("shorts.backToLiked")}>
        <ArrowLeft size={22} /> {t("shorts.liked")}
      </button>
      <span className="pr-2 text-[13px] font-semibold text-white/80 tabular drop-shadow">
        {tc("common.ofTotal", { done: Math.min(active, items.length - 1) + 1, total: items.length })}
      </span>
    </>
  );
  return <Feed touch={touch} items={items} start={from} header={header} onLike={stats.like} onView={stats.view} onNear={near} />;
}

// ---- feed (shared) -----------------------------------------------------------------

function Feed({
  touch,
  items,
  start = 0,
  header,
  onLike,
  onView,
  onNear,
  paused: hold = false,
}: {
  touch: boolean;
  items: Short[];
  /** Something on top (notice): nothing plays nor counts. */
  paused?: boolean;
  start?: number;
  header: ReactNode;
  onLike: (m: Short, on: boolean) => void;
  onView: (m: Short) => void;
  /** The on-screen media changed (the main feed loads more near the end). */
  onNear?: (i: number) => void;
}) {
  const [active, setActive] = useState(start);
  const [paused, setPaused] = useState(false);
  const [muted, setMutedState] = useState(savedMuted);
  const box = useRef<HTMLDivElement>(null);
  // With a layer on top (viewer, sheet), nothing plays underneath.
  const covered = useLayers().length > 0 || hold;

  const setMuted = useCallback((v: boolean) => {
    setMutedState(v);
    try {
      localStorage.setItem(MUTE_KEY, v ? "1" : "0");
    } catch {
      /* just the preference */
    }
  }, []);

  // Opens right at the chosen media (without animation); only on mount.
  const first = useRef(start);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && first.current) el.scrollTop = first.current * el.clientHeight;
  }, []);

  const near = useRef(onNear);
  near.current = onNear;
  useEffect(() => {
    setPaused(false);
    near.current?.(active);
  }, [active]);

  const go = useCallback((i: number) => {
    const el = box.current;
    if (el) el.scrollTo({ top: Math.max(0, i) * el.clientHeight, behavior: "smooth" });
  }, []);

  // Keyboard (desktop): ↑/↓ switches, space pauses, M sound, L likes, T timeline.
  useEffect(() => {
    if (touch) return;
    const onKey = (e: KeyboardEvent) => {
      if (covered || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest("input, textarea")) return;
      const m = items[active];
      const k = e.key.toLowerCase();
      if (k === "arrowdown" || k === "pagedown" || k === "j") go(active + 1);
      else if (k === "arrowup" || k === "pageup" || k === "k") go(active - 1);
      else if (k === " ") setPaused((p) => !p);
      else if (k === "m") setMuted(!muted);
      else if (k === "l" && m) onLike(m, !m.liked);
      else if (k === "t" && m) showInTimeline(m);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [touch, covered, active, items, go, onLike, muted, setMuted]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-black">
      <TopBar>{header}</TopBar>
      <div
        ref={box}
        className="min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto overscroll-contain [scrollbar-width:none]"
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollTop / Math.max(1, el.clientHeight));
          if (i !== active) setActive(i);
        }}
      >
        {items.map((m, i) =>
          Math.abs(i - active) <= 1 ? (
            <Slide
              key={`${m.id}:${i}`}
              m={m}
              touch={touch}
              active={i === active}
              playing={i === active && !covered && !paused}
              setPaused={setPaused}
              muted={muted}
              setMuted={setMuted}
              onLike={(on) => onLike(m, on)}
              onView={() => onView(m)}
            />
          ) : (
            <div key={`${m.id}:${i}`} className="h-full snap-start snap-always" />
          ),
        )}
      </div>
    </div>
  );
}

function Slide({
  m,
  touch,
  active,
  playing,
  setPaused,
  muted,
  setMuted,
  onLike,
  onView,
}: {
  m: Short;
  touch: boolean;
  active: boolean;
  playing: boolean;
  setPaused: (fn: (p: boolean) => boolean) => void;
  muted: boolean;
  setMuted: (v: boolean) => void;
  onLike: (on: boolean) => void;
  onView: () => void;
}) {
  const video = m.mime.startsWith("video/");
  // The feed list does not update: tries the thumbnail even without the mark (it may
  // have just been generated) and gives up if the server does not have it.
  const [missing, setMissing] = useState(false);
  useThumbRev();
  const poster = m.thumb || !missing ? thumbUrl(m.id) : undefined;
  const ref = useRef<HTMLVideoElement>(null);
  // Only the active item mounts the video; when it stops being active, the read is canceled.
  const playSrc = useSrc(m, active);
  const counted = useRef(false);
  const [progress, setProgress] = useState(0);
  const [burst, setBurst] = useState(0);
  const [bad, setBad] = useState(false);
  const tap = useRef<number | null>(null);

  // New display: the view can count again.
  useEffect(() => {
    if (!active) return;
    counted.current = false;
    // Photo: request right away. Video: the frame comes from the video itself playing (onTime);
    // if that failed (left earlier, error), the queue generates after a while.
    if (!video) return requestThumb(m);
    const t = setTimeout(() => requestThumb(m), SHORT_THUMB_MS);
    return () => clearTimeout(t);
    // Only a display change restarts the count.
  }, [active]);

  // Photo: counts after some time in view (with something on top, like the notice, it does not).
  useEffect(() => {
    if (!playing || video || counted.current) return;
    const t = setTimeout(() => {
      counted.current = true;
      onView();
    }, PHOTO_VIEW_MS);
    return () => clearTimeout(t);
  }, [playing, video]);

  // Plays only the active one; without permission for sound, plays muted.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!playing) return void v.pause();
    v.play().catch((e: unknown) => {
      if ((e as Error)?.name === "NotAllowedError" && !v.muted) {
        setMuted(true);
        v.muted = true;
        void v.play().catch(() => {});
      }
    });
  }, [playing, active, setMuted]);

  const onTime = () => {
    const v = ref.current;
    if (!v || !isFinite(v.duration) || !v.duration) return;
    setProgress(v.currentTime / v.duration);
    if (!m.thumb) thumbFromVideo(m, v);
    if (!counted.current && v.currentTime >= Math.min(10, v.duration / 2)) {
      counted.current = true;
      onView();
    }
  };

  const likeBurst = () => {
    haptic();
    setBurst((n) => n + 1);
    if (!m.liked) onLike(true);
  };

  // One tap pauses (video); two taps like.
  const onTap = () => {
    if (tap.current) {
      clearTimeout(tap.current);
      tap.current = null;
      return likeBurst();
    }
    tap.current = window.setTimeout(() => {
      tap.current = null;
      if (video) setPaused((p) => !p);
    }, 250);
  };

  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const v = ref.current;
    if (!v || !isFinite(v.duration)) return;
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * v.duration;
  };

  const btn = `grid place-items-center rounded-full text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)] ${touch ? "size-12 active:bg-white/15" : "size-11 hover:bg-white/10"}`;
  const label = "text-[12px] font-semibold text-white drop-shadow tabular";

  return (
    <section className="relative h-full snap-start snap-always overflow-hidden bg-black select-none" aria-label={m.name}>
      {/* Background: the blurred thumbnail fills the remaining space (portrait or landscape media). */}
      {poster && <img src={poster} alt="" aria-hidden draggable={false} onError={() => setMissing(true)} className="absolute inset-0 size-full scale-110 object-cover opacity-40 blur-2xl" />}

      <div className="absolute inset-0" onClick={onTap}>
        {video ? (
          active ? (
            <video ref={ref} src={playSrc} crossOrigin="anonymous" poster={poster} loop playsInline muted={muted} preload="auto" onTimeUpdate={onTime} className="size-full object-contain" />
          ) : (
            poster && <img src={poster} alt="" draggable={false} className="size-full object-contain" />
          )
        ) : (
          <img
            src={bad ? poster : srcOf(m)}
            alt=""
            draggable={false}
            decoding="async"
            onError={() => setBad(true)}
            className="size-full object-contain"
            style={poster && !bad ? { backgroundImage: `url(${poster})`, backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" } : undefined}
          />
        )}
      </div>

      {video && active && !playing && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="grid size-16 place-items-center rounded-full bg-black/45 text-white anim-fade">
            <Play size={30} className="ml-1 fill-white" />
          </span>
        </div>
      )}

      {burst > 0 && (
        <div key={burst} className="pointer-events-none absolute inset-0 grid place-items-center">
          <Heart size={96} className={`short-burst drop-shadow-[0_2px_8px_rgba(0,0,0,.5)] ${RED}`} />
        </div>
      )}

      {/* Shadow for the text and the buttons. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/65 to-transparent" />

      <div className="absolute right-2 bottom-6 flex flex-col items-center gap-2.5">
        <div className="flex flex-col items-center">
          <button type="button" onClick={() => (m.liked ? onLike(false) : likeBurst())} className={btn} aria-pressed={m.liked} aria-label={m.liked ? t("shorts.unlike") : t("shorts.like")} title={touch ? undefined : t("shorts.likeKey")}>
            <Heart size={30} className={m.liked ? RED : ""} />
          </button>
          <span className={label}>{m.liked ? t("shorts.likedOne") : t("shorts.like")}</span>
        </div>
        <div className="flex flex-col items-center" title={t("shorts.views", { n: m.views })}>
          <span className={`${btn} pointer-events-none`}>
            <Eye size={26} />
          </span>
          <span className={label}>{compact.format(m.views)}</span>
        </div>
        <div className="flex flex-col items-center">
          <button type="button" onClick={() => showInTimeline(m)} className={btn} aria-label={t("shorts.showInTimeline")} title={touch ? undefined : t("shorts.showInTimelineKey")}>
            <CalendarDays size={25} />
          </button>
          <span className={label}>{t("shorts.photos")}</span>
        </div>
        {video && (
          <button type="button" onClick={() => setMuted(!muted)} className={btn} aria-label={muted ? t("shorts.unmute") : t("shorts.mute")} title={touch ? undefined : t("shorts.soundKey")}>
            {muted ? <VolumeX size={26} /> : <Volume2 size={26} />}
          </button>
        )}
        {!touch && video && (
          <button type="button" onClick={() => setPaused((p) => !p)} className={btn} aria-label={playing ? tc("common.pause") : t("shorts.play")} title={t("shorts.pauseKey")}>
            {playing ? <Pause size={24} /> : <Play size={24} />}
          </button>
        )}
        <button type="button" onClick={() => nav.open({ type: "viewer", id: m.id, siblings: [m.id] })} className={btn} aria-label={t("shorts.openViewer")} title={touch ? undefined : t("shorts.openViewer")}>
          <Maximize2 size={22} />
        </button>
      </div>

      {/* Date: goes to the timeline, as in the viewer. */}
      <button type="button" onClick={() => showInTimeline(m)} className="absolute bottom-6 left-3 max-w-[calc(100%-5.5rem)] rounded-lg px-1.5 py-1 text-left text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)] hover:bg-white/10">
        <span className="flex items-center gap-1 text-[15px] font-semibold">
          {formatDate(m.taken_at)} <span className="text-white/60">›</span>
        </span>
        <span className="block truncate text-[12px] text-white/75">{m.name}</span>
      </button>

      {video && active && (
        <div className={`absolute inset-x-0 bottom-0 flex items-end ${touch ? "h-3" : "h-4 cursor-pointer"}`} onPointerDown={touch ? undefined : seek}>
          <div className="h-[3px] w-full bg-white/25">
            <div className="h-full bg-white" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
    </section>
  );
}
