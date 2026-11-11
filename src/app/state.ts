import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { ProposedOrder, PageSnapshot, Pocket, SignedMandate, DeliveryReading } from "../core/types.ts";
import type { GuardDecision } from "../core/guard.ts";
import type { ArbiterResult } from "../core/arbiter.ts";
import type { MandateDraft, MerchantResponse } from "../agent/agents.ts";
import type { AuthState } from "./auth.ts";
import { currentEntry, localEntry, markChanged } from "../db/store.ts";
import { pgEnabled } from "../db/pg.ts";

export type PurchaseStatus = "blocked" | "needs_approval" | "awaiting_look" | "skipped" | "store_suggested" | "bought_in_store" | "completed" | "failed" | "disputed" | "resolved" | "escalated";

/** A line on a weekly order: the usual item, and what was actually chosen (usual, a swap, or a substitute). */
export interface OrderLine {
  itemId: string;
  name: string;
  size: string;
  qty: number;
  usual: { productId: string; title: string; store: string; price: number; inStock: boolean };
  /** What the user usually pays (each). */
  usualPrice: number;
  chosen?: { productId: string; title: string; brand: string; store: string; price: number };
  kind: "usual" | "swap" | "substitute" | "skipped";
  ask?: {
    type: "swap" | "stockout";
    status: "pending" | "accepted" | "kept" | "default" | "auto";
    reason: string;
    options: { productId: string; title: string; brand: string; store: string; price: number; regular: number; onDeal: boolean }[];
  };
  note?: string;
}

/** Right-now agent: one restaurant pick with its reasons. */
export interface NowPick {
  restaurantId: string;
  restaurant: string;
  dish: string;
  price: number;
  fee: number;
  total: number;
  rating: number;
  etaMin: number;
  why: string;
}

/** A weekly grocery order or a right-now order, before it becomes a Purchase. */
export interface Order {
  id: string;
  agentId: string;
  mandateId: string;
  kind: "weekly" | "now";
  status: "awaiting" | "needs_approval" | "placed" | "failed" | "blocked" | "cancelled";
  createdAt: string;
  deadline?: string;
  week?: number;
  lines?: OrderLine[];
  pick?: NowPick;
  alternatives?: NowPick[];
  total: number;
  usualTotal?: number;
  saved?: number;
  purchaseId?: string;
  error?: string;
}

export interface Resolution {
  type: "refund" | "payout" | "mandate_fix" | "review" | "evidence_pack";
  paypalId?: string;
  amount?: number;
  detail: string;
  proposedFix?: { item: string; note: string };
  at: string;
}

export interface Purchase {
  id: string;
  mandateId: string;
  pocketId: string;
  productId: string;
  title: string;
  status: PurchaseStatus;
  mode: "careful" | "naive";
  order: ProposedOrder;
  snapshot: PageSnapshot;
  decision: GuardDecision;
  total: number;
  why?: string;
  /** "Take a look before I buy": the purchase goes ahead at this time unless the user skips it. */
  lookUntil?: string;
  /** Honest savings: what the user usually pays for this (total), and usual minus paid when that's known. */
  usual?: number;
  saved?: number;
  /** Weekly orders: the lines that were bought. */
  lines?: OrderLine[];
  orderId?: string;
  /** "Buy it in store instead": a nearby shop with the same item for less. No payment through Pocket. */
  storeOffer?: { shop: string; address: string; distanceKm: number; price: number; onlinePrice: number; simulated: true };
  paypal?: { orderId: string; captureId?: string; status: string };
  error?: string;
  dispute?: {
    complaint: string;
    delivered: DeliveryReading & { source: string };
    merchant: MerchantResponse;
    result: ArbiterResult;
    explanation: string;
    resolution?: Resolution;
  };
  createdAt: string;
}

/* ----------------------------- Agents: chat, proposals, exceptions ----------------------------- */

/** What a rule change may touch. Anything else the model suggests is dropped. */
export interface RuleChanges {
  maxUnitPrice?: number;
  maxQuantity?: number;
  /** Full replacement list of allowed brands (lowercase). */
  brands?: string[];
  /** Exact attributes to set, e.g. { size_us: "10.5" }. */
  required?: Record<string, string>;
  expiresAt?: string;
  item?: string;
}

/** "once" = next purchase only; "until" = until a date; "always" = permanent new rule. */
export type ChangeScope = "once" | "until" | "always";

export interface DiffRow { label: string; from: string; to: string }

/** The chat never changes anything itself: it can only create one of these for the user to sign. */
export interface Proposal {
  id: string;
  agentId: string;
  kind: "rule_change" | "transfer" | "job";
  status: "pending" | "approved" | "declined" | "superseded";
  summary: string;
  diff: DiffRow[];
  changes?: RuleChanges;
  scope?: ChangeScope;
  until?: string;
  fromAgentId?: string;
  amount?: number;
  /** kind "job": the agent's new one job, in the user's words and as structured rules. */
  instruction?: string;
  draft?: MandateDraft;
  /** After approval the agent tries this product again (it was blocked only by this limit). */
  retryProductId?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  from: "user" | "agent" | "system";
  text: string;
  at: string;
  /** True when the agent needs a decision from you (counts as unread even in "only ask about money"). */
  needsYou?: boolean;
  proposalId?: string;
  purchaseId?: string;
  orderId?: string;
  /** Subscriptions and bills: the alert this message is about (price hike, trial, duplicate, unusual bill). */
  alertId?: string;
  /** The agent's first "Hi, I'm…" message. The app shows its own intro card instead, so it hides these. */
  intro?: boolean;
}

/** A one-time or temporary rule change in force. The base mandate comes back when it ends. */
export interface ActiveException {
  agentId: string;
  baseMandateId: string;
  tempMandateId: string;
  scope: "once" | "until";
  until?: string;
  proposalId: string;
}

export const AGENT_COLORS = ["#0070e0", "#7c4dff", "#e5489b", "#ff7a1a", "#19a35b", "#0aa5a5", "#d4a106", "#e5484d"];

export interface AppState {
  buyerEmail: string;
  userKeyPem: string;
  vault: { vaultId: string; customerId?: string; connectedAt: string } | null;
  pendingSetupToken?: string;
  killSwitch: boolean;
  maxPurchasesPerDay: number;
  knownMerchants: string[];
  pockets: Pocket[];
  mandates: SignedMandate[];
  /** Mandates replaced by a fix keep their id here so old purchases still resolve. */
  retiredMandates: SignedMandate[];
  purchases: Purchase[];
  chats: ChatMessage[];
  proposals: Proposal[];
  exceptions: ActiveException[];
  /** Weekly grocery orders and right-now orders. */
  orders?: Order[];
  /** PIN hash and registered Face ID / fingerprint keys. Never sent to the browser. */
  auth?: AuthState;
}

const FILE = "data/state.json";

/** File mode (no database): the single local user's state, read once from data/state.json. */
function loadFile(): AppState {
  mkdirSync("data", { recursive: true });
  if (existsSync(FILE)) return migrate(JSON.parse(readFileSync(FILE, "utf8")) as AppState);
  const fresh = freshState();
  writeFileSync(FILE, JSON.stringify(fresh, null, 2));
  return fresh;
}

/** The signed-in user's entry for this request (PostgreSQL), or the single local user (file mode). */
function entry() {
  const e = currentEntry();
  if (e) return e;
  if (pgEnabled()) throw new Error("No signed-in user for this request.");
  return localEntry(loadFile);
}

/** The current request's user entry (state, recorder, live-update listeners). */
export const currentUserEntry = () => entry();

/** The current user's state (held in memory; persisted by saveState). */
export function loadState(): AppState {
  return entry().state;
}

/** Older saved state predates agents: give every pocket an identity and add the new collections. */
export function migrate(s: AppState): AppState {
  s.chats ??= [];
  s.proposals ??= [];
  s.exceptions ??= [];
  s.orders ??= [];
  s.pockets.forEach((p, i) => {
    p.color ??= AGENT_COLORS[i % AGENT_COLORS.length];
    p.askMode ??= "money";
    p.paused ??= false;
    p.createdAt ??= new Date().toISOString();
  });
  return s;
}

/** Vault id from PAYPAL_VAULT_ID, or the one saved by `npm run spike`. */
function seedVault(): AppState["vault"] {
  const now = new Date().toISOString();
  if (process.env.PAYPAL_VAULT_ID) return { vaultId: process.env.PAYPAL_VAULT_ID, connectedAt: now };
  try {
    const spike = JSON.parse(readFileSync("data/spike-results.json", "utf8"));
    const id = spike.results?.find((r: any) => r.step?.startsWith("6.") && r.status === "PASS")?.detail?.match(/vault id (\S+)/)?.[1];
    return id ? { vaultId: id, connectedAt: now } : null;
  } catch {
    return null;
  }
}

export function freshState(): AppState {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    buyerEmail: process.env.SANDBOX_BUYER_EMAIL ?? "",
    userKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    vault: seedVault(),
    killSwitch: false,
    maxPurchasesPerDay: 3,
    knownMerchants: [],
    pockets: [],
    mandates: [],
    retiredMandates: [],
    purchases: [],
    chats: [],
    proposals: [],
    exceptions: [],
    orders: [],
  };
}

export function resetState(keepVault = true): AppState {
  const e = entry();
  let state: AppState | null = e.state;
  const vault = state?.vault ?? null;
  const auth = state?.auth;
  // What Pocket learned, paired browsers and notification subscriptions are the user's, not the demo's.
  const keep = state as (AppState & { intel?: unknown; push?: unknown }) | null;
  const intel = keep?.intel, push = keep?.push;
  state = freshState();
  if (intel) (state as AppState & { intel?: unknown }).intel = intel;
  if (push) (state as AppState & { push?: unknown }).push = push;
  if (keepVault && vault) state.vault = vault;
  if (auth) state.auth = { ...auth, failed: 0, challenge: undefined }; // keep your PIN / Face ID across demo resets
  e.state = state;
  saveState();
  return state;
}

/** Persist the current user's state: a debounced write of changed rows (PostgreSQL), or the JSON file. */
export function saveState(): void {
  const e = entry();
  if (!pgEnabled()) writeFileSync(FILE, JSON.stringify(e.state, null, 2));
  markChanged(e);
}

export function userKey(): KeyObject {
  return createPrivateKey(loadState().userKeyPem);
}

/** Public view: never send the private key to the browser. */
export function publicState() {
  const { userKeyPem, pendingSetupToken, auth, ...rest } = loadState();
  return rest;
}
