import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOrder } from "../src/core/guard.ts";
import { cleanChanges, diffFor, mergeTerms } from "../src/app/chat.ts";
import { parseUntil, rulesReply } from "../src/agent/chatBrain.ts";
import { NOW, claim, mandate, pocket, signed, state } from "./fixtures.ts";

const rules = (d: ReturnType<typeof checkOrder>) => d.violations.map((v) => v.rule);

/* ----------------------------- Guard: per-agent settings ----------------------------- */

test("a paused agent cannot buy, even inside its rules", () => {
  const d = checkOrder(signed, claim, { ...pocket, paused: true }, state, NOW);
  assert.equal(d.outcome, "block");
  assert.deepEqual(rules(d), ["agent_paused"]);
});

test('"ask me about anything" turns every in-rules purchase into a one-tap ask', () => {
  const d = checkOrder(signed, claim, pocket, { ...state, askEveryPurchase: true }, NOW);
  assert.equal(d.outcome, "ask_user");
  assert.deepEqual(rules(d), ["ask_every_purchase"]);
});

test('"ask me about anything" never softens a hard rule', () => {
  const d = checkOrder(signed, { ...claim, unitPrice: 140 }, pocket, { ...state, askEveryPurchase: true }, NOW);
  assert.equal(d.outcome, "block");
  assert.ok(rules(d).includes("price_over_limit"));
});

/* ----------------------------- Rule changes ----------------------------- */

test("cleanChanges drops no-ops and junk, keeps real changes", () => {
  const c = cleanChanges(mandate, { maxUnitPrice: 140, maxQuantity: 1, brands: ["Nike", "adidas", "PUMA"], required: { size_us: "10" }, item: " " } as any);
  assert.deepEqual(c, { maxUnitPrice: 140, brands: ["nike", "adidas", "puma"] });
  assert.deepEqual(cleanChanges(mandate, { maxUnitPrice: -5, expiresAt: "2001-01-01" }), {});
});

test("mergeTerms applies only the allowed fields", () => {
  const t = mergeTerms(mandate, { maxUnitPrice: 140, required: { size_us: "10.5" } });
  assert.equal(t.maxUnitPrice, 140);
  assert.equal(t.required.size_us, "10.5");
  assert.deepEqual(t.allowed.brand, ["nike", "adidas"]);
  assert.equal(t.maxQuantity, 1);
});

test("diff rows read like a receipt", () => {
  assert.deepEqual(diffFor(mandate, { maxUnitPrice: 140 }), [{ label: "Price limit", from: "$100", to: "$140" }]);
});

/* ----------------------------- Chat fallback (no AI) ----------------------------- */

const ctx = { agent: { ...pocket, name: "P" }, mandate, others: [{ ...pocket, id: "g", name: "Groceries", balance: 200 }], history: [], realStores: true };

test("chat: 'go up to $140 just this once' proposes a one-time price change", () => {
  const r = rulesReply("Go up to $140 just this once", ctx, NOW);
  assert.deepEqual(r.proposal, { kind: "rule_change", changes: { maxUnitPrice: 140 }, scope: "once", until: undefined });
});

test("chat: 'until sunday' and 'from now on' set the scope", () => {
  const until = rulesReply("you can spend $120 until sunday", ctx, NOW);
  assert.equal(until.proposal?.kind === "rule_change" && until.proposal.scope, "until");
  const always = rulesReply("from now on allow up to $110", ctx, NOW);
  assert.equal(always.proposal?.kind === "rule_change" && always.proposal.scope, "always");
});

test("chat: 'move $40 from Groceries' proposes a transfer", () => {
  assert.deepEqual(rulesReply("move $40 from groceries please", ctx, NOW).proposal, { kind: "transfer", fromAgent: "Groceries", amount: 40 });
});

test("chat: questions never create proposals", () => {
  assert.equal(rulesReply("what are your rules?", ctx, NOW).proposal, undefined);
  assert.equal(rulesReply("how much money do you have", ctx, NOW).proposal, undefined);
});

test("parseUntil: weekdays and month-day, end of day UTC", () => {
  // NOW is Thursday 2026-11-05
  assert.equal(parseUntil("until sunday", NOW), "2026-11-08T23:59:59.000Z");
  assert.equal(parseUntil("till dec 5", NOW), "2026-12-05T23:59:59.000Z");
  assert.equal(parseUntil("no date here", NOW), undefined);
});

/* ----------------------------- Jobs and "never buy" ----------------------------- */

test("guard: an avoided word in the item is a hard block", async () => {
  const { signMandate } = await import("../src/core/mandate.ts");
  const { keys } = await import("./fixtures.ts");
  const m = signMandate({ ...mandate, avoid: ["paprika"] }, keys.privateKey);
  const d = checkOrder(m, { ...claim, title: "Smoked Paprika 50g" }, pocket, state, NOW);
  assert.equal(d.outcome, "block");
  assert.ok(rules(d).includes("avoided_term"));
  assert.equal(checkOrder(m, claim, pocket, state, NOW).outcome, "allow");
});

test("rules parser: 'chilli powder and not paprika for 10 dollars or below'", async () => {
  const { parseWithRules } = await import("../src/agent/agents.ts");
  const d = parseWithRules("buy chilli powder and not paprika for $10 or below", NOW);
  assert.equal(d.item, "chilli powder");
  assert.deepEqual(d.avoid, ["paprika"]);
  assert.equal(d.maxUnitPrice, 10);
  assert.equal(parseWithRules("chilli powder not paprika for 10 dollars or below", NOW).maxUnitPrice, 10);
});

test("chat: an agent with no job turns 'buy X' into a job proposal", () => {
  const r = rulesReply("buy chilli powder and not paprika for $10 or below", { ...ctx, mandate: undefined }, NOW);
  assert.equal(r.proposal?.kind, "job");
});

test("chat: 'instead buy coffee' proposes a new job for an agent that has one", () => {
  assert.equal(rulesReply("instead buy coffee beans under $20", ctx, NOW).proposal?.kind, "job");
});

test("careful agent: shoes are not groceries, but 'Running Shoe' matches 'running shoes'", async () => {
  const { matchesJob } = await import("../src/agent/agents.ts");
  const shoe = { id: "x", title: "Nike Pegasus 41 Road Running Shoe", attributes: {}, unitPrice: 89, inStock: true, listingText: "Men's road running shoe.", image: "" };
  assert.equal(matchesJob(mandate, shoe), true);
  assert.equal(matchesJob({ ...mandate, item: "groceries" }, shoe), false);
  assert.equal(matchesJob({ ...mandate, item: "chilli powder" }, { ...shoe, title: "Kashmiri Chilli Powder 100g", listingText: "" }), true);
});
