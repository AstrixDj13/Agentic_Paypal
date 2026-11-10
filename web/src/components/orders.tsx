import { useEffect, useState } from "react";
import { api, money, STORE_NAME, type AppState, type Order, type OrderLine, type Purchase } from "../api";
import { Icon } from "./Icon";
import { SignButton } from "./lock";
import type { Act } from "./purchase";

/**
 * Cards for the three kinds of agent: the weekly order (with swaps and sold-out items),
 * the right-now pick, and "buy it in store instead". Stores and restaurants are simulated
 * and labelled as such.
 */

const store = (id: string) => STORE_NAME[id] ?? id;

function useClock(until?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = until ? Math.max(0, Date.parse(until) - now) : 0;
  const s = Math.ceil(left / 1000);
  return { left, text: s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s` };
}

/* ------------------------------------ Weekly order ------------------------------------ */

export function OrderCard({ state, o, act }: { state: AppState; o: Order; act: Act }) {
  const { left, text } = useClock(o.deadline);
  const [open, setOpen] = useState(false);
  const open_ = o.status === "awaiting" || o.status === "needs_approval";
  const lines = o.lines ?? [];
  const asks = lines.filter((l) => l.ask?.status === "pending");
  const bought = lines.filter((l) => l.kind !== "skipped");
  const items = bought.reduce((n, l) => n + l.qty, 0);
  const purchase = o.purchaseId ? state.purchases.find((p) => p.id === o.purchaseId) : undefined;
  const firstWeek = !o.usualTotal || o.usualTotal === o.total;

  return (
    <div className={`order-card ${open_ ? "open" : ""}`}>
      <div className="order-head">
        <span className="stack-xs grow">
          <span className="caption muted">Weekly order · week {(o.week ?? 0) + 1} · simulated stores</span>
          <strong className="headline">{items} items · {money(o.total)}</strong>
          {!firstWeek && o.usualTotal! > o.total && <span className="footnote ok-text">Usually {money(o.usualTotal)} · saves {money(o.saved)}</span>}
          {!firstWeek && o.usualTotal! < o.total && <span className="footnote muted">Usually {money(o.usualTotal)}</span>}
          {firstWeek && o.status !== "placed" && <span className="footnote muted">Savings appear after your first week.</span>}
        </span>
        <span className={`badge ${o.status === "placed" ? "ok" : o.status === "awaiting" ? "warn" : o.status === "needs_approval" ? "warn" : "neutral"}`}>
          {o.status === "placed" ? "Placed" : o.status === "awaiting" ? (left > 0 ? `Goes out in ${text}` : "Going out…") : o.status === "needs_approval" ? "Needs approval" : o.status === "cancelled" ? "Replaced" : o.status === "blocked" ? "Stopped" : "Failed"}
        </span>
      </div>

      {asks.map((l) => <AskCard key={l.itemId} o={o} l={l} act={act} />)}

      {lines.filter((l) => l.ask?.status === "auto" && l.kind === "substitute").map((l) => (
        <p key={l.itemId} className="order-note"><Icon name="swap" size={14} />{l.ask!.reason}</p>
      ))}

      <button className="link-btn order-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide the list" : "See the list"}</button>
      {open && (
        <ul className="order-lines">
          {lines.map((l) => (
            <li key={l.itemId} className={`order-line ${l.kind}`}>
              <span className="grow stack-xs">
                <span className="footnote">{l.qty} × {l.kind === "skipped" ? l.usual.title : l.chosen?.title ?? l.usual.title}</span>
                <span className="caption muted">
                  {l.kind === "skipped" ? "Left out this week" : `${store(l.chosen?.store ?? l.usual.store)}${l.kind === "swap" ? " · swap, this week only" : l.kind === "substitute" ? " · substitute" : ""}${l.note ? ` · ${l.note}` : ""}`}
                </span>
              </span>
              <span className="num-plain footnote">{l.kind === "skipped" ? "–" : money((l.ask?.status === "pending" && l.ask.type === "swap" ? l.usual.price : l.chosen?.price ?? 0) * l.qty)}</span>
            </li>
          ))}
        </ul>
      )}

      {open_ && (
        <>
          <p className="caption muted">{asks.length ? "No reply by the deadline means your usual items, never a swap." : "Goes out with these items unless you change something."}</p>
          <SignButton title="Place this week's order" detail={`${items} items · ${money(o.total)}`}
            approval={{ amount: o.total, rows: [{ label: "Items", value: String(items) }, { label: "Usually", value: o.usualTotal ? money(o.usualTotal) : "–" }, { label: "Stores", value: "FreshCart, DailyMart (simulated)" }] }}
            progress={{ working: "Paying with PayPal", done: "Order placed" }}
            onSigned={(auth) => act(() => api(`/api/orders/${o.id}/place`, { auth }), undefined, { rethrow: true })}>
            {o.status === "needs_approval" ? "Approve and place" : "Place it now"}
          </SignButton>
        </>
      )}
      {purchase?.paypal?.orderId && <p className="caption muted">Paid with PayPal · {purchase.paypal.orderId}</p>}
      {o.error && <p className="footnote danger-text">{o.error}</p>}
    </div>
  );
}

/** One question: a better deal (Swap · Keep usual) or a sold-out item (pick one · leave it out). */
function AskCard({ o, l, act }: { o: Order; l: OrderLine; act: Act }) {
  const ask = l.ask!;
  if (ask.type === "swap") {
    const sw = ask.options[0];
    return (
      <div className="ask-card" id={`ask-${o.id}-${l.itemId}`}>
        <span className="caption muted row" style={{ gap: 6 }}><Icon name="swap" size={14} />Better deal this week</span>
        <p className="subhead">{ask.reason}</p>
        <div className="ask-compare">
          <span><span className="caption muted">Usual</span><strong>{money(l.usual.price)}</strong></span>
          <Icon name="chevronRight" size={14} />
          <span><span className="caption muted">{sw.brand}{sw.onDeal ? " · deal" : ""}</span><strong>{money(sw.price)}</strong>{sw.onDeal && <s className="caption muted">{money(sw.regular)}</s>}</span>
        </div>
        <div className="action-pair">
          <button className="btn tonal" onClick={() => act(() => api(`/api/orders/${o.id}/keep`, { itemId: l.itemId }), "Keeping your usual. I won't suggest that again.")}>Keep usual</button>
          <SignButton title="Swap for this week" detail={`${sw.title} · ${money(sw.price)}`} approval={{ amount: sw.price * l.qty, rows: [{ label: "Instead of", value: l.usual.title }, { label: "Swap to", value: sw.title }, { label: "Applies", value: "This week only" }] }}
            onSigned={(auth) => act(() => api(`/api/orders/${o.id}/swap`, { auth, itemId: l.itemId }), "Swapped for this week.", { rethrow: true })}>Swap</SignButton>
        </div>
      </div>
    );
  }
  return (
    <div className="ask-card warn" id={`ask-${o.id}-${l.itemId}`}>
      <span className="caption muted row" style={{ gap: 6 }}><Icon name="alert" size={14} />Sold out</span>
      <p className="subhead">{ask.reason}</p>
      {ask.options.map((opt) => (
        <SignButton key={opt.productId} tone="primary" className="sm" title={`Get ${opt.title}`} detail={`${money(opt.price)} at ${store(opt.store)}`}
          onSigned={(auth) => act(() => api(`/api/orders/${o.id}/stockout`, { auth, itemId: l.itemId, productId: opt.productId }), "Added.", { rethrow: true })}>
          {opt.title} · {money(opt.price)}
        </SignButton>
      ))}
      <button className="btn ghost block sm" onClick={() => act(() => api(`/api/orders/${o.id}/stockout`, { itemId: l.itemId, productId: null }), "Left out this week.")}>Leave it out this week</button>
    </div>
  );
}

/* ------------------------------------ Right now ------------------------------------ */

export function NowCard({ o, act }: { o: Order; act: Act }) {
  const [i, setI] = useState(0);
  const options = [o.pick!, ...(o.alternatives ?? [])];
  const p = options[i] ?? o.pick!;
  const open = o.status === "awaiting";
  return (
    <div className="order-card now-card">
      <span className="caption muted">Right now · one pick · simulated restaurants</span>
      <strong className="headline">{p.dish}</strong>
      <span className="footnote">{p.restaurant} · ★ {p.rating} · {p.etaMin} min</span>
      <div className="ask-compare">
        <span><span className="caption muted">Food</span><strong>{money(p.price)}</strong></span>
        <span><span className="caption muted">Delivery</span><strong>{money(p.fee)}</strong></span>
        <span><span className="caption muted">Total</span><strong>{money(p.total)}</strong></span>
      </div>
      <p className="footnote muted">Why: {p.why}</p>
      {open ? (
        <>
          <SignButton title={`Order ${p.dish}`} detail={`${p.restaurant} · ${money(p.total)}`} approval={{ amount: p.total, rows: [{ label: "From", value: p.restaurant }, { label: "Arrives in", value: `about ${p.etaMin} min` }] }}
            progress={{ working: "Paying with PayPal", done: "Ordered" }}
            onSigned={(auth) => act(() => api(`/api/orders/${o.id}/order-now`, { auth, choice: i }), undefined, { rethrow: true })}>Order it</SignButton>
          {options.length > 1 && <button className="btn ghost block sm" onClick={() => setI((i + 1) % options.length)}>Show another option ({(i + 1) % options.length + 1} of {options.length})</button>}
        </>
      ) : <span className={`badge ${o.status === "placed" ? "ok" : "neutral"}`}>{o.status === "placed" ? "Ordered" : o.status === "cancelled" ? "Replaced by a newer pick" : o.status}</span>}
    </div>
  );
}

/* ------------------------------------ Buy it in store instead ------------------------------------ */

export function StoreOfferCard({ p, act }: { p: Purchase; act: Act }) {
  const so = p.storeOffer!;
  const saving = Math.round((so.onlinePrice - so.price) * 100) / 100;
  return (
    <div className="order-card store-card">
      <span className="caption muted row" style={{ gap: 6 }}><Icon name="store" size={14} />Cheaper nearby · simulated shop</span>
      <strong className="headline">{so.shop} · {so.distanceKm} km</strong>
      <span className="footnote muted">{so.address}</span>
      <div className="ask-compare">
        <span><span className="caption muted">Online</span><strong>{money(so.onlinePrice)}</strong></span>
        <Icon name="chevronRight" size={14} />
        <span><span className="caption muted">In store</span><strong>{money(so.price)}</strong></span>
        <span className="ok-text footnote"><strong>Save {money(saving)}</strong></span>
      </div>
      <p className="footnote muted">Same item. Pocket hasn't paid for anything. I'm on your side, not the store's.</p>
      <div className="action-pair">
        <button className="btn tonal" onClick={() => act(() => api(`/api/purchases/${p.id}/store`, { decision: "online" }), "Buying it online.")}>Buy online instead</button>
        <button className="btn primary" onClick={() => act(() => api(`/api/purchases/${p.id}/store`, { decision: "in_store" }), `Saved ${money(saving)}. Nothing was paid through Pocket.`)}>I'll get it in store</button>
      </div>
    </div>
  );
}

/* ------------------------------------ Weekly list editor (New agent) ------------------------------------ */

export interface CatalogGroup { id: string; name: string; size: string; products: { id: string; brand: string; title: string; size: string; price: number; store: string; tags: string[] }[] }
export interface ListRow { productId: string; qty: number; usualPrice: number }

export function useCatalog() {
  const [cat, setCat] = useState<{ groups: CatalogGroup[]; starter: { group: string; productId: string; qty: number }[] } | null>(null);
  useEffect(() => { api<typeof cat>("/api/grocery/catalog").then(setCat).catch(() => {}); }, []);
  return cat;
}

/** Your usual items, how many, and what you usually pay (savings are measured against this). */
export function ListEditor({ rows, setRows, groups }: { rows: ListRow[]; setRows: (r: ListRow[]) => void; groups: CatalogGroup[] }) {
  const product = (id: string) => groups.flatMap((g) => g.products).find((p) => p.id === id);
  const groupOf = (id: string) => groups.find((g) => g.products.some((p) => p.id === id));
  const used = new Set(rows.map((r) => groupOf(r.productId)?.id));
  const total = rows.reduce((t, r) => t + r.usualPrice * r.qty, 0);
  const set = (i: number, patch: Partial<ListRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const left = groups.filter((g) => !used.has(g.id));
  return (
    <div className="stack-sm list-editor">
      {/* An inset grouped list, like Reminders: the product (tap to change brand), what you usually pay, and a stepper. */}
      <ul className="grouped-list" aria-label="Your weekly list">
        {rows.map((r, i) => {
          const g = groupOf(r.productId);
          const p = product(r.productId);
          return (
            <li key={`${r.productId}-${i}`} className="list-row">
              <span className="lr-main">
                <span className="lr-pick">
                  <span className="lr-title">{p?.title ?? g?.name ?? "Item"}</span>
                  <span className="lr-size">{p?.size}</span>
                  <Icon name="chevronRight" size={12} stroke={2.4} className="lr-chev" />
                  <select value={r.productId} aria-label={`${g?.name ?? "Item"}: change brand`} onChange={(e) => { const np = product(e.target.value); set(i, { productId: e.target.value, usualPrice: np?.price ?? r.usualPrice }); }}>
                    {g?.products.map((x) => <option key={x.id} value={x.id}>{x.title} · {x.size} · {money(x.price)}</option>)}
                  </select>
                </span>
                <label className="lr-price caption muted">Usually
                  <PriceInput value={r.usualPrice} onChange={(v) => set(i, { usualPrice: v })} label={`Usual price of ${p?.title ?? "item"}`} />
                </label>
              </span>
              <span className="stepper" role="group" aria-label={`How many ${p?.title ?? "items"}`}>
                <button type="button" aria-label={r.qty > 1 ? "One fewer" : `Remove ${p?.title ?? "item"}`} className={r.qty > 1 ? "" : "remove"}
                  onClick={() => (r.qty > 1 ? set(i, { qty: r.qty - 1 }) : setRows(rows.filter((_, j) => j !== i)))}>
                  <Icon name={r.qty > 1 ? "minus" : "trash"} size={14} stroke={2.4} />
                </button>
                <span className="stepper-n" aria-live="polite">{r.qty}</span>
                <button type="button" aria-label="One more" disabled={r.qty >= 20} onClick={() => set(i, { qty: r.qty + 1 })}><Icon name="plus" size={14} stroke={2.4} /></button>
              </span>
            </li>
          );
        })}
        {left.length > 0 && (
          <li className="list-row list-add">
            <span className="lr-add"><Icon name="plus" size={16} stroke={2.4} />Add an item</span>
            <select value="" aria-label="Add an item" onChange={(e) => { const g = groups.find((x) => x.id === e.target.value); if (g) setRows([...rows, { productId: g.products[0].id, qty: 1, usualPrice: g.products[0].price }]); }}>
              <option value="">Add an item</option>
              {left.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.size}</option>)}
            </select>
          </li>
        )}
      </ul>
      <p className="caption muted">{rows.length} items, usually about <strong>{money(total)}</strong> a week. Savings are only ever counted against what you usually pay.</p>
    </div>
  );
}

/** A price you can type freely; it settles to two decimals ("2.90") when you leave the field. */
function PriceInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <span className="price-input">
      <span aria-hidden="true">$</span>
      <input inputMode="decimal" aria-label={label} value={text ?? value.toFixed(2)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => { const t = e.target.value.replace(/[^0-9.]/g, ""); setText(t); onChange(Number(t) || 0); }}
        onBlur={() => setText(null)} />
    </span>
  );
}
