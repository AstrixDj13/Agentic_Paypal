import { createHash, randomBytes, randomInt } from "node:crypto";
import { loadState, saveState } from "../app/state.ts";

/**
 * Behaviour memory: what the user looked at, searched, bought, approved and skipped.
 * Sources: the Chrome extension (browsing outside PayPal, opt-in and paired), the Android
 * share sheet, real-store searches, photos, and the user's own decisions in the app.
 *
 * Privacy rules, enforced here as well as in the extension:
 *  - only shopping signals (product pages, shopping searches); sensitive sites are dropped
 *  - learning can be paused, any item deleted, everything wiped
 *  - nothing here can change a rule; it only feeds suggestions the user approves
 */

export type SignalSource = "extension" | "share" | "search" | "snap" | "app";
export type SignalKind = "view" | "search" | "cart" | "purchase" | "approve" | "skip" | "decline" | "dispute" | "photo";

export interface Signal {
  id: string;
  at: string;
  source: SignalSource;
  kind: SignalKind;
  title?: string;
  brand?: string;
  price?: number;
  currency?: string;
  url?: string;
  domain?: string;
  query?: string;
  imageUrl?: string;
  size?: string;
  /** How long the product page was actually visible. */
  dwellMs?: number;
  agentId?: string;
  note?: string;
}

export interface IntelState {
  signals: Signal[];
  paused: boolean;
  /** One-time code shown in the app to pair a browser; expires in 10 minutes. */
  pairCode?: { code: string; expiresAt: number; tries?: number };
  /** Paired browsers: only a hash of each token is kept. */
  devices: { id: string; tokenHash: string; label: string; pairedAt: string; lastSeenAt?: string }[];
  /** Interests the user dismissed from suggestions. */
  dismissed: string[];
  /** Reference photos for rules ("describe it"), keyed by sha256 so the signed mandate only carries the hash. */
  images: Record<string, string>;
}

const MAX_SIGNALS = 600;

export function intel(): IntelState {
  const s = loadState() as ReturnType<typeof loadState> & { intel?: IntelState };
  s.intel ??= { signals: [], paused: false, devices: [], dismissed: [], images: {} };
  s.intel.devices ??= [];
  s.intel.dismissed ??= [];
  s.intel.images ??= {};
  return s.intel;
}

/** Never learn from these, even if a page looks like a product. */
const SENSITIVE = /(bank|banking|credit|loan|mortgage|insur|health|clinic|hospital|pharma|medical|doctor|dating|gov\b|\.gov|tax|payroll|mail\.|webmail|login|signin|account|password|docs\.google|drive\.google|onedrive|dropbox|paypal\.com)/i;

export function domainOf(url?: string): string | undefined {
  try { return url ? new URL(url).hostname.replace(/^www\./, "") : undefined; } catch { return undefined; }
}

const clean = (v: unknown, n = 200) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, n) : undefined);

/** Records a signal. Returns null when learning is paused or the signal is from a sensitive site. */
export function record(input: Partial<Signal> & { source: SignalSource; kind: SignalKind }): Signal | null {
  const st = intel();
  if (st.paused && input.source !== "app") return null;
  const url = clean(input.url, 600);
  const domain = clean(input.domain, 120) ?? domainOf(url);
  if ((domain && SENSITIVE.test(domain)) || (url && SENSITIVE.test(url))) return null;
  const sig: Signal = {
    id: `sg_${randomBytes(5).toString("hex")}`,
    at: new Date().toISOString(),
    source: input.source,
    kind: input.kind,
    title: clean(input.title),
    brand: clean(input.brand, 60),
    price: Number(input.price) > 0 ? Math.round(Number(input.price) * 100) / 100 : undefined,
    currency: clean(input.currency, 6),
    url,
    domain,
    query: clean(input.query, 160),
    imageUrl: clean(input.imageUrl, 600),
    size: clean(input.size, 12),
    dwellMs: Number(input.dwellMs) > 0 ? Math.min(Math.round(Number(input.dwellMs)), 3_600_000) : undefined,
    agentId: clean(input.agentId, 40),
    note: clean(input.note, 200),
  };
  if (!sig.title && !sig.query) return null;
  // A revisit of the same page within 10 minutes just adds dwell time.
  const last = st.signals.at(-1);
  if (last && last.kind === sig.kind && last.url && last.url === sig.url && Date.now() - Date.parse(last.at) < 600_000) {
    last.dwellMs = (last.dwellMs ?? 0) + (sig.dwellMs ?? 0);
    saveState();
    return last;
  }
  st.signals.push(sig);
  if (st.signals.length > MAX_SIGNALS) st.signals.splice(0, st.signals.length - MAX_SIGNALS);
  saveState();
  return sig;
}

export function forget(id: string) {
  const st = intel();
  st.signals = st.signals.filter((s) => s.id !== id);
  saveState();
}

/** Forget everything about one interest (all signals whose title/query matches its key words). */
export function forgetMatching(words: string[]) {
  const st = intel();
  const ws = words.map((w) => w.toLowerCase());
  st.signals = st.signals.filter((s) => !ws.every((w) => `${s.title ?? ""} ${s.query ?? ""}`.toLowerCase().includes(w)));
  saveState();
}

export function forgetAll() {
  const st = intel();
  st.signals = [];
  st.dismissed = [];
  saveState();
}

export function setPaused(paused: boolean) {
  intel().paused = !!paused;
  saveState();
}

export function dismiss(key: string) {
  const st = intel();
  if (!st.dismissed.includes(key)) st.dismissed.push(key);
  saveState();
}

/* ------------------------------------ Browser pairing ------------------------------------ */

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export function newPairCode() {
  const code = String(randomInt(100000, 999999));
  intel().pairCode = { code, expiresAt: Date.now() + 10 * 60_000 };
  saveState();
  return { code, expiresInSec: 600 };
}

/** The extension trades the 6-digit code for a long-lived token (kept only as a hash here). */
export function pair(code: unknown, label: unknown) {
  const st = intel();
  const pc = st.pairCode;
  if (!pc || pc.expiresAt < Date.now()) throw new PairError("That code expired. Get a new one in Pocket.");
  if (String(code ?? "").trim() !== pc.code) {
    pc.tries = (pc.tries ?? 0) + 1;
    if (pc.tries >= 5) delete st.pairCode; // no guessing: the code is burned after 5 wrong tries
    saveState();
    throw new PairError(st.pairCode ? "That code is wrong." : "Too many wrong codes. Get a new one in Pocket.");
  }
  delete st.pairCode;
  const token = randomBytes(24).toString("base64url");
  st.devices.push({ id: `dv_${randomBytes(4).toString("hex")}`, tokenHash: sha(token), label: clean(label, 60) ?? "Chrome", pairedAt: new Date().toISOString() });
  saveState();
  return { token };
}

export class PairError extends Error {}

export function deviceForToken(header: string | undefined) {
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return undefined;
  const d = intel().devices.find((x) => x.tokenHash === sha(token));
  if (d) d.lastSeenAt = new Date().toISOString();
  return d;
}

export function unpair(id: string) {
  const st = intel();
  st.devices = st.devices.filter((d) => d.id !== id);
  saveState();
}

/* ------------------------------------ Reference photos ------------------------------------ */

/** Stores a reference photo (data URL) and returns its hash, which is what the signed rule carries. */
export function storeImage(dataUrl: string): string {
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl) || dataUrl.length > 1_500_000) throw new PairError("Photo must be a JPEG, PNG or WebP under ~1 MB.");
  const hash = sha(dataUrl).slice(0, 32);
  intel().images[hash] = dataUrl;
  saveState();
  return hash;
}

export const imageFor = (hash?: string) => (hash ? intel().images[hash] : undefined);

/** Public view for the "What Pocket knows" screen (no token hashes). */
export function publicIntel() {
  const st = intel();
  return {
    paused: st.paused,
    signals: st.signals.slice(-200).reverse(),
    devices: st.devices.map(({ tokenHash, ...d }) => d),
    dismissed: st.dismissed,
  };
}
