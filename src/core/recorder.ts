import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, sha256 } from "./canonical.ts";

/**
 * Flight recorder: an append-only, hash-chained log.
 * Each entry's hash covers its content plus the previous entry's hash, so editing any
 * stored entry breaks the chain from that point on.
 */

export type EntryKind =
  | "instruction"
  | "mandate_signed"
  | "discovery"
  | "page_snapshot"
  | "agent_claim"
  | "guard_decision"
  | "paypal_order"
  | "paypal_capture"
  | "delivery_reading"
  | "merchant_response"
  | "verdict"
  | "paypal_resolution"
  | "proposal"
  | "proposal_decision"
  | "exception_ended"
  | "transfer"
  | "order_built"
  | "order_answer"
  | "in_store"
  | "bill_request"
  | "bill_decision";

export interface Entry {
  seq: number;
  ts: string;
  purchaseId: string;
  kind: EntryKind;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);

export function hashEntry(e: Omit<Entry, "hash">): string {
  const { seq, ts, purchaseId, kind, payload, prevHash } = e;
  return sha256(prevHash + canonicalJson({ seq, ts, purchaseId, kind, payload }));
}

export interface VerifyResult {
  ok: boolean;
  /** seq of the first entry whose hash does not match, if any. */
  brokenAt?: number;
  checked: number;
}

export function verifyChain(entries: Entry[]): VerifyResult {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i || e.prevHash !== prev || hashEntry(e) !== e.hash) {
      return { ok: false, brokenAt: e.seq, checked: i };
    }
    prev = e.hash;
  }
  return { ok: true, checked: entries.length };
}

/** Where entries are persisted besides memory (e.g. a database table). */
export interface RecorderSink {
  onAppend(e: Entry): void;
  onTamper?(e: Entry): void;
}

export class FlightRecorder {
  private entries: Entry[] = [];

  /**
   * Pass a .jsonl path to persist to a file, or `{ entries, sink }` to start from stored rows and
   * persist each new entry elsewhere (the database). Omit both for in-memory only.
   */
  constructor(private readonly file?: string, private readonly opts: { entries?: Entry[]; sink?: RecorderSink } = {}) {
    if (opts.entries) this.entries = [...opts.entries];
    else if (file && existsSync(file)) {
      this.entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }
  }

  append(purchaseId: string, kind: EntryKind, payload: unknown, now: Date = new Date()): Entry {
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS;
    // Seal a snapshot, not a live reference: callers keep mutating their objects (a proposal's
    // status, a purchase's decision) and that must never rewrite history. The JSON round-trip
    // also makes the in-memory entry identical to what is persisted and reloaded.
    const sealed = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
    const base = { seq: this.entries.length, ts: now.toISOString(), purchaseId, kind, payload: sealed, prevHash };
    const entry: Entry = { ...base, hash: hashEntry(base) };
    this.entries.push(entry);
    this.opts.sink?.onAppend(entry);
    if (this.file) appendFileSync(this.file, JSON.stringify(entry) + "\n");
    return entry;
  }

  all(): Entry[] {
    return [...this.entries];
  }

  forPurchase(purchaseId: string): Entry[] {
    return this.entries.filter((e) => e.purchaseId === purchaseId);
  }

  /** Latest payload of a kind for a purchase. */
  latest<T>(purchaseId: string, kind: EntryKind): T | undefined {
    return this.forPurchase(purchaseId).filter((e) => e.kind === kind).at(-1)?.payload as T | undefined;
  }

  verify(): VerifyResult {
    return verifyChain(this.entries);
  }

  /** Demo only: edit a stored payload in place WITHOUT re-hashing, to show the tamper check. */
  tamperForDemo(seq: number, mutate: (payload: any) => void): void {
    const e = this.entries[seq];
    if (!e) throw new Error(`No entry ${seq}`);
    mutate(e.payload);
    this.opts.sink?.onTamper?.(e);
    if (this.file) writeFileSync(this.file, this.entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  }
}
