import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeMatches, toProduct } from "../src/store/channel3.ts";

test("size labels: US men's sizes match, women's-only do not", () => {
  assert.equal(sizeMatches("10", "10"), true);
  assert.equal(sizeMatches("US 10", "10"), true);
  assert.equal(sizeMatches("M 10", "10"), true);
  assert.equal(sizeMatches("Men's 10", "10"), true);
  assert.equal(sizeMatches("W 11.5 / M 10", "10"), true);
  assert.equal(sizeMatches("W 10", "10"), false);
  assert.equal(sizeMatches("10.5", "10"), false);
  assert.equal(sizeMatches("M 10.5", "10"), false);
});

test("toProduct: only lists size_us when the store proves the size exists", () => {
  const base = { id: "x", title: "Shoe", brands: [{ id: "b", name: "Nike" }], offers: [{ url: "u", domain: "d.com", price: { price: 80, currency: "USD" } }] };
  assert.equal(toProduct({ ...base, variants: null }, "10")?.attributes.size_us, undefined);
  assert.equal(toProduct({ ...base, variants: { options: [{ name: "Size", values: [{ label: "W 11.5 / M 10" }] }] } }, "10")?.attributes.size_us, "10");
  assert.equal(toProduct({ ...base, offers: [] }, "10"), null);
});
