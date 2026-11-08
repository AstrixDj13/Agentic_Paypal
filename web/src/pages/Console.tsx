import { useCallback, useEffect, useState } from "react";
import {
  api, money, prettyKey, VERDICT_LABEL, when,
  type AppState, type LedgerEntry, type Mandate, type Purchase, type VerifyResult,
} from "../api";
import { Icon } from "../components/Icon";
import { StatusBadge, STORE_NAME, VerdictCard, verdictTone } from "../components/purchase";
import { Segmented } from "../components/ui";

type Ledger = { entries: LedgerEntry[]; verify: VerifyResult };

/** Plain names for record entries. */
const ENTRY_LABEL: Record<string, string> = {
  instruction: "Your instruction", mandate_signed: "Rules approved", discovery: "Agent found a product",
  page_snapshot: "Product page saved", agent_claim: "Agent placed order", guard_decision: "Checked against your rules",
  paypal_order: "PayPal order created", paypal_capture: "PayPal payment", delivery_reading: "Your photo read",
  merchant_response: "Merchant replied", verdict: "Decision", paypal_resolution: "Money returned",
  proposal: "Change suggested", proposal_decision: "Change approved or declined", exception_ended: "Exception ended", transfer: "Money moved",
};
const entryLabel = (k: string) => ENTRY_LABEL[k] ?? k.replace(/_/g, " ");
type View = "evidence" | "recorder" | "merchant";

/** Polls the hash-chained flight record. */
function useLedger(intervalMs = 3000) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const load = useCallback(async () => {
    try { setLedger(await api<Ledger>("/api/ledger")); } catch { /* keep last good copy */ }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);
  return { ledger, load };
}

/* ====================================== Black Box tab ====================================== */

export function BlackBox({ state, show, openEvidence }: { state: AppState; show: (t: string, e?: boolean) => void; openEvidence: (id: string) => void }) {
  const [view, setView] = useState<View>("evidence");
  const { ledger, load } = useLedger();

  return (
    <>
      <section className="bb-hero">
        <h1 className="large-title">Black Box</h1>
        <p className="subhead muted">A record of every purchase your agents try. If any entry is changed later, it shows here.</p>
        <ChainBadge verify={ledger?.verify} />
      </section>

      <Tiles state={state} />

      <Segmented<View>
        value={view}
        onChange={setView}
        options={[{ value: "evidence", label: "Evidence" }, { value: "recorder", label: "Recorder" }, { value: "merchant", label: "Merchant" }]}
      />

      {view === "evidence" && <EvidenceList purchases={state.purchases} agents={state.pockets} onOpen={openEvidence} />}
      {view === "recorder" && (ledger ? (
        <Recorder
          ledger={ledger}
          onVerify={async () => {
            const v = await api<VerifyResult>("/api/ledger/verify");
            show(v.ok ? `Record intact: ${v.checked} entries checked` : `Record changed at entry ${v.brokenAt}`, !v.ok);
            load();
          }}
          onTamper={async (seq) => {
            const v = await api<VerifyResult>("/api/ledger/tamper", { seq });
            show(v.ok ? "Record still intact" : `Change caught at entry ${v.brokenAt}`, !v.ok);
            load();
          }}
        />
      ) : <div className="card empty"><span className="spinner" /></div>)}
      {view === "merchant" && <MerchantView purchases={state.purchases} />}
    </>
  );
}

function ChainBadge({ verify }: { verify?: VerifyResult }) {
  if (!verify) return null;
  return verify.ok
    ? <span className="chain-badge ok"><Icon name="shield" size={15} />Verified record · {verify.checked} entries, none changed</span>
    : <span className="chain-badge broken"><Icon name="alert" size={14} />Record changed at entry {verify.brokenAt}</span>;
}

function Tiles({ state }: { state: AppState }) {
  const ps = state.purchases;
  const sum = (f: (p: Purchase) => boolean) => ps.filter(f).reduce((s, p) => s + p.total, 0);
  const tiles = [
    { label: `Across ${state.pockets.filter((p) => !p.closedAt).length} agents`, v: money(state.pockets.filter((p) => !p.closedAt).reduce((s, p) => s + p.balance, 0)) },
    { label: "Agent purchases", v: String(ps.filter((p) => p.paypal).length) },
    { label: "Stopped by your rules", v: String(ps.filter((p) => p.status === "blocked").length), tone: "danger" },
    { label: "Agents", v: state.killSwitch ? "Off" : "On", tone: state.killSwitch ? "danger" : undefined },
    { label: "Refunded by merchants", v: money(sum((p) => p.dispute?.resolution?.type === "refund")), tone: "ok" },
    { label: "Paid by Cover Pool", v: money(sum((p) => p.dispute?.resolution?.type === "payout")), tone: "info" },
  ];
  return (
    <div className="tiles">
      {tiles.map((t) => (
        <div key={t.label} className={`tile ${t.tone ? `tone-${t.tone}` : ""}`}>
          <span className="caption muted">{t.label}</span>
          <span className="tile-v num">{t.v}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------ Evidence list ------------------------------------ */

function GuardBadge({ p }: { p: Purchase }) {
  const o = p.decision.outcome;
  if (o === "allow") return <span className="badge ok"><Icon name="shield" size={13} />Allowed</span>;
  if (o === "block") return <span className="badge danger"><Icon name="hand" size={13} />Stopped</span>;
  return <span className="badge warn"><Icon name="clock" size={13} />Asked you</span>;
}

function EvidenceList({ purchases, agents, onOpen }: { purchases: Purchase[]; agents: AppState["pockets"]; onOpen: (id: string) => void }) {
  if (!purchases.length) return <div className="card empty"><p className="subhead muted">No purchases yet.</p></div>;
  return (
    <div className="stack">
      {purchases.map((p) => {
        const v = p.dispute?.result.verdict;
        return (
          <button key={p.id} className="card feed-item rise" onClick={() => onOpen(p.id)}>
            <div className="row between"><StatusBadge status={p.status} /><span className="caption muted">{when(p.createdAt)}</span></div>
            <div className="row between feed-title"><span className="grow ellipsis">{p.title}</span><span className="num">{money(p.total)}</span></div>
            <div className="chips">
              {(() => { const a = agents.find((x) => x.id === p.pocketId); return a ? <span className="badge neutral">{a.name}</span> : null; })()}
              <GuardBadge p={p} />
              {v && <span className={`badge ${verdictTone(v)}`}>{VERDICT_LABEL[v]}</span>}
            </div>
            <Icon name="chevronRight" size={16} className="feed-chevron" />
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------ Evidence sheet ------------------------------------ */

interface EvidenceRow { field: string; cells: [string, string, string, string]; bad: Set<number> }
const SOURCES = ["Your rule", "Agent ordered", "Product page", "Delivered"];

function mandateOf(state: AppState, id: string): Mandate | undefined {
  return [...state.mandates, ...state.retiredMandates].find((m) => m.mandate.id === id)?.mandate;
}

function evidenceRows(p: Purchase, m?: Mandate): EvidenceRow[] {
  const delivered = p.dispute?.delivered.attributes ?? {};
  const keys = new Set([...Object.keys(m?.required ?? {}), ...Object.keys(m?.allowed ?? {}), ...Object.keys(p.order.attributes), ...Object.keys(p.snapshot.attributes), ...Object.keys(delivered)]);
  const rows: EvidenceRow[] = [...keys].map((k) => ({
    field: prettyKey(k),
    cells: [
      m?.required[k] ?? (m?.allowed[k] ? m.allowed[k].join(" / ") : "any"),
      p.order.attributes[k] ?? "–",
      p.snapshot.attributes[k] ?? "–",
      p.dispute ? delivered[k] ?? "not visible" : "–",
    ],
    bad: new Set<number>(),
  }));
  rows.push({ field: "unit price", cells: [`≤ ${money(m?.maxUnitPrice)}`, money(p.order.unitPrice), money(p.snapshot.unitPrice), "–"], bad: new Set() });
  rows.push({ field: "quantity", cells: [`≤ ${m?.maxQuantity ?? "–"}`, String(p.order.quantity), "–", "–"], bad: new Set() });
  const mark = (field: string, col: number) => rows.find((r) => r.field === prettyKey(field) || r.field === field)?.bad.add(col);
  for (const f of p.dispute?.result.findings ?? []) {
    if (f.compared === "mandate_vs_claim") mark(f.field, 1);
    if (f.compared === "snapshot_vs_claim") { mark(f.field, 1); mark(f.field, 2); }
    if (f.compared === "delivered_vs_snapshot") mark(f.field, 3);
  }
  for (const v of p.decision.violations) {
    if (v.rule === "price_over_limit") mark("unit price", 1);
    if (v.rule === "quantity_over_limit") mark("quantity", 1);
    const field = v.detail.match(/^(\w+) must/)?.[1];
    if (field && (v.rule === "required_attribute" || v.rule === "attribute_not_allowed")) mark(field, 1);
  }
  return rows;
}

export function EvidenceSheet({ state, id }: { state: AppState; id: string }) {
  const { ledger } = useLedger();
  const p = state.purchases.find((x) => x.id === id);
  if (!p) return <p className="subhead muted">This purchase isn't in the record.</p>;
  const rows = evidenceRows(p, mandateOf(state, p.mandateId));
  const timeline = (ledger?.entries ?? []).filter((e) => e.purchaseId === p.id || e.purchaseId === p.mandateId);
  const broken = ledger?.verify.brokenAt;
  const [visible, hidden] = p.snapshot.listingText.split("\n[hidden] ");

  return (
    <div className="stack">
      <div className="row between"><StatusBadge status={p.status} /><span className="caption muted">{when(p.createdAt)}</span></div>
      <h2 className="title-2">{p.title}</h2>

      <section className="stack-sm">
        <h3 className="section-title">Evidence</h3>
        <p className="footnote muted">Values marked in red don't match.</p>
        {rows.map((r) => (
          <div key={r.field} className="ev-row">
            <span className="ev-field">{r.field}</span>
            <div className="ev-cells">
              {r.cells.map((c, i) => (
                <div key={i} className={`ev-cell ${r.bad.has(i) ? "bad" : ""}`}>
                  <span className="caption">{SOURCES[i]}</span>
                  <span className="ev-val">{r.bad.has(i) && <Icon name="alert" size={13} />}{c}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="card stack-sm">
        <h3 className="headline">What the agent saw</h3>
        <p className="subhead">{visible}</p>
        {hidden && <p className="hidden-text revealed">Hidden text on the page: {hidden}</p>}
        <p className="footnote muted">Agent's reason: {p.order.reasoning}</p>
      </section>

      {p.dispute ? <VerdictCard p={p} /> : (
        <section className={`card callout ${p.decision.outcome === "block" ? "danger" : p.decision.outcome === "allow" ? "ok" : "warn"}`}>
          <strong className="headline">{p.decision.outcome === "allow" ? "Allowed by your rules" : p.decision.outcome === "block" ? "Stopped by your rules" : "Sent to you for approval"}</strong>
          {p.decision.violations.map((v, i) => <p key={i} className="subhead row" style={{ alignItems: "flex-start" }}><Icon name="hand" size={16} />{v.detail}</p>)}
          {p.why && <p className="footnote muted">{p.why}</p>}
        </section>
      )}

      <section className="stack-sm">
        <h3 className="section-title">History</h3>
        <ol className="chain">
          {timeline.map((e) => (
            <li key={e.seq} className={broken !== undefined && e.seq >= broken ? "broken" : ""}>
              <span className="chain-node" />
              <span className="grow">{entryLabel(e.kind)}</span>
              <span className="caption muted">{when(e.ts)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/* ------------------------------------ Flight recorder ------------------------------------ */

function Recorder({ ledger, onVerify, onTamper }: { ledger: Ledger; onVerify: () => void; onTamper: (seq: number) => void }) {
  const [sel, setSel] = useState<number | null>(null);
  const broken = ledger.verify.brokenAt;
  const entries = [...ledger.entries].reverse();
  return (
    <div className="stack">
      {broken !== undefined && (
        <div className="card callout danger"><strong className="headline row"><Icon name="alert" size={18} />Entry {broken} was changed</strong>
          <p className="footnote">Entries from this point can no longer be trusted.</p></div>
      )}
      <button className="btn primary block" onClick={onVerify}><Icon name="lock" size={16} />Check record</button>
      <button className="btn danger block" disabled={sel === null} onClick={() => sel !== null && onTamper(sel)}>Change selected entry (demo)</button>
      <p className="footnote muted">Select an entry below, then change it to see the record catch it.</p>
      {entries.length === 0 ? <div className="card empty"><p className="subhead muted">The record is empty.</p></div> : (
        <ol className="chain card">
          {entries.map((e) => {
            const bad = broken !== undefined && e.seq >= broken;
            return (
              <li key={e.seq} className={`${bad ? "broken" : ""} ${sel === e.seq ? "sel" : ""}`}>
                <button className="chain-btn" onClick={() => setSel(sel === e.seq ? null : e.seq)} aria-pressed={sel === e.seq}>
                  <span className="chain-node" />
                  <span className="grow stack-xs">
                    <span className="subhead">{entryLabel(e.kind)}</span>
                    <span className="caption muted">{when(e.ts)}</span>
                    {sel === e.seq && <span className="caption muted">Fingerprint <span className="mono-plain">{e.hash.slice(0, 16)}</span> · links to the entry before it</span>}
                  </span>
                  <span className={`caption ${bad ? "danger-text" : "ok-text"}`}>{bad ? "Changed" : "Intact"}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------------ Merchant view ------------------------------------ */

function MerchantView({ purchases }: { purchases: Purchase[] }) {
  const claims = purchases.filter((p) => p.dispute);
  return (
    <div className="stack">
      <p className="footnote muted">{STORE_NAME} sees the same evidence and decision you do.</p>
      {!claims.length && <div className="card empty"><Icon name="store" size={22} /><p className="subhead muted">No claims against {STORE_NAME} yet.</p></div>}
      {claims.map((p) => {
        const d = p.dispute!;
        return (
          <div key={p.id} className="card stack-sm rise">
            <div className="row between"><strong className="headline">{p.title}</strong><span className="caption muted">{when(p.createdAt)}</span></div>
            <p className="subhead">Customer's photo shows: {Object.entries(d.delivered.attributes).map(([k, v]) => `${prettyKey(k)} ${v}`).join(", ") || "unreadable"}</p>
            <p className="subhead">Warehouse shipped: {Object.entries(d.merchant.evidence.shippedAttributes).map(([k, v]) => `${prettyKey(k)} ${v}`).join(", ")}</p>
            <div className="quote"><p className="subhead">{d.merchant.message}</p></div>
            <div className="chips"><span className={`badge ${verdictTone(d.result.verdict)}`}>{VERDICT_LABEL[d.result.verdict]}</span></div>
            {d.resolution && <p className="footnote muted">{d.resolution.detail}</p>}
          </div>
        );
      })}
    </div>
  );
}
