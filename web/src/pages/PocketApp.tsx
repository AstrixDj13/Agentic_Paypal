import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  api, attrsText, fileToDataUrl, money, PRESET_LABEL, useAppState, useToast, when,
  type AppState, type MandateDraft, type Purchase, type SignedMandate,
} from "../api";
import { BrandLockup } from "../components/Brand";
import { Icon, type IconName } from "../components/Icon";
import { FeedItem, MandateChips, StatusBadge, VerdictCard, type Act } from "../components/purchase";
import { Money, Obj, Segmented, Sheet, Switch, Toast, useTheme } from "../components/ui";
import { BlackBox, EvidenceSheet } from "./Console";

type Tab = "home" | "rules" | "activity" | "blackbox";
export type SheetState =
  | { kind: "pocket" }
  | { kind: "rule" }
  | { kind: "purchase"; id: string }
  | { kind: "wrong"; id: string }
  | { kind: "evidence"; id: string }
  | null;

const TABS: { tab: Tab; path: string; label: string; icon: IconName }[] = [
  { tab: "home", path: "/", label: "Home", icon: "home" },
  { tab: "rules", path: "/rules", label: "Rules", icon: "rules" },
  { tab: "activity", path: "/activity", label: "Activity", icon: "activity" },
  { tab: "blackbox", path: "/console", label: "Black Box", icon: "box" },
];

const tabFromPath = (p: string): Tab => (p.startsWith("/console") ? "blackbox" : p.startsWith("/rules") ? "rules" : p.startsWith("/activity") ? "activity" : "home");

export default function PocketApp() {
  const { state, refresh, error } = useAppState();
  const { toast, show } = useToast();
  const { dark, toggle } = useTheme();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const tab = tabFromPath(pathname);
  const [sheet, setSheet] = useState<SheetState>(null);
  const close = useCallback(() => setSheet(null), []);

  // Return from PayPal approval (vault connect), and deep links like /console?p=<purchaseId>.
  useEffect(() => {
    const q = new URLSearchParams(search);
    if (q.get("paypal") === "connected") show("PayPal connected. Your agent can now pay without a PIN.");
    if (q.get("paypal") === "error") show(`PayPal connect failed: ${q.get("reason") ?? ""}`, true);
    if (q.get("p")) setSheet({ kind: "evidence", id: q.get("p")! });
    if (q.get("paypal") || q.get("p")) navigate(pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll back to top when switching tabs.
  useEffect(() => { document.querySelector(".screen")?.scrollTo({ top: 0 }); }, [tab]);

  const act: Act = async (fn, ok) => {
    try {
      await fn();
      if (ok) show(ok);
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      refresh();
    }
  };

  const toggleKill = () =>
    state && act(() => api("/api/killswitch", { on: !state.killSwitch }), state.killSwitch ? "Agent spending resumed" : "All agent spending paused");

  const openEvidence = (id: string) => { setSheet({ kind: "evidence", id }); navigate("/console"); };

  const pending = state?.purchases.filter((p) => p.status === "needs_approval").length ?? 0;

  return (
    <div className="stage">
      <div className={`device ${state?.killSwitch ? "paused" : ""}`}>
        <header className="brandbar">
          <BrandLockup product={tab === "blackbox" ? "Black Box" : "Pocket"} />
          <div className="row" style={{ gap: 8 }}>
            {state && tab !== "home" && (
              <div className={`kill-pill ${state.killSwitch ? "paused" : ""}`}>
                <span>{state.killSwitch ? "Paused" : "Agent on"}</span>
                <Switch on={!state.killSwitch} onChange={toggleKill} label="Agent can spend" />
              </div>
            )}
            <button className="icon-btn on-chrome" aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>
              <Icon name={dark ? "sun" : "moon"} size={18} />
            </button>
          </div>
        </header>

        <main className="screen">
          {!state ? (
            <div className="card empty">
              {error ? <><Icon name="alert" size={22} /><p className="subhead">Can't reach the server.</p><p className="footnote muted">{error}</p></> : <><span className="spinner" /><p className="subhead muted">Loading your pocket…</p></>}
            </div>
          ) : (
            <>
              {tab === "home" && <Home state={state} act={act} setSheet={setSheet} toggleKill={toggleKill} goActivity={() => navigate("/activity")} />}
              {tab === "rules" && <Rules state={state} act={act} setSheet={setSheet} />}
              {tab === "activity" && <Activity state={state} setSheet={setSheet} />}
              {tab === "blackbox" && <BlackBox state={state} show={show} openEvidence={(id) => setSheet({ kind: "evidence", id })} />}
            </>
          )}
        </main>

        <nav className="tabbar glass" aria-label="Main">
          {TABS.map((t) => (
            <button key={t.tab} className={tab === t.tab ? "on" : ""} aria-current={tab === t.tab ? "page" : undefined} onClick={() => navigate(t.path)}>
              <span className="tab-ico">
                <Icon name={t.icon} size={22} />
                {t.tab === "activity" && pending > 0 && <span className="dot-badge">{pending}</span>}
              </span>
              {t.label}
            </button>
          ))}
        </nav>

        {state && sheet && (
          <Sheet onClose={close} key={sheet.kind + ("id" in sheet ? sheet.id : "")}>
            {sheet.kind === "pocket" && <NewPocket act={act} close={close} />}
            {sheet.kind === "rule" && <NewRule state={state} act={act} close={close} />}
            {sheet.kind === "purchase" && <PurchaseDetail state={state} id={sheet.id} act={act} setSheet={setSheet} openEvidence={openEvidence} />}
            {sheet.kind === "wrong" && <ReportWrong state={state} id={sheet.id} refresh={refresh} show={show} setSheet={setSheet} />}
            {sheet.kind === "evidence" && <EvidenceSheet state={state} id={sheet.id} />}
          </Sheet>
        )}
        <Toast toast={toast} />
      </div>
    </div>
  );
}

/* ====================================== Home ====================================== */

function Home({ state, act, setSheet, toggleKill, goActivity }: { state: AppState; act: Act; setSheet: (s: SheetState) => void; toggleKill: () => void; goActivity: () => void }) {
  const total = state.pockets.reduce((s, p) => s + p.balance, 0);
  const connect = () => act(async () => {
    const { approveUrl } = await api<{ approveUrl: string }>("/api/paypal/connect", {});
    location.href = approveUrl;
  });

  return (
    <>
      <section className="hero">
        <p className="footnote muted">Fenced off for your agent</p>
        <Money value={total} />
        <div className="chips">
          <span className={`badge ${state.vault ? "ok" : "neutral"}`}><span className="dot" />{state.vault ? "PayPal connected" : "PayPal not connected"}</span>
          <span className={`badge ${state.ai.enabled ? "blue" : "neutral"}`}><Icon name="sparkles" size={13} />{state.ai.enabled ? state.ai.model : "AI off · rules only"}</span>
        </div>
      </section>

      <div className={`kill-row glass ${state.killSwitch ? "paused" : ""}`}>
        <div className="grow">
          <div className="headline">{state.killSwitch ? "Agent spending paused" : "Agent can spend"}</div>
          <div className="footnote muted">{state.killSwitch ? "Nothing can be bought until you turn it back on" : "Kill switch: one tap stops every purchase"}</div>
        </div>
        <Switch on={!state.killSwitch} onChange={toggleKill} label="Agent can spend" />
      </div>

      {!state.vault && (
        <div className="card connect-card rise">
          <Obj kind="pocket" size={0.7} />
          <div className="stack-sm" style={{ textAlign: "center" }}>
            <h3 className="headline">Connect PayPal once</h3>
            <p className="subhead muted">Your agent pays inside your rules. No PIN and no redirect after this.</p>
          </div>
          <button className="btn gold block" onClick={connect}>Connect PayPal</button>
        </div>
      )}

      <div className="section-head">
        <h2 className="section-title">Pockets</h2>
        <button className="btn sm glass-btn" onClick={() => setSheet({ kind: "pocket" })}><Icon name="plus" size={16} />New</button>
      </div>
      {state.pockets.length === 0 ? (
        <button className="card empty tappable" onClick={() => setSheet({ kind: "pocket" })}>
          <Obj kind="pocket" size={0.6} />
          <p className="subhead">Create a pocket: a slice of money your agent can use.</p>
          <p className="footnote muted">The rest of your PayPal stays out of reach.</p>
        </button>
      ) : (
        <div className="stack">
          {state.pockets.map((p) => {
            const rules = state.mandates.filter((m) => m.mandate.pocketId === p.id).length;
            return (
              <div key={p.id} className="pocket-card rise">
                <div className="row between"><span className="headline">{p.name}</span><span className="caption">Agent pocket</span></div>
                <Money value={p.balance} size="title" />
                <span className="footnote">{rules} active rule{rules === 1 ? "" : "s"}</span>
                <Obj kind="coin" size={0.85} />
              </div>
            );
          })}
        </div>
      )}

      <div className="section-head">
        <h2 className="section-title">Latest</h2>
        {state.purchases.length > 0 && <button className="btn sm ghost" onClick={goActivity}>See all</button>}
      </div>
      {state.purchases.length === 0 ? (
        <div className="card empty"><p className="subhead muted">Nothing yet. Write a rule, and your agent buys when it's allowed to.</p></div>
      ) : (
        <div className="stack">{state.purchases.slice(0, 3).map((p) => <FeedItem key={p.id} p={p} onOpen={() => setSheet({ kind: "purchase", id: p.id })} />)}</div>
      )}
    </>
  );
}

/* ====================================== Rules ====================================== */

function Rules({ state, act, setSheet }: { state: AppState; act: Act; setSheet: (s: SheetState) => void }) {
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
      <div className="page-head">
        <h1 className="large-title">Rules</h1>
        <button className="btn sm primary" disabled={!state.pockets.length} onClick={() => setSheet({ kind: "rule" })}><Icon name="plus" size={16} />New rule</button>
      </div>
      <p className="subhead muted">Signed once. Plain code enforces them at checkout, not the AI.</p>
      {!state.pockets.length && <div className="card empty"><Obj kind="pocket" size={0.55} /><p className="subhead muted">Create a pocket first, then write a rule for it.</p></div>}
      {state.pockets.length > 0 && state.mandates.length === 0 && (
        <button className="card empty tappable" onClick={() => setSheet({ kind: "rule" })}>
          <Obj kind="shield" size={0.55} />
          <p className="subhead">Tell your agent what it may buy, in your own words.</p>
        </button>
      )}
      <div className="stack">
        {state.mandates.map((m) => (
          <div key={m.mandate.id} className="card stack-sm rise">
            <div className="row between">
              <strong className="headline capitalize">{m.mandate.item}</strong>
              <span className="badge blue"><Icon name="check" size={13} stroke={2.4} />Signed</span>
            </div>
            <MandateChips m={m.mandate} />
            <p className="footnote muted">“{m.mandate.instruction}”</p>
            <div className="row between">
              <span className="mono muted">sig …{m.signature.slice(-12)}</span>
              <button className="btn sm glass-btn" disabled={running === m.mandate.id} onClick={() => run(m)}>
                {running === m.mandate.id ? <><span className="spinner" />Checking</> : "Check store now"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ====================================== Activity ====================================== */

type Filter = "all" | "needs" | "blocked" | "disputes";

function Activity({ state, setSheet }: { state: AppState; setSheet: (s: SheetState) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(() => ({
    needs: state.purchases.filter((p) => p.status === "needs_approval").length,
    blocked: state.purchases.filter((p) => p.status === "blocked").length,
    disputes: state.purchases.filter((p) => p.dispute).length,
  }), [state.purchases]);
  const list = state.purchases.filter((p) =>
    filter === "all" ? true : filter === "needs" ? p.status === "needs_approval" : filter === "blocked" ? p.status === "blocked" : !!p.dispute);
  return (
    <>
      <div className="page-head"><h1 className="large-title">Activity</h1></div>
      <p className="subhead muted">Everything your agent did, with its reasons.</p>
      <Segmented<Filter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All" },
          { value: "needs", label: `Needs OK${counts.needs ? ` ${counts.needs}` : ""}` },
          { value: "blocked", label: `Blocked${counts.blocked ? ` ${counts.blocked}` : ""}` },
          { value: "disputes", label: "Disputes" },
        ]}
      />
      {list.length === 0 && <div className="card empty"><p className="subhead muted">{state.purchases.length ? "Nothing in this view." : "No activity yet."}</p></div>}
      <div className="stack">{list.map((p) => <FeedItem key={p.id} p={p} onOpen={() => setSheet({ kind: "purchase", id: p.id })} />)}</div>
    </>
  );
}

/* ====================================== Sheets ====================================== */

function NewPocket({ act, close }: { act: Act; close: () => void }) {
  const [name, setName] = useState("Drops");
  const [amount, setAmount] = useState("150");
  return (
    <div className="stack">
      <div className="sheet-hero"><Obj kind="pocket" size={0.75} /></div>
      <h2 className="title-2">New pocket</h2>
      <p className="subhead muted">A slice of your money your agent can spend. It can never touch anything outside it.</p>
      <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Amount (USD)
        <div className="amount-input"><span>$</span><input className="input big" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /></div>
      </label>
      <div className="chips">
        {[50, 100, 150, 250].map((v) => (
          <button key={v} className={`chip btnlike ${Number(amount) === v ? "on" : ""}`} onClick={() => setAmount(String(v))}>${v}</button>
        ))}
      </div>
      <button className="btn primary block" disabled={!name.trim() || !(Number(amount) > 0)} onClick={() => act(() => api("/api/pockets", { name, amount: Number(amount) }), `Pocket "${name}" created`).then(close)}>
        Create pocket
      </button>
    </div>
  );
}

function NewRule({ state, act, close }: { state: AppState; act: Act; close: () => void }) {
  const [pocketId, setPocketId] = useState(state.pockets[0]?.id ?? "");
  const [instruction, setInstruction] = useState("Running shoes, size 10, under $100, Nike or Adidas only, expires Nov 30");
  const [draft, setDraft] = useState<MandateDraft | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parse = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ draft: MandateDraft; source: string }>("/api/mandates/draft", { instruction });
      setDraft(r.draft);
      setSource(r.source);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!draft) {
    return (
      <div className="stack">
        <div className="row between"><h2 className="title-2">New rule</h2><span className="caption muted">Step 1 of 2</span></div>
        <p className="subhead muted">Say what your agent may buy, in your own words.</p>
        <label className="field">Pocket
          <select className="input" value={pocketId} onChange={(e) => setPocketId(e.target.value)}>
            {state.pockets.map((p) => <option key={p.id} value={p.id}>{p.name} ({money(p.balance)})</option>)}
          </select>
        </label>
        <textarea className="input textarea" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="Your rule in words" />
        <p className="footnote muted">Try: “Concert tickets under $80 each, max 2, until Dec 15”</p>
        {err && <p className="footnote danger-text">{err}</p>}
        <button className="btn primary block" disabled={busy || !instruction.trim()} onClick={parse}>
          {busy ? <><span className="spinner" />Reading your words…</> : "Turn into rules"}
        </button>
      </div>
    );
  }

  const size = draft.required.size_us ?? "";
  const brands = (draft.allowed.brand ?? []).join(", ");
  const set = (patch: Partial<MandateDraft>) => setDraft({ ...draft, ...patch });
  return (
    <div className="stack">
      <div className="row between">
        <h2 className="title-2">Check the rules</h2>
        <span className="badge blue"><Icon name={source === "ai" ? "sparkles" : "rules"} size={13} />{source === "ai" ? "Read by AI" : "Read by rules"}</span>
      </div>
      <p className="subhead muted">Your agent can only buy what matches these. Plain code enforces them at checkout, not the AI.</p>
      <label className="field">Item<input className="input" value={draft.item} onChange={(e) => set({ item: e.target.value })} /></label>
      <div className="row" style={{ gap: 12 }}>
        <label className="field grow">US size<input className="input" value={size} onChange={(e) => set({ required: { ...draft.required, size_us: e.target.value } })} /></label>
        <label className="field grow">Max price ($)<input className="input" inputMode="decimal" value={draft.maxUnitPrice} onChange={(e) => set({ maxUnitPrice: Number(e.target.value) })} /></label>
      </div>
      <div className="row" style={{ gap: 12 }}>
        <label className="field grow">Brands<input className="input" value={brands} onChange={(e) => set({ allowed: { ...draft.allowed, brand: e.target.value.split(",").map((b) => b.trim().toLowerCase()).filter(Boolean) } })} /></label>
        <label className="field" style={{ width: 96 }}>Max qty<input className="input" inputMode="numeric" value={draft.maxQuantity} onChange={(e) => set({ maxQuantity: Number(e.target.value) })} /></label>
      </div>
      <label className="field">Expires<input className="input" type="date" value={draft.expiresAt.slice(0, 10)} onChange={(e) => set({ expiresAt: new Date(`${e.target.value}T23:59:59Z`).toISOString() })} /></label>
      <MandateChips m={draft} />
      <button className="btn primary block" onClick={() => act(() => api("/api/mandates", { pocketId, instruction, draft }), "Rule approved and signed").then(close)}>
        <Icon name="lock" size={18} />Approve &amp; sign
      </button>
      <button className="btn ghost block" onClick={() => setDraft(null)}>Back</button>
    </div>
  );
}

function PurchaseDetail({ state, id, act, setSheet, openEvidence }: { state: AppState; id: string; act: Act; setSheet: (s: SheetState) => void; openEvidence: (id: string) => void }) {
  const p = state.purchases.find((x) => x.id === id);
  if (!p) return <p className="subhead muted">Not found.</p>;
  const injected = p.snapshot.listingText.includes("[hidden]");
  return (
    <div className="stack">
      <div className="row between"><StatusBadge status={p.status} /><span className="caption muted">{when(p.createdAt)}</span></div>
      <h2 className="title-2">{p.title}</h2>
      <div className="row between subhead"><span className="muted">{p.order.quantity} × {money(p.order.unitPrice)}</span><Money value={p.total} size="body" /></div>
      <p className="footnote muted">{attrsText(p.order.attributes)}</p>

      {p.status === "blocked" && <div className="sheet-hero"><Obj kind="shield" size={0.7} /></div>}

      {p.why && <div className="quote"><strong>Why did you buy this?</strong><p className="subhead">{p.why}</p></div>}

      {p.decision.violations.length > 0 && (
        <div className={`card callout ${p.status === "blocked" ? "danger" : "warn"}`}>
          <strong className="headline">{p.status === "blocked" ? "The guard stopped this order" : "Needs your approval"}</strong>
          {p.decision.violations.map((v, i) => <p key={i} className="subhead row" style={{ alignItems: "flex-start" }}><Icon name="hand" size={16} />{v.detail}</p>)}
          {p.status === "blocked" && injected && (
            <p className="footnote">The page contained hidden instructions aimed at shopping agents. Your agent was fooled, but your rules held.</p>
          )}
        </div>
      )}

      {p.error && <p className="footnote danger-text">{p.error}</p>}
      {p.dispute && <VerdictCard p={p} act={act} />}

      <button className="link-row" onClick={() => openEvidence(p.id)}>
        <Icon name="box" size={18} /><span className="grow">Open the flight record in Black Box</span><Icon name="chevronRight" size={16} />
      </button>
      {p.paypal && <p className="mono muted">PayPal order {p.paypal.orderId}{p.paypal.captureId ? ` · capture ${p.paypal.captureId}` : ""}</p>}

      {p.status === "needs_approval" && <button className="btn primary block" onClick={() => act(() => api(`/api/purchases/${p.id}/approve`, {}), "Approved")}>Approve this merchant &amp; buy</button>}
      {p.status === "completed" && <button className="btn danger block" onClick={() => setSheet({ kind: "wrong", id: p.id })}>Something's wrong</button>}
    </div>
  );
}

const STEPS = ["Reading your photo", "Asking the merchant's agent", "Replaying the flight record", "Settling with PayPal"];

function ReportWrong({ state, id, refresh, show, setSheet }: { state: AppState; id: string; refresh: () => void; show: (t: string, e?: boolean) => void; setSheet: (s: SheetState) => void }) {
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
      <div className="blackbox-moment">
        <Obj kind="box" size={0.85} />
        <h2 className="title-2">Black Box is on it</h2>
        <ul className="steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "active" : ""}>
              <span className="step-dot">{i < step ? <Icon name="check" size={14} stroke={3} /> : i === step ? <span className="spinner" /> : i + 1}</span>{s}
            </li>
          ))}
        </ul>
        <div className="progress"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
      </div>
    );
  }

  return (
    <div className="stack">
      <h2 className="title-2">What's wrong?</h2>
      <p className="subhead muted">Snap the label on the box. The Black Box compares it with what you asked for, what your agent claimed and what the page said.</p>
      <label className="viewfinder">
        {photo ? <img src={photo} alt="Your photo of the label" /> : <span className="frame"><Icon name="camera" size={28} /><span className="footnote">Take a photo of the label</span></span>}
        <input type="file" accept="image/*" capture="environment" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPhoto(await fileToDataUrl(f)); }} />
      </label>
      {photo ? (
        <button className="btn ghost sm" onClick={() => setPhoto(null)}>Use a demo photo instead</button>
      ) : (
        <>
          <span className="footnote muted">Or use a demo photo:</span>
          <div className="chips">
            {state.photoPresets.map((k) => <button key={k} className={`chip btnlike ${preset === k ? "on" : ""}`} onClick={() => setPreset(k)}>{PRESET_LABEL[k] ?? k}</button>)}
          </div>
        </>
      )}
      <textarea className="input textarea" placeholder="Tell us in a sentence (optional), e.g. “I meant trail shoes”" value={complaint} onChange={(e) => setComplaint(e.target.value)} />
      <button className="btn danger block" onClick={submit}>Send to Black Box</button>
    </div>
  );
}

function defaultPreset(p?: Purchase) {
  if (!p) return "label-us11";
  if (p.productId === "ultraboost-5") return "label-adidas-us11";
  return "label-us11";
}
