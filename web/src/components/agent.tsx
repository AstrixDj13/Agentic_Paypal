import type { AppState, Pocket, Proposal } from "../api";
import { Icon } from "./Icon";
import { SignButton, type Signature } from "./lock";

export const AGENT_COLORS = ["#0070e0", "#7c4dff", "#e5489b", "#ff7a1a", "#19a35b", "#0aa5a5", "#d4a106", "#e5484d"];

/* ------------------------------------ Orb ------------------------------------ */

/** The agent's face: a glossy coloured dot with its initial. Pulses when it needs you. */
export function AgentOrb({ name, color, size = 44, pulse = false, paused = false }: { name: string; color?: string; size?: number; pulse?: boolean; paused?: boolean }) {
  const c = color ?? AGENT_COLORS[0];
  return (
    <span
      className={`orb ${pulse ? "pulse" : ""} ${paused ? "paused" : ""}`}
      style={{ "--orb": c, width: size, height: size, fontSize: size * 0.42 } as React.CSSProperties}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/* ------------------------------------ Status & unread ------------------------------------ */

export function activeMandate(state: AppState, agentId: string) {
  return state.mandates.find((m) => m.mandate.pocketId === agentId);
}

export function pendingFor(state: AppState, agentId: string) {
  const proposals = state.proposals.filter((p) => p.agentId === agentId && p.status === "pending").length;
  const approvals = state.purchases.filter((p) => p.pocketId === agentId && p.status === "needs_approval").length;
  return proposals + approvals;
}

/** "Ask me about anything" counts every unread agent message; "only money" counts only ones that need you. */
export function unreadFor(state: AppState, agent: Pocket) {
  const since = agent.lastReadAt ? Date.parse(agent.lastReadAt) : 0;
  return state.chats.filter((c) => c.agentId === agent.id && c.from !== "user" && Date.parse(c.at) > since && (agent.askMode === "anything" || c.needsYou)).length;
}

export function agentStatus(state: AppState, agent: Pocket): { text: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (state.killSwitch) return { text: "All agents paused", tone: "danger" };
  if (agent.paused) return { text: "Paused", tone: "danger" };
  if (pendingFor(state, agent.id)) return { text: "Waiting on you", tone: "warn" };
  if (!activeMandate(state, agent.id)) return { text: "Needs a job", tone: "neutral" };
  if (state.exceptions.some((e) => e.agentId === agent.id)) return { text: "Exception active", tone: "warn" };
  return { text: "Watching", tone: "ok" };
}

/* ------------------------------------ Proposal card ------------------------------------ */

const SCOPE_LABEL: Record<NonNullable<Proposal["scope"]>, string> = { once: "Just this once", until: "Temporary", always: "From now on" };

/** A change the agent prepared. Nothing happens until the user holds to sign. */
export function ProposalCard({ p, color, onApprove, onDecline, busy }: { p: Proposal; color?: string; onApprove: (sig: Signature) => unknown; onDecline: () => void; busy?: boolean }) {
  const until = p.until ? new Date(p.until).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "";
  return (
    <div className={`proposal ${p.status}`} style={{ "--orb": color } as React.CSSProperties}>
      <div className="row between">
        <span className="kicker">{p.kind === "transfer" ? "Move money" : p.kind === "job" ? "New job" : "Rule change"} · needs your signature</span>
        {p.kind === "rule_change" && p.scope && <span className="badge neutral">{SCOPE_LABEL[p.scope]}{p.scope === "until" && until ? ` · until ${until}` : ""}</span>}
      </div>
      <div className="diff">
        {p.diff.map((d) => (
          <div key={d.label} className="diff-row">
            <span className="muted footnote">{d.label}</span>
            <span className="diff-vals"><s className="muted">{d.from}</s><Icon name="chevronRight" size={14} /><strong>{d.to}</strong></span>
          </div>
        ))}
      </div>
      {p.retryProductId && p.status === "pending" && <p className="footnote muted">After you sign, I'll go back for the item.</p>}
      {p.kind === "job" && p.status === "pending" && <p className="footnote muted">One agent, one job. {p.diff[0]?.from !== "–" ? "The old job retires and stays on record." : ""} After you sign, I'll start.</p>}
      {p.status === "pending" ? (
        <div className="stack-sm">
          <SignButton title={p.kind === "transfer" ? "Sign to move money" : p.kind === "job" ? "Sign the new job" : "Sign the rule change"} detail={p.summary} onSigned={onApprove} disabled={busy}>Sign with PIN or Face ID</SignButton>
          <button className="btn ghost block sm" disabled={busy} onClick={onDecline}>No, keep my rules</button>
        </div>
      ) : (
        <span className={`badge ${p.status === "approved" ? "ok" : "neutral"}`}>
          <Icon name={p.status === "approved" ? "check" : "close"} size={13} stroke={2.4} />
          {p.status === "approved" ? "Signed" : p.status === "declined" ? "Declined" : "Replaced by a newer proposal"}
        </span>
      )}
    </div>
  );
}
