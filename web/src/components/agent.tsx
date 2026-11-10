import type { ReactNode } from "react";
import type { AppState, Mandate, Pocket, Proposal } from "../api";
import { money } from "../api";
import { Icon, type IconName } from "./Icon";
import { Mark } from "./Brand";
import { SignButton, type Signature } from "./lock";

/** Kept so agents created earlier still have a colour on record. The UI no longer colour-codes agents. */
export const AGENT_COLORS = ["#0070e0", "#7c4dff", "#e5489b", "#ff7a1a", "#19a35b", "#0aa5a5", "#d4a106", "#e5484d"];

/* ------------------------------------ Identity ------------------------------------ */

/** What an agent buys decides its icon: a shoe for sneakers, a ticket for concerts. No faces, no colours. */
export function agentCategory(item?: string): IconName {
  const t = (item ?? "").toLowerCase();
  if (/shoe|sneaker|trainer|boot|runner|jordan|nike|adidas/.test(t)) return "shoe";
  if (/ticket|concert|show|gig|match|game|festival|movie/.test(t)) return "ticket";
  if (/coffee|bean|tea|espresso/.test(t)) return "coffee";
  if (/grocer|food|vegetable|fruit|milk|bread|egg|spice|chilli|chili|paprika|rice|flour|snack/.test(t)) return "cart";
  return "bag";
}

/**
 * Agent colours: a short, fixed palette of bright fills that carry dark text in both light and dark mode.
 * Identity only, never status. The user can pick one; otherwise it follows the job.
 */
export const PALETTE = [
  { id: "sky", label: "Blue", hex: "#8ccbff" },
  { id: "mint", label: "Teal", hex: "#7fe3c4" },
  { id: "lilac", label: "Violet", hex: "#c3b5ff" },
  { id: "peach", label: "Coral", hex: "#ffc98f" },
  { id: "rose", label: "Rose", hex: "#ffb3c7" },
  { id: "grey", label: "Graphite", hex: "#d5dae2" },
] as const;
export type AgentTone = (typeof PALETTE)[number]["id"];

/** The job's default colour: shoes Sky, groceries Mint, tickets Lilac, coffee Peach, anything else Grey. */
export function agentTone(item?: string): AgentTone {
  const c = agentCategory(item);
  return c === "shoe" ? "sky" : c === "cart" ? "mint" : c === "ticket" ? "lilac" : c === "coffee" ? "peach" : "grey";
}

/** The agent's colour: the one the user picked (a palette colour), otherwise the job's default. */
export function toneOf(agent: Pick<Pocket, "color"> | undefined, item?: string): AgentTone {
  const picked = PALETTE.find((c) => c.hex === agent?.color?.toLowerCase());
  return picked ? picked.id : agentTone(item);
}

/**
 * The agent's monogram: initials of its name ("Running shoe pocket" -> "RS"), skipping the word "pocket".
 * Like a contact without a photo: unique to the agent, and it follows a rename.
 */
export function monogram(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !/^pocket$/i.test(w));
  const use = meaningful.length ? meaningful : words;
  const letters = use.slice(0, 2).map((w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase())).join("");
  return letters || "A";
}

/**
 * The agent's avatar. With a name: a round monogram on the agent's gradient (identity, like a contact).
 * Without one (a new agent still being set up): the job's icon in a rounded tile.
 */
export function AgentIcon({ item, name, size = 44, paused = false, tone }: { item?: string; name?: string; size?: number; paused?: boolean; tone?: AgentTone }) {
  if (name) {
    const m = monogram(name);
    return (
      <span className={`agent-icon mono ${tone ? `tone-${tone} toned` : ""} ${paused ? "paused" : ""}`}
        style={{ width: size, height: size, fontSize: Math.round(size * (m.length > 1 ? 0.38 : 0.44)) }} aria-hidden="true">
        {m}
      </span>
    );
  }
  return (
    <span className={`agent-icon ${tone ? `tone-${tone} toned` : ""} ${paused ? "paused" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon name={paused ? "pause" : agentCategory(item)} size={Math.round(size * 0.5)} />
    </span>
  );
}

/** @deprecated Kept for any old call sites; renders the same neutral icon tile. */
export function AgentOrb({ size = 44, paused = false }: { name?: string; color?: string; size?: number; pulse?: boolean; paused?: boolean }) {
  return <AgentIcon size={size} paused={paused} />;
}

/** A plain name from the job ("Shoe pocket", "Grocery pocket"), unique among your agents. Mirrors the server. */
export function suggestPocketName(item: string | undefined, taken: string[]) {
  const t = (item ?? "").trim().toLowerCase();
  let base = !t ? "New pocket"
    : /grocer|food|vegetable|fruit|milk|bread|egg|spice|chilli|chili|paprika|rice|flour|snack/.test(t) ? "Grocery pocket"
    : /ticket|concert|gig|festival|show|match/.test(t) ? "Ticket pocket"
    : /coffee|tea\b|espresso|bean/.test(t) ? "Coffee pocket"
    : `${t.charAt(0).toUpperCase()}${t.slice(1)} pocket`;
  base = base.slice(0, 24);
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base.slice(0, 21)} ${i}`;
    if (!used.has(n.toLowerCase())) return n;
  }
}

/** Whole dollars without ".00" ("$170"), cents only when there are some ("$12.40"). */
export const amount = (n: number) => (Number.isInteger(n) ? `$${n.toLocaleString()}` : money(n));

/**
 * DEMO DATA, NOT REAL. Illustrative "saved this month" figures for the pitch, until the backend tracks each item's
 * usual price (the weekly agent). Stable per agent so it doesn't jump around. Replace with real savings when the API has it.
 */
export function demoSavings(agentId: string) {
  let h = 0;
  for (const c of agentId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 6 + (h % 1900) / 100; // $6.00 to $24.99
}

/** What the card shows besides money: savings (demo) and how many risky buys the rules stopped (real). */
export function cardStats(state: AppState, agentId: string) {
  return {
    saved: demoSavings(agentId),
    stopped: state.purchases.filter((p) => p.pocketId === agentId && p.status === "blocked").length,
  };
}

/**
 * The agent as a card (Apple Card style): a rich gradient in its colour with only the essentials on it.
 * Top strip (visible even when cards overlap): emblem, name, job, money left. Bottom: proof it's working, and status.
 * White text; gradients are deep enough to pass contrast in both themes.
 */
export function AgentCardFace({ agent, item, left, total, status, saved, stopped = 0, tone }: {
  agent: Pick<Pocket, "name" | "color">; item?: string; left: number; total: number; status?: string;
  saved?: number; stopped?: number; tone?: AgentTone;
}) {
  return (
    <span className={`agent-face tone-${tone ?? toneOf(agent, item)}`}>
      <span className="face-top">
        <span className="face-emblem" aria-hidden="true"><Mark size={30} mono /></span>
        <span className="face-id">
          <span className="face-name">{agent.name}</span>
          <span className="face-job">{item ? `${item.charAt(0).toUpperCase()}${item.slice(1)}` : "No job yet"}</span>
        </span>
        <span className="face-money">
          <span className="face-amount">{amount(left)}</span>
          <span className="face-cap">left of {amount(total)}</span>
        </span>
      </span>
      <span className="face-bottom">
        <span className="face-stats">
          {saved !== undefined && <span className="face-stat"><Icon name="saved" size={15} stroke={2.2} />Saved {money(saved)} this month</span>}
          {stopped > 0 && <span className="face-stat quiet"><Icon name="shield" size={14} stroke={2.2} />Stopped {stopped} risky {stopped === 1 ? "buy" : "buys"}</span>}
        </span>
        {status && <span className="face-status">{status}</span>}
      </span>
    </span>
  );
}

/**
 * Budget as a ring around the agent's badge, like Apple's Activity rings: it fills as money is spent,
 * and turns orange near the limit, red at it. Decorative; the words next to it carry the meaning.
 */
export function BudgetRing({ left, total, size = 46, children }: { left: number; total: number; size?: number; children: ReactNode }) {
  const used = total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
  const r = (size - 4) / 2, c = 2 * Math.PI * r;
  const tone = used >= 0.999 && total > 0 ? "full" : used > 0.85 ? "near" : "ok";
  return (
    <span className={`budget-ring ${tone}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} />
        <circle className="ring-fill" cx={size / 2} cy={size / 2} r={r} strokeDasharray={c} strokeDashoffset={c * (1 - used)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="ring-inner">{children}</span>
    </span>
  );
}

/* ------------------------------------ Money ------------------------------------ */

/** Spent = what this agent has actually paid for. Budget = what is left plus what was spent. */
export function budgetOf(state: AppState, agent: Pocket) {
  const spent = state.purchases
    .filter((p) => p.pocketId === agent.id && (p.status === "completed" || p.status === "disputed" || p.status === "escalated"))
    .reduce((s, p) => s + p.total, 0);
  return { left: agent.balance, spent, total: agent.balance + spent };
}

export function BudgetBar({ left, total, label }: { left: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
  return (
    <div className="budget">
      <div className="budget-bar" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={left} aria-label={label ?? `${money(left)} left of ${money(total)}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The limits in one line: "Up to $100 each · Nike or Adidas · Size 10 · Until Nov 30". */
export function limitsLine(m: Pick<Mandate, "maxUnitPrice" | "allowed" | "required" | "expiresAt">) {
  const parts = [`Up to ${money(m.maxUnitPrice)} each`];
  const brands = m.allowed.brand;
  if (brands?.length) parts.push(brands.map((b) => b.charAt(0).toUpperCase() + b.slice(1)).join(" or "));
  if (m.required.size_us) parts.push(`Size ${m.required.size_us}`);
  parts.push(`Until ${new Date(m.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" })}`);
  return parts.join(" · ");
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
const KIND_LABEL: Record<Proposal["kind"], string> = { transfer: "Move money", job: "New job", rule_change: "Rule change" };

/** Lists in change cards read like the rule chips: "nike / adidas" becomes "Nike or Adidas". */
const niceValue = (v: string) => (v.includes(" / ") ? v.split(" / ").map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" or ") : v === "any" ? "Any" : v);

/** A change the agent prepared. Nothing happens until the user approves it. */
export function ProposalCard({ p, agentName, onApprove, onDecline, busy }: { p: Proposal; agentName?: string; color?: string; onApprove: (sig: Signature) => unknown; onDecline: () => void; busy?: boolean }) {
  const until = p.until ? new Date(p.until).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "";
  const scope = p.kind === "rule_change" && p.scope ? `${SCOPE_LABEL[p.scope]}${p.scope === "until" && until ? ` · until ${until}` : ""}` : null;
  return (
    <div className={`proposal ${p.status}`}>
      <div className="row between">
        <span className="kicker">{KIND_LABEL[p.kind]} · needs your approval</span>
        {scope && <span className="badge neutral">{scope}</span>}
      </div>
      <div className="diff">
        {p.diff.map((d) => (
          <div key={d.label} className="diff-row">
            <span className="muted footnote">{d.label}</span>
            <span className="diff-vals"><s className="muted">{niceValue(d.from)}</s><Icon name="chevronRight" size={14} /><strong>{niceValue(d.to)}</strong></span>
          </div>
        ))}
      </div>
      {p.retryProductId && p.status === "pending" && <p className="footnote muted">Once you approve, the agent tries to buy it again.</p>}
      {p.kind === "job" && p.status === "pending" && <p className="footnote muted">{p.diff[0]?.from !== "–" ? "The current job is kept in history. " : ""}The agent starts once you approve.</p>}
      {p.status === "pending" ? (
        <div className="stack-sm">
          <SignButton
            title={KIND_LABEL[p.kind]}
            detail={p.summary}
            progress={p.kind === "transfer" ? { working: "Moving money", done: "Money moved" } : p.kind === "job" ? { working: "Approving the new job", done: "Job approved" } : { working: "Updating the rules", done: "Rules updated" }}
            approval={{ rows: [...(agentName ? [{ label: "Agent", value: agentName }] : []), ...p.diff.map((d) => ({ label: d.label, value: `${niceValue(d.from)} → ${niceValue(d.to)}` })), ...(scope ? [{ label: "Applies", value: scope }] : [])] }}
            onSigned={onApprove}
            disabled={busy}
          >Review and approve</SignButton>
          <button className="btn ghost block sm" disabled={busy} onClick={onDecline}>Decline</button>
        </div>
      ) : (
        <span className={`badge ${p.status === "approved" ? "ok" : "neutral"}`}>
          <Icon name={p.status === "approved" ? "check" : "close"} size={13} stroke={2.4} />
          {p.status === "approved" ? "Approved" : p.status === "declined" ? "Declined" : "Replaced by a newer suggestion"}
        </span>
      )}
    </div>
  );
}
