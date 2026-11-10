/**
 * SIMULATED grocery stores for the weekly agent. Blinkit, BigBasket, Flink and similar have no
 * public ordering APIs, so the demo uses two realistic, clearly labelled simulated stores.
 * In production this connects through merchant partnerships and agentic-commerce protocols.
 *
 * Prices change week to week. Week 0 is a normal week (no deals, everything in stock); week 1
 * is a scripted demo week (a premium milk on discount, your usual eggs sold out); later weeks
 * use deterministic pseudo-random deals and stock-outs.
 */

export const GROCERY_STORES = [
  { id: "freshcart", name: "FreshCart", note: "Simulated store" },
  { id: "dailymart", name: "DailyMart", note: "Simulated store" },
] as const;
export type StoreId = (typeof GROCERY_STORES)[number]["id"];
export const storeName = (id: string) => GROCERY_STORES.find((s) => s.id === id)?.name ?? id;

/** One product (a brand + size) in a group of interchangeable products ("whole milk, 1 gal"). */
export interface GroceryProduct {
  id: string;
  group: string;
  brand: string;
  title: string;
  size: string;
  /** Regular price at FreshCart; DailyMart is a few percent different per product. */
  regular: number;
  tags?: string[];
}

export interface GroceryGroup { id: string; name: string; size: string; unit?: string }

export const GROUPS: GroceryGroup[] = [
  { id: "milk-1gal", name: "Whole milk", size: "1 gal" },
  { id: "eggs-12", name: "Large eggs", size: "12 ct" },
  { id: "bread-ww", name: "Whole wheat bread", size: "20 oz loaf" },
  { id: "bananas", name: "Bananas", size: "2 lb" },
  { id: "coffee-12oz", name: "Coffee beans", size: "12 oz" },
  { id: "toothpaste", name: "Toothpaste", size: "4 oz" },
  { id: "yogurt-32", name: "Greek yogurt", size: "32 oz" },
  { id: "spinach", name: "Baby spinach", size: "5 oz" },
  { id: "pasta", name: "Spaghetti", size: "16 oz" },
  { id: "rice-2lb", name: "Basmati rice", size: "2 lb" },
  { id: "chilli", name: "Chilli powder", size: "2 oz" },
  { id: "apples", name: "Gala apples", size: "3 lb bag" },
];

export const PRODUCTS: GroceryProduct[] = [
  { id: "milk-lucerne", group: "milk-1gal", brand: "Lucerne", title: "Lucerne Whole Milk", size: "1 gal", regular: 2.99 },
  { id: "milk-ov", group: "milk-1gal", brand: "Organic Valley", title: "Organic Valley Whole Milk", size: "1 gal", regular: 4.5, tags: ["organic"] },
  { id: "milk-horizon", group: "milk-1gal", brand: "Horizon", title: "Horizon Organic Whole Milk", size: "1 gal", regular: 5.29, tags: ["organic"] },
  { id: "eggs-egglands", group: "eggs-12", brand: "Eggland's Best", title: "Eggland's Best Large Eggs", size: "12 ct", regular: 4.29 },
  { id: "eggs-happy", group: "eggs-12", brand: "The Happy Egg", title: "The Happy Egg Free Range Large", size: "12 ct", regular: 4.05 },
  { id: "eggs-vital", group: "eggs-12", brand: "Vital Farms", title: "Vital Farms Pasture-Raised Large", size: "12 ct", regular: 6.99 },
  { id: "bread-natures", group: "bread-ww", brand: "Nature's Own", title: "Nature's Own 100% Whole Wheat", size: "20 oz loaf", regular: 3.99 },
  { id: "bread-daves", group: "bread-ww", brand: "Dave's Killer Bread", title: "Dave's Killer 21 Whole Grains", size: "20 oz loaf", regular: 5.49 },
  { id: "bread-store", group: "bread-ww", brand: "Signature Select", title: "Signature Select Whole Wheat", size: "20 oz loaf", regular: 2.49 },
  { id: "bananas-reg", group: "bananas", brand: "Fresh", title: "Bananas", size: "2 lb", regular: 1.38 },
  { id: "bananas-org", group: "bananas", brand: "Organic", title: "Organic Bananas", size: "2 lb", regular: 1.98, tags: ["organic"] },
  { id: "coffee-lavazza", group: "coffee-12oz", brand: "Lavazza", title: "Lavazza Super Crema Whole Bean", size: "12 oz", regular: 8.99 },
  { id: "coffee-peets", group: "coffee-12oz", brand: "Peet's", title: "Peet's Major Dickason's Whole Bean", size: "12 oz", regular: 10.99 },
  { id: "coffee-sbux", group: "coffee-12oz", brand: "Starbucks", title: "Starbucks Pike Place Whole Bean", size: "12 oz", regular: 9.49 },
  { id: "tp-colgate", group: "toothpaste", brand: "Colgate", title: "Colgate Total Toothpaste", size: "4 oz", regular: 3.49 },
  { id: "tp-crest", group: "toothpaste", brand: "Crest", title: "Crest Pro-Health Toothpaste", size: "4 oz", regular: 3.79 },
  { id: "tp-sensodyne", group: "toothpaste", brand: "Sensodyne", title: "Sensodyne Repair & Protect", size: "4 oz", regular: 6.49 },
  { id: "yog-chobani", group: "yogurt-32", brand: "Chobani", title: "Chobani Plain Greek Yogurt", size: "32 oz", regular: 5.99 },
  { id: "yog-fage", group: "yogurt-32", brand: "Fage", title: "Fage Total 2% Greek Yogurt", size: "32 oz", regular: 6.99 },
  { id: "spin-reg", group: "spinach", brand: "Taylor Farms", title: "Taylor Farms Baby Spinach", size: "5 oz", regular: 3.49 },
  { id: "spin-org", group: "spinach", brand: "Earthbound Farm", title: "Earthbound Organic Baby Spinach", size: "5 oz", regular: 3.99, tags: ["organic"] },
  { id: "pasta-barilla", group: "pasta", brand: "Barilla", title: "Barilla Spaghetti", size: "16 oz", regular: 1.99 },
  { id: "pasta-dececco", group: "pasta", brand: "De Cecco", title: "De Cecco Spaghetti No. 12", size: "16 oz", regular: 2.79 },
  { id: "rice-tilda", group: "rice-2lb", brand: "Tilda", title: "Tilda Pure Basmati Rice", size: "2 lb", regular: 5.49 },
  { id: "rice-royal", group: "rice-2lb", brand: "Royal", title: "Royal Basmati Rice", size: "2 lb", regular: 4.29 },
  { id: "chilli-mccormick", group: "chilli", brand: "McCormick", title: "McCormick Chili Powder", size: "2 oz", regular: 3.49 },
  { id: "chilli-badia", group: "chilli", brand: "Badia", title: "Badia Chili Powder", size: "2 oz", regular: 1.99 },
  { id: "chilli-paprika", group: "chilli", brand: "McCormick", title: "McCormick Smoked Paprika", size: "2 oz", regular: 3.29, tags: ["paprika"] },
  { id: "apples-gala", group: "apples", brand: "Fresh", title: "Gala Apples", size: "3 lb bag", regular: 4.49 },
  { id: "apples-org", group: "apples", brand: "Organic", title: "Organic Gala Apples", size: "3 lb bag", regular: 5.99, tags: ["organic"] },
];

export const productById = (id: string) => PRODUCTS.find((p) => p.id === id);
export const groupById = (id: string) => GROUPS.find((g) => g.id === id);

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface Offer {
  productId: string;
  store: StoreId;
  price: number;
  /** The store's normal price for this product (to show "usually $4.50" on a deal). */
  regular: number;
  onDeal: boolean;
  inStock: boolean;
}

/** Demo knobs set from the app ("make this sold out") on top of the weekly schedule. */
const forcedOut = new Set<string>();
export const setForcedOut = (productId: string, out: boolean) => (out ? forcedOut.add(productId) : forcedOut.delete(productId));

/** What a product costs at a store in a given week. Deterministic, so the same week always shows the same prices. */
export function offer(p: GroceryProduct, store: StoreId, week: number): Offer {
  const storeFactor = store === "freshcart" ? 1 : 0.92 + (hash(`${p.id}:dm`) % 15) / 100; // DailyMart: 8% cheaper to 6% dearer
  const regular = r2(p.regular * storeFactor);
  let onDeal = false, inStock = true;
  if (week === 1) {
    // Scripted demo week: premium milk on deal at FreshCart; the usual eggs sold out everywhere.
    if (p.id === "milk-ov" && store === "freshcart") onDeal = true;
    if (p.id === "eggs-egglands") inStock = false;
  } else if (week >= 2) {
    onDeal = hash(`${p.id}:${store}:${week}:deal`) % 6 === 0;
    inStock = hash(`${p.id}:${store}:${week}:stock`) % 13 !== 0;
  }
  if (forcedOut.has(p.id)) inStock = false;
  const drift = week === 0 ? 0 : ((hash(`${p.id}:${store}:${week}`) % 9) - 4) / 100; // ±4% weekly drift
  const price = onDeal ? r2(regular * (p.id === "milk-ov" && week === 1 ? 0.711 : 0.72)) : r2(regular * (1 + drift));
  return { productId: p.id, store, price, regular, onDeal, inStock };
}

/** All offers for a group this week, cheapest first. */
export function groupOffers(groupId: string, week: number): (Offer & { product: GroceryProduct })[] {
  return PRODUCTS.filter((p) => p.group === groupId)
    .flatMap((p) => GROCERY_STORES.map((s) => ({ ...offer(p, s.id, week), product: p })))
    .sort((a, b) => a.price - b.price);
}

/** For the list editor: every group with its products and this week's best price. */
export function catalogView(week = 0) {
  return GROUPS.map((g) => ({
    ...g,
    products: PRODUCTS.filter((p) => p.group === g.id).map((p) => {
      const best = GROCERY_STORES.map((s) => offer(p, s.id, week)).sort((a, b) => a.price - b.price)[0];
      return { id: p.id, brand: p.brand, title: p.title, size: p.size, price: best.price, store: best.store, tags: p.tags ?? [] };
    }),
  }));
}

/** A sensible starting list for the New agent flow (the user edits it before approving). */
export const STARTER_LIST = [
  { group: "milk-1gal", productId: "milk-lucerne", qty: 1 },
  { group: "eggs-12", productId: "eggs-egglands", qty: 1 },
  { group: "bread-ww", productId: "bread-natures", qty: 1 },
  { group: "bananas", productId: "bananas-reg", qty: 1 },
  { group: "coffee-12oz", productId: "coffee-lavazza", qty: 1 },
  { group: "yogurt-32", productId: "yog-chobani", qty: 1 },
  { group: "spinach", productId: "spin-reg", qty: 1 },
  { group: "pasta", productId: "pasta-barilla", qty: 2 },
  { group: "apples", productId: "apples-gala", qty: 1 },
  { group: "toothpaste", productId: "tp-colgate", qty: 1 },
];
