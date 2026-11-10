import { normalizeValue } from "../core/canonical.ts";
import type { Attributes } from "../core/types.ts";
import type { Product } from "./catalog.ts";

/**
 * Channel3 (https://channel3.ai): real product search across online stores.
 *
 * Channel3 *finds* products; it does not take payment. Real products found here are
 * imported into Stride Supply's catalog and paid for through our PayPal sandbox, so the
 * demo is "real products, test money". We call the REST API directly (not the MCP server)
 * because our design keeps the LLM away from the buy decision: plain code searches,
 * plain code filters, plain code guards.
 */

const BASE = "https://api.trychannel3.com/v1";
const API = `${BASE}/search`;

export const channel3Enabled = () => !!process.env.CHANNEL3_API_KEY;

export interface C3Product {
  id: string;
  title: string;
  description?: string;
  key_features?: string[];
  materials?: string[];
  structured_attributes?: Record<string, unknown>;
  brands?: { id: string; name: string }[];
  images?: { url: string; is_main_image?: boolean; alt_text?: string }[];
  gender?: string;
  offers?: { url: string; domain: string; price: { price: number; currency: string }; availability?: string }[];
  variants?: { options?: { name: string; values: { label: string; exists?: boolean; available?: boolean | null }[] }[] } | null;
}

export interface SearchInput {
  query: string;
  maxPrice?: number;
  limit?: number;
  /** "agentic" lets Channel3 plan sub-searches for long, descriptive queries. */
  mode?: "default" | "agentic";
}

/** Small in-memory cache so repeated demo runs don't spend credits. */
const cache = new Map<string, { at: number; products: C3Product[] }>();
const TTL_MS = 30 * 60 * 1000;

export async function searchRaw(input: SearchInput): Promise<C3Product[]> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new Error("CHANNEL3_API_KEY is not set.");
  const body = {
    query: input.query,
    limit: Math.min(input.limit ?? 10, 30),
    filters: input.maxPrice ? { price: { max_price: input.maxPrice } } : {}, // availability defaults to InStock
    ...(input.mode && input.mode !== "default" ? { config: { mode: input.mode } } : {}),
  };
  const ck = JSON.stringify(body);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.products;

  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: ck,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Channel3 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { products?: C3Product[] };
  const products = json.products ?? [];
  cache.set(ck, { at: Date.now(), products });
  return products;
}

/** Sizes the listing says exist (US sizing for US stores). Empty = the listing does not say. */
export function listedSizes(p: C3Product): string[] {
  const opt = p.variants?.options?.find((o) => /size/i.test(o.name));
  return (opt?.values ?? []).filter((v) => v.exists !== false && v.available !== false).map((v) => v.label.trim());
}

/**
 * Does a store's size label offer US men's `want`? Accepts "10", "US 10", "M 10", "Men's 10",
 * and unisex labels like "W 11.5 / M 10". A women's-only label ("W 10") does not count.
 */
export function sizeMatches(label: string, want: string): boolean {
  const w = normalizeValue(want).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return label.split("/").some((part) => {
    const t = part.trim().toLowerCase();
    if (normalizeValue(t) === normalizeValue(want)) return true;
    return new RegExp(`^(?:us\\s*)?(?:m|men'?s?)\\s*${w}$`).test(t);
  });
}

/**
 * Converts a Channel3 product into a Stride Supply listing.
 * `wantSize`: if the listing offers that size we list the product *in that size*;
 * if the listing has no size data, size_us is left out and the careful agent and guard will skip it.
 */
export function toProduct(p: C3Product, wantSize?: string): Product | null {
  const offer = [...(p.offers ?? [])]
    .filter((o) => o.price?.currency === "USD" && (o.availability ?? "InStock") === "InStock")
    .sort((a, b) => a.price.price - b.price.price)[0];
  if (!offer) return null;

  const brand = p.brands?.[0]?.name ?? "";
  const sizes = listedSizes(p);
  const attributes: Attributes = {};
  if (brand) attributes.brand = brand;
  if (wantSize && sizes.some((s) => sizeMatches(s, wantSize))) attributes.size_us = wantSize;
  const img = p.images?.find((i) => i.is_main_image) ?? p.images?.[0];

  const sizeLine = sizes.length ? `Sizes listed: ${sizes.join(", ")}.` : "Sizes: not listed by the store.";
  return {
    id: `c3-${p.id}`,
    title: p.title,
    attributes,
    unitPrice: Math.round(offer.price.price * 100) / 100,
    inStock: true,
    listingText: `${p.title}. ${brand ? `Brand: ${brand}. ` : ""}${sizeLine} ${(p.description ?? "").slice(0, 280)}`.trim(),
    image: "real",
    imageUrl: img?.url,
    source: { kind: "channel3", productId: p.id, url: offer.url, domain: offer.domain, sizes, fetchedAt: new Date().toISOString() },
  };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new Error("CHANNEL3_API_KEY is not set.");
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Channel3 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Search by photo (raw base64, no data: prefix). Cached by a hash of the image. */
export async function imageSearch(dataUrl: string, limit = 10): Promise<C3Product[]> {
  const b64 = dataUrl.replace(/^data:image\/[a-z+]+;base64,/, "");
  const ck = `img:${b64.length}:${b64.slice(-64)}:${limit}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.products;
  const json = await post<{ products?: C3Product[] }>("/image-search", { base64_image: b64, limit: Math.min(limit, 30), segment: "AUTO" });
  const products = json.products ?? [];
  cache.set(ck, { at: Date.now(), products });
  return products;
}

/** Look up any product page URL (shared from another app or browser). */
export async function lookupUrl(url: string): Promise<C3Product | null> {
  try {
    const json = await post<{ product?: C3Product }>("/lookup", { url });
    return json.product ?? null;
  } catch {
    return null;
  }
}

/** Words that describe the product, without filler: "white leather, gum sole" -> ["white","leather","gum","sole"]. */
const DESC_STOP = new Set(["and", "the", "with", "without", "that", "this", "for", "very", "really", "like", "look", "looks", "style", "something", "kind", "type", "one", "some", "not", "any", "only"]);
export const describeWords = (t?: string) => [...new Set((t ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter((w) => !DESC_STOP.has(w));

/** 0..1: share of the described details that the listing actually mentions. */
export function describeMatch(p: C3Product, description?: string): { score: number; matched: string[] } {
  const want = describeWords(description);
  if (!want.length) return { score: 0, matched: [] };
  const hay = [p.title, p.description, ...(p.key_features ?? []), ...(p.materials ?? []), JSON.stringify(p.structured_attributes ?? {})].join(" ").toLowerCase();
  const matched = want.filter((w) => hay.includes(w.replace(/s$/, "")));
  return { score: Math.round((matched.length / want.length) * 100) / 100, matched };
}

/**
 * Searches Channel3 for the rule: by words (each allowed brand + the item + the user's own
 * description) and, if the user attached one, by their reference photo. Listings are ranked by
 * how well they match the description; the guard still checks every hard rule afterwards.
 */
export async function findForRules(r: { item: string; brands: string[]; maxPrice: number; size?: string; description?: string; imageDataUrl?: string }): Promise<Product[]> {
  const what = r.description ? `${r.item}, ${r.description}` : r.item;
  const queries = r.brands.length ? r.brands.map((b) => `${b} ${what}`) : [what];
  const mode = (r.description?.length ?? 0) > 25 ? "agentic" as const : "default" as const;
  const [byPhoto, ...byWords] = await Promise.all([
    r.imageDataUrl ? imageSearch(r.imageDataUrl, 12).catch(() => [] as C3Product[]) : Promise.resolve([] as C3Product[]),
    ...queries.map((q) => searchRaw({ query: q, maxPrice: r.maxPrice, limit: 10, mode }).catch(() => searchRaw({ query: q, maxPrice: r.maxPrice, limit: 10 }))),
  ]);
  const photoIds = new Set(byPhoto.map((x) => x.id));
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const raw of [...byPhoto, ...byWords.flat()]) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const p = toProduct(raw, r.size);
    if (!p || !p.source) continue;
    const m = describeMatch(raw, r.description);
    p.source.match = m.score;
    p.source.matched = m.matched;
    p.source.byPhoto = photoIds.has(raw.id);
    out.push(p);
  }
  // Photo matches and closer descriptions first.
  return out.sort((a, b) => (Number(b.source!.byPhoto) - Number(a.source!.byPhoto)) || ((b.source!.match ?? 0) - (a.source!.match ?? 0)));
}
