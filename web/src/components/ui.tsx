import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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

/** iOS-style segmented control: one raised thumb that slides to the chosen option. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number; ready: boolean } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const place = () => {
      const on = box.querySelector<HTMLElement>("button.on");
      if (!on) return setThumb(null);
      // The first placement jumps; every later one slides.
      setThumb((t) => ({ x: on.offsetLeft, w: on.offsetWidth, ready: !!t }));
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(box);
    return () => ro?.disconnect();
  }, [value, options.length]);
  return (
    <div className="segmented" role="tablist" ref={ref}>
      {thumb && <span className={`seg-thumb ${thumb.ready ? "ready" : ""}`} aria-hidden="true" style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} />}
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
export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
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
        className="sheet"
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

export function Toast({ toast }: { toast: { text: string; error?: boolean; action?: { label: string; run: () => void } } | null }) {
  if (!toast) return null;
  return (
    <div className={`toast glass ${toast.error ? "error" : ""}`} role="status">
      <Icon name={toast.error ? "alert" : "check"} size={18} />
      <span>{toast.text}</span>
      {toast.action && <button className="toast-action" onClick={toast.action.run}>{toast.action.label}</button>}
    </div>
  );
}
