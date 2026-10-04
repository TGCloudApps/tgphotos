/**
 * Navegação rápida pela linha do tempo.
 *
 * Desktop: trilho à direita com os anos nas alturas reais; passar o mouse
 * mostra o mês daquele ponto, clicar/arrastar leva até ele.
 * Celular: alça que aparece ao rolar; arrastada, mostra o mês e leva até ele.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronsUpDown } from "lucide-react";
import { monthAt, type Layout } from "./layout";

type Props = {
  scroller: RefObject<HTMLDivElement | null>;
  layout: Layout;
  view: { top: number; height: number };
  touch: boolean;
};

/** Só vale a pena com bastante conteúdo. */
const MIN_SCREENS = 3;

export function Scrubber({ scroller, layout, view, touch }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  const hide = useRef<number | undefined>(undefined);
  const max = Math.max(1, layout.height - view.height);

  // Celular: a alça aparece enquanto rola e some depois de parado.
  useEffect(() => {
    if (!touch) return;
    setShown(true);
    clearTimeout(hide.current);
    if (!drag) hide.current = window.setTimeout(() => setShown(false), 1500);
    return () => clearTimeout(hide.current);
  }, [view.top, touch, drag]);

  if (layout.height < view.height * MIN_SCREENS || layout.months.length < 2) return null;

  const frac = Math.min(1, Math.max(0, view.top / max));
  /** Fração do trilho → rolagem. */
  const seek = (clientY: number) => {
    const r = track.current?.getBoundingClientRect();
    const el = scroller.current;
    if (!r || !el) return;
    const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    el.scrollTop = f * max;
  };
  const labelAt = (f: number) => monthAt(layout.months, f * max)?.label ?? "";

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(true);
    seek(e.clientY);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (drag) seek(e.clientY);
  };
  const endDrag = () => setDrag(false);

  if (touch) {
    return (
      <div ref={track} className="pointer-events-none absolute top-3 right-0 bottom-24 w-14">
        <div
          className={`pointer-events-auto absolute right-1 flex items-center transition-opacity duration-300 ${shown || drag ? "opacity-100" : "opacity-0"}`}
          style={{ top: `calc(${frac * 100}% - 24px)`, touchAction: "none" }}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {drag && (
            <span className="floating absolute right-14 rounded-full bg-s4 px-3.5 py-2 text-[14px] font-semibold whitespace-nowrap text-fg">{labelAt(frac)}</span>
          )}
          <span className="floating grid h-12 w-10 place-items-center rounded-l-full rounded-r-lg bg-s4 text-fg">
            <ChevronsUpDown size={18} />
          </span>
        </div>
      </div>
    );
  }

  // Anos: posição do primeiro mês de cada ano.
  const years: { year: number; f: number }[] = [];
  for (const m of layout.months) {
    if (years[years.length - 1]?.year !== m.year) years.push({ year: m.year, f: Math.min(1, m.y / max) });
  }
  // Rótulos colados some: fica o primeiro de cada faixa de 22px.
  const trackH = track.current?.clientHeight ?? 600;
  const labels = years.filter((y, i) => i === 0 || (y.f - years[i - 1].f) * trackH > 22);
  const tip = hoverY !== null ? hoverY : drag ? frac : null;

  return (
    <div
      ref={track}
      className="group/scrub absolute top-2 right-0 bottom-2 w-[60px] cursor-row-resize select-none"
      onPointerDown={startDrag}
      onPointerMove={(e) => {
        const r = track.current!.getBoundingClientRect();
        setHoverY(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
        moveDrag(e);
      }}
      onPointerLeave={() => setHoverY(null)}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {labels.map((y) => (
        <span
          key={y.year}
          className="pointer-events-none absolute right-3 -translate-y-1/2 text-[11px] font-semibold text-fg-3 tabular opacity-60 transition-opacity group-hover/scrub:opacity-100"
          style={{ top: `${y.f * 100}%` }}
        >
          {y.year}
        </span>
      ))}
      {/* Posição atual */}
      <span className="pointer-events-none absolute right-1 h-[3px] w-6 -translate-y-1/2 rounded-full bg-brand" style={{ top: `${frac * 100}%` }} />
      {tip !== null && (
        <>
          <span className="pointer-events-none absolute right-0 left-1 h-px bg-fg-2" style={{ top: `${tip * 100}%` }} />
          <span
            className="floating pointer-events-none absolute right-[64px] -translate-y-1/2 rounded-lg bg-s4 px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap text-fg"
            style={{ top: `${tip * 100}%` }}
          >
            {labelAt(tip)}
          </span>
        </>
      )}
    </div>
  );
}
