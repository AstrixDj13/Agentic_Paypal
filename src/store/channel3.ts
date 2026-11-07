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

const API = "https://api.trychannel3.com/v1/search";

export const channel3Enabled = () => !!process.env.CHANNEL3_API_KEY;

interface C3Product {
  id: string;
  title: string;
  description?: string;
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

/** Searches Channel3 for each allowed brand (or once, if none) and returns Stride Supply listings. */
export async function findForRules(r: { item: string; brands: string[]; maxPrice: number; size?: string }): Promise<Product[]> {
  const queries = r.brands.length ? r.brands.map((b) => `${b} ${r.item}`) : [r.item];
  const results = await Promise.all(queries.map((q) => searchRaw({ query: q, maxPrice: r.maxPrice, limit: 10 })));
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const raw of results.flat()) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const p = toProduct(raw, r.size);
    if (p) out.push(p);
  }
  return out;
}
