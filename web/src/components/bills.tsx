import { useEffect, useState } from "react";
import { api, money, when, type AppState, type LedgerEntry, type Pocket } from "../api";
import { Icon } from "./Icon";
import { SignButton } from "./lock";
import { amount } from "./agent";
import { BrandTile, brandOf } from "./brands";
import { launch, reducedMotion } from "../motion";
import type { Act } from "./purchase";

/**
 * Subscriptions and bills: each recurring payment is a pocket with a cap and rules.
 *  - "Next 7 days" on Home, and the first-run "We found 7 automatic payments" card.
 *  - Alert cards (price hike, trial ending, duplicate, unusual bill) with their decisions.
 *  - The proof behind an alert (what the merchant asked, what the rules allowed, what Pocket did).
 * Merchants and charges are simulated in this demo, and say so.
 */

export interface Sub {
  agentId: string; billerId: string; name: string; kind: "subscription" | "bill"; category: string;
  price: number; cap: number; varyPct?: number; status: "active" | "trial" | "cancelled";
  trialEndsAt?: string; nextChargeAt: string; lastPaid?: { amount: number; at: string; purchaseId: string }; addedAt: string;
}
export interface BillAlert {
  id: string; agentId: string; type: "price_hike" | "trial_end" | "duplicate" | "unusual";
  status: "pending" | "approved" | "paid" | "held" | "kept" | "cancelled" | "superseded";
  title: string; text: string; asked?: number; usual?: number; cap?: number; did?: string; month?: number;
  otherAgentId?: string; purchaseId?: string; createdAt: string; decidedAt?: string;
}
export interface Upcoming { agentId: string; name: string; kind: string; amount: number; approx: boolean; trial: boolean; at: string; inDays: number }
export interface BillsView { subs: Sub[]; alerts: BillAlert[]; month: number; upcoming: Upcoming[]; monthly: number; simulated: true }

interface Found { billerId: string; name: string; kind: "subscription" | "bill"; category: string; price: number; approx?: boolean; trial?: boolean; color: string; added: boolean }
interface Discovery { found: Found[]; count: number; monthly: number; summary: string; merchants: Found[] }

export const subOf = (state: AppState, agentId: string) => state.bills?.subs.find((s) => s.agentId === agentId && s.status !== "cancelled");
export const isRecurring = (state: AppState, p: Pocket) => p.kind === "recurring" || !!state.bills?.subs.some((s) => s.agentId === p.id);
export const pendingBillAlerts = (state: AppState) => {
  const open = new Set(state.pockets.filter((p) => !p.closedAt).map((p) => p.id));
  const rank = { price_hike: 0, unusual: 1, trial_end: 2, duplicate: 3 } as const;
  return (state.bills?.alerts ?? []).filter((a) => a.status === "pending" && open.has(a.agentId)).sort((a, b) => rank[a.type] - rank[b.type]);
};

/** The line on a subscription pocket's card: "$15.49 a month · next Nov 14". */
export function subLine(state: AppState, agentId: string): string | undefined {
  const s = state.bills?.subs.find((x) => x.agentId === agentId);
  if (!s) return undefined;
  if (s.status === "cancelled") return "Cancelled";
  if (s.status === "trial") return `Free trial · ${money(s.price)}/mo from ${short(s.trialEndsAt!)}`;
  return `${s.kind === "bill" ? "~" : ""}${money(s.price)} a month · next ${short(s.nextChargeAt)}`;
}

/**
 * What a subscription pocket's card shows instead of "money left": the price you pay and when.
 *   Netflix   $22.99 / a month    "Next 14 Nov · cap $23"
 *   City Power   ~$90 / a month   "Next 17 Nov · never over $180"
 *   StudyPro     Free / until 14 Nov   "Then $9.99 a month"
 */
export function subFace(state: AppState, agentId: string): { item: string; figure: { amount: string; cap: string }; head: string } | undefined {
  const s = state.bills?.subs.find((x) => x.agentId === agentId);
  if (!s) return undefined;
  const price = `${s.kind === "bill" ? "~" : ""}${amount(s.price)}`;
  if (s.status === "cancelled") return { item: `Was ${price} a month`, figure: { amount: "Off", cap: s.kind === "bill" ? "Not paying" : "Cancelled" }, head: "Cancelled" };
  if (s.status === "trial") return { item: `Then ${amount(s.price)} a month`, figure: { amount: "Free", cap: `until ${short(s.trialEndsAt!)}` }, head: `Free until ${short(s.trialEndsAt!)}` };
  return {
    item: `Next ${short(s.nextChargeAt)} · ${s.kind === "bill" ? "never over" : "cap"} ${amount(s.cap)}`,
    figure: { amount: price, cap: "a month" },
    head: `${price} a month`,
  };
}

const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "short" });
const short = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

/* ------------------------------------ Home ------------------------------------ */

/** "Netflix $15.49 Fri · Electricity ~$90 Mon": what's about to be paid, with the demo's month button. */
export function NextSevenDays({ state, act, openAgent }: { state: AppState; act: Act; openAgent: (id: string) => void }) {
  const b = state.bills;
  if (!b || !b.subs.some((s) => s.status !== "cancelled")) return null;
  const soon = b.upcoming.filter((u) => u.inDays <= 7);
  return (
    <section className="card next7 hero-glass" aria-label="Next 7 days">
      <div className="row between">
        <span className="stack-xs">
          <span className="footnote muted">Next 7 days</span>
          <strong className="headline">{soon.length ? `${soon.length} payment${soon.length === 1 ? "" : "s"} · ${money(soon.reduce((t, u) => t + u.amount, 0))}` : "Nothing due"}</strong>
        </span>
        <span className="caption muted">{money(b.monthly)} a month</span>
      </div>
      {soon.length > 0 && (
        <ul className="next7-list">
          {soon.map((u) => (
            <li key={u.agentId}>
              <button className="next7-row" onClick={() => openAgent(u.agentId)}>
                <span className="grow ellipsis">{u.name}{u.trial ? " · trial ends" : ""}</span>
                <span className="num-plain">{u.approx ? "~" : ""}{money(u.amount)}</span>
                <span className="caption muted next7-day">{u.inDays === 0 ? "Today" : u.inDays === 1 ? "Tomorrow" : day(u.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className="chip btnlike quiet" onClick={() => act(() => api("/api/bills/next-month", {}), "A month went by (simulated).")}>
        <Icon name="clock" size={14} />Next month (demo)
      </button>
    </section>
  );
}

/** First run: "We found 7 automatic payments on your PayPal." Shown until something is added. */
export function DiscoveryCard({ state, openBills }: { state: AppState; openBills: () => void }) {
  const [d, setD] = useState<Discovery | null>(null);
  const has = !!state.bills?.subs.length;
  useEffect(() => { if (!has) api<Discovery>("/api/bills/discover").then(setD).catch(() => {}); }, [has]);
  if (has || !d) return null;
  return (
    <button className="card action-row hero-glass discovery-card" onClick={openBills}>
      <span className="action-count" aria-hidden="true">{d.count}</span>
      <span className="grow stack-xs">
        <strong className="headline">{d.summary}</strong>
        <span className="footnote muted">Want an agent to watch them? Each gets its own cap. (Simulated)</span>
      </span>
      <Icon name="chevronRight" size={18} className="muted" />
    </button>
  );
}

/* ------------------------------------ Discover / pick merchants ------------------------------------ */

/** Pick what to protect: everything found on PayPal, or any merchant from the list. One PIN adds them all. */
export function BillsSheet({ act, close, openAgent }: { act: Act; close: () => void; openAgent?: (id: string) => void }) {
  const [d, setD] = useState<Discovery | null>(null);
  const [all, setAll] = useState(false);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [caps, setCaps] = useState<Record<string, string>>({});
  useEffect(() => {
    api<Discovery>("/api/bills/discover").then((x) => {
      setD(x);
      setPick(Object.fromEntries(x.found.filter((f) => !f.added).map((f) => [f.billerId, true])));
    }).catch(() => {});
  }, []);
  if (!d) return <div className="stack"><h2 className="title-2">Subscriptions and bills</h2><p className="subhead muted"><span className="spinner" /> Looking at your automatic payments…</p></div>;

  const list = all ? d.merchants : d.found;
  const chosen = list.filter((f) => pick[f.billerId] && !f.added);
  const capOf = (f: Found) => Number(caps[f.billerId] ?? (f.kind === "bill" ? (f.price * 2).toFixed(0) : f.price.toFixed(2)));
  const items = chosen.map((f) => ({ billerId: f.billerId, cap: capOf(f) }));

  return (
    <div className="stack">
      <h2 className="title-2">Subscriptions and bills</h2>
      <p className="subhead">{all ? "Pick any merchant and set its cap." : d.summary}</p>
      <p className="caption muted"><Icon name="eye" size={12} /> Simulated in this demo: no real merchant is contacted.</p>
      <div className="set-group">
        {list.map((f) => (
          <label key={f.billerId} className={`bill-pick ${f.added ? "added" : ""}`}>
            <input type="checkbox" checked={!!pick[f.billerId] || f.added} disabled={f.added} onChange={(e) => setPick({ ...pick, [f.billerId]: e.target.checked })} />
            <span className="bill-dot" style={{ background: f.color }} aria-hidden="true" />
            <span className="grow stack-xs">
              <span className="headline">{f.name}</span>
              <span className="caption muted">
                {f.added ? "Already protected" : f.trial ? `Free trial, then ${money(f.price)}/mo` : f.kind === "bill" ? `Bill, usually ~${money(f.price)} · pay within 20%, else ask` : `${money(f.price)} a month`}
              </span>
            </span>
            {!f.added && pick[f.billerId] && (
              <span className="bill-cap">
                <span className="caption muted">{f.kind === "bill" ? "Never over" : "Cap"}</span>
                <input className="input sm" inputMode="decimal" value={caps[f.billerId] ?? String(capOf(f))} aria-label={`Cap for ${f.name}`}
                  onChange={(e) => setCaps({ ...caps, [f.billerId]: e.target.value.replace(/[^0-9.]/g, "") })} />
              </span>
            )}
          </label>
        ))}
      </div>
      <button className="link-btn" onClick={() => setAll(!all)}>{all ? "Show only what was found" : "Add a different merchant"}</button>
      <SignButton title={`Protect ${chosen.length} payment${chosen.length === 1 ? "" : "s"}`} detail="Each becomes its own pocket with a cap"
        disabled={!chosen.length || items.some((i) => !(i.cap > 0))}
        approval={{ rows: chosen.slice(0, 6).map((f) => ({ label: f.name, value: f.kind === "bill" ? `ask above ~${money(f.price * 1.2)}, max ${money(capOf(f))}` : `up to ${money(capOf(f))}/mo` })), note: "Merchants are paid from each pocket through PayPal. Your card is never shared with them." }}
        progress={{ working: "Setting up your pockets", done: "Protected" }}
        onSigned={(auth) => act(async () => {
          const r = await api<{ added: Sub[] }>("/api/bills/add", { auth, items });
          close();
          if (r.added.length === 1 && openAgent) openAgent(r.added[0].agentId);
        }, undefined, { rethrow: true })}>
        {chosen.length === d.found.filter((f) => !f.added).length && !all ? "Add all" : `Add ${chosen.length}`}
      </SignButton>
    </div>
  );
}

/* ------------------------------------ Alerts ------------------------------------ */

const ALERT_ICON = { price_hike: "up", trial_end: "clock", duplicate: "copy", unusual: "alert" } as const;

/** One moment that matters, with its proof and its decision. */
export function BillAlertCard({ state, a, act, openProof, openAgent, inChat }: { state: AppState; a: BillAlert; act: Act; openProof: (id: string) => void; openAgent?: (id: string) => void; inChat?: boolean }) {
  const sub = state.bills?.subs.find((s) => s.agentId === a.agentId);
  const other = a.otherAgentId ? state.bills?.subs.find((s) => s.agentId === a.otherAgentId) : undefined;
  const live = a.status === "pending" || (a.status === "held" && a.type === "unusual");
  const name = sub?.name ?? "This pocket";
  const cancel = (agentId: string, label: string) => act(() => api(`/api/bills/${agentId}/cancel`, { alertId: a.id }), `${label} cancelled. It won't be paid again.`);

  return (
    <div className={`ask-card bill-alert ${a.type === "price_hike" || a.type === "unusual" ? "warn" : ""}`} id={`alert-${a.id}`}>
      <span className="caption muted row" style={{ gap: 6 }}>
        <Icon name={ALERT_ICON[a.type]} size={14} />
        {a.type === "price_hike" ? "Price hike stopped" : a.type === "trial_end" ? "Trial ending" : a.type === "duplicate" ? "Paying twice?" : "Unusual bill"}
        {openAgent && <button className="link-btn caption" onClick={() => openAgent(a.agentId)}>· {name}</button>}
      </span>
      {/* In the chat, the agent's message right above already says this. */}
      {!inChat && <p className="subhead">{a.text}</p>}
      {(a.type === "price_hike" || a.type === "unusual") && a.asked !== undefined && (
        <div className="ask-compare bill-compare">
          <span><span className="caption muted">{a.type === "price_hike" ? "Was" : "Usual"}</span><strong>{amount(a.usual ?? 0)}</strong></span>
          <span className="asked"><span className="caption muted">{a.type === "price_hike" ? "Now" : "This bill"}</span><strong>{amount(a.asked)}</strong></span>
          <span><span className="caption muted">{a.type === "price_hike" ? "Your cap" : "Max"}</span><strong>{amount(a.cap ?? 0)}</strong></span>
        </div>
      )}
      {a.did && <p className="footnote row" style={{ gap: 6 }}><Icon name="shield" size={14} className="ok-text" />{a.did}</p>}

      {live && a.type === "price_hike" && (
        <div className="action-pair">
          <button className="btn tonal" onClick={() => cancel(a.agentId, name)}>Cancel {name}</button>
          <SignButton title="Approve the new price" detail={`${name} · ${money(a.asked)} a month`}
            approval={{ amount: a.asked, rows: [{ label: "Old price", value: money(a.usual) }, { label: "New price", value: money(a.asked) }, { label: "New cap", value: `${money(a.asked)} a month` }] }}
            progress={{ working: "Paying with PayPal", done: "New price approved" }}
            onSigned={(auth) => act(() => api(`/api/bills/alerts/${a.id}/approve-price`, { auth }), undefined, { rethrow: true })}>Approve</SignButton>
        </div>
      )}
      {live && a.type === "unusual" && (
        <div className="action-pair">
          {a.status === "pending" ? <button className="btn tonal" onClick={() => act(() => api(`/api/bills/alerts/${a.id}/hold`, {}), "Held. Nothing paid.")}>Hold it</button>
            : <span className="badge neutral">Held</span>}
          <SignButton title={`Pay ${name}`} detail={`${money(a.asked)} this once`}
            approval={{ amount: a.asked, rows: [{ label: "Usually", value: money(a.usual) }, { label: "This bill", value: money(a.asked) }, { label: "Applies", value: "This bill only" }] }}
            progress={{ working: "Paying with PayPal", done: "Paid" }}
            onSigned={(auth) => act(() => api(`/api/bills/alerts/${a.id}/pay`, { auth }), undefined, { rethrow: true })}>Pay it</SignButton>
        </div>
      )}
      {live && a.type === "trial_end" && (
        <div className="action-pair">
          <button className="btn tonal" onClick={() => cancel(a.agentId, name)}>Cancel it</button>
          <button className="btn primary" onClick={() => act(() => api(`/api/bills/alerts/${a.id}/keep`, {}), `Keeping ${name}.`)}>Keep it</button>
        </div>
      )}
      {live && a.type === "duplicate" && (
        <div className="stack-sm">
          <div className="action-pair">
            {other && <button className="btn tonal" onClick={() => cancel(other.agentId, other.name)}>Cancel {other.name}</button>}
            <button className="btn tonal" onClick={() => cancel(a.agentId, name)}>Cancel {name}</button>
          </div>
          <button className="btn ghost block sm" onClick={() => act(() => api(`/api/bills/alerts/${a.id}/keep`, {}), "Keeping both.")}>Keep both</button>
        </div>
      )}
      {!live && <span className="caption muted">{a.status === "superseded" ? "Replaced by a newer alert" : `Answered${a.decidedAt ? ` ${when(a.decidedAt)}` : ""}`}</span>}
      {(a.type === "price_hike" || a.type === "unusual") && <button className="link-btn caption" onClick={() => openProof(a.id)}>See the record</button>}
    </div>
  );
}

const DID: Record<string, (x: any) => string> = {
  held: () => "Held the charge. Nothing was paid.",
  asked_user: () => "Asked you before paying.",
  stopped: () => "Didn't pay.",
  paid: () => "Paid through PayPal.",
  payment_failed: () => "Tried to pay; PayPal refused.",
  approved_new_price: (x) => `You approved the new price${x.to ? `, ${money(x.to)}` : ""}${x.paid ? ", and it was paid" : ""}.`,
  paid_once: (x) => `You said pay this once${x.amount ? `: ${money(x.amount)}` : ""}.`,
  held_by_user: () => "You held it to check first.",
  kept: () => "You kept it.",
  cancelled: () => "You cancelled it. It won't be paid again.",
};

/** The proof: what the merchant asked, what the rules allowed, and what Pocket did, from the hash-chained record. */
export function ProofSheet({ id }: { id: string }) {
  const [p, setP] = useState<{ alert: BillAlert; entries: LedgerEntry[]; verify: { ok: boolean; checked: number } } | null>(null);
  useEffect(() => { api(`/api/bills/alerts/${id}/proof`).then(setP).catch(() => {}); }, [id]);
  if (!p) return <div className="stack"><h2 className="title-2">The record</h2><span className="spinner" /></div>;
  const line = (e: LedgerEntry) => {
    const x = e.payload ?? {};
    if (e.kind === "bill_request") return { t: "Merchant asked", d: x.amount !== undefined ? `${x.merchant} asked for ${money(x.amount)}${x.simulated ? " (simulated)" : ""}` : "" };
    if (e.kind === "guard_decision") return { t: "What your rules allowed", d: x.outcome === "allow" ? "Inside your rules" : (x.violations ?? []).map((v: { detail: string }) => v.detail).join(" ") || x.outcome };
    if (e.kind === "bill_decision") return { t: x.did === "held" || x.did === "asked_user" || x.did === "stopped" || x.did === "paid" ? "What Pocket did" : "What you decided", d: DID[x.did as string] ? DID[x.did as string](x) : String(x.did ?? "").replace(/_/g, " ") };
    if (e.kind === "paypal_order" || e.kind === "paypal_capture") return { t: "PayPal", d: x.orderId ? `Order ${x.orderId} · ${x.status}` : `Captured ${money(x.amount)}` };
    if (e.kind === "agent_claim") return { t: "Charge", d: `${x.title} · ${money(x.unitPrice)}` };
    return { t: e.kind.replace(/_/g, " "), d: "" };
  };
  return (
    <div className="stack">
      <h2 className="title-2">The record</h2>
      <p className="subhead">{p.alert.title}</p>
      <ol className="proof-list">
        {p.entries.filter((e) => e.kind !== "page_snapshot" && !(e.kind === "bill_request" && e.payload?.record)).map((e) => {
          const l = line(e);
          return (
            <li key={e.seq}>
              <span className="caption muted">#{e.seq} · {when(e.ts)}</span>
              <strong className="footnote">{l.t}</strong>
              {l.d && <span className="footnote">{l.d}</span>}
            </li>
          );
        })}
      </ol>
      <p className={`footnote row ${p.verify.ok ? "ok-text" : "danger-text"}`} style={{ gap: 6 }}>
        <Icon name="shield" size={14} />{p.verify.ok ? `Record intact: ${p.verify.checked} entries checked, none changed.` : "The record was altered."}
      </p>
    </div>
  );
}

/* ------------------------------------ Agent page ------------------------------------ */

/** The top of a subscription pocket: next charge, cap, rule, and the controls. */
export function SubPanel({ state, agent, act }: { state: AppState; agent: Pocket; act: Act }) {
  const sub = state.bills?.subs.find((s) => s.agentId === agent.id);
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState("");
  if (!sub) return null;
  const nextAt = sub.status === "trial" ? sub.trialEndsAt! : sub.nextChargeAt;
  return (
    <section className="agent-intro sub-panel" aria-label={`${sub.name} subscription`}>
      <span className="caption muted">{sub.kind === "bill" ? "Bill" : "Subscription"} · simulated merchant</span>
      <h2 className="headline">{sub.status === "cancelled" ? `${sub.name} is cancelled` : sub.status === "trial" ? `Free trial until ${short(nextAt)}` : `Next charge ${short(nextAt)}`}</h2>
      <div className="ask-compare sub-facts">
        <span><span className="caption muted">{sub.kind === "bill" ? "Usual" : "Price"}</span><strong>{sub.kind === "bill" ? "~" : ""}{amount(sub.price)}</strong></span>
        <span><span className="caption muted">{sub.kind === "bill" ? "Max" : "Cap"}</span><strong>{amount(sub.cap)}</strong></span>
        {sub.lastPaid && <span><span className="caption muted">Last paid</span><strong>{amount(sub.lastPaid.amount)}</strong></span>}
      </div>
      <p className="footnote">
        {sub.kind === "bill"
          ? `Pays when the bill is within ${sub.varyPct ?? 20}% of usual. Above ${amount(Math.round(sub.price * (1 + (sub.varyPct ?? 20) / 100) * 100) / 100)} it asks you first, and it never pays over ${amount(sub.cap)}.`
          : `Pays ${sub.name} up to ${amount(sub.cap)} a month, not a cent more.`} Paid from this pocket through PayPal; {sub.name} never gets your card.
      </p>
      {sub.status !== "cancelled" && (
        editing ? (
          <div className="stack-sm">
            <div className="amount-input"><span>$</span><input className="input" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="New cap" /></div>
            <div className="action-pair">
              <button className="btn tonal" onClick={() => setEditing(false)}>Back</button>
              <SignButton title="Change the cap" detail={`${sub.name} · ${money(Number(cap))}`} disabled={!(Number(cap) > 0)}
                approval={{ rows: [{ label: "From", value: money(sub.cap) }, { label: "To", value: money(Number(cap)) }] }}
                onSigned={(auth) => act(async () => { await api(`/api/bills/${agent.id}/cap`, { auth, cap: Number(cap) }); setEditing(false); }, "New cap signed.", { rethrow: true })}>Sign new cap</SignButton>
            </div>
          </div>
        ) : (
          <div className="row intro-actions">
            <button className="link-btn" onClick={() => { setCap(String(sub.cap)); setEditing(true); }}>Change cap</button>
            <button className="link-btn danger-text" onClick={() => act(() => api(`/api/bills/${agent.id}/cancel`, {}), sub.kind === "bill" ? `Stopped paying ${sub.name}.` : `${sub.name} cancelled. It won't be paid again.`)}>{sub.kind === "bill" ? "Stop paying" : "Cancel subscription"}</button>
          </div>
        )
      )}
    </section>
  );
}

/* ------------------------------------ Home: the subscriptions row ------------------------------------ */

/** "today", "tomorrow", "Sat", then "26 Nov". */
const rel = (iso: string) => {
  const d = Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
  return d === 0 ? "Today" : d === 1 ? "Tomorrow" : d <= 6 ? day(iso) : short(iso);
};

/**
 * Subscriptions on Home: a sideways row of small merchant cards, one tap from opening the app.
 * Whatever needs you comes first, then whatever charges soonest. Tap a card and it flies into its page;
 * "See all" opens the Subscriptions wallet. (Replaces the "Next 7 days" block: same facts, on the cards.)
 */
export function SubsRow({ state, openAgent, seeAll }: { state: AppState; openAgent: (id: string) => void; seeAll: () => void }) {
  const open = new Map(state.pockets.filter((p) => !p.closedAt).map((p) => [p.id, p]));
  const subs = (state.bills?.subs ?? []).filter((x) => x.status !== "cancelled" && open.has(x.agentId));
  if (!subs.length) return null;
  const alerts = pendingBillAlerts(state);
  const needs = (id: string) => alerts.some((a) => a.agentId === id);
  const at = (x: Sub) => (x.status === "trial" ? x.trialEndsAt! : x.nextChargeAt);
  const sorted = [...subs].sort((x, y) => Number(needs(y.agentId)) - Number(needs(x.agentId)) || Date.parse(at(x)) - Date.parse(at(y)));
  const go = (id: string, el: HTMLElement) => { if (!reducedMotion()) launch(id, el.getBoundingClientRect()); openAgent(id); };
  return (
    <section className="subs-row" aria-label="Subscriptions">
      <div className="subs-head">
        <h2 className="headline">Subscriptions</h2>
        <span className="footnote muted grow">{amount(Math.round((state.bills?.monthly ?? 0) * 100) / 100)} a month</span>
        <button className="link-btn" onClick={seeAll}>See all</button>
      </div>
      <div className="subs-scroll">
        {sorted.map((x) => {
          const p = open.get(x.agentId)!;
          const brand = brandOf(p);
          const f = subFace(state, x.agentId)!;
          const n = needs(x.agentId);
          const r = rel(at(x));
          const when = x.status === "trial" ? `Trial ends ${/^To/.test(r) ? r.toLowerCase() : r}` : r;
          return (
            <button key={x.agentId} className={`mini-card agent-face tone-${brand ?? "bundle"}`} data-flight onClick={(e) => go(x.agentId, e.currentTarget)}
              aria-label={`${x.name}, ${f.figure.amount} ${f.figure.cap}${n ? ", needs you" : `, next ${when}`}`}>
              <span className="mini-top">
                {brand ? <BrandTile id={brand} /> : <span />}
                {n && <span className="mini-flag">Needs you</span>}
              </span>
              <span className="mini-text">
                <span className="mini-name">{x.name}</span>
                <span className="mini-price">{f.figure.amount}{x.status === "trial" ? "" : <small>/mo</small>}</span>
                <span className="mini-when">{when}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
