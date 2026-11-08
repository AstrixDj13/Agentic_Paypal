import { useState } from "react";
import {
  api, attrsText, money, prettyKey, STATUS_LABEL, VERDICT_LABEL, when,
  type AppState, type MandateDraft, type Purchase,
} from "../api";
import { Mark } from "./Brand";
import type { Approval } from "./lock";
import { Icon, type IconName } from "./Icon";
import { Money } from "./ui";
import { SignButton } from "./lock";

/** Runs an action, toasts the result, refreshes. With `rethrow`, failures are thrown to the caller instead of toasted. */
export type Act = (fn: () => Promise<unknown>, ok?: string, opts?: { rethrow?: boolean }) => Promise<boolean>;

const STATUS_ICON: Record<Purchase["status"], IconName> = {
  completed: "check",
  blocked: "hand",
  needs_approval: "clock",
  failed: "alert",
  disputed: "eye",
  resolved: "undo",
  escalated: "up",
};

/** Status is always icon + word, never colour alone. */
export function StatusBadge({ status }: { status: Purchase["status"] }) {
  const s = STATUS_LABEL[status];
  return <span className={`badge ${s.tone}`}><Icon name={STATUS_ICON[status]} size={13} stroke={2.4} />{s.text}</span>;
}

export function verdictTone(v: string) {
  return v === "MERCHANT_AT_FAULT" ? "blue" : v === "AGENT_AT_FAULT" ? "info" : v === "NEEDS_REVIEW" ? "danger" : "neutral";
}

export function resolutionLine(r: NonNullable<NonNullable<Purchase["dispute"]>["resolution"]>) {
  if (r.type === "refund") return `Refunded ${money(r.amount)} by the merchant`;
  if (r.type === "payout") return `Paid back ${money(r.amount)} by the Agent Cover Pool`;
  if (r.type === "mandate_fix") return "Suggested rule update";
  if (r.type === "evidence_pack") return "Evidence pack ready to file";
  return r.detail;
}

export function FeedItem({ p, onOpen }: { p: Purchase; onOpen: () => void }) {
  const r = p.dispute?.resolution;
  return (
    <button className="card feed-item rise" onClick={onOpen}>
      <div className="row between">
        <StatusBadge status={p.status} />
        <span className="caption muted">{when(p.createdAt)}</span>
      </div>
      <div className="row between feed-title">
        <span className="grow ellipsis">{p.title}{p.order.quantity > 1 ? ` ×${p.order.quantity}` : ""}</span>
        <span className="num">{money(p.total)}</span>
      </div>
      {p.status === "blocked" && (
        <p className="footnote danger-text">
          {p.decision.violations[0]?.detail}{p.decision.violations.length > 1 ? ` (+${p.decision.violations.length - 1} more)` : ""}
        </p>
      )}
      {r && <p className="footnote ok-text">{resolutionLine(r)}</p>}
      <Icon name="chevronRight" size={16} className="feed-chevron" />
    </button>
  );
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function MandateChips({ m }: { m: Pick<MandateDraft, "required" | "allowed" | "maxUnitPrice" | "maxQuantity" | "expiresAt" | "avoid"> }) {
  return (
    <div className="chips">
      {Object.entries(m.required).map(([k, v]) => <span key={k} className="chip">{cap(prettyKey(k))}: {cap(v)}</span>)}
      {Object.entries(m.allowed).map(([k, v]) => <span key={k} className="chip">{cap(prettyKey(k))}: {v.map(cap).join(" or ")}</span>)}
      {(m.avoid ?? []).map((w) => <span key={`no-${w}`} className="chip chip-no">Never {w}</span>)}
      <span className="chip">Up to {money(m.maxUnitPrice)}</span>
      <span className="chip">Max {m.maxQuantity}</span>
      <span className="chip">Until {new Date(m.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
    </div>
  );
}

export const STORE_NAME = "Stride Supply";

/** Approve a purchase and only resolve if money actually moved. A "failed" or "blocked" result throws,
 *  so the confirmation moment never shows a check for a payment that didn't happen. */
export async function approvePurchaseOrThrow(id: string, auth: unknown) {
  const p = await api<Purchase>(`/api/purchases/${id}/approve`, { auth });
  if (p.status === "completed") return p;
  if (p.status === "blocked") throw new Error("Your rules stopped this purchase.");
  throw new Error(p.error ? `Payment didn't go through. ${p.error}` : "Payment didn't go through.");
}

/** The store a purchase came from: the real domain for Channel3 finds, otherwise the demo store. */
export function merchantOf(state: AppState, p: Purchase) {
  return state.products.find((x) => x.id === p.productId)?.source?.domain ?? STORE_NAME;
}

/** Summary shown on the approval sheet before a purchase is signed. */
export function purchaseApproval(state: AppState, p: Purchase): Approval {
  const agent = state.pockets.find((a) => a.id === p.pocketId);
  const why = p.decision.violations.map((v) => v.detail);
  return {
    amount: p.total,
    rows: [
      { label: "Merchant", value: merchantOf(state, p) },
      { label: "Item", value: `${p.title}${p.order.quantity > 1 ? ` × ${p.order.quantity}` : ""}` },
      ...(agent ? [{ label: "Agent", value: `${agent.name} · ${money(agent.balance)} left` }] : []),
      { label: "Your rules", value: "Within your limits", tone: "ok" as const },
      ...(why.length ? [{ label: "Why it's asking", value: why.join(" ") }] : []),
      { label: "Pay with", value: "PayPal" },
    ],
  };
}

/** Purchase detail as a receipt: merchant, item, amount, rule check, and the PayPal reference one level down. */
export function Receipt({ state, p }: { state: AppState; p: Purchase }) {
  const agent = state.pockets.find((a) => a.id === p.pocketId);
  const [copied, setCopied] = useState(false);
  const ref = p.paypal?.captureId ?? p.paypal?.orderId;
  const copy = async () => {
    if (!ref) return;
    try { await navigator.clipboard.writeText(ref); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  };
  const ruleOk = p.decision.outcome !== "block";
  return (
    <div className="card receipt">
      <div className="receipt-row"><span>Merchant</span><strong>{merchantOf(state, p)}</strong></div>
      <div className="receipt-row"><span>Item</span><strong>{p.title}</strong></div>
      {Object.keys(p.order.attributes).length > 0 && <div className="receipt-row"><span>Details</span><span className="capitalize">{attrsText(p.order.attributes)}</span></div>}
      <div className="receipt-row"><span>Price</span><span className="num-plain">{p.order.quantity} × {money(p.order.unitPrice)}</span></div>
      {agent && <div className="receipt-row"><span>Agent</span><span>{agent.name}</span></div>}
      <div className="receipt-row"><span>Date</span><span>{when(p.createdAt)}</span></div>
      <div className="receipt-row"><span>Rule check</span><span className={ruleOk ? "ok-text" : "danger-text"}>{ruleOk ? (p.decision.violations.length ? "Within limits, asked you first" : "Within your limits") : "Outside your limits"}</span></div>
      <div className="receipt-total"><span>Total</span><Money value={p.total} size="body" /></div>
      {p.paypal?.captureId && <div className="receipt-row"><span>Paid with</span><span className="row" style={{ gap: 6 }}><Mark size={16} />PayPal</span></div>}
      {ref && (
        <details className="receipt-more">
          <summary>PayPal transaction details</summary>
          <div className="receipt-row">
            <span>Transaction ID</span>
            <button className="copy-btn" onClick={copy} aria-label="Copy transaction ID">
              <span className="mono-plain">{ref}</span><Icon name={copied ? "check" : "copy"} size={15} />
            </button>
          </div>
          <p className="caption muted">{copied ? "Copied." : "Use this ID if you contact PayPal about this payment."}</p>
        </details>
      )}
    </div>
  );
}

/** Verdict → AI explanation → evidence → merchant stance → settlement (the peak-end moment). */
export function VerdictCard({ p, act }: { p: Purchase; act?: Act }) {
  const d = p.dispute!;
  const r = d.resolution;
  const moneyBack = r && (r.type === "refund" || r.type === "payout") && r.amount !== undefined;
  return (
    <div className="stack rise">
      <div className={`verdict tone-${verdictTone(d.result.verdict)}`}>
        <span className="kicker">Black Box decision</span>
        <h3 className="title-2">{VERDICT_LABEL[d.result.verdict]}</h3>
        <p className="subhead">{d.explanation}</p>
        {d.result.findings.length > 0 && (
          <div className="findings">
            {d.result.findings.map((f, i) => (
              <p key={i} className="footnote"><span className="capitalize">{prettyKey(f.field)}</span>: expected {f.expected}, got {f.actual}</p>
            ))}
          </div>
        )}
      </div>

      <div className="quote">
        <div className="row between">
          <strong>{STORE_NAME}</strong>
          <span className={`badge ${d.merchant.stance === "accept" ? "ok" : "warn"}`}>{d.merchant.stance === "accept" ? "Accepts" : "Contests"}</span>
        </div>
        <p className="subhead">{d.merchant.message}</p>
      </div>

      <p className="footnote muted">
        From your photo: {attrsText(d.delivered.attributes) || "nothing readable"}
      </p>

      {r && (
        <div className={`card settle ${moneyBack ? "money-back" : ""}`}>
          {moneyBack ? (
            <div className="row" style={{ gap: 16 }}>
              <div className="grow">
                <p className="footnote muted">{r.type === "refund" ? "Refunded by the merchant" : "Paid by the Agent Cover Pool"}</p>
                <Money value={r.amount!} size="title" />
              </div>
            </div>
          ) : (
            <strong className="headline">{resolutionLine(r)}</strong>
          )}
          <p className="footnote muted">{r.detail}</p>
          {r.proposedFix && (
            <>
              <p className="subhead">New rule: <strong>{r.proposedFix.item}</strong></p>
              <p className="footnote muted">{r.proposedFix.note}</p>
              {act && (
                <SignButton title="Sign the updated rule" detail={r.proposedFix.item} progress={{ working: "Updating your rules", done: "Rules updated" }} onSigned={(auth) => act(() => api(`/api/purchases/${p.id}/apply-fix`, { auth }), undefined, { rethrow: true })}>
                  Sign updated rule
                </SignButton>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
