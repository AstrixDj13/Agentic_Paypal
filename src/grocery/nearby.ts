/**
 * SIMULATED nearby shops for one-time hunts. In production this would come from local
 * inventory feeds (store availability APIs); here it's deterministic per product so a demo
 * always shows the same thing. The agent recommends the shop and takes no payment: it's
 * proof the agent works for the user, not for any store.
 */

const SHOPS = [
  { name: "Fleet Feet", address: "214 Market St" },
  { name: "Foot Locker", address: "88 Grand Ave" },
  { name: "Dick's Sporting Goods", address: "Westfield Center, level 2" },
  { name: "Big 5 Sporting Goods", address: "1550 Mission St" },
  { name: "Running Warehouse Outlet", address: "9 Harbor Blvd" },
];

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };

export interface NearbyOffer { shop: string; address: string; distanceKm: number; price: number; onlinePrice: number; simulated: true }

/** A nearby shop selling the same item for at least $3 less, or null. About 6 in 10 products have one. */
export function nearbyOffer(productId: string, onlinePrice: number): NearbyOffer | null {
  const h = hash(productId);
  if (h % 10 >= 6 || onlinePrice < 20) return null;
  const cheaper = 3 + (h % 9); // $3 to $11 less
  const shop = SHOPS[h % SHOPS.length];
  return {
    shop: shop.name,
    address: shop.address,
    distanceKm: Math.round((0.6 + ((h >>> 4) % 40) / 10) * 10) / 10,
    price: Math.round((onlinePrice - cheaper) * 100) / 100,
    onlinePrice,
    simulated: true,
  };
}
