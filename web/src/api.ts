import { useCallback, useEffect, useRef, useState } from "react";

/* ---------------------------- Types (mirror the backend JSON) ---------------------------- */

export type Attributes = Record<string, string>;

export type AskMode = "anything" | "money";

/** A pocket is an agent: its own money, name, colour and one job. */
export interface Pocket {
  id: string; name: string; balance: number; currency: "USD";
  color?: string; askMode?: AskMode; paused?: boolean; lastReadAt?: string; createdAt?: string;
  /** Closed agents never buy again; their records stay. */
  closedAt?: string;
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
  needsYou?: boolean; proposalId?: string; purchaseId?: string;
}
export interface ActiveException { agentId: string; baseMandateId: string; tempMandateId: string; scope: "once" | "until"; until?: string; proposalId: string }

export interface Mandate {
  id: string; pocketId: string; instruction: string; item: string;
  required: Attributes; allowed: Record<string, string[]>;
  maxUnitPrice: number; maxQuantity: number; merchants: string[]; expiresAt: string; createdAt: string;
  /** Words that must never appear in what is bought ("not paprika"). */
  avoid?: string[];
}
export interface SignedMandate { mandate: Mandate; publicKey: string; signature: string }
export type MandateDraft = Pick<Mandate, "item" | "required" | "allowed" | "maxUnitPrice" | "maxQuantity" | "expiresAt" | "avoid">;

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
  status: "blocked" | "needs_approval" | "completed" | "failed" | "disputed" | "resolved" | "escalated";
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
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Polls /api/state so every screen (phone, console, store) stays in sync during the demo. */
export function useAppState(intervalMs = 2000) {
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
    const t = setInterval(refresh, intervalMs);
    return () => { alive.current = false; clearInterval(t); };
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
