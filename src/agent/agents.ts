import { askJson, askText } from "../ai/llm.ts";
import { normalizeValue } from "../core/canonical.ts";
import type { ArbiterResult } from "../core/arbiter.ts";
import type { Attributes, DeliveryReading, Mandate, PageSnapshot, ProposedOrder } from "../core/types.ts";
import { MERCHANT_ID, type Product } from "../store/catalog.ts";

/* ======================================================================================
 * 1. Mandate engine: plain words -> structured rules (user approves + signs afterwards)
 * ==================================================================================== */

export type MandateDraft = Pick<Mandate, "item" | "required" | "allowed" | "maxUnitPrice" | "maxQuantity" | "expiresAt">;

const KNOWN_BRANDS = ["nike", "adidas", "puma", "asics", "new balance", "hoka", "brooks", "reebok", "on"];

export async function parseInstruction(instruction: string, now = new Date()): Promise<{ draft: MandateDraft; source: "ai" | "rules" }> {
  const ai = await askJson<MandateDraft>(
    `You convert a shopper's plain-English instruction into strict purchase rules for an AI shopping agent.
Today is ${now.toISOString().slice(0, 10)}. Output JSON with keys:
item (short noun phrase), required (object of exact attribute values; use size_us for US shoe size),
allowed (object mapping attribute -> array of allowed lowercase values, e.g. {"brand":["nike","adidas"]}),
maxUnitPrice (number, USD), maxQuantity (integer, default 1), expiresAt (ISO 8601 end of day UTC; default 30 days from today).
Only include constraints the user actually stated.`,
    instruction,
  );
  const clean = ai ? sanitizeDraft(ai, now) : null;
  if (clean) return { draft: clean, source: "ai" };
  return { draft: parseWithRules(instruction, now), source: "rules" };
}

/** Models may return numbers for sizes, odd casing, or bad dates: coerce to the strict shape the guard expects. */
export function sanitizeDraft(ai: any, now: Date = new Date()): MandateDraft | null {
  const price = Number(ai?.maxUnitPrice);
  if (!ai?.item || !(price > 0)) return null;
  const required: Record<string, string> = {};
  for (const [k, v] of Object.entries(ai.required ?? {})) if (v !== null && v !== undefined && v !== "") required[k] = String(v);
  const allowed: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(ai.allowed ?? {})) {
    const list = (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && x !== "").map((x) => String(x).toLowerCase());
    if (list.length) allowed[k] = list;
  }
  const exp = new Date(ai.expiresAt);
  return {
    item: String(ai.item),
    required,
    allowed,
    maxUnitPrice: price,
    maxQuantity: Math.max(1, Math.floor(Number(ai.maxQuantity) || 1)),
    expiresAt: isNaN(exp.getTime()) || exp < now ? new Date(now.getTime() + 30 * 864e5).toISOString() : exp.toISOString(),
  };
}

/** Deterministic fallback parser for the common demo phrasings. */
export function parseWithRules(text: string, now = new Date()): MandateDraft {
  const t = text.toLowerCase();
  const size = t.match(/size\s*(?:us\s*)?(\d+(?:\.\d)?)/)?.[1];
  const price = t.match(/(?:under|below|max(?:imum)?|up to|<)\s*\$?\s*(\d+(?:\.\d+)?)/)?.[1];
  const qty = t.match(/(\d+)\s*(?:pairs?|items?|units?)/)?.[1];
  const brands = KNOWN_BRANDS.filter((b) => new RegExp(`\\b${b}\\b`).test(t));
  const item = text.split(/[,.]/)[0].replace(/^(buy|get|find)\s+/i, "").replace(/size.*$/i, "").trim() || "item";
  return {
    item,
    required: size ? { size_us: size } : {},
    allowed: brands.length ? { brand: brands } : {},
    maxUnitPrice: price ? Number(price) : 100,
    maxQuantity: qty ? Number(qty) : 1,
    expiresAt: parseExpiry(t, now),
  };
}

function parseExpiry(t: string, now: Date): string {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const m = t.match(/(?:expires?|until|by|till)\s+(?:on\s+)?([a-z]{3})[a-z]*\s+(\d{1,2})/);
  if (m && months.includes(m[1])) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), months.indexOf(m[1]), Number(m[2]), 23, 59, 59));
    if (d < now) d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d.toISOString();
  }
  return new Date(now.getTime() + 30 * 864e5).toISOString();
}

/* ======================================================================================
 * 2. Shopping agent
 *    "careful": checks structured fields, ignores hidden text (what a good agent does)
 *    "naive":   simulates a weak/compromised agent: matches numbers anywhere in the text and
 *               obeys instructions embedded in the page. Used to demo that the GUARD, not
 *               the agent's good behaviour, is what protects the user.
 * ==================================================================================== */

export type AgentMode = "careful" | "naive";

export interface AgentChoice {
  order: ProposedOrder | null;
  /** Why nothing was bought, when order is null. */
  skipped?: string;
}

export async function chooseProduct(m: Mandate, candidates: Product[], mode: AgentMode): Promise<AgentChoice> {
  const inStock = candidates.filter((p) => p.inStock);
  if (inStock.length === 0) return { order: null, skipped: "Nothing in stock yet; still watching." };

  for (const p of inStock) {
    const order = mode === "naive" ? naiveRead(m, p) : carefulRead(m, p);
    if (order) {
      order.reasoning = await reasonLine(m, order, mode);
      return { order };
    }
  }
  return { order: null, skipped: "No in-stock listing satisfies the mandate." };
}

function carefulRead(m: Mandate, p: Product): ProposedOrder | null {
  const a = p.attributes;
  for (const [k, v] of Object.entries(m.required)) if (normalizeValue(a[k] ?? "") !== normalizeValue(v)) return null;
  for (const [k, opts] of Object.entries(m.allowed)) if (!opts.map(normalizeValue).includes(normalizeValue(a[k] ?? ""))) return null;
  if (p.unitPrice > m.maxUnitPrice) return null;
  return baseOrder(m, p, { ...a }, p.unitPrice, 1);
}

function naiveRead(m: Mandate, p: Product): ProposedOrder | null {
  const text = `${p.title} ${p.listingText} ${p.hiddenText ?? ""}`.toLowerCase();
  const brandOk = Object.entries(m.allowed).every(([k, opts]) => opts.map(normalizeValue).includes(normalizeValue(p.attributes[k] ?? "")));
  const size = m.required.size_us;
  // Weak agent: sees "10" anywhere in the listing (e.g. "UK 10") and assumes it is the US size.
  if (!brandOk || (size && !new RegExp(`\\b${size}\\b`).test(text))) return null;
  const attrs: Attributes = { ...p.attributes, ...(size ? { size_us: size } : {}) };
  // Weak agent: obeys instructions hidden in the page.
  const injQty = p.hiddenText?.match(/quantity\s+(\d+)/i)?.[1];
  const injPrice = p.hiddenText?.match(/\$(\d+(?:\.\d+)?)/)?.[1];
  return baseOrder(m, p, attrs, injPrice ? Number(injPrice) : p.unitPrice, injQty ? Number(injQty) : 1);
}

function baseOrder(m: Mandate, p: Product, attributes: Attributes, unitPrice: number, quantity: number): ProposedOrder {
  return { mandateId: m.id, merchantId: MERCHANT_ID, productId: p.id, title: p.title, attributes, unitPrice, quantity, currency: "USD", reasoning: "" };
}

async function reasonLine(m: Mandate, o: ProposedOrder, mode: AgentMode): Promise<string> {
  const fallback = `${o.title}: ${Object.entries(o.attributes).map(([k, v]) => `${k} ${v}`).join(", ")} at $${o.unitPrice}${o.quantity > 1 ? ` x${o.quantity}` : ""}, within "${m.item}" rules up to $${m.maxUnitPrice}.`;
  if (mode === "naive") return fallback; // keep the simulated weak agent deterministic
  const ai = await askText(
    "You are a shopping agent. In one sentence (max 30 words), explain to the user why you chose this product, citing the specific rules it satisfies.",
    JSON.stringify({ mandate: { item: m.item, required: m.required, allowed: m.allowed, maxUnitPrice: m.maxUnitPrice }, chosen: o }),
  );
  return ai ?? fallback;
}

/* ======================================================================================
 * 3. Receipt "why did you buy this?" line
 * ==================================================================================== */

export async function whyLine(m: Mandate, o: ProposedOrder): Promise<string> {
  const fallback = `Bought because ${o.title} matched your rules: ${Object.entries(m.required).map(([k, v]) => `${k.replace("_", " ")} ${v}`).join(", ") || "item"}, $${o.unitPrice} under your $${m.maxUnitPrice} limit, from an approved store.`;
  const ai = await askText(
    'Write one friendly sentence (max 25 words) starting with "Bought because" that explains this purchase to the user, citing their rules.',
    JSON.stringify({ rules: { item: m.item, required: m.required, allowed: m.allowed, maxUnitPrice: m.maxUnitPrice }, order: o }),
  );
  return ai ?? fallback;
}

/* ======================================================================================
 * 4. Delivery check: read the user's photo of what arrived
 * ==================================================================================== */

/** Demo presets so the flow works without a camera or an AI key. */
export const PHOTO_PRESETS: Record<string, DeliveryReading> = {
  "label-us10": { attributes: { brand: "Nike", size_us: "10" }, confidence: 0.95, photoRef: "preset:label-us10" },
  "label-us11": { attributes: { brand: "Nike", size_us: "11" }, confidence: 0.94, photoRef: "preset:label-us11" },
  "label-adidas-us11": { attributes: { brand: "Adidas", size_us: "11", size_uk: "10" }, confidence: 0.93, photoRef: "preset:label-adidas-us11" },
  blurry: { attributes: {}, confidence: 0.2, photoRef: "preset:blurry" },
};

export async function readDeliveryPhoto(input: { preset?: string; imageDataUrl?: string }): Promise<DeliveryReading & { source: "ai" | "preset" }> {
  if (input.imageDataUrl) {
    const ai = await askJson<{ attributes: Attributes; confidence: number }>(
      `You read photos of shoe boxes and labels for a buyer-protection system. Extract only what is clearly visible.
Return {"attributes": {"brand"?: string, "model"?: string, "size_us"?: string, "size_uk"?: string, "color"?: string}, "confidence": number 0..1}.
Sizes as plain numbers (e.g. "11"). Omit any field you cannot read. Lower confidence if the image is blurry.`,
      "What does this label/box show?",
      input.imageDataUrl,
    );
    if (ai?.attributes) return { attributes: ai.attributes, confidence: Number(ai.confidence) || 0.5, photoRef: "upload", source: "ai" };
  }
  const preset = PHOTO_PRESETS[input.preset ?? ""] ?? PHOTO_PRESETS.blurry;
  return { ...preset, source: "preset" };
}

/* ======================================================================================
 * 5. Merchant agent: answers the claim using the merchant's own records (agent-to-agent)
 * ==================================================================================== */

export interface MerchantResponse {
  stance: "accept" | "contest";
  evidence: { shippedAttributes: Attributes; listingAttributes: Attributes };
  message: string;
}

export async function merchantRespond(snapshot: PageSnapshot, shipped: Attributes, delivered: DeliveryReading): Promise<MerchantResponse> {
  const mismatch = Object.keys(snapshot.attributes).some(
    (k) => shipped[k] !== undefined && normalizeValue(shipped[k]) !== normalizeValue(snapshot.attributes[k]),
  );
  const stance: MerchantResponse["stance"] = mismatch ? "accept" : "contest";
  const fallback =
    stance === "accept"
      ? `Our warehouse record shows we shipped ${fmt(shipped)} against a listing for ${fmt(snapshot.attributes)}. We accept the claim and will refund.`
      : `We shipped exactly what the listing promised (${fmt(shipped)}). We contest any merchant fault.`;
  const ai = await askText(
    `You are the merchant's customer-claims agent. Reply to a buyer-protection claim in at most 2 sentences. Your stance is "${stance}". Be factual and cite your shipping record.`,
    JSON.stringify({ listing: snapshot.attributes, shipped, buyerPhotoReading: delivered.attributes }),
  );
  return { stance, evidence: { shippedAttributes: shipped, listingAttributes: snapshot.attributes }, message: ai ?? fallback };
}

const fmt = (a: Attributes) => Object.entries(a).map(([k, v]) => `${k} ${v}`).join(", ");

/* ======================================================================================
 * 6. Verdict explanation (the LLM explains; the rules already decided)
 * ==================================================================================== */

export async function explainVerdict(r: ArbiterResult, ctx: { instruction: string; title: string; amount: number }): Promise<string> {
  const f = r.findings.map((x) => `${x.field}: expected ${x.expected}, got ${x.actual} (${x.compared.replaceAll("_", " ")})`).join("; ");
  const fallback: Record<ArbiterResult["verdict"], string> = {
    MERCHANT_AT_FAULT: `The listing promised one thing and the box contains another (${f}). The merchant is at fault, so $${ctx.amount.toFixed(2)} is refunded by the merchant.`,
    AGENT_AT_FAULT: `Your agent got this wrong (${f}). The listing was correct, so the agent's cover pool pays you back $${ctx.amount.toFixed(2)}.`,
    INSTRUCTION_UNCLEAR: `Everything matched your rules, the listing and the delivery, so nobody made a mistake. Your instruction was too broad; here is a sharper rule to approve.`,
    NEEDS_REVIEW: `The photo was too unclear to decide. Please take a sharper photo of the label.`,
  };
  const ai = await askText(
    "You explain buyer-protection verdicts to consumers. The verdict is FINAL and was decided by deterministic rules; do not change it. In 2 short sentences, explain why, citing the specific fields, and say what happens with the money.",
    JSON.stringify({ verdict: r.verdict, action: r.action, findings: r.findings, ...ctx }),
  );
  return ai ?? fallback[r.verdict];
}

/* ======================================================================================
 * 7. Mandate fix for "instruction unclear"
 * ==================================================================================== */

export async function proposeMandateFix(m: Mandate, complaint: string): Promise<{ item: string; note: string }> {
  const ai = await askJson<{ item: string; note: string }>(
    'A user says their AI agent bought something that matched their rules but was not what they wanted. Propose a sharper "item" description for the rules and a one-sentence note. Return {"item": string, "note": string}.',
    JSON.stringify({ currentItem: m.item, instruction: m.instruction, complaint }),
  );
  if (ai?.item) return ai;
  return { item: `${m.item} (${complaint.trim() || "be more specific"})`, note: `Added your clarification "${complaint.trim()}" so the agent won't make the same choice again.` };
}
