import { normalizeValue } from "./canonical.ts";
import { verifyMandate } from "./mandate.ts";
import type { GuardState, Pocket, ProposedOrder, SignedMandate } from "./types.ts";

/**
 * Policy guard: plain code, no AI. Every order the agent proposes passes through here
 * before any PayPal Orders call. A tricked or buggy agent cannot get past these checks.
 */

export type GuardRule =
  | "kill_switch"
  | "agent_paused"
  | "agent_closed"
  | "ask_every_purchase"
  | "signature"
  | "mandate_mismatch"
  | "expired"
  | "merchant_not_allowed"
  | "new_merchant_needs_approval"
  | "required_attribute"
  | "attribute_not_allowed"
  | "avoided_term"
  | "price_over_limit"
  | "quantity_over_limit"
  | "insufficient_pocket_balance"
  | "currency"
  | "daily_limit"
  | "unusual_amount";

export interface Violation {
  rule: GuardRule;
  detail: string;
}

export interface GuardDecision {
  /** "allow" = proceed to PayPal; "ask_user" = needs a one-tap approval; "block" = refused. */
  outcome: "allow" | "ask_user" | "block";
  violations: Violation[];
  total: number;
}

export function checkOrder(
  signed: SignedMandate,
  order: ProposedOrder,
  pocket: Pocket,
  state: GuardState,
  now: Date = new Date(),
): GuardDecision {
  const m = signed.mandate;
  const v: Violation[] = [];
  const total = round2(order.unitPrice * order.quantity);

  if (state.killSwitch) v.push({ rule: "kill_switch", detail: "Kill switch is on; all agent spending is paused." });
  if (pocket.closedAt) v.push({ rule: "agent_closed", detail: `${pocket.name} is closed; it cannot buy.` });
  if (pocket.paused) v.push({ rule: "agent_paused", detail: `${pocket.name} is paused; it cannot buy until you resume it.` });
  if (!verifyMandate(signed)) v.push({ rule: "signature", detail: "Mandate signature is invalid or the mandate was altered." });
  if (order.mandateId !== m.id) v.push({ rule: "mandate_mismatch", detail: `Order cites mandate ${order.mandateId}, expected ${m.id}.` });
  if (new Date(m.expiresAt).getTime() <= now.getTime()) v.push({ rule: "expired", detail: `Mandate expired at ${m.expiresAt}.` });
  if (order.currency !== m.currency || pocket.currency !== m.currency) v.push({ rule: "currency", detail: `Currency must be ${m.currency}.` });

  if (m.merchants.length > 0 && !m.merchants.includes(order.merchantId)) {
    v.push({ rule: "merchant_not_allowed", detail: `Merchant "${order.merchantId}" is not in the mandate (${m.merchants.join(", ")}).` });
  }

  for (const [key, want] of Object.entries(m.required)) {
    const got = order.attributes[key];
    if (got === undefined || normalizeValue(got) !== normalizeValue(want)) {
      v.push({ rule: "required_attribute", detail: `${key} must be "${want}", order has "${got ?? "missing"}".` });
    }
  }
  for (const [key, options] of Object.entries(m.allowed)) {
    const got = order.attributes[key];
    const ok = got !== undefined && options.map(normalizeValue).includes(normalizeValue(got));
    if (!ok) v.push({ rule: "attribute_not_allowed", detail: `${key} must be one of ${options.join("/")}, order has "${got ?? "missing"}".` });
  }

  const hay = `${order.title} ${Object.values(order.attributes).join(" ")}`.toLowerCase();
  for (const word of m.avoid ?? []) {
    if (word.trim() && hay.includes(word.trim().toLowerCase())) v.push({ rule: "avoided_term", detail: `You said no "${word}", and this is "${order.title}".` });
  }
  if (order.unitPrice > m.maxUnitPrice) v.push({ rule: "price_over_limit", detail: `Unit price $${order.unitPrice} exceeds limit $${m.maxUnitPrice}.` });
  if (order.quantity < 1 || order.quantity > m.maxQuantity) v.push({ rule: "quantity_over_limit", detail: `Quantity ${order.quantity} outside 1..${m.maxQuantity}.` });
  if (total > pocket.balance) v.push({ rule: "insufficient_pocket_balance", detail: `Total $${total} exceeds pocket "${pocket.name}" balance $${pocket.balance}.` });
  // A monthly bill is not an agent "purchase": it doesn't use up the daily purchase limit.
  if (m.kind !== "recurring" && state.purchasesToday >= state.maxPurchasesPerDay) v.push({ rule: "daily_limit", detail: `Daily limit of ${state.maxPurchasesPerDay} purchases reached.` });

  if (v.length > 0) return { outcome: "block", violations: v, total };

  // Soft rules: everything is inside the rules, but the user wants a tap first.
  const soft: Violation[] = [];
  if (!state.knownMerchants.includes(order.merchantId)) soft.push({ rule: "new_merchant_needs_approval", detail: `First purchase from "${order.merchantId}".` });
  if (m.askAbove !== undefined && order.unitPrice > m.askAbove) soft.push({ rule: "unusual_amount", detail: `$${order.unitPrice} is more than usual (you said ask me above $${m.askAbove}).` });
  if (state.askEveryPurchase) soft.push({ rule: "ask_every_purchase", detail: `${pocket.name} is set to ask you before every purchase.` });
  if (soft.length) return { outcome: "ask_user", violations: soft, total };
  return { outcome: "allow", violations: [], total };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
