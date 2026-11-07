import { FlightRecorder } from "../core/recorder.ts";

/** The one flight recorder for the app (hash-chained, tamper-evident). */
export const recorder = new FlightRecorder("data/ledger.jsonl");
