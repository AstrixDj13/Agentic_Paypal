import { useEffect, useRef } from "react";
import { reducedMotion } from "./motion";

/**
 * Behaviour for the installed app (Android Chrome "Install", iPhone "Add to Home Screen"), where there is no
 * address bar, no browser refresh and the keyboard can move the page:
 *  - the page itself never scrolls (only the app's own scroll areas do), so the tab bar and the message box can't be
 *    pushed off screen by the keyboard and left there;
 *  - pull down at the top of a screen to refresh its data in place;
 *  - when a newer version has been deployed, offer a one-tap reload.
 */

/** Keep the document pinned at the top. Android's keyboard can shift it and, in the installed app, nothing shifts it back. */
export function useViewportGuard() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("app-locked");
    const reset = () => {
      if (window.scrollY || root.scrollTop || document.body.scrollTop) {
        window.scrollTo(0, 0);
        root.scrollTop = 0;
        document.body.scrollTop = 0;
      }
    };
    // Only when the keyboard has gone (or the app comes back): while it's open, iPhone may scroll the page on purpose
    // to keep the field you're typing in visible.
    const vv = window.visualViewport;
    const onResize = () => { if (!vv || vv.height >= window.innerHeight - 1) reset(); };
    const onFocusOut = () => setTimeout(reset, 60);
    const onVisible = () => { if (document.visibilityState === "visible") reset(); };
    vv?.addEventListener("resize", onResize);
    window.addEventListener("focusout", onFocusOut);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("orientationchange", onFocusOut);
    return () => {
      root.classList.remove("app-locked");
      vv?.removeEventListener("resize", onResize);
      window.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("orientationchange", onFocusOut);
    };
  }, []);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull to refresh on a scroll area: pull down from the top, a small spinner follows your finger (half speed, so it
 * feels weighted), past the threshold it locks and spins while the data reloads, then tucks away.
 * Only transform and opacity change. Returns the ref for the spinner element.
 */
export function usePullToRefresh(getScroller: () => HTMLElement | null, onRefresh: () => Promise<unknown> | unknown, enabled: boolean, key: string) {
  const ind = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const el = getScroller();
    if (!el) return;
    const TRIGGER = 64, MAX = 96;
    let y0: number | null = null;
    let d = 0;
    let busy = false;
    const paint = (p: number, animate: boolean, spinning = false) => {
      const i = ind.current;
      if (!i) return;
      i.style.transition = animate ? "transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.25s ease" : "none";
      i.style.transform = `translate3d(-50%, ${Math.min(p, MAX) - 56}px, 0) rotate(${spinning ? 0 : p * 4}deg)`;
      i.style.opacity = String(Math.min(1, p / TRIGGER));
      i.classList.toggle("armed", p >= TRIGGER);
      i.classList.toggle("spinning", spinning);
    };
    const start = (e: TouchEvent) => {
      if (busy || el.scrollTop > 0 || e.touches.length !== 1) { y0 = null; return; }
      y0 = e.touches[0].clientY;
      d = 0;
    };
    const move = (e: TouchEvent) => {
      if (y0 === null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy <= 0 || el.scrollTop > 0) { if (d) { d = 0; paint(0, false); } return; }
      const was = d >= TRIGGER;
      d = dy * 0.5;
      if (!was && d >= TRIGGER) navigator.vibrate?.(8);
      paint(d, false);
    };
    const end = () => {
      if (y0 === null) return;
      y0 = null;
      if (d < TRIGGER) { d = 0; paint(0, true); return; }
      busy = true;
      paint(TRIGGER, true, true);
      Promise.all([Promise.resolve(onRefresh()), wait(reducedMotion() ? 0 : 650)])
        .catch(() => {})
        .finally(() => { busy = false; d = 0; paint(0, true); });
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return ind;
}

/**
 * The installed app can stay open for days. When it comes back to the front (and every few minutes), check whether
 * the server has a newer build than the one running, and offer a reload. Production builds only.
 */
export function useUpdateCheck(offer: () => void) {
  const told = useRef(false);
  useEffect(() => {
    const running = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src");
    if (!running) return; // dev server
    const check = async () => {
      if (told.current || document.visibilityState !== "visible") return;
      try {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const latest = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
        if (latest && latest !== running) { told.current = true; offer(); setTimeout(() => { told.current = false; }, 10 * 60_000); }
      } catch { /* offline: try again later */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    const t = setInterval(check, 5 * 60_000);
    return () => { document.removeEventListener("visibilitychange", onVisible); clearInterval(t); };
  }, [offer]);
}

/**
 * The number on the app icon: how many things wait for you (like unread messages). Supported for installed web apps on
 * iPhone, Mac and Windows; on Android the launcher shows its own dot from notifications instead.
 */
export function useAppBadge(count: number) {
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => {});
  }, [count]);
}
