import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  api, attrsText, fileToDataUrl, money, PRESET_LABEL, useAppState, useToast, when,
  type AppState, type FindResult, type Purchase,
} from "../api";
import { BrandLockup } from "../components/Brand";
import { Icon, type IconName } from "../components/Icon";
import { FeedItem, MandateChips, StatusBadge, VerdictCard, type Act } from "../components/purchase";
import { Money, Obj, Segmented, Sheet, Switch, Toast, useTheme } from "../components/ui";
import { BlackBox, EvidenceSheet } from "./Console";
import AgentPage from "./AgentPage";
import { AgentOrb, agentStatus, activeMandate, pendingFor, unreadFor } from "../components/agent";
import { JobSheet, MoveMoney, NewAgent } from "../components/agentSheets";
import { LockScreen, SignButton, SignerProvider } from "../components/lock";

const UNLOCK_KEY = "pocket.unlocked";
const readUnlocked = () => { try { return sessionStorage.getItem(UNLOCK_KEY) === "1"; } catch { return false; } };

type Tab = "home" | "agent" | "activity" | "blackbox";
export type SheetState =
  | { kind: "agent" }
  | { kind: "job"; id: string }
  | { kind: "move"; id: string }
  | { kind: "purchase"; id: string }
  | { kind: "wrong"; id: string }
  | { kind: "evidence"; id: string }
  | { kind: "found"; id: string; result: FindResult }
  | null;

const TABS: { tab: Tab; path: string; label: string; icon: IconName }[] = [
  { tab: "home", path: "/", label: "Agents", icon: "home" },
  { tab: "activity", path: "/activity", label: "Activity", icon: "activity" },
  { tab: "blackbox", path: "/console", label: "Black Box", icon: "box" },
];

const tabFromPath = (p: string): Tab => (p.startsWith("/console") ? "blackbox" : p.startsWith("/agents/") ? "agent" : p.startsWith("/activity") ? "activity" : "home");

export default function PocketApp() {
  const { state, refresh, error } = useAppState();
  const { toast, show } = useToast();
  const { dark, toggle } = useTheme();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const tab = tabFromPath(pathname);
  const agentId = tab === "agent" ? decodeURIComponent(pathname.split("/")[2] ?? "") : "";
  const openAgent = (id: string) => navigate(`/agents/${id}`);
  const [sheet, setSheet] = useState<SheetState>(null);
  const close = useCallback(() => setSheet(null), []);

  // App lock: PIN pad on open (create a PIN the first time). Stays unlocked for this tab session.
  const [lock, setLock] = useState<"checking" | "setup" | "unlock" | "open">(readUnlocked() ? "open" : "checking");
  useEffect(() => {
    if (lock !== "checking") return;
    api<{ hasPin: boolean }>("/api/auth/status").then((s) => setLock(s.hasPin ? "unlock" : "setup")).catch(() => setLock("unlock"));
  }, [lock]);
  const unlocked = () => {
    try { sessionStorage.setItem(UNLOCK_KEY, "1"); } catch { /* private mode: unlock for this view only */ }
    setLock("open");
  };

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
  // (An agent's chat scrolls itself to the latest message instead.)
  useEffect(() => { if (tab !== "agent") document.querySelector(".screen")?.scrollTo({ top: 0 }); }, [tab]);

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
      <div className={`device ${state?.killSwitch ? "paused" : ""} ${tab === "agent" ? "in-agent" : ""}`}>
        {(lock === "setup" || lock === "unlock") && <LockScreen mode={lock} onDone={unlocked} />}
        {lock === "checking" && <div className="lock" />}
        <SignerProvider>
        <header className="brandbar">
          <BrandLockup product={tab === "blackbox" ? "Black Box" : "Pocket"} />
          <div className="row" style={{ gap: 8 }}>
            {state && tab !== "home" && (
              <div className={`kill-pill ${state.killSwitch ? "paused" : ""}`}>
                <span>{state.killSwitch ? "All paused" : "Agents on"}</span>
                <Switch on={!state.killSwitch} onChange={toggleKill} label="Agents can spend" />
              </div>
            )}
            <button className="icon-btn on-chrome" aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>
              <Icon name={dark ? "sun" : "moon"} size={18} />
            </button>
          </div>
        </header>

        <main className={`screen ${tab === "agent" ? "agent-screen" : ""}`}>
          {!state ? (
            <div className="card empty">
              {error ? <><Icon name="alert" size={22} /><p className="subhead">Can't reach the server.</p><p className="footnote muted">{error}</p></> : <><span className="spinner" /><p className="subhead muted">Loading your pocket…</p></>}
            </div>
          ) : (
            <>
              {tab === "home" && <Home state={state} act={act} setSheet={setSheet} toggleKill={toggleKill} goActivity={() => navigate("/activity")} openAgent={openAgent} />}
              {tab === "agent" && <AgentPage state={state} agentId={agentId} act={act} refresh={refresh} show={show} setSheet={setSheet} back={() => navigate("/")} />}
              {tab === "activity" && <Activity state={state} setSheet={setSheet} />}
              {tab === "blackbox" && <BlackBox state={state} show={show} openEvidence={(id) => setSheet({ kind: "evidence", id })} />}
            </>
          )}
        </main>

        {tab !== "agent" && <nav className="tabbar glass" aria-label="Main" style={{ gridTemplateColumns: `repeat(${TABS.length}, 1fr)` }}>
          {TABS.map((t) => (
            <button key={t.tab} className={tab === t.tab ? "on" : ""} aria-current={tab === t.tab ? "page" : undefined} onClick={() => navigate(t.path)}>
              <span className="tab-ico">
                <Icon name={t.icon} size={22} />
                {t.tab === "activity" && pending > 0 && <span className="dot-badge">{pending}</span>}
              </span>
              {t.label}
            </button>
          ))}
        </nav>}

        {state && sheet && (
          <Sheet onClose={close} key={sheet.kind + ("id" in sheet ? sheet.id : "")}>
            {sheet.kind === "agent" && <NewAgent state={state} act={act} close={close} open={openAgent} />}
            {sheet.kind === "job" && <JobSheet state={state} agentId={sheet.id} act={act} close={close} />}
            {sheet.kind === "move" && <MoveMoney state={state} agentId={sheet.id} act={act} close={close} />}
            {sheet.kind === "purchase" && <PurchaseDetail state={state} id={sheet.id} act={act} setSheet={setSheet} openEvidence={openEvidence} />}
            {sheet.kind === "wrong" && <ReportWrong state={state} id={sheet.id} refresh={refresh} show={show} setSheet={setSheet} />}
            {sheet.kind === "evidence" && <EvidenceSheet state={state} id={sheet.id} />}
            {sheet.kind === "found" && <FoundSheet state={state} result={sheet.result} setSheet={setSheet} />}
          </Sheet>
        )}
        <Toast toast={toast} />
        </SignerProvider>
      </div>
    </div>
  );
}

/* ====================================== Home ====================================== */

function Home({ state, act, setSheet, toggleKill, goActivity, openAgent }: { state: AppState; act: Act; setSheet: (s: SheetState) => void; toggleKill: () => void; goActivity: () => void; openAgent: (id: string) => void }) {
  const total = state.pockets.reduce((s, p) => s + p.balance, 0);
  const connect = () => act(async () => {
    const { approveUrl } = await api<{ approveUrl: string }>("/api/paypal/connect", {});
    location.href = approveUrl;
  });

  return (
    <>
      <section className="hero">
        <p className="footnote muted">Fenced off across {state.pockets.length} agent{state.pockets.length === 1 ? "" : "s"}</p>
        <Money value={total} />
        <div className="chips">
          <span className={`badge ${state.vault ? "ok" : "neutral"}`}><span className="dot" />{state.vault ? "PayPal connected" : "PayPal not connected"}</span>
          <span className={`badge ${state.ai.enabled ? "blue" : "neutral"}`}><Icon name="sparkles" size={13} />{state.ai.enabled ? state.ai.model : "AI off · rules only"}</span>
        </div>
      </section>

      <div className={`kill-row glass ${state.killSwitch ? "paused" : ""}`}>
        <div className="grow">
          <div className="headline">{state.killSwitch ? "All agents paused" : "Agents can spend"}</div>
          <div className="footnote muted">{state.killSwitch ? "Nothing can be bought until you turn it back on" : "Kill switch: one tap stops every agent"}</div>
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
        <h2 className="section-title">Your agents</h2>
        <button className="btn sm glass-btn" onClick={() => setSheet({ kind: "agent" })}><Icon name="plus" size={16} />New agent</button>
      </div>
      {state.pockets.length === 0 ? (
        <button className="card empty tappable" onClick={() => setSheet({ kind: "agent" })}>
          <div className="orb-row"><AgentOrb name="P" color="#0070e0" size={40} /><AgentOrb name="S" color="#e5489b" size={40} /><AgentOrb name="G" color="#19a35b" size={40} /></div>
          <p className="subhead">Create your first agent: a name, some money and one job.</p>
          <p className="footnote muted">Each agent only spends its own money, by rules you sign. The rest of your PayPal stays out of reach.</p>
        </button>
      ) : (
        <div className="agent-grid">
          {state.pockets.map((p) => {
            const st = agentStatus(state, p);
            const job = activeMandate(state, p.id)?.mandate.item;
            const unread = unreadFor(state, p);
            const waiting = pendingFor(state, p.id) > 0;
            return (
              <button key={p.id} className={`agent-tile rise ${p.paused ? "is-paused" : ""}`} style={{ "--orb": p.color } as React.CSSProperties} onClick={() => openAgent(p.id)}>
                <div className="row between" style={{ alignItems: "flex-start" }}>
                  <AgentOrb name={p.name} color={p.color} size={44} pulse={waiting} paused={p.paused} />
                  {unread > 0 && <span className="dot-badge static">{unread}</span>}
                </div>
                <strong className="headline ellipsis">{p.name}</strong>
                <span className="footnote muted clamp-2 capitalize">{job ?? "Needs a job"}</span>
                <Money value={p.balance} size="body" />
                <span className={`badge ${st.tone}`}><span className="dot" />{st.text}</span>
              </button>
            );
          })}
          <button className="agent-tile add" onClick={() => setSheet({ kind: "agent" })}>
            <span className="add-orb"><Icon name="plus" size={22} /></span>
            <strong className="headline">New agent</strong>
            <span className="footnote muted">Name, money, one job</span>
          </button>
        </div>
      )}

      <div className="section-head">
        <h2 className="section-title">Latest</h2>
        {state.purchases.length > 0 && <button className="btn sm ghost" onClick={goActivity}>See all</button>}
      </div>
      {state.purchases.length === 0 ? (
        <div className="card empty"><p className="subhead muted">Nothing yet. Give an agent a job, and it buys when it's allowed to.</p></div>
      ) : (
        <div className="stack">{state.purchases.slice(0, 3).map((p) => <FeedItem key={p.id} p={p} onOpen={() => setSheet({ kind: "purchase", id: p.id })} />)}</div>
      )}
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

      {p.status === "needs_approval" && (
        <SignButton title={`Buy for ${money(p.total)}`} detail={p.title} onSigned={(auth) => act(() => api(`/api/purchases/${p.id}/approve`, { auth }), "Approved")}>Sign &amp; buy</SignButton>
      )}
      {p.status === "completed" && <button className="btn danger block" onClick={() => setSheet({ kind: "wrong", id: p.id })}>Something's wrong</button>}
    </div>
  );
}

/** Real listings the agent looked at, why each did or didn't fit, and what happened next. */
function FoundSheet({ state, result, setSheet }: { state: AppState; result: FindResult; setSheet: (s: SheetState) => void }) {
  const fits = result.found.filter((f) => f.reasons.length === 0).length;
  const p = result.purchase ? state.purchases.find((x) => x.id === result.purchase!.id) ?? result.purchase : undefined;
  return (
    <div className="stack">
      <h2 className="title-2">Real stores, checked</h2>
      <p className="subhead muted">
        Your agent searched {result.found.length} real listings via Channel3. {fits} {fits === 1 ? "proves it matches" : "prove they match"} your rules; plain code checked every one.
      </p>
      {p ? (
        <button className="card tappable stack-sm" style={{ textAlign: "left" }} onClick={() => setSheet({ kind: "purchase", id: p.id })}>
          <div className="row between"><StatusBadge status={p.status} /><Money value={p.total} size="body" /></div>
          <strong className="headline">{p.title}</strong>
          <span className="footnote muted">Paid with test money (PayPal sandbox) at Stride Supply checkout. Tap for details.</span>
        </button>
      ) : (
        result.skipped && <div className="card callout warn"><p className="subhead">{result.skipped}</p></div>
      )}
      <ul className="found-list">
        {result.found.map(({ product: x, reasons }) => {
          const chosen = p?.productId === x.id;
          return (
            <li key={x.id} className={`found-item ${reasons.length ? "no" : "ok"} ${chosen ? "chosen" : ""}`}>
              {x.imageUrl ? <img src={x.imageUrl} alt="" loading="lazy" /> : <div className="found-ph" />}
              <div className="grow stack-xs">
                <div className="row between" style={{ alignItems: "flex-start", gap: 8 }}>
                  <strong className="footnote">{x.title}</strong>
                  <strong className="footnote">{money(x.unitPrice)}</strong>
                </div>
                <span className="caption muted">{x.attributes.brand ?? "Unknown brand"} · {x.source?.domain}</span>
                {reasons.length === 0
                  ? <span className="caption ok-text">{chosen ? "✓ Fits your rules · chosen" : "✓ Fits your rules"}</span>
                  : <span className="caption danger-text">✕ {reasons.join(" · ")}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="caption muted">Real products and prices from Channel3. Payment is PayPal sandbox (test money), so nothing is really shipped.</p>
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
