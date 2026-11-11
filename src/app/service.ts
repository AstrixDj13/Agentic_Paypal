import { randomUUID } from "node:crypto";
import { arbitrate } from "../core/arbiter.ts";
import { checkOrder } from "../core/guard.ts";
import { signMandate } from "../core/mandate.ts";
import type { AskMode, GuardState, Mandate, Pocket, SignedMandate } from "../core/types.ts";
import * as agents from "../agent/agents.ts";
import { PayPalClient, PayPalError, approveLink } from "../paypal/client.ts";
import * as pp from "../paypal/api.ts";
import * as store from "../store/catalog.ts";
import * as channel3 from "../store/channel3.ts";
import { loadState, saveState, userKey, type Purchase, type Resolution } from "./state.ts";
import { recorder } from "./ledger.ts";
import { endException, exceptionOf, notifyPurchase, postMessage, proposeRuleChange, sweepExceptions } from "./chat.ts";
import { AGENT_COLORS } from "./state.ts";
import { notify } from "../intel/push.ts";
import { imageFor, record } from "../intel/signals.ts";
import { nearbyOffer } from "../grocery/nearby.ts";

/** Orchestrates the buy path (agent -> guard -> PayPal) and the dispute path (photo -> arbiter -> PayPal). */

export { recorder };

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

export function createPocket(name: string, amount: number, opts: { color?: string; askMode?: AskMode } = {}): Pocket {
  if (!name.trim() || !(amount > 0)) throw new UserError("An agent needs a name and a positive amount.");
  const s = loadState();
  const color = opts.color && /^#[0-9a-f]{6}$/i.test(opts.color) ? opts.color : AGENT_COLORS[s.pockets.length % AGENT_COLORS.length];
  const pocket: Pocket = {
    id: `pk_${randomUUID().slice(0, 8)}`, name: name.trim().slice(0, 24), balance: round2(amount), currency: "USD",
    color, askMode: opts.askMode === "anything" ? "anything" : "money", paused: false, createdAt: new Date().toISOString(),
  };
  s.pockets.push(pocket);
  saveState();
  return pocket;
}

export function pocketOf(id: string): Pocket {
  const p = loadState().pockets.find((x) => x.id === id);
  if (!p) throw new UserError(`Unknown pocket ${id}`);
  return p;
}

/* ---------------------------------------- Mandates ---------------------------------------- */

export async function draftMandate(instruction: string) {
  if (!instruction.trim()) throw new UserError("Write what the agent may buy.");
  return agents.parseInstruction(instruction);
}

/**
 * Signs the agent's one job. One agent, one job: any other active rule for this agent retires
 * (kept for history and for old purchases). `keepException` is used when signing a temporary rule.
 */
export function signNewMandate(pocketId: string, instruction: string, rawDraft: agents.MandateDraft, opts: { keepException?: boolean } = {}): SignedMandate {
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
    ...(draft.avoid?.length ? { avoid: draft.avoid } : {}),
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.refImage ? { refImage: draft.refImage } : {}),
    ...(draft.kind && draft.kind !== "hunt" ? { kind: draft.kind } : {}),
    ...(draft.list?.length ? { list: draft.list } : {}),
    ...(draft.withinMinutes ? { withinMinutes: draft.withinMinutes } : {}),
    ...(draft.cadence ? { cadence: draft.cadence } : {}),
    ...(draft.askAbove ? { askAbove: draft.askAbove } : {}),
    // Routine and right-now jobs buy from their own (simulated) stores; hunts buy at Stride Supply.
    merchants: draft.merchants ?? (draft.kind === "routine" ? ["grocery"] : draft.kind === "now" ? [] : [store.MERCHANT_ID]),
    expiresAt: draft.expiresAt,
    createdAt: new Date().toISOString(),
  };
  const signed = signMandate(mandate, userKey());
  if (!opts.keepException) s.exceptions = s.exceptions.filter((e) => e.agentId !== pocketId);
  for (const old of s.mandates.filter((m) => m.mandate.pocketId === pocketId)) s.retiredMandates.push(old);
  s.mandates = s.mandates.filter((m) => m.mandate.pocketId !== pocketId);
  s.mandates.push(signed);
  saveState();
  recorder.append(mandate.id, "instruction", { text: instruction });
  recorder.append(mandate.id, "mandate_signed", signed);
  return signed;
}

export function mandateOf(id: string): SignedMandate {
  const s = loadState();
  const m = s.mandates.find((x) => x.mandate.id === id) ?? s.retiredMandates.find((x) => x.mandate.id === id);
  if (!m) throw new UserError(`Unknown mandate ${id}`);
  return m;
}

/* ---------------------------------------- Guard state ---------------------------------------- */

export function guardState(pocket?: Pocket): GuardState {
  const s = loadState();
  const today = new Date().toISOString().slice(0, 10);
  // Monthly bill payments are not agent purchases: they never use up the daily purchase limit.
  const purchasesToday = s.purchases.filter((p) => p.paypal && p.createdAt.startsWith(today) && !p.productId.startsWith("bill:")).length;
  return { killSwitch: s.killSwitch, maxPurchasesPerDay: s.maxPurchasesPerDay, purchasesToday, knownMerchants: s.knownMerchants, askEveryPurchase: pocket?.askMode === "anything" };
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

export async function runAgent(mandateId: string, opts: { mode?: agents.AgentMode; productId?: string; productIds?: string[]; baseUrl: string; quiet?: boolean }): Promise<RunResult> {
  sweepExceptions();
  const signed = mandateOf(mandateId);
  const mode = opts.mode ?? "careful";
  const ids = opts.productIds ?? (opts.productId ? [opts.productId] : null);
  const candidates = ids ? ids.map((id) => store.getProduct(id)).filter((p): p is store.Product => !!p) : store.listProducts();
  const choice = await agents.chooseProduct(signed.mandate, candidates, mode);
  // Sent to one listing that breaks a rule (not just the price): let the guard check it and record why.
  if (!choice.order && !choice.nearMiss && mode === "careful" && ids?.length === 1) {
    const only = candidates[0];
    if (only?.inStock && agents.matchesJob(signed.mandate, only)) choice.order = agents.listingClaim(signed.mandate, only);
  }
  if (!choice.order) {
    const m = signed.mandate;
    if (choice.nearMiss) {
      // Out of bounds: stop, tell the user, and offer a one-time exception they can sign.
      const { product, overBy } = choice.nearMiss;
      const prop = proposeRuleChange(m.pocketId, m, { maxUnitPrice: product.unitPrice }, "once", undefined, product.id);
      postMessage(m.pocketId, "agent", `I found ${product.title} for $${product.unitPrice}. It fits everything except your $${m.maxUnitPrice} limit ($${overBy} over), so I didn't buy it. Want to make an exception just this once?`, { proposalId: prop?.id, needsYou: true });
      saveState();
    } else if (!opts.quiet) {
      postMessage(m.pocketId, "agent", `Checked the store: ${choice.skipped}`);
      saveState();
    }
    return { skipped: choice.skipped };
  }

  const product = store.getProduct(choice.order.productId)!;
  const snapshot = store.snapshotOf(product, opts.baseUrl);
  const pocket = pocketOf(signed.mandate.pocketId);
  const decision = checkOrder(signed, choice.order, pocket, guardState(pocket));

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

  // "Buy it in store instead": a real-store hunt checks nearby shops (simulated) before paying online.
  // The careful agent only; the weak demo agent never would. No payment through Pocket if the user goes to the shop.
  const near = decision.outcome !== "block" && mode === "careful" && product.source && pocket.checkNearby !== false && (signed.mandate.kind ?? "hunt") === "hunt" && choice.order.quantity === 1
    ? nearbyOffer(product.id, purchase.total) : null;
  if (near) {
    purchase.status = "store_suggested";
    purchase.storeOffer = near;
    recorder.append(purchase.id, "in_store", { suggested: true, ...near, saving: Math.round((near.onlinePrice - near.price) * 100) / 100 });
    postMessage(pocket.id, "agent", "It's cheaper in a shop nearby. I haven't paid for anything.", { purchaseId: purchase.id, needsYou: true });
    saveState();
    return { purchase };
  }

  // "Take a look before I buy": hold an in-rules purchase for a moment and ping the phone.
  const look = Math.max(0, Math.min(3600, Number(pocket.lookFirstSec) || 0));
  if (decision.outcome === "allow" && look > 0) {
    purchase.status = "awaiting_look";
    purchase.lookUntil = new Date(Date.now() + look * 1000).toISOString();
    const mins = look >= 60 ? `${Math.round(look / 60)} min` : `${look} s`;
    postMessage(pocket.id, "agent", `Take a look before I buy. I'll go ahead in ${mins} unless you skip it.`, { purchaseId: purchase.id, needsYou: true }); // its own push (with photo and buttons) follows
    void notify({
      title: `${pocket.name}: take a look before I buy`,
      body: `${product.title} · $${purchase.total}. Buying in ${mins} unless you skip.`,
      url: `/agents/${pocket.id}`,
      image: product.imageUrl,
      tag: purchase.id,
      look: { purchaseId: purchase.id },
    });
    saveState();
    return { purchase };
  }

  if (decision.outcome === "allow") await executePurchase(purchase);
  notifyPurchase(purchase, signed.mandate);
  saveState();
  return { purchase };
}

/* ------------------------------- Take a look before I buy ------------------------------- */

/**
 * The user's answer to a look-first purchase ("Looks good" / "Skip"), or the timer running out.
 * Buying re-checks every rule first; skipping is remembered so the agent learns what you don't want.
 */
export async function resolveLook(purchaseId: string, decision: "buy" | "skip", by: "user" | "timer" = "user"): Promise<Purchase> {
  const purchase = purchaseOf(purchaseId);
  if (purchase.status !== "awaiting_look") throw new UserError("This purchase isn't waiting for a look any more.");
  const signed = mandateOf(purchase.mandateId);
  const pocket = pocketOf(purchase.pocketId);
  const product = store.getProduct(purchase.productId);
  if (decision === "skip") {
    purchase.status = "skipped";
    recorder.append(purchase.id, "guard_decision", { outcome: "block", violations: [{ rule: "skipped_by_user", detail: "You skipped it after taking a look." }], total: purchase.total });
    record({ source: "app", kind: "skip", title: purchase.title, brand: purchase.order.attributes.brand, price: purchase.order.unitPrice, url: product?.source?.url, imageUrl: product?.imageUrl, agentId: pocket.id });
    postMessage(pocket.id, "agent", `Skipped ${purchase.title}. Nothing was paid. I'll remember you didn't want it.`);
    learnFromSkips(pocket.id, signed.mandate, purchase.order.attributes.brand);
    saveState();
    return purchase;
  }
  const d = checkOrder(signed, purchase.order, pocket, guardState(pocket));
  purchase.decision = d.outcome === "ask_user" ? { ...d, outcome: "allow", violations: [] } : d;
  recorder.append(purchase.id, "guard_decision", { ...purchase.decision, lookedAt: by });
  if (purchase.decision.outcome !== "allow") {
    purchase.status = "blocked";
  } else {
    purchase.status = "completed";
    if (by === "user") record({ source: "app", kind: "approve", title: purchase.title, brand: purchase.order.attributes.brand, price: purchase.order.unitPrice, agentId: pocket.id });
    await executePurchase(purchase);
  }
  notifyPurchase(purchase, signed.mandate);
  saveState();
  return purchase;
}

/**
 * The user's answer to "buy it in store instead": they bought it at the shop (nothing is paid through
 * Pocket; the saving is recorded) or they want it online after all (rules re-checked, then PayPal).
 */
export async function resolveStore(purchaseId: string, decision: "in_store" | "online"): Promise<Purchase> {
  const purchase = purchaseOf(purchaseId);
  if (purchase.status !== "store_suggested" || !purchase.storeOffer) throw new UserError("This isn't waiting on a shop decision.");
  const signed = mandateOf(purchase.mandateId);
  const pocket = pocketOf(purchase.pocketId);
  const so = purchase.storeOffer;
  if (decision === "in_store") {
    purchase.status = "bought_in_store";
    purchase.usual = so.onlinePrice;
    purchase.saved = Math.round((so.onlinePrice - so.price) * 100) / 100;
    recorder.append(purchase.id, "in_store", { boughtInStore: true, shop: so.shop, price: so.price, onlinePrice: so.onlinePrice, saved: purchase.saved, payment: "none through Pocket" });
    postMessage(pocket.id, "agent", `Noted: you bought it at ${so.shop} for $${so.price}. You saved $${purchase.saved.toFixed(2)}, and nothing was paid through Pocket.`);
    saveState();
    return purchase;
  }
  const d = checkOrder(signed, purchase.order, pocket, guardState(pocket));
  purchase.decision = d.outcome === "ask_user" ? { ...d, outcome: "allow", violations: [] } : d;
  recorder.append(purchase.id, "guard_decision", { ...purchase.decision, chose: "online instead of in store" });
  if (purchase.decision.outcome === "allow") {
    purchase.status = "completed";
    await executePurchase(purchase);
  } else purchase.status = "blocked";
  notifyPurchase(purchase, signed.mandate);
  saveState();
  return purchase;
}

/** Runs every few seconds: look-first purchases whose window has passed go ahead (after a fresh rule check). */
export async function sweepLooks(now = Date.now()) {
  const due = loadState().purchases.filter((p) => p.status === "awaiting_look" && p.lookUntil && Date.parse(p.lookUntil) <= now);
  for (const p of due) {
    try { await resolveLook(p.id, "buy", "timer"); } catch { /* already resolved */ }
  }
}

/**
 * Learning from reactions: after the user skips the same brand twice for an agent, the agent
 * offers (as a signable proposal) to stop considering that brand. It never drops it on its own.
 */
function learnFromSkips(agentId: string, m: Mandate, brand?: string) {
  if (!brand) return;
  const b = brand.toLowerCase();
  const allowed = m.allowed.brand ?? [];
  if (!allowed.includes(b) || allowed.length < 2) return;
  const since = Date.now() - 30 * 864e5;
  const skips = loadState().purchases.filter((p) => p.pocketId === agentId && p.status === "skipped" && p.order.attributes.brand?.toLowerCase() === b && Date.parse(p.createdAt) > since).length;
  if (skips < 2) return;
  if (loadState().proposals.some((p) => p.agentId === agentId && p.status === "pending")) return;
  const prop = proposeRuleChange(agentId, m, { brands: allowed.filter((x) => x !== b) }, "always");
  if (prop) postMessage(agentId, "agent", `You've skipped ${skips} ${brand} picks. Want me to stop looking at ${brand}?`, { proposalId: prop.id, needsYou: true });
}

/* ------------------------------- Real products (Channel3) ------------------------------- */

export interface FoundProduct {
  product: store.Product;
  /** Why it does not fit the rules; empty = it fits. */
  reasons: string[];
}

/**
 * "Find it for me": searches real stores via Channel3 for the rule, shows what fits and what
 * doesn't, then lets the careful agent buy the best fit through the normal guard + PayPal path.
 */
export async function findAndBuy(mandateId: string, baseUrl: string): Promise<RunResult & { found: FoundProduct[] }> {
  if (!channel3.channel3Enabled()) throw new UserError("Real-store search is off (CHANNEL3_API_KEY not set).");
  const m = mandateOf(mandateId).mandate;
  let real: store.Product[];
  try {
    real = await channel3.findForRules({ item: m.item, brands: m.allowed.brand ?? [], maxPrice: m.maxUnitPrice, size: m.required.size_us, description: m.description, imageDataUrl: imageFor(m.refImage) });
  } catch (e) {
    throw new UserError(`Real-store search failed: ${(e as Error).message}`);
  }
  const imported = store.importProducts(real);
  const found = imported
    .map((product) => ({ product, reasons: agents.fitReasons(m, product) }))
    .sort((a, b) => a.reasons.length - b.reasons.length || a.product.unitPrice - b.product.unitPrice);
  recorder.append(mandateId, "discovery", {
    source: "channel3",
    results: found.map((f) => ({ id: f.product.id, title: f.product.title, unitPrice: f.product.unitPrice, domain: f.product.source?.domain, fits: f.reasons.length === 0, reasons: f.reasons })),
  });

  const fits = found.filter((f) => f.reasons.length === 0).map((f) => f.product.id);
  postMessage(m.pocketId, "agent", `Searched ${found.length} real listings via Channel3. ${fits.length} prove they match your rules.${fits.length ? "" : " I'll keep watching."}`);
  saveState();
  if (fits.length === 0) return { found, skipped: `Checked ${found.length} real listings; none prove they match your rules yet. Still watching.` };
  const run = await runAgent(mandateId, { mode: "careful", productIds: fits, baseUrl, quiet: true });
  return { found, ...run };
}

/** Store page: import real products for a free-text search. */
export async function importRealProducts(query: string, maxPrice?: number): Promise<store.Product[]> {
  if (!channel3.channel3Enabled()) throw new UserError("Real-store search is off (CHANNEL3_API_KEY not set).");
  if (!query.trim()) throw new UserError("Type what to search for.");
  try {
    record({ source: "search", kind: "search", query, price: maxPrice });
    const raw = await channel3.searchRaw({ query, maxPrice, limit: 6 });
    return store.importProducts(raw.map((r) => channel3.toProduct(r)).filter((p): p is store.Product => !!p));
  } catch (e) {
    throw new UserError(`Real-store search failed: ${(e as Error).message}`);
  }
}

/** One-tap approval for a first purchase from a new merchant. */
export async function approvePurchase(purchaseId: string): Promise<Purchase> {
  const s = loadState();
  const purchase = purchaseOf(purchaseId);
  if (purchase.status !== "needs_approval") throw new UserError("This purchase is not waiting for approval.");
  if (!s.knownMerchants.includes(purchase.order.merchantId)) s.knownMerchants.push(purchase.order.merchantId);
  // Re-check every hard rule (balance, kill switch, limits) at approval time. Soft "ask me" rules
  // are what the user just answered, so ask_user counts as allowed here.
  const signed = mandateOf(purchase.mandateId);
  const pocket = pocketOf(purchase.pocketId);
  const decision = checkOrder(signed, purchase.order, pocket, guardState(pocket));
  purchase.decision = decision.outcome === "ask_user" ? { ...decision, outcome: "allow", violations: [] } : decision;
  recorder.append(purchase.id, "guard_decision", { ...purchase.decision, approvedByUser: true });
  if (purchase.decision.outcome !== "allow") {
    purchase.status = "blocked";
    notifyPurchase(purchase, signed.mandate);
    saveState();
    return purchase;
  }
  purchase.status = "completed";
  record({ source: "app", kind: "approve", title: purchase.title, brand: purchase.order.attributes.brand, price: purchase.order.unitPrice, agentId: purchase.pocketId });
  await executePurchase(purchase);
  notifyPurchase(purchase, signed.mandate);
  saveState();
  return purchase;
}

export async function executePurchase(purchase: Purchase): Promise<void> {
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
    const bought = store.getProduct(purchase.productId);
    record({ source: "app", kind: "purchase", title: purchase.title, brand: purchase.order.attributes.brand, price: purchase.order.unitPrice, size: purchase.order.attributes.size_us, url: bought?.source?.url, imageUrl: bought?.imageUrl, agentId: purchase.pocketId });
    // A one-time exception is used up by this purchase.
    const ex = exceptionOf(purchase.pocketId);
    if (ex?.scope === "once" && ex.tempMandateId === purchase.mandateId) endException(purchase.pocketId, "used for this purchase");
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
  record({ source: "app", kind: "dispute", title: purchase.title, brand: purchase.order.attributes.brand, price: purchase.order.unitPrice, size: purchase.order.attributes.size_us, note: input.complaint, agentId: purchase.pocketId });
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
