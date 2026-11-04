import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  api, attrsText, fileToDataUrl, money, prettyKey, PRESET_LABEL, STATUS_LABEL, useAppState, useToast, VERDICT_LABEL, when,
  type AppState, type MandateDraft, type Purchase, type SignedMandate,
} from "../api";

type Tab = "home" | "rules" | "activity";
type Sheet = { kind: "pocket" } | { kind: "rule" } | { kind: "purchase"; id: string } | { kind: "wrong"; id: string } | null;

export default function PocketApp() {
  const { state, refresh, error } = useAppState();
  const { toast, show } = useToast();
  const [tab, setTab] = useState<Tab>("home");
  const [sheet, setSheet] = useState<Sheet>(null);

  // Return from PayPal approval (vault connect).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("paypal") === "connected") show("PayPal connected. Your agent can now pay without a PIN.");
    if (q.get("paypal") === "error") show(`PayPal connect failed: ${q.get("reason") ?? ""}`, true);
    if (q.get("paypal")) history.replaceState(null, "", "/");
  }, [show]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) show(ok);
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      refresh();
    }
  };

  if (!state) {
    return <div className="phone-stage"><div className="phone"><div className="phone-body"><p className="muted">{error ? `Can't reach the server: ${error}` : "Loading…"}</p></div></div></div>;
  }

  const total = state.pockets.reduce((s, p) => s + p.balance, 0);
  const pending = state.purchases.filter((p) => p.status === "needs_approval").length;

  return (
    <div className="phone-stage">
      <div className="phone">
        <header className="phone-header">
          <div className="row between">
            <div className="row" style={{ gap: 10 }}>
              <img src="/icon.svg" width={28} height={28} alt="" />
              <strong>Agent Pocket</strong>
            </div>
            <Link to="/console" style={{ color: "#9fc2ff", fontSize: 12 }}>Black Box ↗</Link>
          </div>
          <p className="xs" style={{ color: "#9fb0cc", marginTop: 14 }}>Fenced off for your agent</p>
          <div className="balance">{money(total)}</div>
          <div className="row xs" style={{ color: "#9fb0cc", gap: 12, marginTop: 4 }}>
            <span>{state.vault ? "● PayPal connected" : "○ PayPal not connected"}</span>
            <span>{state.ai.enabled ? `● AI: ${state.ai.model}` : "○ AI off (rules only)"}</span>
          </div>
          <div className="kill">
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{state.killSwitch ? "Agent spending paused" : "Agent can spend"}</div>
              <div className="xs" style={{ color: "#9fb0cc" }}>Kill switch: one tap stops every purchase</div>
            </div>
            <button
              className={`switch ${state.killSwitch ? "on" : ""}`}
              aria-label="Kill switch"
              onClick={() => act(() => api("/api/killswitch", { on: !state.killSwitch }), state.killSwitch ? "Agent spending resumed" : "All agent spending paused")}
            />
          </div>
        </header>

        <main className="phone-body">
          {tab === "home" && <Home state={state} act={act} setSheet={setSheet} setTab={setTab} />}
          {tab === "rules" && <Rules state={state} act={act} setSheet={setSheet} />}
          {tab === "activity" && <Activity state={state} setSheet={setSheet} />}
        </main>

        <nav className="phone-tabs">
          <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}><span className="ico">⌂</span>Home</button>
          <button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}><span className="ico">✎</span>Rules</button>
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
            <span className="ico">≡</span>Activity{pending ? ` (${pending})` : ""}
          </button>
        </nav>

        {sheet && (
          <div className="sheet-backdrop" onClick={() => setSheet(null)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="grab" />
              {sheet.kind === "pocket" && <NewPocket act={act} close={() => setSheet(null)} />}
              {sheet.kind === "rule" && <NewRule state={state} act={act} close={() => setSheet(null)} />}
              {sheet.kind === "purchase" && <PurchaseDetail state={state} id={sheet.id} act={act} setSheet={setSheet} />}
              {sheet.kind === "wrong" && <ReportWrong state={state} id={sheet.id} refresh={refresh} show={show} setSheet={setSheet} />}
            </div>
          </div>
        )}
        {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

/* ====================================== Home ====================================== */

function Home({ state, act, setSheet, setTab }: { state: AppState; act: Act; setSheet: (s: Sheet) => void; setTab: (t: Tab) => void }) {
  const connect = () => act(async () => {
    const { approveUrl } = await api<{ approveUrl: string }>("/api/paypal/connect", {});
    location.href = approveUrl;
  });

  return (
    <>
      {!state.vault && (
        <div className="card stack-sm">
          <strong>Connect PayPal once</strong>
          <p className="small muted">Save PayPal for your agent. After this it pays inside your rules, with no PIN and no redirect.</p>
          <button className="btn gold" onClick={connect}>Connect PayPal</button>
        </div>
      )}

      <div className="row between"><span className="section-title">Pockets</span><button className="btn sm" onClick={() => setSheet({ kind: "pocket" })}>+ New pocket</button></div>
      {state.pockets.length === 0 && <div className="card small muted">Create a pocket: a slice of money your agent can use. The rest of your PayPal stays out of reach.</div>}
      {state.pockets.map((p) => (
        <div key={p.id} className="pocket-card rise">
          <div className="row between"><span style={{ fontWeight: 700 }}>{p.name}</span><span className="xs" style={{ opacity: .8 }}>Agent pocket</span></div>
          <div className="amt">{money(p.balance)}</div>
          <div className="xs" style={{ opacity: .85 }}>{state.mandates.filter((m) => m.mandate.pocketId === p.id).length} active rule(s)</div>
        </div>
      ))}

      <div className="row between"><span className="section-title">Latest</span><button className="btn sm ghost" onClick={() => setTab("activity")}>See all</button></div>
      {state.purchases.length === 0 ? (
        <div className="card small muted">Nothing yet. Write a rule, and your agent will buy when it's allowed to.</div>
      ) : (
        state.purchases.slice(0, 3).map((p) => <FeedItem key={p.id} p={p} onOpen={() => setSheet({ kind: "purchase", id: p.id })} />)
      )}
    </>
  );
}

/* ====================================== Rules ====================================== */

function Rules({ state, act, setSheet }: { state: AppState; act: Act; setSheet: (s: Sheet) => void }) {
  const [running, setRunning] = useState<string | null>(null);
  const run = (m: SignedMandate) => {
    setRunning(m.mandate.id);
    act(async () => {
      const r = await api<{ purchase?: Purchase; skipped?: string }>("/api/agent/run", { mandateId: m.mandate.id, mode: "careful" });
      if (r.skipped) throw new Error(r.skipped);
    }, "Agent checked the store").finally(() => setRunning(null));
  };
  return (
    <>
      <div className="row between"><span className="section-title">Signed rules</span><button className="btn sm primary" disabled={!state.pockets.length} onClick={() => setSheet({ kind: "rule" })}>+ New rule</button></div>
      {!state.pockets.length && <div className="card small muted">Create a pocket first.</div>}
      {state.mandates.map((m) => (
        <div key={m.mandate.id} className="card stack-sm rise">
          <div className="row between">
            <strong style={{ textTransform: "capitalize" }}>{m.mandate.item}</strong>
            <span className="badge ok">✓ Signed</span>
          </div>
          <MandateChips m={m.mandate} />
          <p className="xs muted">“{m.mandate.instruction}”</p>
          <div className="row between">
            <span className="mono muted">sig …{m.signature.slice(-12)}</span>
            <button className="btn sm" disabled={running === m.mandate.id} onClick={() => run(m)}>
              {running === m.mandate.id ? <span className="spinner" /> : "Check store now"}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function MandateChips({ m }: { m: Pick<MandateDraft, "required" | "allowed" | "maxUnitPrice" | "maxQuantity" | "expiresAt"> }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {Object.entries(m.required).map(([k, v]) => <span key={k} className="chip">{prettyKey(k)}: {v}</span>)}
      {Object.entries(m.allowed).map(([k, v]) => <span key={k} className="chip">{prettyKey(k)}: {v.join(" / ")}</span>)}
      <span className="chip">≤ {money(m.maxUnitPrice)}</span>
      <span className="chip">max {m.maxQuantity}</span>
      <span className="chip">until {new Date(m.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
    </div>
  );
}

/* ====================================== Activity ====================================== */

function Activity({ state, setSheet }: { state: AppState; setSheet: (s: Sheet) => void }) {
  return (
    <>
      <span className="section-title">Everything your agent did</span>
      {state.purchases.length === 0 && <div className="card small muted">No activity yet.</div>}
      {state.purchases.map((p) => <FeedItem key={p.id} p={p} onOpen={() => setSheet({ kind: "purchase", id: p.id })} />)}
    </>
  );
}

function FeedItem({ p, onOpen }: { p: Purchase; onOpen: () => void }) {
  const s = STATUS_LABEL[p.status];
  const r = p.dispute?.resolution;
  return (
    <button className={`card feed-item s-${p.status} stack-sm rise`} style={{ textAlign: "left", cursor: "pointer" }} onClick={onOpen}>
      <div className="row between">
        <span className={`badge ${s.tone}`}>{s.text}</span>
        <span className="xs muted">{when(p.createdAt)}</span>
      </div>
      <div className="row between">
        <strong className="grow" style={{ fontSize: 14 }}>{p.title}{p.order.quantity > 1 ? ` ×${p.order.quantity}` : ""}</strong>
        <strong>{money(p.total)}</strong>
      </div>
      {p.status === "blocked" && <p className="xs" style={{ color: "var(--danger)" }}>✋ {p.decision.violations[0]?.detail}{p.decision.violations.length > 1 ? ` (+${p.decision.violations.length - 1} more)` : ""}</p>}
      {p.why && !p.dispute && <p className="xs muted">{p.why}</p>}
      {r && <p className="xs" style={{ color: "var(--ok)" }}>{resolutionLine(r)}</p>}
    </button>
  );
}

function resolutionLine(r: NonNullable<NonNullable<Purchase["dispute"]>["resolution"]>) {
  if (r.type === "refund") return `↩ Refunded ${money(r.amount)} by the merchant`;
  if (r.type === "payout") return `↩ Paid back ${money(r.amount)} by the Agent Cover Pool`;
  if (r.type === "mandate_fix") return "✎ Sharper rule proposed";
  if (r.type === "evidence_pack") return "⚑ Evidence pack ready to file";
  return r.detail;
}

/* ====================================== Sheets ====================================== */

function NewPocket({ act, close }: { act: Act; close: () => void }) {
  const [name, setName] = useState("Drops");
  const [amount, setAmount] = useState("150");
  return (
    <div className="stack">
      <h3>New pocket</h3>
      <p className="small muted">A slice of your money your agent can spend. It can never touch anything outside it.</p>
      <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Amount (USD)<input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <button className="btn primary block" onClick={() => act(() => api("/api/pockets", { name, amount: Number(amount) }), `Pocket "${name}" created`).then(close)}>Create pocket</button>
    </div>
  );
}

function NewRule({ state, act, close }: { state: AppState; act: Act; close: () => void }) {
  const [pocketId, setPocketId] = useState(state.pockets[0]?.id ?? "");
  const [instruction, setInstruction] = useState("Running shoes, size 10, under $100, Nike or Adidas only, expires Nov 30");
  const [draft, setDraft] = useState<MandateDraft | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);

  const parse = async () => {
    setBusy(true);
    try {
      const r = await api<{ draft: MandateDraft; source: string }>("/api/mandates/draft", { instruction });
      setDraft(r.draft);
      setSource(r.source);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!draft) {
    return (
      <div className="stack">
        <h3>New rule</h3>
        <p className="small muted">Say what your agent may buy, in your own words.</p>
        <label className="field">Pocket
          <select className="select" value={pocketId} onChange={(e) => setPocketId(e.target.value)}>
            {state.pockets.map((p) => <option key={p.id} value={p.id}>{p.name} ({money(p.balance)})</option>)}
          </select>
        </label>
        <textarea className="textarea" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        <button className="btn primary block" disabled={busy || !instruction.trim()} onClick={parse}>
          {busy ? <><span className="spinner" /> Reading your words…</> : "Turn into rules"}
        </button>
      </div>
    );
  }

  const size = draft.required.size_us ?? "";
  const brands = (draft.allowed.brand ?? []).join(", ");
  const set = (patch: Partial<MandateDraft>) => setDraft({ ...draft, ...patch });

  return (
    <div className="stack">
      <div className="row between"><h3>Check the rules</h3><span className="badge info">{source === "ai" ? "Read by AI" : "Read by rules"}</span></div>
      <p className="small muted">Your agent can only buy what matches these. Plain code enforces them at checkout, not the AI.</p>
      <label className="field">Item<input className="input" value={draft.item} onChange={(e) => set({ item: e.target.value })} /></label>
      <div className="row">
        <label className="field grow">US size<input className="input" value={size} onChange={(e) => set({ required: { ...draft.required, size_us: e.target.value } })} /></label>
        <label className="field grow">Max price ($)<input className="input" inputMode="decimal" value={draft.maxUnitPrice} onChange={(e) => set({ maxUnitPrice: Number(e.target.value) })} /></label>
      </div>
      <div className="row">
        <label className="field grow">Brands<input className="input" value={brands} onChange={(e) => set({ allowed: { ...draft.allowed, brand: e.target.value.split(",").map((b) => b.trim().toLowerCase()).filter(Boolean) } })} /></label>
        <label className="field" style={{ width: 90 }}>Max qty<input className="input" inputMode="numeric" value={draft.maxQuantity} onChange={(e) => set({ maxQuantity: Number(e.target.value) })} /></label>
      </div>
      <label className="field">Expires<input className="input" type="date" value={draft.expiresAt.slice(0, 10)} onChange={(e) => set({ expiresAt: new Date(`${e.target.value}T23:59:59Z`).toISOString() })} /></label>
      <MandateChips m={draft} />
      <button className="btn primary block" onClick={() => act(() => api("/api/mandates", { pocketId, instruction, draft }), "Rule approved and signed").then(close)}>Approve &amp; sign</button>
      <button className="btn ghost block" onClick={() => setDraft(null)}>Back</button>
    </div>
  );
}

function PurchaseDetail({ state, id, act, setSheet }: { state: AppState; id: string; act: Act; setSheet: (s: Sheet) => void }) {
  const p = state.purchases.find((x) => x.id === id);
  if (!p) return <p className="muted">Not found.</p>;
  const s = STATUS_LABEL[p.status];
  return (
    <div className="stack">
      <div className="row between"><span className={`badge ${s.tone}`}>{s.text}</span><span className="xs muted">{when(p.createdAt)}</span></div>
      <h3>{p.title}</h3>
      <div className="row between small"><span className="muted">{p.order.quantity} × {money(p.order.unitPrice)}</span><strong>{money(p.total)}</strong></div>
      <p className="small muted">{attrsText(p.order.attributes)}</p>

      {p.why && <div className="quote"><strong>Why did you buy this?</strong><br />{p.why}</div>}

      {p.decision.violations.length > 0 && (
        <div className="card stack-sm" style={{ borderColor: "var(--danger)" }}>
          <strong style={{ color: "var(--danger)" }}>{p.status === "blocked" ? "The guard stopped this order" : "Needs your approval"}</strong>
          {p.decision.violations.map((v, i) => <p key={i} className="small">✋ {v.detail}</p>)}
          {p.status === "blocked" && p.snapshot.listingText.includes("[hidden]") && (
            <p className="xs muted">The page contained hidden instructions aimed at shopping agents. Your agent was fooled, but your rules held.</p>
          )}
        </div>
      )}

      {p.paypal && <p className="mono muted">PayPal order {p.paypal.orderId} · capture {p.paypal.captureId}</p>}
      <Link className="small" to={`/console?p=${p.id}`}>Open the flight record in Black Box ↗</Link>
      {p.error && <p className="small" style={{ color: "var(--danger)" }}>{p.error}</p>}

      {p.dispute && <VerdictCard p={p} act={act} />}

      {p.status === "needs_approval" && <button className="btn primary block" onClick={() => act(() => api(`/api/purchases/${p.id}/approve`, {}), "Approved")}>Approve this merchant &amp; buy</button>}
      {p.status === "completed" && <button className="btn danger block" onClick={() => setSheet({ kind: "wrong", id: p.id })}>Something's wrong</button>}
    </div>
  );
}

export function VerdictCard({ p, act }: { p: Purchase; act?: Act }) {
  const d = p.dispute!;
  const r = d.resolution;
  return (
    <div className="stack-sm rise">
      <div className={`verdict ${d.result.verdict} stack-sm`}>
        <span className="section-title">Black Box verdict</span>
        <h3>{VERDICT_LABEL[d.result.verdict]}</h3>
        <p className="small">{d.explanation}</p>
        {d.result.findings.map((f, i) => (
          <p key={i} className="xs mono">{prettyKey(f.field)}: expected {f.expected}, got {f.actual} · {f.compared.replace(/_/g, " ")}</p>
        ))}
      </div>
      <div className="quote">
        <div className="row between"><strong>{STORE_NAME} agent</strong><span className={`badge ${d.merchant.stance === "accept" ? "ok" : "warn"}`}>{d.merchant.stance === "accept" ? "Accepts" : "Contests"}</span></div>
        <p style={{ marginTop: 4 }}>{d.merchant.message}</p>
      </div>
      <p className="xs muted">Photo read ({d.delivered.source === "ai" ? "AI vision" : "demo preset"}, {Math.round(d.delivered.confidence * 100)}% sure): {attrsText(d.delivered.attributes) || "nothing readable"}</p>
      {r && (
        <div className="card stack-sm">
          <strong>{resolutionLine(r)}</strong>
          <p className="xs muted">{r.detail}</p>
          {r.paypalId && <p className="mono muted">PayPal ref {r.paypalId}</p>}
          {r.proposedFix && (
            <>
              <p className="small">New rule: <strong>{r.proposedFix.item}</strong></p>
              <p className="xs muted">{r.proposedFix.note}</p>
              {act && <button className="btn primary sm" onClick={() => act(() => api(`/api/purchases/${p.id}/apply-fix`, {}), "Sharper rule signed")}>Approve &amp; sign new rule</button>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const STORE_NAME = "Stride Supply";

const STEPS = ["Reading your photo", "Asking the merchant's agent", "Replaying the flight record", "Settling with PayPal"];

function ReportWrong({ state, id, refresh, show, setSheet }: { state: AppState; id: string; refresh: () => void; show: (t: string, e?: boolean) => void; setSheet: (s: Sheet) => void }) {
  const p = state.purchases.find((x) => x.id === id);
  const [preset, setPreset] = useState<string>(defaultPreset(p));
  const [photo, setPhoto] = useState<string | null>(null);
  const [complaint, setComplaint] = useState("");
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (step < 0 || step >= STEPS.length - 1) return;
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1300);
    return () => clearTimeout(t);
  }, [step]);

  const presets = useMemo(() => state.photoPresets, [state.photoPresets]);
  if (!p) return null;

  const submit = async () => {
    setStep(0);
    try {
      await api(`/api/purchases/${p.id}/wrong`, photo ? { imageDataUrl: photo, complaint } : { preset, complaint });
      await refresh();
      setSheet({ kind: "purchase", id: p.id });
    } catch (e) {
      show((e as Error).message, true);
      setStep(-1);
    }
  };

  if (step >= 0) {
    return (
      <div className="stack">
        <h3>Black Box is on it</h3>
        <ul className="steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "active" : ""}>
              <span className="dot">{i < step ? "✓" : i === step ? <span className="spinner" /> : i + 1}</span>{s}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="stack">
      <h3>What's wrong?</h3>
      <p className="small muted">Snap the label on the box. The Black Box compares it with what you asked for, what your agent claimed and what the page said.</p>
      <label className="btn block">
        📷 {photo ? "Retake photo" : "Take a photo of the label"}
        <input type="file" accept="image/*" capture="environment" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPhoto(await fileToDataUrl(f)); }} />
      </label>
      {photo ? (
        <>
          <img className="photo-preview" src={photo} alt="Your photo" />
          <button className="btn ghost sm" onClick={() => setPhoto(null)}>Use a demo photo instead</button>
        </>
      ) : (
        <>
          <span className="xs muted">Or use a demo photo:</span>
          <div className="row wrap" style={{ gap: 6 }}>
            {presets.map((k) => <button key={k} className={`chip btnlike ${preset === k ? "on" : ""}`} onClick={() => setPreset(k)}>{PRESET_LABEL[k] ?? k}</button>)}
          </div>
        </>
      )}
      <textarea className="textarea" placeholder="Tell us in a sentence (optional), e.g. “I meant trail shoes”" value={complaint} onChange={(e) => setComplaint(e.target.value)} />
      <button className="btn danger block" onClick={submit}>Send to Black Box</button>
    </div>
  );
}

function defaultPreset(p?: Purchase) {
  if (!p) return "label-us11";
  if (p.productId === "ultraboost-5") return "label-adidas-us11";
  return "label-us11";
}
