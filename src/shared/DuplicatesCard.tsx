/** Atalho em Coleções para as duplicatas, só quando há grupos. */
import { ChevronRight, Copy } from "lucide-react";
import { nav } from "../core/nav";
import { useDuplicates } from "./Duplicates";

export function DuplicatesCard({ touch }: { touch: boolean }) {
  const { data } = useDuplicates();
  const n = data?.length ?? 0;
  if (!n) return null;
  const extra = data!.reduce((s, g) => s + g.items.length - 1, 0);
  return (
    <button type="button" onClick={() => nav.dest("duplicates")} className={`surface mb-4 flex w-full items-center gap-3 rounded-xl bg-s1 px-3.5 text-left ${touch ? "min-h-14 active:bg-s3" : "min-h-12 hover:bg-s3"}`}>
      <Copy size={20} className="shrink-0 text-brand" />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold">Duplicatas</span>
        <span className="block text-[12px] text-fg-3 tabular">
          {n} {n === 1 ? "grupo" : "grupos"} · {extra} {extra === 1 ? "cópia" : "cópias"} a revisar
        </span>
      </span>
      <ChevronRight size={18} className="text-fg-3" />
    </button>
  );
}
