import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { ProposedOrder, PageSnapshot, Pocket, SignedMandate, DeliveryReading } from "../core/types.ts";
import type { GuardDecision } from "../core/guard.ts";
import type { ArbiterResult } from "../core/arbiter.ts";
import type { MandateDraft, MerchantResponse } from "../agent/agents.ts";
import type { AuthState } from "./auth.ts";

export type PurchaseStatus = "blocked" | "needs_approval" | "completed" | "failed" | "disputed" | "resolved" | "escalated";

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
  /** PIN hash and registered Face ID / fingerprint keys. Never sent to the browser. */
  auth?: AuthState;
}

const FILE = "data/state.json";
let state: AppState | null = null;

export function loadState(): AppState {
  if (state) return state;
  mkdirSync("data", { recursive: true });
  if (existsSync(FILE)) {
    state = migrate(JSON.parse(readFileSync(FILE, "utf8")) as AppState);
  } else {
    state = freshState();
    saveState();
  }
  return state;
}

/** Older saved state predates agents: give every pocket an identity and add the new collections. */
function migrate(s: AppState): AppState {
  s.chats ??= [];
  s.proposals ??= [];
  s.exceptions ??= [];
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
  };
}

export function resetState(keepVault = true): AppState {
  const vault = state?.vault ?? null;
  const auth = state?.auth;
  state = freshState();
  if (keepVault && vault) state.vault = vault;
  if (auth) state.auth = { ...auth, failed: 0, challenge: undefined }; // keep your PIN / Face ID across demo resets
  saveState();
  return state;
}

export function saveState(): void {
  if (state) writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function userKey(): KeyObject {
  return createPrivateKey(loadState().userKeyPem);
}

/** Public view: never send the private key to the browser. */
export function publicState() {
  const { userKeyPem, pendingSetupToken, auth, ...rest } = loadState();
  return rest;
}
