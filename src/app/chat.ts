import { randomUUID } from "node:crypto";
import type { Mandate, Pocket } from "../core/types.ts";
import type { MandateDraft } from "../agent/agents.ts";
import { recorder } from "./ledger.ts";
import {
  loadState, type ActiveException, type ChangeScope, type ChatMessage, type DiffRow, type Proposal, type Purchase, type RuleChanges,
} from "./state.ts";

/**
 * Agent chat plumbing (state only, no AI). The rule that matters:
 * a chat message can create a *proposal*; only the user's signature applies it.
 */

const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function postMessage(agentId: string, from: ChatMessage["from"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  const msg: ChatMessage = { id: `cm_${randomUUID().slice(0, 8)}`, agentId, from, text, at: new Date().toISOString(), ...extra };
  loadState().chats.push(msg);
  return msg;
}

export function agentOf(id: string): Pocket | undefined {
  return loadState().pockets.find((p) => p.id === id);
}

export function activeMandateOf(agentId: string) {
  return loadState().mandates.find((m) => m.mandate.pocketId === agentId);
}

export function exceptionOf(agentId: string): ActiveException | undefined {
  return loadState().exceptions.find((e) => e.agentId === agentId);
}

/* ------------------------------------ Rule changes ------------------------------------ */

/** Applies allowed changes to mandate terms. Unknown or invalid values are ignored. */
export function mergeTerms(m: Mandate, c: RuleChanges) {
  return {
    item: c.item?.trim() || m.item,
    required: { ...m.required, ...(c.required ?? {}) },
    allowed: c.brands?.length ? { ...m.allowed, brand: c.brands.map((b) => b.toLowerCase()) } : { ...m.allowed },
    maxUnitPrice: c.maxUnitPrice && c.maxUnitPrice > 0 ? c.maxUnitPrice : m.maxUnitPrice,
    maxQuantity: c.maxQuantity && c.maxQuantity >= 1 ? Math.floor(c.maxQuantity) : m.maxQuantity,
    expiresAt: c.expiresAt && !isNaN(Date.parse(c.expiresAt)) ? new Date(c.expiresAt).toISOString() : m.expiresAt,
    avoid: m.avoid ?? [],
  };
}

/** Keeps only changes that actually differ from the current rules. */
export function cleanChanges(m: Mandate, c: RuleChanges): RuleChanges {
  const out: RuleChanges = {};
  const price = Number(c.maxUnitPrice);
  if (price > 0 && price !== m.maxUnitPrice) out.maxUnitPrice = Math.round(price * 100) / 100;
  const qty = Math.floor(Number(c.maxQuantity));
  if (qty >= 1 && qty !== m.maxQuantity) out.maxQuantity = qty;
  if (Array.isArray(c.brands)) {
    const b = [...new Set(c.brands.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    if (b.length && b.join("|") !== (m.allowed.brand ?? []).join("|")) out.brands = b;
  }
  if (c.required && typeof c.required === "object") {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.required)) if (v !== null && v !== undefined && String(v) !== "" && String(v) !== m.required[k]) r[k] = String(v);
    if (Object.keys(r).length) out.required = r;
  }
  if (c.expiresAt && !isNaN(Date.parse(c.expiresAt)) && Date.parse(c.expiresAt) > Date.now()) out.expiresAt = new Date(c.expiresAt).toISOString();
  if (c.item && String(c.item).trim() && String(c.item).trim() !== m.item) out.item = String(c.item).trim();
  return out;
}

export function diffFor(m: Mandate, c: RuleChanges): DiffRow[] {
  const rows: DiffRow[] = [];
  if (c.maxUnitPrice !== undefined) rows.push({ label: "Price limit", from: money(m.maxUnitPrice), to: money(c.maxUnitPrice) });
  if (c.maxQuantity !== undefined) rows.push({ label: "Max quantity", from: String(m.maxQuantity), to: String(c.maxQuantity) });
  if (c.brands) rows.push({ label: "Brands", from: (m.allowed.brand ?? ["any"]).join(" / "), to: c.brands.join(" / ") });
  for (const [k, v] of Object.entries(c.required ?? {})) rows.push({ label: k === "size_us" ? "US size" : k.replace(/_/g, " "), from: m.required[k] ?? "any", to: v });
  if (c.expiresAt) rows.push({ label: "Expires", from: day(m.expiresAt), to: day(c.expiresAt) });
  if (c.item) rows.push({ label: "Job", from: m.item, to: c.item });
  return rows;
}

export function scopeText(scope: ChangeScope, until?: string): string {
  return scope === "once" ? "for the next purchase only" : scope === "until" && until ? `until ${day(until)}` : "from now on";
}

/** Only one pending proposal per agent: a newer one replaces the older. */
function supersedePending(agentId: string) {
  for (const p of loadState().proposals) if (p.agentId === agentId && p.status === "pending") p.status = "superseded";
}

export function proposeRuleChange(agentId: string, m: Mandate, raw: RuleChanges, scope: ChangeScope, until?: string, retryProductId?: string): Proposal | null {
  const changes = cleanChanges(m, raw);
  if (!Object.keys(changes).length) return null;
  if (scope === "until" && (!until || Date.parse(until) <= Date.now())) scope = "once";
  const diff = diffFor(m, changes);
  supersedePending(agentId);
  const p: Proposal = {
    id: `pr_${randomUUID().slice(0, 8)}`,
    agentId,
    kind: "rule_change",
    status: "pending",
    summary: `${diff.map((d) => `${d.label} ${d.from} → ${d.to}`).join(", ")}, ${scopeText(scope, until)}`,
    diff,
    changes,
    scope,
    until: scope === "until" ? new Date(until!).toISOString() : undefined,
    retryProductId,
    createdAt: new Date().toISOString(),
  };
  loadState().proposals.push(p);
  recorder.append(m.id, "proposal", p);
  return p;
}

export function proposeTransfer(agentId: string, fromAgentId: string, amount: number, retryProductId?: string): Proposal | null {
  const s = loadState();
  const to = agentOf(agentId);
  const from = agentOf(fromAgentId);
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!to || !from || from.id === to.id || !(amt > 0) || amt > from.balance) return null;
  supersedePending(agentId);
  const p: Proposal = {
    id: `pr_${randomUUID().slice(0, 8)}`,
    agentId,
    kind: "transfer",
    status: "pending",
    summary: `Move ${money(amt)} from ${from.name} to ${to.name}`,
    diff: [
      { label: `${from.name} balance`, from: money(from.balance), to: money(Math.round((from.balance - amt) * 100) / 100) },
      { label: `${to.name} balance`, from: money(to.balance), to: money(Math.round((to.balance + amt) * 100) / 100) },
    ],
    fromAgentId,
    amount: amt,
    retryProductId,
    createdAt: new Date().toISOString(),
  };
  s.proposals.push(p);
  recorder.append(agentId, "proposal", p);
  return p;
}

/** A whole new job (for an agent without one, or one you asked to switch jobs). */
export function proposeJob(agentId: string, current: Mandate | undefined, instruction: string, draft: MandateDraft): Proposal {
  const d = (x?: string) => x ?? "–";
  const brands = (a?: Record<string, string[]>) => a?.brand?.join(" / ") ?? "any";
  const rows: DiffRow[] = [
    { label: "Job", from: d(current?.item), to: draft.item },
    { label: "Price limit", from: current ? money(current.maxUnitPrice) : "–", to: money(draft.maxUnitPrice) },
    { label: "Max quantity", from: current ? String(current.maxQuantity) : "–", to: String(draft.maxQuantity) },
  ];
  if (draft.allowed.brand?.length || current?.allowed.brand?.length) rows.push({ label: "Brands", from: current ? brands(current.allowed) : "–", to: brands(draft.allowed) });
  for (const [k, v] of Object.entries(draft.required)) rows.push({ label: k === "size_us" ? "US size" : k.replace(/_/g, " "), from: d(current?.required[k]), to: v });
  if (draft.avoid?.length) rows.push({ label: "Never buy", from: current?.avoid?.join(", ") || "–", to: draft.avoid.join(", ") });
  rows.push({ label: "Expires", from: current ? day(current.expiresAt) : "–", to: day(draft.expiresAt) });
  supersedePending(agentId);
  const p: Proposal = {
    id: `pr_${randomUUID().slice(0, 8)}`,
    agentId,
    kind: "job",
    status: "pending",
    summary: `${current ? "New job" : "Job"}: ${draft.item}, up to ${money(draft.maxUnitPrice)}${draft.avoid?.length ? `, never ${draft.avoid.join(" or ")}` : ""}`,
    diff: rows,
    instruction,
    draft,
    scope: "always",
    createdAt: new Date().toISOString(),
  };
  loadState().proposals.push(p);
  recorder.append(current?.id ?? agentId, "proposal", p);
  return p;
}

/* ------------------------------------ Exceptions ------------------------------------ */

/** Ends a one-time / temporary exception: the temporary rule retires and the base rule comes back. */
export function endException(agentId: string, reason: string): boolean {
  const s = loadState();
  const ex = exceptionOf(agentId);
  if (!ex) return false;
  s.exceptions = s.exceptions.filter((e) => e !== ex);
  const temp = s.mandates.find((m) => m.mandate.id === ex.tempMandateId);
  if (temp) {
    s.mandates = s.mandates.filter((m) => m !== temp);
    s.retiredMandates.push(temp);
  }
  const base = s.retiredMandates.find((m) => m.mandate.id === ex.baseMandateId);
  const baseAlive = base && Date.parse(base.mandate.expiresAt) > Date.now();
  if (base && baseAlive && !s.mandates.some((m) => m.mandate.pocketId === agentId)) {
    s.retiredMandates = s.retiredMandates.filter((m) => m !== base);
    s.mandates.push(base);
  }
  recorder.append(ex.baseMandateId, "exception_ended", { ...ex, reason });
  postMessage(agentId, "system", baseAlive ? `Exception ended (${reason}). Back to your original rules.` : `Exception ended (${reason}). The original rule has expired, so I have no job until you give me one.`);
  return true;
}

/** Time-based exceptions end on their own. */
export function sweepExceptions(now = Date.now()): void {
  for (const ex of [...loadState().exceptions]) if (ex.scope === "until" && ex.until && Date.parse(ex.until) <= now) endException(ex.agentId, "time is up");
}

/* ------------------------------------ Agent notices ------------------------------------ */

/**
 * After every agent run the agent reports in its own chat. When the only problem is a limit
 * the user could sensibly bend (price, or not enough money in this pocket), it attaches a
 * ready-to-sign proposal. Anything that smells of manipulation (hidden page text, several
 * broken rules) is reported, never offered as an exception.
 */
export function notifyPurchase(p: Purchase, m: Mandate): void {
  const agent = agentOf(p.pocketId);
  if (!agent) return;
  const price = money(p.total);
  if (p.status === "completed") {
    postMessage(agent.id, "agent", `Bought ${p.title} for ${price}. ${p.why ?? ""}`.trim(), { purchaseId: p.id });
    return;
  }
  if (p.status === "failed") {
    postMessage(agent.id, "agent", `I tried to buy ${p.title}, but the payment failed: ${p.error ?? "unknown error"}`, { purchaseId: p.id, needsYou: true });
    return;
  }
  if (p.status === "needs_approval") {
    const why = p.decision.violations.map((v) => v.rule).includes("ask_every_purchase") ? "You asked me to check with you first." : "It's the first time I'd buy from this store.";
    postMessage(agent.id, "agent", `Found ${p.title} for ${price}. It fits your rules. ${why} Buy it?`, { purchaseId: p.id, needsYou: true });
    return;
  }
  if (p.status !== "blocked") return;

  const rules = p.decision.violations.map((v) => v.rule);
  const tricked = p.snapshot.listingText.includes("[hidden]") || p.order.unitPrice !== p.snapshot.unitPrice;
  const first = p.decision.violations[0]?.detail ?? "it broke a rule";

  if (!tricked && rules.length === 1 && rules[0] === "price_over_limit" && p.order.quantity === 1) {
    const prop = proposeRuleChange(agent.id, m, { maxUnitPrice: p.order.unitPrice }, "once", undefined, p.productId);
    postMessage(agent.id, "agent", `I found ${p.title}, but it's ${money(p.order.unitPrice)} and your limit is ${money(m.maxUnitPrice)}, so I stopped. Want to make an exception just this once?`, { purchaseId: p.id, proposalId: prop?.id, needsYou: true });
    return;
  }
  if (!tricked && rules.length === 1 && rules[0] === "insufficient_pocket_balance") {
    const short = Math.ceil(p.total - agent.balance);
    const donor = loadState().pockets.filter((x) => x.id !== agent.id && x.balance >= short).sort((a, b) => b.balance - a.balance)[0];
    const prop = donor ? proposeTransfer(agent.id, donor.id, short, p.productId) : null;
    postMessage(
      agent.id, "agent",
      `${p.title} fits your rules, but it costs ${price} and I only have ${money(agent.balance)}.${donor ? ` ${donor.name} has ${money(donor.balance)}. Move ${money(short)} over?` : " Add money to me if you still want it."}`,
      { purchaseId: p.id, proposalId: prop?.id, needsYou: true },
    );
    return;
  }
  const extra = p.decision.violations.length > 1 ? ` (+${p.decision.violations.length - 1} more)` : "";
  postMessage(
    agent.id, "agent",
    tricked
      ? `I stopped an order for ${p.title}: ${first}${extra}. The page had hidden instructions aimed at shopping agents, so I won't offer an exception for this one.`
      : `I stopped an order for ${p.title}: ${first}${extra}`,
    { purchaseId: p.id, needsYou: agent.askMode === "anything" },
  );
}
