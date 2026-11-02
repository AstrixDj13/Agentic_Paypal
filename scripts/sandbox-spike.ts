/**
 * Day-1 sandbox spike: confirms which PayPal capabilities our plan can rely on.
 *
 *   npm run spike
 *
 * Steps (each one is independent; a failure is reported, not fatal):
 *   1. OAuth token + granted scopes
 *   2. Payouts  ($1.00 to the sandbox buyer)          -> agent-at-fault cover pool
 *   3. Disputes (list)                                 -> merchant-at-fault contest path
 *   4. Orders   (buyer approves $1.00, we capture)     -> checkout
 *   5. Refunds  ($0.50 of that capture)                -> merchant-at-fault refund
 *   6. Vault    (buyer saves PayPal once)              -> pocket funding
 *   7. Vaulted order, no buyer present ($2.00)         -> "no PIN" agent checkout
 * Steps 4 and 6 open a browser: log in with the SANDBOX PERSONAL account and approve.
 */
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { PayPalClient, PayPalError, approveLink } from "../src/paypal/client.ts";
import * as api from "../src/paypal/api.ts";

const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const env = (k: string) => process.env[k] ?? "";

type Result = { step: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
const results: Result[] = [];
const record = (step: string, status: Result["status"], detail: string) => {
  results.push({ step, status, detail });
  console.log(`${status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⏭️ "} ${step}: ${detail}`);
};
const errText = (e: unknown) => (e instanceof PayPalError ? `${e.status} ${JSON.stringify(e.body).slice(0, 400)}` : String(e));

// --- tiny local server that catches PayPal redirects ---
const waiters = new Map<string, (q: URLSearchParams) => void>();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const resolve = waiters.get(url.pathname);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<h2>${resolve ? "Approved. You can close this tab and go back to the terminal." : "Agent Pocket spike server"}</h2>`);
  if (resolve) {
    waiters.delete(url.pathname);
    resolve(url.searchParams);
  }
});
const waitFor = (path: string, timeoutMs = 5 * 60_000) =>
  new Promise<URLSearchParams>((resolve, reject) => {
    waiters.set(path, resolve);
    setTimeout(() => reject(new Error(`Timed out waiting for ${path}`)), timeoutMs).unref();
  });
const openBrowser = (url: string) => {
  console.log(`\n   👉 Approve in browser (sandbox PERSONAL account):\n   ${url}\n`);
  exec(process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`);
};

async function main() {
  await new Promise<void>((r) => server.listen(PORT, r));
  const store = new PayPalClient(env("PAYPAL_CLIENT_ID"), env("PAYPAL_CLIENT_SECRET"));
  const coverPool = env("COVER_POOL_CLIENT_ID") ? new PayPalClient(env("COVER_POOL_CLIENT_ID"), env("COVER_POOL_CLIENT_SECRET")) : store;
  const buyer = env("SANDBOX_BUYER_EMAIL");

  // 1. Token + scopes
  try {
    const t = await store.getToken();
    const want = ["payouts", "disputes", "vault", "refund", "checkout", "webhook"];
    const found = want.map((w) => `${w}:${t.scopes.some((s) => s.toLowerCase().includes(w)) ? "yes" : "no"}`).join(" ");
    record("1. OAuth token", "PASS", `${t.scopes.length} scopes (${found})`);
  } catch (e) {
    record("1. OAuth token", "FAIL", errText(e));
    return finish(); // nothing else can work
  }

  // 2. Payouts
  if (!buyer) record("2. Payouts", "SKIP", "SANDBOX_BUYER_EMAIL not set");
  else
    try {
      const p = await api.sendPayout(coverPool, buyer, 1, "Agent Pocket spike: cover-pool payout test");
      record("2. Payouts", "PASS", `batch ${p.batch_header?.payout_batch_id} status ${p.batch_header?.batch_status}${coverPool === store ? " (from store app; cover pool app not set yet)" : " (from cover pool app)"}`);
    } catch (e) {
      record("2. Payouts", "FAIL", errText(e) + "  → enable Payouts on the app in the developer dashboard");
    }

  // 3. Disputes (read)
  try {
    const d = await api.listDisputes(store);
    record("3. Disputes list", "PASS", `${d.items?.length ?? 0} disputes visible. Buyer-side CREATE still needs testing (likely needs extra scope).`);
  } catch (e) {
    record("3. Disputes list", "FAIL", errText(e));
  }

  // 4 + 5. Buyer-present order, capture, partial refund
  try {
    const order = await api.createOrder(store, 1, "Spike test order", `${BASE}/order-return`, `${BASE}/order-cancel`);
    const link = approveLink(order);
    if (!link) throw new Error("No approve link in order response");
    openBrowser(link);
    await waitFor("/order-return");
    const captured = await api.captureOrder(store, order.id);
    const captureId = api.captureIdOf(captured);
    record("4. Orders create+capture", "PASS", `order ${order.id} ${captured.status}, capture ${captureId}`);
    try {
      const r = await api.refundCapture(store, captureId!, 0.5, "Spike: partial refund test");
      record("5. Refunds", "PASS", `refund ${r.id} ${r.status}`);
    } catch (e) {
      record("5. Refunds", "FAIL", errText(e));
    }
  } catch (e) {
    record("4. Orders create+capture", "FAIL", errText(e));
    record("5. Refunds", "SKIP", "needs a capture from step 4");
  }

  // 6 + 7. Vault, then buyer-not-present order
  try {
    const setup = await api.createSetupToken(store, `${BASE}/vault-return`, `${BASE}/vault-cancel`);
    const link = approveLink(setup);
    if (!link) throw new Error("No approve link in setup-token response");
    openBrowser(link);
    await waitFor("/vault-return");
    const token = await api.createPaymentToken(store, setup.id);
    record("6. Vault save PayPal", "PASS", `vault id ${token.id} (customer ${token.customer?.id})`);
    try {
      let o = await api.createVaultedOrder(store, token.id, 2, "Spike: agent purchase, no buyer present", "spike");
      if (o.status !== "COMPLETED") o = await api.captureOrder(store, o.id);
      record("7. Vaulted order (no PIN)", "PASS", `order ${o.id} ${o.status}, capture ${api.captureIdOf(o)}`);
    } catch (e) {
      record("7. Vaulted order (no PIN)", "FAIL", errText(e));
    }
  } catch (e) {
    record("6. Vault save PayPal", "FAIL", errText(e) + "  → tick 'Save payment methods' (Vault) on the app in the developer dashboard");
    record("7. Vaulted order (no PIN)", "SKIP", "needs a vault id from step 6");
  }

  finish();
}

function finish() {
  mkdirSync("data", { recursive: true });
  writeFileSync("data/spike-results.json", JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log("\nSummary written to data/spike-results.json");
  server.close();
  process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
}

main().catch((e) => {
  record("spike", "FAIL", errText(e));
  finish();
});
