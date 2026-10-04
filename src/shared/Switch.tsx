/** Chave liga/desliga nos tokens (trilho s4, ligado brand). */
export function Switch({ on, touch }: { on: boolean; touch?: boolean }) {
  const w = touch ? 44 : 36;
  const h = touch ? 26 : 20;
  const k = h - 6;
  return (
    <span
      aria-hidden
      className={`relative inline-block shrink-0 rounded-full transition-colors duration-150 ${on ? "bg-brand" : "bg-s4"}`}
      style={{ width: w, height: h }}
    >
      <span className="absolute top-[3px] rounded-full bg-white shadow transition-[left] duration-150" style={{ width: k, height: k, left: on ? w - k - 3 : 3 }} />
    </span>
  );
}
