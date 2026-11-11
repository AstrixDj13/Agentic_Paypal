import { useCallback, useEffect, useRef, useState } from "react";

/* ---------------------------- Types (mirror the backend JSON) ---------------------------- */

export type Attributes = Record<string, string>;

export type AskMode = "anything" | "money";
export type AgentKind = "hunt" | "routine" | "now" | "recurring";
import type { BillsView } from "./components/bills";
export interface ListItem { id: string; group: string; name: string; size: string; productId: string; qty: number; usualPrice: number }

/** A pocket is an agent: its own money, name, colour and one job. */
export interface Pocket {
  id: string; name: string; balance: number; currency: "USD";
  color?: string; askMode?: AskMode; paused?: boolean; lastReadAt?: string; createdAt?: string;
  /** Closed agents never buy again; their records stay. */
  closedAt?: string;
  /** "Take a look before I buy": seconds to wait (and ping the phone) before an in-rules purchase. */
  lookFirstSec?: number;
  kind?: AgentKind;
  checkNearby?: boolean;
  prefs?: { keepUsual?: string[]; autoSwapCheaper?: boolean; week?: number; orderDeadlineSec?: number };
}

export interface DiffRow { label: string; from: string; to: string }
export interface Proposal {
  id: string; agentId: string; kind: "rule_change" | "transfer" | "job";
  instruction?: string;
  status: "pending" | "approved" | "declined" | "superseded";
  summary: string; diff: DiffRow[];
  scope?: "once" | "until" | "always"; until?: string;
  fromAgentId?: string; amount?: number; retryProductId?: string;
  createdAt: string; decidedAt?: string;
}
export interface ChatMessage {
  id: string; agentId: string; from: "user" | "agent" | "system"; text: string; at: string;
  needsYou?: boolean; proposalId?: string; purchaseId?: string; orderId?: string;
  /** Subscriptions and bills: the alert this message is about. */
  alertId?: string;
  /** The agent's first greeting; the app shows its own intro card instead. */
  intro?: boolean;
}
export interface ActiveException { agentId: string; baseMandateId: string; tempMandateId: string; scope: "once" | "until"; until?: string; proposalId: string }

export interface Mandate {
  id: string; pocketId: string; instruction: string; item: string;
  required: Attributes; allowed: Record<string, string[]>;
  maxUnitPrice: number; maxQuantity: number; merchants: string[]; expiresAt: string; createdAt: string;
  /** Words that must never appear in what is bought ("not paprika"). */
  avoid?: string[];
  /** How the user described the product; the agent searches with it. */
  description?: string;
  /** Hash of a reference photo (served at /api/intel/image/:hash). */
  refImage?: string;
  kind?: AgentKind;
  list?: ListItem[];
  withinMinutes?: number;
}
export interface SignedMandate { mandate: Mandate; publicKey: string; signature: string }
export type MandateDraft = Pick<Mandate, "item" | "required" | "allowed" | "maxUnitPrice" | "maxQuantity" | "expiresAt" | "avoid" | "description" | "refImage">;

export interface ProposedOrder {
  mandateId: string; merchantId: string; productId: string; title: string;
  attributes: Attributes; unitPrice: number; quantity: number; reasoning: string;
}
export interface PageSnapshot { url: string; productId: string; title: string; attributes: Attributes; unitPrice: number; listingText: string; capturedAt: string }
export interface Violation { rule: string; detail: string }
export interface Finding { field: string; compared: string; expected: string; actual: string }
export type Verdict = "MERCHANT_AT_FAULT" | "AGENT_AT_FAULT" | "INSTRUCTION_UNCLEAR" | "NEEDS_REVIEW";

export interface Purchase {
  id: string; mandateId: string; pocketId: string; productId: string; title: string;
  status: "blocked" | "needs_approval" | "awaiting_look" | "skipped" | "store_suggested" | "bought_in_store" | "completed" | "failed" | "disputed" | "resolved" | "escalated";
  /** Honest savings: what you usually pay (total) and usual minus paid, when known. */
  usual?: number;
  saved?: number;
  lines?: OrderLine[];
  orderId?: string;
  storeOffer?: { shop: string; address: string; distanceKm: number; price: number; onlinePrice: number; simulated: true };
  /** Look-first purchases go ahead at this time unless skipped. */
  lookUntil?: string;
  mode: "careful" | "naive";
  order: ProposedOrder; snapshot: PageSnapshot;
  decision: { outcome: "allow" | "ask_user" | "block"; violations: Violation[]; total: number };
  total: number; why?: string; error?: string;
  paypal?: { orderId: string; captureId?: string; status: string };
  dispute?: {
    complaint: string;
    delivered: { attributes: Attributes; confidence: number; photoRef: string; source: string };
    merchant: { stance: "accept" | "contest"; message: string; evidence: { shippedAttributes: Attributes } };
    result: { verdict: Verdict; action: string; findings: Finding[]; reason: string };
    explanation: string;
    resolution?: { type: string; paypalId?: string; amount?: number; detail: string; proposedFix?: { item: string; note: string }; at: string };
  };
  createdAt: string;
}

export interface Product {
  id: string; title: string; attributes: Attributes; unitPrice: number; inStock: boolean;
  listingText: string; hiddenText?: string; image: string; shipsAs?: Attributes;
  imageUrl?: string;
  source?: { kind: "channel3"; productId: string; url: string; domain: string; sizes: string[]; fetchedAt: string };
}

/** Result of "Find it for me": real listings (Channel3) with why each does or doesn't fit, plus what the agent did. */
export interface FindResult {
  found: { product: Product; reasons: string[] }[];
  purchase?: Purchase;
  skipped?: string;
}

export interface AppState {
  buyerEmail: string;
  vault: { vaultId: string; connectedAt: string } | null;
  killSwitch: boolean; maxPurchasesPerDay: number; knownMerchants: string[];
  pockets: Pocket[]; mandates: SignedMandate[]; retiredMandates: SignedMandate[]; purchases: Purchase[];
  ai: { provider: string; model: string; enabled: boolean; calls: number; lastError?: string };
  products: Product[]; photoPresets: string[];
  channel3: { enabled: boolean };
  chats: ChatMessage[]; proposals: Proposal[]; exceptions: ActiveException[];
  orders?: Order[];
  /** Subscriptions and bills (simulated merchants): pockets, alerts, what's coming up. */
  bills?: BillsView;
}

export interface LedgerEntry { seq: number; ts: string; purchaseId: string; kind: string; payload: any; prevHash: string; hash: string }
export interface VerifyResult { ok: boolean; brokenAt?: number; checked: number }

/* ------------------------------------- HTTP helpers ------------------------------------- */

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Signed out (or the session expired): the app shows the sign-in screen.
  if (res.status === 401 && data.code === "signin") window.dispatchEvent(new Event("pocket:signin"));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/**
 * Keeps every screen (phone, console, store) in sync. The server pushes "changed" over
 * server-sent events the moment anything happens; a slow poll is only a fallback.
 */
export function useAppState(intervalMs = 15000) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const s = await api<AppState>("/api/state");
      if (alive.current) { setState(s); setError(null); }
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, Math.max(intervalMs, 10000));
    let es: EventSource | undefined;
    try {
      es = new EventSource("/api/events");
      es.onmessage = () => refresh();
    } catch { /* no SSE: the poll keeps things fresh */ }
    return () => { alive.current = false; clearInterval(t); es?.close(); };
  }, [refresh, intervalMs]);
  return { state, error, refresh };
}

export interface Toast { text: string; error?: boolean; action?: { label: string; run: () => void } }

/** Tiny toast helper shared by pages. */
export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const show = useCallback((text: string, error = false, action?: Toast["action"]) => {
    clearTimeout(timer.current);
    setToast({ text, error, action });
    // Longer when there's an Undo, so there's time to reach it.
    timer.current = setTimeout(() => setToast(null), action ? 6000 : 3500);
  }, []);
  return { toast, show };
}

/* -------------------------------------- Formatting -------------------------------------- */

export const money = (n: number | undefined) => (n === undefined ? "–" : `$${n.toFixed(2)}`);
export const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const prettyKey = (k: string) => k.replace(/_us$/, " (US)").replace(/_uk$/, " (UK)").replace(/_/g, " ");
export const attrsText = (a: Attributes) => Object.entries(a).map(([k, v]) => `${prettyKey(k)} ${v}`).join(" · ");

export const STATUS_LABEL: Record<Purchase["status"], { text: string; tone: string }> = {
  completed: { text: "Bought", tone: "ok" },
  awaiting_look: { text: "Take a look", tone: "warn" },
  store_suggested: { text: "Cheaper in store", tone: "warn" },
  bought_in_store: { text: "Bought in store", tone: "ok" },
  skipped: { text: "Skipped", tone: "neutral" },
  blocked: { text: "Stopped", tone: "danger" },
  needs_approval: { text: "Needs approval", tone: "warn" },
  failed: { text: "Payment failed", tone: "danger" },
  disputed: { text: "Under review", tone: "warn" },
  resolved: { text: "Settled", tone: "ok" },
  escalated: { text: "Escalated", tone: "warn" },
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  MERCHANT_AT_FAULT: "Merchant at fault",
  AGENT_AT_FAULT: "Agent at fault",
  INSTRUCTION_UNCLEAR: "Rule was unclear",
  NEEDS_REVIEW: "Needs a clearer photo",
};

export const PRESET_LABEL: Record<string, string> = {
  "label-us10": "Label: Nike US 10",
  "label-us11": "Label: Nike US 11",
  "label-adidas-us11": "Label: Adidas US 11 / UK 10",
  blurry: "Blurry photo",
};

/** Shrink a camera photo before upload (keeps requests small and fast). */
export async function fileToDataUrl(file: File, maxSide = 1024): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/* ---------------------------- What Pocket knows (behaviour memory) ---------------------------- */

export interface Signal {
  id: string; at: string; source: "extension" | "share" | "search" | "snap" | "app";
  kind: "view" | "search" | "cart" | "purchase" | "approve" | "skip" | "decline" | "dispute" | "photo";
  title?: string; brand?: string; price?: number; url?: string; domain?: string; query?: string; imageUrl?: string; size?: string; dwellMs?: number; note?: string;
}
export interface Interest {
  key: string; label: string; words: string[]; brand?: string; category: string; score: number;
  views: number; searches: number; dwellMin: number; domains: string[]; imageUrl?: string; priceMin?: number; priceMax?: number; lastAt: string; bought: boolean;
}
export interface Profile {
  sizes: { size: string; count: number; why: string }[];
  brands: { brand: string; score: number; why: string }[];
  dislikedBrands: { brand: string; why: string }[];
  interests: Interest[];
  priceHabits: { category: string; typical: number; max: number; why: string }[];
  flexibility?: { overPct: number; why: string };
  askHint?: { mode: "money" | "anything"; why: string };
  avoidHints: { word: string; why: string }[];
  signalCount: number;
}
export interface AgentSuggestion { key: string; title: string; why: string; instruction: string; amount: number; imageUrl?: string; domains: string[] }
export interface IntelView {
  paused: boolean; signals: Signal[];
  devices: { id: string; label: string; pairedAt: string; lastSeenAt?: string }[];
  dismissed: string[]; profile: Profile; suggestions: AgentSuggestion[];
}
export interface RuleTip { id: string; text: string; why: string; patch: Partial<MandateDraft> }
export interface WantResult {
  item: string; brand?: string; description: string; confidence: number;
  matches: { title: string; price: number; domain?: string; url?: string; imageUrl?: string; brand?: string }[];
  instruction: string; amount: number; refImage?: string; source: "photo" | "link";
}
/** What a new agent can start from: a suggestion, a photo, or a shared link. */
export interface AgentPrefill { instruction: string; amount?: number; description?: string; refImage?: string; why?: string }

/** Polls /api/intel (lighter than state; only screens that show it use it). */
export function useIntel(intervalMs = 5000) {
  const [intel, setIntel] = useState<IntelView | null>(null);
  const refresh = useCallback(async () => { try { setIntel(await api<IntelView>("/api/intel")); } catch { /* offline: keep last */ } }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, intervalMs); return () => clearInterval(t); }, [refresh, intervalMs]);
  return { intel, refresh };
}

/* ---------------------------- Weekly orders, right-now picks, savings ---------------------------- */

export interface OrderOption { productId: string; title: string; brand: string; store: string; price: number; regular: number; onDeal: boolean }
export interface OrderLine {
  itemId: string; name: string; size: string; qty: number;
  usual: { productId: string; title: string; store: string; price: number; inStock: boolean };
  usualPrice: number;
  chosen?: { productId: string; title: string; brand: string; store: string; price: number };
  kind: "usual" | "swap" | "substitute" | "skipped";
  ask?: { type: "swap" | "stockout"; status: "pending" | "accepted" | "kept" | "default" | "auto"; reason: string; options: OrderOption[] };
  note?: string;
}
export interface NowPick { restaurantId: string; restaurant: string; dish: string; price: number; fee: number; total: number; rating: number; etaMin: number; why: string }
export interface Order {
  id: string; agentId: string; mandateId: string; kind: "weekly" | "now";
  status: "awaiting" | "needs_approval" | "placed" | "failed" | "blocked" | "cancelled";
  createdAt: string; deadline?: string; week?: number; lines?: OrderLine[]; pick?: NowPick; alternatives?: NowPick[];
  total: number; usualTotal?: number; saved?: number; purchaseId?: string; error?: string;
}

export const STORE_NAME: Record<string, string> = { freshcart: "FreshCart", dailymart: "DailyMart" };

/**
 * Saved this month, honestly: only purchases where we know what the user usually pays
 * (weekly orders, buying in store). Undefined when there's nothing to compare against yet,
 * so the UI shows "Savings appear after your first week" instead of a $0 or a made-up number.
 */
export function savedThisMonth(state: AppState, agentId?: string): number | undefined {
  const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
  const counted = state.purchases.filter((p) => (!agentId || p.pocketId === agentId) && p.usual !== undefined && p.saved !== undefined
    && ["completed", "disputed", "escalated", "bought_in_store"].includes(p.status) && Date.parse(p.createdAt) >= start.getTime());
  if (!counted.length) return undefined;
  // Net: a week that cost a little more than usual counts against the total (never shown below $0).
  return Math.max(0, Math.round(counted.reduce((t, p) => t + (p.saved ?? 0), 0) * 100) / 100);
}
