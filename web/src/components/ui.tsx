import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/* ------------------------------------ Money ------------------------------------ */

/** Balance-style amount with raised cents: $150.⁰⁰ (tabular figures). */
export function Money({ value, size = "display", className = "" }: { value: number; size?: "display" | "title" | "body"; className?: string }) {
  const [whole, cents] = Math.abs(value).toFixed(2).split(".");
  return (
    <span className={`money money-${size} ${className}`} aria-label={`$${whole}.${cents}`}>
      {value < 0 ? "−" : ""}${Number(whole).toLocaleString("en-US")}
      <sup>.{cents}</sup>
    </span>
  );
}

/* ------------------------------------ Switch ------------------------------------ */

export function Switch({ on, onChange, label, tone = "ok" }: { on: boolean; onChange: () => void; label: string; tone?: "ok" | "danger" }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""} tone-${tone}`} onClick={onChange}>
      <span className="knob" />
    </button>
  );
}

/* ------------------------------------ Segmented control ------------------------------------ */

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented glass" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------ Bottom sheet ------------------------------------ */

/** Bottom sheet: tap the scrim, press Escape, or drag the handle down to dismiss. */
export function Sheet({ onClose, children, tone }: { onClose: () => void; children: ReactNode; tone?: "dark" }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const down = (e: React.PointerEvent) => { start.current = e.clientY; (e.target as Element).setPointerCapture?.(e.pointerId); };
  const move = (e: React.PointerEvent) => { if (start.current !== null) setDrag(Math.max(0, e.clientY - start.current)); };
  const up = () => { if (drag > 110) onClose(); start.current = null; setDrag(0); };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className={`sheet ${tone === "dark" ? "sheet-dark" : ""}`}
        role="dialog"
        aria-modal="true"
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <span className="grab" />
          <button className="icon-btn sheet-close" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------ Toast ------------------------------------ */

export function Toast({ toast }: { toast: { text: string; error?: boolean } | null }) {
  if (!toast) return null;
  return (
    <div className={`toast glass ${toast.error ? "error" : ""}`} role="status">
      <Icon name={toast.error ? "alert" : "check"} size={18} />
      <span>{toast.text}</span>
    </div>
  );
}

/* ------------------------------------ 3D objects ------------------------------------ */

/**
 * Soft clay 3D objects for emotion moments only (empty states, success, verdicts).
 * CSS stand-ins until the rendered WebP assets exist; swap the markup for <img> later.
 */
export function Obj({ kind, size = 1 }: { kind: "pocket" | "shield" | "box" | "coin"; size?: number }) {
  return (
    <div className={`obj obj-${kind}`} style={{ "--s": size } as React.CSSProperties} aria-hidden="true">
      {kind === "box" && <i />}
    </div>
  );
}

/* ------------------------------------ Theme ------------------------------------ */

type Theme = "system" | "light" | "dark";
const KEY = "pocket.theme";

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

/** Follows the system by default; the toggle flips to the opposite of what is showing now. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const isDark = useCallback(() => {
    if (theme !== "system") return theme === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  }, [theme]);
  const toggle = useCallback(() => {
    const next: Theme = isDark() ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch { /* storage blocked: still switch for this session */ }
    setTheme(next);
  }, [isDark]);
  return { dark: isDark(), toggle };
}
