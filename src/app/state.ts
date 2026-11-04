import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { ProposedOrder, PageSnapshot, Pocket, SignedMandate, DeliveryReading } from "../core/types.ts";
import type { GuardDecision } from "../core/guard.ts";
import type { ArbiterResult } from "../core/arbiter.ts";
import type { MerchantResponse } from "../agent/agents.ts";

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
}

const FILE = "data/state.json";
let state: AppState | null = null;

export function loadState(): AppState {
  if (state) return state;
  mkdirSync("data", { recursive: true });
  if (existsSync(FILE)) {
    state = JSON.parse(readFileSync(FILE, "utf8")) as AppState;
  } else {
    state = freshState();
    saveState();
  }
  return state;
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
  };
}

export function resetState(keepVault = true): AppState {
  const vault = state?.vault ?? null;
  state = freshState();
  if (keepVault && vault) state.vault = vault;
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
  const { userKeyPem, pendingSetupToken, ...rest } = loadState();
  return rest;
}
