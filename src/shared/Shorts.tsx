/**
 * Curtas: feed vertical infinito com as mídias do vault, uma por tela. A
 * ordem vem do Rust: sorteio entre as menos vistas (somando os aparelhos).
 *
 * - Visualização conta sozinha: foto após 2 s na tela; vídeo ao passar da
 *   metade (ou de 10 s). Uma vez por exibição.
 * - Curtir é só dos Curtas (sincroniza pelo vault); não mexe nos favoritos.
 * - Só a mídia da tela e as vizinhas existem no DOM; vídeo só toca na ativa.
 * - HUD próprio (nada de controles nativos): tocar pausa, toque duplo curte.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, Eye, Maximize2, Pause, Play, ThumbsUp, Volume2, VolumeX } from "lucide-react";
import { formatDate } from "@tgcloud/ui/core/format";
import { srcOf } from "@tgcloud/ui/core/item";
import { useNet } from "@tgcloud/ui/core/net";
import { notifyError } from "@tgcloud/ui/core/notices";
import { haptic } from "@tgcloud/ui/core/platform";
import { thumbUrl } from "@tgcloud/ui/core/thumbs";
import { EmptyState, ErrorState } from "@tgcloud/ui/ui/States";
import { api, type Short } from "../core/api";
import { nav, useLayers } from "../core/nav";

const BATCH = 12;
/** Ids recentes que o sorteio evita (o resto pode voltar: o feed não acaba). */
const RECENT = 300;
const PHOTO_VIEW_MS = 2000;
const compact = new Intl.NumberFormat("pt-BR", { notation: "compact" });

const MUTE_KEY = "shorts-muted";
function savedMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Shorts({ touch }: { touch: boolean }) {
  const [items, setItems] = useState<Short[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [muted, setMutedState] = useState(savedMuted);
  const box = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const list = useRef<Short[]>([]);
  list.current = items;
  // Com uma camada por cima (visualizador, folha), nada toca aqui embaixo.
  const covered = useLayers().length > 0;
  const syncing = useNet((s) => s.syncing);

  const setMuted = (v: boolean) => {
    setMutedState(v);
    try {
      localStorage.setItem(MUTE_KEY, v ? "1" : "0");
    } catch {
      /* só a preferência */
    }
  };

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const cur = list.current;
      let next = await api.shortsNext(cur.slice(-RECENT).map((m) => m.id), BATCH);
      // Vault menor que a janela: libera as já vistas (menos a da tela).
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

  useEffect(() => {
    if (!items.length) void load();
    // Vault vazio na abertura: tenta de novo quando a sincronização terminar.
  }, [load, syncing, items.length]);

  useEffect(() => {
    if (items.length && active >= items.length - 4) void load();
  }, [active, items.length, load]);

  const go = useCallback((i: number) => {
    const el = box.current;
    if (!el) return;
    el.scrollTo({ top: Math.max(0, i) * el.clientHeight, behavior: "smooth" });
  }, []);

  const patch = (id: number, p: Partial<Short>) => setItems((old) => old.map((m) => (m.id === id ? { ...m, ...p } : m)));

  const like = useCallback(async (m: Short, on = !m.liked) => {
    patch(m.id, { liked: on });
    try {
      await api.shortLike(m.id, on);
    } catch (e) {
      patch(m.id, { liked: !on });
      notifyError(e);
    }
  }, []);

  const view = useCallback(async (m: Short) => {
    try {
      patch(m.id, { views: await api.shortView(m.id) });
    } catch {
      /* contagem perdida não atrapalha o feed */
    }
  }, []);

  // Teclado (desktop): ↑/↓ troca, espaço pausa, M som, L curte.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (touch) return;
    const onKey = (e: KeyboardEvent) => {
      if (covered || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest("input, textarea")) return;
      const k = e.key.toLowerCase();
      if (k === "arrowdown" || k === "pagedown" || k === "j") go(active + 1);
      else if (k === "arrowup" || k === "pageup" || k === "k") go(active - 1);
      else if (k === " ") setPaused((p) => !p);
      else if (k === "m") setMuted(!muted);
      else if (k === "l" && list.current[active]) void like(list.current[active]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [touch, covered, active, go, like, muted]);
  useEffect(() => setPaused(false), [active]);

  if (!items.length) {
    if (error) return <ErrorState error={error} retry={() => void load()} touch={touch} />;
    if (!done) return <div className="flex-1 bg-black" />;
    return (
      <div className="grid flex-1 place-items-center">
        <EmptyState icon={Clapperboard} title="Nada para assistir" text="As fotos e vídeos do vault aparecem aqui, um de cada vez." touch={touch} />
      </div>
    );
  }

  return (
    <div
      ref={box}
      className="min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto overscroll-contain bg-black [scrollbar-width:none]"
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
            onLike={(on) => void like(m, on)}
            onView={() => void view(m)}
          />
        ) : (
          <div key={`${m.id}:${i}`} className="h-full snap-start snap-always" />
        ),
      )}
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
  onLike: (on?: boolean) => void;
  onView: () => void;
}) {
  const video = m.mime.startsWith("video/");
  const poster = m.thumb ? thumbUrl(m.id) : undefined;
  const ref = useRef<HTMLVideoElement>(null);
  const counted = useRef(false);
  const [progress, setProgress] = useState(0);
  const [burst, setBurst] = useState(0);
  const [bad, setBad] = useState(false);
  const tap = useRef<number | null>(null);

  // Nova exibição: a visualização pode contar de novo.
  useEffect(() => {
    if (!active) return;
    counted.current = false;
    if (video) return;
    const t = setTimeout(() => {
      counted.current = true;
      onView();
    }, PHOTO_VIEW_MS);
    return () => clearTimeout(t);
  }, [active, video]);

  // Toca só a ativa; sem permissão para som, toca mudo.
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

  // Um toque pausa (vídeo); dois toques curtem.
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

  const btn = `grid place-items-center rounded-full text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)] ${touch ? "size-12" : "size-11 hover:bg-white/10"}`;

  return (
    <section className="relative h-full snap-start snap-always overflow-hidden bg-black select-none" aria-label={m.name}>
      {/* Fundo: a miniatura borrada preenche as sobras (mídia em pé ou deitada). */}
      {poster && <img src={poster} alt="" aria-hidden draggable={false} className="absolute inset-0 size-full scale-110 object-cover opacity-40 blur-2xl" />}

      <div className="absolute inset-0" onClick={onTap}>
        {video ? (
          active ? (
            <video
              ref={ref}
              src={srcOf(m)}
              poster={poster}
              loop
              playsInline
              muted={muted}
              preload="auto"
              onTimeUpdate={onTime}
              className="size-full object-contain"
            />
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
          <ThumbsUp size={96} className="short-burst fill-white text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.5)]" />
        </div>
      )}

      {/* Sombras para o texto e os botões. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/60 to-transparent" />

      <div className="absolute right-2 bottom-6 flex flex-col items-center gap-3">
        <div className="flex flex-col items-center">
          <button type="button" onClick={() => (m.liked ? onLike(false) : likeBurst())} className={btn} aria-pressed={m.liked} aria-label={m.liked ? "Descurtir" : "Curtir"} title={touch ? undefined : "Curtir (L)"}>
            <ThumbsUp size={28} className={m.liked ? "fill-brand text-brand" : ""} />
          </button>
          <span className="text-[12px] font-semibold text-white drop-shadow">{m.liked ? "Curtido" : "Curtir"}</span>
        </div>
        <div className="flex flex-col items-center text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)]" title={`${m.views} ${m.views === 1 ? "visualização" : "visualizações"}`}>
          <span className={`${btn} pointer-events-none`}>
            <Eye size={26} />
          </span>
          <span className="text-[12px] font-semibold tabular">{compact.format(m.views)}</span>
        </div>
        {video && (
          <button type="button" onClick={() => setMuted(!muted)} className={btn} aria-label={muted ? "Ativar som" : "Silenciar"} title={touch ? undefined : "Som (M)"}>
            {muted ? <VolumeX size={26} /> : <Volume2 size={26} />}
          </button>
        )}
        {!touch && video && (
          <button type="button" onClick={() => setPaused((p) => !p)} className={btn} aria-label={playing ? "Pausar" : "Tocar"} title="Pausar (espaço)">
            {playing ? <Pause size={24} /> : <Play size={24} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => nav.open({ type: "viewer", id: m.id, siblings: [m.id] })}
          className={btn}
          aria-label="Abrir no visualizador"
          title={touch ? undefined : "Abrir no visualizador"}
        >
          <Maximize2 size={22} />
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-4 right-20 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.6)]">
        <p className="truncate text-[15px] font-semibold">{formatDate(m.taken_at)}</p>
        <p className="truncate text-[12px] text-white/75">{m.name}</p>
      </div>

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
