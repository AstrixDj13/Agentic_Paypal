import { generateKeyPairSync, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { Mandate, SignedMandate } from "./types.ts";

/**
 * Ed25519 signing for mandates (AP2-style intent binding).
 * In production the private key would live on the user's device; for the demo the
 * backend holds one key per user.
 */
export function generateUserKeys(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

export function signMandate(mandate: Mandate, privateKey: KeyObject): SignedMandate {
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
  const signature = sign(null, Buffer.from(canonicalJson(mandate)), privateKey).toString("base64");
  return { mandate, publicKey, signature };
}

export function verifyMandate(signed: SignedMandate): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(signed.publicKey, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonicalJson(signed.mandate)), key, Buffer.from(signed.signature, "base64"));
  } catch {
    return false;
  }
}
