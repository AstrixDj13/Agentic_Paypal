import { pendingAlerts } from "../bills/pending.ts";
import { loadState, saveState } from "../app/state.ts";
import { lastCheckin, markCheckin, notify } from "./push.ts";
import { orderSummary, pendingAsks } from "../grocery/routine.ts";

/**
 * The weekly check-in: one notification a week instead of a ping per item.
 * It bundles everything waiting for the user and what the agents did this week.
 * Urgent asks (a take-a-look the user turned on, a stock-out blocking an order) still push at once.
 */

/** Default: Saturday, 9:00 (server's local time). Each user can choose their own day and time. */
export const CHECKIN_DAY = 6;
export const CHECKIN_HOUR = 9;

type WithCheckin = ReturnType<typeof loadState> & { checkinAt?: { day: number; hour: number } };
export function checkinSchedule() {
  const c = (loadState() as WithCheckin).checkinAt;
  return { day: c?.day ?? CHECKIN_DAY, hour: c?.hour ?? CHECKIN_HOUR };
}
export function setCheckinSchedule(day: unknown, hour: unknown) {
  const d = Math.round(Number(day)), h = Math.round(Number(hour));
  if (!(d >= 0 && d <= 6) || !(h >= 0 && h <= 23)) throw new Error("Pick a day (0 = Sunday … 6 = Saturday) and an hour (0–23).");
  (loadState() as WithCheckin).checkinAt = { day: d, hour: h };
  saveState();
  return { ...checkinSchedule(), nextAt: nextCheckinAt().toISOString() };
}

export interface Checkin {
  title: string;
  body: string;
  url: string;
  waiting: { agentId: string; agent: string; what: string }[];
  week: { purchases: number; spent: number; stopped: number; moneyBack: number };
  lastSentAt?: string;
  nextAt: string;
  schedule?: { day: number; hour: number };
}

const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function nextCheckinAt(now = new Date(), when: { day: number; hour: number } = safeSchedule()): Date {
  const d = new Date(now);
  d.setHours(when.hour, 0, 0, 0);
  d.setDate(d.getDate() + ((when.day - d.getDay() + 7) % 7));
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
  const orders = (s.orders ?? []).filter((o) => o.kind === "weekly" && (o.status === "awaiting" || o.status === "needs_approval"));
  for (const o of orders) {
    const asks = pendingAsks(o).length;
    if (asks || o.status === "needs_approval") waiting.push({ agentId: o.agentId, agent: name(o.agentId), what: asks ? `${asks} swap${asks === 1 ? "" : "s"} on this week's order` : "approve this week's order" });
  }
  for (const a of pendingAlerts(s)) waiting.push({ agentId: a.agentId, agent: name(a.agentId), what: a.type === "price_hike" ? `a new price, ${money(a.asked ?? 0)}` : a.type === "unusual" ? `a ${money(a.asked ?? 0)} bill` : a.type === "trial_end" ? "a trial ending" : "paying twice" });
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
  const saved = Math.round(paid.reduce((t, p) => t + (p.saved ?? 0), 0) * 100) / 100
    + Math.round(thisWeek.filter((p) => p.status === "bought_in_store").reduce((t, p) => t + (p.saved ?? 0), 0) * 100) / 100;
  const orderLine = orders[0] ? `${orderSummary(orders[0]).replace("This week's order", "Saturday's order")} ` : "";
  return {
    title: "Your weekly check-in",
    body: `${orderLine}${did}${saved > 0 ? ` · saved ${money(saved)}` : ""}${extra ? ` · ${extra}` : ""}. ${asks}`,
    url: waiting[0] ? `/agents/${waiting[0].agentId}` : "/",
    waiting,
    week,
    lastSentAt: lastCheckin(),
    nextAt: nextCheckinAt(now).toISOString(),
    schedule: checkinSchedule(),
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
  const when = checkinSchedule();
  if (now.getDay() !== when.day || now.getHours() < when.hour) return;
  const last = lastCheckin();
  if (last && now.getTime() - Date.parse(last) < 6 * 864e5) return;
  await sendCheckin();
}

/** The user's schedule, or the default when there's no signed-in user (e.g. unit tests). */
function safeSchedule() {
  try { return checkinSchedule(); } catch { return { day: CHECKIN_DAY, hour: CHECKIN_HOUR }; }
}
