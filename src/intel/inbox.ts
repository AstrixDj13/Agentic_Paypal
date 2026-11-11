import { randomBytes } from "node:crypto";
import { loadState, saveState, type AppState } from "../app/state.ts";
import { pendingAlerts } from "../bills/pending.ts";

/**
 * The server's list of notifications, with read / unread per user (so it follows the person
 * across devices), and the "needs you" count that goes on the app icon.
 */

export interface Notification { id: string; at: string; title: string; body: string; url: string; tag?: string; read: boolean }

const MAX = 100;
type WithInbox = AppState & { notifications?: Notification[] };

function list(): Notification[] {
  const s = loadState() as WithInbox;
  s.notifications ??= [];
  return s.notifications;
}

/** Records a notification (whether or not a phone was subscribed to receive it). */
export function remember(n: { title: string; body: string; url: string; tag?: string }) {
  const l = list();
  l.push({ id: `nt_${randomBytes(5).toString("hex")}`, at: new Date().toISOString(), read: false, ...n });
  if (l.length > MAX) l.splice(0, l.length - MAX);
  saveState();
}

export function inbox() {
  const items = [...list()].reverse();
  return { items, unread: items.filter((n) => !n.read).length, needsYou: needsYouCount() };
}

/** Marks some (or, with no ids, all) notifications as read. */
export function markRead(ids?: unknown) {
  const want = Array.isArray(ids) ? new Set(ids.map(String)) : null;
  for (const n of list()) if (!want || want.has(n.id)) n.read = true;
  saveState();
  return inbox();
}

/** Everything waiting on the user right now: the number shown on the app icon. */
export function needsYouCount(s: AppState = loadState()): number {
  const open = new Set(s.pockets.filter((p) => !p.closedAt).map((p) => p.id));
  const purchases = s.purchases.filter((p) => open.has(p.pocketId) && ["needs_approval", "awaiting_look", "store_suggested"].includes(p.status)).length;
  const proposals = s.proposals.filter((p) => open.has(p.agentId) && p.status === "pending").length;
  const orders = (s.orders ?? []).filter((o) => open.has(o.agentId) && (o.status === "needs_approval" || (o.status === "awaiting" && (o.kind === "now" || (o.lines ?? []).some((l) => l.ask?.status === "pending"))))).length;
  return purchases + proposals + orders + pendingAlerts(s).length;
}
