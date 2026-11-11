import type { Mandate } from "../core/types.ts";
import type { MandateDraft } from "../agent/agents.ts";
import { loadState } from "../app/state.ts";
import { intel, type Signal } from "./signals.ts";

/**
 * The taste profile: plain arithmetic over signals and the user's own decisions. No model
 * decides anything here; every suggestion carries the reason it was made ("because…").
 */

const HALF_LIFE_DAYS = 14;
const decay = (iso: string, now: number) => Math.pow(0.5, (now - Date.parse(iso)) / (HALF_LIFE_DAYS * 864e5));

const WEIGHT: Record<Signal["kind"], number> = { view: 1, search: 1.5, cart: 3, photo: 3, purchase: 4, approve: 2, skip: -2, decline: -3, dispute: -1 };

const KNOWN_BRANDS = ["nike", "adidas", "jordan", "new balance", "asics", "puma", "hoka", "brooks", "on", "reebok", "converse", "vans", "salomon", "under armour", "saucony", "apple", "samsung", "sony", "lego", "starbucks", "lavazza", "illy", "nespresso"];
const NOISE = new Set(["men", "mens", "women", "womens", "unisex", "kids", "shoe", "shoes", "sneaker", "sneakers", "the", "and", "with", "for", "new", "size", "color", "colour", "black", "white", "buy", "shop", "sale", "free", "shipping", "official", "store", "us", "uk", "eu", "pack"]);

export function brandOf(s: Pick<Signal, "brand" | "title" | "query">): string | undefined {
  if (s.brand) return s.brand.toLowerCase();
  const t = ` ${(s.title ?? s.query ?? "").toLowerCase()} `;
  return KNOWN_BRANDS.find((b) => t.includes(` ${b} `));
}

/** Significant words of a title/query: "Nike Air Jordan 1 Retro High OG" -> ["air","jordan","1","retro","high","og"]. */
export function keyWords(text: string): string[] {
  return (text.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) ?? [])
    .filter((w) => !NOISE.has(w) && (w.length > 2 || /^\d{1,2}$/.test(w)) && !/^\d+(\.\d+)?(cm|mm|g|kg|ml|oz)$/.test(w));
}

export type Category = "shoes" | "tickets" | "groceries" | "coffee" | "electronics" | "other";
export function categoryOf(text: string): Category {
  const t = text.toLowerCase();
  if (/shoe|sneaker|trainer|runner|boot|jordan|pegasus|ultraboost|dunk|air force|air max|gel-|clifton|cloud/.test(t)) return "shoes";
  if (/ticket|concert|gig|festival|match|tour/.test(t)) return "tickets";
  if (/coffee|espresso|bean|roast/.test(t)) return "coffee";
  if (/grocer|spice|chilli|chili|paprika|rice|flour|milk|snack|sauce|oil|tea\b/.test(t)) return "groceries";
  if (/phone|laptop|headphone|earbud|airpods|console|camera|tablet|watch/.test(t)) return "electronics";
  return "other";
}

export interface Interest {
  key: string;
  label: string;
  words: string[];
  brand?: string;
  category: Category;
  score: number;
  views: number;
  searches: number;
  dwellMin: number;
  domains: string[];
  imageUrl?: string;
  priceMin?: number;
  priceMax?: number;
  lastAt: string;
  bought: boolean;
}

export interface Profile {
  sizes: { size: string; count: number; why: string }[];
  brands: { brand: string; score: number; why: string }[];
  dislikedBrands: { brand: string; why: string }[];
  interests: Interest[];
  priceHabits: { category: Category; typical: number; max: number; why: string }[];
  flexibility?: { overPct: number; why: string };
  askHint?: { mode: "money" | "anything"; why: string };
  avoidHints: { word: string; why: string; category: Category }[];
  signalCount: number;
}

const money = (n: number) => `$${Math.round(n)}`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function buildProfile(now = Date.now()): Profile {
  const st = loadState();
  const sig = intel().signals;

  /* -------- interests: cluster signals by shared key words -------- */
  type Cluster = { words: Set<string>; items: Signal[] };
  const clusters: Cluster[] = [];
  for (const s of sig) {
    if (!["view", "search", "cart", "photo", "purchase"].includes(s.kind)) continue;
    const words = keyWords(s.title ?? s.query ?? "").slice(0, 6);
    if (!words.length) continue;
    const ws = new Set(words);
    let best: Cluster | undefined, bestSim = 0;
    for (const c of clusters) {
      const inter = [...ws].filter((w) => c.words.has(w)).length;
      const sim = inter / Math.min(ws.size, c.words.size);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best && bestSim >= 0.6) { best.items.push(s); words.forEach((w) => best!.words.add(w)); }
    else clusters.push({ words: ws, items: [s] });
  }
  const interests: Interest[] = clusters.map((c) => {
    // Label: the most common leading words across the cluster, in order of the best-scored title.
    const counts = new Map<string, number>();
    c.items.forEach((s) => new Set(keyWords(s.title ?? s.query ?? "")).forEach((w) => counts.set(w, (counts.get(w) ?? 0) + 1)));
    const lead = c.items.slice().sort((a, b) => (b.dwellMs ?? 0) - (a.dwellMs ?? 0))[0];
    const core = keyWords(lead.title ?? lead.query ?? "").filter((w) => (counts.get(w) ?? 0) >= Math.max(1, Math.ceil(c.items.length / 2))).slice(0, 5);
    const brand = c.items.map(brandOf).find(Boolean);
    const words = core.length ? core : [...c.words].slice(0, 4);
    const label = titleCase([brand && !words.includes(brand) ? brand : "", ...words].filter(Boolean).join(" "));
    const prices = c.items.map((s) => s.price).filter((p): p is number => !!p);
    const score = c.items.reduce((sum, s) => sum + WEIGHT[s.kind] * decay(s.at, now) * (1 + Math.min(3, (s.dwellMs ?? 0) / 60_000)), 0);
    return {
      key: words.slice(0, 3).join("-"),
      label,
      words,
      brand,
      category: categoryOf(`${label} ${c.items.map((s) => s.title ?? s.query).join(" ")}`),
      score: Math.round(score * 10) / 10,
      views: c.items.filter((s) => s.kind === "view").length,
      searches: c.items.filter((s) => s.kind === "search").length,
      dwellMin: Math.round(c.items.reduce((m, s) => m + (s.dwellMs ?? 0), 0) / 6000) / 10,
      domains: [...new Set(c.items.map((s) => s.domain).filter((d): d is string => !!d))].slice(0, 4),
      imageUrl: c.items.find((s) => s.imageUrl)?.imageUrl,
      priceMin: prices.length ? Math.min(...prices) : undefined,
      priceMax: prices.length ? Math.max(...prices) : undefined,
      lastAt: c.items.map((s) => s.at).sort().at(-1)!,
      bought: c.items.some((s) => s.kind === "purchase"),
    };
  }).filter((i) => i.score > 0.5).sort((a, b) => b.score - a.score);

  /* -------- sizes: purchases and signed rules count more than browsing -------- */
  const sizeCount = new Map<string, { n: number; from: Set<string> }>();
  const addSize = (size: string | undefined, n: number, from: string) => {
    if (!size) return;
    const e = sizeCount.get(size) ?? { n: 0, from: new Set<string>() };
    e.n += n; e.from.add(from); sizeCount.set(size, e);
  };
  st.purchases.filter((p) => p.paypal).forEach((p) => addSize(p.order.attributes.size_us, 3, "purchases"));
  [...st.mandates, ...st.retiredMandates].forEach((m) => addSize(m.mandate.required.size_us, 2, "rules you approved"));
  sig.forEach((s) => addSize(s.size, 1, "pages you viewed"));
  const sizes = [...sizeCount.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3)
    .map(([size, e]) => ({ size, count: e.n, why: `From ${[...e.from].join(" and ")}` }));

  /* -------- brands -------- */
  const bScore = new Map<string, { s: number; parts: Map<string, number> }>();
  const addBrand = (b: string | undefined, w: number, part: string) => {
    if (!b) return;
    const e = bScore.get(b) ?? { s: 0, parts: new Map() };
    e.s += w; e.parts.set(part, (e.parts.get(part) ?? 0) + 1); bScore.set(b, e);
  };
  for (const s of sig) addBrand(brandOf(s), WEIGHT[s.kind] * decay(s.at, now), s.kind);
  st.purchases.filter((p) => p.paypal).forEach((p) => addBrand(p.order.attributes.brand?.toLowerCase(), 4, "purchase"));
  const partText = (parts: Map<string, number>) => [...parts.entries()].map(([k, n]) => `${n} ${k}${n === 1 ? "" : k.endsWith("h") ? "es" : "s"}`).join(", ");
  const brands = [...bScore.entries()].filter(([, e]) => e.s > 1).sort((a, b) => b[1].s - a[1].s).slice(0, 5)
    .map(([brand, e]) => ({ brand, score: Math.round(e.s * 10) / 10, why: partText(e.parts) }));
  const dislikedBrands = [...bScore.entries()].filter(([, e]) => e.s <= -3).map(([brand, e]) => ({ brand, why: partText(e.parts) }));

  /* -------- price habits per category -------- */
  const byCat = new Map<Category, number[]>();
  for (const s of sig) if (s.price && ["view", "cart", "purchase", "approve"].includes(s.kind)) {
    const c = categoryOf(`${s.title ?? ""} ${s.query ?? ""}`);
    byCat.set(c, [...(byCat.get(c) ?? []), s.price]);
  }
  st.purchases.filter((p) => p.paypal).forEach((p) => { const c = categoryOf(p.title); byCat.set(c, [...(byCat.get(c) ?? []), p.order.unitPrice]); });
  const priceHabits = [...byCat.entries()].filter(([, xs]) => xs.length >= 2)
    .map(([category, xs]) => ({ category, typical: Math.round(median(xs)), max: Math.round(Math.max(...xs)), why: `From ${xs.length} prices you looked at or paid` }));

  /* -------- how far you bend: approved price exceptions -------- */
  const bends = st.proposals.filter((p) => p.kind === "rule_change" && p.status === "approved" && p.diff.some((d) => d.label === "Price limit"))
    .map((p) => { const d = p.diff.find((x) => x.label === "Price limit")!; const a = Number(d.from.replace(/[^0-9.]/g, "")), b = Number(d.to.replace(/[^0-9.]/g, "")); return a > 0 ? (b - a) / a : 0; })
    .filter((x) => x > 0);
  const flexibility = bends.length ? { overPct: Math.round(median(bends) * 100), why: `You approved ${bends.length} price exception${bends.length === 1 ? "" : "s"}` } : undefined;

  /* -------- ask-mode hint: if you approve everything, asking is just friction -------- */
  const asked = st.purchases.filter((p) => p.decision.violations.some((v) => v.rule === "ask_every_purchase"));
  const approved = asked.filter((p) => p.paypal).length;
  const askHint = asked.length >= 3 && approved / asked.length >= 0.9
    ? { mode: "money" as const, why: `You approved ${approved} of ${asked.length} purchases you were asked about` }
    : undefined;

  /* -------- avoid hints: things that went wrong before -------- */
  const avoidHints: Profile["avoidHints"] = [];
  const wrongSize = st.purchases.filter((p) => p.dispute && p.dispute.result.findings.some((f) => f.field.startsWith("size")));
  if (wrongSize.length) avoidHints.push({ word: "kids", category: "shoes", why: `${wrongSize.length} past order${wrongSize.length === 1 ? "" : "s"} arrived in the wrong size` });
  // An excluded word belongs to the kind of thing it was excluded from ("paprika" from a spice rule, not a shoe rule).
  const avoidUsed = new Map<string, { n: number; category: Category }>();
  [...st.mandates, ...st.retiredMandates].forEach((m) => (m.mandate.avoid ?? []).forEach((w) => {
    const key = `${w}|${categoryOf(`${m.mandate.item} ${m.mandate.description ?? ""}`)}`;
    const e = avoidUsed.get(key) ?? { n: 0, category: categoryOf(`${m.mandate.item} ${m.mandate.description ?? ""}`) };
    e.n++; avoidUsed.set(key, e);
  }));
  avoidUsed.forEach((e, key) => avoidHints.push({ word: key.split("|")[0], category: e.category, why: `You excluded it in ${e.n} rule${e.n === 1 ? "" : "s"} for ${e.category}` }));

  return { sizes, brands, dislikedBrands, interests, priceHabits, flexibility, askHint, avoidHints, signalCount: sig.length };
}

/* ------------------------------------ Suggestions ------------------------------------ */

export interface AgentSuggestion {
  key: string;
  title: string;
  why: string;
  instruction: string;
  amount: number;
  imageUrl?: string;
  domains: string[];
}

/** Is an interest already somebody's job? */
function covered(i: Interest, jobs: Mandate[]) {
  return jobs.some((m) => {
    const w = new Set(keyWords(`${m.item} ${m.description ?? ""}`));
    return i.words.filter((x) => w.has(x)).length >= Math.min(2, i.words.length);
  });
}

/** Agent ideas from what you've been looking at, each with its reason. */
export function agentSuggestions(limit = 3): AgentSuggestion[] {
  const p = buildProfile();
  const st = loadState();
  const jobs = st.mandates.filter((m) => !st.pockets.find((x) => x.id === m.mandate.pocketId)?.closedAt).map((m) => m.mandate);
  const dismissed = new Set(intel().dismissed);
  return p.interests
    .filter((i) => !i.bought && !dismissed.has(i.key) && !covered(i, jobs))
    .slice(0, limit)
    .map((i) => {
      const size = i.category === "shoes" ? p.sizes[0]?.size : undefined;
      const habit = p.priceHabits.find((h) => h.category === i.category);
      const cap = Math.ceil(Math.max(i.priceMax ?? 0, habit?.typical ?? 0, i.priceMin ?? 0) * 1.05 / 5) * 5 || 100;
      const avoid = p.avoidHints.filter((a) => a.category === i.category).slice(0, 1).map((a) => a.word);
      const shops = i.domains.filter((d) => !/google|bing|duckduckgo/.test(d)).slice(0, 2);
      const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
      const parts = [
        i.views ? `viewed it ${times(i.views)}${shops.length ? ` on ${shops.join(" and ")}` : ""}` : "",
        i.searches ? `searched for it ${times(i.searches)}` : "",
        i.dwellMin >= 1 ? `spent ${Math.round(i.dwellMin)} min on its pages` : "",
      ].filter(Boolean);
      const seen = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
      const price = i.priceMin ? ` Prices you saw: ${money(i.priceMin)}${i.priceMax && i.priceMax > i.priceMin ? `–${money(i.priceMax)}` : ""}.` : "";
      return {
        key: i.key,
        title: i.label,
        why: `You ${seen || "looked at this"}.${price}`,
        instruction: [i.label, size ? `size ${size}` : "", `under $${cap}`, i.brand ? `${titleCase(i.brand)} only` : "", avoid.length ? `not ${avoid.join(", ")}` : ""].filter(Boolean).join(", "),
        amount: Math.max(50, Math.ceil(cap * 1.2 / 10) * 10),
        imageUrl: i.imageUrl,
        domains: i.domains,
      };
    });
}

export interface RuleTip { id: string; text: string; why: string; patch: Partial<MandateDraft> }

/** Tips while reviewing a new rule: fill in what Pocket already knows, flag what looks off. */
export function ruleTips(draft: MandateDraft): RuleTip[] {
  // Tips are for one-time hunts. Right-now meals and the weekly shop have their own setup.
  if (draft.kind === "now" || draft.kind === "routine") return [];
  const p = buildProfile();
  const tips: RuleTip[] = [];
  const cat = categoryOf(`${draft.item} ${draft.description ?? ""}`);
  const size = p.sizes[0];
  if (cat === "shoes" && size && !draft.required.size_us) {
    tips.push({ id: "size", text: `Add size ${size.size}`, why: `${size.why}.`, patch: { required: { ...draft.required, size_us: size.size } } });
  }
  // Brands only from the same kind of thing: what you viewed or bought in this category.
  const sameCat = new Set(p.interests.filter((i) => i.category === cat && i.brand).map((i) => i.brand!));
  loadState().purchases.filter((x) => x.paypal && categoryOf(x.title) === cat && x.order.attributes.brand).forEach((x) => sameCat.add(x.order.attributes.brand.toLowerCase()));
  const liked = p.brands.filter((b) => sameCat.has(b.brand) && !p.dislikedBrands.some((d) => d.brand === b.brand)).slice(0, 2).map((b) => b.brand);
  const relevantLiked = cat === "other" ? [] : liked;
  if (!draft.allowed.brand?.length && relevantLiked.length) {
    tips.push({ id: "brands", text: `Only ${relevantLiked.map(titleCase).join(" or ")}`, why: `Your most-viewed and bought brand${relevantLiked.length > 1 ? "s" : ""}.`, patch: { allowed: { ...draft.allowed, brand: relevantLiked } } });
  }
  const dis = p.dislikedBrands.map((d) => d.brand).filter((b) => draft.allowed.brand?.includes(b));
  if (dis.length) {
    tips.push({ id: "drop", text: `Drop ${dis.map(titleCase).join(", ")}`, why: `You skipped or declined ${dis.length > 1 ? "them" : "it"} before.`, patch: { allowed: { ...draft.allowed, brand: draft.allowed.brand!.filter((b) => !dis.includes(b)) } } });
  }
  const habit = p.priceHabits.find((h) => h.category === cat);
  if (habit && draft.maxUnitPrice < habit.typical * 0.7) {
    tips.push({ id: "price", text: `Raise the limit to $${habit.typical}`, why: `What you usually pay for ${cat} is about $${habit.typical}; few listings will fit $${draft.maxUnitPrice}.`, patch: { maxUnitPrice: habit.typical } });
  }
  for (const a of p.avoidHints) {
    if ((draft.avoid ?? []).includes(a.word) || a.category !== cat || cat === "other") continue;
    tips.push({ id: `avoid-${a.word}`, text: `Never buy "${a.word}"`, why: `${a.why}.`, patch: { avoid: [...(draft.avoid ?? []), a.word] } });
    break;
  }
  return tips.slice(0, 4);
}

/** One short paragraph the chat agent can use to answer "what do you know about me". */
export function profileSummary(): string {
  const p = buildProfile();
  const parts = [
    p.sizes[0] ? `usual size ${p.sizes[0].size}` : "",
    p.brands.length ? `likes ${p.brands.slice(0, 3).map((b) => b.brand).join(", ")}` : "",
    p.dislikedBrands.length ? `tends to skip ${p.dislikedBrands.map((b) => b.brand).join(", ")}` : "",
    p.interests.length ? `recently interested in ${p.interests.slice(0, 3).map((i) => i.label).join("; ")}` : "",
    ...p.priceHabits.map((h) => `usually pays about $${h.typical} for ${h.category}`),
    p.flexibility ? `has bent price limits by about ${p.flexibility.overPct}%` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "nothing learned yet";
}
