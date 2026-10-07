/**
 * Configurações da inteligência de mídia: o que analisar, quanto de energia
 * usar e como está o andamento (docs/inteligencia-de-midia.md §10).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BatteryCharging, Copy, Download, Loader2, MapPin, Pause, ScanFace, Search, Thermometer, Type, Wifi, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { formatSize } from "@tgcloud/ui/core/format";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { confirmAction } from "@tgcloud/ui/ui/Confirm";
import { api, type IntelHold, type IntelSettings, type IntelStatus, type ModelState } from "../core/api";
import { Switch } from "./Switch";

const FEATURES: { key: keyof IntelSettings & ("search" | "people" | "text" | "places" | "duplicates"); stage: string; icon: ReactNode; title: string; text: string }[] = [
  { key: "search", stage: "clip", icon: <Search />, title: "Busca por descrição", text: "“Praia ao pôr do sol”, “cachorro no sofá”. Baixa um modelo de ~400 MB uma vez." },
  { key: "people", stage: "faces", icon: <ScanFace />, title: "Pessoas", text: "Agrupa rostos para você nomear e buscar pelo nome." },
  { key: "text", stage: "ocr", icon: <Type />, title: "Texto nas imagens", text: "Lê o que está escrito (placas, documentos, prints) para a busca." },
  { key: "places", stage: "place", icon: <MapPin />, title: "Lugares", text: "Cidade e país das fotos com localização, sem internet." },
  { key: "duplicates", stage: "hash", icon: <Copy />, title: "Duplicatas", text: "Acha a mesma foto enviada mais de uma vez." },
];

const MODES: { mode: IntelSettings["mode"]; label: string }[] = [
  { mode: "auto", label: "Automático" },
  { mode: "charging", label: "Só carregando" },
  { mode: "paused", label: "Pausado" },
];

const HOLD: Record<IntelHold, { icon: ReactNode; text: string }> = {
  paused: { icon: <Pause size={16} />, text: "Pausado por você." },
  "not-charging": { icon: <BatteryCharging size={16} />, text: "Esperando o carregador." },
  "low-battery": { icon: <BatteryCharging size={16} />, text: "Bateria abaixo do limite: retoma ao carregar." },
  saver: { icon: <BatteryCharging size={16} />, text: "Modo economia ligado no aparelho." },
  hot: { icon: <Thermometer size={16} />, text: "Aparelho quente: retoma quando esfriar." },
  "in-use": { icon: <Pause size={16} />, text: "Dando licença enquanto você usa o app." },
};

const STAGE_NAME: Record<string, string> = { clip: "Busca por descrição", faces: "Pessoas", ocr: "Texto", place: "Lugares", hash: "Duplicatas" };

export function IntelSettingsBody({ touch }: { touch: boolean }) {
  const qc = useQueryClient();
  const { data: st } = useQuery({ queryKey: ["intel-status"], queryFn: api.intelStatus, refetchInterval: 4000 });
  if (!st) return <div className="grid h-40 place-items-center"><Loader2 className="animate-spin text-fg-3" /></div>;
  // "Só carregando" sem bateria (computador de mesa) vale como Automático.
  const s = !st.battery && st.settings.mode === "charging" ? { ...st.settings, mode: "auto" as const } : st.settings;

  const save = (patch: Partial<IntelSettings>) => {
    const next = { ...s, ...patch };
    qc.setQueryData<IntelStatus>(["intel-status"], { ...st, settings: next });
    void api.intelSet(next).catch(notifyError);
  };
  const row = touch ? "min-h-16 px-4 active:bg-s3" : "min-h-14 px-4 hover:bg-s3";
  const working = st.running ? STAGE_NAME[st.running] ?? st.running : null;

  return (
    <div className="pb-2">
      {/* Estado agora. */}
      <div className="mx-4 mb-3 flex items-center gap-2.5 rounded-xl bg-s3 px-3.5 py-3 text-[13px]">
        {working ? <Loader2 size={16} className="shrink-0 animate-spin text-brand" /> : st.hold ? <span className="shrink-0 text-fg-2">{HOLD[st.hold].icon}</span> : <Zap size={16} className="shrink-0 text-fg-3" />}
        <span className="min-w-0 flex-1 text-fg-2">
          {working ? `Analisando: ${working.toLowerCase()}` : st.hold ? HOLD[st.hold].text : "Em dia. Fotos novas entram sozinhas."}
        </span>
        <button
          type="button"
          title={st.rush ? undefined : "Ignora a bateria e o modo escolhido por 1 hora (a temperatura continua valendo)"}
          onClick={() => void api.intelRush(!st.rush).then(() => qc.invalidateQueries({ queryKey: ["intel-status"] }))}
          className={`shrink-0 rounded-full px-3 font-semibold ${touch ? "h-9 text-[13px]" : "h-8 text-[12px]"} ${st.rush ? "bg-s4 text-fg" : "step bg-brand text-white"}`}
        >
          {st.rush ? "Voltar ao normal" : "Processar agora"}
        </button>
      </div>
      <p className="-mt-1 mb-2 px-4 text-[12px] text-fg-3">
        {st.rush ? "Processando sem pausas por até 1 hora." : "“Processar agora” ignora a bateria e o modo por 1 hora."}
      </p>

      {/* Energia. */}
      <p className="px-4 pt-2 pb-1.5 text-[12px] font-semibold tracking-wide text-fg-3 uppercase">Energia</p>
      <div className="px-4">
        <div className="surface flex rounded-lg bg-s1 p-0.5" role="tablist">
          {MODES.filter((m) => st.battery || m.mode !== "charging").map((m) => (
            <button key={m.mode} role="tab" aria-selected={s.mode === m.mode} onClick={() => save({ mode: m.mode })} className={`flex-1 rounded-md font-semibold ${touch ? "h-10 text-[14px]" : "h-8 text-[13px]"} ${s.mode === m.mode ? "bg-s4 text-fg" : "text-fg-2"}`}>
              {m.label}
            </button>
          ))}
        </div>
        {/* Bateria só onde há bateria (celular, notebook). */}
        {st.battery && s.mode === "auto" && (
          <label className="mt-4 block">
            <span className="flex justify-between text-[13px]">
              <span className="text-fg-2">Na bateria, só acima de</span>
              <span className="font-semibold tabular">{s.min_battery}%</span>
            </span>
            <input type="range" min={10} max={90} step={5} value={s.min_battery} onChange={(e) => save({ min_battery: Number(e.target.value) })} className="mt-2 w-full accent-[var(--brand)]" />
          </label>
        )}
        <label className="mt-3 block">
          <span className="flex justify-between text-[13px]">
            <span className="text-fg-2">Intensidade</span>
            <span className="font-semibold">{s.budget <= 0.2 ? "Leve" : s.budget <= 0.4 ? "Moderada" : "Alta"}</span>
          </span>
          <input type="range" min={0.1} max={0.6} step={0.05} value={s.budget} onChange={(e) => save({ budget: Number(e.target.value) })} className="mt-2 w-full accent-[var(--brand)]" />
          <span className="mt-1 block text-[12px] text-fg-3">{st.battery ? "Mais alta termina antes e gasta mais bateria. Carregando, dobra." : "Mais alta termina antes e usa mais o processador."}</span>
        </label>
      </div>

      {/* Recursos e andamento. */}
      <p className="px-4 pt-5 pb-1.5 text-[12px] font-semibold tracking-wide text-fg-3 uppercase">O que analisar</p>
      {FEATURES.map((f) => {
        const stage = st.stages.find((x) => x.stage === f.stage);
        const on = s[f.key];
        const model = st.models.find((m) => m.stage === f.stage);
        return (
          <button key={f.key} type="button" onClick={() => save({ [f.key]: !on })} className={`flex w-full items-center gap-3.5 text-left ${row}`}>
            <span className="text-fg-2 [&>svg]:size-5">{f.icon}</span>
            <span className="min-w-0 flex-1 py-2.5">
              <span className="block text-[15px] font-medium">{f.title}</span>
              <span className="block text-[12px] text-fg-3">{f.text}</span>
              {on && stage && stage.total > 0 && (
                <span className="mt-1.5 flex items-center gap-2">
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-s4">
                    <span className="block h-full rounded-full bg-brand" style={{ width: `${(stage.done / stage.total) * 100}%` }} />
                  </span>
                  <span className="text-[11px] text-fg-3 tabular">
                    {stage.done.toLocaleString("pt-BR")}/{stage.total.toLocaleString("pt-BR")}
                  </span>
                </span>
              )}
              {on && model && model.state !== "ready" && <ModelLine m={model} metered={st.metered} touch={touch} onRetry={() => void api.intelRetry().then(() => qc.invalidateQueries({ queryKey: ["intel-status"] }))} />}
            </span>
            <Switch on={on} touch={touch} />
          </button>
        );
      })}

      <p className="px-4 pt-3 text-[12px] text-fg-3">Desligar um recurso não apaga o que já foi analisado; ligue de novo para continuar de onde parou.</p>
      <Space touch={touch} />
      <p className="px-4 pt-4 text-[12px] text-fg-3">Tudo é feito neste aparelho. Nada sai dele para ser analisado.</p>
    </div>
  );
}

/** Estado do modelo de um recurso: baixando, esperando o Wi-Fi ou falhou. */
function ModelLine({ m, metered, touch, onRetry }: { m: ModelState; metered: boolean; touch: boolean; onRetry: () => void }) {
  if (m.state === "failed")
    return (
      <span className="mt-1.5 flex items-center gap-2 text-[12px] text-danger">
        <AlertCircle size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">Não deu para baixar o modelo{m.error ? `: ${m.error}` : ""}</span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className={`shrink-0 rounded-full bg-s4 px-3 font-semibold text-fg ${touch ? "py-1.5" : "py-1"}`}
        >
          Tentar de novo
        </span>
      </span>
    );
  if (m.state === "downloading")
    return (
      <span className="mt-1.5 flex items-center gap-2 text-[12px] text-fg-3">
        <Download size={14} className="shrink-0" />
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-s4">
          <span className="block h-full rounded-full bg-info" style={{ width: `${m.size ? (m.done / m.size) * 100 : 0}%` }} />
        </span>
        <span className="tabular">{m.size ? `Baixando ${formatSize(m.done)} de ${formatSize(m.size)}` : "Baixando…"}</span>
      </span>
    );
  return (
    <span className="mt-1.5 flex items-center gap-2 text-[12px] text-fg-3">
      {metered ? <Wifi size={14} className="shrink-0" /> : <Download size={14} className="shrink-0" />}
      {metered ? "Esperando o Wi-Fi para baixar o modelo" : "O modelo será baixado em seguida"}
    </span>
  );
}

/** Espaço usado e "Apagar e refazer". */
function Space({ touch }: { touch: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["intel-usage"], queryFn: api.intelUsage, refetchInterval: 30_000 });
  const reset = async () => {
    const ok = await confirmAction({
      title: "Apagar e refazer a análise?",
      body: "Os resultados deste vault (busca, rostos, texto lido, lugares e duplicatas) são apagados e a análise recomeça do zero. Os nomes das pessoas voltam sozinhos conforme os rostos são encontrados de novo. Os modelos baixados ficam.",
      cta: "Apagar e refazer",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.intelReset();
      for (const k of [["intel-status"], ["intel-usage"], ["people"], ["people-review"], ["duplicates"], ["places"], ["map-points"]]) void qc.invalidateQueries({ queryKey: k });
      notify({ text: "Análise recomeçada", tone: "success" });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <>
      <p className="px-4 pt-5 pb-1.5 text-[12px] font-semibold tracking-wide text-fg-3 uppercase">Espaço</p>
      <div className="flex items-center gap-3 px-4 py-1.5 text-[13px]">
        <span className="min-w-0 flex-1 text-fg-2">
          {data ? (
            <>
              Modelos <span className="font-semibold text-fg tabular">{formatSize(data.models)}</span> · Resultados{" "}
              <span className="font-semibold text-fg tabular">{formatSize(data.data)}</span>
            </>
          ) : (
            "…"
          )}
        </span>
        <button type="button" onClick={() => void reset()} className={`shrink-0 rounded-full bg-s3 px-3 font-semibold text-danger ${touch ? "h-9 text-[13px] active:bg-s4" : "h-8 text-[12px] hover:bg-s4"}`}>
          Apagar e refazer
        </button>
      </div>
    </>
  );
}
