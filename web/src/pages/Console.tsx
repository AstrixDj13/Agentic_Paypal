import { useCallback, useEffect, useState } from "react";
import {
  api, money, prettyKey, VERDICT_LABEL, when,
  type AppState, type LedgerEntry, type Mandate, type Purchase, type VerifyResult,
} from "../api";
import { Icon } from "../components/Icon";
import { StatusBadge, STORE_NAME, VerdictCard, verdictTone } from "../components/purchase";
import { Obj, Segmented } from "../components/ui";

type Ledger = { entries: LedgerEntry[]; verify: VerifyResult };
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
      <section className="bb-hero rise">
        <div className="grow stack-sm">
          <span className="kicker">Flight recorder</span>
          <h1 className="title-2">Every agent purchase, sealed.</h1>
          <p className="footnote">Rules decide, AI explains, PayPal pays. Edit one entry and the chain breaks.</p>
          <ChainBadge verify={ledger?.verify} />
        </div>
        <Obj kind="box" size={0.7} />
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
            show(v.ok ? `Chain intact: ${v.checked} entries verified` : `Chain broken at entry #${v.brokenAt}`, !v.ok);
            load();
          }}
          onTamper={async (seq) => {
            const v = await api<VerifyResult>("/api/ledger/tamper", { seq });
            show(v.ok ? "Chain still valid" : `Tampering detected at entry #${v.brokenAt}`, !v.ok);
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
    ? <span className="chain-badge ok"><Icon name="lock" size={14} />Chain intact · {verify.checked} entries</span>
    : <span className="chain-badge broken"><Icon name="alert" size={14} />Tampering detected at entry #{verify.brokenAt}</span>;
}

function Tiles({ state }: { state: AppState }) {
  const ps = state.purchases;
  const sum = (f: (p: Purchase) => boolean) => ps.filter(f).reduce((s, p) => s + p.total, 0);
  const tiles = [
    { label: `Across ${state.pockets.length} agents`, v: money(state.pockets.reduce((s, p) => s + p.balance, 0)) },
    { label: "Agent purchases", v: String(ps.filter((p) => p.paypal).length) },
    { label: "Blocked by guard", v: String(ps.filter((p) => p.status === "blocked").length), tone: "danger" },
    { label: "Kill switch", v: state.killSwitch ? "On" : "Off", tone: state.killSwitch ? "danger" : undefined },
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
  if (o === "allow") return <span className="badge ok"><Icon name="shield" size={13} />Guard allowed</span>;
  if (o === "block") return <span className="badge danger"><Icon name="hand" size={13} />Blocked ×{p.decision.violations.length}</span>;
  return <span className="badge warn"><Icon name="clock" size={13} />Asked you</span>;
}

function EvidenceList({ purchases, agents, onOpen }: { purchases: Purchase[]; agents: AppState["pockets"]; onOpen: (id: string) => void }) {
  if (!purchases.length) return <div className="card empty"><p className="subhead muted">No agent purchases yet. They appear here the moment the agent tries to buy.</p></div>;
  return (
    <div className="stack">
      {purchases.map((p) => {
        const v = p.dispute?.result.verdict;
        return (
          <button key={p.id} className={`card feed-item s-${p.status} rise`} onClick={() => onOpen(p.id)}>
            <div className="row between"><StatusBadge status={p.status} /><span className="caption muted">{when(p.createdAt)}</span></div>
            <div className="row between feed-title"><span className="grow ellipsis">{p.title}</span><span className="num">{money(p.total)}</span></div>
            <div className="chips">
              {(() => { const a = agents.find((x) => x.id === p.pocketId); return a ? <span className="badge neutral"><span className="dot" style={{ color: a.color }} />{a.name}</span> : null; })()}
              <GuardBadge p={p} />
              {v && <span className={`badge ${verdictTone(v)}`}>{VERDICT_LABEL[v]}</span>}
              <span className="badge neutral">{p.mode === "naive" ? "naive* agent" : "careful agent"}</span>
            </div>
            {p.paypal && <p className="mono muted">PayPal {p.paypal.orderId}</p>}
            <Icon name="chevronRight" size={16} className="feed-chevron" />
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------ Evidence sheet ------------------------------------ */

interface EvidenceRow { field: string; cells: [string, string, string, string]; bad: Set<number> }
const SOURCES = ["Signed mandate", "Agent claimed", "Page snapshot", "Delivered (photo)"];

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
      <div className="row between"><StatusBadge status={p.status} /><span className="mono muted">{p.id}</span></div>
      <h2 className="title-2">{p.title}</h2>

      <section className="stack-sm">
        <h3 className="section-title">Evidence, four ways</h3>
        <p className="footnote muted">Red cells are where the record disagrees. The arbiter's rules decide fault from these cells alone.</p>
        {rows.map((r) => (
          <div key={r.field} className="ev-row">
            <span className="ev-field">{r.field}</span>
            <div className="ev-cells">
              {r.cells.map((c, i) => (
                <div key={i} className={`ev-cell ${r.bad.has(i) ? "bad" : ""}`}>
                  <span className="caption">{i + 1} · {SOURCES[i]}</span>
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
        {hidden && <p className="hidden-text revealed">Hidden text on page: {hidden}</p>}
        <p className="footnote muted">Agent's reasoning: {p.order.reasoning}</p>
      </section>

      {p.dispute ? <VerdictCard p={p} /> : (
        <section className={`card callout ${p.decision.outcome === "block" ? "danger" : p.decision.outcome === "allow" ? "ok" : "warn"}`}>
          <strong className="headline">Guard decision: {p.decision.outcome === "allow" ? "allowed" : p.decision.outcome === "block" ? "blocked" : "asked you"}</strong>
          {p.decision.violations.map((v, i) => <p key={i} className="subhead row" style={{ alignItems: "flex-start" }}><Icon name="hand" size={16} />{v.detail}</p>)}
          {p.why && <p className="footnote muted">{p.why}</p>}
        </section>
      )}

      <section className="stack-sm">
        <h3 className="section-title">Flight record · {timeline.length} sealed entries</h3>
        <ol className="chain">
          {timeline.map((e) => (
            <li key={e.seq} className={broken !== undefined && e.seq >= broken ? "broken" : ""}>
              <span className="chain-node" />
              <span className="grow">#{e.seq} {e.kind.replace(/_/g, " ")}</span>
              <span className="mono muted">{e.hash.slice(0, 10)}…</span>
            </li>
          ))}
        </ol>
      </section>
      {p.paypal && <p className="mono muted">PayPal order {p.paypal.orderId}{p.paypal.captureId ? ` · capture ${p.paypal.captureId}` : ""}</p>}
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
        <div className="card callout danger"><strong className="headline row"><Icon name="alert" size={18} />Tampering detected at entry #{broken}</strong>
          <p className="footnote">Every entry after it no longer matches its hash.</p></div>
      )}
      <div className="row" style={{ gap: 10 }}>
        <button className="btn primary grow" onClick={onVerify}><Icon name="lock" size={16} />Verify chain</button>
        <button className="btn danger grow" disabled={sel === null} onClick={() => sel !== null && onTamper(sel)}>Tamper (demo)</button>
      </div>
      <p className="footnote muted">Each entry's hash covers its content and the previous hash. Tap an entry, then tamper with it to watch the chain break.</p>
      {entries.length === 0 ? <div className="card empty"><p className="subhead muted">The record is empty.</p></div> : (
        <ol className="chain card">
          {entries.map((e) => {
            const bad = broken !== undefined && e.seq >= broken;
            return (
              <li key={e.seq} className={`${bad ? "broken" : ""} ${sel === e.seq ? "sel" : ""}`}>
                <button className="chain-btn" onClick={() => setSel(sel === e.seq ? null : e.seq)} aria-pressed={sel === e.seq}>
                  <span className="chain-node" />
                  <span className="grow stack-xs">
                    <span className="subhead">#{e.seq} {e.kind.replace(/_/g, " ")}</span>
                    <span className="caption muted">{when(e.ts)} · {e.purchaseId}</span>
                  </span>
                  <span className="stack-xs" style={{ alignItems: "flex-end" }}>
                    <span className="mono muted">{e.hash.slice(0, 8)}…</span>
                    <span className={`caption ${bad ? "danger-text" : "ok-text"}`}>{bad ? "broken" : "ok"}</span>
                  </span>
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
      <p className="footnote muted">{STORE_NAME} sees the same sealed evidence and verdict as the buyer. Fair to both sides.</p>
      {!claims.length && <div className="card empty"><Icon name="store" size={22} /><p className="subhead muted">No claims against {STORE_NAME} yet.</p></div>}
      {claims.map((p) => {
        const d = p.dispute!;
        return (
          <div key={p.id} className="card stack-sm rise">
            <div className="row between"><strong className="headline">{p.title}</strong><span className="caption muted">{when(p.createdAt)}</span></div>
            <p className="subhead">Buyer's photo shows: {Object.entries(d.delivered.attributes).map(([k, v]) => `${prettyKey(k)} ${v}`).join(", ") || "unreadable"}</p>
            <p className="subhead">Our warehouse shipped: {Object.entries(d.merchant.evidence.shippedAttributes).map(([k, v]) => `${prettyKey(k)} ${v}`).join(", ")}</p>
            <div className="quote"><p className="subhead">Our agent ({d.merchant.stance}): {d.merchant.message}</p></div>
            <div className="chips"><span className={`badge ${verdictTone(d.result.verdict)}`}>{VERDICT_LABEL[d.result.verdict]}</span></div>
            {d.resolution && <p className="footnote muted">{d.resolution.detail}</p>}
          </div>
        );
      })}
    </div>
  );
}
