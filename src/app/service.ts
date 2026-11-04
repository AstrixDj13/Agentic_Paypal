import { randomUUID } from "node:crypto";
import { arbitrate } from "../core/arbiter.ts";
import { checkOrder } from "../core/guard.ts";
import { signMandate } from "../core/mandate.ts";
import { FlightRecorder } from "../core/recorder.ts";
import type { GuardState, Mandate, Pocket, SignedMandate } from "../core/types.ts";
import * as agents from "../agent/agents.ts";
import { PayPalClient, PayPalError, approveLink } from "../paypal/client.ts";
import * as pp from "../paypal/api.ts";
import * as store from "../store/catalog.ts";
import { loadState, saveState, userKey, type Purchase, type Resolution } from "./state.ts";

/** Orchestrates the buy path (agent -> guard -> PayPal) and the dispute path (photo -> arbiter -> PayPal). */

export const recorder = new FlightRecorder("data/ledger.jsonl");

const env = (k: string) => process.env[k] ?? "";
let storeClient: PayPalClient | undefined;
let coverClient: PayPalClient | undefined;
const storePP = () => (storeClient ??= new PayPalClient(env("PAYPAL_CLIENT_ID"), env("PAYPAL_CLIENT_SECRET")));
const coverPP = () => (coverClient ??= env("COVER_POOL_CLIENT_ID") ? new PayPalClient(env("COVER_POOL_CLIENT_ID"), env("COVER_POOL_CLIENT_SECRET")) : storePP());

export class UserError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ppErr = (e: unknown) => (e instanceof PayPalError ? `PayPal ${e.status}: ${JSON.stringify(e.body).slice(0, 300)}` : String(e));

/* ---------------------------------- PayPal connect (Vault) ---------------------------------- */

export async function startPaypalConnect(baseUrl: string): Promise<string> {
  const setup = await pp.createSetupToken(storePP(), `${baseUrl}/api/paypal/return`, `${baseUrl}/?paypal=cancelled`);
  const s = loadState();
  s.pendingSetupToken = setup.id;
  saveState();
  const link = approveLink(setup);
  if (!link) throw new UserError("PayPal did not return an approval link.");
  return link;
}

export async function finishPaypalConnect(): Promise<void> {
  const s = loadState();
  if (!s.pendingSetupToken) throw new UserError("No PayPal connection in progress.");
  const token = await pp.createPaymentToken(storePP(), s.pendingSetupToken);
  s.vault = { vaultId: token.id, customerId: token.customer?.id, connectedAt: new Date().toISOString() };
  delete s.pendingSetupToken;
  saveState();
}

/* ---------------------------------------- Pockets ---------------------------------------- */

export function createPocket(name: string, amount: number): Pocket {
  if (!name.trim() || !(amount > 0)) throw new UserError("Pocket needs a name and a positive amount.");
  const s = loadState();
  const pocket: Pocket = { id: `pk_${randomUUID().slice(0, 8)}`, name: name.trim(), balance: round2(amount), currency: "USD" };
  s.pockets.push(pocket);
  saveState();
  return pocket;
}

function pocketOf(id: string): Pocket {
  const p = loadState().pockets.find((x) => x.id === id);
  if (!p) throw new UserError(`Unknown pocket ${id}`);
  return p;
}

/* ---------------------------------------- Mandates ---------------------------------------- */

export async function draftMandate(instruction: string) {
  if (!instruction.trim()) throw new UserError("Write what the agent may buy.");
  return agents.parseInstruction(instruction);
}

export function signNewMandate(pocketId: string, instruction: string, rawDraft: agents.MandateDraft): SignedMandate {
  pocketOf(pocketId);
  const draft = agents.sanitizeDraft(rawDraft);
  if (!draft) throw new UserError("Rules need an item and a positive max price.");
  const s = loadState();
  const mandate: Mandate = {
    id: `md_${randomUUID().slice(0, 8)}`,
    pocketId,
    instruction,
    item: draft.item,
    required: draft.required ?? {},
    allowed: draft.allowed ?? {},
    maxUnitPrice: Number(draft.maxUnitPrice),
    currency: "USD",
    maxQuantity: Math.max(1, Number(draft.maxQuantity) || 1),
    merchants: [store.MERCHANT_ID],
    expiresAt: draft.expiresAt,
    createdAt: new Date().toISOString(),
  };
  const signed = signMandate(mandate, userKey());
  s.mandates.push(signed);
  saveState();
  recorder.append(mandate.id, "instruction", { text: instruction });
  recorder.append(mandate.id, "mandate_signed", signed);
  return signed;
}

function mandateOf(id: string): SignedMandate {
  const s = loadState();
  const m = s.mandates.find((x) => x.mandate.id === id) ?? s.retiredMandates.find((x) => x.mandate.id === id);
  if (!m) throw new UserError(`Unknown mandate ${id}`);
  return m;
}

/* ---------------------------------------- Guard state ---------------------------------------- */

function guardState(): GuardState {
  const s = loadState();
  const today = new Date().toISOString().slice(0, 10);
  const purchasesToday = s.purchases.filter((p) => p.paypal && p.createdAt.startsWith(today)).length;
  return { killSwitch: s.killSwitch, maxPurchasesPerDay: s.maxPurchasesPerDay, purchasesToday, knownMerchants: s.knownMerchants };
}

export function setKillSwitch(on: boolean): void {
  loadState().killSwitch = on;
  saveState();
}

/* ---------------------------------------- Buy path ---------------------------------------- */

export interface RunResult {
  purchase?: Purchase;
  skipped?: string;
}

export async function runAgent(mandateId: string, opts: { mode?: agents.AgentMode; productId?: string; baseUrl: string }): Promise<RunResult> {
  const signed = mandateOf(mandateId);
  const mode = opts.mode ?? "careful";
  const candidates = opts.productId ? [store.getProduct(opts.productId)].filter((p): p is store.Product => !!p) : store.listProducts();
  const choice = await agents.chooseProduct(signed.mandate, candidates, mode);
  if (!choice.order) return { skipped: choice.skipped };

  const product = store.getProduct(choice.order.productId)!;
  const snapshot = store.snapshotOf(product, opts.baseUrl);
  const pocket = pocketOf(signed.mandate.pocketId);
  const decision = checkOrder(signed, choice.order, pocket, guardState());

  const purchase: Purchase = {
    id: `pu_${randomUUID().slice(0, 8)}`,
    mandateId,
    pocketId: pocket.id,
    productId: product.id,
    title: product.title,
    status: decision.outcome === "allow" ? "completed" : decision.outcome === "ask_user" ? "needs_approval" : "blocked",
    mode,
    order: choice.order,
    snapshot,
    decision,
    total: decision.total,
    createdAt: new Date().toISOString(),
  };
  loadState().purchases.unshift(purchase);
  recorder.append(purchase.id, "page_snapshot", snapshot);
  recorder.append(purchase.id, "agent_claim", choice.order);
  recorder.append(purchase.id, "guard_decision", decision);
  saveState();

  if (decision.outcome === "allow") await executePurchase(purchase);
  return { purchase };
}

/** One-tap approval for a first purchase from a new merchant. */
export async function approvePurchase(purchaseId: string): Promise<Purchase> {
  const s = loadState();
  const purchase = purchaseOf(purchaseId);
  if (purchase.status !== "needs_approval") throw new UserError("This purchase is not waiting for approval.");
  if (!s.knownMerchants.includes(purchase.order.merchantId)) s.knownMerchants.push(purchase.order.merchantId);
  // Re-check everything (balance, kill switch, limits) at approval time.
  const decision = checkOrder(mandateOf(purchase.mandateId), purchase.order, pocketOf(purchase.pocketId), guardState());
  purchase.decision = decision;
  recorder.append(purchase.id, "guard_decision", { ...decision, approvedByUser: true });
  if (decision.outcome !== "allow") {
    purchase.status = "blocked";
    saveState();
    return purchase;
  }
  purchase.status = "completed";
  await executePurchase(purchase);
  return purchase;
}

async function executePurchase(purchase: Purchase): Promise<void> {
  const s = loadState();
  if (!s.vault) {
    purchase.status = "failed";
    purchase.error = "Connect PayPal first (Settings → Connect PayPal).";
    saveState();
    return;
  }
  try {
    let order = await pp.createVaultedOrder(storePP(), s.vault.vaultId, purchase.total, purchase.title.slice(0, 120), purchase.id);
    if (order.status !== "COMPLETED") order = await pp.captureOrder(storePP(), order.id);
    const captureId = pp.captureIdOf(order);
    purchase.paypal = { orderId: order.id, captureId, status: order.status };
    recorder.append(purchase.id, "paypal_order", { orderId: order.id, status: order.status });
    recorder.append(purchase.id, "paypal_capture", { captureId, amount: purchase.total });
    pocketOf(purchase.pocketId).balance = round2(pocketOf(purchase.pocketId).balance - purchase.total);
    purchase.why = await agents.whyLine(mandateOf(purchase.mandateId).mandate, purchase.order);
  } catch (e) {
    purchase.status = "failed";
    purchase.error = ppErr(e);
  }
  saveState();
}

function purchaseOf(id: string): Purchase {
  const p = loadState().purchases.find((x) => x.id === id);
  if (!p) throw new UserError(`Unknown purchase ${id}`);
  return p;
}

/* ---------------------------------------- Dispute path ---------------------------------------- */

export async function reportWrong(purchaseId: string, input: { preset?: string; imageDataUrl?: string; complaint?: string }): Promise<Purchase> {
  const purchase = purchaseOf(purchaseId);
  if (purchase.status !== "completed") throw new UserError("Only completed purchases can be reported.");
  const signed = mandateOf(purchase.mandateId);
  purchase.status = "disputed";

  // 1. What actually arrived (vision model or demo preset).
  const delivered = await agents.readDeliveryPhoto(input);
  recorder.append(purchase.id, "delivery_reading", delivered);

  // 2. Merchant agent answers with its own shipping record.
  const product = store.getProduct(purchase.productId);
  const shipped = product ? store.shippedAttributes(product) : purchase.snapshot.attributes;
  const merchant = await agents.merchantRespond(purchase.snapshot, shipped, delivered);
  recorder.append(purchase.id, "merchant_response", merchant);

  // 3. Rules decide. 4. LLM explains.
  const result = arbitrate({ mandate: signed.mandate, claim: purchase.order, snapshot: purchase.snapshot, delivered });
  const explanation = await agents.explainVerdict(result, { instruction: signed.mandate.instruction, title: purchase.title, amount: purchase.total });
  recorder.append(purchase.id, "verdict", { ...result, explanation });
  purchase.dispute = { complaint: input.complaint ?? "", delivered, merchant, result, explanation };
  saveState();

  // 5. PayPal acts.
  purchase.dispute.resolution = await resolve(purchase, signed);
  recorder.append(purchase.id, "paypal_resolution", purchase.dispute.resolution);
  saveState();
  return purchase;
}

async function resolve(purchase: Purchase, signed: SignedMandate): Promise<Resolution> {
  const at = new Date().toISOString();
  const { result, merchant, complaint } = purchase.dispute!;
  const credit = () => (pocketOf(purchase.pocketId).balance = round2(pocketOf(purchase.pocketId).balance + purchase.total));

  try {
    switch (result.action) {
      case "REFUND_FROM_MERCHANT": {
        if (merchant.stance === "contest") {
          purchase.status = "escalated";
          return { type: "evidence_pack", detail: "Merchant contests. Sealed evidence pack is ready to file as a PayPal dispute.", at };
        }
        const r = await pp.refundCapture(storePP(), purchase.paypal!.captureId!, purchase.total, "Black Box verdict: merchant shipped a different item than listed.");
        credit();
        purchase.status = "resolved";
        return { type: "refund", paypalId: r.id, amount: purchase.total, detail: `Refund ${r.status} from ${store.MERCHANT_NAME}.`, at };
      }
      case "PAYOUT_FROM_COVER_POOL": {
        const buyer = loadState().buyerEmail;
        if (!buyer) throw new UserError("SANDBOX_BUYER_EMAIL is not set.");
        const p = await pp.sendPayout(coverPP(), buyer, purchase.total, `Black Box verdict: your agent made the mistake on "${purchase.title}". The Agent Cover Pool pays you back.`);
        credit();
        purchase.status = "resolved";
        return { type: "payout", paypalId: p.batch_header?.payout_batch_id, amount: purchase.total, detail: `Payout ${p.batch_header?.batch_status} from the Agent Cover Pool.`, at };
      }
      case "PROPOSE_MANDATE_FIX": {
        const fix = await agents.proposeMandateFix(signed.mandate, complaint);
        purchase.status = "resolved";
        return { type: "mandate_fix", detail: "No money moves. A sharper rule is waiting for your approval.", proposedFix: fix, at };
      }
      default:
        purchase.status = "completed";
        return { type: "review", detail: "Photo unclear. Upload a sharper photo of the label.", at };
    }
  } catch (e) {
    purchase.status = "escalated";
    return { type: "evidence_pack", detail: `PayPal action failed (${ppErr(e)}). Evidence pack kept for manual filing.`, at };
  }
}

/** User approves the proposed fix: the old mandate is retired and a new one is signed. */
export function applyMandateFix(purchaseId: string): SignedMandate {
  const purchase = purchaseOf(purchaseId);
  const fix = purchase.dispute?.resolution?.proposedFix;
  if (!fix) throw new UserError("No proposed fix on this purchase.");
  const s = loadState();
  const old = mandateOf(purchase.mandateId);
  s.mandates = s.mandates.filter((m) => m.mandate.id !== old.mandate.id);
  s.retiredMandates.push(old);
  saveState();
  const { item: _i, ...rest } = old.mandate;
  return signNewMandate(old.mandate.pocketId, `${old.mandate.instruction} (clarified: ${fix.item})`, { ...rest, item: fix.item });
}

/* ---------------------------------------- Demo controls ---------------------------------------- */

export function restock(productId: string, inStock = true) {
  return store.updateProduct(productId, { inStock });
}

export function setWarehouseError(productId: string, shipsAs: Record<string, string> | null) {
  return store.updateProduct(productId, { shipsAs: shipsAs ?? undefined });
}
