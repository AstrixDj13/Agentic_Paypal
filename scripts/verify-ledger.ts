// Verifies the flight recorder file on disk: `npx tsx scripts/verify-ledger.ts [path]`.
import { readFileSync } from "node:fs";
import { verifyChain } from "../src/core/recorder.ts";

const file = process.argv[2] ?? "data/ledger.jsonl";
const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const r = verifyChain(entries);
console.log(`${file}: ${entries.length} entries, ${r.ok ? "chain intact" : `BROKEN at entry #${r.brokenAt}`}`);
process.exitCode = r.ok ? 0 : 1;
