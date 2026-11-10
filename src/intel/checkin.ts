import { loadState } from "../app/state.ts";
import { lastCheckin, markCheckin, notify } from "./push.ts";

/**
 * The weekly check-in: one notification a week instead of a ping per item.
 * It bundles everything waiting for the user and what the agents did this week.
 * Urgent asks (a take-a-look the user turned on, a stock-out blocking an order) still push at once.
 */

/** Saturday, 9:00 (server's local time). */
export const CHECKIN_DAY = 6;
export const CHECKIN_HOUR = 9;

export interface Checkin {
  title: string;
  body: string;
  url: string;
  waiting: { agentId: string; agent: string; what: string }[];
  week: { purchases: number; spent: number; stopped: number; moneyBack: number };
  lastSentAt?: string;
  nextAt: string;
}

const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function nextCheckinAt(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(CHECKIN_HOUR, 0, 0, 0);
  d.setDate(d.getDate() + ((CHECKIN_DAY - d.getDay() + 7) % 7));
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

export function buildCheckin(now = new Date()): Checkin {
  const s = loadState();
  const open = s.pockets.filter((p) => !p.closedAt);
  const name = (id: string) => s.pockets.find((p) => p.id === id)?.name ?? "An agent";
  const waiting: Checkin["waiting"] = [
    ...s.purchases.filter((p) => p.status === "needs_approval").map((p) => ({ agentId: p.pocketId, agent: name(p.pocketId), what: `approve ${p.title} (${money(p.total)})` })),
    ...s.purchases.filter((p) => p.status === "awaiting_look").map((p) => ({ agentId: p.pocketId, agent: name(p.pocketId), what: `take a look at ${p.title}` })),
    ...s.proposals.filter((p) => p.status === "pending" && open.some((a) => a.id === p.agentId)).map((p) => ({
      agentId: p.agentId, agent: name(p.agentId),
      what: p.kind === "transfer" ? "a money move" : p.kind === "job" ? "a new job" : p.retryProductId ? "a one-time exception" : "a rule change",
    })),
  ];
  const since = now.getTime() - 7 * 864e5;
  const thisWeek = s.purchases.filter((p) => Date.parse(p.createdAt) >= since);
  const paid = thisWeek.filter((p) => p.paypal);
  const week = {
    purchases: paid.length,
    spent: Math.round(paid.reduce((t, p) => t + p.total, 0) * 100) / 100,
    stopped: thisWeek.filter((p) => p.status === "blocked").length,
    moneyBack: Math.round(thisWeek.reduce((t, p) => {
      const r = p.dispute?.resolution;
      return t + (r && (r.type === "refund" || r.type === "payout") ? r.amount ?? 0 : 0);
    }, 0) * 100) / 100,
  };

  const did = week.purchases
    ? `This week: ${week.purchases} purchase${week.purchases === 1 ? "" : "s"}, ${money(week.spent)}`
    : "This week: nothing bought";
  const extra = [week.stopped ? `${week.stopped} stopped by your rules` : "", week.moneyBack ? `${money(week.moneyBack)} back` : ""].filter(Boolean).join(", ");
  const asks = waiting.length
    ? `${waiting.length} thing${waiting.length === 1 ? "" : "s"} to approve: ${waiting.slice(0, 3).map((w) => `${w.agent} (${w.what})`).join("; ")}${waiting.length > 3 ? ` and ${waiting.length - 3} more` : ""}.`
    : "Nothing needs you.";
  return {
    title: "Your weekly check-in",
    body: `${did}${extra ? ` · ${extra}` : ""}. ${asks}`,
    url: waiting[0] ? `/agents/${waiting[0].agentId}` : "/",
    waiting,
    week,
    lastSentAt: lastCheckin(),
    nextAt: nextCheckinAt(now).toISOString(),
  };
}

export async function sendCheckin(): Promise<{ sent: number; checkin: Checkin }> {
  const checkin = buildCheckin();
  const sent = await notify({ title: checkin.title, body: checkin.body, url: checkin.url, tag: "weekly-checkin" });
  markCheckin();
  return { sent, checkin: { ...checkin, lastSentAt: new Date().toISOString() } };
}

/** Called every few minutes: sends the check-in once, on Saturday after 9:00, if it hasn't gone out this week. */
export async function maybeWeeklyCheckin(now = new Date()) {
  if (now.getDay() !== CHECKIN_DAY || now.getHours() < CHECKIN_HOUR) return;
  const last = lastCheckin();
  if (last && now.getTime() - Date.parse(last) < 6 * 864e5) return;
  await sendCheckin();
}
