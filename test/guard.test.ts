import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOrder } from "../src/core/guard.ts";
import { verifyMandate } from "../src/core/mandate.ts";
import { NOW, claim, pocket, signed, state } from "./fixtures.ts";

const rules = (d: ReturnType<typeof checkOrder>) => d.violations.map((v) => v.rule);

test("valid order is allowed", () => {
  const d = checkOrder(signed, claim, pocket, state, NOW);
  assert.equal(d.outcome, "allow");
  assert.equal(d.total, 89);
});

test("signature verifies, and any edit to the mandate breaks it", () => {
  assert.ok(verifyMandate(signed));
  const forged = { ...signed, mandate: { ...signed.mandate, maxUnitPrice: 500 } };
  assert.equal(verifyMandate(forged), false);
  assert.deepEqual(rules(checkOrder(forged, claim, pocket, state, NOW)), ["signature"]);
});

test("prompt-injected order (3 pairs, wrong size, over price) is blocked", () => {
  const injected = { ...claim, quantity: 3, unitPrice: 120, attributes: { brand: "Nike", size_us: "11" } };
  const d = checkOrder(signed, injected, pocket, state, NOW);
  assert.equal(d.outcome, "block");
  for (const r of ["required_attribute", "price_over_limit", "quantity_over_limit", "insufficient_pocket_balance"]) assert.ok(rules(d).includes(r as any), r);
});

test("kill switch blocks everything", () => {
  assert.deepEqual(rules(checkOrder(signed, claim, pocket, { ...state, killSwitch: true }, NOW)), ["kill_switch"]);
});

test("brand outside allowed set is blocked; 'US 10' normalises to '10'", () => {
  const d = checkOrder(signed, { ...claim, attributes: { brand: "Puma", size_us: "US 10" } }, pocket, state, NOW);
  assert.deepEqual(rules(d), ["attribute_not_allowed"]);
});

test("expired mandate, unknown merchant, daily limit", () => {
  assert.ok(rules(checkOrder(signed, claim, pocket, state, new Date("2026-12-01T00:00:00Z"))).includes("expired"));
  assert.ok(rules(checkOrder(signed, { ...claim, merchantId: "shady" }, pocket, state, NOW)).includes("merchant_not_allowed"));
  assert.ok(rules(checkOrder(signed, claim, pocket, { ...state, purchasesToday: 2 }, NOW)).includes("daily_limit"));
});

test("first purchase from an allowed-but-new merchant asks the user", () => {
  const d = checkOrder(signed, claim, pocket, { ...state, knownMerchants: [] }, NOW);
  assert.equal(d.outcome, "ask_user");
});
