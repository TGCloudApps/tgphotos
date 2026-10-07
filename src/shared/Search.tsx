/**
 * Busca (Rust: intel::query), no espírito do Google Fotos:
 *
 * - Sem texto: Explorar — Pessoas, Lugares, Categorias e buscas recentes.
 * - Com texto: duas fases. A rápida (filtros, nomes, texto lido) aparece na
 *   hora; a da descrição (SigLIP2, que carrega um modelo grande na primeira
 *   vez) chega depois e soma. Um erro na segunda nunca esconde a primeira.
 * - Chips com o que foi entendido (data, lugar, pessoa, tipo, álbum).
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Camera,
  CalendarDays,
  Clock,
  Dog,
  FileText,
  Film,
  Heart,
  Library,
  Loader2,
  MapPin,
  Mountain,
  PartyPopper,
  Search,
  Smartphone,
  ScanSearch,
  Info,
  Sunset,
  UserRound,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { thumbUrl } from "@tgcloud/ui/core/thumbs";
import { errText } from "@tgcloud/ui/core/server";
import { EmptyState } from "@tgcloud/ui/ui/States";
import { api, type IntelChip, type IntelResult, type IntelStatus, type SemanticState } from "../core/api";
import { formatSize } from "@tgcloud/ui/core/format";
import { useAlbums } from "../core/data";
import { nav } from "../core/nav";
import { Timeline } from "../timeline/Timeline";
import { FaceAvatar, usePeople } from "./People";

const chipIcon = { date: CalendarDays, place: MapPin, kind: Film, album: Library, person: UserRound } as const;

/** Categorias do Explorar: cada uma vira uma busca (descrição ou filtro). */
/** `semantic` = depende da busca por descrição (sem o modelo, "em breve"). */
const CATEGORIES: { label: string; query: string; icon: typeof Camera; semantic: boolean }[] = [
  { label: "Vídeos", query: "vídeos", icon: Film, semantic: false },
  { label: "Capturas de tela", query: "captura de tela", icon: Smartphone, semantic: true },
  { label: "Documentos", query: "documento", icon: FileText, semantic: true },
  { label: "Selfies", query: "selfie", icon: Camera, semantic: true },
  { label: "Comida", query: "comida", icon: UtensilsCrossed, semantic: true },
  { label: "Animais", query: "animal de estimação", icon: Dog, semantic: true },
  { label: "Paisagens", query: "paisagem", icon: Mountain, semantic: true },
  { label: "Pôr do sol", query: "pôr do sol", icon: Sunset, semantic: true },
  { label: "Festas", query: "festa aniversário", icon: PartyPopper, semantic: true },
];

// ---- buscas recentes (só neste aparelho) ------------------------------------------------

const RECENT_KEY = "search-recent";
function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function remember(q: string) {
  const t = q.trim();
  if (t.length < 2) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([t, ...recent().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8)));
  } catch {
    /* sem armazenamento */
  }
}
/** Tira de `text` o pedaço que virou um chip (o ✕ do chip). */
function without(text: string, piece: string) {
  if (!piece) return text;
  const i = text.toLowerCase().indexOf(piece.toLowerCase());
  if (i < 0) return text;
  return (text.slice(0, i) + text.slice(i + piece.length)).replace(/\s+/g, " ").trim();
}

/** Por que a busca por descrição não cobre tudo, em palavras; `null` = cobre. */
function semanticNote(s: SemanticState | null | undefined): string | null {
  if (!s) return null;
  if (s.state === "off") return "A busca por descrição está desligada: só nomes, lugares, pessoas, datas e texto lido entram.";
  if (s.state === "model") {
    const m = s.model;
    if (m?.state === "downloading" && m.size) return `Preparando a busca por descrição: baixando o modelo (${formatSize(m.done)} de ${formatSize(m.size)}).`;
    if (m?.state === "failed") return "A busca por descrição não está disponível: o modelo não foi baixado.";
    return "A busca por descrição ainda não está pronta: o modelo será baixado no Wi-Fi.";
  }
  const pct = s.total ? Math.floor((s.done / s.total) * 100) : 0;
  return `${pct}% da biblioteca analisada: fotos ainda não analisadas não aparecem na busca por descrição.`;
}

/** A busca por descrição funciona (modelo pronto), mesmo que pela metade. */
function semanticReady(st: IntelStatus | undefined) {
  if (!st) return true;
  if (!st.settings.search) return false;
  const m = st.models.find((x) => x.stage === "clip");
  return !m || m.state === "ready";
}

function forget(q: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent().filter((x) => x !== q)));
  } catch {
    /* sem armazenamento */
  }
}

// ---- resultados ---------------------------------------------------------------------------

export function SearchResults({ text, album, touch, bottom = 24 }: { text: string; album: number; touch: boolean; bottom?: number }) {
  const { data: albums } = useAlbums();
  const scope = album ? albums?.find((a) => a.id === album) : undefined;
  const t = text.trim();
  const active = t.length > 0 || album > 0;

  // Fase 1: rápida (sem descrição). Fase 2: com descrição, quando há texto.
  const fast = useQuery({
    queryKey: ["search-fast", t, album],
    queryFn: () => api.intelQuery(t, album || null, false),
    enabled: active,
    placeholderData: (prev) => prev,
  });
  const deep = useQuery({
    queryKey: ["search-deep", t, album],
    queryFn: () => api.intelQuery(t, album || null, true),
    enabled: active && t.length > 0,
    retry: false,
    staleTime: 60_000,
  });

  // Busca que mostrou resultado entra nas recentes (depois de parar de digitar).
  useEffect(() => {
    if (!t || !fast.data?.items.length) return;
    const h = setTimeout(() => remember(t), 1500);
    return () => clearTimeout(h);
  }, [t, fast.data]);

  if (!active) return <Explore touch={touch} />;

  // A profunda, quando chega, substitui a rápida (ela já inclui o que a rápida achou).
  const deepBusy = t.length > 0 && deep.isFetching;
  const data: IntelResult | undefined = deep.data?.items.length ? deep.data : fast.data;
  const chips: IntelChip[] = [...(scope ? [{ kind: "album" as const, label: scope.name, text: "" }] : []), ...(data?.chips ?? [])];
  // O aviso só faz sentido quando sobrou texto para descrever.
  const note = t && !deepBusy ? semanticNote((deep.data ?? fast.data)?.semantic_state) : null;
  const pad = touch ? "px-4" : "px-5";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex shrink-0 flex-wrap items-center gap-1.5 pt-1 pb-2.5 ${pad}`}>
        {chips.map((c, i) => {
          const Icon = chipIcon[c.kind] ?? Search;
          return (
            <span key={i} className="surface flex h-8 items-center gap-1.5 rounded-full bg-s2 pr-3 pl-2.5 text-[13px] font-semibold text-fg anim-fade">
              <Icon size={14} className="text-brand" /> {c.label}
              {(c.kind === "album" && !c.text) || c.text ? (
                <button
                  type="button"
                  onClick={() => nav.go(c.kind === "album" && !c.text ? { dest: "search", album: 0, query: text } : { dest: "search", album, query: without(text, c.text) })}
                  className={`-mr-1.5 grid place-items-center rounded-full text-fg-2 hover:bg-s4 ${touch ? "size-7" : "size-6"}`}
                  aria-label={`Tirar “${c.label}” da busca`}
                >
                  <X size={13} />
                </button>
              ) : null}
            </span>
          );
        })}
        <span className="flex h-8 items-center gap-1.5 px-1 text-[12px] text-fg-3 tabular">
          {data && `${data.items.length.toLocaleString("pt-BR")} ${data.items.length === 1 ? "resultado" : "resultados"}`}
          {deepBusy ? (
            <>
              <Loader2 size={13} className="animate-spin" /> procurando pela descrição…
            </>
          ) : deep.data?.semantic ? (
            <>
              <ScanSearch size={13} /> inclui busca por descrição
            </>
          ) : null}
        </span>
      </div>

      <Suggestions text={t} touch={touch} />
      {note && (
        <button type="button" onClick={() => nav.open({ type: "intel" })} className={`mb-2.5 flex shrink-0 items-start gap-2.5 text-left text-[12px] text-fg-3 anim-fade ${pad}`}>
          <Info size={14} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">{note}</span>
        </button>
      )}
      {fast.isError && !data ? (
        <EmptyState touch={touch} sync={false} icon={Search} title="Não deu para buscar" text={errText(fast.error)} />
      ) : !data ? (
        <ResultsSkeleton touch={touch} />
      ) : !data.items.length ? (
        deepBusy ? (
          <ResultsSkeleton touch={touch} />
        ) : (
          <EmptyState
            touch={touch}
            sync={false}
            icon={Search}
            title="Nada encontrado"
            text={t ? `Nenhuma foto combina com “${t}”. Tente descrever de outro jeito, ou um lugar, uma pessoa ou uma data.` : "Nenhuma foto neste álbum."}
          />
        )
      ) : (
        // Com descrição: por relevância (sem dias). Só filtros: linha do tempo.
        <Timeline key={`${t}|${album}|${data === deep.data}`} items={data.items} touch={touch} grouped={!(data.semantic && t)} bottom={bottom} />
      )}
    </div>
  );
}

/** Pessoas, lugares e álbuns que começam com o que foi digitado. */
function Suggestions({ text, touch }: { text: string; touch: boolean }) {
  const { data: people } = usePeople();
  const { data: places } = useQuery({ queryKey: ["places"], queryFn: api.placesList, staleTime: 5 * 60_000 });
  const { data: albums } = useAlbums();
  const q = text.toLocaleLowerCase("pt-BR");
  if (q.length < 2) return null;
  const hit = (s: string) => {
    const l = s.toLocaleLowerCase("pt-BR");
    return l !== q && (l.startsWith(q) || l.includes(` ${q}`));
  };
  const out: { key: string; label: string; icon: typeof Camera; run: () => void }[] = [];
  for (const p of people ?? []) if (p.name && !p.hidden && hit(p.name)) out.push({ key: `p${p.uid}`, label: p.name, icon: UserRound, run: () => nav.openSearch(p.name) });
  for (const pl of places ?? []) if (hit(pl.city)) out.push({ key: `l${pl.city}|${pl.country}`, label: pl.city, icon: MapPin, run: () => nav.openSearch(pl.city) });
  for (const a of albums ?? []) if (hit(a.name)) out.push({ key: `a${a.id}`, label: a.name, icon: Library, run: () => nav.go({ dest: "search", album: a.id, query: "" }) });
  if (!out.length) return null;
  return (
    <div className={`-mt-1 flex shrink-0 gap-1.5 overflow-x-auto pb-2.5 [scrollbar-width:none] ${touch ? "px-4" : "px-5"}`}>
      {out.slice(0, 8).map(({ key, label, icon: Icon, run }) => (
        <button key={key} type="button" onClick={run} className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-hairline px-3 text-[13px] text-fg-2 ${touch ? "active:bg-s3" : "hover:bg-s3"}`}>
          <Icon size={14} className="text-fg-3" /> {label}
        </button>
      ))}
    </div>
  );
}

function ResultsSkeleton({ touch }: { touch: boolean }) {
  return (
    <div className={`grid gap-0.5 ${touch ? "grid-cols-4" : "grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1 px-4"}`}>
      {Array.from({ length: touch ? 16 : 18 }, (_, i) => (
        <div key={i} className="skeleton aspect-square rounded-none" />
      ))}
    </div>
  );
}

// ---- Explorar (sem texto) ---------------------------------------------------------------------

function Explore({ touch }: { touch: boolean }) {
  const { data: people } = usePeople();
  const { data: places } = useQuery({ queryKey: ["places"], queryFn: api.placesList, staleTime: 5 * 60_000 });
  const status = useQuery({ queryKey: ["intel-status"], queryFn: api.intelStatus, refetchInterval: 15_000 });
  const [recents, setRecents] = useState(recent);
  const named = (people ?? []).filter((p) => !p.hidden).slice(0, 16);
  const pad = touch ? "px-4" : "px-6";
  const clip = status.data?.stages.find((s) => s.stage === "clip");
  const faces = status.data?.stages.find((s) => s.stage === "faces");
  const ready = semanticReady(status.data);

  const head = (title: string, more?: { label: string; run: () => void }) => (
    <div className={`flex items-baseline pt-6 pb-3 ${pad}`}>
      <h2 className="flex-1 text-[17px] font-semibold tracking-tight">{title}</h2>
      {more && (
        <button type="button" onClick={more.run} className="text-[13px] font-semibold text-accent">
          {more.label}
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-28">
      <div className={touch ? "" : "mx-auto max-w-[1100px]"}>
        {recents.length > 0 && (
          <>
            {head("Buscas recentes")}
            <div className={`flex flex-wrap gap-2 ${pad}`}>
              {recents.map((q) => (
                <span key={q} className="surface flex h-9 items-center rounded-full bg-s2 pr-1 pl-3 text-[14px]">
                  <button type="button" onClick={() => nav.openSearch(q)} className="flex items-center gap-1.5 font-medium">
                    <Clock size={14} className="text-fg-3" /> {q}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      forget(q);
                      setRecents(recent());
                    }}
                    className="ml-1 grid size-7 place-items-center rounded-full text-fg-3 hover:bg-s4"
                    aria-label={`Tirar “${q}” das recentes`}
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          </>
        )}

        {named.length > 0 && (
          <>
            {head("Pessoas", { label: "Ver todas", run: () => nav.dest("people") })}
            <div className={`flex gap-4 overflow-x-auto pb-1 [scrollbar-width:none] ${pad}`}>
              {named.map((p) => (
                <button key={p.uid} type="button" onClick={() => (p.name ? nav.openSearch(p.name) : nav.person(p.uid))} className="flex w-[84px] shrink-0 flex-col items-center gap-1.5">
                  <FaceAvatar face={p.cover} size={touch ? 80 : 84} />
                  <span className={`w-full truncate text-center text-[13px] ${p.name ? "font-medium" : "text-fg-3"}`}>{p.name || "Adicionar nome"}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {!named.length && status.data?.settings.people && faces && faces.total > 0 && faces.done < faces.total && (
          <>
            {head("Pessoas")}
            <button type="button" onClick={() => nav.dest("people")} className={`flex w-full items-center gap-3 text-left ${pad}`}>
              <span className="grid size-14 shrink-0 place-items-center rounded-full bg-s2 text-fg-3">
                <UserRound size={22} />
              </span>
              <span className="min-w-0 flex-1 text-[13px] text-fg-3 tabular">
                Encontrando rostos: {faces.done.toLocaleString("pt-BR")} de {faces.total.toLocaleString("pt-BR")} fotos. As pessoas aparecem aqui conforme a análise avança.
              </span>
            </button>
          </>
        )}

        {!!places?.length && (
          <>
            {head("Lugares", { label: "Ver no mapa", run: () => nav.dest("map") })}
            <div className={`flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] ${pad}`}>
              {places.map((pl) => (
                <button key={`${pl.city}|${pl.country}`} type="button" onClick={() => nav.openSearch(pl.city)} className="group w-[132px] shrink-0 text-left">
                  <span className="relative block aspect-square overflow-hidden rounded-xl bg-s2">
                    {pl.cover > 0 && <img src={thumbUrl(pl.cover)} alt="" loading="lazy" draggable={false} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />}
                    <span className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 to-transparent" />
                    <span className="absolute inset-x-2 bottom-2 truncate text-[14px] font-semibold text-white">{pl.city}</span>
                  </span>
                  <span className="mt-1 block truncate text-[12px] text-fg-3 tabular">
                    {pl.country} · {pl.count.toLocaleString("pt-BR")}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {head("Categorias")}
        <div className={`grid gap-2 ${touch ? "grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(180px,1fr))]"} ${pad}`}>
          {CATEGORIES.map(({ label, query, icon: Icon, semantic }) => (
            <button key={label} type="button" onClick={() => nav.openSearch(query)} className={`surface flex items-center gap-3 rounded-xl bg-s1 px-3.5 text-left font-semibold ${touch ? "h-14 text-[15px] active:bg-s3" : "h-12 text-[14px] hover:bg-s3"}`}>
              <Icon size={20} className={`shrink-0 ${semantic && !ready ? "text-fg-3" : "text-brand"}`} />
              <span className="min-w-0 flex-1">
                {label}
                {semantic && !ready && <span className="block text-[11px] font-normal text-fg-3">em breve</span>}
              </span>
            </button>
          ))}
          <button type="button" onClick={() => nav.dest("favorites")} className={`surface flex items-center gap-3 rounded-xl bg-s1 px-3.5 text-left font-semibold ${touch ? "h-14 text-[15px] active:bg-s3" : "h-12 text-[14px] hover:bg-s3"}`}>
            <Heart size={20} className="shrink-0 text-brand" /> Favoritos
          </button>
        </div>

        {clip && clip.total > 0 && clip.done < clip.total && (
          <button type="button" onClick={() => nav.open({ type: "intel" })} className={`mt-6 flex w-full items-center gap-3 text-left ${pad}`}>
            <ScanSearch size={18} className="shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 text-[13px] text-fg-3 tabular">
              Analisando a biblioteca: {clip.done.toLocaleString("pt-BR")} de {clip.total.toLocaleString("pt-BR")} fotos prontas para a busca por descrição.
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
