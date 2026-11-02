import { test } from "node:test";
import assert from "node:assert/strict";
import { FlightRecorder } from "../src/core/recorder.ts";
import { claim, mandate, snapshot } from "./fixtures.ts";

function sample() {
  const r = new FlightRecorder();
  r.append("p1", "instruction", { text: mandate.instruction });
  r.append("p1", "mandate_signed", mandate);
  r.append("p1", "page_snapshot", snapshot);
  r.append("p1", "agent_claim", claim);
  r.append("p2", "instruction", { text: "Weekly coffee beans" });
  return r;
}

test("fresh chain verifies", () => {
  assert.deepEqual(sample().verify(), { ok: true, checked: 5 });
});

test("editing a stored entry breaks the chain at that entry", () => {
  const r = sample();
  r.tamperForDemo(2, (p) => (p.attributes.size_us = "11"));
  const v = r.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test("per-purchase lookup", () => {
  const r = sample();
  assert.equal(r.forPurchase("p1").length, 4);
  assert.equal(r.latest<typeof claim>("p1", "agent_claim")?.productId, "pegasus-41");
});
