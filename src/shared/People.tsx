/**
 * Pessoas (rostos agrupados neste aparelho): a faixa em Coleções, a tela de
 * todas e a tela de uma pessoa. Nomear, mesclar e ocultar; o que é decidido
 * à mão o automático não desfaz (Rust: intel::people).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Eye, EyeOff, Merge, ScanFace, Smartphone, UserRound, UserRoundX, X } from "lucide-react";
import { getPort } from "@tgcloud/ui/core/server";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { confirmAction } from "@tgcloud/ui/ui/Confirm";
import { EmptyState } from "@tgcloud/ui/ui/States";
import { api, type Person } from "../core/api";
import { deviceToken, tokenNow } from "../core/local";
import { nav } from "../core/nav";
import { Timeline } from "../timeline/Timeline";

const photos = (n: number) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "foto" : "fotos"}`;

/** Confirma a mesclagem mostrando quem entra em quem e o nome que fica. */
async function confirmMerge(chosen: Person[]) {
  const keep = chosen.find((p) => p.name)?.name;
  return confirmAction({
    title: `Mesclar ${chosen.length} pessoas?`,
    body: (
      <>
        <span className="mb-3 flex justify-center -space-x-3">
          {chosen.slice(0, 5).map((p) => (
            <FaceAvatar key={p.uid} face={p.cover} size={52} className="ring-2 ring-s1" />
          ))}
        </span>
        {keep ? `Todas as fotos passam a ser de “${keep}”.` : "Todas as fotos passam a ser de uma pessoa só, ainda sem nome."} Rostos errados podem ser tirados depois, na aba Rostos.
      </>
    ),
    cta: "Mesclar",
  });
}

export const usePeople = () => useQuery({ queryKey: ["people"], queryFn: api.peopleList, refetchInterval: 30_000 });

function useToken() {
  const [t, setT] = useState(tokenNow());
  useEffect(() => {
    if (!t) void deviceToken().then(setT);
  }, [t]);
  return t;
}

/** Avatar redondo recortado do rosto da capa. */
export function FaceAvatar({ face, size, className = "" }: { face: number | null; size: number; className?: string }) {
  const t = useToken();
  const [bad, setBad] = useState(false);
  const url = face && t && !bad ? `http://127.0.0.1:${getPort()}/face/${face}?t=${t}` : null;
  return (
    <span className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-s3 text-fg-3 ${className}`} style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" draggable={false} loading="lazy" onError={() => setBad(true)} className="size-full object-cover" /> : <UserRound size={size * 0.45} />}
    </span>
  );
}

/** Faixa de Coleções: as pessoas mais presentes, com "Ver todas". */
export function PeopleStrip({ touch }: { touch: boolean }) {
  const { data } = usePeople();
  const shown = (data ?? []).filter((p) => !p.hidden).slice(0, 12);
  if (!shown.length) return null;
  return (
    <section className="mb-6">
      <button type="button" onClick={() => nav.dest("people")} className={`flex w-full items-center gap-2 pb-3 text-left ${touch ? "px-4" : ""}`}>
        <h2 className="flex-1 text-[16px] font-semibold">Pessoas</h2>
        <span className="flex items-center text-[13px] font-semibold text-accent">
          Ver todas <ChevronRight size={16} />
        </span>
      </button>
      <div className={`flex gap-4 overflow-x-auto pb-1 [scrollbar-width:none] ${touch ? "px-4" : ""}`}>
        {shown.map((p) => (
          <button key={p.uid} type="button" onClick={() => nav.person(p.uid)} className="flex w-[76px] shrink-0 flex-col items-center gap-1.5">
            <FaceAvatar face={p.cover} size={touch ? 72 : 68} className="ring-2 ring-transparent transition hover:ring-brand" />
            <span className={`w-full truncate text-center text-[12px] ${p.name ? "font-semibold text-fg" : "text-fg-3"}`}>{p.name || "Sem nome"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Todas as pessoas: com nome, sem nome e ocultas; selecionar várias → mesclar ou ocultar. */
export function PeopleScreen({ touch }: { touch: boolean }) {
  const qc = useQueryClient();
  const { data } = usePeople();
  const { data: st } = useQuery({ queryKey: ["intel-status"], queryFn: api.intelStatus, refetchInterval: 15_000 });
  const faces = st?.stages.find((x) => x.stage === "faces");
  const finding = !!st?.settings.people && !!faces && faces.total > 0 && faces.done < faces.total;
  const [picked, setPicked] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const selecting = picked.length > 0;
  const list = data ?? [];
  const named = list.filter((p) => !p.hidden && p.name);
  const unnamed = list.filter((p) => !p.hidden && !p.name);
  const hidden = list.filter((p) => p.hidden);

  const toggle = (uid: string) => setPicked((cur) => (cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid]));
  const refresh = () => void qc.invalidateQueries({ queryKey: ["people"] });

  const merge = async () => {
    // Fica a de nome (ou a com mais fotos); as outras entram nela.
    const chosen = list.filter((p) => picked.includes(p.uid)).sort((a, b) => Number(!!b.name) - Number(!!a.name) || b.count - a.count);
    if (!(await confirmMerge(chosen))) return;
    try {
      await api.personMerge(chosen[0].uid, chosen.slice(1).map((p) => p.uid));
      setPicked([]);
      refresh();
      notify({ text: chosen[0].name ? `Mescladas em “${chosen[0].name}”` : "Pessoas mescladas", tone: "success" });
    } catch (e) {
      notifyError(e);
    }
  };
  const hide = async (on: boolean) => {
    try {
      await Promise.all(picked.map((uid) => api.personHide(uid, on)));
      setPicked([]);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  if (data && !list.length)
    return (
      <div className="grid flex-1 place-items-center">
        {finding ? (
          <EmptyState
            touch={touch}
            sync={false}
            icon={ScanFace}
            title="Encontrando rostos"
            text={`${faces.done.toLocaleString("pt-BR")} de ${faces.total.toLocaleString("pt-BR")} fotos analisadas. Uma pessoa aparece aqui quando o rosto dela é visto em pelo menos 3 fotos.`}
          />
        ) : (
          <EmptyState
            touch={touch}
            sync={false}
            icon={ScanFace}
            title="Ninguém por aqui ainda"
            text={st && !st.settings.people ? "Ligue “Pessoas” em Inteligência para agrupar os rostos das fotos." : "Nenhum rosto foi visto em fotos suficientes para formar uma pessoa."}
          />
        )}
      </div>
    );

  const grid = (people: Person[]) => (
    <div className={`grid gap-x-3 gap-y-5 ${touch ? "grid-cols-3 px-4" : "grid-cols-[repeat(auto-fill,minmax(112px,1fr))]"}`}>
      {people.map((p) => {
        const on = picked.includes(p.uid);
        return (
          <button
            key={p.uid}
            type="button"
            onClick={() => (selecting ? toggle(p.uid) : nav.person(p.uid))}
            onContextMenu={(e) => {
              e.preventDefault();
              toggle(p.uid);
            }}
            className="group relative flex flex-col items-center gap-2"
          >
            <span className="relative">
              <FaceAvatar face={p.cover} size={touch ? 92 : 96} className={`ring-[3px] transition ${on ? "scale-90 ring-brand" : "ring-transparent group-hover:ring-line"}`} />
              {(on || !touch) && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(p.uid);
                  }}
                  className={`absolute top-0 left-0 grid size-6 place-items-center rounded-full border-2 transition-opacity ${on ? "border-brand bg-brand text-white" : "border-white/90 bg-black/30 text-transparent opacity-0 group-hover:opacity-100"}`}
                >
                  <Check size={14} strokeWidth={3} />
                </span>
              )}
            </span>
            <span className="w-full text-center">
              <span className={`block truncate text-[14px] ${p.name ? "font-semibold" : "text-fg-3"}`}>{p.name || "Adicionar nome"}</span>
              <span className="block text-[12px] text-fg-3 tabular">{photos(p.count)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selecting && (
        <div className={`glint-top flex shrink-0 items-center gap-2 border-b border-hairline bg-s1 py-2 anim-fade ${touch ? "px-2" : "px-4"}`}>
          <button type="button" onClick={() => setPicked([])} className="grid size-10 place-items-center rounded-full hover:bg-s3" aria-label="Cancelar seleção">
            <X size={20} />
          </button>
          <span className="flex-1 text-[15px] font-semibold tabular">{picked.length} selecionadas</span>
          {picked.length > 1 && (
            <button type="button" onClick={() => void merge()} className="step flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-[14px] font-semibold text-white">
              <Merge size={16} /> Mesclar
            </button>
          )}
          <button type="button" onClick={() => void hide(!showHidden)} className="surface flex h-9 items-center gap-1.5 rounded-full bg-s2 px-3.5 text-[14px] font-semibold">
            {showHidden ? <Eye size={16} /> : <EyeOff size={16} />} {showHidden ? "Mostrar" : "Ocultar"}
          </button>
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-y-auto pb-24 ${touch ? "pt-2" : "mx-auto w-full max-w-[960px] px-6 pt-4"}`}>
        {!selecting && <p className={`pb-4 text-[13px] text-fg-3 ${touch ? "px-4" : ""}`}>{touch ? "Toque e segure" : "Clique com o botão direito ou no círculo"} para selecionar e mesclar quem é a mesma pessoa.</p>}
        {finding && (
          <p className={`flex items-center gap-2 pb-4 text-[12px] text-fg-3 tabular ${touch ? "px-4" : ""}`}>
            <ScanFace size={14} className="shrink-0" /> Encontrando rostos: {faces.done.toLocaleString("pt-BR")} de {faces.total.toLocaleString("pt-BR")} fotos.
          </p>
        )}
        {named.length > 0 && grid(named)}
        {unnamed.length > 0 && (
          <>
            <h3 className={`pt-8 pb-4 text-[15px] font-semibold ${touch ? "px-4" : ""}`}>Sem nome</h3>
            {grid(unnamed)}
          </>
        )}
        {hidden.length > 0 && (
          <>
            <button type="button" onClick={() => setShowHidden((v) => !v)} className={`flex items-center gap-2 pt-8 pb-4 text-[15px] font-semibold text-fg-2 ${touch ? "px-4" : ""}`}>
              <EyeOff size={16} /> Ocultas ({hidden.length}) <ChevronRight size={16} className={`transition-transform ${showHidden ? "rotate-90" : ""}`} />
            </button>
            {showHidden && grid(hidden)}
          </>
        )}
        <p className={`flex items-start gap-2 pt-10 text-[12px] text-fg-3 ${touch ? "px-4" : ""}`}>
          <Smartphone size={14} className="mt-px shrink-0" /> Pessoas e nomes ficam só neste aparelho, por enquanto. Nada é enviado para ser analisado.
        </p>
      </div>
    </div>
  );
}

/** Uma pessoa: nome editável, ações e a linha do tempo dela. */
export function PersonScreen({ uid, touch }: { uid: string; touch: boolean }) {
  const qc = useQueryClient();
  const { data: people } = usePeople();
  const p = people?.find((x) => x.uid === uid);
  const { data: media } = useQuery({ queryKey: ["person", uid], queryFn: () => api.personMedia(uid) });
  const [name, setName] = useState(p?.name ?? "");
  const [merging, setMerging] = useState(false);
  const [tab, setTab] = useState<"photos" | "faces">("photos");
  useEffect(() => setName(p?.name ?? ""), [p?.name]);

  const save = async () => {
    if (!p || name.trim() === p.name) return;
    try {
      await api.personRename(uid, name.trim());
      void qc.invalidateQueries({ queryKey: ["people"] });
      notify({ text: name.trim() ? "Nome salvo" : "Nome tirado", tone: "success" });
    } catch (e) {
      notifyError(e);
    }
  };
  const others = useMemo(() => (people ?? []).filter((x) => x.uid !== uid && !x.hidden), [people, uid]);

  const header = (
    <div className={`flex items-center gap-4 pb-4 ${touch ? "px-4 pt-2" : "px-6 pt-5"}`}>
      <FaceAvatar face={p?.cover ?? null} size={touch ? 72 : 80} />
      <div className="min-w-0 flex-1">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="Adicionar nome"
          className="w-full rounded-lg bg-transparent font-heading text-[22px] font-bold tracking-tight text-fg-title outline-none placeholder:text-fg-3 focus:bg-s2 focus:px-2"
        />
        <p className="text-[13px] text-fg-3 tabular">{p ? photos(p.count) : ""}</p>
      </div>
      <button type="button" onClick={() => setMerging(true)} className="surface flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-s2 px-3.5 text-[13px] font-semibold hover:bg-s3">
        <Merge size={15} /> Mesclar
      </button>
      {p && (
        <button
          type="button"
          onClick={() => void api.personHide(uid, !p.hidden).then(() => qc.invalidateQueries({ queryKey: ["people"] }))}
          className="grid size-9 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-s3"
          aria-label={p.hidden ? "Mostrar pessoa" : "Ocultar pessoa"}
          title={p.hidden ? "Mostrar" : "Ocultar"}
        >
          {p.hidden ? <Eye size={18} /> : <EyeOff size={18} />}
        </button>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {merging && (
        <div className={`mb-3 rounded-xl bg-s2 p-3 anim-fade ${touch ? "mx-4" : "mx-6"}`}>
          <div className="mb-2 flex items-center">
            <p className="flex-1 text-[13px] font-semibold">É a mesma pessoa que…</p>
            <button type="button" onClick={() => setMerging(false)} className="grid size-7 place-items-center rounded-full hover:bg-s4" aria-label="Fechar">
              <X size={15} />
            </button>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none]">
            {others.map((o) => (
              <button
                key={o.uid}
                type="button"
                onClick={async () => {
                  if (!p || !(await confirmMerge([p, o]))) return;
                  try {
                    await api.personMerge(uid, [o.uid]);
                    setMerging(false);
                    void qc.invalidateQueries({ queryKey: ["people"] });
                    void qc.invalidateQueries({ queryKey: ["person", uid] });
                    void qc.invalidateQueries({ queryKey: ["person-faces", uid] });
                    notify({ text: "Pessoas mescladas", tone: "success" });
                  } catch (e) {
                    notifyError(e);
                  }
                }}
                className="flex w-16 shrink-0 flex-col items-center gap-1"
              >
                <FaceAvatar face={o.cover} size={52} />
                <span className="w-full truncate text-center text-[11px]">{o.name || "Sem nome"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={`flex shrink-0 pb-2 ${touch ? "px-4" : "px-6"}`}>
        <div className="surface flex rounded-lg bg-s1 p-0.5" role="tablist">
          {(["photos", "faces"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-4 font-semibold ${touch ? "h-9 text-[14px]" : "h-8 text-[13px]"} ${tab === k ? "bg-s4 text-fg" : "text-fg-2"}`}>
              {k === "photos" ? "Fotos" : "Rostos"}
            </button>
          ))}
        </div>
      </div>
      {tab === "faces" ? (
        <FacesTab uid={uid} name={p?.name ?? ""} cover={p?.cover ?? null} touch={touch} />
      ) : media ? (
        <Timeline items={media} touch={touch} bottom={touch ? 96 : 24} />
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}

/** Os rostos que o automático pôs nesta pessoa: selecionar → "Não é X" ou "Usar como capa". */
function FacesTab({ uid, name, cover, touch }: { uid: string; name: string; cover: number | null; touch: boolean }) {
  const qc = useQueryClient();
  const { data: faces } = useQuery({ queryKey: ["person-faces", uid], queryFn: () => api.personFaces(uid) });
  const [picked, setPicked] = useState<number[]>([]);
  const toggle = (id: number) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const who = name || "esta pessoa";

  const refresh = () => {
    setPicked([]);
    for (const k of [["people"], ["person", uid], ["person-faces", uid]]) void qc.invalidateQueries({ queryKey: k });
  };
  const reject = async () => {
    try {
      await Promise.all(picked.map((f) => api.faceReject(f)));
      notify({ text: picked.length === 1 ? `Rosto tirado de ${who}` : `${picked.length} rostos tirados de ${who}`, tone: "success" });
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const makeCover = async () => {
    try {
      await api.personCover(uid, picked[0]);
      notify({ text: "Capa trocada", tone: "success" });
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  if (!faces) return <div className="flex-1" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex min-h-12 shrink-0 items-center gap-2 pb-2 ${touch ? "px-4" : "px-6"}`}>
        {picked.length ? (
          <>
            <span className="flex-1 text-[14px] font-semibold tabular">{picked.length === 1 ? "1 selecionado" : `${picked.length} selecionados`}</span>
            {picked.length === 1 && picked[0] !== cover && (
              <button type="button" onClick={() => void makeCover()} className="surface h-9 rounded-full bg-s2 px-3.5 text-[13px] font-semibold hover:bg-s3">
                Usar como capa
              </button>
            )}
            <button type="button" onClick={() => void reject()} className="step flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-[13px] font-semibold text-white">
              <UserRoundX size={15} /> {name ? `Não é ${name}` : "Não é esta pessoa"}
            </button>
          </>
        ) : (
          <span className="text-[13px] text-fg-3">{touch ? "Toque" : "Clique"} nos rostos que não são de {who} para tirar.</span>
        )}
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto pb-24 ${touch ? "px-4" : "px-6"}`}>
        <div className={`grid gap-3 ${touch ? "grid-cols-4" : "grid-cols-[repeat(auto-fill,minmax(88px,1fr))]"}`}>
          {faces.map((f) => {
            const on = picked.includes(f);
            return (
              <button key={f} type="button" onClick={() => toggle(f)} className="relative mx-auto" aria-pressed={on}>
                <FaceAvatar face={f} size={touch ? 72 : 80} className={`ring-[3px] transition ${on ? "scale-90 ring-brand" : "ring-transparent"}`} />
                {on && (
                  <span className="absolute top-0 left-0 grid size-6 place-items-center rounded-full bg-brand text-white">
                    <Check size={14} strokeWidth={3} />
                  </span>
                )}
                {f === cover && <span className="absolute right-0 bottom-0 rounded-full bg-s4 px-1.5 text-[10px] font-semibold">capa</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
