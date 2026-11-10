import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  api, attrsText, fileToDataUrl, money, PRESET_LABEL, savedThisMonth, useAppState, useToast, when,
  type AgentPrefill, type AppState, type FindResult, type Purchase, type WantResult,
} from "../api";
import { KnowsPage, LookCard, NoticedCard, SharePage, WantSheet, useSnap } from "../components/intel";
import { BrandLockup, Mark } from "../components/Brand";
import { Icon, type IconName } from "../components/Icon";
import { FeedItem, MandateChips, Receipt, StatusBadge, VerdictCard, purchaseApproval, approvePurchaseOrThrow, type Act } from "../components/purchase";
import { Money, Segmented, Sheet, Toast } from "../components/ui";
import { BlackBox, EvidenceSheet } from "./Console";
import AgentPage, { AgentDetails } from "./AgentPage";
import { SPRING, reducedMotion, launch, land, flyFrom } from "../motion";
import { usePullToRefresh, useUpdateCheck, useViewportGuard } from "../standalone";
import { AgentCardFace, AgentIcon, BudgetBar, activeMandate, amount, budgetOf, cardStats, pendingFor, toneOf, unreadFor } from "../components/agent";
import { AgentMenu, CloseAgent, DeleteAgent, JobSheet, MoveMoney, NewAgent, RenameAgent } from "../components/agentSheets";
import { LockScreen, SignButton, SignerProvider } from "../components/lock";
import { AccountScreen } from "../components/account";
import { AccountButton, AccountSheet } from "../components/accountSheet";
import { AgentsStatus, PauseSheet, PausedBanner, type SetKill } from "../components/pause";
import type { Signature } from "../components/lock";

const UNLOCK_KEY = "pocket.unlocked";
const readUnlocked = () => { try { return sessionStorage.getItem(UNLOCK_KEY) === "1"; } catch { return false; } };

type Tab = "home" | "agents" | "agent" | "activity" | "blackbox" | "knows" | "share";
export type SheetState =
  | { kind: "agent"; prefill?: AgentPrefill }
  | { kind: "want"; result: WantResult; photo?: string }
  | { kind: "job"; id: string }
  | { kind: "move"; id: string }
  | { kind: "rename"; id: string }
  | { kind: "menu"; id: string }
  | { kind: "details"; id: string }
  | { kind: "close"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "purchase"; id: string }
  | { kind: "wrong"; id: string }
  | { kind: "evidence"; id: string }
  | { kind: "account" }
  | { kind: "pause" }
  | { kind: "found"; id: string; result: FindResult }
  | null;

const TABS: { tab: Tab; path: string; label: string; icon: IconName }[] = [
  { tab: "home", path: "/", label: "Home", icon: "home" },
  { tab: "agents", path: "/agents", label: "Agents", icon: "wallet" },
  { tab: "activity", path: "/activity", label: "Activity", icon: "activity" },
];

const TAB_TITLE: Record<Tab, string> = { home: "Pocket", agents: "Agents", agent: "", activity: "Activity", blackbox: "Black Box", knows: "What Pocket knows", share: "Pocket" };

const tabFromPath = (p: string): Tab =>
  p.startsWith("/knows") ? "knows" : p.startsWith("/share") ? "share" :
  p.startsWith("/console") ? "blackbox" : /^\/agents\/?$/.test(p) ? "agents" : p.startsWith("/agents/") ? "agent" : p.startsWith("/activity") ? "activity" : "home";

/**
 * The Agents screen as a layer pushed over Home (fintech/iOS style): it slides in from the right with a shadow on
 * its leading edge, while Home shifts 30% left and dims underneath. Back reverses it; dragging from the left edge
 * follows the finger and snaps with velocity. Only transform and opacity move, so it stays smooth.
 */
function AgentsLayer({ under, animateIn, onBack, onScroll, children }: {
  under: React.RefObject<HTMLElement>; animateIn: boolean; onBack: () => void; onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  children: (goBack: () => void) => React.ReactNode;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const dim = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; dx: number; lastX: number; lastT: number; v: number } | null>(null);
  const leaving = useRef(false);

  const settle = (el: HTMLElement | null) => { el?.getAnimations().forEach((a) => { try { a.commitStyles(); } catch { /* detached */ } a.cancel(); }); };
  const place = (dx: number) => {
    const L = layer.current, U = under.current, D = dim.current;
    if (!L || !U || !D) return;
    const p = Math.min(1, Math.max(0, dx / L.offsetWidth));
    L.style.transform = `translate3d(${dx}px,0,0)`;
    U.style.transform = `translate3d(${-30 + 30 * p}%,0,0)`;
    D.style.opacity = String(1 - p);
  };

  useLayoutEffect(() => {
    const L = layer.current, U = under.current, D = dim.current;
    if (!L || !U || !D) return;
    if (!animateIn || reducedMotion()) {
      U.style.transform = "translate3d(-30%,0,0)"; D.style.opacity = "1";
    } else {
      const { easing, duration } = SPRING;
      L.animate([{ transform: "translate3d(100%,0,0)" }, { transform: "translate3d(0,0,0)" }], { duration, easing });
      U.animate([{ transform: "translate3d(0,0,0)" }, { transform: "translate3d(-30%,0,0)" }], { duration, easing, fill: "forwards" });
      D.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.8, easing: "ease-out", fill: "forwards" });
      // The cards arrive as a loose cascade that closes up: compositor-only, a few ms apart.
      [...L.querySelectorAll<HTMLElement>(".agent-card")].slice(0, 5).forEach((card, i) => {
        card.animate([{ transform: `translate3d(${48 + i * 34}px, ${-i * 40}px, 0)` }, { transform: "translate3d(0,0,0)" }],
          { duration: duration + i * 60, easing, delay: 40 + i * 45, fill: "backwards" });
      });
    }
    return () => { settle(U); if (U) U.style.transform = ""; };
  }, []);

  const animateTo = (open: boolean) => {
    const L = layer.current, U = under.current, D = dim.current;
    if (!L || !U || !D) return;
    [L, U, D].forEach(settle);
    const { easing, duration } = SPRING;
    const opts = { duration: open ? duration : Math.round(duration * 0.85), easing, fill: "forwards" as const };
    L.animate([{ transform: L.style.transform || "translate3d(0,0,0)" }, { transform: open ? "translate3d(0,0,0)" : "translate3d(100%,0,0)" }], opts);
    U.animate([{ transform: U.style.transform || "translate3d(-30%,0,0)" }, { transform: open ? "translate3d(-30%,0,0)" : "translate3d(0,0,0)" }], opts);
    const fade = D.animate([{ opacity: D.style.opacity || "1" }, { opacity: open ? 1 : 0 }], { ...opts, easing: "ease-out" });
    if (!open) { leaving.current = true; fade.finished.then(onBack).catch(onBack); }
  };
  const goBack = () => {
    if (leaving.current) return;
    if (reducedMotion()) { onBack(); return; }
    animateTo(false);
  };

  // Edge swipe: start within 24px of the left edge, follow the finger, snap by distance or speed.
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    const L = layer.current;
    if (!L || leaving.current || e.clientX - L.getBoundingClientRect().left > 24) return;
    [L, under.current, dim.current].forEach((el) => settle(el));
    drag.current = { x0: e.clientX, dx: 0, lastX: e.clientX, lastT: e.timeStamp, v: 0 };
    L.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d) return;
    d.dx = Math.max(0, e.clientX - d.x0);
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientX - d.lastX) / dt;
    d.lastX = e.clientX; d.lastT = e.timeStamp;
    place(d.dx);
  };
  const up = () => {
    const d = drag.current; drag.current = null;
    if (!d || !layer.current) return;
    if (d.dx === 0) return;
    animateTo(!(d.dx / layer.current.offsetWidth > 0.35 || d.v > 0.5));
  };

  return (
    <>
      <div className="push-dim" ref={dim} aria-hidden="true" />
      <div className="screen home-screen push-layer" ref={layer} onScroll={onScroll}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {children(goBack)}
      </div>
    </>
  );
}

export default function PocketApp() {
  const { state, refresh, error } = useAppState();
  const { toast, show } = useToast();
  const { pathname, search, state: locState } = useLocation();
  const navigate = useNavigate();
  const tab = tabFromPath(pathname);
  // Black Box opens from Activity (and your account), so Activity stays lit while you are in it.
  const navTab: Tab = tab === "blackbox" ? "activity" : tab === "knows" ? "home" : tab;
  const agentId = tab === "agent" ? decodeURIComponent(pathname.split("/")[2] ?? "") : "";
  const openAgent = (id: string, view?: "chat") => navigate(`/agents/${id}${view ? `?view=${view}` : ""}`);
  // Home → Agents: the Agents screen is pushed over Home (see AgentsLayer).
  const goAgents = () => navigate("/agents", { state: { push: true } });
  const mainRef = useRef<HTMLElement>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const close = useCallback(() => setSheet(null), []);
  // Intelligence: start an agent from a suggestion, a photo or a shared link.
  const makeAgent = useCallback((prefill: AgentPrefill) => setSheet({ kind: "agent", prefill }), []);
  const snap = useSnap((result, photo) => setSheet({ kind: "want", result, photo }), (t, e) => show(t, e));
  const onShared = useCallback((result: WantResult) => setSheet({ kind: "want", result }), []);
  const shareDone = useCallback(() => navigate("/", { replace: true }), [navigate]);

  // Account first (email + password), then the PIN pad. Without a database there is one local user and no sign-in.
  const [account, setAccount] = useState<{ status: "checking" | "signin" | "ok"; email?: string | null; mode?: string }>({ status: "checking" });
  useEffect(() => {
    api<{ mode: string; user: { email: string | null } | null }>("/api/account/me")
      .then((r) => setAccount(r.user ? { status: "ok", email: r.user.email, mode: r.mode } : { status: "signin", mode: r.mode }))
      .catch(() => setAccount({ status: "ok" }));
    const onSignin = () => {
      try { sessionStorage.removeItem(UNLOCK_KEY); } catch { /* storage blocked */ }
      setAccount((a) => ({ ...a, status: "signin" }));
      setLock("checking");
    };
    window.addEventListener("pocket:signin", onSignin);
    return () => window.removeEventListener("pocket:signin", onSignin);
  }, []);

  // App lock: PIN pad on open (create a PIN the first time). Stays unlocked for this tab session.
  const [lock, setLock] = useState<"checking" | "setup" | "unlock" | "open">(readUnlocked() ? "open" : "checking");
  useEffect(() => {
    if (lock !== "checking" || account.status !== "ok") return;
    api<{ hasPin: boolean }>("/api/auth/status").then((s) => setLock(s.hasPin ? "unlock" : "setup")).catch(() => setLock("unlock"));
  }, [lock, account.status]);
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

  // Every new page starts at the top. (An agent's chat scrolls itself to the latest message.)
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!pathname.startsWith("/agents/")) document.querySelector(".screen")?.scrollTo({ top: 0 });
    setScrolled(false);
  }, [pathname]);

  const act: Act = async (fn, ok, opts) => {
    try {
      await fn();
      if (ok) show(ok);
      return true;
    } catch (e) {
      if (opts?.rethrow) throw e;
      show((e as Error).message, true);
      return false;
    } finally {
      refresh();
    }
  };

  // Pause is instant (it only makes things safer). Resume gives spending power back, so callers pass a signature
  // (PIN / fingerprint / Face ID). Re-pausing right after a resume is offered from the toast.
  const setKill: SetKill = async (on: boolean, auth?: Signature) => {
    try {
      await api("/api/killswitch", auth ? { on, auth } : { on });
      navigator.vibrate?.(on ? [18, 40, 18] : 12);
      if (on) show("All agents paused. Nothing will be bought.");
      else show("Agents resumed.", false, { label: "Pause again", run: () => setKill(true) });
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      refresh();
    }
  };

  const openEvidence = (id: string) => { setSheet({ kind: "evidence", id }); navigate("/console"); };

  const pending = state?.purchases.filter((p) => p.status === "needs_approval").length ?? 0;

  // Installed app: the page can't be shifted off screen by the keyboard, pull down to refresh, and a reload offer
  // when a newer version is deployed.
  useViewportGuard();
  const canPull = !!state && !sheet && (tab === "home" || tab === "agents" || tab === "activity" || tab === "blackbox" || tab === "knows");
  const pullRef = usePullToRefresh(
    () => (tab === "agents" ? document.querySelector<HTMLElement>(".push-layer") : mainRef.current),
    refresh, canPull, tab,
  );
  useUpdateCheck(useCallback(() => show("A new version of Pocket is ready.", false, { label: "Reload", run: () => location.reload() }), [show]));

  return (
    <div className="stage">
      <div className={`device ${state?.killSwitch ? "paused" : ""} ${tab === "agent" ? "in-agent" : ""} ${sheet ? "sheet-open" : ""}`}>
        {account.status === "signin" && (
          <AccountScreen onDone={(u) => {
            try { sessionStorage.removeItem(UNLOCK_KEY); } catch { /* storage blocked */ }
            setLock("checking");
            setAccount({ status: "ok", email: u.email, mode: "accounts" });
            refresh();
            if (u.imported) show("Your existing agents and Black Box were moved into this account.");
          }} />
        )}
        {account.status === "ok" && (lock === "setup" || lock === "unlock") && <LockScreen mode={lock} onDone={unlocked} />}
        {(account.status === "checking" || (account.status === "ok" && lock === "checking")) && <div className="lock splash"><span className="lock-mark"><Mark size={44} /></span></div>}
        <SignerProvider>
        <div className="ptr" ref={pullRef} aria-hidden="true"><span className="ptr-ring" /></div>
        {/* Compact bar: appears once the page scrolls. The full logo scrolls away with Home's content. */}
        {tab !== "agent" && (
          <div className={`topbar ${scrolled ? "on" : ""}`} aria-hidden={!scrolled}>
            <Mark size={20} />{TAB_TITLE[tab]}
          </div>
        )}

        <main
          ref={mainRef}
          className={`screen ${tab === "agent" ? "agent-screen" : ""} ${tab === "home" || tab === "agents" ? "home-screen" : ""}`}
          onScroll={(e) => { const s = e.currentTarget.scrollTop > 56; if (s !== scrolled) setScrolled(s); }}
        >
          {!state ? (
            <div className="card empty">
              {error ? <><Icon name="alert" size={22} /><p className="subhead">Can't reach the server.</p><p className="footnote muted">{error}</p></> : <><span className="spinner" /><p className="subhead muted">Loading your pocket…</p></>}
            </div>
          ) : (
            <>
              {/* Home stays mounted under the Agents layer, so going back is instant and the slide can reveal it. */}
              {(tab === "home" || tab === "agents") && <Home state={state} act={act} setSheet={setSheet} setKill={setKill} goActivity={(f) => navigate(f ? `/activity?f=${f}` : "/activity")} openAgent={openAgent} goAgents={goAgents} goBlackBox={() => navigate("/console")} makeAgent={makeAgent} openKnows={() => navigate("/knows")} snap={snap.open} accountEmail={account.mode === "accounts" ? account.email : null} openAccount={() => setSheet({ kind: "account" })} />}
              {tab === "knows" && <KnowsPage back={() => navigate("/")} onUse={makeAgent} onSnap={snap.open} show={show} />}
              {tab === "share" && <SharePage onResult={onShared} show={show} done={shareDone} />}
              {tab === "agent" && <AgentPage state={state} agentId={agentId} act={act} refresh={refresh} show={show} setSheet={setSheet} back={() => navigate("/agents")} />}
              {tab === "activity" && <Activity key={search} initial={(new URLSearchParams(search).get("f") as Filter) ?? "all"} state={state} setSheet={setSheet} openBlackBox={() => navigate("/console")} />}
              {tab === "blackbox" && (
                <>
                  {/* Black Box is a page you open (from Activity or your account), not a tab: Back returns you to where you were. */}
                  <div className="page-back">
                    <button className="glass-circle" aria-label="Back" onClick={() => ((window.history.state as { idx?: number } | null)?.idx ? navigate(-1) : navigate("/activity"))}><Icon name="chevronLeft" size={22} /></button>
                  </div>
                  <BlackBox state={state} show={show} openEvidence={(id) => setSheet({ kind: "evidence", id })} />
                </>
              )}
            </>
          )}
        </main>

        {tab === "agents" && state && (
          <AgentsLayer under={mainRef} animateIn={!!(locState as { push?: boolean } | null)?.push} onBack={() => navigate("/")}
            onScroll={(e) => { const sc = e.currentTarget.scrollTop > 56; if (sc !== scrolled) setScrolled(sc); }}>
            {(goBack) => <AgentsTab state={state} setSheet={setSheet} openAgent={openAgent} show={show} refresh={refresh} back={goBack} setKill={setKill} />}
          </AgentsLayer>
        )}

        {tab !== "agent" && <nav className="tabbar glass" aria-label="Main" style={{ gridTemplateColumns: `repeat(${TABS.length}, 1fr)` }}>
          {TABS.map((t) => (
            <button key={t.tab} className={navTab === t.tab ? "on" : ""} aria-current={navTab === t.tab ? "page" : undefined} onClick={() => (t.tab === "agents" ? goAgents() : navigate(t.path))}>
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
            {sheet.kind === "agent" && <NewAgent state={state} act={act} close={close} open={openAgent} prefill={sheet.prefill} />}
            {sheet.kind === "want" && <WantSheet result={sheet.result} photo={sheet.photo} onMake={makeAgent} />}
            {sheet.kind === "job" && <JobSheet state={state} agentId={sheet.id} act={act} close={close} />}
            {sheet.kind === "move" && <MoveMoney state={state} agentId={sheet.id} act={act} close={close} />}
            {sheet.kind === "rename" && <RenameAgent state={state} agentId={sheet.id} close={close} show={show} refresh={refresh} />}
            {sheet.kind === "details" && <AgentDetails state={state} agentId={sheet.id} act={act} setSheet={setSheet} show={show} refresh={refresh} />}
            {sheet.kind === "menu" && <AgentMenu state={state} agentId={sheet.id} setSheet={setSheet} show={show} refresh={refresh} />}
            {sheet.kind === "close" && <CloseAgent state={state} agentId={sheet.id} close={close} show={show} refresh={refresh} />}
            {sheet.kind === "delete" && <DeleteAgent state={state} agentId={sheet.id} close={close} show={show} refresh={refresh} after={() => { if (tab === "agent") navigate("/agents"); }} />}
            {sheet.kind === "purchase" && <PurchaseDetail state={state} id={sheet.id} act={act} setSheet={setSheet} openEvidence={openEvidence} />}
            {sheet.kind === "wrong" && <ReportWrong state={state} id={sheet.id} refresh={refresh} show={show} setSheet={setSheet} />}
            {sheet.kind === "evidence" && <EvidenceSheet state={state} id={sheet.id} />}
            {sheet.kind === "pause" && <PauseSheet state={state} setKill={setKill} close={close} />}
            {sheet.kind === "account" && <AccountSheet state={state} email={account.mode === "accounts" ? account.email : null} signedIn={account.mode === "accounts" && !!account.email} act={act} setKill={setKill} go={(path) => { close(); navigate(path); }} show={show} />}
            {sheet.kind === "found" && <FoundSheet state={state} result={sheet.result} setSheet={setSheet} />}
          </Sheet>
        )}
        <Toast toast={toast} />
        {snap.el}
        </SignerProvider>
      </div>
    </div>
  );
}

/* ====================================== Home ====================================== */

function Home({ state, act, setSheet, setKill, goActivity, openAgent, goAgents, goBlackBox, makeAgent, openKnows, snap, accountEmail, openAccount }: {
  state: AppState; act: Act; setSheet: (s: SheetState) => void; setKill: SetKill; goActivity: (filter?: string) => void;
  openAgent: (id: string) => void; goAgents: () => void; goBlackBox: () => void;
  makeAgent: (p: AgentPrefill) => void; openKnows: () => void; snap: () => void;
  accountEmail?: string | null; openAccount: () => void;
}) {
  const looks = state.purchases.filter((p) => p.status === "awaiting_look");
  const open = state.pockets.filter((p) => !p.closedAt);
  const total = open.reduce((s, p) => s + p.balance, 0);
  const paused = state.killSwitch;
  const connect = () => act(async () => {
    const { approveUrl } = await api<{ approveUrl: string }>("/api/paypal/connect", {});
    location.href = approveUrl;
  });
  const toApprove = state.purchases.filter((p) => p.status === "needs_approval").length;
  const savedMonth = savedThisMonth(state);
  const suggesting = open.filter((a) => state.proposals.some((x) => x.agentId === a.id && x.status === "pending"));

  // This month: what agents actually spent, against what they may still spend.
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const spentMonth = state.purchases
    .filter((p) => (p.status === "completed" || p.status === "disputed" || p.status === "escalated") && Date.parse(p.createdAt) >= monthStart.getTime())
    .reduce((s, p) => s + p.total, 0);
  // Trust tiles: proof the rules work, and proof you're covered.
  const stopped = state.purchases.filter((p) => p.status === "blocked").length;
  const budgetAll = spentMonth + total;
  const hasWeekly = state.mandates.some((m) => m.mandate.kind === "routine" && open.some((a) => a.id === m.mandate.pocketId));
  const moneyBack = state.purchases.reduce((s, p) => {
    const r = p.dispute?.resolution;
    return s + (r && (r.type === "refund" || r.type === "payout") ? r.amount ?? 0 : 0);
  }, 0);

  return (
    <>
      <section className="hero wallet">
        <span className="hero-watermark" aria-hidden="true"><Mark size={280} /></span>
        <div className="hero-top">
          <BrandLockup height={46} />
          <AccountButton email={accountEmail} onOpen={openAccount} />
        </div>
        {/* No card around the balance: it sits on the brand wash, with the agents' cards peeking in from the right. */}
        <div className={`balance ${paused ? "is-paused" : ""}`}>
          <p className="subhead muted">Total in your pockets</p>
          <Money value={total} />
          <p className="footnote muted balance-meta">
            {open.length ? <AgentsStatus state={state} onOpen={() => setSheet({ kind: "pause" })} /> : "No agents yet"}
            {state.vault && <span className="row" style={{ gap: 4 }}><Icon name="check" size={13} stroke={2.4} className="ok-text" />PayPal connected</span>}
          </p>
          {open.length === 0 && (
            <div className="balance-action">
              <button className="btn sm primary new-agent-btn" onClick={() => setSheet({ kind: "agent" })}><Icon name="plus" size={16} />Create your first agent</button>
            </div>
          )}
          {open.length > 0 && (
            <button className="peek" onClick={goAgents} aria-label={`View all agents (${open.length})`}>
              {open.slice(0, 3).map((a, i, pile) => {
                const item = activeMandate(state, a.id)?.mandate.item;
                return (
                  <span key={a.id} className={`peek-card tone-${toneOf(a, item)}`} style={{ "--i": i } as React.CSSProperties} aria-hidden="true">
                    {i === pile.length - 1 && <Mark size={22} mono />}
                  </span>
                );
              })}
              {open.length > 3 && <span className="peek-more" aria-hidden="true">+{open.length - 3}</span>}
            </button>
          )}
        </div>
      </section>

      {/* Quiet while all is well (the status line above); loud only while paused. */}
      {paused && open.length > 0 && <PausedBanner setKill={setKill} />}

      {toApprove > 0 && (
        <button className="card action-row hero-glass" onClick={() => goActivity("needs")}>
          <span className="action-count" aria-hidden="true">{toApprove}</span>
          <span className="grow stack-xs">
            <strong className="headline">{toApprove} purchase{toApprove === 1 ? "" : "s"} to approve</strong>
            <span className="footnote muted">Nothing is bought until you approve.</span>
          </span>
          <Icon name="chevronRight" size={18} className="muted" />
        </button>
      )}
      {looks.map((p) => (
        <LookCard key={p.id} state={state} p={p} answer={(d) => act(() => api(`/api/purchases/${p.id}/look`, { decision: d }), d === "buy" ? "Buying it now." : "Skipped. Nothing was paid.")} />
      ))}
      {suggesting.map((a) => (
        <button key={a.id} className="card action-row hero-glass" onClick={() => openAgent(a.id)}>
          <AgentIcon name={a.name} item={activeMandate(state, a.id)?.mandate.item} tone={toneOf(a, activeMandate(state, a.id)?.mandate.item)} size={36} />
          <span className="grow stack-xs">
            <strong className="headline">{a.name} suggested a change</strong>
            <span className="footnote muted">Review it before anything changes.</span>
          </span>
          <Icon name="chevronRight" size={18} className="muted" />
        </button>
      ))}

      {!state.vault ? (
        <div className="card connect-card rise">
          <Mark size={40} />
          <div className="stack-sm" style={{ textAlign: "center" }}>
            <h3 className="headline">Connect PayPal</h3>
            <p className="subhead muted">Your agents pay with PayPal, only within the rules you set.</p>
          </div>
          <button className="btn gold block" onClick={connect}>Connect PayPal</button>
        </div>
      ) : open.length > 0 && (
        /* One truthful story: savings lead only when they're real; otherwise what was spent and what's left.
           Savings are only promised where they can happen (a weekly shop measures against your usual prices). */
        <button className="card spend-card hero-glass" onClick={() => goActivity()}
          aria-label={`This month: ${savedMonth !== undefined ? `saved ${money(savedMonth)}, ` : ""}${money(spentMonth)} spent, ${money(total)} left to spend. Open Activity.`}>
          <span className="footnote muted">This month</span>
          {savedMonth !== undefined ? (
            <span className="month-hero">
              <span className="month-label ok-text">Saved</span>
              <Money value={savedMonth} size="title" className="ok-text" />
            </span>
          ) : (
            <span className="month-hero">
              <Money value={spentMonth} size="title" />
              <span className="month-label muted">spent</span>
            </span>
          )}
          <span className="month-bar" aria-hidden="true"><i style={{ transform: `scaleX(${budgetAll > 0 ? Math.min(1, spentMonth / budgetAll) : 0})` }} /></span>
          <span className="month-meta">
            <span>{savedMonth !== undefined ? `${amount(spentMonth)} spent` : `${amount(total)} left to spend`}</span>
            <span className="muted">{savedMonth !== undefined ? `${amount(total)} left` : `of ${amount(budgetAll)}`}</span>
          </span>
          {savedMonth === undefined && hasWeekly && <span className="caption muted">Your weekly shop shows savings after its first order.</span>}
        </button>
      )}

      {(open.length > 0 || state.purchases.length > 0) && (stopped === 0 && moneyBack === 0 ? (
        /* Nothing has gone wrong yet: say so in one calm line instead of two zero tiles. */
        <button className="card trust-line hero-glass" onClick={goBlackBox} aria-label="Nothing risky got through and no disputes. Open Black Box.">
          <Icon name="shield" size={18} className="ok-text" />
          <span className="grow">Nothing risky got through · No disputes</span>
          <Icon name="chevronRight" size={16} className="muted" />
        </button>
      ) : (
        <div className="tiles">
          <button className="tile tile-btn hero-glass" onClick={goBlackBox} aria-label={`Stopped by your rules: ${stopped}. Open Black Box.`}>
            <span className="caption muted row" style={{ gap: 6 }}><Icon name="shield" size={14} />Stopped by rules</span>
            <span className="tile-v num">{stopped}</span>
          </button>
          <button className="tile tile-btn hero-glass" onClick={goBlackBox} aria-label={`Money back: ${money(moneyBack)}. Open Black Box.`}>
            <span className="caption muted row" style={{ gap: 6 }}><Icon name="undo" size={14} />Money back</span>
            <span className={`tile-v num ${moneyBack > 0 ? "ok-text" : ""}`}>{money(moneyBack)}</span>
          </button>
        </div>
      ))}

      <NoticedCard onUse={makeAgent} onOpenKnows={openKnows} onSnap={snap} />

      <p className="trust-note"><Icon name="shield" size={16} />Agents can only spend what's in their own pocket. Your PayPal balance and cards are never shared with them.</p>
    </>
  );
}

/* ====================================== Agents (the wallet) ====================================== */

function AgentsTab({ state, setSheet, openAgent, show, refresh, back, setKill }: {
  state: AppState; setSheet: (s: SheetState) => void; openAgent: (id: string, view?: "chat") => void;
  show: (t: string, e?: boolean, action?: { label: string; run: () => void }) => void; refresh: () => Promise<void> | void;
  /** Slides the Agents layer away, back to Home. */
  back: () => void;
  setKill: SetKill;
}) {
  const open = state.pockets.filter((p) => !p.closedAt);
  const closed = state.pockets.filter((p) => p.closedAt);
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  // Needs you first, then active, then paused.
  const rank = (p: typeof open[number]) => (pendingFor(state, p.id) > 0 ? 0 : p.paused ? 2 : 1);
  const shown = open
    .filter((p) => !q.trim() || `${p.name} ${activeMandate(state, p.id)?.mandate.item ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => rank(a) - rank(b));
  const stackRef = useRef<HTMLDivElement>(null);

  // Tap a card: it lifts, the others drop away, then it flies on to become the agent's header card.
  const lift = (id: string, btn: HTMLElement) => {
    const face = btn.querySelector<HTMLElement>(".agent-face");
    if (!face || reducedMotion()) { openAgent(id); return; }
    const others = [...(stackRef.current?.children ?? [])].filter((el) => el !== btn) as HTMLElement[];
    others.forEach((el, i) => el.animate(
      [{ opacity: 1, transform: "translate3d(0,0,0) scale(1)" }, { opacity: 0, transform: "translate3d(0,56px,0) scale(0.96)" }],
      { duration: 200, delay: i * 18, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }));
    btn.style.zIndex = "4";
    btn.animate([{ transform: "scale(1)" }, { transform: "scale(1.02)" }], { duration: 140, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" });
    setTimeout(() => { launch(id, face.getBoundingClientRect()); openAgent(id); }, 120);
  };

  // Coming back from an agent: its card flies home into its slot; the rest of the wallet rises in around it.
  useLayoutEffect(() => {
    const f = land();
    if (!f || reducedMotion()) return;
    const btn = stackRef.current?.querySelector<HTMLElement>(`[data-agent="${f.id}"]`);
    const face = btn?.querySelector<HTMLElement>(".agent-face");
    if (face) flyFrom(face, f.rect);
    [...(stackRef.current?.children ?? [])].filter((el) => el !== btn).forEach((el, i) => (el as HTMLElement).animate(
      [{ opacity: 0, transform: "translate3d(0,40px,0)" }, { opacity: 1, transform: "translate3d(0,0,0)" }],
      { duration: 420, delay: 80 + i * 35, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" }));
  }, []);

  return (
    <>
      <div className="agents-top">
        <button className="glass-circle" onClick={back} aria-label="Back to Home"><Icon name="chevronLeft" size={22} /></button>
        <h1 className="agents-title">Agents</h1>
        <button className="glass-circle new-agent-btn" onClick={() => setSheet({ kind: "agent" })} aria-label="New agent"><Icon name="plus" size={22} /></button>
      </div>
      {state.killSwitch && open.length > 0 && <PausedBanner setKill={setKill} />}
      {open.length > 6 && <input className="input search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents" aria-label="Search agents" />}

      {open.length === 0 ? (
        <button className="card empty tappable" onClick={() => setSheet({ kind: "agent" })}>
          <span className="add-orb"><Icon name="plus" size={22} /></span>
          <p className="subhead">Create your first agent</p>
          <p className="footnote muted">Give it a budget and one job. It can only spend that budget, within your rules.</p>
        </button>
      ) : (
        // A wallet: gradient cards, overlapping like Apple Wallet when there are several. Tap a card to open it.
        <div ref={stackRef} className={`wallet-stack ${shown.length > 2 ? "overlap" : ""}`}>
          {shown.length === 0 && <p className="subhead muted">No agents match “{q}”.</p>}
          {shown.map((p) => {
            const m = activeMandate(state, p.id)?.mandate;
            const b = budgetOf(state, p);
            const unread = unreadFor(state, p);
            const waiting = pendingFor(state, p.id);
            const off = state.killSwitch || p.paused;
            const ended = m && Date.parse(m.expiresAt) < Date.now();
            const status = waiting ? "Needs you" : off ? "Paused" : ended ? "Job ended" : unread ? `${unread} new` : undefined;
            return (
              <button key={p.id} className="agent-card wallet-item agent-row-main" data-agent={p.id} data-flight onClick={(e) => lift(p.id, e.currentTarget)}
                aria-label={`${p.name}, ${money(b.left)} left of ${money(b.total)}${status ? `, ${status}` : ""}`}>
                <AgentCardFace agent={p} item={m?.item} left={b.left} total={b.total} status={status} {...cardStats(state, p.id)} />
              </button>
            );
          })}
        </div>
      )}

      {closed.length > 0 && (
        <section className="stack-sm">
          <button className="closed-toggle" aria-expanded={showClosed} aria-controls="closed-agents" onClick={() => setShowClosed(!showClosed)}>
            <span className="grow">Closed agents ({closed.length})</span>
            <Icon name="chevronRight" size={18} className={showClosed ? "rot90" : ""} />
          </button>
          {showClosed && (
            <div id="closed-agents" className="stack-sm">
              {closed.map((p) => (
                <div key={p.id} className="card closed-row">
                  <button className="agent-row-main" data-agent={p.id} onClick={() => openAgent(p.id)} aria-label={`${p.name}, closed`}>
                    <span className="row" style={{ gap: 12 }}>
                      <AgentIcon name={p.name} item={activeMandate(state, p.id)?.mandate.item} tone="grey" size={36} paused />
                      <span className="grow stack-xs">
                        <strong className="headline ellipsis">{p.name}</strong>
                        <span className="caption muted">Closed {new Date(p.closedAt!).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                      </span>
                    </span>
                  </button>
                  <button className="icon-btn row-more" aria-label={`More options for ${p.name}`} aria-haspopup="dialog" onClick={() => setSheet({ kind: "menu", id: p.id })}>
                    <Icon name="more" size={22} stroke={3} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <p className="trust-note"><Icon name="shield" size={16} />Each agent can only spend its own budget, within the rules you approved.</p>
    </>
  );
}

/* ====================================== Activity ====================================== */

type Filter = "all" | "needs" | "blocked" | "disputes";

function Activity({ state, setSheet, initial, openBlackBox }: { state: AppState; setSheet: (s: SheetState) => void; initial: Filter; openBlackBox: () => void }) {
  const [filter, setFilter] = useState<Filter>(["all", "needs", "blocked", "disputes"].includes(initial) ? initial : "all");
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
      <p className="subhead muted">Every purchase your agents made or tried to make.</p>
      {/* The proof behind this list lives one tap away, not in its own tab. */}
      <button className="card bb-entry" onClick={openBlackBox}>
        <span className="bb-entry-ico" aria-hidden="true"><Icon name="box" size={20} /></span>
        <span className="grow stack-xs">
          <strong className="headline">Black Box</strong>
          <span className="footnote muted">A tamper-proof record of every decision your agents made.</span>
        </span>
        <Icon name="chevronRight" size={18} className="muted" />
      </button>
      <Segmented<Filter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All" },
          { value: "needs", label: `To approve${counts.needs ? ` ${counts.needs}` : ""}` },
          { value: "blocked", label: `Stopped${counts.blocked ? ` ${counts.blocked}` : ""}` },
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
      <Receipt state={state} p={p} />

      {p.why && <div className="quote"><strong>Agent's reason</strong><p className="subhead">{p.why}</p></div>}

      {p.decision.violations.length > 0 && (
        <div className={`card callout ${p.status === "blocked" ? "danger" : "warn"}`}>
          <strong className="headline">{p.status === "blocked" ? "Order stopped" : "Needs your approval"}</strong>
          {p.decision.violations.map((v, i) => <p key={i} className="subhead row" style={{ alignItems: "flex-start" }}><Icon name="hand" size={16} />{v.detail}</p>)}
          {p.status === "blocked" && injected && (
            <p className="footnote">The product page had hidden text telling agents to buy it. Your rules stopped the order.</p>
          )}
        </div>
      )}

      {p.error && <p className="footnote danger-text">{p.error}</p>}
      {p.dispute && <VerdictCard p={p} act={act} />}

      <button className="link-row" onClick={() => openEvidence(p.id)}>
        <Icon name="box" size={18} /><span className="grow">View record in Black Box</span><Icon name="chevronRight" size={16} />
      </button>

      {p.status === "needs_approval" && (
        <SignButton title="Approve purchase" detail={`${p.title} · ${money(p.total)}`} approval={purchaseApproval(state, p)} progress={{ working: "Paying with PayPal", done: `Paid ${money(p.total)}` }} onSigned={(auth) => act(() => approvePurchaseOrThrow(p.id, auth), undefined, { rethrow: true })}>Review and approve</SignButton>
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
      <h2 className="title-2">Results from real stores</h2>
      <p className="subhead muted">
        Your agent found {result.found.length} listings. {fits} {fits === 1 ? "matches" : "match"} your rules.
      </p>
      {p ? (
        <button className="card tappable stack-sm" style={{ textAlign: "left" }} onClick={() => setSheet({ kind: "purchase", id: p.id })}>
          <div className="row between"><StatusBadge status={p.status} /><Money value={p.total} size="body" /></div>
          <strong className="headline">{p.title}</strong>
          <span className="footnote muted">Paid with PayPal sandbox test money. Tap for details.</span>
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
                  ? <span className="caption ok-text">{chosen ? "Matches your rules · chosen" : "Matches your rules"}</span>
                  : <span className="caption danger-text">{reasons.join(" · ")}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="caption muted">Products and prices from Channel3. Payment uses PayPal sandbox, so nothing ships.</p>
    </div>
  );
}

const STEPS = ["Reading your photo", "Asking the merchant", "Checking the purchase record", "Settling with PayPal"];

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
        <span className="moment-icon"><Icon name="box" size={28} /></span>
        <h2 className="title-2">Checking what happened</h2>
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
      <p className="subhead muted">Take a photo of the label. We compare it with your rules, the order and the product page.</p>
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
