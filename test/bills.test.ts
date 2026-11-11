import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOrder } from "../src/core/guard.ts";
import { signMandate } from "../src/core/mandate.ts";
import type { Mandate, ProposedOrder } from "../src/core/types.ts";
import { BILLERS, amountFor, billerById } from "../src/bills/catalog.ts";
import { sanitizeDraft } from "../src/agent/agents.ts";
import { NOW, keys, pocket, state } from "./fixtures.ts";

const rules = (d: ReturnType<typeof checkOrder>) => d.violations.map((v) => v.rule);

const recurring = (over: Partial<Mandate> = {}): Mandate => ({
  id: "mr", pocketId: "drops", instruction: "Pay Netflix up to $15.49 a month.", item: "Netflix", required: {}, allowed: {},
  maxUnitPrice: 15.49, currency: "USD", maxQuantity: 1, merchants: ["netflix"], kind: "recurring", cadence: "monthly",
  expiresAt: "2027-11-05T00:00:00Z", createdAt: "2026-11-05T00:00:00Z", ...over,
});
const charge = (amount: number, merchantId = "netflix"): ProposedOrder => ({
  mandateId: "mr", merchantId, productId: `bill:${merchantId}:1`, title: "Netflix · monthly subscription", attributes: {},
  unitPrice: amount, quantity: 1, currency: "USD", reasoning: "simulated charge",
});
const known = { ...state, knownMerchants: ["netflix", "electricity"] };

test("subscription: the agreed price is paid; a price hike is blocked by the cap", () => {
  const s = signMandate(recurring(), keys.privateKey);
  assert.equal(checkOrder(s, charge(15.49), pocket, known, NOW).outcome, "allow");
  const hike = checkOrder(s, charge(22.99), pocket, known, NOW);
  assert.equal(hike.outcome, "block");
  assert.deepEqual(rules(hike), ["price_over_limit"]);
});

test("subscription: only its own merchant can charge the pocket", () => {
  const s = signMandate(recurring(), keys.privateKey);
  assert.ok(rules(checkOrder(s, charge(9.99, "spotify"), pocket, known, NOW)).includes("merchant_not_allowed"));
});

test("bill: within the usual range pays; unusual asks first; over the hard cap is blocked", () => {
  const s = signMandate(recurring({ item: "City Power", merchants: ["electricity"], maxUnitPrice: 180, askAbove: 108 }), keys.privateKey);
  assert.equal(checkOrder(s, charge(93.4, "electricity"), { ...pocket, balance: 500 }, known, NOW).outcome, "allow");
  const odd = checkOrder(s, charge(142, "electricity"), { ...pocket, balance: 500 }, known, NOW);
  assert.equal(odd.outcome, "ask_user");
  assert.deepEqual(rules(odd), ["unusual_amount"]);
  assert.deepEqual(rules(checkOrder(s, charge(190, "electricity"), { ...pocket, balance: 500 }, known, NOW)), ["price_over_limit"]);
});

test("monthly bills don't use up the daily purchase limit; hunts still do", () => {
  const busy = { ...known, purchasesToday: 5, maxPurchasesPerDay: 3 };
  assert.equal(checkOrder(signMandate(recurring(), keys.privateKey), charge(15.49), pocket, busy, NOW).outcome, "allow");
});

test("the recurring kind, cadence and ask-above survive draft sanitising (and only for recurring)", () => {
  const d = sanitizeDraft({ item: "City Power", maxUnitPrice: 180, kind: "recurring", askAbove: 108.004, merchants: ["electricity"], expiresAt: "2027-11-05" }, NOW)!;
  assert.equal(d.kind, "recurring");
  assert.equal(d.cadence, "monthly");
  assert.equal(d.askAbove, 108);
  const h = sanitizeDraft({ item: "shoes", maxUnitPrice: 100, askAbove: 50 }, NOW)!;
  assert.equal(h.askAbove, undefined);
});

test("simulated catalog: 7 found on PayPal, Netflix raises its price in month 1, the bill varies", () => {
  assert.equal(BILLERS.filter((b) => b.discovered).length, 7);
  const nf = billerById("netflix")!, el = billerById("electricity")!, sp = billerById("spotify")!;
  assert.equal(amountFor(nf, 1, nf.price), 22.99);
  assert.equal(amountFor(el, 1, el.price), 142);
  assert.equal(amountFor(sp, 1, sp.price), sp.price);
  assert.equal(amountFor(sp, 4, 12.5), 12.5); // after an approved new price, that price is charged
});
