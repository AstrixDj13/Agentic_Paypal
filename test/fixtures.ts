import { generateUserKeys, signMandate } from "../src/core/mandate.ts";
import type { DeliveryReading, GuardState, Mandate, PageSnapshot, Pocket, ProposedOrder } from "../src/core/types.ts";

export const NOW = new Date("2026-11-05T12:00:00Z");
export const keys = generateUserKeys();

export const mandate: Mandate = {
  id: "m1",
  pocketId: "drops",
  instruction: "Running shoes, size 10, under $100, Nike or Adidas only, expires Nov 30.",
  item: "running shoes",
  required: { size_us: "10" },
  allowed: { brand: ["nike", "adidas"] },
  maxUnitPrice: 100,
  currency: "USD",
  maxQuantity: 1,
  merchants: ["demo-store"],
  expiresAt: "2026-11-30T23:59:59Z",
  createdAt: "2026-11-03T09:00:00Z",
};
export const signed = signMandate(mandate, keys.privateKey);

export const pocket: Pocket = { id: "drops", name: "Drops", balance: 150, currency: "USD" };
export const state: GuardState = { killSwitch: false, maxPurchasesPerDay: 2, purchasesToday: 0, knownMerchants: ["demo-store"] };

export const claim: ProposedOrder = {
  mandateId: "m1",
  merchantId: "demo-store",
  productId: "pegasus-41",
  title: "Nike Pegasus 41",
  attributes: { brand: "Nike", size_us: "10" },
  unitPrice: 89,
  quantity: 1,
  currency: "USD",
  reasoning: "Back in stock at $89, size 10, Nike: matches the mandate.",
};

export const snapshot: PageSnapshot = {
  url: "http://localhost/demo-store/pegasus-41",
  merchantId: "demo-store",
  productId: "pegasus-41",
  title: "Nike Pegasus 41",
  attributes: { brand: "Nike", size_us: "10", color: "black" },
  unitPrice: 89,
  listingText: "Nike Pegasus 41, US 10, black.",
  capturedAt: "2026-11-05T11:59:00Z",
};

export const delivered: DeliveryReading = { attributes: { brand: "Nike", size_us: "10" }, confidence: 0.93, photoRef: "photo-1" };
