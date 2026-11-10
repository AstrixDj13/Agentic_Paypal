import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOffers, offer, productById } from "../src/grocery/catalog.ts";
import { pickNow } from "../src/grocery/restaurants.ts";
import { nearbyOffer } from "../src/grocery/nearby.ts";
import { mandate } from "./fixtures.ts";

test("week 0 is a normal week: no deals, everything in stock", () => {
  const all = groupOffers("milk-1gal", 0).concat(groupOffers("eggs-12", 0));
  assert.ok(all.every((o) => !o.onDeal && o.inStock));
});

test("week 1 (scripted demo): Organic Valley on deal at $3.20 (usually $4.50), usual eggs sold out", () => {
  const ov = offer(productById("milk-ov")!, "freshcart", 1);
  assert.equal(ov.onDeal, true);
  assert.equal(ov.price, 3.2);
  assert.equal(ov.regular, 4.5);
  assert.ok(groupOffers("eggs-12", 1).filter((o) => o.productId === "eggs-egglands").every((o) => !o.inStock));
  const sub = groupOffers("eggs-12", 1).find((o) => o.inStock && o.price <= 4.29 * 1.1);
  assert.ok(sub, "a substitute within 10% exists");
});

test("prices are deterministic week to week", () => {
  assert.deepEqual(groupOffers("coffee-12oz", 5), groupOffers("coffee-12oz", 5));
});

test("right-now pick: within budget and time, best rated wins, and it says why", () => {
  const r = pickNow({ ...mandate, item: "chicken biryani", maxUnitPrice: 15, withinMinutes: 30, required: {}, allowed: {} });
  assert.ok(r);
  assert.ok(r!.pick.total <= 15 && r!.pick.etaMin <= 30);
  assert.match(r!.pick.why, /Picked from \d+ options/);
  assert.match(r!.pick.dish, /chicken/i, "chicken biryani means chicken, not veg");
  assert.equal(pickNow({ ...mandate, item: "chicken biryani", maxUnitPrice: 5, withinMinutes: 30, required: {}, allowed: {} }), null);
  const veg = pickNow({ ...mandate, item: "biryani", avoid: ["chicken", "goat", "lamb"], maxUnitPrice: 20, withinMinutes: 60, required: {}, allowed: {} });
  assert.ok(veg && !/chicken|goat|lamb/i.test(veg.pick.dish));
});

test("nearby shop offers are deterministic, at least $3 cheaper, and only for items over $20", () => {
  const a = nearbyOffer("c3-abc", 89), b = nearbyOffer("c3-abc", 89);
  assert.deepEqual(a, b);
  if (a) assert.ok(a.onlinePrice - a.price >= 3 && a.simulated);
  assert.equal(nearbyOffer("c3-abc", 12), null);
});
