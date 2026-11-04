import { useState } from "react";
import { api, money, useAppState, useToast, type Product } from "../api";

const EMOJI: Record<string, string> = { pegasus: "👟", ultraboost: "👟", cloudrunner: "⚡" };

export default function Store() {
  const { state, refresh } = useAppState(2000);
  const { toast, show } = useToast();
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (!state) return <div className="page muted">Loading…</div>;
  const mandate = state.mandates[0]?.mandate;

  const act = async (key: string, fn: () => Promise<any>, ok?: (r: any) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) show(ok(r));
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const sendAgent = (p: Product, mode: "careful" | "naive") =>
    act(`${p.id}-${mode}`, () => api("/api/agent/run", { mandateId: mandate!.id, productId: p.id, mode }), (r) =>
      r.skipped ? `Agent: ${r.skipped}` : r.purchase.status === "blocked" ? "Agent tried to buy. The guard blocked it." : r.purchase.status === "completed" ? `Agent bought ${r.purchase.title}` : `Agent: ${r.purchase.status.replace("_", " ")}`);

  return (
    <>
      <header className="store-header">
        <div className="row between wrap">
          <div>
            <h1>Stride Supply</h1>
            <p className="small" style={{ color: "#aaa", marginTop: 6 }}>Running gear · Agent-ready checkout with PayPal</p>
          </div>
          <span className="badge ok">✓ Accepts AI agent checkout</span>
        </div>
      </header>

      <div className="page">
        <div className="card demo-panel stack-sm">
          <div className="row between wrap">
            <strong>Demo controls</strong>
            <div className="row wrap">
              <label className="row small"><input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Show hidden text (what agents read)</label>
              <button className="btn sm" onClick={() => confirm("Reset pockets, rules, purchases and the store?") && act("reset", () => api("/api/demo/reset", {}), () => "Demo reset")}>Reset demo</button>
            </div>
          </div>
          <p className="xs muted">
            {mandate ? <>Agent rule in use: “{mandate.instruction}”.</> : "Create a pocket and a rule in the Agent Pocket app first."}{" "}
            “Careful” is a well-behaved agent. “Naive*” simulates a weak or tricked agent that misreads labels and obeys hidden page text, to show the guard and Black Box protect you anyway.
          </p>
        </div>

        <div className="products">
          {state.products.map((p) => (
            <div key={p.id} className="card stack-sm">
              <div className={`product-img ${p.image}`}>{EMOJI[p.image] ?? "👟"}</div>
              <div className="row between">
                <strong>{p.title}</strong>
                <span className={`badge ${p.inStock ? "ok" : "neutral"}`}>{p.inStock ? "In stock" : "Sold out"}</span>
              </div>
              <div className="row between"><span className="small muted">{p.attributes.brand}</span><strong>{money(p.unitPrice)}</strong></div>
              <p className="small">{p.listingText}</p>
              {p.hiddenText && <p className={`hidden-text ${reveal ? "revealed" : ""}`}>{p.hiddenText}</p>}

              <div className="divider" />
              <div className="row wrap">
                <button className="btn sm" disabled={!!busy} onClick={() => act(p.id, () => api(`/api/store/${p.id}/restock`, { inStock: !p.inStock }), () => (p.inStock ? `${p.title} sold out` : `${p.title} dropped: back in stock!`))}>
                  {p.inStock ? "Sell out" : "Drop it (restock)"}
                </button>
                {p.id === "pegasus-41" && (
                  <button className="btn sm" disabled={!!busy} onClick={() => act(`${p.id}-wh`, () => api(`/api/store/${p.id}/warehouse-error`, { shipsAs: p.shipsAs ? null : { ...p.attributes, size_us: "11" } }), () => (p.shipsAs ? "Warehouse fixed" : "Warehouse will ship the wrong size (US 11)"))}>
                    {p.shipsAs ? "✓ Warehouse ships wrong size" : "Warehouse error: ship US 11"}
                  </button>
                )}
              </div>
              <div className="row wrap">
                <button className="btn sm primary" disabled={!mandate || !!busy} onClick={() => sendAgent(p, "careful")}>{busy === `${p.id}-careful` ? <span className="spinner" /> : "Send careful agent"}</button>
                <button className="btn sm" disabled={!mandate || !!busy} onClick={() => sendAgent(p, "naive")}>{busy === `${p.id}-naive` ? <span className="spinner" /> : "Send naive* agent"}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
    </>
  );
}
