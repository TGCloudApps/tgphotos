/**
 * Importar de chats (as duas cascas): conversas com busca e paginação sob
 * demanda, tópicos de grupos-fórum e a grade de fotos/vídeos de um chat —
 * tocar seleciona, segurar mostra a prévia (soltar fecha), importar põe na
 * fila de envios.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Circle, Clock, CloudCheck, Hash, Lock, MessagesSquare, Play, Search, X } from "lucide-react";
import { EmptyState, ErrorState } from "@tgcloud/ui/ui/States";
import { formatSize } from "@tgcloud/ui/core/format";
import { useTransfers } from "@tgcloud/ui/core/transfers";
import { api, type ChatInfo, type ChatMedia, type Topic } from "../core/api";
import {
  chatPhotoUrl,
  chatSrc,
  chatThumbUrl,
  chatToken,
  chatTokenNow,
  duration,
  importMedia,
  kindLabel,
  rememberChats,
  topicKey,
  useChatInfo,
  useTopicTitles,
} from "../core/chats";
import { uploadStates } from "../core/library";
import { nav, useRoute } from "../core/nav";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Chama `onSeen` quando o elemento aparece (fim da lista: carrega mais). */
function useSentinel(onSeen: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onSeen);
  cb.current = onSeen;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && cb.current(), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

function useToken() {
  const [t, setT] = useState(chatTokenNow);
  useEffect(() => {
    if (!t) void chatToken().then(setT);
  }, [t]);
  return t;
}

// ---- conversas ---------------------------------------------------------------------------

const palette = ["#e17076", "#7bc862", "#e5ca77", "#65aadd", "#a695e7", "#ee7aae", "#6ec9cb", "#faa774"];

function Avatar({ chat, size }: { chat: ChatInfo; size: number }) {
  const t = useToken();
  const [failed, setFailed] = useState(false);
  const url = t ? chatPhotoUrl(t, chat) : null;
  const initials = chat.title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  const color = palette[Math.abs([...chat.key].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % palette.length];
  return (
    <div className="grid shrink-0 place-items-center overflow-hidden rounded-full text-white" style={{ width: size, height: size, background: url && !failed ? undefined : color }}>
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" draggable={false} className="size-full object-cover" onError={() => setFailed(true)} />
      ) : chat.kind === "saved" ? (
        <MessagesSquare size={size * 0.45} />
      ) : (
        <span className="font-semibold" style={{ fontSize: size * 0.38 }}>
          {initials || "?"}
        </span>
      )}
    </div>
  );
}

/** Conversas da conta, com busca; tocar abre o chat (ou os tópicos, num fórum). */
export function ChatList({ touch }: { touch: boolean }) {
  const [list, setList] = useState<ChatInfo[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ChatInfo[] | null>(null);

  const load = useCallback(async () => {
    if (loading || next === null) return;
    setLoading(true);
    setError(null);
    try {
      const page = await api.chats(next ?? null);
      rememberChats(page.chats);
      setList((cur) => {
        const seen = new Set(cur.map((c) => c.key));
        return [...cur, ...page.chats.filter((c) => !seen.has(c.key))];
      });
      setNext(page.next);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [loading, next]);

  useEffect(() => {
    void load();
    // Só a primeira página aqui; o resto pelo fim da lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Busca no servidor (as da conta primeiro), com uma pausa ao digitar.
  useEffect(() => {
    const text = q.trim();
    if (!text) return setFound(null);
    let alive = true;
    const t = setTimeout(() => {
      api
        .chatsSearch(text)
        .then((r) => {
          rememberChats(r);
          if (alive) setFound(r);
        })
        .catch((e) => alive && setError(e));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const searching = found !== null;
  const shown = searching ? found : list;
  const sentinel = useSentinel(() => void load(), !searching && next !== null && !error);

  return (
    <div className={touch ? "pb-28" : "mx-auto max-w-[720px] px-6 pt-3 pb-10"}>
      <div className={touch ? "px-3 pt-1 pb-2" : "pb-3"}>
        <div className="relative">
          <Search size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-fg-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar conversas, grupos e canais"
            enterKeyHint="search"
            className={`surface w-full rounded-xl border border-line bg-s3 pr-11 pl-10 text-fg outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25 ${touch ? "h-11 text-[16px]" : "h-10 text-[14px]"}`}
          />
          {q && (
            <button onClick={() => setQ("")} className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-fg-2 hover:bg-s4" aria-label="Limpar busca">
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {error && !shown.length ? (
        <ErrorState touch={touch} error={error} retry={() => (searching ? setQ((x) => x + "") : void load())} />
      ) : searching && !shown.length ? (
        <EmptyState touch={touch} sync={false} icon={Search} title="Nada encontrado" text={`Nenhuma conversa com “${q.trim()}”.`} />
      ) : (
        <div className={touch ? "" : "surface overflow-hidden rounded-xl bg-s1"}>
          {shown.map((c) => (
            <button
              key={c.key}
              onClick={() => nav.chat(c.key)}
              className={`flex w-full items-center gap-3 text-left ${touch ? "min-h-[68px] px-4 py-2 active:bg-s3" : "min-h-14 border-b border-hairline px-3.5 py-2 last:border-0 hover:bg-s2"}`}
            >
              <Avatar chat={c} size={touch ? 48 : 40} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate font-medium ${touch ? "text-[15px]" : "text-[14px]"}`}>{c.title}</span>
                <span className="flex items-center gap-1 text-[12px] text-fg-3">
                  {c.protected && <Lock size={12} className="shrink-0" />}
                  {kindLabel[c.kind]}
                  {c.protected && " · protegido"}
                </span>
              </span>
            </button>
          ))}
          {!searching && next !== null && (
            <div ref={sentinel} className="space-y-2 px-4 py-3" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="skeleton size-10 shrink-0 rounded-full" />
                  <div className="skeleton h-3 w-1/2" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- tópicos ------------------------------------------------------------------------------

function TopicList({ chat, touch }: { chat: string; touch: boolean }) {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    setError(null);
    api
      .chatTopics(chat)
      .then((list) => {
        useTopicTitles.setState(Object.fromEntries(list.map((t) => [topicKey(chat, t.id), t.title])));
        setTopics(list);
      })
      .catch(setError);
  }, [chat]);
  useEffect(load, [load]);
  if (error) return <ErrorState touch={touch} error={error} retry={load} />;
  if (!topics) return <div className="flex-1" />;
  if (!topics.length) return <EmptyState touch={touch} sync={false} icon={Hash} title="Nenhum tópico" text="Este grupo ainda não tem tópicos." />;
  return (
    <div className={touch ? "pb-28" : "mx-auto max-w-[720px] px-6 pt-3 pb-10"}>
      <div className={touch ? "" : "surface overflow-hidden rounded-xl bg-s1"}>
        {topics.map((t) => (
          <button
            key={t.id}
            onClick={() => nav.chat(chat, t.id)}
            className={`flex w-full items-center gap-3 text-left ${touch ? "min-h-14 px-4 active:bg-s3" : "min-h-12 border-b border-hairline px-3.5 last:border-0 hover:bg-s2"}`}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-full" style={{ background: `#${(t.color || 0x6fb9f0).toString(16).padStart(6, "0")}33`, color: `#${(t.color || 0x6fb9f0).toString(16).padStart(6, "0")}` }}>
              <Hash size={18} />
            </span>
            <span className={`min-w-0 flex-1 truncate font-medium ${touch ? "text-[15px]" : "text-[14px]"}`}>{t.title}</span>
            {t.closed && <Lock size={14} className="shrink-0 text-fg-3" />}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- mídias do chat -----------------------------------------------------------------------

type Section = { key: string; label: string; items: ChatMedia[] };

function sections(items: ChatMedia[]): Section[] {
  const out: Section[] = [];
  const now = new Date();
  for (const m of items) {
    const d = new Date(m.date * 1000);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (out[out.length - 1]?.key !== key) {
      const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
      if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
      const s = d.toLocaleDateString("pt-BR", opts).replace(/\./g, "").replace(/ de /g, " ");
      out.push({ key, label: s[0].toUpperCase() + s.slice(1), items: [] });
    }
    out[out.length - 1].items.push(m);
  }
  return out;
}

/** Tile: tocar seleciona; segurar mostra a prévia enquanto o dedo/botão estiver no lugar. */
function Tile({
  m,
  chat,
  token,
  state,
  selected,
  onToggle,
  onPeek,
}: {
  m: ChatMedia;
  chat: string;
  token: string;
  state: "vault" | "queued" | null;
  selected: boolean;
  onToggle: () => void;
  onPeek: (m: ChatMedia | null) => void;
}) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const peeking = useRef(false);
  const [broken, setBroken] = useState(false);
  const locked = m.protected || state !== null;

  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  return (
    <div
      role="button"
      aria-pressed={selected}
      aria-label={`${m.video ? "Vídeo" : "Foto"} de ${new Date(m.date * 1000).toLocaleString("pt-BR")}`}
      className="relative aspect-square cursor-pointer overflow-hidden bg-s3 select-none touch-pan-y"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY };
        peeking.current = false;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          peeking.current = true;
          onPeek(m);
        }, 320);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        // Rolando a grade: não é toque nem prévia.
        if (s && !peeking.current && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) {
          cancel();
          start.current = null;
        }
      }}
      onPointerUp={() => {
        if (peeking.current) {
          peeking.current = false;
          onPeek(null);
        } else if (timer.current !== undefined && start.current && !locked) {
          onToggle();
        }
        cancel();
        start.current = null;
      }}
      onPointerCancel={() => {
        cancel();
        start.current = null;
        if (peeking.current) {
          peeking.current = false;
          onPeek(null);
        }
      }}
    >
      {m.thumb && token && !broken ? (
        <img
          src={chatThumbUrl(token, chat, m.id)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
          className={`size-full object-cover transition-transform duration-150 ${selected ? "scale-[0.86] rounded-md" : ""} ${locked ? "opacity-45" : ""}`}
        />
      ) : (
        <div className="grid size-full place-items-center text-fg-3">{m.video ? <Play size={22} /> : null}</div>
      )}
      {m.video && (
        <span className="absolute right-1.5 bottom-1.5 flex items-center gap-0.5 rounded bg-black/55 px-1 text-[11px] font-semibold text-white tabular">
          <Play size={10} className="fill-current" />
          {duration(m.duration)}
        </span>
      )}
      {m.protected ? (
        <span className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white" title="Protegido: o chat não permite salvar">
          <Lock size={13} />
        </span>
      ) : state === "vault" ? (
        <span className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white" title="Já está no vault">
          <CloudCheck size={14} />
        </span>
      ) : state === "queued" ? (
        <span className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white" title="Na fila de envios">
          <Clock size={13} />
        </span>
      ) : (
        <span className={`absolute top-1.5 left-1.5 ${selected ? "text-brand" : "text-white/90 drop-shadow"}`}>
          {selected ? <CheckCircle2 size={22} className="fill-white" /> : <Circle size={22} />}
        </span>
      )}
    </div>
  );
}

/** Prévia ao segurar: miniatura grande por cima de tudo; some ao soltar. */
function Peek({ m, chat, token }: { m: ChatMedia; chat: string; token: string }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-black/85 p-4 anim-fade">
      <div className="relative max-h-full max-w-full">
        <img src={chatThumbUrl(token, chat, m.id, true)} alt="" draggable={false} className="max-h-[80vh] max-w-full rounded-lg object-contain" />
        {m.video && (
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-14 place-items-center rounded-full bg-black/50 text-white">
              <Play size={26} className="fill-current" />
            </span>
          </span>
        )}
      </div>
      <p className="absolute inset-x-0 bottom-[calc(var(--inset-bottom)+24px)] text-center text-[13px] text-white/80 tabular">
        {new Date(m.date * 1000).toLocaleString("pt-BR", { dateStyle: "medium", timeStyle: "short" })} · {formatSize(m.size)}
        {m.video && m.duration ? ` · ${duration(m.duration)}` : ""}
      </p>
    </div>
  );
}

function MediaGrid({ chat, topic, touch }: { chat: string; topic: number | null; touch: boolean }) {
  const info = useChatInfo((s) => s[chat]);
  const token = useToken();
  const [items, setItems] = useState<ChatMedia[]>([]);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [inVault, setInVault] = useState<Set<number>>(new Set());
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [peek, setPeek] = useState<ChatMedia | null>(null);
  const uploads = useTransfers((s) => uploadStates(s.list));
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current || next === null) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      let before = next ?? 0;
      // Página só com texto/figurinhas: segue até achar mídia (ou acabar).
      for (let tries = 0; tries < 6; tries++) {
        const page = await api.chatMedia(chat, topic, before);
        if (page.items.length) {
          setItems((cur) => {
            const seen = new Set(cur.map((m) => m.id));
            return [...cur, ...page.items.filter((m) => !seen.has(m.id))];
          });
          const st = await api.backupStatus(page.items.map((m) => chatSrc(chat, m.id))).catch(() => [] as number[]);
          setInVault((cur) => new Set([...cur, ...page.items.filter((_, i) => st[i] === 2).map((m) => m.id)]));
        }
        setNext(page.next);
        if (page.items.length || page.next === null) break;
        before = page.next;
      }
    } catch (e) {
      setError(e);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [chat, topic, next]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sentinel = useSentinel(() => void load(), next !== null && !error);
  const groups = useMemo(() => sections(items), [items]);
  const stateOf = (m: ChatMedia): "vault" | "queued" | null => {
    if (inVault.has(m.id)) return "vault";
    const st = uploads.get(chatSrc(chat, m.id));
    return st && st !== "error" && st !== "canceled" ? (st === "done" ? "vault" : "queued") : null;
  };
  const free = items.filter((m) => !m.protected && !stateOf(m));
  const toggle = (id: number) =>
    setPicked((cur) => {
      const s = new Set(cur);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  const doImport = async () => {
    const chosen = items.filter((m) => picked.has(m.id));
    const n = await importMedia({ key: chat, title: info?.title ?? "Chat" }, chosen);
    if (n) setPicked(new Set());
  };

  if (error && !items.length) return <ErrorState touch={touch} error={error} retry={() => void load()} />;
  if (!items.length && next === null) {
    return <EmptyState touch={touch} sync={false} icon={MessagesSquare} title="Nenhuma foto ou vídeo" text="Este chat não tem fotos nem vídeos para importar." />;
  }

  const bar = picked.size > 0 && (
    <div
      className={`floating fixed z-30 flex items-center gap-2 rounded-2xl bg-s2 py-2 pr-2 pl-4 ${touch ? "inset-x-3" : "right-6 bottom-6 left-auto w-[440px]"}`}
      style={touch ? { bottom: "calc(var(--inset-bottom) + 12px)" } : undefined}
    >
      <p className="flex-1 text-[14px] font-semibold tabular">
        {picked.size} {picked.size === 1 ? "selecionada" : "selecionadas"}
      </p>
      <button onClick={() => setPicked(new Set())} className="h-10 rounded-lg px-3 text-[14px] font-semibold text-fg-2 active:bg-s3 hover:bg-s3">
        Limpar
      </button>
      <button onClick={() => void doImport()} className="step h-10 rounded-lg bg-brand px-4 text-[14px] font-semibold text-white active:translate-y-0.5">
        Importar
      </button>
    </div>
  );

  return (
    <div className={touch ? "pb-28" : "px-6 pt-2 pb-24"}>
      <div className={`flex items-center gap-2 ${touch ? "px-4 pb-1" : "pb-2"}`}>
        <p className="flex-1 text-[12px] text-fg-3">
          {info?.protected ? "Chat protegido: não dá para importar." : "Toque para escolher; segure para ver maior. A data é a de envio ao Telegram."}
        </p>
        {free.length > 0 && (
          <button
            onClick={() => setPicked(picked.size === free.length ? new Set() : new Set(free.map((m) => m.id)))}
            className={`shrink-0 rounded-lg px-2.5 font-semibold text-accent ${touch ? "h-9 text-[13px] active:bg-s3" : "h-8 text-[13px] hover:bg-s3"}`}
          >
            {picked.size === free.length ? "Desmarcar" : "Selecionar tudo"}
          </button>
        )}
      </div>
      {groups.map((g) => (
        <section key={g.key}>
          <h3 className={`font-semibold text-fg-2 ${touch ? "px-4 pt-3 pb-1.5 text-[13px]" : "pt-3 pb-1.5 text-[13px]"}`}>{g.label}</h3>
          <div className={`grid gap-0.5 ${touch ? "grid-cols-4" : "grid-cols-[repeat(auto-fill,minmax(132px,1fr))]"}`}>
            {g.items.map((m) => (
              <Tile key={m.id} m={m} chat={chat} token={token} state={stateOf(m)} selected={picked.has(m.id)} onToggle={() => toggle(m.id)} onPeek={setPeek} />
            ))}
          </div>
        </section>
      ))}
      {next !== null && (
        <div ref={sentinel} className={`grid gap-0.5 pt-0.5 ${touch ? "grid-cols-4" : "grid-cols-[repeat(auto-fill,minmax(132px,1fr))]"}`} aria-busy={loading}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton aspect-square" />
          ))}
        </div>
      )}
      {!!error && items.length > 0 && (
        <button onClick={() => void load()} className="mx-auto mt-3 block rounded-lg px-3 py-2 text-[13px] font-semibold text-accent">
          Não deu para carregar mais: {errText(error)}. Tentar de novo
        </button>
      )}
      {bar}
      {peek && token && <Peek m={peek} chat={chat} token={token} />}
    </div>
  );
}

/** Tela de um chat: tópicos (fórum sem tópico escolhido) ou a grade de mídias. */
export function ChatScreen({ touch }: { touch: boolean }) {
  const route = useRoute();
  const chat = route.chat ?? "";
  const info = useChatInfo((s) => s[chat]);
  if (!chat) return null;
  if (info?.kind === "forum" && !route.topic) return <TopicList key={chat} chat={chat} touch={touch} />;
  return <MediaGrid key={`${chat}#${route.topic ?? 0}`} chat={chat} topic={route.topic ?? null} touch={touch} />;
}

/** Título da barra na tela do chat. */
export function useChatTitle(): string {
  const route = useRoute();
  const info = useChatInfo((s) => (route.chat ? s[route.chat] : undefined));
  const topic = useTopicTitles((s) => (route.chat && route.topic ? s[topicKey(route.chat, route.topic)] : undefined));
  return topic ?? info?.title ?? "Chat";
}

