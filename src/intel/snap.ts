import { askJson } from "../ai/llm.ts";
import { channel3Enabled, imageSearch, lookupUrl, searchRaw, toProduct, type C3Product } from "../store/channel3.ts";
import type { Product } from "../store/catalog.ts";
import { buildProfile, categoryOf } from "./profile.ts";
import { domainOf, record, storeImage } from "./signals.ts";

/**
 * "Snap to want": a photo of something you like (a shoe someone is wearing, a bag of coffee)
 * becomes a description, real listings, and a ready-made job for a new agent.
 * "Share to Pocket": a product link shared from any app or browser does the same.
 */

export interface WantResult {
  item: string;
  brand?: string;
  description: string;
  confidence: number;
  matches: { title: string; price: number; domain?: string; url?: string; imageUrl?: string; brand?: string }[];
  /** A job in plain words, pre-filled from the photo and what Pocket knows (size, usual price). */
  instruction: string;
  amount: number;
  /** Hash of the stored photo, so the new rule can search by it too. */
  refImage?: string;
  source: "photo" | "link";
}

const toMatch = (p: Product) => ({ title: p.title, price: p.unitPrice, domain: p.source?.domain, url: p.source?.url, imageUrl: p.imageUrl, brand: p.attributes.brand });

function jobFrom(item: string, brand: string | undefined, description: string, prices: number[]) {
  const prof = buildProfile();
  const cat = categoryOf(`${item} ${description}`);
  const size = cat === "shoes" ? prof.sizes[0]?.size : undefined;
  const typical = prof.priceHabits.find((h) => h.category === cat)?.typical;
  const ref = prices.length ? prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)] : typical ?? 100;
  const cap = Math.ceil((ref * 1.1) / 5) * 5;
  const instruction = [item, size ? `size ${size}` : "", `under $${cap}`, brand ? `${brand} only` : ""].filter(Boolean).join(", ");
  return { instruction, amount: Math.max(50, Math.ceil((cap * 1.2) / 10) * 10) };
}

export async function snap(imageDataUrl: string): Promise<WantResult> {
  if (!/^data:image\//.test(imageDataUrl)) throw new Error("Send a photo.");
  const refImage = storeImage(imageDataUrl);
  const [seen, byPhoto] = await Promise.all([
    askJson<{ item: string; brand?: string; description: string; confidence: number }>(
      `You identify a product in a shopper's photo so an AI agent can find it in stores.
Return {"item": short product type a store would use (e.g. "white leather low-top sneakers"), "brand": brand if clearly visible or recognisable, else omit,
"description": the visual details that matter when buying (colour, material, sole, pattern, model name if recognisable), max 20 words,
"confidence": 0..1}. If there is no product, item "unknown" and confidence 0.`,
      "What product is this?",
      imageDataUrl,
    ),
    channel3Enabled() ? imageSearch(imageDataUrl, 8).catch(() => [] as C3Product[]) : Promise.resolve([] as C3Product[]),
  ]);
  const matches = byPhoto.map((r) => toProduct(r)).filter((p): p is Product => !!p).slice(0, 6);
  const top = matches[0];
  const item = seen?.item && seen.item !== "unknown" ? seen.item : top?.title ?? "this item";
  const brand = seen?.brand || top?.attributes.brand || undefined;
  const description = seen?.description ?? "";
  record({ source: "snap", kind: "photo", title: brand && !item.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${item}` : item, brand, price: top?.unitPrice, imageUrl: top?.imageUrl, note: description });
  return { item, brand, description, confidence: Number(seen?.confidence) || (top ? 0.6 : 0), matches: matches.map(toMatch), ...jobFrom(item, brand, description, matches.map((m) => m.unitPrice)), refImage, source: "photo" };
}

/** A link shared from another app: look the product up, remember it, offer an agent for it. */
export async function shareLink(input: { url?: string; title?: string; text?: string }): Promise<WantResult> {
  const url = (input.url || input.text?.match(/https?:\/\/\S+/)?.[0] || "").trim();
  let product: Product | null = null;
  if (url && /^https?:\/\//.test(url) && channel3Enabled()) {
    const raw = await lookupUrl(url);
    product = raw ? toProduct(raw) : null;
  }
  const title = product?.title ?? input.title?.trim() ?? input.text?.replace(/https?:\/\/\S+/g, "").trim() ?? "";
  if (!title) throw new Error("Couldn't read a product from that link.");
  record({ source: "share", kind: "view", title, brand: product?.attributes.brand, price: product?.unitPrice, url: url || undefined, domain: domainOf(url), imageUrl: product?.imageUrl });
  // Similar listings help set a sensible price limit.
  let matches: Product[] = product ? [product] : [];
  if (channel3Enabled()) {
    const more = await searchRaw({ query: title, limit: 6 }).catch(() => [] as C3Product[]);
    matches = [...matches, ...more.map((r) => toProduct(r)).filter((p): p is Product => !!p)].slice(0, 6);
  }
  const brand = product?.attributes.brand;
  return { item: title, brand, description: "", confidence: product ? 0.9 : 0.5, matches: matches.map(toMatch), ...jobFrom(title, brand, "", matches.map((m) => m.unitPrice)), source: "link" };
}
