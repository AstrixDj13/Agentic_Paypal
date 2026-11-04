import { useCallback, useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import {
  api, money, prettyKey, STATUS_LABEL, useAppState, useToast, VERDICT_LABEL, when,
  type AppState, type LedgerEntry, type Mandate, type Purchase, type VerifyResult,
} from "../api";
import { gridTheme } from "../gridTheme";
import { VerdictCard } from "./PocketApp";

type Tab = "purchases" | "ledger" | "merchant";

export default function Console() {
  const { state, refresh } = useAppState(2500);
  const { toast, show } = useToast();
  const [tab, setTab] = useState<Tab>("purchases");
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("p"));
  const [ledger, setLedger] = useState<{ entries: LedgerEntry[]; verify: VerifyResult } | null>(null);

  const loadLedger = useCallback(async () => setLedger(await api("/api/ledger")), []);
  useEffect(() => {
    loadLedger();
    const t = setInterval(loadLedger, 3000);
    return () => clearInterval(t);
  }, [loadLedger]);

  if (!state) return <div className="page muted">Loading…</div>;
  const sel = state.purchases.find((p) => p.id === selected) ?? null;

  return (
    <div className="page">
      <div className="row between wrap">
        <div>
          <h2>Black Box</h2>
          <p className="small muted">Every agent purchase, sealed in a tamper-evident flight record. Rules decide, AI explains, PayPal pays.</p>
        </div>
        <ChainBadge verify={ledger?.verify} />
      </div>

      <Tiles state={state} />

      <div className="tabs">
        <button className={tab === "purchases" ? "active" : ""} onClick={() => setTab("purchases")}>Evidence ledger</button>
        <button className={tab === "ledger" ? "active" : ""} onClick={() => setTab("ledger")}>Flight recorder</button>
        <button className={tab === "merchant" ? "active" : ""} onClick={() => setTab("merchant")}>Merchant view</button>
      </div>

      {tab === "purchases" && (
        <>
          <PurchasesGrid purchases={state.purchases} onSelect={setSelected} />
          {sel ? <PurchaseEvidence p={sel} state={state} entries={ledger?.entries ?? []} /> : <p className="small muted">Select a row to replay its flight record.</p>}
        </>
      )}
      {tab === "ledger" && ledger && (
        <LedgerView
          ledger={ledger}
          onTamper={async (seq) => {
            const v = await api<VerifyResult>("/api/ledger/tamper", { seq });
            show(v.ok ? "Chain still valid" : `Tampering detected at entry #${v.brokenAt}`, !v.ok);
            loadLedger();
          }}
          onVerify={async () => {
            const v = await api<VerifyResult>("/api/ledger/verify");
            show(v.ok ? `Chain intact: ${v.checked} entries verified` : `Chain broken at entry #${v.brokenAt}`, !v.ok);
            loadLedger();
          }}
        />
      )}
      {tab === "merchant" && <MerchantView purchases={state.purchases} />}
      <div className="row"><button className="btn sm ghost" onClick={refresh}>Refresh</button></div>
      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
    </div>
  );
}

function ChainBadge({ verify }: { verify?: VerifyResult }) {
  if (!verify) return null;
  return verify.ok
    ? <span className="badge ok" style={{ fontSize: 13, padding: "6px 12px" }}>🔒 Chain intact · {verify.checked} entries</span>
    : <span className="badge danger" style={{ fontSize: 13, padding: "6px 12px" }}>⚠ Tampering detected at entry #{verify.brokenAt}</span>;
}

function Tiles({ state }: { state: AppState }) {
  const ps = state.purchases;
  const sum = (f: (p: Purchase) => boolean) => ps.filter(f).reduce((s, p) => s + p.total, 0);
  const tiles = [
    { label: "In agent pockets", v: money(state.pockets.reduce((s, p) => s + p.balance, 0)) },
    { label: "Agent purchases", v: String(ps.filter((p) => p.paypal).length) },
    { label: "Blocked by guard", v: String(ps.filter((p) => p.status === "blocked").length) },
    { label: "Refunded by merchants", v: money(sum((p) => p.dispute?.resolution?.type === "refund")) },
    { label: "Paid by Agent Cover Pool", v: money(sum((p) => p.dispute?.resolution?.type === "payout")) },
    { label: "Kill switch", v: state.killSwitch ? "ON" : "off" },
  ];
  return (
    <div className="tiles">
      {tiles.map((t) => <div key={t.label} className="tile"><div className="xs muted">{t.label}</div><div className="v">{t.v}</div></div>)}
    </div>
  );
}

/* ------------------------------------ Purchases grid ------------------------------------ */

const StatusCell = (p: ICellRendererParams<Purchase>) => {
  if (!p.data) return null;
  const s = STATUS_LABEL[p.data.status];
  return <span className={`badge ${s.tone}`}>{s.text}</span>;
};
const GuardCell = (p: ICellRendererParams<Purchase>) => {
  const o = p.data?.decision.outcome;
  return <span className={`badge ${o === "allow" ? "ok" : o === "block" ? "danger" : "warn"}`}>{o === "allow" ? "allowed" : o === "block" ? `blocked ×${p.data!.decision.violations.length}` : "ask user"}</span>;
};
const VerdictCell = (p: ICellRendererParams<Purchase>) => {
  const v = p.data?.dispute?.result.verdict;
  return v ? <span className={`badge ${v === "MERCHANT_AT_FAULT" ? "info" : v === "AGENT_AT_FAULT" ? "warn" : "neutral"}`}>{VERDICT_LABEL[v]}</span> : <span className="muted">–</span>;
};

function PurchasesGrid({ purchases, onSelect }: { purchases: Purchase[]; onSelect: (id: string) => void }) {
  const cols = useMemo<ColDef<Purchase>[]>(() => [
    { headerName: "Time", field: "createdAt", valueFormatter: (p) => when(p.value), width: 130 },
    { headerName: "Item", field: "title", flex: 2, minWidth: 200 },
    { headerName: "Agent", field: "mode", width: 95, valueFormatter: (p) => (p.value === "naive" ? "naive*" : "careful") },
    { headerName: "Qty", valueGetter: (p) => p.data?.order.quantity, width: 70 },
    { headerName: "Total", field: "total", valueFormatter: (p) => money(p.value), width: 100 },
    { headerName: "Guard", cellRenderer: GuardCell, width: 120 },
    { headerName: "PayPal order", valueGetter: (p) => p.data?.paypal?.orderId ?? "–", width: 170, cellClass: "mono" },
    { headerName: "Verdict", cellRenderer: VerdictCell, width: 150 },
    {
      headerName: "Settlement", flex: 1, minWidth: 140,
      valueGetter: (p) => {
        const r = p.data?.dispute?.resolution;
        return !r ? "–" : r.type === "refund" ? `Refund ${money(r.amount)}` : r.type === "payout" ? `Cover pool ${money(r.amount)}` : r.type === "mandate_fix" ? "Rule fix proposed" : r.type;
      },
    },
    { headerName: "Status", cellRenderer: StatusCell, width: 140 },
  ], []);

  return (
    <div className="grid-wrap">
      <AgGridReact<Purchase>
        theme={gridTheme}
        rowData={purchases}
        columnDefs={cols}
        getRowId={(p) => p.data.id}
        rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
        onRowClicked={(e) => e.data && onSelect(e.data.id)}
        defaultColDef={{ sortable: true, resizable: true, filter: true }}
        overlayNoRowsTemplate="No agent purchases yet"
      />
    </div>
  );
}

/* ------------------------------------ Evidence comparison ------------------------------------ */

interface EvidenceRow { field: string; mandate: string; claim: string; snapshot: string; delivered: string; bad: Set<string> }

function mandateOf(state: AppState, id: string): Mandate | undefined {
  return [...state.mandates, ...state.retiredMandates].find((m) => m.mandate.id === id)?.mandate;
}

function evidenceRows(p: Purchase, m?: Mandate): EvidenceRow[] {
  const delivered = p.dispute?.delivered.attributes ?? {};
  const keys = new Set([...Object.keys(m?.required ?? {}), ...Object.keys(m?.allowed ?? {}), ...Object.keys(p.order.attributes), ...Object.keys(p.snapshot.attributes), ...Object.keys(delivered)]);
  const rows: EvidenceRow[] = [...keys].map((k) => ({
    field: prettyKey(k),
    mandate: m?.required[k] ?? (m?.allowed[k] ? m.allowed[k].join(" / ") : "any"),
    claim: p.order.attributes[k] ?? "–",
    snapshot: p.snapshot.attributes[k] ?? "–",
    delivered: p.dispute ? delivered[k] ?? "not visible" : "–",
    bad: new Set<string>(),
  }));
  rows.push({ field: "unit price", mandate: `≤ ${money(m?.maxUnitPrice)}`, claim: money(p.order.unitPrice), snapshot: money(p.snapshot.unitPrice), delivered: "–", bad: new Set() });
  rows.push({ field: "quantity", mandate: `≤ ${m?.maxQuantity ?? "–"}`, claim: String(p.order.quantity), snapshot: "–", delivered: "–", bad: new Set() });

  const mark = (field: string, col: string) => rows.find((r) => r.field === prettyKey(field) || r.field === field)?.bad.add(col);
  for (const f of p.dispute?.result.findings ?? []) {
    if (f.compared === "mandate_vs_claim") mark(f.field, "claim");
    if (f.compared === "snapshot_vs_claim") { mark(f.field, "claim"); mark(f.field, "snapshot"); }
    if (f.compared === "delivered_vs_snapshot") mark(f.field, "delivered");
  }
  for (const v of p.decision.violations) {
    if (v.rule === "price_over_limit") mark("unit price", "claim");
    if (v.rule === "quantity_over_limit") mark("quantity", "claim");
    const field = v.detail.match(/^(\w+) must/)?.[1];
    if (field && (v.rule === "required_attribute" || v.rule === "attribute_not_allowed")) mark(field, "claim");
  }
  return rows;
}

function PurchaseEvidence({ p, state, entries }: { p: Purchase; state: AppState; entries: LedgerEntry[] }) {
  const m = mandateOf(state, p.mandateId);
  const rows = evidenceRows(p, m);
  const bad = (col: string) => ({ "cell-bad": (x: { data?: EvidenceRow }) => !!x.data?.bad.has(col) });
  const cols: ColDef<EvidenceRow>[] = [
    { headerName: "Field", field: "field", width: 130, cellStyle: { fontWeight: 600 } },
    { headerName: "① Signed mandate", field: "mandate", flex: 1 },
    { headerName: "② Agent claimed", field: "claim", flex: 1, cellClassRules: bad("claim") },
    { headerName: "③ Page snapshot", field: "snapshot", flex: 1, cellClassRules: bad("snapshot") },
    { headerName: "④ Delivered (photo)", field: "delivered", flex: 1, cellClassRules: bad("delivered") },
  ];
  const timeline = entries.filter((e) => e.purchaseId === p.id || e.purchaseId === p.mandateId);

  return (
    <div className="detail">
      <div className="stack">
        <div className="card stack-sm">
          <div className="row between"><strong>Evidence comparison: {p.title}</strong><span className="xs muted">{p.id}</span></div>
          <p className="xs muted">Red cells are where the record disagrees. The arbiter's rules decide fault from these cells alone.</p>
          <div style={{ height: 60 + rows.length * 42 }}>
            <AgGridReact<EvidenceRow> theme={gridTheme} rowData={rows} columnDefs={cols} domLayout="normal" suppressCellFocus />
          </div>
        </div>
        <div className="card stack-sm">
          <strong>What the agent saw</strong>
          <p className="small">{p.snapshot.listingText.split("\n[hidden] ")[0]}</p>
          {p.snapshot.listingText.includes("[hidden]") && <p className="hidden-text revealed">Hidden text on page: {p.snapshot.listingText.split("[hidden] ")[1]}</p>}
          <p className="xs muted">Agent's reasoning: {p.order.reasoning}</p>
        </div>
      </div>
      <div className="stack">
        {p.dispute ? <div className="card"><VerdictCard p={p} /></div> : (
          <div className="card stack-sm">
            <strong>Guard decision: {p.decision.outcome}</strong>
            {p.decision.violations.map((v, i) => <p key={i} className="small">✋ {v.detail}</p>)}
            {p.why && <p className="small muted">{p.why}</p>}
          </div>
        )}
        <div className="card stack-sm">
          <strong>Flight record ({timeline.length} sealed entries)</strong>
          {timeline.map((e) => (
            <div key={e.seq} className="row between xs">
              <span>#{e.seq} {e.kind.replace(/_/g, " ")}</span>
              <span className="mono muted">{e.hash.slice(0, 10)}…</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------ Flight recorder ------------------------------------ */

function LedgerView({ ledger, onTamper, onVerify }: { ledger: { entries: LedgerEntry[]; verify: VerifyResult }; onTamper: (seq: number) => void; onVerify: () => void }) {
  const [sel, setSel] = useState<number | null>(null);
  const broken = ledger.verify.brokenAt;
  const cols: ColDef<LedgerEntry>[] = [
    { headerName: "#", field: "seq", width: 70 },
    { headerName: "Time", field: "ts", valueFormatter: (p) => when(p.value), width: 140 },
    { headerName: "Record", field: "purchaseId", width: 130, cellClass: "mono" },
    { headerName: "Entry", field: "kind", width: 170, valueFormatter: (p) => String(p.value).replace(/_/g, " ") },
    { headerName: "Payload", valueGetter: (p) => JSON.stringify(p.data?.payload).slice(0, 140), flex: 2, cellClass: "mono" },
    { headerName: "Prev hash", field: "prevHash", width: 130, cellClass: "mono", valueFormatter: (p) => `${String(p.value).slice(0, 10)}…` },
    { headerName: "Hash", field: "hash", width: 130, cellClass: "mono", valueFormatter: (p) => `${String(p.value).slice(0, 10)}…` },
    {
      headerName: "Chain", width: 110,
      valueGetter: (p) => (broken !== undefined && p.data!.seq >= broken ? "✗ broken" : "✓ ok"),
      cellClassRules: { "hash-broken": (p) => broken !== undefined && p.data!.seq >= broken, "cell-good": (p) => broken === undefined || p.data!.seq < broken },
    },
  ];
  return (
    <div className="stack">
      <div className="row wrap">
        <button className="btn primary" onClick={onVerify}>Verify chain</button>
        <button className="btn danger" disabled={sel === null} onClick={() => sel !== null && onTamper(sel)}>Tamper with selected entry (demo)</button>
        <span className="small muted">Each entry's hash covers its content and the previous hash. Edit anything and the chain breaks from that point on.</span>
      </div>
      <div style={{ height: 460 }}>
        <AgGridReact<LedgerEntry>
          theme={gridTheme}
          rowData={[...ledger.entries].reverse()}
          columnDefs={cols}
          getRowId={(p) => String(p.data.seq)}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => e.data && setSel(e.data.seq)}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------ Merchant view ------------------------------------ */

function MerchantView({ purchases }: { purchases: Purchase[] }) {
  const claims = purchases.filter((p) => p.dispute);
  if (!claims.length) return <p className="small muted">No claims against Stride Supply yet.</p>;
  return (
    <div className="stack">
      <p className="small muted">Stride Supply sees the same sealed evidence and verdict as the buyer. Fair to both sides.</p>
      {claims.map((p) => {
        const d = p.dispute!;
        return (
          <div key={p.id} className="card stack-sm">
            <div className="row between"><strong>{p.title}</strong><span className="badge neutral">{when(p.createdAt)}</span></div>
            <p className="small">Buyer's photo shows: {Object.entries(d.delivered.attributes).map(([k, v]) => `${prettyKey(k)} ${v}`).join(", ") || "unreadable"}</p>
            <p className="small">Our warehouse shipped: {Object.entries(d.merchant.evidence.shippedAttributes).map(([k, v]) => `${prettyKey(k)} ${v}`).join(", ")}</p>
            <div className="quote">Our agent ({d.merchant.stance}): {d.merchant.message}</div>
            <div className="row wrap"><span className="badge info">{VERDICT_LABEL[d.result.verdict]}</span><span className="small muted">{d.resolution?.detail}</span></div>
          </div>
        );
      })}
    </div>
  );
}
