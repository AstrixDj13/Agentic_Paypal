import webpush from "web-push";
import { loadState, saveState } from "../app/state.ts";

/**
 * Real phone notifications (Web Push). Works on Android Chrome and on iPhone once the app is
 * installed to the Home Screen; needs HTTPS (or localhost). VAPID keys are generated once and
 * kept in state, or supplied via VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
 */

type Sub = webpush.PushSubscription & { addedAt: string };
interface PushState { vapid?: { publicKey: string; privateKey: string }; subs: Sub[]; lastCheckinAt?: string }

function ps(): PushState {
  const s = loadState() as ReturnType<typeof loadState> & { push?: PushState };
  s.push ??= { subs: [] };
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    s.push.vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (!s.push.vapid) {
    s.push.vapid = webpush.generateVAPIDKeys();
    saveState();
  }
  return s.push;
}

/** When the last weekly check-in went out (so it's sent once a week, not once per restart). */
export function lastCheckin(): string | undefined { return ps().lastCheckinAt; }
export function markCheckin(at = new Date().toISOString()) { ps().lastCheckinAt = at; saveState(); }

export function publicKey() {
  return { publicKey: ps().vapid!.publicKey, subscribed: ps().subs.length };
}

export function subscribe(sub: unknown) {
  const s = sub as webpush.PushSubscription | undefined;
  if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw new Error("That isn't a valid push subscription.");
  const st = ps();
  st.subs = st.subs.filter((x) => x.endpoint !== s.endpoint);
  st.subs.push({ ...s, addedAt: new Date().toISOString() });
  saveState();
  return { ok: true, subscribed: st.subs.length };
}

export function unsubscribe(endpoint: unknown) {
  const st = ps();
  st.subs = st.subs.filter((x) => x.endpoint !== endpoint);
  saveState();
  return { ok: true };
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  image?: string;
  tag?: string;
  /** When set, the notification shows "Looks good" / "Skip" and the service worker answers directly. */
  look?: { purchaseId: string };
}

/** Sends to every subscribed device. Dead subscriptions (404/410) are removed. Never throws. */
export async function notify(msg: PushMessage): Promise<number> {
  const st = ps();
  if (!st.subs.length) return 0;
  const contact = process.env.PUBLIC_URL || "https://localhost";
  webpush.setVapidDetails(contact.startsWith("http") ? contact : `https://${contact}`, st.vapid!.publicKey, st.vapid!.privateKey);
  let sent = 0;
  const dead: string[] = [];
  await Promise.all(st.subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(msg), { TTL: 600, urgency: msg.look ? "high" : "normal" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(sub.endpoint);
    }
  }));
  if (dead.length) { st.subs = st.subs.filter((x) => !dead.includes(x.endpoint)); saveState(); }
  return sent;
}
