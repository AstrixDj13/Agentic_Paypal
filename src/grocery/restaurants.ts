import type { Mandate } from "../core/types.ts";
import type { NowPick } from "../app/state.ts";
import { keyWords } from "../intel/profile.ts";

/**
 * SIMULATED restaurants for the right-now agent ("biryani under $15 within 30 minutes").
 * Zomato, Uber Eats and DoorDash have no public ordering APIs for this; in production it would
 * connect through merchant partnerships. The agent weighs price + delivery fee, rating and time,
 * then makes ONE pick and says why.
 */

interface Dish { name: string; price: number; tags: string[] }
interface Restaurant { id: string; name: string; rating: number; etaMin: number; fee: number; dishes: Dish[] }

export const RESTAURANTS: Restaurant[] = [
  { id: "rest-paradise", name: "Paradise Biryani Pointe", rating: 4.6, etaMin: 25, fee: 1.99, dishes: [{ name: "Chicken Dum Biryani", price: 11.49, tags: ["biryani", "chicken", "indian"] }, { name: "Veg Dum Biryani", price: 9.99, tags: ["biryani", "veg", "vegetarian", "indian"] }] },
  { id: "rest-bawarchi", name: "Bawarchi Biryanis", rating: 4.4, etaMin: 35, fee: 0.99, dishes: [{ name: "Hyderabadi Chicken Biryani", price: 10.99, tags: ["biryani", "chicken", "indian"] }, { name: "Goat Biryani", price: 13.99, tags: ["biryani", "goat", "mutton", "indian"] }] },
  { id: "rest-hyderabad", name: "Hyderabad House", rating: 4.8, etaMin: 20, fee: 2.99, dishes: [{ name: "Chicken 65 Biryani", price: 13.49, tags: ["biryani", "chicken", "indian"] }, { name: "Paneer Biryani", price: 12.49, tags: ["biryani", "paneer", "veg", "vegetarian", "indian"] }] },
  { id: "rest-curry", name: "Curry Express", rating: 3.9, etaMin: 28, fee: 1.49, dishes: [{ name: "Chicken Biryani", price: 8.99, tags: ["biryani", "chicken", "indian"] }, { name: "Butter Chicken Bowl", price: 10.49, tags: ["curry", "chicken", "indian"] }] },
  { id: "rest-spice", name: "Spice Route Kitchen", rating: 4.5, etaMin: 45, fee: 0.0, dishes: [{ name: "Lamb Biryani", price: 12.99, tags: ["biryani", "lamb", "mutton", "indian"] }, { name: "Chicken Biryani", price: 10.49, tags: ["biryani", "chicken", "indian"] }] },
  { id: "rest-slice", name: "Slice Society", rating: 4.5, etaMin: 22, fee: 1.99, dishes: [{ name: "Margherita Pizza", price: 12.99, tags: ["pizza", "veg", "vegetarian", "italian"] }, { name: "Pepperoni Pizza", price: 14.49, tags: ["pizza", "pepperoni", "italian"] }] },
  { id: "rest-sushi", name: "Sushi Go Round", rating: 4.7, etaMin: 30, fee: 2.49, dishes: [{ name: "Salmon Roll Combo", price: 13.99, tags: ["sushi", "salmon", "japanese"] }, { name: "Veggie Roll Combo", price: 10.99, tags: ["sushi", "veg", "vegetarian", "japanese"] }] },
  { id: "rest-burrito", name: "Burrito Bros", rating: 4.2, etaMin: 18, fee: 1.29, dishes: [{ name: "Chicken Burrito", price: 9.49, tags: ["burrito", "mexican", "chicken"] }, { name: "Veggie Bowl", price: 8.99, tags: ["bowl", "mexican", "veg", "vegetarian"] }] },
];

const money = (n: number) => `$${n.toFixed(2)}`;

/** Ranks every matching dish and returns the best pick plus the next two, each with its reason. */
export function pickNow(m: Mandate): { pick: NowPick; alternatives: NowPick[]; considered: number } | null {
  const want = keyWords(`${m.item} ${m.description ?? ""}`).filter((w) => !["under", "within", "minutes", "min", "delivered", "order", "food", "meal"].includes(w));
  const limit = m.withinMinutes ?? 45;
  const budget = m.maxUnitPrice;
  const avoid = (m.avoid ?? []).map((a) => a.toLowerCase());
  const all = RESTAURANTS.flatMap((r) => r.dishes.map((d) => ({ r, d, total: Math.round((d.price + r.fee) * 100) / 100 })));
  // Dishes that match every word you used ("chicken biryani" means chicken, not veg); fall back to any word.
  const hits = (r: Restaurant, d: Dish) => { const hay = `${d.name} ${d.tags.join(" ")} ${r.name}`.toLowerCase(); return want.filter((w) => hay.includes(w.replace(/s$/, ""))).length; };
  const allowed = all.filter(({ r, d }) => !avoid.some((a) => `${d.name} ${d.tags.join(" ")} ${r.name}`.toLowerCase().includes(a)));
  const full = allowed.filter(({ r, d }) => hits(r, d) === want.length);
  const matches = full.length ? full : allowed.filter(({ r, d }) => hits(r, d) > 0);
  const ok = matches.filter((x) => x.total <= budget && x.r.etaMin <= limit);
  if (!ok.length) return null;
  // Score: rating matters most, then total cost against the budget, then time against the limit.
  const scored = ok.map((x) => ({ ...x, score: x.r.rating * 2 - (x.total / budget) * 1.5 - (x.r.etaMin / limit) * 0.8 })).sort((a, b) => b.score - a.score);
  const cheapest = Math.min(...ok.map((x) => x.total));
  const fastest = Math.min(...ok.map((x) => x.r.etaMin));
  const toPick = (x: (typeof scored)[number]): NowPick => {
    const reasons = [
      x.r.rating >= 4.5 ? `rated ${x.r.rating}` : "",
      x.total === cheapest ? "cheapest that fits" : `${money(x.total)} with delivery`,
      x.r.etaMin === fastest ? `fastest at ${x.r.etaMin} min` : `${x.r.etaMin} min`,
    ].filter(Boolean);
    return { restaurantId: x.r.id, restaurant: x.r.name, dish: x.d.name, price: x.d.price, fee: x.r.fee, total: x.total, rating: x.r.rating, etaMin: x.r.etaMin, why: `${reasons.join(", ")}. Picked from ${ok.length} options that are under ${money(budget)} and arrive within ${limit} min (${matches.length - ok.length} others were too slow or too expensive).` };
  };
  return { pick: toPick(scored[0]), alternatives: scored.slice(1, 3).map(toPick), considered: matches.length };
}
