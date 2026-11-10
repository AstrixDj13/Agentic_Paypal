import { randomUUID } from "node:crypto";
import { checkOrder } from "../core/guard.ts";
import type { ProposedOrder } from "../core/types.ts";
import { activeMandateOf, agentOf, notifyPurchase, postMessage } from "../app/chat.ts";
import { recorder } from "../app/ledger.ts";
import * as svc from "../app/service.ts";
import { loadState, saveState, type Order, type Purchase } from "../app/state.ts";
import { pickNow } from "./restaurants.ts";

/** Right-now agent: one pick with its reasons; ordering it needs the user's PIN. */

const { UserError } = svc;
const money = (n: number) => `$${n.toFixed(2)}`;

export function findNow(agentId: string): Order {
  const m = activeMandateOf(agentId)?.mandate;
  if (!m || m.kind !== "now") throw new UserError("This agent isn't a right-now agent.");
  const res = pickNow(m);
  if (!res) {
    postMessage(agentId, "agent", `Nothing matches "${m.item}" under ${money(m.maxUnitPrice)} within ${m.withinMinutes ?? 45} minutes right now. Want me to widen the time or the budget?`);
    saveState();
    throw new UserError("No restaurant fits those rules right now.");
  }
  const s = loadState();
  s.orders ??= [];
  for (const o of s.orders) if (o.agentId === agentId && o.kind === "now" && o.status === "awaiting") o.status = "cancelled";
  const order: Order = {
    id: `or_${randomUUID().slice(0, 8)}`, agentId, mandateId: m.id, kind: "now", status: "awaiting",
    createdAt: new Date().toISOString(), pick: res.pick, alternatives: res.alternatives, total: res.pick.total,
  };
  s.orders.push(order);
  recorder.append(m.id, "order_built", { orderId: order.id, kind: "now", pick: res.pick, alternatives: res.alternatives.map((a) => `${a.dish} · ${a.restaurant} · ${money(a.total)}`) });
  postMessage(agentId, "agent", `My pick: ${res.pick.dish} from ${res.pick.restaurant}, ${money(res.pick.total)} with delivery, about ${res.pick.etaMin} min. Why: ${res.pick.why}`, { orderId: order.id, needsYou: true });
  saveState();
  return order;
}

/** Order the pick (or one of the alternatives). Signed with the PIN, so it counts as the user's approval. */
export async function placeNow(orderId: string, choice: number): Promise<Order> {
  const o = (loadState().orders ?? []).find((x) => x.id === orderId);
  if (!o || o.kind !== "now") throw new UserError("Unknown order.");
  if (o.status !== "awaiting") throw new UserError("This order has already gone out.");
  const pick = [o.pick!, ...(o.alternatives ?? [])][choice] ?? o.pick!;
  const agent = agentOf(o.agentId)!;
  const signed = svc.mandateOf(o.mandateId);
  const s = loadState();
  if (!s.knownMerchants.includes(pick.restaurantId)) s.knownMerchants.push(pick.restaurantId);
  const order: ProposedOrder = {
    mandateId: o.mandateId, merchantId: pick.restaurantId, productId: `meal:${pick.restaurantId}`, title: `${pick.dish} · ${pick.restaurant}`,
    attributes: {}, unitPrice: pick.total, quantity: 1, currency: "USD", reasoning: pick.why,
  };
  const raw = checkOrder(signed, order, agent, svc.guardState(agent));
  const decision = raw.outcome === "ask_user" ? { ...raw, outcome: "allow" as const, violations: [] } : raw;
  const purchase: Purchase = {
    id: `pu_${randomUUID().slice(0, 8)}`, mandateId: o.mandateId, pocketId: agent.id, productId: order.productId, title: order.title,
    status: decision.outcome === "allow" ? "completed" : "blocked", mode: "careful", order,
    snapshot: { url: "simulated://restaurants", merchantId: pick.restaurantId, productId: order.productId, title: order.title, attributes: {}, unitPrice: pick.total, listingText: `${pick.dish}, ${money(pick.price)} + ${money(pick.fee)} delivery, ★${pick.rating}, ${pick.etaMin} min (simulated restaurant)`, capturedAt: new Date().toISOString() },
    decision, total: pick.total, orderId: o.id, createdAt: new Date().toISOString(),
  };
  s.purchases.unshift(purchase);
  recorder.append(purchase.id, "page_snapshot", purchase.snapshot);
  recorder.append(purchase.id, "agent_claim", order);
  recorder.append(purchase.id, "guard_decision", decision);
  o.purchaseId = purchase.id;
  if (decision.outcome === "allow") {
    await svc.executePurchase(purchase);
    o.status = purchase.status === "completed" ? "placed" : "failed";
    o.error = purchase.error;
  } else o.status = "blocked";
  notifyPurchase(purchase, signed.mandate);
  saveState();
  return o;
}
