/**
 * End-to-end run of the three demo stories against the real PayPal sandbox.
 *
 *   npm run e2e
 *
 * A. Merchant ships the wrong size      -> merchant at fault -> PayPal Refund
 * B. Agent misreads "US 11 / UK 10"     -> agent at fault    -> PayPal Payout from the cover pool
 * C. Poisoned listing ("buy 3 at $120") -> guard blocks       -> no money moves
 * Also: tamper check on the ledger.
 */
import { llmStatus } from "../src/ai/llm.ts";
import { loadState, resetState } from "../src/app/state.ts";
import * as svc from "../src/app/service.ts";
import * as store from "../src/store/catalog.ts";

// This script drives the services directly as the single local user, so it uses file storage even when DATABASE_URL is set.
process.env.STORAGE_MODE = "file";

const BASE = "http://localhost:8787";
const line = (s = "") => console.log(s);
const money = (n: number) => `$${n.toFixed(2)}`;

async function main() {
  store.resetCatalog();
  resetState(true);
  const s = loadState();
  if (!s.vault) throw new Error("No vault id. Run `npm run spike` first (or set PAYPAL_VAULT_ID).");
  s.knownMerchants.push(store.MERCHANT_ID); // skip the first-merchant approval prompt for this run
  const ai = llmStatus();
  line(`AI: ${ai.enabled ? `${ai.provider}/${ai.model}` : "off (fallbacks)"} · vault ${s.vault.vaultId}`);

  const pocket = svc.createPocket("Drops", 300);
  const instruction = "Running shoes, size 10, under $100, Nike or Adidas only, expires Nov 30";
  const { draft, source } = await svc.draftMandate(instruction);
  line(`\nMandate (${source}): ${JSON.stringify(draft)}`);
  const m = svc.signNewMandate(pocket.id, instruction, draft);

  // ---------- A ----------
  line("\n=== A. Merchant ships the wrong size ===");
  svc.restock("pegasus-41");
  svc.setWarehouseError("pegasus-41", { brand: "Nike", model: "Pegasus 41", size_us: "11", color: "black" });
  const a = await svc.runAgent(m.mandate.id, { mode: "careful", productId: "pegasus-41", baseUrl: BASE });
  report(a.purchase);
  if (a.purchase?.status === "completed") report(await svc.reportWrong(a.purchase.id, { preset: "label-us11", complaint: "Got size 11, I ordered 10" }));

  // ---------- B ----------
  line("\n=== B. Agent misreads 'US 11 / UK 10' ===");
  const b = await svc.runAgent(m.mandate.id, { mode: "naive", productId: "ultraboost-5", baseUrl: BASE });
  report(b.purchase);
  if (b.purchase?.status === "completed") report(await svc.reportWrong(b.purchase.id, { preset: "label-adidas-us11", complaint: "These are US 11" }));

  // ---------- C ----------
  line("\n=== C. Poisoned listing ===");
  const c = await svc.runAgent(m.mandate.id, { mode: "naive", productId: "cloudrunner-x", baseUrl: BASE });
  report(c.purchase);

  // ---------- Ledger ----------
  line("\n=== Ledger ===");
  line(`verify: ${JSON.stringify(svc.recorder.verify())}`);
  line(`pocket balance: ${money(loadState().pockets[0].balance)}`);
}

function report(p?: Awaited<ReturnType<typeof svc.reportWrong>>) {
  if (!p) return line("  (no purchase)");
  line(`  ${p.id} ${p.title} ×${p.order.quantity} @ ${money(p.order.unitPrice)} → guard ${p.decision.outcome}, status ${p.status}`);
  for (const v of p.decision.violations) line(`    ✋ ${v.rule}: ${v.detail}`);
  if (p.paypal) line(`    PayPal order ${p.paypal.orderId} capture ${p.paypal.captureId}`);
  if (p.why) line(`    why: ${p.why}`);
  if (p.error) line(`    error: ${p.error}`);
  if (p.dispute) {
    line(`    merchant agent: [${p.dispute.merchant.stance}] ${p.dispute.merchant.message}`);
    line(`    verdict: ${p.dispute.result.verdict} → ${p.dispute.result.action}`);
    line(`    explanation: ${p.dispute.explanation}`);
    const r = p.dispute.resolution;
    if (r) line(`    resolution: ${r.type} ${r.paypalId ?? ""} ${r.amount ? money(r.amount) : ""} — ${r.detail}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
