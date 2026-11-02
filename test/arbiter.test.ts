import { test } from "node:test";
import assert from "node:assert/strict";
import { arbitrate } from "../src/core/arbiter.ts";
import { claim, delivered, mandate, snapshot } from "./fixtures.ts";

test("merchant shipped the wrong size -> merchant at fault, refund", () => {
  const r = arbitrate({ mandate, claim, snapshot, delivered: { ...delivered, attributes: { brand: "Nike", size_us: "11" } } });
  assert.equal(r.verdict, "MERCHANT_AT_FAULT");
  assert.equal(r.action, "REFUND_FROM_MERCHANT");
  assert.deepEqual(r.findings, [{ field: "size_us", compared: "delivered_vs_snapshot", expected: "10", actual: "11" }]);
});

test("agent misread 'US 11 / UK 10' -> agent at fault, cover-pool payout", () => {
  const page = { ...snapshot, attributes: { brand: "Nike", size_us: "11", size_uk: "10" }, listingText: "Nike Pegasus 41, US 11 / UK 10" };
  const r = arbitrate({ mandate, claim, snapshot: page, delivered: { ...delivered, attributes: { size_us: "11" } } });
  assert.equal(r.verdict, "AGENT_AT_FAULT");
  assert.equal(r.action, "PAYOUT_FROM_COVER_POOL");
  assert.equal(r.findings[0].compared, "snapshot_vs_claim");
});

test("claim violating the mandate (guard bypass) -> agent at fault", () => {
  const r = arbitrate({ mandate, claim: { ...claim, attributes: { brand: "Puma", size_us: "10" } }, snapshot, delivered });
  assert.equal(r.verdict, "AGENT_AT_FAULT");
  assert.equal(r.findings[0].compared, "mandate_vs_claim");
});

test("everything matches but user unhappy -> instruction unclear", () => {
  const r = arbitrate({ mandate, claim, snapshot, delivered });
  assert.equal(r.verdict, "INSTRUCTION_UNCLEAR");
  assert.equal(r.action, "PROPOSE_MANDATE_FIX");
});

test("blurry photo -> needs review, no money moves", () => {
  const r = arbitrate({ mandate, claim, snapshot, delivered: { ...delivered, confidence: 0.3, attributes: { size_us: "11" } } });
  assert.equal(r.verdict, "NEEDS_REVIEW");
});

test("photo that omits a field is not treated as a mismatch", () => {
  const r = arbitrate({ mandate, claim, snapshot, delivered: { ...delivered, attributes: { size_us: "10" } } });
  assert.equal(r.verdict, "INSTRUCTION_UNCLEAR");
});
