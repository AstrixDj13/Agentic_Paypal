import type { Entry, EntryKind, VerifyResult } from "../core/recorder.ts";
import { currentEntry, localEntry } from "../db/store.ts";
import { loadState } from "./state.ts";

/**
 * The Black Box recorder for the current user (hash-chained, tamper-evident).
 * Each user has their own chain; this object forwards to the one for the current request.
 */
function current() {
  const e = currentEntry();
  if (e) return e.recorder;
  loadState(); // file mode: makes sure the local user is loaded
  return localEntry(() => loadState()).recorder;
}

export const recorder = {
  append: (purchaseId: string, kind: EntryKind, payload: unknown, now?: Date): Entry => current().append(purchaseId, kind, payload, now),
  all: (): Entry[] => current().all(),
  forPurchase: (purchaseId: string): Entry[] => current().forPurchase(purchaseId),
  latest: <T>(purchaseId: string, kind: EntryKind): T | undefined => current().latest<T>(purchaseId, kind),
  verify: (): VerifyResult => current().verify(),
  tamperForDemo: (seq: number, mutate: (payload: any) => void): void => current().tamperForDemo(seq, mutate),
};
