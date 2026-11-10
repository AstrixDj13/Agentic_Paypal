import { useState } from "react";
import { Link } from "react-router-dom";
import { api, money, useAppState, useToast, type Product } from "../api";
import { Toast } from "../components/ui";


/**
 * Stride Supply: the demo merchant. Deliberately plain and not PayPal-branded,
 * so the Pocket app reads as "yours" and this reads as "any shop on the web".
 */
export default function Store() {
  const { state, refresh, error } = useAppState();
  const { toast, show } = useToast();
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("Nike running shoes");
  const [agentId, setAgentId] = useState<string>("");

  if (!state) {
    return (
      <div className="store"><p className="store-pad">
        {error && /sign in/i.test(error) ? <>The demo store runs your own agents, so <a href="/">sign in to Pocket</a> first.</> : "Loading…"}
      </p></div>
    );
  }
  // Which agent the demo buttons send. Defaults to the first agent that has a job.
  const withJobs = state.pockets.filter((p) => !p.closedAt && state.mandates.some((m) => m.mandate.pocketId === p.id));
  const agent = withJobs.find((p) => p.id === agentId) ?? withJobs[0];
  const mandate = agent ? state.mandates.find((m) => m.mandate.pocketId === agent.id)?.mandate : undefined;

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
    <div className="store">
      <header className="store-header">
        <div>
          <h1>Stride Supply</h1>
          <p>Running gear · Agent-ready checkout with PayPal</p>
        </div>
        <span className="store-badge">Accepts agent checkout</span>
      </header>

      <div className="store-pad">
        <section className="backstage">
          <div className="backstage-head">
            <strong>Demo controls</strong>
            <span className="backstage-links"><Link to="/">Pocket app</Link><Link to="/console">Black Box</Link></span>
          </div>
          <p>
            {mandate ? <>Sending <strong>{agent!.name}</strong>, whose job is “{mandate.instruction}”.</> : "Create an agent with a job in the Pocket app first."}{" "}
            “Careful” is a well-behaved agent. “Naive*” simulates a weak or tricked agent that misreads labels and obeys hidden page text, to show the guard and Black Box protect you anyway.
          </p>
          {withJobs.length > 1 && (
            <div className="import-row" role="radiogroup" aria-label="Agent to send">
              {withJobs.map((p) => (
                <button key={p.id} role="radio" aria-checked={agent?.id === p.id} className={`s-btn ${agent?.id === p.id ? "dark" : ""}`} onClick={() => setAgentId(p.id)}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
          <div className="backstage-actions">
            <label className="check"><input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Show hidden text (what agents read)</label>
            <button className="s-btn" onClick={() => confirm("Reset agents, rules, chats, purchases and the store?") && act("reset", () => api("/api/demo/reset", {}), () => "Demo reset")}>Reset demo</button>
          </div>
          {state.channel3?.enabled && (
            <div className="stack-sm">
              <strong>Import real products (Channel3)</strong>
              <div className="import-row">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Adidas running shoes" />
                <button className="s-btn dark" disabled={!!busy || !query.trim()} onClick={() => act("import", () => api<Product[]>("/api/store/import", { query, maxPrice: mandate?.maxUnitPrice }), (r) => `Imported ${r.length} real listing(s)`)}>
                  {busy === "import" ? <span className="spinner" /> : "Import"}
                </button>
              </div>
              <span>Real names, prices and photos from real stores. Checkout here stays PayPal sandbox (test money).</span>
            </div>
          )}
        </section>

        <div className="products">
          {state.products.map((p) => (
            <article key={p.id} className="product">
              <div className={`product-img ${p.image}`}>{p.imageUrl ? <img src={p.imageUrl} alt={p.title} loading="lazy" /> : <span className="product-ph">{p.attributes.brand ?? "Product"}<small>{p.attributes.model ?? p.title}</small></span>}</div>
              {p.source && <a className="real-tag" href={p.source.url} target="_blank" rel="noreferrer">Real listing · {p.source.domain}</a>}
              <div className="product-row">
                <h2>{p.title}</h2>
                <span className={`stock ${p.inStock ? "in" : "out"}`}>{p.inStock ? "In stock" : "Sold out"}</span>
              </div>
              <div className="product-row"><span className="brand">{p.attributes.brand}</span><strong>{money(p.unitPrice)}</strong></div>
              <p className="listing">{p.listingText}</p>
              {p.hiddenText && <p className={`hidden-text ${reveal ? "revealed" : ""}`}>{p.hiddenText}</p>}
              <div className="product-actions">
                <button className="s-btn" disabled={!!busy} onClick={() => act(p.id, () => api(`/api/store/${p.id}/restock`, { inStock: !p.inStock }), () => (p.inStock ? `${p.title} sold out` : `${p.title} dropped: back in stock!`))}>
                  {p.inStock ? "Sell out" : "Drop it (restock)"}
                </button>
                {p.id === "pegasus-41" && (
                  <button className="s-btn" disabled={!!busy} onClick={() => act(`${p.id}-wh`, () => api(`/api/store/${p.id}/warehouse-error`, { shipsAs: p.shipsAs ? null : { ...p.attributes, size_us: "11" } }), () => (p.shipsAs ? "Warehouse fixed" : "Warehouse will ship the wrong size (US 11)"))}>
                    {p.shipsAs ? "Wrong size is on (tap to fix)" : "Warehouse error: US 11"}
                  </button>
                )}
              </div>
              <div className="product-actions">
                <button className="s-btn dark" disabled={!mandate || !!busy} onClick={() => sendAgent(p, "careful")}>{busy === `${p.id}-careful` ? <span className="spinner" /> : "Send careful agent"}</button>
                <button className="s-btn" disabled={!mandate || !!busy} onClick={() => sendAgent(p, "naive")}>{busy === `${p.id}-naive` ? <span className="spinner" /> : "Send naive* agent"}</button>
              </div>
            </article>
          ))}
        </div>
      </div>
      <Toast toast={toast} />
    </div>
  );
}
