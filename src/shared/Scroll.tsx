/**
 * Stacked screens keep their scroll position: going back to the Library, a chat or the
 * timeline returns where you were. The key is the route (screen address).
 * Tapping again the destination you are already on (Photos in the bar) goes back to the top.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const saved = new Map<string, number>();

/** Current route as key (the address changes along with the screen). */
export const routeKey = () => location.hash || "#/photos";

/** Takes the `key` screen (or the current one) to the top, with animation. */
export function scrollToTop(key = routeKey()) {
  saved.delete(key);
  window.dispatchEvent(new CustomEvent("tg-scroll-top", { detail: key }));
}

/**
 * Binds the `ref` container to the route memory: restores on mount (waits for the
 * content to grow enough, for up to ~2 s) and saves on every scroll.
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
    // The person scrolled before the restore: what they did wins.
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

/** Scrollable container that remembers the position (screens without Timeline). */
export function ScrollPane({ className = "", children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollMemory(ref);
  return (
    <div ref={ref} className={`flex-1 overflow-y-auto ${className}`}>
      {children}
    </div>
  );
}
