import { randomUUID } from "node:crypto";
import type { AskMode, Pocket } from "../core/types.ts";
import { agentReply } from "../agent/chatBrain.ts";
import type { MandateDraft } from "../agent/agents.ts";
import { channel3Enabled } from "../store/channel3.ts";
import {
  activeMandateOf, agentOf, endException, exceptionOf, mergeTerms, postMessage, proposeJob, proposeRuleChange, proposeTransfer, scopeText, sweepExceptions,
} from "./chat.ts";
import { draftMandate } from "./service.ts";
import { recorder } from "./ledger.ts";
import * as svc from "./service.ts";
import { loadState, saveState, type ChatMessage, type Proposal } from "./state.ts";

/**
 * Agents: each pocket is a helper with a name, a colour, its own money and one signed job.
 * It talks to you in its own chat, can only *propose* changes, and you sign them.
 */

const { UserError } = svc;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

function agentOrThrow(id: string): Pocket {
  const a = agentOf(id);
  if (!a) throw new UserError(`Unknown agent ${id}`);
  return a;
}

/** Like agentOrThrow, but refuses closed agents: they can't chat, take jobs or move money. */
function openAgentOrThrow(id: string): Pocket {
  const a = agentOrThrow(id);
  if (a.closedAt) throw new UserError(`${a.name} is closed. Restore it first.`);
  return a;
}

/* ------------------------------------ Close, restore, delete ------------------------------------ */

/**
 * Close: the agent stops for good (the guard blocks it), its remaining budget is set aside,
 * anything waiting on it is declined, and every record stays. No PIN: closing only stops spending.
 */
export function closeAgent(agentId: string) {
  const a = agentOrThrow(agentId);
  if (a.closedAt) return { agent: a, declined: 0 };
  const s = loadState();
  if (s.purchases.some((p) => p.pocketId === a.id && p.status === "disputed")) {
    throw new UserError("You can close this agent after the refund settles.");
  }
  let declined = 0;
  for (const p of s.purchases) {
    if (p.pocketId !== a.id || p.status !== "needs_approval") continue;
    p.status = "blocked";
    p.decision = { ...p.decision, outcome: "block", violations: [{ rule: "agent_closed", detail: "Declined because you closed this agent." }] };
    recorder.append(p.id, "guard_decision", { ...p.decision, closedByUser: true });
    declined++;
  }
  for (const pr of s.proposals) {
    if (pr.agentId === a.id && pr.status === "pending") { pr.status = "declined"; pr.decidedAt = new Date().toISOString(); declined++; }
  }
  s.exceptions = s.exceptions.filter((e) => e.agentId !== a.id);
  a.closedAt = new Date().toISOString();
  postMessage(a.id, "system", `${a.name} was closed. It won't buy anything. Its records stay, and you can restore it any time.`);
  saveState();
  return { agent: a, declined };
}

/** Restore: lets the agent spend again, so the route requires the user's PIN / Face ID. */
export function restoreAgent(agentId: string) {
  const a = agentOrThrow(agentId);
  if (!a.closedAt) return a;
  delete a.closedAt;
  postMessage(a.id, "system", `${a.name} was restored. It follows the same rules as before.`);
  saveState();
  return a;
}

/** Delete: only for an agent that never tried to buy anything. Anything with a purchase is closed instead. */
export function deleteAgent(agentId: string) {
  const a = agentOrThrow(agentId);
  const s = loadState();
  if (s.purchases.some((p) => p.pocketId === a.id)) {
    throw new UserError("Agents with purchases can't be deleted. Close it instead; its records protect you.");
  }
  s.pockets = s.pockets.filter((p) => p.id !== a.id);
  s.retiredMandates.push(...s.mandates.filter((m) => m.mandate.pocketId === a.id));
  s.mandates = s.mandates.filter((m) => m.mandate.pocketId !== a.id);
  s.proposals = s.proposals.filter((p) => p.agentId !== a.id);
  s.exceptions = s.exceptions.filter((e) => e.agentId !== a.id);
  s.chats = s.chats.filter((c) => c.agentId !== a.id);
  saveState();
  return { ok: true };
}

/* ------------------------------------ Create & settings ------------------------------------ */

export interface NewAgent {
  /** Optional: when blank, the agent is named after its job ("Shoe pocket"). */
  name?: string;
  color?: string;
  amount: number;
  askMode?: AskMode;
  instruction: string;
  draft: MandateDraft;
}

const GROCERY = /grocer|food|vegetable|fruit|milk|bread|egg|spice|chilli|chili|paprika|rice|flour|snack/;
const TICKETS = /ticket|concert|gig|festival|show|match/;

/** A plain name from the job: "Shoe pocket", "Grocery pocket", "Ticket pocket". Unique among your agents. */
export function pocketNameFor(item: string | undefined, taken: string[]) {
  const t = (item ?? "").trim().toLowerCase();
  let base = !t ? "New pocket"
    : GROCERY.test(t) ? "Grocery pocket"
    : TICKETS.test(t) ? "Ticket pocket"
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

function assertNameFree(name: string, exceptId?: string) {
  if (loadState().pockets.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) throw new UserError(`You already have an agent called ${name}.`);
}

/** Name, money, and the one job: created and signed in one step. */
export function createAgent(input: NewAgent) {
  if (!input.instruction?.trim() || !input.draft) throw new UserError("Give your agent a job first.");
  const name = input.name?.trim() ? input.name.trim().slice(0, 24) : pocketNameFor(input.draft.item, loadState().pockets.map((p) => p.name));
  assertNameFree(name);
  const agent = svc.createPocket(name, Number(input.amount), { color: input.color, askMode: input.askMode });
  try {
    const signed = svc.signNewMandate(agent.id, input.instruction, input.draft);
    const m = signed.mandate;
    const ask = agent.askMode === "anything" ? "I'll ask you before every purchase." : "I'll buy on my own inside these rules and only ask you about money.";
    postMessage(agent.id, "agent", `Hi, I'm ${agent.name}. My one job: ${m.item}, up to ${money(m.maxUnitPrice)} each, with ${money(agent.balance)} to spend. ${ask} If anything is out of bounds I stop and tell you here.`);
    saveState();
    return { agent, mandate: signed };
  } catch (e) {
    // Don't leave a jobless agent behind if signing failed.
    const s = loadState();
    s.pockets = s.pockets.filter((p) => p.id !== agent.id);
    saveState();
    throw e;
  }
}

/** Give an existing agent (e.g. one created before agents had jobs) its job. */
export function giveJob(agentId: string, instruction: string, draft: MandateDraft) {
  const agent = openAgentOrThrow(agentId);
  const signed = svc.signNewMandate(agent.id, instruction, draft);
  postMessage(agent.id, "agent", `Got it. My job is now: ${signed.mandate.item}, up to ${money(signed.mandate.maxUnitPrice)} each.`);
  saveState();
  return signed;
}

export function updateAgent(agentId: string, patch: { askMode?: AskMode; paused?: boolean; color?: string; name?: string }) {
  const a = agentOrThrow(agentId);
  if (patch.askMode && patch.askMode !== a.askMode) {
    a.askMode = patch.askMode === "anything" ? "anything" : "money";
    postMessage(a.id, "system", a.askMode === "anything" ? "Setting changed: ask me about anything. I'll check with you before every purchase." : "Setting changed: only ask about money. I'll buy inside my rules on my own.");
  }
  if (typeof patch.paused === "boolean" && patch.paused !== a.paused) {
    a.paused = patch.paused;
    postMessage(a.id, "system", a.paused ? `${a.name} is paused. Nothing will be bought until you resume.` : `${a.name} resumed.`);
  }
  if (patch.color && /^#[0-9a-f]{6}$/i.test(patch.color)) a.color = patch.color;
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 24);
    if (!name) throw new UserError("Give the agent a name.");
    if (name !== a.name) {
      assertNameFree(name, a.id);
      postMessage(a.id, "system", `Renamed from ${a.name} to ${name}.`);
      a.name = name;
    }
  }
  saveState();
  return a;
}

export function markRead(agentId: string) {
  agentOrThrow(agentId).lastReadAt = new Date().toISOString();
  saveState();
}

/* ------------------------------------ Chat ------------------------------------ */

export async function chat(agentId: string, text: string, baseUrl: string): Promise<{ messages: ChatMessage[]; action?: string; found?: unknown }> {
  const agent = openAgentOrThrow(agentId);
  const clean = String(text ?? "").trim().slice(0, 600);
  if (!clean) throw new UserError("Say something to your agent.");
  sweepExceptions();
  const s = loadState();
  const before = s.chats.length;
  const history = s.chats.filter((c) => c.agentId === agentId);
  postMessage(agentId, "user", clean);
  agent.lastReadAt = new Date().toISOString();
  saveState();

  const signed = activeMandateOf(agentId);
  const out = await agentReply(clean, {
    agent,
    mandate: signed?.mandate,
    others: s.pockets.filter((p) => p.id !== agentId && !p.closedAt),
    history,
    realStores: channel3Enabled(),
  });

  // The model only suggests. Here plain code turns a suggestion into a signable card, or says why not.
  // If no card could be made, the reply is replaced so the agent never claims a card that isn't there.
  let proposal: Proposal | null = null;
  let failed: string | null = null;
  if (out.proposal?.kind === "job" || (out.proposal?.kind === "rule_change" && !signed)) {
    const words = out.proposal.kind === "job" ? out.proposal.instruction : clean;
    try {
      const { draft } = await draftMandate(words);
      proposal = proposeJob(agentId, signed?.mandate, words, draft);
    } catch {
      failed = `I couldn't turn that into a job. Tell me the item and a max price, e.g. "chilli powder, not paprika, $10 or less".`;
    }
  } else if (out.proposal?.kind === "rule_change" && signed) {
    const base = exceptionBase(agentId) ?? signed.mandate;
    proposal = proposeRuleChange(agentId, base, out.proposal.changes, out.proposal.scope, out.proposal.until);
    if (!proposal) failed = "That's already my rule, so there's nothing to approve.";
  } else if (out.proposal?.kind === "transfer") {
    const want = out.proposal.fromAgent.trim().toLowerCase();
    const from = s.pockets.find((p) => p.id !== agentId && p.name.toLowerCase() === want);
    proposal = from ? proposeTransfer(agentId, from.id, out.proposal.amount) : null;
    if (!proposal) failed = from ? `${from.name} only has ${money(from.balance)}, so I can't draft that move.` : "I couldn't find that agent, so there's nothing to approve.";
  }
  const reply = failed ?? (proposal ? out.reply : out.reply.replace(/\b(I've|I have) (prepared|drafted)[^.]*\.\s*/i, "")) ?? out.reply;
  postMessage(agentId, "agent", reply.trim() || out.reply, proposal ? { proposalId: proposal.id, needsYou: true } : {});
  saveState();

  let found: unknown;
  // Never act while a card is waiting for the user's signature: it would bury the card.
  if (proposal) return { messages: loadState().chats.slice(before), action: "none" };
  if (out.action === "check_store" && signed) await svc.runAgent(signed.mandate.id, { mode: "careful", baseUrl });
  if (out.action === "find_real" && signed && channel3Enabled()) {
    try { found = await svc.findAndBuy(signed.mandate.id, baseUrl); } catch (e) { postMessage(agentId, "agent", (e as Error).message); saveState(); }
  }
  return { messages: loadState().chats.slice(before), action: out.action, found };
}

/** While an exception is active, new changes are measured against the original rule. */
function exceptionBase(agentId: string) {
  const ex = exceptionOf(agentId);
  if (!ex) return undefined;
  return loadState().retiredMandates.find((m) => m.mandate.id === ex.baseMandateId)?.mandate;
}

/* ------------------------------------ Proposals ------------------------------------ */

function proposalOrThrow(id: string): Proposal {
  const p = loadState().proposals.find((x) => x.id === id);
  if (!p) throw new UserError(`Unknown proposal ${id}`);
  if (p.status !== "pending") throw new UserError(`This proposal was already ${p.status}.`);
  return p;
}

/** The user's signature. This is the only path by which a chat suggestion changes anything. */
export async function approveProposal(id: string, baseUrl: string) {
  const p = proposalOrThrow(id);
  const agent = agentOrThrow(p.agentId);

  if (p.kind === "transfer") {
    transfer(p.fromAgentId!, agent.id, p.amount!, `approved in ${agent.name}'s chat`);
  } else if (p.kind === "job") {
    const signed = svc.signNewMandate(agent.id, p.instruction!, p.draft!);
    postMessage(agent.id, "agent", `Approved. My one job is now: ${signed.mandate.item}, up to ${money(signed.mandate.maxUnitPrice)}${signed.mandate.avoid?.length ? `, never ${signed.mandate.avoid.join(" or ")}` : ""}. I'll check the store.`);
  } else {
    applyRuleChange(p);
  }
  p.status = "approved";
  p.decidedAt = new Date().toISOString();
  recorder.append(p.agentId, "proposal_decision", { proposalId: p.id, status: "approved", summary: p.summary });
  saveState();

  // The agent goes back for the item it had to stop on, or starts on its new job.
  const now = activeMandateOf(agent.id);
  if (now && p.retryProductId) await svc.runAgent(now.mandate.id, { mode: "careful", productId: p.retryProductId, baseUrl });
  else if (now && p.kind === "job") await svc.runAgent(now.mandate.id, { mode: "careful", baseUrl });
  return p;
}

export function declineProposal(id: string) {
  const p = proposalOrThrow(id);
  p.status = "declined";
  p.decidedAt = new Date().toISOString();
  recorder.append(p.agentId, "proposal_decision", { proposalId: p.id, status: "declined", summary: p.summary });
  postMessage(p.agentId, "agent", "Okay, no change. I'll stick to the rules you signed.");
  saveState();
  return p;
}

function applyRuleChange(p: Proposal) {
  const agentId = p.agentId;
  // A new change replaces any exception in force; measure it from the original rule.
  const base = exceptionBase(agentId);
  if (base) endException(agentId, "replaced by a new change");
  const current = activeMandateOf(agentId);
  if (!current) throw new UserError("This agent has no active job to change.");
  const m = current.mandate;
  const terms = mergeTerms(m, p.changes ?? {});
  const scopeLine = scopeText(p.scope ?? "once", p.until);

  if (p.scope === "always") {
    svc.signNewMandate(agentId, `${m.instruction} (changed: ${p.summary})`, terms);
    postMessage(agentId, "system", `Approved. New rules ${scopeLine}: ${p.diff.map((d) => `${d.label} ${d.to}`).join(", ")}.`);
    return;
  }
  const until = p.scope === "until" && p.until ? p.until : undefined;
  const temp = svc.signNewMandate(
    agentId,
    `${m.instruction} (exception ${scopeLine}: ${p.diff.map((d) => `${d.label} ${d.to}`).join(", ")})`,
    { ...terms, expiresAt: until ?? terms.expiresAt },
    { keepException: true },
  );
  loadState().exceptions.push({ agentId, baseMandateId: m.id, tempMandateId: temp.mandate.id, scope: p.scope === "until" ? "until" : "once", until, proposalId: p.id });
  postMessage(agentId, "system", `Approved. Exception ${scopeLine}: ${p.diff.map((d) => `${d.label} ${d.to}`).join(", ")}. Your original rules come back after.`);
}

/** End an exception early from the agent page. */
export function endExceptionNow(agentId: string) {
  agentOrThrow(agentId);
  if (!endException(agentId, "ended by you")) throw new UserError("No exception is active.");
  saveState();
}

/* ------------------------------------ Money between agents ------------------------------------ */

/** Moves money between two agents. Called only after the user approves (sheet or signed proposal). */
export function transfer(fromId: string, toId: string, amount: number, via = "approved by you") {
  const from = openAgentOrThrow(fromId);
  const to = openAgentOrThrow(toId);
  const amt = round2(Number(amount));
  if (from.id === to.id) throw new UserError("Pick a different agent to move money from.");
  if (!(amt > 0)) throw new UserError("Amount must be positive.");
  if (amt > from.balance) throw new UserError(`${from.name} only has ${money(from.balance)}.`);
  from.balance = round2(from.balance - amt);
  to.balance = round2(to.balance + amt);
  const id = `tr_${randomUUID().slice(0, 8)}`;
  recorder.append(id, "transfer", { from: from.id, to: to.id, amount: amt, via });
  postMessage(to.id, "system", `${money(amt)} moved in from ${from.name} (${via}). Balance: ${money(to.balance)}.`);
  postMessage(from.id, "system", `${money(amt)} moved out to ${to.name} (${via}). Balance: ${money(from.balance)}.`);
  saveState();
  return { id, from, to, amount: amt };
}

/** "Check the store now" from the agent page. */
export async function checkNow(agentId: string, baseUrl: string) {
  const signed = activeMandateOf(openAgentOrThrow(agentId).id);
  if (!signed) throw new UserError("Give this agent a job first.");
  return svc.runAgent(signed.mandate.id, { mode: "careful", baseUrl });
}

export async function findReal(agentId: string, baseUrl: string) {
  const signed = activeMandateOf(openAgentOrThrow(agentId).id);
  if (!signed) throw new UserError("Give this agent a job first.");
  return svc.findAndBuy(signed.mandate.id, baseUrl);
}
