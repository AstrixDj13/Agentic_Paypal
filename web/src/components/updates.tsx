import { useCallback, useEffect, useState } from "react";
import { api, money, when, type AppState } from "../api";
import { Icon, type IconName } from "./Icon";
import { AgentIcon, activeMandate, toneOf } from "./agent";

/**
 * Updates: one place for everything your agents told you, so a missed notification is never lost.
 *  - "Needs you": things waiting on you right now (approvals, take-a-looks, suggestions, order questions). They stay
 *    until you act, and their count is the number on the app icon.
 *  - "Earlier": what agents said recently (and the weekly check-in). New since you last looked shows a blue dot.
 * Built from the app state; "seen" is remembered on this device.
 */

export interface Update {
  id: string; at: string; agentId?: string; icon?: IconName;
  title: string; detail: string;
  open: { agent: string } | { purchase: string } | { path: string };
}

const SEEN_KEY = "pp-updates-seen";
const DAY = 86_400_000;

/** What needs you, newest first. Its length is the app-icon number. */
export function needsYou(state: AppState): Update[] {
  const name = (id: string) => state.pockets.find((p) => p.id === id)?.name ?? "Your agent";
  const out: Update[] = [];
  // A weekly order and its basket purchase are one thing to you: list the order, not its purchase as well.
  const orderBuys = new Set((state.orders ?? []).filter((o) => o.status === "awaiting" || o.status === "needs_approval").map((o) => o.purchaseId).filter(Boolean));
  for (const p of state.purchases) {
    if (orderBuys.has(p.id)) continue;
    if (p.status === "needs_approval") out.push({ id: `buy-${p.id}`, at: p.createdAt, agentId: p.pocketId, title: `Approve ${p.title}`, detail: `${name(p.pocketId)} · ${money(p.total)}`, open: { purchase: p.id } });
    if (p.status === "awaiting_look") out.push({ id: `look-${p.id}`, at: p.createdAt, agentId: p.pocketId, title: `Take a look: ${p.title}`, detail: `${name(p.pocketId)} buys it soon unless you skip`, open: { agent: p.pocketId } });
    if (p.status === "store_suggested") out.push({ id: `store-${p.id}`, at: p.createdAt, agentId: p.pocketId, title: `Cheaper in store: ${p.title}`, detail: `${name(p.pocketId)} found it nearby`, open: { agent: p.pocketId } });
  }
  for (const x of state.proposals) {
    if (x.status === "pending") out.push({ id: `prop-${x.id}`, at: x.createdAt, agentId: x.agentId, title: x.summary, detail: `${name(x.agentId)} suggested a change`, open: { agent: x.agentId } });
  }
  for (const o of state.orders ?? []) {
    if (o.status !== "awaiting" && o.status !== "needs_approval") continue;
    const asks = (o.lines ?? []).filter((l) => l.ask?.status === "pending").length;
    const title = o.kind === "now" ? `Your pick: ${o.pick?.dish ?? "ready"}` : asks ? `${asks} ${asks === 1 ? "question" : "questions"} on this week's order` : o.status === "needs_approval" ? "Approve this week's order" : "";
    if (title) out.push({ id: `order-${o.id}`, at: o.createdAt, agentId: o.agentId, title, detail: `${name(o.agentId)} · ${money(o.total)}`, open: { agent: o.agentId } });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** What agents said recently that isn't already waiting above (two weeks, newest first). */
function earlier(state: AppState, pendingIds: Set<string>): Update[] {
  const since = Date.now() - 14 * DAY;
  const open = new Set(state.pockets.filter((p) => !p.closedAt).map((p) => p.id));
  const stillPending = (m: AppState["chats"][number]) =>
    (m.purchaseId && pendingIds.has(m.purchaseId)) || (m.proposalId && pendingIds.has(m.proposalId)) || (m.orderId && pendingIds.has(m.orderId));
  return state.chats
    .filter((m) => m.from === "agent" && open.has(m.agentId) && Date.parse(m.at) >= since && !/^Hi, I'm\b/.test(m.text) && !stillPending(m))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 25)
    .map((m) => ({ id: m.id, at: m.at, agentId: m.agentId, title: state.pockets.find((p) => p.id === m.agentId)?.name ?? "Your agent", detail: m.text, open: { agent: m.agentId } }));
}

/** When you last opened Updates, on this device. */
export function useSeen() {
  const read = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
  const [seenAt, setSeenAt] = useState(read);
  const markSeen = useCallback(() => {
    const now = Date.now();
    try { localStorage.setItem(SEEN_KEY, String(now)); } catch { /* storage blocked */ }
    setSeenAt(now);
  }, []);
  return { seenAt, markSeen };
}

/** New "earlier" items since you last looked (for the bell's dot). */
export function unreadCount(state: AppState, seenAt: number) {
  const pending = new Set(needsYou(state).map((u) => u.id.replace(/^\w+-/, "")));
  return earlier(state, pending).filter((u) => Date.parse(u.at) > seenAt).length;
}

/** The bell next to your avatar: a number for what needs you, a dot for anything new. */
export function UpdatesButton({ needs, unread, onOpen }: { needs: number; unread: number; onOpen: () => void }) {
  return (
    <button className="glass-circle updates-btn" onClick={onOpen}
      aria-label={needs ? `Updates: ${needs} need${needs === 1 ? "s" : ""} you` : unread ? `Updates: ${unread} new` : "Updates"}>
      <Icon name="bell" size={21} />
      {needs > 0 ? <span className="bell-count" aria-hidden="true">{needs > 9 ? "9+" : needs}</span>
        : unread > 0 ? <span className="bell-dot" aria-hidden="true" /> : null}
    </button>
  );
}

export function UpdatesSheet({ state, seenAt, markSeen, go }: {
  state: AppState; seenAt: number; markSeen: () => void;
  go: (where: Update["open"]) => void;
}) {
  const needs = needsYou(state);
  const pending = new Set(needs.map((u) => u.id.replace(/^\w+-/, "")));
  const [checkin, setCheckin] = useState<Update | null>(null);
  // Keep the dots as they were while the sheet is open; mark everything seen once you've had a moment to look.
  const [shownSeen] = useState(seenAt);
  useEffect(() => { const t = setTimeout(markSeen, 1200); return () => clearTimeout(t); }, [markSeen]);
  useEffect(() => {
    api<{ title?: string; body: string; lastSentAt?: string }>("/api/checkin")
      .then((c) => { if (c.lastSentAt) setCheckin({ id: "checkin", at: c.lastSentAt, icon: "clock", title: "Weekly check-in", detail: c.body, open: { path: "/knows" } }); })
      .catch(() => {});
  }, []);
  const info = [...earlier(state, pending), ...(checkin ? [checkin] : [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const row = (u: Update, kind: "needs" | "info") => {
    const agent = u.agentId ? state.pockets.find((p) => p.id === u.agentId) : undefined;
    const item = u.agentId ? activeMandate(state, u.agentId)?.mandate.item : undefined;
    const fresh = kind === "info" && Date.parse(u.at) > shownSeen;
    return (
      <button key={u.id} type="button" className={`upd-row ${kind}`} onClick={() => go(u.open)}>
        <span className="upd-lead" aria-hidden="true">
          {agent ? <AgentIcon name={agent.name} item={item} tone={toneOf(agent, item)} size={34} /> : <span className="upd-ico"><Icon name={u.icon ?? "bell"} size={18} /></span>}
        </span>
        <span className="upd-text">
          <span className="upd-title">{u.title}</span>
          <span className="upd-detail">{u.detail}</span>
        </span>
        <span className="upd-meta">
          <span className="upd-time">{ago(u.at)}</span>
          {kind === "needs" ? <span className="upd-flag needs" aria-label="Needs you" /> : fresh ? <span className="upd-flag new" aria-label="New" /> : null}
        </span>
      </button>
    );
  };

  return (
    <div className="stack updates-sheet">
      <h2 className="title-2">Updates</h2>
      {needs.length > 0 && (
        <section className="stack-sm" aria-label="Needs you">
          <h3 className="upd-head">Needs you <span className="upd-count">{needs.length}</span></h3>
          <div className="set-group">{needs.map((u) => row(u, "needs"))}</div>
        </section>
      )}
      <section className="stack-sm" aria-label="Earlier">
        <h3 className="upd-head">{needs.length ? "Earlier" : "Recent"}</h3>
        {info.length ? <div className="set-group">{info.map((u) => row(u, "info"))}</div>
          : <p className="footnote muted">Nothing yet. When your agents have something to tell you, it shows here, even if you miss the notification.</p>}
      </section>
      {needs.length === 0 && <p className="caption muted upd-clear"><Icon name="check" size={14} stroke={2.6} className="ok-text" />Nothing needs you right now.</p>}
    </div>
  );
}

/** "Just now", "12m", "3h", "Yesterday", then the date. */
function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2 * 86400) return "Yesterday";
  return when(iso).split(",")[0];
}
