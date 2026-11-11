import { test } from "node:test";
import assert from "node:assert/strict";
import { brandOf, categoryOf, keyWords } from "../src/intel/profile.ts";
import { describeMatch, describeWords } from "../src/store/channel3.ts";

test("keyWords keeps what identifies a product, drops filler", () => {
  const w = keyWords("Nike Air Jordan 1 Retro High OG Men's Shoes - Size 10");
  for (const x of ["air", "jordan", "1", "retro", "high"]) assert.ok(w.includes(x), x);
  for (const x of ["men", "mens", "shoes", "size"]) assert.ok(!w.includes(x), x);
});

test("categoryOf and brandOf read plain titles", () => {
  assert.equal(categoryOf("Air Jordan 1 Retro High OG"), "shoes");
  assert.equal(categoryOf("Taylor Swift concert tickets"), "tickets");
  assert.equal(categoryOf("Kashmiri chilli powder 100g"), "groceries");
  assert.equal(categoryOf("Lavazza espresso beans 1kg"), "coffee");
  assert.equal(brandOf({ title: "Nike Pegasus 41 Road Running Shoe" }), "nike");
  assert.equal(brandOf({ title: "Classic leather shoe", brand: "Reebok" }), "reebok");
});

test("describeMatch: share of described details the listing mentions", () => {
  assert.deepEqual(describeWords("white leather low-tops, with a gum sole"), ["white", "leather", "low", "tops", "gum", "sole"]);
  const p = { id: "1", title: "Court Classic Leather Sneaker", description: "White low top with gum rubber sole", key_features: [] };
  const m = describeMatch(p, "white leather low-tops, gum sole");
  assert.ok(m.score >= 0.8, String(m.score));
  assert.ok(m.matched.includes("gum"));
  assert.equal(describeMatch(p, "").score, 0);
});

test("weekly check-in is scheduled for the next Saturday at 9:00 (local)", async () => {
  const { nextCheckinAt } = await import("../src/intel/checkin.ts");
  const wed = new Date(2026, 10, 11, 15, 0);            // Wednesday Nov 11, 3pm
  const n = nextCheckinAt(wed, { day: 6, hour: 9 });
  assert.equal(n.getDay(), 6);
  assert.equal(n.getHours(), 9);
  assert.equal(n.getDate(), 14);
  const satLate = new Date(2026, 10, 14, 10, 0);        // Saturday after 9:00 -> next week
  assert.equal(nextCheckinAt(satLate, { day: 6, hour: 9 }).getDate(), 21);
  const satEarly = new Date(2026, 10, 14, 8, 0);        // Saturday before 9:00 -> today
  assert.equal(nextCheckinAt(satEarly, { day: 6, hour: 9 }).getDate(), 14);
  const mon = nextCheckinAt(wed, { day: 1, hour: 18 });
  assert.equal(mon.getDay(), 1);
  assert.equal(mon.getHours(), 18);
});
