import { randomUUID } from "node:crypto";
import type { PayPalClient } from "./client.ts";

/** Thin wrappers over the PayPal APIs this project uses. Amounts are USD strings like "12.00". */

const usd = (n: number) => ({ currency_code: "USD", value: n.toFixed(2) });

// ---------- Vault v3: save the buyer's PayPal once, pay later with no buyer present ----------

export function createSetupToken(pp: PayPalClient, returnUrl: string, cancelUrl: string) {
  return pp.request("POST", "/v3/vault/setup-tokens", {
    payment_source: {
      paypal: {
        description: "Agent Pocket: let your agent pay within your signed rules",
        usage_pattern: "IMMEDIATE",
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: false,
        experience_context: {
          brand_name: "Agent Pocket",
          shipping_preference: "NO_SHIPPING",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  });
}

export function createPaymentToken(pp: PayPalClient, setupTokenId: string) {
  return pp.request("POST", "/v3/vault/payment-tokens", {
    payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } },
  });
}

// ---------- Orders v2 ----------

/** Buyer-present order: returns an approve link the buyer must visit. */
export function createOrder(pp: PayPalClient, amount: number, description: string, returnUrl: string, cancelUrl: string) {
  return pp.request("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: usd(amount), description }],
    payment_source: {
      paypal: {
        experience_context: { brand_name: "Agent Pocket Demo Store", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: returnUrl, cancel_url: cancelUrl },
      },
    },
  });
}

/** Buyer-not-present order paid with a vaulted PayPal wallet: no PIN, no redirect. */
export function createVaultedOrder(pp: PayPalClient, vaultId: string, amount: number, description: string, customId?: string) {
  return pp.request("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: usd(amount), description, custom_id: customId }],
    payment_source: { paypal: { vault_id: vaultId } },
  });
}

export function captureOrder(pp: PayPalClient, orderId: string) {
  return pp.request("POST", `/v2/checkout/orders/${orderId}/capture`, {});
}

export function getOrder(pp: PayPalClient, orderId: string) {
  return pp.request("GET", `/v2/checkout/orders/${orderId}`);
}

export function captureIdOf(order: any): string | undefined {
  return order?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
}

// ---------- Refunds (merchant at fault) ----------

export function refundCapture(pp: PayPalClient, captureId: string, amount: number, note: string) {
  return pp.request("POST", `/v2/payments/captures/${captureId}/refund`, { amount: usd(amount), note_to_payer: note.slice(0, 255) });
}

// ---------- Payouts (agent at fault, paid from the Agent Cover Pool account) ----------

export function sendPayout(pp: PayPalClient, receiverEmail: string, amount: number, note: string) {
  return pp.request("POST", "/v1/payments/payouts", {
    sender_batch_header: { sender_batch_id: `cover-${randomUUID()}`, email_subject: "Agent Pocket: your agent's mistake is covered" },
    items: [{ recipient_type: "EMAIL", amount: { value: amount.toFixed(2), currency: "USD" }, receiver: receiverEmail, note: note.slice(0, 4000) }],
  });
}

export function getPayoutBatch(pp: PayPalClient, batchId: string) {
  return pp.request("GET", `/v1/payments/payouts/${batchId}`);
}

// ---------- Disputes ----------

export function listDisputes(pp: PayPalClient) {
  return pp.request("GET", "/v1/customer/disputes?page_size=5");
}

// ---------- Webhooks ----------

export function listWebhooks(pp: PayPalClient) {
  return pp.request("GET", "/v1/notifications/webhooks");
}
