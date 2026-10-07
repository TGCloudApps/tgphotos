/**
 * Duplicatas: grupos de fotos iguais ou quase iguais (Rust: intel::dups), com
 * a sugerida para ficar. "Manter só a melhor" manda as outras para a
 * lixeira (30 dias) e passa favorito e álbuns delas para a que fica.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2 } from "lucide-react";
import { formatDate } from "@tgcloud/ui/core/format";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { EmptyState } from "@tgcloud/ui/ui/States";
import { api, type Media } from "../core/api";
import { nav } from "../core/nav";
import { refresh } from "../core/data";
import { Cover } from "../timeline/Cover";

type Group = { key: string; kind: "exact" | "similar" | "burst"; best: number; items: Media[] };

export const useDuplicates = () => useQuery({ queryKey: ["duplicates"], queryFn: () => api.dupGroups() as Promise<Group[]>, staleTime: 5 * 60_000 });

const KIND: Record<Group["kind"], string> = {
  exact: "Arquivos idênticos",
  similar: "Mesma foto, outra cópia",
  burst: "Fotos muito parecidas",
};

export function DuplicatesScreen({ touch }: { touch: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useDuplicates();
  const [busy, setBusy] = useState<string | null>(null);

  const keepBest = async (g: Group) => {
    setBusy(g.key);
    try {
      const best = g.items.find((m) => m.id === g.best)!;
      const others = g.items.filter((m) => m.id !== g.best);
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

  if (isLoading) return <div className="grid flex-1 place-items-center"><Loader2 className="animate-spin text-fg-3" /></div>;
  if (!data?.length)
    return (
      <div className="grid flex-1 place-items-center">
        <EmptyState touch={touch} sync={false} icon={Copy} title="Nenhuma duplicata" text="Fotos repetidas aparecem aqui conforme a biblioteca é analisada." />
      </div>
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-24">
      <div className={touch ? "space-y-3 px-3 pt-2" : "mx-auto max-w-[880px] space-y-4 px-6 pt-4"}>
        <p className="px-1 text-[13px] text-fg-3">{data.length === 1 ? "1 grupo" : `${data.length} grupos`}. A marcada com ✓ é a sugerida para ficar. Nada é apagado de vez: vai para a lixeira por 30 dias.</p>
        {data.map((g) => (
          <section key={g.key} className="surface rounded-2xl bg-s1 p-3">
            <p className="px-1 pb-2 text-[13px]">
              <span className="font-semibold">{KIND[g.kind]}</span>
              <span className="text-fg-3"> · {formatDate(g.items[0]?.taken_at ?? 0)} · {g.items.length} fotos</span>
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
              {g.items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => nav.open({ type: "viewer", id: m.id, siblings: g.items.map((x) => x.id) })}
                  className={`relative shrink-0 overflow-hidden rounded-lg bg-s2 ${touch ? "size-28" : "size-32"} ${m.id === g.best ? "ring-[3px] ring-brand" : ""}`}
                >
                  <Cover m={m} selected={false} />
                  {m.id === g.best && (
                    <span className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-brand text-white ring-2 ring-s1">
                      <Check size={14} strokeWidth={3} />
                    </span>
                  )}
                  {m.width && m.height ? <span className="absolute right-1 bottom-1 rounded bg-black/55 px-1 text-[10px] text-white tabular">{m.width}×{m.height}</span> : null}
                </button>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy === g.key} onClick={() => void keepBest(g)} className="step flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand text-[14px] font-semibold text-white disabled:opacity-60">
                {busy === g.key ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Manter só a melhor
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
