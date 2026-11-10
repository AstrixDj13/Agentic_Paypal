import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, pgEnabled } from "../db/pg.ts";
import { createUserState, entryFor, loadUser, readLegacyFiles, type UserEntry } from "../db/store.ts";
import { freshState, migrate } from "./state.ts";

/**
 * Accounts: email + password (scrypt), and a session cookie. Each account has its own agents,
 * PIN, learned data and Black Box. The PIN / Face ID is still the signature for spending; the
 * password only opens the account.
 */

export class AccountError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const SESSION_COOKIE = "pp_session";
const SESSION_DAYS = 30;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const hashPw = (pw: string, salt: string) => scryptSync(pw, salt, 64).toString("hex");

function cleanEmail(v: unknown) {
  const e = String(v ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw new AccountError("Enter a valid email address.");
  return e;
}
function checkPassword(v: unknown) {
  const p = String(v ?? "");
  if (p.length < 8) throw new AccountError("Use at least 8 characters for your password.");
  if (p.length > 200) throw new AccountError("That password is too long.");
  return p;
}

/* Slow down guessing: at most 8 failed sign-ins per email per 15 minutes. */
const fails = new Map<string, { n: number; until: number }>();
function guard(email: string) {
  const f = fails.get(email);
  if (f && f.n >= 8 && f.until > Date.now()) throw new AccountError("Too many attempts. Try again in a few minutes.", 429);
}
function failed(email: string) {
  const f = fails.get(email);
  const fresh = !f || f.until < Date.now();
  fails.set(email, { n: fresh ? 1 : f!.n + 1, until: Date.now() + 15 * 60_000 });
}

async function newSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db().query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '30 days')", [sha(token), userId]);
  return { token, maxAgeSec: SESSION_DAYS * 86400 };
}

export async function signUp(emailIn: unknown, pwIn: unknown) {
  if (!pgEnabled()) throw new AccountError("Accounts need the database.", 501);
  const email = cleanEmail(emailIn);
  const pw = checkPassword(pwIn);
  const exists = await db().query("select 1 from users where email = $1", [email]);
  if (exists.rowCount) throw new AccountError("An account with that email already exists. Sign in instead.", 409);
  const id = `us_${randomBytes(6).toString("hex")}`;
  const salt = randomBytes(16).toString("hex");
  const first = Number((await db().query("select count(*)::int as n from users")).rows[0].n) === 0;
  await db().query("insert into users (id, email, pw_salt, pw_hash) values ($1, $2, $3, $4)", [id, email, salt, hashPw(pw, salt)]);
  // The very first account inherits the data from before accounts existed (data/state.json + ledger).
  const legacy = first ? readLegacyFiles() : null;
  await createUserState(id, legacy ? migrate(legacy.state) : freshState(), legacy?.entries ?? []);
  return { user: { id, email, imported: !!legacy }, ...(await newSession(id)) };
}

export async function signIn(emailIn: unknown, pwIn: unknown) {
  if (!pgEnabled()) throw new AccountError("Accounts need the database.", 501);
  const email = cleanEmail(emailIn);
  guard(email);
  const r = await db().query("select id, pw_salt, pw_hash from users where email = $1", [email]);
  const u = r.rows[0];
  const ok = u && timingSafeEqual(Buffer.from(hashPw(String(pwIn ?? ""), u.pw_salt), "hex"), Buffer.from(u.pw_hash, "hex"));
  if (!ok) { failed(email); throw new AccountError("Wrong email or password.", 401); }
  fails.delete(email);
  await loadUser(u.id, migrate, freshState);
  return { user: { id: u.id, email }, ...(await newSession(u.id)) };
}

export async function signOut(token?: string) {
  if (token && pgEnabled()) await db().query("delete from sessions where token_hash = $1", [sha(token)]);
}

/** The user for a session cookie, with their state loaded. Undefined if missing or expired. */
export async function userForSession(token?: string): Promise<{ id: string; email: string; entry: UserEntry } | undefined> {
  if (!token) return undefined;
  const r = await db().query("select u.id, u.email from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()", [sha(token)]);
  const u = r.rows[0];
  if (!u) return undefined;
  const entry = entryFor(u.id) ?? (await loadUser(u.id, migrate, freshState));
  return { id: u.id, email: u.email, entry };
}

/** Load every account's state at startup, so background jobs (look-first timers, weekly check-ins) run for everyone. */
export async function preloadAll() {
  const r = await db().query("select id from users");
  for (const row of r.rows) await loadUser(row.id, migrate, freshState);
  return r.rowCount ?? 0;
}

export function readCookie(header: string | undefined, name: string) {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
