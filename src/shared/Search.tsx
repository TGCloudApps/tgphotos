/**
 * Resultados da busca da caixa única (Rust: intel::query). Mostra o que foi
 * entendido do texto em chips (data, lugar, tipo, álbum); resultado por
 * descrição vem por relevância, só com filtros vem na linha do tempo.
 */
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Film, Images, Library, Loader2, MapPin, Search, Sparkles, X } from "lucide-react";
import { EmptyState } from "@tgcloud/ui/ui/States";
import { api, type IntelChip } from "../core/api";
import { useAlbums } from "../core/data";
import { nav } from "../core/nav";
import { Timeline } from "../timeline/Timeline";

const chipIcon = { date: CalendarDays, place: MapPin, kind: Film, album: Library } as const;

/** Sugestões para começar (tocar preenche a busca). */
const IDEAS = ["praia", "pôr do sol", "aniversário", "comida", "ano passado", "vídeos", "documento", "cachorro"];

export function SearchResults({ text, album, touch, bottom = 24 }: { text: string; album: number; touch: boolean; bottom?: number }) {
  const { data: albums } = useAlbums();
  const scope = album ? albums?.find((a) => a.id === album) : undefined;
  const active = text.trim().length > 0 || album > 0;
  const q = useQuery({
    queryKey: ["intel-search", text.trim(), album],
    queryFn: () => api.intelQuery(text.trim(), album || null),
    enabled: active,
    placeholderData: (prev) => prev,
  });
  const status = useQuery({ queryKey: ["intel-status"], queryFn: api.intelStatus, refetchInterval: 15_000, enabled: !active });

  const chips: IntelChip[] = [...(scope ? [{ kind: "album" as const, label: scope.name }] : []), ...(q.data?.chips ?? [])];
  const pad = touch ? "px-3" : "px-5";

  const bar = (chips.length > 0 || q.isFetching) && (
    <div className={`flex shrink-0 flex-wrap items-center gap-1.5 pb-2 ${pad}`}>
      {chips.map((c, i) => {
        const Icon = chipIcon[c.kind];
        return (
          <span key={i} className="surface flex h-8 items-center gap-1.5 rounded-full bg-s2 pr-3 pl-2.5 text-[13px] font-semibold text-fg">
            <Icon size={14} className="text-brand" /> {c.label}
            {c.kind === "album" && (
              <button type="button" onClick={() => nav.go({ dest: "search", album: 0, query: text })} className="-mr-1.5 grid size-6 place-items-center rounded-full text-fg-2 hover:bg-s4" aria-label="Buscar no vault todo">
                <X size={13} />
              </button>
            )}
          </span>
        );
      })}
      {q.data?.semantic && text.trim() && (
        <span className="flex h-8 items-center gap-1 px-1 text-[12px] text-fg-3">
          <Sparkles size={13} /> por descrição
        </span>
      )}
      {q.isFetching && <Loader2 size={15} className="ml-1 animate-spin text-fg-3" />}
    </div>
  );

  if (!active) {
    const clip = status.data?.stages.find((s) => s.stage === "clip");
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto max-w-lg py-8 ${pad}`}>
          <div className="step grid size-12 place-items-center rounded-xl bg-brand text-white">
            <Search size={22} />
          </div>
          <h2 className="mt-4 font-heading text-[22px] font-bold tracking-tight text-fg-title">Buscar fotos</h2>
          <p className="mt-1 text-[14px] text-fg-2">Descreva o que tem na foto, um lugar ou uma época: “praia ao pôr do sol”, “Salvador”, “março de 2023”. Dá para juntar: “vídeos de aniversário ano passado”.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {IDEAS.map((t) => (
              <button key={t} type="button" onClick={() => nav.search(t)} className={`surface rounded-full bg-s2 px-3.5 font-semibold text-fg hover:bg-s3 active:translate-y-px ${touch ? "h-10 text-[14px]" : "h-9 text-[13px]"}`}>
                {t}
              </button>
            ))}
          </div>
          {clip && clip.total > 0 && clip.done < clip.total && (
            <button type="button" onClick={() => nav.open({ type: "intel" })} className="surface mt-6 flex w-full items-center gap-3 rounded-xl bg-s1 px-3.5 py-3 text-left hover:bg-s2">
              <Images size={20} className="shrink-0 text-brand" />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold">Analisando a biblioteca</span>
                <span className="block text-[12px] text-fg-2 tabular">
                  {clip.done.toLocaleString("pt-BR")} de {clip.total.toLocaleString("pt-BR")} prontas para a busca por descrição
                </span>
              </span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {bar}
      {q.data && !q.data.items.length ? (
        <EmptyState touch={touch} icon={Search} title="Nada encontrado" text={text.trim() ? `Nenhuma foto combina com “${text.trim()}”.` : "Nenhuma foto neste álbum."} />
      ) : q.data ? (
        // Por descrição: ordem de relevância (sem dias); só filtros: linha do tempo.
        <Timeline key={`${text}|${album}`} items={q.data.items} touch={touch} grouped={!(q.data.semantic && text.trim())} bottom={bottom} />
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}
