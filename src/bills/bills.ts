import { randomUUID } from "node:crypto";
import { checkOrder } from "../core/guard.ts";
import { niceDate } from "../core/format.ts";
import type { Pocket, ProposedOrder, SignedMandate } from "../core/types.ts";
import { activeMandateOf, agentOf, postMessage } from "../app/chat.ts";
import { recorder } from "../app/ledger.ts";
import * as svc from "../app/service.ts";
import { closeAgent } from "../app/agentService.ts";
import { loadState, saveState, type AppState, type Purchase } from "../app/state.ts";
import { BILLERS, DUPLICATE_CATEGORIES, amountFor, billerById, type Biller, type BillerCategory, type BillerKind } from "./catalog.ts";

/**
 * Subscriptions and bills: each recurring payment is its own pocket (agent) with a cap and rules.
 * The merchant is paid from the pocket through PayPal; the user's card is never shared with it.
 *
 *  - Subscriptions: the cap is the agreed price. A higher charge (a price hike) is blocked by the
 *    guard and held until the user approves the new price (PIN) or cancels.
 *  - Bills that vary: "pay if within X% of usual, otherwise ask me", plus a hard cap.
 *  - Trials: the user is told before a free trial turns paid. Silence is safe: an unanswered
 *    trial is not paid.
 *  - Duplicates: two subscriptions that do the same job (Spotify and Apple Music) are pointed out.
 *
 * Every charge goes through the same guard and is written to the same hash-chained record.
 * Discovery and charges are simulated (labelled as such), like the demo stores.
 */


const DAY = 864e5;
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;
const DEFAULT_VARY_PCT = 20;

export interface Sub {
  agentId: string;
  billerId: string;
  name: string;
  kind: BillerKind;
  category: BillerCategory;
  /** Subscriptions: the agreed monthly price. Bills: the usual amount. */
  price: number;
  /** The most the merchant may take in a month (signed into the pocket's mandate). */
  cap: number;
  /** Bills: ask first when the bill is more than this % above usual. */
  varyPct?: number;
  status: "active" | "trial" | "cancelled";
  trialEndsAt?: string;
  nextChargeAt: string;
  lastPaid?: { amount: number; at: string; purchaseId: string };
  addedAt: string;
}

export type AlertType = "price_hike" | "trial_end" | "duplicate" | "unusual";

export interface BillAlert {
  id: string;
  agentId: string;
  type: AlertType;
  status: "pending" | "approved" | "paid" | "held" | "kept" | "cancelled" | "superseded";
  title: string;
  text: string;
  /** What the merchant asked for, what's usual, what the cap allowed, and what Pocket did. */
  asked?: number;
  usual?: number;
  cap?: number;
  did?: string;
  month?: number;
  /** Duplicates: the other pocket doing the same job. */
  otherAgentId?: string;
  purchaseId?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface BillsState { subs: Sub[]; alerts: BillAlert[]; month: number }

type WithBills = AppState & { bills?: BillsState };

export function billsState(s: AppState = loadState()): BillsState {
  const w = s as WithBills;
  w.bills ??= { subs: [], alerts: [], month: 0 };
  return w.bills;
}

const subOf = (agentId: string) => {
  const sub = billsState().subs.find((x) => x.agentId === agentId);
  if (!sub) throw new svc.UserError("This pocket isn't a subscription or bill.");
  return sub;
};
const alertOf = (id: string) => {
  const a = billsState().alerts.find((x) => x.id === id);
  if (!a) throw new svc.UserError("Unknown alert.");
  return a;
};
const liveSubs = () => {
  const s = loadState();
  return billsState(s).subs.filter((x) => x.status !== "cancelled" && s.pockets.some((p) => p.id === x.agentId && !p.closedAt));
};

/* ------------------------------------ Discovery ------------------------------------ */

/** "We found 7 automatic payments on your PayPal": simulated, and labelled so. */
export function discover() {
  const have = new Set(liveSubs().map((x) => x.billerId));
  const found = BILLERS.filter((b) => b.discovered).map((b) => ({
    billerId: b.id, name: b.name, kind: b.kind, category: b.category, price: b.price, approx: b.kind === "bill",
    trial: !!b.trialDays, color: b.color, added: have.has(b.id),
  }));
  const monthly = r2(found.filter((f) => !f.trial).reduce((t, f) => t + f.price, 0));
  return {
    found, count: found.length, monthly, simulated: true as const,
    summary: `We found ${found.length} automatic payments on your PayPal, about ${money(monthly)} a month.`,
    merchants: BILLERS.map((b) => ({ billerId: b.id, name: b.name, kind: b.kind, category: b.category, price: b.price, color: b.color, added: have.has(b.id) })),
  };
}

/* ------------------------------------ Adding pockets ------------------------------------ */

export interface AddItem { billerId: string; cap?: number; varyPct?: number }

function draftFor(b: Biller, cap: number, varyPct: number | undefined) {
  const usual = b.price;
  return {
    item: b.name, required: {}, allowed: {}, maxUnitPrice: cap, maxQuantity: 1, kind: "recurring" as const, cadence: "monthly" as const,
    merchants: [b.id], expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
    ...(b.kind === "bill" ? { askAbove: r2(usual * (1 + (varyPct ?? DEFAULT_VARY_PCT) / 100)) } : {}),
  };
}

function rulesLine(sub: Sub) {
  return sub.kind === "bill"
    ? `I pay ${sub.name} when the bill is within ${sub.varyPct ?? DEFAULT_VARY_PCT}% of usual (about ${money(sub.price)}). Above ${money(r2(sub.price * (1 + (sub.varyPct ?? DEFAULT_VARY_PCT) / 100)))} I ask you first, and never more than ${money(sub.cap)}.`
    : `I pay ${sub.name} up to ${money(sub.cap)} a month and not a cent more.`;
}

/** Turns the chosen merchants into pockets: one agent each, its cap signed (the route needs the PIN). */
export function addSubs(items: AddItem[]) {
  if (!Array.isArray(items) || !items.length) throw new svc.UserError("Pick at least one subscription or bill.");
  const s = loadState();
  const bs = billsState(s);
  const added: Sub[] = [];
  for (const it of items) {
    const b = billerById(String(it?.billerId ?? ""));
    if (!b) throw new svc.UserError(`Unknown merchant ${it?.billerId}.`);
    if (liveSubs().some((x) => x.billerId === b.id)) continue;
    const varyPct = b.kind === "bill" ? Math.max(5, Math.min(100, Math.round(Number(it.varyPct) || DEFAULT_VARY_PCT))) : undefined;
    const cap = r2(Number(it.cap) > 0 ? Number(it.cap) : b.kind === "bill" ? b.price * 2 : b.price);
    const takenNames = s.pockets.filter((p) => !p.closedAt).map((p) => p.name.toLowerCase());
    const name = takenNames.includes(b.name.toLowerCase()) ? `${b.name} bill`.slice(0, 24) : b.name;
    // Three months of money in the pocket to start (the demo funds it; real money would move from PayPal).
    const fund = Math.ceil((b.kind === "bill" ? b.price * (1 + (varyPct ?? DEFAULT_VARY_PCT) / 100) : cap) * 3);
    const agent = svc.createPocket(name, fund, { color: b.color, askMode: "money" });
    agent.kind = "recurring";
    const instruction = b.kind === "bill"
      ? `Pay ${b.name} if it's within ${varyPct}% of usual (about ${money(b.price)}). Otherwise ask me. Never more than ${money(cap)}.`
      : `Pay ${b.name} up to ${money(cap)} a month.`;
    try {
      svc.signNewMandate(agent.id, instruction, draftFor(b, cap, varyPct));
    } catch (e) {
      s.pockets = s.pockets.filter((p) => p.id !== agent.id);
      throw e;
    }
    if (!s.knownMerchants.includes(b.id)) s.knownMerchants.push(b.id);
    const now = Date.now();
    const sub: Sub = {
      agentId: agent.id, billerId: b.id, name: b.name, kind: b.kind, category: b.category, price: b.price, cap,
      ...(varyPct ? { varyPct } : {}),
      status: b.trialDays ? "trial" : "active",
      ...(b.trialDays ? { trialEndsAt: new Date(now + b.trialDays * DAY).toISOString() } : {}),
      nextChargeAt: new Date(now + (b.trialDays ?? b.dueInDays) * DAY).toISOString(),
      addedAt: new Date(now).toISOString(),
    };
    bs.subs.push(sub);
    const trial = sub.status === "trial" ? ` Your free trial turns paid (${money(b.price)}) on ${niceDate(sub.trialEndsAt!)}. I'll check with you before then.` : "";
    postMessage(agent.id, "agent", `Hi, I'm ${agent.name}'s pocket. ${rulesLine(sub)} I pay from my own money through PayPal, so ${b.name} never gets your card.${trial} If they ask for more, I stop and tell you here.`, { intro: true });
    added.push(sub);
  }
  findDuplicates();
  saveState();
  return { added, subs: liveSubs() };
}

/** "You pay for Spotify and Apple Music." Once per pair, and not urgent (it can wait for the weekly check-in). */
function findDuplicates() {
  const bs = billsState();
  const live = liveSubs();
  for (const cat of DUPLICATE_CATEGORIES) {
    const same = live.filter((x) => x.category === cat);
    if (same.length < 2) continue;
    const [a, b] = same;
    const known = bs.alerts.some((al) => al.type === "duplicate" && [al.agentId, al.otherAgentId].includes(a.agentId) && [al.agentId, al.otherAgentId].includes(b.agentId));
    if (known) continue;
    const alert = newAlert({
      agentId: b.agentId, otherAgentId: a.agentId, type: "duplicate",
      title: `You pay for ${a.name} and ${b.name}`,
      text: `You pay for ${a.name} and ${b.name}: ${money(a.price + b.price)} a month for ${cat}. Cancel one, or keep both?`,
      did: "Nothing changed. Both keep working until you decide.",
    });
    postMessage(b.agentId, "agent", alert.text, { needsYou: true, alertId: alert.id });
  }
}

function newAlert(a: Omit<BillAlert, "id" | "status" | "createdAt">): BillAlert {
  const bs = billsState();
  // A newer alert of the same kind replaces an unanswered older one.
  for (const old of bs.alerts) if (old.agentId === a.agentId && old.type === a.type && old.status === "pending") old.status = "superseded";
  const alert: BillAlert = { id: `ba_${randomUUID().slice(0, 8)}`, status: "pending", createdAt: new Date().toISOString(), ...a };
  bs.alerts.unshift(alert);
  return alert;
}

/* ------------------------------------ Charges ------------------------------------ */

function chargeOrder(sub: Sub, signed: SignedMandate, amount: number, month: number): ProposedOrder {
  return {
    mandateId: signed.mandate.id, merchantId: sub.billerId, productId: `bill:${sub.billerId}:${month}`,
    title: `${sub.name} · ${sub.kind === "bill" ? "monthly bill" : "monthly subscription"}`,
    attributes: {}, unitPrice: r2(amount), quantity: 1, currency: "USD",
    reasoning: `${sub.name} asked for ${money(amount)} (simulated ${sub.kind}, month ${month}).`,
  };
}

/** Pays one charge through PayPal from the pocket, recording it like any purchase. */
async function pay(sub: Sub, agent: Pocket, signed: SignedMandate, order: ProposedOrder, decision: ReturnType<typeof checkOrder>, approvedByUser: boolean): Promise<Purchase> {
  const s = loadState();
  const purchase: Purchase = {
    id: `pu_${randomUUID().slice(0, 8)}`, mandateId: signed.mandate.id, pocketId: agent.id, productId: order.productId, title: order.title,
    status: "completed", mode: "careful", order,
    snapshot: {
      url: `simulated://billing/${sub.billerId}`, merchantId: sub.billerId, productId: order.productId, title: order.title, attributes: {},
      unitPrice: order.unitPrice, listingText: `${sub.name} requested ${money(order.unitPrice)} (simulated charge).`, capturedAt: new Date().toISOString(),
    },
    decision: { ...decision, outcome: "allow", violations: [] }, total: order.unitPrice, createdAt: new Date().toISOString(),
  };
  s.purchases.unshift(purchase);
  recorder.append(purchase.id, "page_snapshot", purchase.snapshot);
  recorder.append(purchase.id, "agent_claim", order);
  recorder.append(purchase.id, "guard_decision", { ...purchase.decision, ...(approvedByUser ? { approvedByUser: true } : {}) });
  await svc.executePurchase(purchase);
  if (purchase.status === "completed") {
    purchase.why = `${sub.name}'s monthly charge, inside your rules.`;
    sub.lastPaid = { amount: order.unitPrice, at: purchase.createdAt, purchaseId: purchase.id };
  }
  return purchase;
}

/** One merchant's charge for a simulated month: pay, hold for the user, or stop. */
async function runCharge(sub: Sub, month: number): Promise<{ sub: string; result: string; amount?: number; alertId?: string; purchaseId?: string }> {
  const agent = agentOf(sub.agentId)!;
  const signed = activeMandateOf(sub.agentId);
  if (!signed) return { sub: sub.name, result: "no rules" };
  const b = billerById(sub.billerId)!;

  // A trial: tell the user before it turns paid; silence is safe (an unanswered trial isn't paid).
  if (sub.status === "trial") {
    const bs = billsState();
    const told = bs.alerts.find((a) => a.agentId === sub.agentId && a.type === "trial_end");
    if (!told) {
      const alert = newAlert({
        agentId: sub.agentId, type: "trial_end", title: `${sub.name} trial ends ${niceDate(sub.trialEndsAt!)}`,
        text: `Your free trial of ${sub.name} turns paid (${money(sub.price)} a month) on ${niceDate(sub.trialEndsAt!)}. Keep it, or cancel before then?`,
        asked: sub.price, cap: sub.cap, did: "Nothing paid yet. If you don't answer, I won't pay it.", month,
      });
      postMessage(sub.agentId, "agent", alert.text, { needsYou: true, urgent: true, alertId: alert.id });
      saveState();
      return { sub: sub.name, result: "trial notice", alertId: alert.id };
    }
    if (told.status === "pending") {
      told.did = `${sub.name} asked for its first ${money(sub.price)}. I held it because you haven't said keep.`;
      postMessage(sub.agentId, "agent", `${sub.name} wants its first ${money(sub.price)}. I'm holding it until you say keep or cancel.`, { needsYou: true, alertId: told.id });
      saveState();
      return { sub: sub.name, result: "trial held", alertId: told.id };
    }
    return { sub: sub.name, result: "trial" };
  }

  const amount = amountFor(b, month, sub.price);
  const order = chargeOrder(sub, signed, amount, month);
  const key = `bill_${sub.billerId}_${month}_${randomUUID().slice(0, 4)}`;
  recorder.append(key, "bill_request", { merchant: sub.name, merchantId: sub.billerId, amount, month, simulated: true });
  const decision = checkOrder(signed, order, agent, { ...svc.guardState(agent), askEveryPurchase: false });
  recorder.append(key, "guard_decision", decision);
  const rules = decision.violations.map((v) => v.rule);

  if (decision.outcome === "allow") {
    const p = await pay(sub, agent, signed, order, decision, false);
    recorder.append(key, "bill_decision", { did: p.status === "completed" ? "paid" : "payment_failed", purchaseId: p.id });
    sub.nextChargeAt = new Date(Date.now() + b.dueInDays * DAY).toISOString();
    postMessage(sub.agentId, "agent", p.status === "completed"
      ? `Paid ${sub.name} ${money(amount)} through PayPal. Next charge ${niceDate(sub.nextChargeAt)}.`
      : `${sub.name}'s ${money(amount)} payment failed: ${p.error ?? "unknown error"}`, { purchaseId: p.id, ...(p.status === "completed" ? {} : { needsYou: true }) });
    saveState();
    return { sub: sub.name, result: p.status === "completed" ? "paid" : "failed", amount, purchaseId: p.id };
  }

  // Price hike: a subscription asking for more than its cap. Held; the user approves the new price or cancels.
  if (decision.outcome === "block" && rules.length === 1 && rules[0] === "price_over_limit") {
    const alert = newAlert({
      agentId: sub.agentId, type: sub.kind === "bill" ? "unusual" : "price_hike",
      title: sub.kind === "bill" ? `${sub.name} bill is ${money(amount)}` : `${sub.name} raised its price`,
      text: sub.kind === "bill"
        ? `${sub.name} asked for ${money(amount)}, over your ${money(sub.cap)} limit (usually about ${money(sub.price)}). I didn't pay it.`
        : `${sub.name} tried to charge ${money(amount)}, up from ${money(sub.price)}. Your cap is ${money(sub.cap)}, so I didn't pay.`,
      asked: amount, usual: sub.price, cap: sub.cap, did: "Held the charge. Nothing was paid and your card was never shared.", month,
    });
    recorder.append(key, "bill_decision", { did: "held", alertId: alert.id });
    recorder.append(alert.id, "bill_request", { merchant: sub.name, amount, month, simulated: true, record: key });
    postMessage(sub.agentId, "agent", sub.kind === "bill" ? alert.text : `${sub.name} raised its price. ${alert.text} Approve the new price, or cancel?`, { needsYou: true, urgent: true, alertId: alert.id });
    saveState();
    return { sub: sub.name, result: "held", amount, alertId: alert.id };
  }

  // A bill inside the hard cap but well above usual: ask first.
  if (decision.outcome === "ask_user" && rules.includes("unusual_amount")) {
    const alert = newAlert({
      agentId: sub.agentId, type: "unusual", title: `${sub.name} bill is ${money(amount)}`,
      text: `${sub.name} is ${money(amount)}; usually about ${money(sub.price)}. Pay it, or hold and check first?`,
      asked: amount, usual: sub.price, cap: sub.cap, did: `Waiting for you. You said ask me above ${money(signed.mandate.askAbove ?? sub.price)}.`, month,
    });
    recorder.append(key, "bill_decision", { did: "asked_user", alertId: alert.id });
    recorder.append(alert.id, "bill_request", { merchant: sub.name, amount, month, simulated: true, record: key });
    postMessage(sub.agentId, "agent", alert.text, { needsYou: true, urgent: true, alertId: alert.id });
    saveState();
    return { sub: sub.name, result: "asked", amount, alertId: alert.id };
  }

  // Anything else (paused, kill switch, not enough money in the pocket): stop and say why.
  const why = rules.includes("agent_paused") ? "You paused me" : rules.includes("kill_switch") ? "All agents are paused" : rules.includes("insufficient_pocket_balance") ? `I only have ${money(agent.balance)}` : decision.violations[0]?.detail ?? "it broke a rule";
  recorder.append(key, "bill_decision", { did: "stopped", rules });
  postMessage(sub.agentId, "agent", `${why}, so I didn't pay ${sub.name}'s ${money(amount)}.`, { needsYou: rules.includes("insufficient_pocket_balance") });
  saveState();
  return { sub: sub.name, result: "stopped", amount };
}

/** "Next month (demo)": every subscription and bill charges once (simulated), through the guard. */
export async function nextMonth() {
  const bs = billsState();
  const subs = liveSubs();
  if (!subs.length) throw new svc.UserError("Add a subscription or bill first.");
  bs.month += 1;
  const results = [];
  for (const sub of subs) results.push(await runCharge(sub, bs.month));
  saveState();
  return { month: bs.month, results, simulated: true as const };
}

/* ------------------------------------ Decisions ------------------------------------ */

function openAlert(id: string, types: AlertType[]) {
  const a = alertOf(id);
  if (!types.includes(a.type)) throw new svc.UserError("That action doesn't fit this alert.");
  if (a.status !== "pending" && a.status !== "held") throw new svc.UserError("This alert has already been answered.");
  return a;
}

/** Approve a new price (the route requires the PIN / Face ID): the cap is re-signed, then this month is paid. */
export async function approveNewPrice(alertId: string) {
  const a = openAlert(alertId, ["price_hike"]);
  const sub = subOf(a.agentId);
  const b = billerById(sub.billerId)!;
  const price = a.asked!;
  svc.signNewMandate(sub.agentId, `Pay ${sub.name} up to ${money(price)} a month.`, draftFor(b, price, undefined));
  const old = sub.price;
  sub.price = price;
  sub.cap = price;
  const agent = agentOf(sub.agentId)!;
  const signed = activeMandateOf(sub.agentId)!;
  const order = chargeOrder(sub, signed, price, a.month ?? billsState().month);
  const decision = checkOrder(signed, order, agent, { ...svc.guardState(agent), askEveryPurchase: false });
  a.decidedAt = new Date().toISOString();
  if (decision.outcome === "block") {
    a.status = "approved";
    a.did = `New price approved, but I couldn't pay yet: ${decision.violations[0]?.detail}`;
    recorder.append(a.id, "bill_decision", { did: "approved_new_price", from: old, to: price, paid: false, rules: decision.violations.map((v) => v.rule) });
    postMessage(sub.agentId, "agent", a.did);
    saveState();
    return { alert: a, sub };
  }
  const p = await pay(sub, agent, signed, order, decision, true);
  a.status = "approved";
  a.purchaseId = p.id;
  a.did = p.status === "completed" ? `You approved ${money(price)}. Paid this month through PayPal.` : `You approved ${money(price)}, but the payment failed: ${p.error}`;
  recorder.append(a.id, "bill_decision", { did: "approved_new_price", from: old, to: price, paid: p.status === "completed", purchaseId: p.id });
  postMessage(sub.agentId, "agent", `New price approved: ${sub.name} can now take up to ${money(price)} a month. ${p.status === "completed" ? `I paid this month's ${money(price)}.` : `The payment failed: ${p.error}`}`, { purchaseId: p.id });
  saveState();
  return { alert: a, sub, purchase: p };
}

/** Pay an unusual bill once (the route requires the PIN / Face ID). The usual rule stays as it was. */
export async function payBill(alertId: string) {
  const a = openAlert(alertId, ["unusual"]);
  const sub = subOf(a.agentId);
  const agent = agentOf(sub.agentId)!;
  let signed = activeMandateOf(sub.agentId)!;
  // Over the hard cap: paying it once means a one-time cap for this bill, signed by this approval.
  if (a.asked! > signed.mandate.maxUnitPrice) {
    const b = billerById(sub.billerId)!;
    signed = svc.signNewMandate(sub.agentId, `Pay ${sub.name}'s ${money(a.asked!)} bill once.`, draftFor(b, a.asked!, sub.varyPct));
  }
  const order = chargeOrder(sub, signed, a.asked!, a.month ?? billsState().month);
  const decision = checkOrder(signed, order, agent, { ...svc.guardState(agent), askEveryPurchase: false });
  if (decision.outcome === "block") throw new svc.UserError(decision.violations[0]?.detail ?? "Your rules stop this payment.");
  const p = await pay(sub, agent, signed, order, decision, true);
  if (a.asked! > sub.cap) svc.signNewMandate(sub.agentId, `Pay ${sub.name} if it's within ${sub.varyPct}% of usual. Never more than ${money(sub.cap)}.`, draftFor(billerById(sub.billerId)!, sub.cap, sub.varyPct));
  a.status = "paid";
  a.decidedAt = new Date().toISOString();
  a.purchaseId = p.id;
  a.did = p.status === "completed" ? `You said pay. Paid ${money(a.asked!)} through PayPal, this once.` : `The payment failed: ${p.error}`;
  recorder.append(a.id, "bill_decision", { did: "paid_once", amount: a.asked, paid: p.status === "completed", purchaseId: p.id });
  postMessage(sub.agentId, "agent", p.status === "completed" ? `Paid ${sub.name} ${money(a.asked!)}, this once. Next month I'll ask again if it's this high.` : a.did, { purchaseId: p.id });
  saveState();
  return { alert: a, purchase: p };
}

/** Hold an unusual bill: nothing is paid until the user says so. */
export function holdBill(alertId: string) {
  const a = openAlert(alertId, ["unusual"]);
  a.status = "held";
  a.decidedAt = new Date().toISOString();
  a.did = "Held at your request. Nothing paid.";
  recorder.append(a.id, "bill_decision", { did: "held_by_user" });
  postMessage(a.agentId, "agent", `Held. I won't pay ${subOf(a.agentId).name}'s ${money(a.asked!)} until you say so.`);
  saveState();
  return { alert: a };
}

/** Keep a trial (or a duplicate). A held first trial charge is paid now. */
export async function keep(alertId: string) {
  const a = openAlert(alertId, ["trial_end", "duplicate"]);
  a.status = "kept";
  a.decidedAt = new Date().toISOString();
  recorder.append(a.id, "bill_decision", { did: "kept" });
  if (a.type === "duplicate") {
    a.did = "You kept both.";
    postMessage(a.agentId, "agent", "Okay, keeping both.");
    saveState();
    return { alert: a };
  }
  const sub = subOf(a.agentId);
  sub.status = "active";
  const held = (a.did ?? "").startsWith(`${sub.name} asked`);
  a.did = "You kept it. It's paid monthly from now on, up to its cap.";
  postMessage(sub.agentId, "agent", `Keeping ${sub.name}. I'll pay up to ${money(sub.cap)} a month.`);
  saveState();
  if (held) {
    const r = await runCharge(sub, billsState().month);
    return { alert: a, charge: r };
  }
  return { alert: a };
}

/** Cancel a subscription: the pocket closes and never pays this merchant again (no PIN; it only stops spending). */
export function cancelSub(agentId: string, alertId?: string) {
  const sub = subOf(agentId);
  if (sub.status === "cancelled") return { sub };
  sub.status = "cancelled";
  const now = new Date().toISOString();
  for (const a of billsState().alerts) {
    if ((a.agentId === agentId || a.otherAgentId === agentId) && (a.status === "pending" || a.status === "held")) {
      a.status = "cancelled";
      a.decidedAt = now;
      a.did = a.type === "duplicate" ? `You cancelled ${sub.name} and kept the other.` : `You cancelled ${sub.name}. Nothing was paid.`;
      recorder.append(a.id, "bill_decision", { did: "cancelled", agentId, ...(alertId === a.id ? { fromThisAlert: true } : {}) });
    }
  }
  postMessage(agentId, "agent", `Cancelled. I won't pay ${sub.name} again. (Simulated: with a real merchant this ends the PayPal billing agreement.)`);
  closeAgent(agentId);
  saveState();
  return { sub };
}

/** Change a pocket's cap (and, for bills, the "ask me above" %). Signed with the PIN. */
export function setCap(agentId: string, cap: unknown, varyPct?: unknown) {
  const sub = subOf(agentId);
  const c = r2(Number(cap));
  if (!(c > 0)) throw new svc.UserError("The cap must be more than $0.");
  if (sub.kind === "bill" && varyPct !== undefined) sub.varyPct = Math.max(5, Math.min(100, Math.round(Number(varyPct) || DEFAULT_VARY_PCT)));
  const b = billerById(sub.billerId)!;
  svc.signNewMandate(agentId, sub.kind === "bill" ? `Pay ${sub.name} if it's within ${sub.varyPct}% of usual. Never more than ${money(c)}.` : `Pay ${sub.name} up to ${money(c)} a month.`, draftFor(b, c, sub.varyPct));
  sub.cap = c;
  postMessage(agentId, "system", `New rule signed. ${rulesLine(sub)}`);
  saveState();
  return { sub };
}

/* ------------------------------------ What the app shows ------------------------------------ */

/** Charges coming up (the "Next 7 days" block takes the first week). */
export function upcoming(now = Date.now()) {
  const pockets = loadState().pockets;
  return liveSubs()
    .filter((x) => !pockets.find((p) => p.id === x.agentId)?.paused)
    .map((x) => ({
      agentId: x.agentId, name: x.name, kind: x.kind,
      amount: x.status === "trial" ? x.price : x.kind === "bill" ? x.price : x.price,
      approx: x.kind === "bill", trial: x.status === "trial",
      at: x.status === "trial" ? x.trialEndsAt! : x.nextChargeAt,
      inDays: Math.max(0, Math.ceil(((Date.parse(x.status === "trial" ? x.trialEndsAt! : x.nextChargeAt)) - now) / DAY)),
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Everything the app needs: the pockets, the alerts, what's coming up, and the monthly total. */
export function billsView() {
  const bs = billsState();
  const subs = liveSubs();
  return {
    subs: bs.subs, alerts: bs.alerts.slice(0, 50), month: bs.month, upcoming: upcoming(),
    monthly: r2(subs.filter((x) => x.status !== "trial").reduce((t, x) => t + x.price, 0)),
    simulated: true as const,
  };
}

/** The proof behind an alert: what the merchant asked, what the rules allowed, and what Pocket did. */
export function proof(alertId: string) {
  const a = alertOf(alertId);
  const link = recorder.all().filter((e) => e.purchaseId === a.id);
  const key = (link.find((e) => e.kind === "bill_request")?.payload as { record?: string } | undefined)?.record;
  const entries = recorder.all().filter((e) => e.purchaseId === a.id || (key && e.purchaseId === key) || (a.purchaseId && e.purchaseId === a.purchaseId));
  return { alert: a, entries, verify: recorder.verify() };
}

export { pendingAlerts } from "./pending.ts";
