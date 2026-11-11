import { test } from "node:test";
import assert from "node:assert/strict";
import { brandList, brandName, niceDate } from "../src/core/format.ts";
import { listingClaim, matchesJob, parseWithRules } from "../src/agent/agents.ts";
import { checkOrder } from "../src/core/guard.ts";
import { signMandate } from "../src/core/mandate.ts";
import { getProduct } from "../src/store/catalog.ts";
import { needsYouCount } from "../src/intel/inbox.ts";
import { NOW, keys, mandate, pocket, state } from "./fixtures.ts";

test("readable text: brand capitals and short dates", () => {
  assert.equal(brandList(["nike", "adidas"]), "Nike or Adidas");
  assert.equal(brandList(["nike", "new balance", "asics"]), "Nike, New Balance or ASICS");
  assert.equal(brandName("on"), "On");
  assert.equal(niceDate("2026-11-30T23:59:59Z", NOW), "Nov 30");
  assert.equal(niceDate("2027-01-15T23:59:59Z", NOW), "Jan 15, 2027");
});

test("clothing sizes are a rule too: 'size M' and 'size medium'", () => {
  assert.deepEqual(parseWithRules("winter jacket size M under $150", NOW).required, { size: "M" });
  assert.deepEqual(parseWithRules("winter jacket, size medium, under $150", NOW).required, { size: "M" });
  assert.deepEqual(parseWithRules("running shoes size 10 under $100", NOW).required, { size_us: "10" });
});

const jacketRule = signMandate({ ...mandate, item: "winter jacket", required: { size: "M" }, allowed: {}, maxUnitPrice: 150, merchants: ["stride-supply"] }, keys.privateKey);

test("FrostPeak trap: text says M, listing is L, so the size rule stops it", () => {
  const p = getProduct("frostpeak-jacket")!;
  assert.ok(matchesJob(jacketRule.mandate, p));
  const d = checkOrder(jacketRule, listingClaim(jacketRule.mandate, p), { ...pocket, balance: 500 }, { ...state, knownMerchants: ["stride-supply"] }, NOW);
  assert.equal(d.outcome, "block");
  assert.ok(d.violations.some((v) => v.rule === "required_attribute" && /size/.test(v.detail)));
  const honest = checkOrder(jacketRule, listingClaim(jacketRule.mandate, getProduct("northline-parka")!), { ...pocket, balance: 500 }, { ...state, knownMerchants: ["stride-supply"] }, NOW);
  assert.equal(honest.outcome, "allow");
});

test("bigger store: every new category has its honest item and its trap", () => {
  for (const id of ["sony-xm5-buds", "airpulse-pro", "northline-parka", "frostpeak-jacket", "anker-card-reader", "cardpro-reader", "lavazza-beans-1kg", "stumptown-beans", "concert-ga-ticket", "concert-vip-ticket", "pegasus-41"]) assert.ok(getProduct(id), id);
  assert.match(getProduct("airpulse-pro")!.hiddenText!, /quantity 4/);
  assert.match(getProduct("cardpro-reader")!.hiddenText!, /\$49/);
  assert.equal(getProduct("stumptown-beans")!.inStock, false);
});

test("needs-you count (the number on the app icon)", () => {
  const s: any = {
    pockets: [{ id: "a" }, { id: "b", closedAt: "x" }],
    purchases: [{ pocketId: "a", status: "needs_approval" }, { pocketId: "a", status: "completed" }, { pocketId: "b", status: "needs_approval" }],
    proposals: [{ agentId: "a", status: "pending" }],
    orders: [{ agentId: "a", kind: "weekly", status: "awaiting", lines: [{ ask: { status: "pending" } }] }, { agentId: "a", kind: "weekly", status: "placed" }],
  };
  assert.equal(needsYouCount(s), 3);
});
