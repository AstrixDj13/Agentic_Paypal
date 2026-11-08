import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, money, when, type AppState, type ChatMessage, type FindResult, type Pocket, type Purchase } from "../api";
import { Icon, type IconName } from "../components/Icon";
import { AgentCardFace, AgentIcon, BudgetBar, ProposalCard, activeMandate, budgetOf, toneOf } from "../components/agent";
import { SignButton, type Signature } from "../components/lock";
import { FeedItem, MandateChips, StatusBadge, purchaseApproval, approvePurchaseOrThrow, type Act } from "../components/purchase";
import { Money, Segmented, Switch } from "../components/ui";
import type { SheetState } from "./PocketApp";
import { RestoreButton } from "../components/agentSheets";

type View = "overview" | "chat" | "activity";

/**
 * One agent's home. It opens on an overview (money, limits, what's waiting for you, settings),
 * like an account page. Chat is the second tab: the agent can only suggest changes there.
 */
export default function AgentPage({ state, agentId, act, refresh, show, setSheet, back }: {
  state: AppState; agentId: string; act: Act; refresh: () => Promise<void> | void;
  show: (t: string, e?: boolean, action?: { label: string; run: () => void }) => void; setSheet: (s: SheetState) => void; back: () => void;
}) {
  const agent = state.pockets.find((p) => p.id === agentId);
  // Open straight on a view when asked (e.g. the Chat button on an agent card: ?view=chat).
  const { search } = useLocation();
  const [view, setView] = useState<View>(new URLSearchParams(search).get("view") === "chat" ? "chat" : "overview");
  const [busy, setBusy] = useState(false);

  // Opening the chat marks the agent's messages as read.
  const lastMsg = state.chats.filter((c) => c.agentId === agentId).at(-1)?.id;
  useEffect(() => {
    if (agent && view === "chat") api(`/api/agents/${agentId}/read`, {}).catch(() => {});
  }, [agentId, view, lastMsg, agent]);

  if (!agent) {
    return (
      <div className="card empty">
        <p className="subhead">This agent doesn't exist any more.</p>
        <button className="btn ghost" onClick={back}>Back to your agents</button>
      </div>
    );
  }
  const signed = activeMandate(state, agent.id);
  const unread = state.chats.filter((c) => c.agentId === agent.id && c.from === "agent" && agent.lastReadAt && Date.parse(c.at) > Date.parse(agent.lastReadAt)).length;

  const decide = (id: string, approve: boolean, auth?: Signature) => {
    setBusy(true);
    return act(() => api(`/api/proposals/${id}/${approve ? "approve" : "decline"}`, approve ? { auth } : {}), approve ? undefined : "Declined. Your rules stay the same.", { rethrow: approve }).finally(() => setBusy(false));
  };

  return (
    <>
      {/* Header and view switch stay pinned while the page or chat scrolls. */}
      <div className="agent-top">
      <header className="agent-head">
        <button className="icon-btn back-btn" aria-label="Back to agents" onClick={back}><Icon name="chevronLeft" size={22} /></button>
        <AgentIcon item={signed?.mandate.item} tone={toneOf(agent, signed?.mandate.item)} size={44} paused={agent.paused} />
        <div className="grow stack-xs">
          <button className="name-btn" onClick={() => setSheet({ kind: "rename", id: agent.id })} aria-label={`${agent.name}. Edit name and colour`}>
            <h1 className={`title-2 clamp-2 ${agent.name.length > 16 ? "long-name" : ""}`}>{agent.name}</h1><Icon name="pencil" size={15} />
          </button>
          <span className="footnote muted ellipsis capitalize">{agent.closedAt ? "Closed" : signed?.mandate.item ?? "No job yet"}</span>
        </div>
        <button className="icon-btn row-more-head" aria-label={`More options for ${agent.name}`} aria-haspopup="dialog" onClick={() => setSheet({ kind: "menu", id: agent.id })}>
          <Icon name="more" size={22} stroke={3} />
        </button>
      </header>

      <Segmented<View>
        value={view}
        onChange={setView}
        options={[
          { value: "overview", label: "Overview" },
          { value: "chat", label: unread ? `Chat ${unread}` : "Chat" },
          { value: "activity", label: "Activity" },
        ]}
      />
      </div>

      {view === "overview" && <Overview state={state} agent={agent} act={act} busy={busy} decide={decide} setSheet={setSheet} openChat={() => setView("chat")} show={show} refresh={refresh} />}
      {view === "chat" && <Chat state={state} agent={agent} act={act} refresh={refresh} show={show} setSheet={setSheet} busyOuter={busy} decide={decide} />}
      {view === "activity" && <ActivityView state={state} agent={agent} setSheet={setSheet} />}
    </>
  );
}

/* ====================================== Chat ====================================== */

function Chat({ state, agent, act, refresh, show, setSheet, busyOuter, decide }: {
  state: AppState; agent: Pocket; act: Act; refresh: () => Promise<void> | void; show: (t: string, e?: boolean) => void; setSheet: (s: SheetState) => void;
  busyOuter: boolean; decide: (id: string, approve: boolean, auth?: Signature) => unknown;
}) {
  const [text, setText] = useState("");
  // The message being sent, and how many of your messages the thread had at that moment.
  const [pending, setPending] = useState<{ text: string; mineBefore: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = state.chats.filter((c) => c.agentId === agent.id);
  const mine = messages.filter((m) => m.from === "user").length;
  // The app polls while the agent replies. Once the server's copy of your message arrives,
  // stop drawing the local copy, or it shows twice.
  const echoPending = pending && mine <= pending.mineBefore ? pending.text : null;
  const signed = activeMandate(state, agent.id);

  // Jump to the latest message on open, and follow new ones.
  useLayoutEffect(() => {
    const el = endRef.current?.closest(".screen");
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  const send = async (t: string) => {
    const msg = t.trim();
    if (!msg || busy) return;
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

  const suggestions = [
    "What are your rules?",
    signed ? "Check the store now" : null,
    signed && state.channel3?.enabled ? "Find it in real stores" : null,
    signed ? `Go up to ${money(Math.round(signed.mandate.maxUnitPrice * 1.4))} just this once` : null,
    state.pockets.some((p) => p.id !== agent.id && !p.closedAt) ? `Move $20 from ${state.pockets.find((p) => p.id !== agent.id && !p.closedAt)?.name}` : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <div className="thread" aria-live="polite">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="subhead muted">{agent.name}</p>
            <h2 className="large-title">Ask anything about this pocket</h2>
            <p className="subhead muted">Its rules, what it's watching, or a change you want. Nothing changes until you approve it.</p>
          </div>
        )}
        {messages.map((m) => <Message key={m.id} m={m} state={state} agent={agent} act={act} busy={busy || busyOuter} decide={decide} setSheet={setSheet} />)}
        {echoPending && <div className="bubble-row me"><div className="bubble me">{echoPending}</div></div>}
        {pending && <span className="sr-only" role="status">{agent.name} is checking your rules and the store.</span>}
        <div ref={endRef} />
      </div>

      {agent.closedAt ? <div className="chat-closed" role="note">{agent.name} is closed. Restore it to chat again.</div> : <>
      {/* The light hugs the box: 50% at rest, 5% while you type, and travels around the edge while the agent works. */}
      <div className={`composer ${pending ? "is-working" : text.trim() ? "is-typing" : ""}`}>
        <div className="composer-body">
        <div className="suggest">
          {suggestions.map((s) => <button key={s} className="chip btnlike" disabled={busy} onClick={() => send(s)}>{s}</button>)}
        </div>
        <form className="composer-row" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${agent.name}`} aria-label={`Message ${agent.name}`} maxLength={600} />
          <button className="icon-btn send-btn" type="submit" disabled={busy || !text.trim()} aria-label="Send">
            {busy ? <span className="spinner" /> : <Icon name="send" size={18} />}
          </button>
        </form>
        </div>
      </div>
      </>}
    </>
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

function Message({ m, state, agent, act, busy, decide, setSheet }: {
  m: ChatMessage; state: AppState; agent: Pocket; act: Act; busy: boolean; decide: (id: string, approve: boolean, auth?: Signature) => unknown; setSheet: (s: SheetState) => void;
}) {
  const proposal = m.proposalId ? state.proposals.find((p) => p.id === m.proposalId) : undefined;
  const purchase = m.purchaseId ? state.purchases.find((p) => p.id === m.purchaseId) : undefined;

  if (m.from === "system") {
    return <div className="sys-note"><Icon name={sysIcon(m.text)} size={13} /><span>{m.text} <span className="muted">· {when(m.at)}</span></span></div>;
  }
  const mine = m.from === "user";
  return (
    <div className={`bubble-row ${mine ? "me" : ""}`}>
      <div className="stack-sm bubble-col">
        <div className={`bubble ${mine ? "me" : "agent"}`}>
          {m.text}
        </div>
        {purchase && <PurchaseChip state={state} p={purchase} act={act} onOpen={() => setSheet({ kind: "purchase", id: purchase.id })} />}
        {proposal && <ProposalCard p={proposal} agentName={agent.name} busy={busy} onApprove={(auth) => decide(proposal.id, true, auth)} onDecline={() => decide(proposal.id, false)} />}
        <span className={`caption muted ${mine ? "right" : ""}`}>{when(m.at)}</span>
      </div>
    </div>
  );
}

function PurchaseChip({ state, p, act, onOpen }: { state: AppState; p: Purchase; act: Act; onOpen: () => void }) {
  return (
    <div className="purchase-chip">
      <button className="row between" onClick={onOpen} style={{ all: "unset", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span className="stack-xs grow">
          <strong className="footnote ellipsis">{p.title}</strong>
          <StatusBadge status={p.status} />
        </span>
        <span className="num">{money(p.total)}</span>
      </button>
      {p.status === "needs_approval" && (
        <SignButton title="Approve purchase" detail={`${p.title} · ${money(p.total)}`} approval={purchaseApproval(state, p)} progress={{ working: "Paying with PayPal", done: `Paid ${money(p.total)}` }} onSigned={(auth) => act(() => approvePurchaseOrThrow(p.id, auth), undefined, { rethrow: true })}>Review and approve</SignButton>
      )}
    </div>
  );
}

/* ====================================== Overview ====================================== */

function Overview({ state, agent, act, busy, decide, setSheet, openChat, show, refresh }: {
  state: AppState; agent: Pocket; act: Act; busy: boolean; decide: (id: string, approve: boolean, auth?: Signature) => unknown; setSheet: (s: SheetState) => void; openChat: () => void;
  show: (t: string, e?: boolean, action?: { label: string; run: () => void }) => void; refresh: () => Promise<void> | void;
}) {
  const b = budgetOf(state, agent);
  const m = activeMandate(state, agent.id)?.mandate;
  const proposals = state.proposals.filter((x) => x.agentId === agent.id && x.status === "pending");
  const approvals = state.purchases.filter((x) => x.pocketId === agent.id && x.status === "needs_approval");
  const last = state.purchases.find((x) => x.pocketId === agent.id);
  const off = state.killSwitch || agent.paused;
  if (agent.closedAt) {
    return (
      <div className="stack">
        <div className="card closed-note">
          <strong className="headline">Closed {new Date(agent.closedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</strong>
          <p className="subhead muted">{agent.name} can't buy anything. Its purchases, receipts and Black Box records stay. Its {money(agent.balance)} budget comes back if you restore it.</p>
          <RestoreButton state={state} agentId={agent.id} />
        </div>
        {last && (
          <section className="stack-sm">
            <h2 className="section-title">Last activity</h2>
            <FeedItem p={last} onOpen={() => setSheet({ kind: "purchase", id: last.id })} />
          </section>
        )}
      </div>
    );
  }
  // This week: purchase attempts per day (bought vs not), for the activity bars.
  const days = Array.from({ length: 7 }, (_, k) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - k)); return d; });
  const mine = state.purchases.filter((x) => x.pocketId === agent.id);
  const week = days.map((d) => {
    const next = d.getTime() + 864e5;
    const on = mine.filter((x) => { const t = Date.parse(x.createdAt); return t >= d.getTime() && t < next; });
    return { d, tries: on.length, bought: on.filter((x) => x.status === "completed" || x.status === "resolved" || x.status === "disputed").length };
  });
  const tries = week.reduce((n, w) => n + w.tries, 0);
  const bought = week.reduce((n, w) => n + w.bought, 0);
  const peak = Math.max(1, ...week.map((w) => w.tries));
  const tone = toneOf(agent, m?.item);
  const setPaused = async (paused: boolean) => {
    try {
      await api(`/api/agents/${agent.id}/settings`, { paused });
      show(paused ? `${agent.name} paused. Nothing will be bought.` : `${agent.name} resumed.`, false, { label: "Undo", run: () => setPaused(!paused) });
    } catch (e) { show((e as Error).message, true); } finally { refresh(); }
  };

  return (
    <div className={`stack agent-overview tone-${tone}`}>
      {/* The hero: the agent as a card */}
      <div className="hero-face"><AgentCardFace agent={agent} item={m?.item} left={b.left} total={b.total} status={off ? "Paused" : undefined} /></div>

      {/* Answer tiles: each one answers a single question */}
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
                {m.allowed.brand?.length ? <li>{m.allowed.brand.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" or ")}</li> : null}
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

      {(proposals.length > 0 || approvals.length > 0) && (
        <section className="stack-sm">
          <h2 className="section-title">Waiting for you</h2>
          {approvals.map((p) => <PurchaseChip key={p.id} state={state} p={p} act={act} onOpen={() => setSheet({ kind: "purchase", id: p.id })} />)}
          {proposals.map((p) => <ProposalCard key={p.id} p={p} agentName={agent.name} busy={busy} onApprove={(auth) => decide(p.id, true, auth)} onDecline={() => decide(p.id, false)} />)}
        </section>
      )}

      {/* The actions, once */}
      <div className="action-pair">
        <button className={`btn ${agent.paused ? "primary" : "caution"}`} onClick={() => setPaused(!agent.paused)}>
          <Icon name={agent.paused ? "play" : "pause"} size={18} />{agent.paused ? "Resume" : "Pause"}
        </button>
        <button className="btn tonal" onClick={openChat}><Icon name="chat" size={18} />Chat</button>
      </div>
      {state.killSwitch && <p className="footnote danger-text row" style={{ gap: 6 }}><Icon name="pause" size={14} />All agents are paused from Home. Nothing will be bought.</p>}

      {mine.length > 0 && (
        <section className="tx-card">
          <h2 className="section-title">Latest purchases</h2>
          {mine.slice(0, 4).map((x) => (
            <button key={x.id} className="tx-row" onClick={() => setSheet({ kind: "purchase", id: x.id })}>
              <span className="grow stack-xs">
                <strong className="subhead ellipsis">{x.title}</strong>
                <span className="caption muted">{when(x.createdAt)}</span>
              </span>
              <span className="stack-xs" style={{ alignItems: "flex-end" }}>
                <span className="num">{money(x.total)}</span>
                <StatusBadge status={x.status} />
              </span>
              <Icon name="chevronRight" size={16} className="muted" />
            </button>
          ))}
        </section>
      )}

      <RulesView state={state} agent={agent} act={act} setSheet={setSheet} show={show} refresh={refresh} />

      <button className="link-row neutral" onClick={() => setSheet({ kind: "close", id: agent.id })}>
        <Icon name="archive" size={18} /><span className="grow">Close agent</span><Icon name="chevronRight" size={16} />
      </button>
      <p className="caption muted">Closing stops it for good. Its records stay, and you can restore it later.</p>
    </div>
  );
}

/* ====================================== Rules & settings ====================================== */

function RulesView({ state, agent, act, setSheet, show, refresh }: {
  state: AppState; agent: Pocket; act: Act; setSheet: (s: SheetState) => void;
  show: (t: string, e?: boolean, action?: { label: string; run: () => void }) => void; refresh: () => Promise<void> | void;
}) {
  const signed = activeMandate(state, agent.id);
  const ex = state.exceptions.find((e) => e.agentId === agent.id);
  const history = state.retiredMandates.filter((m) => m.mandate.pocketId === agent.id).slice().reverse();
  const set = (patch: Partial<Pocket>, ok: string) => act(() => api(`/api/agents/${agent.id}/settings`, patch), ok);
  const setPaused = async (paused: boolean) => {
    try {
      await api(`/api/agents/${agent.id}/settings`, { paused });
      show(paused ? `${agent.name} paused. Nothing will be bought.` : `${agent.name} resumed.`, false, { label: "Undo", run: () => setPaused(!paused) });
    } catch (e) { show((e as Error).message, true); } finally { refresh(); }
  };

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
        <button className="link-row" onClick={() => setSheet({ kind: "rename", id: agent.id })}>
          <Icon name="pencil" size={18} /><span className="grow">Name and colour</span><span className="footnote muted">{agent.name}</span><Icon name="chevronRight" size={16} />
        </button>
        <button className="link-row" onClick={() => setSheet({ kind: "move", id: agent.id })}>
          <Icon name="swap" size={18} /><span className="grow">Move money to {agent.name}</span><Icon name="chevronRight" size={16} />
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

/* ====================================== Activity ====================================== */

function ActivityView({ state, agent, setSheet }: { state: AppState; agent: Pocket; setSheet: (s: SheetState) => void }) {
  const list = state.purchases.filter((p) => p.pocketId === agent.id);
  if (!list.length) return <div className="card empty"><p className="subhead muted">{agent.name} hasn't tried to buy anything yet.</p></div>;
  return <div className="stack">{list.map((p) => <FeedItem key={p.id} p={p} onOpen={() => setSheet({ kind: "purchase", id: p.id })} />)}</div>;
}
