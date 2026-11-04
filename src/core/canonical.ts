import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, so hashes and signatures are stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Normalise attribute values so "US 10", "10 " and "10" compare equal. */
export function normalizeValue(v: string | number): string {
  return String(v).trim().toLowerCase().replace(/^us\s*/, "").replace(/\s+/g, " ");
}
