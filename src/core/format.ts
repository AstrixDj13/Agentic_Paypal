/** How agents write dates and brand names for people (values are stored lower case / ISO for matching). */

const SPECIAL: Record<string, string> = { asics: "ASICS", hoka: "HOKA", "new balance": "New Balance", on: "On", lg: "LG", hp: "HP", "de cecco": "De Cecco", frostpeak: "FrostPeak", airpulse: "AirPulse", cardpro: "CardPro", livestage: "LiveStage", resalehub: "ResaleHub" };

/** "nike" -> "Nike", "new balance" -> "New Balance", "asics" -> "ASICS". Display only. */
export function brandName(b: string): string {
  const k = b.trim().toLowerCase();
  return SPECIAL[k] ?? k.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** ["nike", "adidas"] -> "Nike or Adidas"; three or more -> "Nike, Adidas or Puma". */
export function brandList(list: string[] = [], joiner = "or"): string {
  const names = list.map(brandName);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${joiner} ${names.at(-1)}`;
}

/** "2026-11-30T23:59:59Z" -> "Nov 30" (adds the year only when it isn't this year). */
export function niceDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}
