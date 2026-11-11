import { createHash, createPublicKey, randomBytes, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { loadState, saveState } from "./state.ts";

/**
 * The user's signature for anything that spends or changes rules: a 4-digit PIN or the
 * phone's biometrics (WebAuthn: Face ID / fingerprint). Both are checked here on the server,
 * so the browser alone can never approve a proposal, move money or sign a job.
 */

export class AuthError extends Error {}

export interface AuthState {
  pinSalt?: string;
  pinHash?: string;
  failed: number;
  lockedUntil?: string;
  credentials: { id: string; publicKey: string; alg: number; createdAt: string }[];
  challenge?: { value: string; expiresAt: number };
}

/** What a signing request carries: either the PIN or a WebAuthn assertion. */
export type Signature =
  | { pin: string }
  | { assertion: { id: string; clientDataJSON: string; authenticatorData: string; signature: string } };

const MAX_TRIES = 5;
const LOCK_MS = 30_000;

export function authState(): AuthState {
  const s = loadState();
  s.auth ??= { failed: 0, credentials: [] };
  return s.auth;
}

/** credentialIds lets each device tell whether ITS passkey is registered (not just "some device has one"). */
export function authStatus() {
  const a = authState();
  return { hasPin: !!a.pinHash, biometrics: a.credentials.length > 0, credentialIds: a.credentials.map((c) => c.id), lockedUntil: a.lockedUntil };
}

/** Change the PIN. The route requires the CURRENT PIN as the signature (not a passkey), so a leaked PIN can be replaced. */
export function changePin(newPin: unknown) {
  const a = authState();
  if (!validPin(newPin)) throw new AuthError("The new PIN must be 4 digits.");
  a.pinSalt = randomBytes(16).toString("hex");
  a.pinHash = hashPin(newPin, a.pinSalt);
  a.failed = 0;
  delete a.lockedUntil;
  saveState();
  return authStatus();
}

/** Remove a registered passkey (Face ID / fingerprint) by its credential id. */
export function removeCredential(id: unknown) {
  const a = authState();
  const before = a.credentials.length;
  a.credentials = a.credentials.filter((c) => c.id !== String(id ?? ""));
  if (a.credentials.length === before) throw new AuthError("That passkey isn't registered here.");
  saveState();
  return authStatus();
}

const hashPin = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString("hex");
const validPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{4}$/.test(pin);

export function setupPin(pin: unknown) {
  const a = authState();
  if (a.pinHash) throw new AuthError("A PIN is already set.");
  if (!validPin(pin)) throw new AuthError("PIN must be 4 digits.");
  a.pinSalt = randomBytes(16).toString("hex");
  a.pinHash = hashPin(pin, a.pinSalt);
  a.failed = 0;
  saveState();
}

function checkPin(pin: unknown) {
  const a = authState();
  if (!a.pinHash || !a.pinSalt) throw new AuthError("Set a PIN first.");
  if (a.lockedUntil && Date.parse(a.lockedUntil) > Date.now()) {
    throw new AuthError(`Too many wrong tries. Try again in ${Math.ceil((Date.parse(a.lockedUntil) - Date.now()) / 1000)}s.`);
  }
  const ok = validPin(pin) && timingSafeEqual(Buffer.from(hashPin(pin, a.pinSalt), "hex"), Buffer.from(a.pinHash, "hex"));
  if (!ok) {
    a.failed += 1;
    if (a.failed >= MAX_TRIES) {
      a.lockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
      a.failed = 0;
    }
    saveState();
    throw new AuthError(a.lockedUntil && Date.parse(a.lockedUntil) > Date.now() ? "Too many wrong tries. Locked for 30 seconds." : `Wrong PIN. ${MAX_TRIES - a.failed} tries left.`);
  }
  a.failed = 0;
  delete a.lockedUntil;
  saveState();
}

/* ------------------------------------ WebAuthn ------------------------------------ */

export function newChallenge() {
  const a = authState();
  const value = randomBytes(32).toString("base64url");
  a.challenge = { value, expiresAt: Date.now() + 2 * 60_000 };
  return { challenge: value, credentialIds: a.credentials.map((c) => c.id) };
}

function takeChallenge(got: string) {
  const a = authState();
  const c = a.challenge;
  delete a.challenge; // single use
  if (!c || c.expiresAt < Date.now() || c.value !== got) throw new AuthError("Biometric check expired. Try again.");
}

function checkClientData(b64: string, type: string, origin: { host: string }) {
  const cd = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  if (cd.type !== type) throw new AuthError("Wrong biometric response type.");
  takeChallenge(cd.challenge);
  if (new URL(cd.origin).host !== origin.host) throw new AuthError("Biometric response came from a different site.");
  return cd;
}

/** Stores a platform credential (Face ID / fingerprint). Requires the PIN in the same request. */
export function registerCredential(body: { id: string; publicKey: string; alg: number; clientDataJSON: string }, origin: { host: string }) {
  checkClientData(body.clientDataJSON, "webauthn.create", origin);
  createPublicKey({ key: Buffer.from(body.publicKey, "base64url"), format: "der", type: "spki" }); // throws if not a key
  if (![-7, -8, -257].includes(Number(body.alg))) throw new AuthError("Unsupported biometric key type.");
  const a = authState();
  a.credentials = a.credentials.filter((c) => c.id !== body.id);
  a.credentials.push({ id: body.id, publicKey: body.publicKey, alg: Number(body.alg), createdAt: new Date().toISOString() });
  saveState();
}

function checkAssertion(x: Extract<Signature, { assertion: unknown }>["assertion"], origin: { host: string }) {
  const cred = authState().credentials.find((c) => c.id === x.id);
  if (!cred) throw new AuthError("This device's Face ID / fingerprint isn't set up here.");
  checkClientData(x.clientDataJSON, "webauthn.get", origin);
  const authData = Buffer.from(x.authenticatorData, "base64url");
  const rpIdHash = createHash("sha256").update(origin.host.split(":")[0]).digest();
  if (!authData.subarray(0, 32).equals(rpIdHash)) throw new AuthError("Biometric response is for a different site.");
  const flags = authData[32];
  if (!(flags & 0x01) || !(flags & 0x04)) throw new AuthError("Biometric check did not verify you.");
  const signed = Buffer.concat([authData, createHash("sha256").update(Buffer.from(x.clientDataJSON, "base64url")).digest()]);
  const key = createPublicKey({ key: Buffer.from(cred.publicKey, "base64url"), format: "der", type: "spki" });
  const ok = verify(cred.alg === -8 ? null : "sha256", signed, key, Buffer.from(x.signature, "base64url"));
  if (!ok) throw new AuthError("Biometric signature did not verify.");
}

/* ------------------------------------ The gate ------------------------------------ */

/** Throws unless the request carries a valid PIN or biometric signature. */
export function requireSignature(sig: unknown, origin: { host: string }) {
  if (!authState().pinHash) throw new AuthError("Set a PIN first.");
  const s = sig as Partial<{ pin: string; assertion: any }> | undefined;
  if (s?.assertion) return checkAssertion(s.assertion, origin);
  if (s?.pin !== undefined) return checkPin(s.pin);
  throw new AuthError("Signature required: enter your PIN or use Face ID.");
}
