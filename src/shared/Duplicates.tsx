/**
 * Duplicatas: grupos de fotos iguais ou quase iguais (Rust: intel::dups), com
 * a sugerida para ficar. "Manter só a melhor" manda as outras para a
 * lixeira (30 dias) e passa favorito e álbuns delas para a que fica.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Maximize2 } from "lucide-react";
import { formatDate } from "@tgcloud/ui/core/format";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { EmptyState } from "@tgcloud/ui/ui/States";
import { api, type Media } from "../core/api";
import { nav } from "../core/nav";
import { refresh, useList } from "../core/data";
import { Cover } from "../timeline/Cover";

type Group = { key: string; kind: "exact" | "similar" | "burst"; best: number; items: Media[] };

export const useDuplicates = () => useQuery({ queryKey: ["duplicates"], queryFn: () => api.dupGroups() as Promise<Group[]>, staleTime: 5 * 60_000 });

const KIND: Record<Group["kind"], { title: string; text: string }> = {
  exact: { title: "Arquivos idênticos", text: "O mesmo arquivo, enviado mais de uma vez." },
  similar: { title: "Mesma foto, outra cópia", text: "A mesma imagem em outro tamanho ou qualidade (ex.: recebida por mensagem)." },
  burst: { title: "Fotos muito parecidas", text: "Tiradas em sequência, com poucos minutos de diferença." },
};

export function DuplicatesScreen({ touch }: { touch: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useDuplicates();
  const { data: all } = useList("timeline");
  const [busy, setBusy] = useState<string | null>(null);
  // Qual fica, por grupo (tocar escolhe; sem escolha, a sugerida).
  const [keep, setKeep] = useState<Record<string, number>>({});
  const kept = (g: Group) => keep[g.key] ?? g.best;

  const keepBest = async (g: Group) => {
    setBusy(g.key);
    try {
      const best = g.items.find((m) => m.id === kept(g))!;
      const others = g.items.filter((m) => m.id !== best.id);
      // A que fica herda o favorito e os álbuns das outras.
      if (!best.favorite && others.some((m) => m.favorite)) await api.setFavorite([best.id], true);
      const albums = new Set<number>();
      for (const m of others) for (const a of (await api.details(m.id))?.albums ?? []) albums.add(a.id);
      for (const a of albums) await api.albumAdd(a, [best.id]);
      await api.trash(others.map((m) => m.id));
      notify({ text: `${others.length} ${others.length === 1 ? "cópia foi" : "cópias foram"} para a lixeira`, tone: "success" });
      void qc.invalidateQueries({ queryKey: ["duplicates"] });
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const keepAll = async (g: Group) => {
    await api.dupKeep(g.key).catch(notifyError);
    qc.setQueryData<Group[]>(["duplicates"], (cur) => cur?.filter((x) => x.key !== g.key));
  };

  if (isLoading)
    return (
      <div className={touch ? "space-y-3 px-3 pt-2" : "mx-auto w-full max-w-[880px] space-y-4 px-6 pt-4"}>
        <p className="flex items-center gap-2 px-1 text-[13px] text-fg-3 tabular">
          <Loader2 size={14} className="animate-spin" /> Comparando {all ? `${all.length.toLocaleString("pt-BR")} fotos` : "as fotos"}…
        </p>
        {[0, 1, 2].map((i) => (
          <div key={i} className="surface rounded-2xl bg-s1 p-3">
            <div className="skeleton mb-3 h-4 w-48 rounded" />
            <div className="flex gap-2">
              {[0, 1, 2].map((j) => (
                <div key={j} className={`skeleton shrink-0 rounded-lg ${touch ? "size-28" : "size-32"}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  if (!data?.length)
    return (
      <div className="grid flex-1 place-items-center">
        <EmptyState touch={touch} sync={false} icon={Copy} title="Nenhuma duplicata" text="Fotos repetidas aparecem aqui conforme a biblioteca é analisada." />
      </div>
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-24">
      <div className={touch ? "space-y-3 px-3 pt-2" : "mx-auto max-w-[880px] space-y-4 px-6 pt-4"}>
        <p className="px-1 text-[13px] text-fg-3">{data.length === 1 ? "1 grupo" : `${data.length} grupos`}. A marcada com ✓ fica; {touch ? "toque" : "clique"} em outra para escolher. Nada é apagado de vez: vai para a lixeira por 30 dias.</p>
        {data.map((g) => (
          <section key={g.key} className="surface rounded-2xl bg-s1 p-3">
            <p className="px-1 pb-2 text-[13px]">
              <span className="font-semibold">{KIND[g.kind].title}</span>
              <span className="text-fg-3"> · {formatDate(g.items[0]?.taken_at ?? 0)} · {g.items.length} fotos</span>
              <span className="block text-[12px] text-fg-3">{KIND[g.kind].text}</span>
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
              {g.items.map((m) => (
                <div
                  key={m.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={m.id === kept(g)}
                  onClick={() => setKeep((k) => ({ ...k, [g.key]: m.id }))}
                  className={`group relative shrink-0 cursor-pointer overflow-hidden rounded-lg bg-s2 ${touch ? "size-28" : "size-32"} ${m.id === kept(g) ? "ring-[3px] ring-brand" : ""}`}
                >
                  <Cover m={m} selected={false} />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      nav.open({ type: "viewer", id: m.id, siblings: g.items.map((x) => x.id) });
                    }}
                    className={`absolute top-1 right-1 grid size-7 place-items-center rounded-full bg-black/50 text-white ${touch ? "" : "opacity-0 group-hover:opacity-100"}`}
                    aria-label="Ver maior"
                  >
                    <Maximize2 size={13} />
                  </button>
                  {m.id === kept(g) && (
                    <span className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-brand text-white ring-2 ring-s1">
                      <Check size={14} strokeWidth={3} />
                    </span>
                  )}
                  {m.width && m.height ? <span className="absolute right-1 bottom-1 rounded bg-black/55 px-1 text-[10px] text-white tabular">{m.width}×{m.height}</span> : null}
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy === g.key} onClick={() => void keepBest(g)} className="step flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand text-[14px] font-semibold text-white disabled:opacity-60">
                {busy === g.key ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Manter 1 · {g.items.length - 1} para a lixeira
              </button>
              <button type="button" onClick={() => void keepAll(g)} className="surface h-10 flex-1 rounded-lg bg-s2 text-[14px] font-semibold hover:bg-s3">
                Manter todas
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
