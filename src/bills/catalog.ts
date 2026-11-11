/**
 * Simulated subscriptions and bills (labelled as simulated in the app, like the demo stores).
 * Nothing here talks to the real merchants: the names are only there so the demo is relatable.
 *
 * `script` is what the merchant asks for in each simulated month (month 1 = the first
 * "Next month (demo)"). Missing months charge the normal price.
 */

export type BillerKind = "subscription" | "bill";
export type BillerCategory = "streaming" | "music" | "cloud" | "fitness" | "electricity" | "gas" | "phone" | "learning";

export interface Biller {
  id: string;
  name: string;
  kind: BillerKind;
  category: BillerCategory;
  /** Subscriptions: the monthly price. Bills: the usual amount (it varies). */
  price: number;
  /** In how many days the next charge is due (spreads the "Next 7 days" view). */
  dueInDays: number;
  /** A free trial that turns paid after this many days. */
  trialDays?: number;
  color: string;
  /** Found on the user's PayPal as an automatic payment (first-run discovery). */
  discovered: boolean;
  script?: Record<number, number>;
}

export const BILLERS: Biller[] = [
  // Netflix raises its price in the first simulated month: the hero story.
  { id: "netflix", name: "Netflix", kind: "subscription", category: "streaming", price: 15.49, dueInDays: 3, color: "#e5484d", discovered: true, script: { 1: 22.99, 2: 22.99, 3: 22.99 } },
  { id: "spotify", name: "Spotify", kind: "subscription", category: "music", price: 11.99, dueInDays: 5, color: "#19a35b", discovered: true },
  { id: "apple-music", name: "Apple Music", kind: "subscription", category: "music", price: 10.99, dueInDays: 9, color: "#e5489b", discovered: true },
  { id: "icloud", name: "iCloud+", kind: "subscription", category: "cloud", price: 2.99, dueInDays: 12, color: "#0070e0", discovered: true },
  { id: "gym", name: "Northside Gym", kind: "subscription", category: "fitness", price: 29.99, dueInDays: 15, color: "#ff7a1a", discovered: true },
  // The electricity bill is unusually high in the first simulated month.
  { id: "electricity", name: "City Power", kind: "bill", category: "electricity", price: 90, dueInDays: 6, color: "#d4a106", discovered: true, script: { 1: 142, 2: 93.4, 3: 88.75 } },
  { id: "studypro", name: "StudyPro", kind: "subscription", category: "learning", price: 9.99, dueInDays: 4, trialDays: 4, color: "#7c4dff", discovered: true },
  // In the merchant picker only (not found on PayPal).
  { id: "gas", name: "Metro Gas", kind: "bill", category: "gas", price: 45, dueInDays: 20, color: "#0aa5a5", discovered: false, script: { 1: 51.2, 2: 47.8 } },
  { id: "phone", name: "Mobile plan", kind: "subscription", category: "phone", price: 25, dueInDays: 18, color: "#6b7280", discovered: false },
];

export const billerById = (id: string) => BILLERS.find((b) => b.id === id);

/** What the merchant asks for in a simulated month. */
export function amountFor(b: Biller, month: number, agreedPrice: number): number {
  return b.script?.[month] ?? (b.kind === "bill" ? b.price : agreedPrice);
}

/** Two subscriptions in the same category that do the same job (Spotify and Apple Music). */
export const DUPLICATE_CATEGORIES: BillerCategory[] = ["music", "streaming", "cloud"];
