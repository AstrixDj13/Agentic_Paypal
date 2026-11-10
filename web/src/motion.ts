/**
 * Shared motion: one spring for every move, and a hand-off for the agent card "flight" between screens
 * (the wallet card lifts and becomes the agent's header card, and back again).
 * Only transform and opacity ever animate, so the compositor does the work.
 */

export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * A real spring (stiffness 300, damping 30), sampled into a CSS linear() easing so the browser runs it on the
 * compositor. Falls back to an iOS-like curve where linear() isn't supported.
 */
export const SPRING = (() => {
  const k = 300, c = 30, m = 1, dt = 1 / 120;
  let x = 0, v = 0, t = 0;
  const pts: number[] = [0];
  while (t < 2) {
    const a = (k * (1 - x) - c * v) / m;
    v += a * dt; x += v * dt; t += dt;
    if (Math.round(t * 120) % 2 === 0) pts.push(+x.toFixed(4));
    if (Math.abs(1 - x) < 0.0008 && Math.abs(v) < 0.01) break;
  }
  const duration = Math.round(t * 1000);
  const ok = typeof CSS !== "undefined" && CSS.supports?.("animation-timing-function", "linear(0, 1)");
  return ok ? { easing: `linear(${pts.join(", ")}, 1)`, duration } : { easing: "cubic-bezier(0.32, 0.72, 0, 1)", duration: 500 };
})();

/* ------------------------------ Card flight (shared element across routes) ------------------------------ */

let flight: { id: string; rect: DOMRect; at: number } | null = null;

/** Remember where a card was on screen just before the route changes. */
export function launch(id: string, rect: DOMRect) {
  flight = { id, rect, at: performance.now() };
}

/** Pick up the card on the new screen (once, and only if it just left). */
export function land(id?: string) {
  const f = flight;
  flight = null;
  if (!f || performance.now() - f.at > 1200 || (id && f.id !== id)) return null;
  return f;
}

/** Fly an element from where the card was to where it is now: FLIP with the shared spring. */
export function flyFrom(el: HTMLElement, from: DOMRect, opts: { duration?: number } = {}) {
  const to = el.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const dx = from.left - to.left, dy = from.top - to.top;
  const sx = from.width / to.width, sy = from.height / to.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) return;
  const lift = el.closest<HTMLElement>("[data-flight]") ?? el;
  lift.style.zIndex = "8";
  const a = el.animate(
    [
      { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`, transformOrigin: "0 0" },
      { transform: "translate3d(0, 0, 0) scale(1, 1)", transformOrigin: "0 0" },
    ],
    { duration: opts.duration ?? SPRING.duration, easing: SPRING.easing },
  );
  const done = () => { lift.style.zIndex = ""; };
  a.finished.then(done, done);
}

/**
 * Content that arrives with a card: a short fade and rise, slightly after the card starts moving.
 * `fadeOnly` for containers that hold absolutely positioned children (a transform would re-anchor them).
 */
export function arrive(els: (Element | null | undefined)[], delay = 90, fadeOnly: (Element | null | undefined)[] = []) {
  els.forEach((el, i) => {
    const fade = fadeOnly.includes(el);
    (el as HTMLElement | null)?.animate(
      fade ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translate3d(0, 18px, 0)" }, { opacity: 1, transform: "translate3d(0, 0, 0)" }],
      { duration: 380, delay: delay + i * 40, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" },
    );
  });
}
