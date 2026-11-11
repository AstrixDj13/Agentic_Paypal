import { loadState, type AppState } from "../app/state.ts";
import type { BillAlert } from "./bills.ts";

/**
 * Subscription and bill alerts still waiting on the user. A leaf module (it only reads state),
 * so the inbox and the weekly check-in can count them without importing the whole bills engine.
 */
export function pendingAlerts(s: AppState = loadState()): BillAlert[] {
  const open = new Set(s.pockets.filter((p) => !p.closedAt).map((p) => p.id));
  const alerts = (s as AppState & { bills?: { alerts: BillAlert[] } }).bills?.alerts ?? [];
  return alerts.filter((a) => a.status === "pending" && open.has(a.agentId));
}
