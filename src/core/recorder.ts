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
  | "page_snapshot"
  | "agent_claim"
  | "guard_decision"
  | "paypal_order"
  | "paypal_capture"
  | "delivery_reading"
  | "merchant_response"
  | "verdict"
  | "paypal_resolution";

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

export class FlightRecorder {
  private entries: Entry[] = [];

  /** Pass a .jsonl path to persist across restarts, or omit for in-memory. */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      this.entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }
  }

  append(purchaseId: string, kind: EntryKind, payload: unknown, now: Date = new Date()): Entry {
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS;
    const base = { seq: this.entries.length, ts: now.toISOString(), purchaseId, kind, payload, prevHash };
    const entry: Entry = { ...base, hash: hashEntry(base) };
    this.entries.push(entry);
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
    if (this.file) writeFileSync(this.file, this.entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  }
}
