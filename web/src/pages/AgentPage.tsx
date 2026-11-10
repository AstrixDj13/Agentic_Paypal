import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, money, when, type AppState, type ChatMessage, type FindResult, type Pocket, type Purchase } from "../api";
import { Icon, type IconName } from "../components/Icon";
import { AgentIcon, AgentCardFace, BudgetBar, BudgetRing, ProposalCard, activeMandate, agentStatus, amount, budgetOf, cardStats, toneOf } from "../components/agent";
import { arrive, flyFrom, land, launch, reducedMotion } from "../motion";
import { SignButton, type Signature } from "../components/lock";
import { FeedItem, StatusBadge, purchaseApproval, approvePurchaseOrThrow, type Act } from "../components/purchase";
import { Money, Segmented, Switch } from "../components/ui";
import { LOOK_OPTIONS, LookCard } from "../components/intel";
import { NowCard, OrderCard, StoreOfferCard } from "../components/orders";
import type { SheetState } from "./PocketApp";
import { RestoreButton } from "../components/agentSheets";

type Show = (t: string, e?: boolean, action?: { label: string; run: () => void }) => void;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const brandsOf = (b?: string[]) => (b?.length ? b.map(cap).join(" or ") : "");

/** Pause or resume one agent, always with Undo. */
function usePause(agent: Pocket, show: Show, refresh: () => Promise<void> | void) {
  const setPaused = async (paused: boolean) => {
    try {
      await api(`/api/agents/${agent.id}/settings`, { paused });
      show(paused ? `${agent.name} paused. Nothing will be bought.` : `${agent.name} resumed.`, false, { label: "Undo", run: () => setPaused(!paused) });
    } catch (e) { show((e as Error).message, true); } finally { refresh(); }
  };
  return setPaused;
}

/**
 * One agent = one conversation, with the agent's card on top (like Apple Card's screen).
 * The card arrives from the wallet, then collapses into a compact header (badge with a budget ring) as you scroll.
 * Everything that isn't the conversation lives in Details.
 */
export default function AgentPage({ state, agentId, act, refresh, show, setSheet, back }: {
  state: AppState; agentId: string; act: Act; refresh: () => Promise<void> | void;
  show: Show; setSheet: (s: SheetState) => void; back: () => void;
}) {
  const agent = state.pockets.find((p) => p.id === agentId);
  const [busy, setBusy] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLButtonElement>(null);
  const compactRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Being on the page means you've read its messages.
  const lastMsg = state.chats.filter((c) => c.agentId === agentId).at(-1)?.id;
  useEffect(() => {
    if (agent) api(`/api/agents/${agentId}/read`, {}).catch(() => {});
  }, [agentId, lastMsg, agent]);

  // Arrival: the wallet card flies into the hero slot; the conversation rises in underneath it.
  useLayoutEffect(() => {
    const face = heroRef.current?.querySelector<HTMLElement>(".agent-face");
    const f = land(agentId);
    if (!face || !f || reducedMotion()) return;
    flyFrom(face, f.rect);
    // The thread fades (it holds the absolutely positioned composer); the head and composer also rise.
    const thread = bodyRef.current?.querySelector(".thread");
    arrive([topRef.current?.querySelector(".agent-head"), thread, bodyRef.current?.querySelector(".composer, .chat-closed")], 90, [thread]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Scroll: the hero card recedes and the compact header (ring, name, money left) takes over. Transform/opacity only.
  useEffect(() => {
    const screen = topRef.current?.closest<HTMLElement>(".screen");
    const hero = heroRef.current, compact = compactRef.current, top = topRef.current;
    if (!screen || !hero || !compact || !top) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const span = Math.max(1, hero.offsetHeight - 24);
      const p = Math.min(1, Math.max(0, screen.scrollTop / span));
      // The card is gone by the time the header's name arrives, so the two never overlap.
      hero.style.opacity = String(Math.max(0, 1 - 1.4 * p));
      hero.style.transform = `scale(${1 - 0.06 * p})`;
      const q = Math.min(1, Math.max(0, (p - 0.62) / 0.38));
      compact.style.opacity = String(q);
      compact.style.transform = `translate3d(0, ${(1 - q) * 10}px, 0)`;
      compact.style.visibility = q < 0.02 ? "hidden" : "visible";
      top.style.setProperty("--q", String(q));
      // The bar behind Back and Details appears as soon as anything scrolls under it.
      top.style.setProperty("--b", String(Math.min(1, screen.scrollTop / 16)));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    screen.addEventListener("scroll", onScroll, { passive: true });
    return () => { screen.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [agentId, !!agent]);

  const setPaused = usePause(agent ?? ({ id: agentId, name: "" } as Pocket), show, refresh);

  if (!agent) {
    return (
      <div className="card empty">
        <p className="subhead">This agent doesn't exist any more.</p>
        <button className="btn ghost" onClick={back}>Back to your agents</button>
      </div>
    );
  }
  const m = activeMandate(state, agent.id)?.mandate;
  const tone = agent.closedAt ? "grey" : toneOf(agent, m?.item);
  const b = budgetOf(state, agent);
  const status = agentStatus(state, agent);
  const doing = agent.closedAt ? "Closed" : status.text;
  const off = state.killSwitch || agent.paused;
  const openDetails = () => setSheet({ kind: "details", id: agent.id });
  const cardStatus = agent.closedAt ? "Closed" : off ? "Paused" : status.text === "Waiting on you" ? "Needs you" : undefined;

  // Back: the card flies home to its slot in the wallet (if it's still on screen).
  const goBack = () => {
    const face = heroRef.current?.querySelector<HTMLElement>(".agent-face");
    const r = face?.getBoundingClientRect();
    if (face && r && r.bottom > 80 && !reducedMotion()) launch(agent.id, r);
    back();
  };

  const decide = (id: string, approve: boolean, auth?: Signature) => {
    setBusy(true);
    return act(() => api(`/api/proposals/${id}/${approve ? "approve" : "decline"}`, approve ? { auth } : {}), approve ? undefined : "Declined. Your rules stay the same.", { rethrow: approve }).finally(() => setBusy(false));
  };

  return (
    <>
      {/* Pinned: Back, the compact identity (fades in once the card scrolls away), Details. */}
      <div className="agent-top" ref={topRef}>
        <header className="agent-head">
          <button className="glass-circle head-btn" aria-label="Back to agents" onClick={goBack}><Icon name="chevronLeft" size={22} /></button>
          <button className="agent-id" ref={compactRef} onClick={openDetails} aria-label={`${agent.name}. ${doing}. ${money(b.left)} left of ${money(b.total)}. Open details`}>
            <BudgetRing left={b.left} total={b.total} size={44}>
              <AgentIcon name={agent.name} item={m?.item} tone={tone} size={32} paused={agent.paused || !!agent.closedAt} />
            </BudgetRing>
            <span className="grow stack-xs id-text">
              <span className="headline ellipsis">{agent.name}</span>
              <span className="footnote muted ellipsis id-sub">
                <strong className="id-money">{amount(b.left)} left</strong>
                <span aria-hidden="true">·</span>
                {!agent.closedAt && <span className={`presence-dot ${status.tone}`} aria-hidden="true" />}
                {doing}
              </span>
            </span>
          </button>
          <button className="glass-circle head-btn" aria-label={`Details for ${agent.name}`} aria-haspopup="dialog" onClick={openDetails}>
            <Icon name="more" size={22} stroke={3} />
          </button>
        </header>
      </div>

      {/* The card itself, front and centre. Tap for Details. */}
      <button className="agent-hero" ref={heroRef} data-flight onClick={openDetails} aria-label={`${agent.name}: ${money(b.left)} left of ${money(b.total)}. ${doing}. Open details`}>
        <AgentCardFace agent={agent} item={m?.item} left={b.left} total={b.total} status={cardStatus} tone={tone} {...cardStats(state, agent.id)} />
      </button>

      <div ref={bodyRef} className="agent-body">
        <Chat state={state} agent={agent} act={act} refresh={refresh} show={show} setSheet={setSheet} busyOuter={busy} decide={decide} openDetails={openDetails} setPaused={setPaused} />
      </div>
    </>
  );
}

/* ====================================== Dictation ====================================== */

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void; onerror: (e: { error: string }) => void;
  start: () => void; stop: () => void; abort: () => void;
};

/** Speech to text in the browser (Chrome, Safari). Words land in the box; you still review and tap Send. */
function useDictation(onText: (t: string) => void, show: Show) {
  const SR = typeof window !== "undefined" ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) as (new () => Recognition) | undefined : undefined;
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  useEffect(() => () => rec.current?.abort(), []);

  const start = (base: string) => {
    if (!SR) return;
    try {
      if (!localStorage.getItem("pp-mic-note")) {
        show("Your browser turns speech into text. Nothing is sent until you tap Send.");
        localStorage.setItem("pp-mic-note", "1");
      }
    } catch { /* storage blocked: skip the one-time note */ }
    const r = new SR();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    const prefix = base.trim() ? `${base.trim()} ` : "";
    r.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      onText(prefix + t);
    };
    r.onend = () => setListening(false);
    r.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") show("Microphone access is off. Allow it in your browser settings.", true);
      else if (e.error === "no-speech") show("Didn't catch that. Tap the mic and try again.");
      else if (e.error !== "aborted") show("Voice input isn't available right now.", true);
    };
    rec.current = r;
    r.start();
    setListening(true);
  };
  const stop = () => rec.current?.stop();
  return { supported: !!SR, listening, start, stop };
}

/* ====================================== Chat ====================================== */

type Item = { kind: "msg"; at: string; m: ChatMessage } | { kind: "buy"; at: string; p: Purchase };

/** How many recent items show under the card at first; the rest are one tap away. */
const RECENT = 4;

function Chat({ state, agent, act, refresh, show, setSheet, busyOuter, decide, openDetails, setPaused }: {
  state: AppState; agent: Pocket; act: Act; refresh: () => Promise<void> | void; show: Show; setSheet: (s: SheetState) => void;
  busyOuter: boolean; decide: (id: string, approve: boolean, auth?: Signature) => unknown; openDetails: () => void;
  setPaused: (paused: boolean) => void;
}) {
  const [text, setText] = useState("");
  // The message being sent, and how many of your messages the thread had at that moment.
  const [pending, setPending] = useState<{ text: string; mineBefore: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = state.chats.filter((c) => c.agentId === agent.id);
  const mine = messages.filter((m) => m.from === "user").length;
  // The app polls while the agent replies. Once the server's copy of your message arrives,
  // stop drawing the local copy, or it shows twice.
  const echoPending = pending && mine <= pending.mineBefore ? pending.text : null;
  const signed = activeMandate(state, agent.id);
  const tone = agent.closedAt ? "grey" : toneOf(agent, signed?.mandate.item);
  const mic = useDictation(setText, show);

  // The conversation is also the activity log: purchases no message mentions join the timeline at their time.
  const mentioned = new Set(messages.map((m) => m.purchaseId).filter(Boolean));
  // The agent's original "Hi, I'm…" greeting is replaced by the intro card, so it isn't said twice.
  const greeting = messages[0]?.from === "agent" && /^Hi, I'm /.test(messages[0].text) ? messages[0].id : null;
  const items: Item[] = [
    ...messages.filter((m) => m.id !== greeting).map((m) => ({ kind: "msg" as const, at: m.at, m })),
    ...state.purchases.filter((p) => p.pocketId === agent.id && !mentioned.has(p.id)).map((p) => ({ kind: "buy" as const, at: p.createdAt, p })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const hidden = showAll ? 0 : Math.max(0, items.length - RECENT);
  const visible = items.slice(hidden);

  // What needs you, pinned above the composer so it can't scroll away.
  const needs = [
    ...state.purchases.filter((p) => p.pocketId === agent.id && p.status === "needs_approval").map((p) => ({ id: `buy-${p.id}`, label: `Approve ${p.title}` })),
    ...state.purchases.filter((p) => p.pocketId === agent.id && p.status === "awaiting_look").map((p) => ({ id: `buy-${p.id}`, label: `Take a look: ${p.title}` })),
    ...state.proposals.filter((p) => p.agentId === agent.id && p.status === "pending").map((p) => ({ id: `prop-${p.id}`, label: p.summary })),
    ...state.purchases.filter((p) => p.pocketId === agent.id && p.status === "store_suggested").map((p) => ({ id: `buy-${p.id}`, label: `Cheaper in store: ${p.title}` })),
    ...(state.orders ?? []).filter((o) => o.agentId === agent.id && (o.status === "awaiting" || o.status === "needs_approval")).flatMap((o) => {
      const asks = (o.lines ?? []).filter((l) => l.ask?.status === "pending").length;
      if (o.kind === "now") return [{ id: `order-${o.id}`, label: `Your pick: ${o.pick?.dish}` }];
      if (asks) return [{ id: `order-${o.id}`, label: `${asks} ${asks === 1 ? "question" : "questions"} on this week's order` }];
      return o.status === "needs_approval" ? [{ id: `order-${o.id}`, label: "Approve this week's order" }] : [];
    }),
  ];

  // Open with the card on top and the latest few items under it; follow new ones as they arrive.
  const seen = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = endRef.current?.closest(".screen");
    if (!el) return;
    if (seen.current === null) el.scrollTop = 0;
    else if (items.length > seen.current || pending) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    seen.current = items.length;
  }, [items.length, pending]);

  const send = async (t: string) => {
    const msg = t.trim();
    if (!msg || busy) return;
    if (mic.listening) mic.stop();
    setText("");
    setPending({ text: msg, mineBefore: mine });
    setBusy(true);
    try {
      const r = await api<{ found?: FindResult }>(`/api/agents/${agent.id}/chat`, { text: msg });
      await refresh();
      if (r.found) setSheet({ kind: "found", id: agent.id, result: r.found });
    } catch (e) {
      show((e as Error).message, true);
      setText(msg);
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const reveal = (id: string) => {
    // Scroll only the conversation (scrollIntoView would also shift the phone frame and clip the header).
    const go = () => {
      const el = document.getElementById(id);
      const screen = el?.closest<HTMLElement>(".screen");
      if (!el || !screen) return;
      const y = el.getBoundingClientRect().top - screen.getBoundingClientRect().top + screen.scrollTop - screen.clientHeight / 2 + el.offsetHeight / 2;
      screen.scrollTo({ top: Math.max(0, y), behavior: reducedMotion() ? "auto" : "smooth" });
      el.querySelector<HTMLButtonElement>("button.btn")?.focus({ preventScroll: true });
    };
    if (document.getElementById(id)) go();
    else { setShowAll(true); requestAnimationFrame(() => requestAnimationFrame(go)); }
  };

  // Starter questions: only in an empty conversation (the mic and the box cover the rest).
  const kind = signed?.mandate.kind ?? "hunt";
  const starters = mine === 0 && !agent.closedAt && kind === "hunt" ? [
    "What are your rules?",
    signed ? "Check the store now" : null,
    signed ? `Go up to ${money(Math.round(signed.mandate.maxUnitPrice * 1.4))} just this once` : null,
  ].filter(Boolean) as string[] : [];
  // Routine and right-now agents get their main action next to the message box (it stands in for a schedule).
  const [acting, setActing] = useState(false);
  const runCheck = async () => {
    setActing(true);
    try { await api(`/api/agents/${agent.id}/check`, {}); await refresh(); requestAnimationFrame(() => document.querySelector(".screen")?.scrollTo({ top: 1e9, behavior: "smooth" })); }
    catch (e) { show((e as Error).message, true); } finally { setActing(false); }
  };
  const nextWeek = () => act(() => api(`/api/agents/${agent.id}/next-week`, {}), "Moved to next week (demo). Prices and stock have changed.");

  const showSend = !!text.trim() || !mic.supported || busy;
  const paused = !agent.closedAt && (state.killSwitch || agent.paused);

  return (
    <>
      <div className="thread" aria-live="polite">
        {hidden > 0 ? (
          <button className="earlier-btn" onClick={() => setShowAll(true)}>
            <Icon name="up" size={14} />Show {hidden} earlier {hidden === 1 ? "item" : "items"}
          </button>
        ) : (
          <Intro state={state} agent={agent} openDetails={openDetails} setSheet={setSheet} starters={starters} send={send} busy={busy} />
        )}

        {visible.map((it, i) => {
          if (it.kind === "buy") return <div key={it.p.id} id={`buy-${it.p.id}`} className="timeline-buy"><PurchaseChip state={state} p={it.p} act={act} setSheet={setSheet} /></div>;
          const prev = visible[i - 1];
          const firstOfRun = !(prev?.kind === "msg" && prev.m.from === it.m.from);
          return <Message key={it.m.id} m={it.m} state={state} agent={agent} tone={tone} act={act} busy={busy || busyOuter} decide={decide} setSheet={setSheet} showAvatar={firstOfRun} />;
        })}

        {echoPending && <div className="bubble-row me"><div className="bubble me">{echoPending}</div></div>}
        {pending && (
          <div className="bubble-row from-agent">
            <span className="bubble-avatar"><AgentIcon name={agent.name} item={signed?.mandate.item} tone={tone} size={28} /></span>
            <div className="stack-xs bubble-col">
              <div className="bubble agent typing" aria-hidden="true"><i /><i /><i /></div>
              <span className="caption muted">{agent.name} is checking your rules and the store</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {agent.closedAt ? (
        <div className="chat-closed" role="note">
          <span>{agent.name} is closed. Its records stay.</span>
          <RestoreButton state={state} agentId={agent.id} />
        </div>
      ) : (
        /* Calm at rest. While the agent is thinking (a reply, a store check, an order), a soft aura blooms behind the box
           and drifts until the answer lands. The light is a state, not decoration. */
        <div className={`composer ${pending || acting ? "is-working" : mic.listening ? "is-listening" : text.trim() ? "is-typing" : ""}`}>
          <span className="composer-aura" aria-hidden="true"><i /><i /></span>
          <div className="composer-body">
            {paused ? (
              <div className="needs-strip paused" role="status">
                <Icon name="pause" size={14} />
                <span className="grow ellipsis">{state.killSwitch ? "All agents are paused from Home" : "Paused. Nothing will be bought."}</span>
                {!state.killSwitch && <button className="needs-go as-btn" onClick={() => setPaused(false)}>Resume</button>}
              </div>
            ) : needs.length > 0 && (
              <button className="needs-strip" onClick={() => reveal(needs[0].id)}>
                <span className="needs-dot" aria-hidden="true" />
                <span className="grow ellipsis"><strong>{needs.length === 1 ? "Needs you" : `${needs.length} things need you`}</strong> · {needs[0].label}</span>
                <span className="needs-go">Review</span>
              </button>
            )}
            {!paused && signed && kind !== "hunt" && (
              <div className="composer-actions">
                <button className="chip btnlike" disabled={acting} onClick={runCheck}>
                  {acting ? <span className="spinner" /> : <Icon name={kind === "routine" ? "store" : "search"} size={14} />}
                  {kind === "routine" ? "Run this week's order" : "Find me one now"}
                </button>
                {kind === "routine" && <button className="chip btnlike quiet" onClick={nextWeek}>Skip to next week (demo)</button>}
              </div>
            )}
            <form className="composer-row" onSubmit={(e) => { e.preventDefault(); send(text); }}>
              <input className="input" value={text} onChange={(e) => setText(e.target.value)}
                placeholder={mic.listening ? "Listening…" : `Message ${agent.name}`} aria-label={`Message ${agent.name}`} maxLength={600} />
              {showSend && (
                <button className="icon-btn send-btn" type="submit" disabled={busy || !text.trim()} aria-label="Send">
                  {busy ? <span className="spinner" /> : <Icon name="send" size={18} />}
                </button>
              )}
              {mic.supported && !busy && (
                <button type="button" className={`icon-btn mic-btn ${mic.listening ? "on" : ""}`} aria-pressed={mic.listening}
                  aria-label={mic.listening ? "Stop listening" : "Speak a message"} onClick={() => (mic.listening ? mic.stop() : mic.start(text))}>
                  <Icon name={mic.listening ? "stop" : "mic"} size={18} />
                </button>
              )}
            </form>
            {mic.listening && <span className="sr-only" role="status">Listening. Speak your message, then tap Send.</span>}
          </div>
        </div>
      )}
    </>
  );
}

/** The agent introduces itself in its own words, built from the rules you signed. The start of every conversation. */
function Intro({ state, agent, openDetails, setSheet, starters, send, busy }: {
  state: AppState; agent: Pocket; openDetails: () => void; setSheet: (s: SheetState) => void;
  starters: string[]; send: (t: string) => void; busy: boolean;
}) {
  const m = activeMandate(state, agent.id)?.mandate;
  const brands = brandsOf(m?.allowed.brand);
  const since = agent.createdAt ? new Date(agent.createdAt).toLocaleDateString([], { month: "short", day: "numeric" }) : null;
  return (
    <section className="agent-intro" aria-label={`About ${agent.name}`}>
      <h2 className="headline">Hi, I'm {agent.name}.</h2>
      {m && m.kind === "routine" ? (
        <p className="subhead">
          I do your weekly shop: <strong>{m.list?.length ?? 0} items</strong>, up to <strong>{money(m.maxUnitPrice)}</strong> a week. I buy each usual item where it's cheapest, ask once about better deals, and never swap without your OK.
        </p>
      ) : m && m.kind === "now" ? (
        <p className="subhead">
          I find <strong>{m.item}</strong> under <strong>{money(m.maxUnitPrice)}</strong> with delivery{m.withinMinutes ? `, arriving within ${m.withinMinutes} minutes` : ""}. I weigh price, delivery fee, rating and time, then make one pick.
        </p>
      ) : m ? (
        <p className="subhead">
          I look for <strong>{m.item}</strong>{brands ? ` from ${brands}` : ""}{m.required.size_us ? ` in size ${m.required.size_us}` : ""}, up to <strong>{money(m.maxUnitPrice)}</strong> each, until {new Date(m.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" })}.
        </p>
      ) : (
        <p className="subhead">I don't have a job yet. Tell me what to look for and I'll get started once you approve.</p>
      )}
      <ul className="intro-promises">
        <li><Icon name="check" size={14} stroke={2.4} />{agent.askMode === "anything" ? "I ask you before every purchase." : "I ask you whenever money or a limit is involved."}</li>
        <li><Icon name="lock" size={14} />Nothing changes until you approve it.</li>
        <li><Icon name="box" size={14} />Every decision is recorded in your Black Box.</li>
      </ul>
      {starters.length > 0 && (
        <div className="intro-starters">
          {starters.map((s) => <button key={s} className="chip btnlike" disabled={busy} onClick={() => send(s)}>{s}</button>)}
        </div>
      )}
      <div className="row intro-actions">
        {m ? <button className="link-btn" onClick={openDetails}>See my rules</button>
          : !agent.closedAt && <button className="btn sm primary" onClick={() => setSheet({ kind: "job", id: agent.id })}>Give it a job</button>}
        {since && <span className="caption muted">With you since {since}</span>}
      </div>
    </section>
  );
}

/** The icon for a system note says what kind of event it was. The lock is only for approvals and security. */
function sysIcon(text: string): IconName {
  if (/^Renamed/.test(text)) return "pencil";
  if (/moved (in|out)/.test(text)) return "swap";
  if (/paused|resumed/i.test(text)) return "pause";
  if (/^Setting changed/.test(text)) return "rules";
  return "lock";
}

function Message({ m, state, agent, tone, act, busy, decide, setSheet, showAvatar }: {
  m: ChatMessage; state: AppState; agent: Pocket; tone: string; act: Act; busy: boolean;
  decide: (id: string, approve: boolean, auth?: Signature) => unknown; setSheet: (s: SheetState) => void; showAvatar: boolean;
}) {
  const proposal = m.proposalId ? state.proposals.find((p) => p.id === m.proposalId) : undefined;
  const purchase = m.purchaseId ? state.purchases.find((p) => p.id === m.purchaseId) : undefined;
  const order = m.orderId ? (state.orders ?? []).find((o) => o.id === m.orderId) : undefined;
  const item = activeMandate(state, agent.id)?.mandate.item;

  if (m.from === "system") {
    return <div className="sys-note"><Icon name={sysIcon(m.text)} size={13} /><span>{m.text} <span className="muted">· {when(m.at)}</span></span></div>;
  }
  const mine = m.from === "user";
  return (
    <div className={`bubble-row ${mine ? "me" : "from-agent"}`}>
      {!mine && <span className="bubble-avatar" aria-hidden="true">{showAvatar && <AgentIcon name={agent.name} item={item} tone={tone as any} size={28} />}</span>}
      <div className="stack-sm bubble-col">
        <div className={`bubble ${mine ? "me" : "agent"}`}>
          {!mine && <span className="sr-only">{agent.name}: </span>}
          {m.text}
        </div>
        {purchase && <div id={`buy-${purchase.id}`}><PurchaseChip state={state} p={purchase} act={act} setSheet={setSheet} /></div>}
        {order && <div id={`order-${order.id}`}>{order.kind === "weekly" ? <OrderCard state={state} o={order} act={act} /> : <NowCard o={order} act={act} />}</div>}
        {proposal && <div id={`prop-${proposal.id}`}><ProposalCard p={proposal} agentName={agent.name} busy={busy} onApprove={(auth) => decide(proposal.id, true, auth)} onDecline={() => decide(proposal.id, false)} /></div>}
        <span className={`caption muted ${mine ? "right" : ""}`}>{when(m.at)}</span>
      </div>
    </div>
  );
}

/** A purchase in the conversation: what, how much, how it went, and proof it was checked and recorded. */
function PurchaseChip({ state, p, act, setSheet }: { state: AppState; p: Purchase; act: Act; setSheet: (s: SheetState) => void }) {
  // "Take a look before I buy": photo, price, countdown, Looks good / Skip.
  if (p.status === "awaiting_look") {
    return <LookCard state={state} p={p} answer={(d) => act(() => api(`/api/purchases/${p.id}/look`, { decision: d }), d === "buy" ? "Buying it now." : "Skipped. Nothing was paid.")} />;
  }
  if (p.status === "store_suggested" && p.storeOffer) return <StoreOfferCard p={p} act={act} />;
  const why = p.decision.violations.map((v) => v.detail);
  const check = p.status === "blocked" ? { icon: "shield" as const, tone: "danger", text: why[0] ? `Stopped by your rules: ${why[0]}` : "Stopped by your rules" }
    : p.status === "needs_approval" ? { icon: "hand" as const, tone: "warn", text: why[0] ? `Asking because ${why[0].charAt(0).toLowerCase()}${why[0].slice(1)}` : "Waiting for your approval" }
    : p.status === "skipped" ? { icon: "close" as const, tone: "warn", text: "You skipped it after a look. Nothing was paid." }
    : p.status === "bought_in_store" ? { icon: "store" as const, tone: "ok", text: `Bought in store at ${p.storeOffer?.shop}: saved ${money(p.saved)}. Nothing paid through Pocket.` }
    : p.saved !== undefined && p.usual !== undefined && p.saved > 0 ? { icon: "check" as const, tone: "ok", text: `Usually ${money(p.usual)} · saved ${money(p.saved)}` }
    : p.status === "failed" ? { icon: "alert" as const, tone: "danger", text: p.error ?? "PayPal couldn't complete the payment" }
    : { icon: "check" as const, tone: "ok", text: "Checked against your rules" };
  return (
    <div className="purchase-chip">
      <button className="chip-main" onClick={() => setSheet({ kind: "purchase", id: p.id })} aria-label={`${p.title}, ${money(p.total)}. Open receipt`}>
        <span className="stack-xs grow">
          <strong className="footnote ellipsis">{p.title}</strong>
          <StatusBadge status={p.status} />
        </span>
        <span className="num">{money(p.total)}</span>
      </button>
      <div className={`chip-check ${check.tone}`}>
        <Icon name={check.icon} size={14} />
        <span className="grow">{check.text}</span>
        <button className="link-btn" onClick={() => setSheet({ kind: "evidence", id: p.id })}>Black Box</button>
      </div>
      {p.status === "needs_approval" && (
        <SignButton title="Approve purchase" detail={`${p.title} · ${money(p.total)}`} approval={purchaseApproval(state, p)} progress={{ working: "Paying with PayPal", done: `Paid ${money(p.total)}` }} onSigned={(auth) => act(() => approvePurchaseOrThrow(p.id, auth), undefined, { rethrow: true })}>Review and approve</SignButton>
      )}
    </div>
  );
}

/* ====================================== Details (sheet) ====================================== */

/** Everything about an agent that isn't the conversation: money, rules, this week, settings, history, close. */
export function AgentDetails({ state, agentId, act, setSheet, show, refresh }: {
  state: AppState; agentId: string; act: Act; setSheet: (s: SheetState) => void; show: Show; refresh: () => Promise<void> | void;
}) {
  const agent = state.pockets.find((p) => p.id === agentId);
  const setPaused = usePause(agent ?? ({ id: agentId, name: "" } as Pocket), show, refresh);
  if (!agent) return null;
  const b = budgetOf(state, agent);
  const m = activeMandate(state, agent.id)?.mandate;
  const all = state.purchases.filter((x) => x.pocketId === agent.id);
  const off = state.killSwitch || agent.paused;

  if (agent.closedAt) {
    return (
      <div className="stack">
        <h2 className="title-2">{agent.name}</h2>
        <div className="card closed-note">
          <strong className="headline">Closed {new Date(agent.closedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</strong>
          <p className="subhead muted">{agent.name} can't buy anything. Its purchases, receipts and Black Box records stay. Its {money(agent.balance)} budget comes back if you restore it.</p>
          <RestoreButton state={state} agentId={agent.id} after={() => setSheet(null)} />
        </div>
        {all.length > 0 && <History list={all} setSheet={setSheet} />}
      </div>
    );
  }

  // This week: purchase attempts per day (bought vs not), for the activity bars.
  const days = Array.from({ length: 7 }, (_, k) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - k)); return d; });
  const week = days.map((d) => {
    const next = d.getTime() + 864e5;
    const on = all.filter((x) => { const t = Date.parse(x.createdAt); return t >= d.getTime() && t < next; });
    return { d, tries: on.length, bought: on.filter((x) => x.status === "completed" || x.status === "resolved" || x.status === "disputed").length };
  });
  const tries = week.reduce((n, w) => n + w.tries, 0);
  const bought = week.reduce((n, w) => n + w.bought, 0);
  const peak = Math.max(1, ...week.map((w) => w.tries));
  const tone = toneOf(agent, m?.item);

  return (
    <div className={`stack agent-overview tone-${tone}`}>
      <div className="bento">
        <div className="bento-tile">
          <span className="footnote muted">Left to spend</span>
          <Money value={b.left} size="title" />
          <span className="caption muted">of {money(b.total)} · {money(b.spent)} spent</span>
          <BudgetBar left={b.left} total={b.total} />
        </div>
        <div className="bento-tile tall">
          <span className="footnote muted">Rules</span>
          {m ? (
            <>
              <ul className="rule-lines">
                <li>Up to <strong>{money(m.maxUnitPrice)}</strong> each</li>
                {m.allowed.brand?.length ? <li>{brandsOf(m.allowed.brand)}</li> : null}
                {m.required.size_us ? <li>Size {m.required.size_us}</li> : null}
                <li>Max {m.maxQuantity} at a time</li>
                <li>Until {new Date(m.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" })}</li>
              </ul>
              <button className="btn sm tonal tile-action" onClick={() => setSheet({ kind: "job", id: agent.id })}>Edit rules</button>
            </>
          ) : (
            <>
              <p className="subhead">No job yet.</p>
              <button className="btn sm primary tile-action" onClick={() => setSheet({ kind: "job", id: agent.id })}>Give it a job</button>
            </>
          )}
        </div>
        <div className="bento-tile" role="img" aria-label={`This week: ${tries} tries, ${bought} bought`}>
          <span className="footnote muted">This week</span>
          <span className="headline">{tries} {tries === 1 ? "try" : "tries"} · {bought} bought</span>
          <span className="week-bars" aria-hidden="true">
            {week.map((w) => (
              <span key={w.d.toISOString()} className="week-col">
                <span className={`week-bar ${w.tries ? "" : "empty"}`} style={{ height: `${Math.max(10, (w.tries / peak) * 100)}%` }} />
                <span className="week-day">{w.d.toLocaleDateString([], { weekday: "narrow" })}</span>
              </span>
            ))}
          </span>
        </div>
      </div>

      {!state.killSwitch && (
        <button className={`btn block ${agent.paused ? "primary" : "caution"}`} onClick={() => setPaused(!agent.paused)}>
          <Icon name={agent.paused ? "play" : "pause"} size={18} />{agent.paused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
        </button>
      )}
      {state.killSwitch && <p className="footnote danger-text row" style={{ gap: 6 }}><Icon name="pause" size={14} />All agents are paused from Home. Nothing will be bought.</p>}

      <Settings state={state} agent={agent} act={act} setSheet={setSheet} />

      {all.length > 0 && <History list={all} setSheet={setSheet} />}

      <button className="link-row neutral" onClick={() => setSheet({ kind: "close", id: agent.id })}>
        <Icon name="archive" size={18} /><span className="grow">Close agent</span><Icon name="chevronRight" size={16} />
      </button>
      <p className="caption muted">Closing stops it for good. Its records stay, and you can restore it later.</p>
    </div>
  );
}

function History({ list, setSheet }: { list: Purchase[]; setSheet: (s: SheetState) => void }) {
  return (
    <section className="stack-sm">
      <h3 className="section-title">Activity</h3>
      {list.map((p) => <FeedItem key={p.id} p={p} onOpen={() => setSheet({ kind: "purchase", id: p.id })} />)}
    </section>
  );
}

function Settings({ state, agent, act, setSheet }: { state: AppState; agent: Pocket; act: Act; setSheet: (s: SheetState) => void }) {
  const ex = state.exceptions.find((e) => e.agentId === agent.id);
  const history = state.retiredMandates.filter((m) => m.mandate.pocketId === agent.id).slice().reverse();
  const set = (patch: Partial<Pocket> | Record<string, unknown>, ok: string) => act(() => api(`/api/agents/${agent.id}/settings`, patch), ok);
  const kind = activeMandate(state, agent.id)?.mandate.kind ?? "hunt";

  return (
    <div className="stack">
      {ex && (
        <div className="card callout warn">
          <strong className="headline">Exception active</strong>
          <p className="subhead">{ex.scope === "once" ? "For the next purchase only." : `Until ${new Date(ex.until!).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}.`} Your original rules come back after.</p>
          <button className="btn sm tonal" onClick={() => act(() => api(`/api/agents/${agent.id}/end-exception`, {}), "Back to your original rules")}>End it now</button>
        </div>
      )}

      <div className="card stack">
        <span className="kicker">Settings</span>
        <div className="stack-sm">
          <span className="headline">When should {agent.name} ask you?</span>
          <Segmented
            value={agent.askMode ?? "money"}
            onChange={(v) => set({ askMode: v }, v === "anything" ? "Will ask before every purchase" : "Will only ask about money")}
            options={[{ value: "anything", label: "About anything" }, { value: "money", label: "Only about money" }]}
          />
          <p className="footnote muted">
            {agent.askMode === "anything" ? "Every purchase waits for your tap, even inside the rules." : "Buys on its own inside the rules. Asks you when money or a limit is involved."}
          </p>
        </div>
        <div className="stack-sm">
          <span className="headline">Show me before buying</span>
          <Segmented
            value={String(agent.lookFirstSec ?? 0)}
            onChange={(v) => set({ lookFirstSec: Number(v) }, Number(v) ? "You'll get a look before each purchase" : "Look-first is off")}
            options={LOOK_OPTIONS}
          />
          <p className="footnote muted">
            {agent.lookFirstSec ? `Before each purchase, ${agent.name} sends you the photo and price, then waits ${agent.lookFirstSec >= 60 ? `${Math.round(agent.lookFirstSec / 60)} min` : `${agent.lookFirstSec} s`}. Skip it and nothing is paid.` : "Buys as soon as something fits the rules. Turn this on to get a heads-up first."}
          </p>
        </div>
        {kind === "routine" && (
          <div className="row between">
            <span className="stack-xs grow">
              <span className="headline">Always swap if cheaper and same size</span>
              <span className="footnote muted">Skips the question for cheaper swaps. Anything that costs more still needs your PIN.</span>
            </span>
            <Switch on={!!agent.prefs?.autoSwapCheaper} onChange={() => set({ autoSwapCheaper: !agent.prefs?.autoSwapCheaper }, agent.prefs?.autoSwapCheaper ? "I'll ask before every swap." : "Cheaper same-size swaps happen automatically.")} label="Always swap if cheaper" />
          </div>
        )}
        {kind === "hunt" && (
          <div className="row between">
            <span className="stack-xs grow">
              <span className="headline">Check nearby shops</span>
              <span className="footnote muted">If the same item is cheaper in a shop near you, I'll say so instead of paying online. (Simulated shops in this demo.)</span>
            </span>
            <Switch on={agent.checkNearby !== false} onChange={() => set({ checkNearby: agent.checkNearby === false }, agent.checkNearby === false ? "I'll check nearby shops." : "Online only.")} label="Check nearby shops" />
          </div>
        )}
        <button className="link-row" onClick={() => setSheet({ kind: "rename", id: agent.id })}>
          <Icon name="pencil" size={18} /><span className="grow">Name and colour</span><Icon name="chevronRight" size={16} />
        </button>
        <button className="link-row" onClick={() => setSheet({ kind: "move", id: agent.id })}>
          <Icon name="swap" size={18} /><span className="grow">Add money from another agent</span><Icon name="chevronRight" size={16} />
        </button>
      </div>

      {history.length > 0 && (
        <div className="card stack-sm">
          <span className="kicker">Earlier versions</span>
          {history.slice(0, 6).map((m) => (
            <div key={m.mandate.id} className="row between footnote">
              <span className="grow ellipsis capitalize">{m.mandate.item} · ≤ {money(m.mandate.maxUnitPrice)}</span>
              <span className="muted">{when(m.mandate.createdAt)}</span>
            </div>
          ))}
          <p className="caption muted">Past purchases are always checked against the rules that applied at the time.</p>
        </div>
      )}
    </div>
  );
}
