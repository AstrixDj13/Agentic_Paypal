import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, money, when, type AppState, type ChatMessage, type FindResult, type Pocket, type Purchase } from "../api";
import { Icon } from "../components/Icon";
import { AgentOrb, ProposalCard, activeMandate, agentStatus } from "../components/agent";
import { SignButton, type Signature } from "../components/lock";
import { FeedItem, MandateChips, StatusBadge, type Act } from "../components/purchase";
import { Money, Segmented, Switch } from "../components/ui";
import type { SheetState } from "./PocketApp";

type View = "chat" | "rules" | "activity";

/**
 * One agent's home: talk to it, see its one job, change its settings, see what it did.
 * The chat can only propose changes; every change is a card you hold to sign.
 */
export default function AgentPage({ state, agentId, act, refresh, show, setSheet, back }: {
  state: AppState; agentId: string; act: Act; refresh: () => Promise<void> | void;
  show: (t: string, e?: boolean) => void; setSheet: (s: SheetState) => void; back: () => void;
}) {
  const agent = state.pockets.find((p) => p.id === agentId);
  const [view, setView] = useState<View>("chat");

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
  const status = agentStatus(state, agent);
  const signed = activeMandate(state, agent.id);

  return (
    <>
      <header className="agent-head">
        <button className="icon-btn back-btn" aria-label="Back to agents" onClick={back}><Icon name="chevronLeft" size={20} /></button>
        <AgentOrb name={agent.name} color={agent.color} size={52} paused={agent.paused} />
        <div className="grow stack-xs">
          <h1 className="title-2 ellipsis">{agent.name}</h1>
          <span className="footnote muted ellipsis capitalize">{signed?.mandate.item ?? "No job yet"}</span>
        </div>
        <div className="stack-xs" style={{ alignItems: "flex-end" }}>
          <Money value={agent.balance} size="body" />
          <span className={`badge ${status.tone}`}><span className="dot" />{status.text}</span>
        </div>
      </header>

      <Segmented<View>
        value={view}
        onChange={setView}
        options={[
          { value: "chat", label: "Chat" },
          { value: "rules", label: "Rules & settings" },
          { value: "activity", label: "Activity" },
        ]}
      />

      {view === "chat" && <Chat state={state} agent={agent} act={act} refresh={refresh} show={show} setSheet={setSheet} />}
      {view === "rules" && <RulesView state={state} agent={agent} act={act} setSheet={setSheet} />}
      {view === "activity" && <ActivityView state={state} agent={agent} setSheet={setSheet} />}
    </>
  );
}

/* ====================================== Chat ====================================== */

function Chat({ state, agent, act, refresh, show, setSheet }: {
  state: AppState; agent: Pocket; act: Act; refresh: () => Promise<void> | void; show: (t: string, e?: boolean) => void; setSheet: (s: SheetState) => void;
}) {
  const [text, setText] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = state.chats.filter((c) => c.agentId === agent.id);
  const signed = activeMandate(state, agent.id);

  // Jump to the latest message on open, and follow new ones.
  useLayoutEffect(() => {
    const el = endRef.current?.closest(".screen");
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pendingText]);

  const send = async (t: string) => {
    const msg = t.trim();
    if (!msg || busy) return;
    setText("");
    setPendingText(msg);
    setBusy(true);
    try {
      const r = await api<{ found?: FindResult }>(`/api/agents/${agent.id}/chat`, { text: msg });
      await refresh();
      if (r.found) setSheet({ kind: "found", id: agent.id, result: r.found });
    } catch (e) {
      show((e as Error).message, true);
      setText(msg);
    } finally {
      setPendingText(null);
      setBusy(false);
    }
  };

  const decide = (id: string, approve: boolean, auth?: Signature) => {
    setBusy(true);
    return act(() => api(`/api/proposals/${id}/${approve ? "approve" : "decline"}`, approve ? { auth } : {}), approve ? "Signed" : "Kept your rules").finally(() => setBusy(false));
  };

  const suggestions = [
    "What are your rules?",
    signed ? "Check the store now" : null,
    signed && state.channel3?.enabled ? "Find it in real stores" : null,
    signed ? `Go up to ${money(Math.round(signed.mandate.maxUnitPrice * 1.4))} just this once` : null,
    state.pockets.length > 1 ? `Move $20 from ${state.pockets.find((p) => p.id !== agent.id)?.name}` : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <div className="thread" aria-live="polite">
        {messages.length === 0 && (
          <div className="card empty">
            <p className="subhead">Say hi to {agent.name}.</p>
            <p className="footnote muted">Ask about its rules, ask it to check now, or ask it to bend a rule. It can only propose; you sign.</p>
          </div>
        )}
        {messages.map((m) => <Message key={m.id} m={m} state={state} agent={agent} act={act} busy={busy} decide={decide} setSheet={setSheet} />)}
        {pendingText && (
          <>
            <div className="bubble-row me"><div className="bubble me">{pendingText}</div></div>
            <div className="bubble-row"><AgentOrb name={agent.name} color={agent.color} size={26} /><div className="bubble agent typing"><i /><i /><i /></div></div>
          </>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer glass">
        <div className="suggest">
          {suggestions.map((s) => <button key={s} className="chip btnlike" disabled={busy} onClick={() => send(s)}>{s}</button>)}
        </div>
        <form className="composer-row" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${agent.name}`} aria-label={`Message ${agent.name}`} maxLength={600} />
          <button className="icon-btn send-btn" type="submit" disabled={busy || !text.trim()} aria-label="Send" style={{ "--orb": agent.color } as React.CSSProperties}>
            {busy ? <span className="spinner" /> : <Icon name="send" size={18} />}
          </button>
        </form>
      </div>
    </>
  );
}

function Message({ m, state, agent, act, busy, decide, setSheet }: {
  m: ChatMessage; state: AppState; agent: Pocket; act: Act; busy: boolean; decide: (id: string, approve: boolean, auth?: Signature) => unknown; setSheet: (s: SheetState) => void;
}) {
  const proposal = m.proposalId ? state.proposals.find((p) => p.id === m.proposalId) : undefined;
  const purchase = m.purchaseId ? state.purchases.find((p) => p.id === m.purchaseId) : undefined;

  if (m.from === "system") {
    return <div className="sys-note"><Icon name="lock" size={13} /><span>{m.text} <span className="muted">· {when(m.at)}</span></span></div>;
  }
  const mine = m.from === "user";
  return (
    <div className={`bubble-row ${mine ? "me" : ""}`}>
      {!mine && <AgentOrb name={agent.name} color={agent.color} size={26} />}
      <div className="stack-sm bubble-col">
        <div className={`bubble ${mine ? "me" : "agent"}`} style={mine ? undefined : ({ "--orb": agent.color } as React.CSSProperties)}>
          {m.text}
        </div>
        {purchase && <PurchaseChip p={purchase} act={act} onOpen={() => setSheet({ kind: "purchase", id: purchase.id })} />}
        {proposal && <ProposalCard p={proposal} color={agent.color} busy={busy} onApprove={(auth) => decide(proposal.id, true, auth)} onDecline={() => decide(proposal.id, false)} />}
        <span className={`caption muted ${mine ? "right" : ""}`}>{when(m.at)}</span>
      </div>
    </div>
  );
}

function PurchaseChip({ p, act, onOpen }: { p: Purchase; act: Act; onOpen: () => void }) {
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
        <SignButton title={`Buy for ${money(p.total)}`} detail={p.title} onSigned={(auth) => act(() => api(`/api/purchases/${p.id}/approve`, { auth }), "Approved")}>Sign to buy for {money(p.total)}</SignButton>
      )}
    </div>
  );
}

/* ====================================== Rules & settings ====================================== */

function RulesView({ state, agent, act, setSheet }: { state: AppState; agent: Pocket; act: Act; setSheet: (s: SheetState) => void }) {
  const signed = activeMandate(state, agent.id);
  const ex = state.exceptions.find((e) => e.agentId === agent.id);
  const history = state.retiredMandates.filter((m) => m.mandate.pocketId === agent.id).slice().reverse();
  const set = (patch: Partial<Pocket>, ok: string) => act(() => api(`/api/agents/${agent.id}/settings`, patch), ok);

  return (
    <div className="stack">
      {ex && (
        <div className="card callout warn">
          <strong className="headline">Exception active</strong>
          <p className="subhead">{ex.scope === "once" ? "For the next purchase only." : `Until ${new Date(ex.until!).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}.`} Your original rules come back after.</p>
          <button className="btn sm glass-btn" onClick={() => act(() => api(`/api/agents/${agent.id}/end-exception`, {}), "Back to your original rules")}>End it now</button>
        </div>
      )}

      {signed ? (
        <div className="card stack-sm">
          <div className="row between">
            <span className="kicker">One job</span>
            <span className="badge blue"><Icon name="check" size={13} stroke={2.4} />Signed</span>
          </div>
          <strong className="headline capitalize">{signed.mandate.item}</strong>
          <MandateChips m={signed.mandate} />
          <p className="footnote muted">“{signed.mandate.instruction}”</p>
          <span className="mono muted">sig …{signed.signature.slice(-16)}</span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm glass-btn" onClick={() => setSheet({ kind: "job", id: agent.id })}><Icon name="pencil" size={15} />Rewrite job</button>
            <span className="footnote muted">Or ask {agent.name} in chat to bend a rule.</span>
          </div>
        </div>
      ) : (
        <button className="card empty tappable" onClick={() => setSheet({ kind: "job", id: agent.id })}>
          <p className="subhead">{agent.name} has no job yet.</p>
          <span className="btn sm primary">Give {agent.name} a job</span>
        </button>
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
        <div className="row between">
          <div className="stack-xs"><span className="headline">{agent.paused ? "Paused" : "Can spend"}</span><span className="footnote muted">Pause just {agent.name}. Your other agents keep going.</span></div>
          <Switch on={!agent.paused} onChange={() => set({ paused: !agent.paused }, agent.paused ? `${agent.name} resumed` : `${agent.name} paused`)} label={`${agent.name} can spend`} />
        </div>
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
          <p className="caption muted">Every version stays signed and on record, so old purchases can always be checked against the rules in force at the time.</p>
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
