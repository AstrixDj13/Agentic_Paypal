import { normalizeValue } from "./canonical.ts";
import type { Attributes, DeliveryReading, Mandate, PageSnapshot, ProposedOrder } from "./types.ts";

/**
 * Rule-based arbiter. Code decides fault by comparing four field sets:
 *   mandate   - what the user allowed
 *   claim     - what the agent said it was buying (what the guard approved)
 *   snapshot  - what the product page actually said
 *   delivered - what the user's photo shows arrived
 * An LLM is used afterwards only to explain the verdict in plain English (see explain step).
 */

export type Verdict = "MERCHANT_AT_FAULT" | "AGENT_AT_FAULT" | "INSTRUCTION_UNCLEAR" | "NEEDS_REVIEW";

export interface Finding {
  field: string;
  compared: "mandate_vs_claim" | "snapshot_vs_claim" | "delivered_vs_snapshot";
  expected: string;
  actual: string;
}

export interface ArbiterResult {
  verdict: Verdict;
  /** Which party's money moves: merchant refund, agent cover-pool payout, or nothing. */
  action: "REFUND_FROM_MERCHANT" | "PAYOUT_FROM_COVER_POOL" | "PROPOSE_MANDATE_FIX" | "HUMAN_REVIEW";
  findings: Finding[];
  /** Short machine-written reason; the LLM turns this into the user-facing explanation. */
  reason: string;
}

export interface ArbiterInput {
  mandate: Mandate;
  claim: ProposedOrder;
  snapshot: PageSnapshot;
  delivered: DeliveryReading;
}

/** Below this, the photo reading is too unreliable to decide on. */
export const MIN_DELIVERY_CONFIDENCE = 0.6;

export function arbitrate({ mandate, claim, snapshot, delivered }: ArbiterInput): ArbiterResult {
  // 1. Claim vs mandate. The guard should have blocked this; if not, the agent (platform) is at fault.
  const mandateFindings = diff(mandateExpectations(mandate, claim), claim.attributes, "mandate_vs_claim");
  if (claim.unitPrice > mandate.maxUnitPrice) {
    mandateFindings.push({ field: "unit_price", compared: "mandate_vs_claim", expected: `<= ${mandate.maxUnitPrice}`, actual: String(claim.unitPrice) });
  }
  if (mandateFindings.length > 0) {
    return { verdict: "AGENT_AT_FAULT", action: "PAYOUT_FROM_COVER_POOL", findings: mandateFindings, reason: "The order the agent placed did not satisfy the signed mandate." };
  }

  // 2. Snapshot vs claim. The agent said it was buying X, but the page it saw said Y: the agent misread.
  const misread = diff(snapshot.attributes, claim.attributes, "snapshot_vs_claim", true);
  if (snapshot.productId !== claim.productId) {
    misread.push({ field: "product_id", compared: "snapshot_vs_claim", expected: snapshot.productId, actual: claim.productId });
  }
  if (misread.length > 0) {
    return { verdict: "AGENT_AT_FAULT", action: "PAYOUT_FROM_COVER_POOL", findings: misread, reason: "The agent's claim does not match the page it saw: the agent misread the listing." };
  }

  // 3. Delivered vs snapshot. The page promised X, the box contains Y: the merchant shipped wrong.
  if (delivered.confidence < MIN_DELIVERY_CONFIDENCE) {
    return { verdict: "NEEDS_REVIEW", action: "HUMAN_REVIEW", findings: [], reason: `Photo reading confidence ${delivered.confidence} is below ${MIN_DELIVERY_CONFIDENCE}; ask for a clearer photo.` };
  }
  const wrongShipment = diff(snapshot.attributes, delivered.attributes, "delivered_vs_snapshot", true);
  if (wrongShipment.length > 0) {
    return { verdict: "MERCHANT_AT_FAULT", action: "REFUND_FROM_MERCHANT", findings: wrongShipment, reason: "What arrived does not match what the listing promised." };
  }

  // 4. Everything matched, yet the user is unhappy: the instruction itself was ambiguous.
  return { verdict: "INSTRUCTION_UNCLEAR", action: "PROPOSE_MANDATE_FIX", findings: [], reason: "Mandate, claim, listing and delivery all agree; the original instruction needs to be more specific." };
}

/** Attribute values the mandate demands of the claim (required values, plus allowed sets collapsed when the claim's value is outside them). */
function mandateExpectations(m: Mandate, claim: ProposedOrder): Attributes {
  const exp: Attributes = { ...m.required };
  for (const [key, options] of Object.entries(m.allowed)) {
    const got = claim.attributes[key];
    const ok = got !== undefined && options.map(normalizeValue).includes(normalizeValue(got));
    if (!ok) exp[key] = options.join("|");
  }
  return exp;
}

/**
 * Compare expected vs actual on keys present in `expected`.
 * With `onlySharedKeys`, keys missing from `actual` are skipped (a photo may not show every field).
 */
function diff(expected: Attributes, actual: Attributes, compared: Finding["compared"], onlySharedKeys = false): Finding[] {
  const out: Finding[] = [];
  for (const [field, want] of Object.entries(expected)) {
    const got = actual[field];
    if (got === undefined) {
      if (!onlySharedKeys) out.push({ field, compared, expected: want, actual: "missing" });
      continue;
    }
    const wants = want.split("|").map(normalizeValue);
    if (!wants.includes(normalizeValue(got))) out.push({ field, compared, expected: want, actual: got });
  }
  return out;
}
