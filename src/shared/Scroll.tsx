/**
 * Telas em pilha guardam a rolagem: voltar para a Biblioteca, um chat ou a
 * linha do tempo devolve onde estava. A chave é a rota (endereço da tela).
 * Tocar de novo no destino em que já se está (Fotos na barra) volta ao topo.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const saved = new Map<string, number>();

/** Rota atual como chave (o endereço muda junto com a tela). */
export const routeKey = () => location.hash || "#/photos";

/** Leva a tela `key` (ou a atual) ao topo, com animação. */
export function scrollToTop(key = routeKey()) {
  saved.delete(key);
  window.dispatchEvent(new CustomEvent("tg-scroll-top", { detail: key }));
}

/**
 * Liga o contêiner `ref` à memória da rota: restaura ao montar (espera o
 * conteúdo crescer o bastante, por até ~2 s) e guarda a cada rolagem.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>, enabled = true) {
  const key = useRef(routeKey()).current;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const target = saved.get(key) ?? 0;
    let frame = 0;
    let tries = 0;
    let restoring = target > 0;
    const restore = () => {
      if (!restoring) return;
      if (el.scrollHeight - el.clientHeight >= target || tries++ > 120) {
        el.scrollTop = target;
        restoring = false;
        return;
      }
      frame = requestAnimationFrame(restore);
    };
    restore();
    const onScroll = () => {
      if (!restoring) saved.set(key, el.scrollTop);
    };
    // A pessoa rolou antes de restaurar: vale o que ela fez.
    const stop = () => (restoring = false);
    const top = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== key) return;
      restoring = false;
      el.scrollTo({ top: 0, behavior: "smooth" });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("tg-scroll-top", top);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      window.removeEventListener("tg-scroll-top", top);
    };
  }, [ref, key, enabled]);
}

/** Contêiner rolável que lembra a posição (telas sem Timeline). */
export function ScrollPane({ className = "", children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollMemory(ref);
  return (
    <div ref={ref} className={`flex-1 overflow-y-auto ${className}`}>
      {children}
    </div>
  );
}
