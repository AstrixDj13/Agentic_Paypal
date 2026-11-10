import { randomUUID } from "node:crypto";
import { checkOrder } from "../core/guard.ts";
import type { ListItem, Mandate, Pocket, ProposedOrder } from "../core/types.ts";
import { activeMandateOf, agentOf, notifyPurchase, postMessage } from "../app/chat.ts";
import { recorder } from "../app/ledger.ts";
import * as svc from "../app/service.ts";
import { loadState, saveState, type Order, type OrderLine, type Purchase } from "../app/state.ts";
import { GROCERY_STORES, groupOffers, offer, productById, storeName, type StoreId } from "./catalog.ts";

/**
 * The weekly routine agent: reorders the user's list every week, buys each usual item where it's
 * cheapest, and asks ONCE per order about a better deal (a swap) or a sold-out item.
 *
 * Safety rules (from the product direction):
 *  - Swap needs the PIN and applies to this week only. "Keep usual" is remembered.
 *  - Silence is safe: no reply by the deadline means the usual item, never a swap.
 *  - Out of stock: a substitute only within the rules (same size, at most 10% more), else ask.
 *  - Savings are measured against what the user usually pays, never a list price.
 */

const { UserError } = svc;
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;
const SUB_MAX = 1.1; // substitutes: at most 10% more than the usual price
const DEFAULT_DEADLINE_SEC = 120;

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

/** What the user usually pays for a list item: the median of what they actually paid, else what they told us. */
export function usualPriceFor(agent: Pocket, item: ListItem) {
  const paid = agent.prefs?.paid?.[item.id];
  return paid?.length ? r2(median(paid)) : item.usualPrice;
}

const avoids = (m: Mandate, title: string, tags: string[] = []) => (m.avoid ?? []).some((w) => `${title} ${tags.join(" ")}`.toLowerCase().includes(w.toLowerCase()));

function totals(o: Order) {
  let total = 0, usualTotal = 0;
  for (const l of o.lines ?? []) {
    if (l.kind === "skipped") continue;
    // A pending swap counts as the usual item until the user says otherwise (silence is safe).
    const price = l.ask?.status === "pending" && l.ask.type === "swap" ? l.usual.price : l.chosen?.price;
    if (price === undefined) continue;
    total += price * l.qty;
    usualTotal += l.usualPrice * l.qty;
  }
  o.total = r2(total);
  o.usualTotal = r2(usualTotal);
  o.saved = r2(usualTotal - total);
}

export const pendingAsks = (o: Order) => (o.lines ?? []).filter((l) => l.ask?.status === "pending");

function orderOf(id: string): Order {
  const o = (loadState().orders ?? []).find((x) => x.id === id);
  if (!o) throw new UserError(`Unknown order ${id}`);
  return o;
}

/** One-line summary used in the chat, the check-in and notifications. */
export function orderSummary(o: Order) {
  const items = (o.lines ?? []).filter((l) => l.kind !== "skipped").reduce((n, l) => n + l.qty, 0);
  const asks = pendingAsks(o);
  const usual = o.usualTotal && o.usualTotal > o.total ? ` (usually ${money(o.usualTotal)})` : "";
  const ask = asks.length ? ` ${asks.length} ${asks.some((a) => a.ask!.type === "stockout") ? "question" : "swap"}${asks.length === 1 ? "" : "s"} to approve.` : "";
  return `This week's order: ${items} items, ${money(o.total)}${usual}.${ask}`;
}

/* ------------------------------------ Build ------------------------------------ */

/** Prepares this week's order: usual items at the cheapest store, honest swaps, and substitutes within the rules. */
export function buildWeeklyOrder(agentId: string): Order {
  const agent = agentOf(agentId);
  if (!agent) throw new UserError("Unknown agent.");
  const signed = activeMandateOf(agentId);
  const m = signed?.mandate;
  if (!m || m.kind !== "routine" || !m.list?.length) throw new UserError("This agent doesn't have a weekly list.");
  const s = loadState();
  s.orders ??= [];
  const week = agent.prefs?.week ?? 0;
  const open = s.orders.find((o) => o.agentId === agentId && o.kind === "weekly" && o.week === week && (o.status === "awaiting" || o.status === "needs_approval"));
  if (open) return open;
  if (s.orders.some((o) => o.agentId === agentId && o.kind === "weekly" && o.week === week && o.status === "placed")) {
    throw new UserError("This week's order is already placed. Skip to next week to plan the next one.");
  }
  const keep = new Set(agent.prefs?.keepUsual ?? []);
  // The first week only learns your usual order: no swap questions until there's history.
  const learning = !Object.keys(agent.prefs?.paid ?? {}).length;
  const lines: OrderLine[] = m.list.map((item) => {
    const usualProduct = productById(item.productId);
    const offers = groupOffers(item.group, week);
    const usualOffers = offers.filter((o) => o.productId === item.productId);
    const usualBest = usualOffers.find((o) => o.inStock);
    const usualPrice = usualPriceFor(agent, item);
    const usualRef = usualBest ?? usualOffers[0];
    const line: OrderLine = {
      itemId: item.id, name: item.name, size: item.size, qty: item.qty, usualPrice,
      usual: { productId: item.productId, title: usualProduct?.title ?? item.name, store: usualRef?.store ?? "freshcart", price: usualRef?.price ?? usualPrice, inStock: !!usualBest },
      kind: "usual",
    };
    const alt = offers.filter((o) => o.inStock && o.productId !== item.productId && !avoids(m, o.product.title, o.product.tags));
    const opt = (o: (typeof alt)[number]) => ({ productId: o.productId, title: o.product.title, brand: o.product.brand, store: o.store, price: o.price, regular: o.regular, onDeal: o.onDeal });

    if (usualBest) {
      line.chosen = { productId: item.productId, title: usualProduct!.title, brand: usualProduct!.brand, store: usualBest.store, price: usualBest.price };
      const other = usualOffers.find((o) => o.store !== usualBest.store);
      if (other && other.inStock && other.price > usualBest.price) line.note = `${money(other.price - usualBest.price)} cheaper at ${storeName(usualBest.store)} this week`;
      // A swap worth asking about: a better product on a real discount, or a clearly cheaper one.
      const candidates = learning ? [] : alt.filter((o) => !keep.has(`${item.id}:${o.productId}`));
      // Only real deals, or something at least 25% cheaper. (Only the single best one is asked about; see below.)
      const swap = candidates.find((o) => o.onDeal && o.price <= usualBest.price * 1.12) ?? candidates.find((o) => o.price <= usualBest.price * 0.75);
      if (swap) {
        const reason = `Your usual ${usualProduct!.title.replace(usualProduct!.brand, "").trim() || item.name.toLowerCase()} is ${money(usualBest.price)}. ${swap.product.title} is ${money(swap.price)} this week${swap.onDeal ? ` (usually ${money(swap.regular)})` : ""}. Swap for this week only?`;
        if (agent.prefs?.autoSwapCheaper && swap.price <= usualBest.price) {
          line.chosen = { productId: swap.productId, title: swap.product.title, brand: swap.product.brand, store: swap.store, price: swap.price };
          line.kind = "swap";
          line.ask = { type: "swap", status: "auto", reason: `Swapped automatically (your rule: cheaper and same size). ${reason.replace(" Swap for this week only?", "")}`, options: [opt(swap)] };
        } else {
          line.ask = { type: "swap", status: "pending", reason, options: [opt(swap)] };
        }
      }
    } else {
      // Sold out: substitute within the rules (same size, at most 10% more than usual), else ask.
      const sub = alt.filter((o) => o.price <= usualPrice * SUB_MAX).sort((a, b) => a.price - b.price)[0];
      if (sub) {
        line.chosen = { productId: sub.productId, title: sub.product.title, brand: sub.product.brand, store: sub.store, price: sub.price };
        line.kind = "substitute";
        line.ask = { type: "stockout", status: "auto", reason: `Your usual ${usualProduct?.title ?? item.name} is sold out. ${sub.product.title} is the same size and ${money(sub.price)}, within your rule of at most 10% more (${money(usualPrice)} usually).`, options: [opt(sub)] };
      } else {
        line.kind = "skipped";
        line.ask = { type: "stockout", status: "pending", reason: `Your usual ${usualProduct?.title ?? item.name} is sold out, and nothing the same size is within 10% of your usual ${money(usualPrice)}. Pick one, or I'll leave it out this week.`, options: alt.slice(0, 3).map(opt) };
      }
    }
    return line;
  });

  // Ask once: keep only the single best swap question (a deal first, then the biggest saving). Auto-swaps and
  // sold-out questions are separate: a stock-out that blocks an item always asks.
  const swaps = lines.filter((l) => l.ask?.type === "swap" && l.ask.status === "pending");
  if (swaps.length > 1) {
    const value = (l: OrderLine) => (l.ask!.options[0].onDeal ? 1000 : 0) + (l.usual.price - l.ask!.options[0].price) * l.qty + (l.ask!.options[0].regular - l.ask!.options[0].price);
    const best = swaps.sort((a, b) => value(b) - value(a))[0];
    for (const l of swaps) if (l !== best) delete l.ask;
  }

  const deadlineSec = agent.prefs?.orderDeadlineSec ?? DEFAULT_DEADLINE_SEC;
  const order: Order = {
    id: `or_${randomUUID().slice(0, 8)}`, agentId, mandateId: m.id, kind: "weekly", status: "awaiting",
    createdAt: new Date().toISOString(), deadline: new Date(Date.now() + deadlineSec * 1000).toISOString(), week, lines, total: 0,
  };
  totals(order);
  s.orders.push(order);
  recorder.append(m.id, "order_built", { orderId: order.id, week, total: order.total, usualTotal: order.usualTotal, lines: lines.map((l) => ({ item: l.name, kind: l.kind, chosen: l.chosen?.title, price: l.chosen?.price, ask: l.ask?.type, askStatus: l.ask?.status })) });
  const asks = pendingAsks(order);
  const subs = lines.filter((l) => l.kind === "substitute").map((l) => l.chosen!.title);
  const extra = subs.length ? ` Substituted ${subs.join(", ")} for sold-out items, within your rules.` : "";
  const when = new Date(order.deadline!).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  postMessage(agentId, "agent", `${orderSummary(order)}${extra} ${asks.length ? `No reply by ${when} means your usual items.` : `It goes out at ${when} unless you change something.`}`, {
    orderId: order.id, needsYou: asks.length > 0,
    // Only a stock-out that blocks the order is urgent enough to buzz the phone; swaps wait for the check-in.
    urgent: asks.some((a) => a.ask!.type === "stockout"),
  });
  saveState();
  return order;
}

/* ------------------------------------ Answers ------------------------------------ */

function lineOf(o: Order, itemId: string) {
  const l = o.lines?.find((x) => x.itemId === itemId);
  if (!l) throw new UserError("That item isn't on this order.");
  if (o.status !== "awaiting" && o.status !== "needs_approval") throw new UserError("This order has already gone out.");
  return l;
}

/** Swap (signed with the PIN): this week only. */
export function acceptSwap(orderId: string, itemId: string) {
  const o = orderOf(orderId);
  const l = lineOf(o, itemId);
  if (l.ask?.type !== "swap" || l.ask.status !== "pending") throw new UserError("There's no swap waiting on this item.");
  const sw = l.ask.options[0];
  l.chosen = { productId: sw.productId, title: sw.title, brand: sw.brand, store: sw.store, price: sw.price };
  l.kind = "swap";
  l.ask.status = "accepted";
  totals(o);
  recorder.append(o.mandateId, "order_answer", { orderId, item: l.name, answer: "swap", to: sw.title, price: sw.price, thisWeekOnly: true });
  postMessage(o.agentId, "system", `Swapped to ${sw.title} for this week only. Next week is back to your usual.`);
  saveState();
  return o;
}

/** Keep usual (no PIN): remembered, so the agent stops suggesting this swap. */
export function keepUsual(orderId: string, itemId: string) {
  const o = orderOf(orderId);
  const l = lineOf(o, itemId);
  if (l.ask?.type !== "swap" || l.ask.status !== "pending") throw new UserError("There's no swap waiting on this item.");
  l.ask.status = "kept";
  const agent = agentOf(o.agentId)!;
  agent.prefs ??= {};
  agent.prefs.keepUsual = [...new Set([...(agent.prefs.keepUsual ?? []), `${itemId}:${l.ask.options[0].productId}`])];
  totals(o);
  recorder.append(o.mandateId, "order_answer", { orderId, item: l.name, answer: "keep_usual", remembered: l.ask.options[0].title });
  postMessage(o.agentId, "agent", `Keeping your usual ${l.usual.title}. I won't suggest ${l.ask.options[0].title} again.`);
  saveState();
  return o;
}

/** Sold out: pick an option (signed) or skip it this week. */
export function answerStockout(orderId: string, itemId: string, productId: string | null) {
  const o = orderOf(orderId);
  const l = lineOf(o, itemId);
  if (l.ask?.type !== "stockout" || l.ask.status !== "pending") throw new UserError("Nothing is waiting on this item.");
  if (productId) {
    const pick = l.ask.options.find((x) => x.productId === productId);
    if (!pick) throw new UserError("Pick one of the options shown.");
    l.chosen = { productId: pick.productId, title: pick.title, brand: pick.brand, store: pick.store, price: pick.price };
    l.kind = "substitute";
    l.ask.status = "accepted";
  } else {
    l.kind = "skipped";
    l.ask.status = "kept";
  }
  totals(o);
  recorder.append(o.mandateId, "order_answer", { orderId, item: l.name, answer: productId ? "substitute" : "skip", to: l.chosen?.title });
  saveState();
  return o;
}

/* ------------------------------------ Place ------------------------------------ */

/** Places the order: one guard check for the basket (budget, balance, kill switch, signature), then PayPal. */
export async function placeOrder(orderId: string, by: "user" | "deadline"): Promise<Order> {
  const o = orderOf(orderId);
  if (o.status !== "awaiting" && o.status !== "needs_approval") throw new UserError("This order has already gone out.");
  // Silence is safe: unanswered swaps become the usual item; unanswered stock-outs are left out.
  for (const l of o.lines ?? []) {
    if (l.ask?.status !== "pending") continue;
    if (l.ask.type === "swap") { l.ask.status = "default"; l.kind = "usual"; }
    else { l.ask.status = "default"; l.kind = "skipped"; }
  }
  totals(o);
  const agent = agentOf(o.agentId)!;
  const signed = svc.mandateOf(o.mandateId);
  const bought = (o.lines ?? []).filter((l) => l.kind !== "skipped" && l.chosen);
  if (!bought.length) { o.status = "cancelled"; saveState(); throw new UserError("Nothing left on this order to buy."); }

  // Auto-placing at the deadline still respects "ask me about anything".
  if (by === "deadline" && agent.askMode === "anything") {
    o.status = "needs_approval";
    postMessage(agent.id, "agent", `${orderSummary(o)} Ready to go. You asked me to check with you first.`, { orderId: o.id, needsYou: true });
    saveState();
    return o;
  }

  const s = loadState();
  if (by === "user" && !s.knownMerchants.includes("grocery")) s.knownMerchants.push("grocery");
  // Honest savings: the first week has no history to compare against, so it carries no "usual" figure.
  const hasHistory = Object.keys(agent.prefs?.paid ?? {}).length > 0;
  const order: ProposedOrder = {
    mandateId: o.mandateId, merchantId: "grocery", productId: `order:${o.id}`,
    title: `Weekly groceries · ${bought.reduce((n, l) => n + l.qty, 0)} items`,
    attributes: {}, unitPrice: o.total, quantity: 1, currency: "USD",
    reasoning: orderSummary(o),
  };
  const raw = checkOrder(signed, order, agent, svc.guardState(agent));
  const decision = raw.outcome === "ask_user" && by === "user" ? { ...raw, outcome: "allow" as const, violations: [] } : raw;
  const purchase: Purchase = {
    id: `pu_${randomUUID().slice(0, 8)}`, mandateId: o.mandateId, pocketId: agent.id, productId: order.productId, title: order.title,
    status: decision.outcome === "allow" ? "completed" : decision.outcome === "ask_user" ? "needs_approval" : "blocked",
    mode: "careful", order,
    snapshot: {
      url: "simulated://grocery", merchantId: "grocery", productId: order.productId, title: order.title, attributes: {}, unitPrice: o.total,
      listingText: bought.map((l) => `${l.qty} × ${l.chosen!.title} @ ${money(l.chosen!.price)} (${storeName(l.chosen!.store)}, simulated)`).join("\n"),
      capturedAt: new Date().toISOString(),
    },
    decision, total: o.total, ...(hasHistory ? { usual: o.usualTotal, saved: o.saved } : {}), lines: o.lines, orderId: o.id, createdAt: new Date().toISOString(),
  };
  s.purchases.unshift(purchase);
  recorder.append(purchase.id, "page_snapshot", purchase.snapshot);
  recorder.append(purchase.id, "agent_claim", order);
  recorder.append(purchase.id, "guard_decision", { ...decision, placedBy: by });
  o.purchaseId = purchase.id;

  if (decision.outcome === "allow") {
    await svc.executePurchase(purchase);
    o.status = purchase.status === "completed" ? "placed" : "failed";
    o.error = purchase.error;
    if (purchase.status === "completed") {
      // Learn what the user actually pays for each usual item (savings stay honest week to week).
      agent.prefs ??= {};
      agent.prefs.paid ??= {};
      for (const l of bought) if (l.kind === "usual") agent.prefs.paid[l.itemId] = [...(agent.prefs.paid[l.itemId] ?? []), l.chosen!.price].slice(-4);
    }
  } else {
    o.status = decision.outcome === "ask_user" ? "needs_approval" : "blocked";
  }
  notifyPurchase(purchase, signed.mandate);
  saveState();
  return o;
}

/** Every few seconds: orders past their deadline go out with the usual items (or wait, in "ask about anything"). */
export async function sweepOrders(now = Date.now()) {
  const due = (loadState().orders ?? []).filter((o) => o.kind === "weekly" && o.status === "awaiting" && o.deadline && Date.parse(o.deadline) <= now);
  for (const o of due) {
    try { await placeOrder(o.id, "deadline"); } catch (e) { o.status = "failed"; o.error = (e as Error).message; saveState(); }
  }
}

/** Demo: move the routine agent to the next simulated week (new prices, deals and stock-outs). */
export function nextWeek(agentId: string) {
  const agent = agentOf(agentId);
  if (!agent) throw new UserError("Unknown agent.");
  agent.prefs ??= {};
  agent.prefs.week = (agent.prefs.week ?? 0) + 1;
  for (const o of loadState().orders ?? []) if (o.agentId === agentId && o.status === "awaiting") o.status = "cancelled";
  postMessage(agentId, "system", `Demo: it's now week ${agent.prefs.week + 1}. Prices, deals and stock-outs have changed (simulated stores).`);
  saveState();
  return agent;
}

/** Builds the signed weekly list from the New agent flow (validated here, not trusted from the browser). */
export function listFromInput(input: unknown): ListItem[] {
  const rows = Array.isArray(input) ? input.slice(0, 40) : [];
  const list: ListItem[] = [];
  for (const r of rows as { productId?: string; qty?: number; usualPrice?: number }[]) {
    const p = productById(String(r.productId ?? ""));
    if (!p) continue;
    const qty = Math.max(1, Math.min(12, Math.round(Number(r.qty) || 1)));
    const price = Number(r.usualPrice);
    const fallback = Math.min(...GROCERY_STORES.map((s) => offer(p, s.id as StoreId, 0).regular));
    list.push({ id: `li_${randomUUID().slice(0, 6)}`, group: p.group, name: p.title, size: p.size, productId: p.id, qty, usualPrice: r2(price > 0 && price < 1000 ? price : fallback) });
  }
  if (!list.length) throw new UserError("Add at least one item to the list.");
  return list;
}
