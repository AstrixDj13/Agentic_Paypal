import {
  api, attrsText, money, prettyKey, STATUS_LABEL, VERDICT_LABEL, when,
  type MandateDraft, type Purchase,
} from "../api";
import { Icon, type IconName } from "./Icon";
import { Money, Obj } from "./ui";
import { SignButton } from "./lock";

export type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

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
  if (r.type === "mandate_fix") return "Sharper rule proposed";
  if (r.type === "evidence_pack") return "Evidence pack ready to file";
  return r.detail;
}

export function FeedItem({ p, onOpen }: { p: Purchase; onOpen: () => void }) {
  const r = p.dispute?.resolution;
  return (
    <button className={`card feed-item s-${p.status} rise`} onClick={onOpen}>
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
      {p.why && !p.dispute && p.status !== "blocked" && <p className="footnote muted clamp-2">{p.why}</p>}
      {r && <p className="footnote ok-text">{resolutionLine(r)}</p>}
      <Icon name="chevronRight" size={16} className="feed-chevron" />
    </button>
  );
}

export function MandateChips({ m }: { m: Pick<MandateDraft, "required" | "allowed" | "maxUnitPrice" | "maxQuantity" | "expiresAt" | "avoid"> }) {
  return (
    <div className="chips">
      {Object.entries(m.required).map(([k, v]) => <span key={k} className="chip">{prettyKey(k)}: {v}</span>)}
      {Object.entries(m.allowed).map(([k, v]) => <span key={k} className="chip">{prettyKey(k)}: {v.join(" / ")}</span>)}
      {(m.avoid ?? []).map((w) => <span key={`no-${w}`} className="chip chip-no">never {w}</span>)}
      <span className="chip">≤ {money(m.maxUnitPrice)}</span>
      <span className="chip">max {m.maxQuantity}</span>
      <span className="chip">until {new Date(m.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
    </div>
  );
}

export const STORE_NAME = "Stride Supply";

/** Verdict → AI explanation → evidence → merchant stance → settlement (the peak-end moment). */
export function VerdictCard({ p, act }: { p: Purchase; act?: Act }) {
  const d = p.dispute!;
  const r = d.resolution;
  const moneyBack = r && (r.type === "refund" || r.type === "payout") && r.amount !== undefined;
  return (
    <div className="stack rise">
      <div className={`verdict tone-${verdictTone(d.result.verdict)}`}>
        <span className="kicker">Black Box verdict</span>
        <h3 className="title-2">{VERDICT_LABEL[d.result.verdict]}</h3>
        <p className="subhead">{d.explanation}</p>
        {d.result.findings.length > 0 && (
          <div className="findings">
            {d.result.findings.map((f, i) => (
              <p key={i} className="mono">{prettyKey(f.field)}: expected {f.expected}, got {f.actual} · {f.compared.replace(/_/g, " ")}</p>
            ))}
          </div>
        )}
      </div>

      <div className="quote">
        <div className="row between">
          <strong>{STORE_NAME} agent</strong>
          <span className={`badge ${d.merchant.stance === "accept" ? "ok" : "warn"}`}>{d.merchant.stance === "accept" ? "Accepts" : "Contests"}</span>
        </div>
        <p className="subhead">{d.merchant.message}</p>
      </div>

      <p className="footnote muted">
        Photo read ({d.delivered.source === "ai" ? "AI vision" : "demo preset"}, {Math.round(d.delivered.confidence * 100)}% sure): {attrsText(d.delivered.attributes) || "nothing readable"}
      </p>

      {r && (
        <div className={`card settle ${moneyBack ? "money-back" : ""}`}>
          {moneyBack ? (
            <div className="row" style={{ gap: 16 }}>
              <Obj kind="coin" size={0.8} />
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
                <SignButton title="Sign the sharper rule" detail={r.proposedFix.item} onSigned={(auth) => act(() => api(`/api/purchases/${p.id}/apply-fix`, { auth }), "Sharper rule signed")}>
                  Approve &amp; sign new rule
                </SignButton>
              )}
            </>
          )}
          {r.paypalId && <p className="mono muted">PayPal ref {r.paypalId}</p>}
        </div>
      )}
    </div>
  );
}
