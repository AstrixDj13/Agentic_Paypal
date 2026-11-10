import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import type { AppState } from "../app/state.ts";
import { FlightRecorder, type Entry } from "../core/recorder.ts";
import { db, pgEnabled } from "./pg.ts";

/**
 * Per-user state, held in memory for speed and written through to PostgreSQL.
 *
 * Every request runs "as" one user (AsyncLocalStorage), so the existing services keep calling
 * loadState() / saveState() and the recorder, and get that user's data. A save marks the user
 * dirty; a debounced flush writes only the rows that changed, in one transaction. The Black Box
 * ledger is append-only: each new entry is inserted in order as it is recorded.
 */

export interface UserEntry {
  userId: string;
  state: AppState;
  recorder: FlightRecorder;
  /** Last persisted JSON per row ("table:id"), so a flush only writes what changed. */
  snap: Map<string, string>;
  timer?: ReturnType<typeof setTimeout>;
  flushing: Promise<void>;
  ledgerQueue: Promise<void>;
  /** Live-update listeners (server-sent events) for this user. */
  listeners: Set<() => void>;
}

export const LOCAL_USER = "local";
const als = new AsyncLocalStorage<UserEntry>();
const cache = new Map<string, UserEntry>();

export const currentEntry = () => als.getStore();
export const runAs = <T>(e: UserEntry, fn: () => T): T => als.run(e, fn);
export const allEntries = () => [...cache.values()];
export const entryFor = (userId: string) => cache.get(userId);

/* ------------------------------------ Table mapping ------------------------------------ */

type Row = { id: string; cols: Record<string, unknown>; data?: unknown };
interface Spec { table: string; hasData: boolean; updatedAt: boolean; rows: (s: AppState) => Row[] }

type Intel = { signals?: { id: string; at: string; source: string; kind: string; domain?: string; title?: string; query?: string }[]; images?: Record<string, string> };
const intelOf = (s: AppState) => (s as AppState & { intel?: Intel }).intel ?? {};
const ts = (v?: string | null) => (v && !isNaN(Date.parse(v)) ? v : null);

const SPECS: Spec[] = [
  { table: "agents", hasData: true, updatedAt: true, rows: (s) => s.pockets.map((p) => ({ id: p.id, cols: { name: p.name, balance: p.balance, closed_at: ts(p.closedAt), created_at: ts(p.createdAt) }, data: p })) },
  {
    table: "mandates", hasData: true, updatedAt: true,
    rows: (s) => [...s.mandates.map((m) => [m, true] as const), ...s.retiredMandates.map((m) => [m, false] as const)].map(([m, active]) => ({
      id: m.mandate.id,
      cols: { agent_id: m.mandate.pocketId, active, item: m.mandate.item, max_unit_price: m.mandate.maxUnitPrice, expires_at: ts(m.mandate.expiresAt), created_at: ts(m.mandate.createdAt) },
      data: m,
    })),
  },
  { table: "purchases", hasData: true, updatedAt: true, rows: (s) => s.purchases.map((p) => ({ id: p.id, cols: { agent_id: p.pocketId, status: p.status, title: p.title, total: p.total, paypal_order_id: p.paypal?.orderId ?? null, created_at: ts(p.createdAt) }, data: p })) },
  { table: "proposals", hasData: true, updatedAt: true, rows: (s) => s.proposals.map((p) => ({ id: p.id, cols: { agent_id: p.agentId, kind: p.kind, status: p.status, created_at: ts(p.createdAt) }, data: p })) },
  { table: "chat_messages", hasData: true, updatedAt: false, rows: (s) => s.chats.map((c) => ({ id: c.id, cols: { agent_id: c.agentId, sender: c.from, at: ts(c.at) }, data: c })) },
  { table: "signals", hasData: true, updatedAt: false, rows: (s) => (intelOf(s).signals ?? []).map((g) => ({ id: g.id, cols: { source: g.source, kind: g.kind, domain: g.domain ?? null, title: g.title ?? g.query ?? null, at: ts(g.at) }, data: g })) },
  { table: "orders", hasData: true, updatedAt: true, rows: (s) => (s.orders ?? []).map((o) => ({ id: o.id, cols: { agent_id: o.agentId, kind: o.kind, status: o.status, total: o.total, created_at: ts(o.createdAt) }, data: o })) },
  { table: "images", hasData: false, updatedAt: false, rows: (s) => Object.entries(intelOf(s).images ?? {}).map(([id, url]) => ({ id, cols: { data_url: url } })) },
];

/** Everything that isn't one of the tables above: settings, PIN hash, vault, learning settings. */
function settingsOf(s: AppState) {
  const { pockets, mandates, retiredMandates, purchases, chats, proposals, orders, ...rest } = s;
  const intel = (rest as { intel?: Intel }).intel;
  if (intel) { const { signals, images, ...keep } = intel; (rest as { intel?: unknown }).intel = keep; }
  return rest;
}

const rowJson = (r: Row) => JSON.stringify([r.cols, r.data ?? null]);

/* ------------------------------------ Load ------------------------------------ */

function newEntry(userId: string, state: AppState, entries: Entry[], persist: boolean): UserEntry {
  const e: UserEntry = { userId, state, snap: new Map(), flushing: Promise.resolve(), ledgerQueue: Promise.resolve(), listeners: new Set(), recorder: undefined as unknown as FlightRecorder };
  e.recorder = new FlightRecorder(undefined, {
    entries,
    sink: persist ? {
      onAppend: (x) => { e.ledgerQueue = e.ledgerQueue.then(() => insertLedger(userId, [x])).catch((err) => console.error("ledger insert", err.message)); },
      onTamper: (x) => { e.ledgerQueue = e.ledgerQueue.then(async () => { await db().query("update ledger set payload = $3 where user_id = $1 and seq = $2", [userId, x.seq, JSON.stringify(x.payload)]); }).catch((err) => console.error("ledger tamper", err.message)); },
    } : undefined,
  });
  cache.set(userId, e);
  return e;
}

async function insertLedger(userId: string, entries: Entry[]) {
  for (let i = 0; i < entries.length; i += 200) {
    const chunk = entries.slice(i, i + 200);
    const vals: unknown[] = [];
    const ph = chunk.map((x, k) => {
      vals.push(userId, x.seq, x.ts, x.purchaseId, x.kind, JSON.stringify(x.payload), x.prevHash, x.hash);
      const b = k * 8;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::jsonb,$${b + 7},$${b + 8})`;
    });
    await db().query(`insert into ledger (user_id, seq, ts, purchase_id, kind, payload, prev_hash, hash) values ${ph.join(",")} on conflict (user_id, seq) do nothing`, vals);
  }
}

/** Builds a user's in-memory state from their rows. */
export async function loadUser(userId: string, migrate: (s: AppState) => AppState, fresh: () => AppState): Promise<UserEntry> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const q = (sql: string) => db().query(sql, [userId]).then((r) => r.rows);
  const [us, ag, md, pu, pr, ch, sg, im, lg, od] = await Promise.all([
    q("select data from user_state where user_id = $1"),
    q("select data from agents where user_id = $1"),
    q("select data, active from mandates where user_id = $1"),
    q("select data from purchases where user_id = $1"),
    q("select data from proposals where user_id = $1"),
    q("select data from chat_messages where user_id = $1"),
    q("select data from signals where user_id = $1"),
    q("select id, data_url from images where user_id = $1"),
    q("select seq, ts, purchase_id, kind, payload, prev_hash, hash from ledger where user_id = $1 order by seq"),
    q("select data from orders where user_id = $1"),
  ]);
  const by = <T>(rows: { data: T }[], key: (x: T) => string | undefined, desc = false) =>
    rows.map((r) => r.data).sort((a, b) => ((key(a) ?? "") < (key(b) ?? "") ? -1 : 1) * (desc ? -1 : 1));
  const base = (us[0]?.data as AppState | undefined) ?? fresh();
  const state = {
    ...base,
    pockets: by(ag, (p: any) => p.createdAt),
    mandates: by(md.filter((r: any) => r.active), (m: any) => m.mandate.createdAt),
    retiredMandates: by(md.filter((r: any) => !r.active), (m: any) => m.mandate.createdAt),
    purchases: by(pu, (p: any) => p.createdAt, true),
    proposals: by(pr, (p: any) => p.createdAt),
    chats: by(ch, (c: any) => c.at),
    orders: by(od, (o: any) => o.createdAt),
  } as AppState;
  const intel = ((base as { intel?: Intel }).intel ?? {}) as Intel & Record<string, unknown>;
  (state as AppState & { intel?: unknown }).intel = { ...intel, signals: by(sg, (g: any) => g.at), images: Object.fromEntries(im.map((r: any) => [r.id, r.data_url])) };
  const entries: Entry[] = lg.map((r: any) => ({ seq: r.seq, ts: new Date(r.ts).toISOString(), purchaseId: r.purchase_id, kind: r.kind, payload: r.payload, prevHash: r.prev_hash, hash: r.hash }));
  const e = newEntry(userId, migrate(state), entries, true);
  remember(e);
  return e;
}

/** Marks the current rows as persisted (after a load or a successful flush). */
function remember(e: UserEntry) {
  e.snap.clear();
  for (const spec of SPECS) for (const r of spec.rows(e.state)) e.snap.set(`${spec.table}:${r.id}`, rowJson(r));
  e.snap.set("user_state", JSON.stringify(settingsOf(e.state)));
}

/** A brand-new user (optionally seeded from the old single-user files), written to the database in full. */
export async function createUserState(userId: string, state: AppState, entries: Entry[] = []): Promise<UserEntry> {
  const e = newEntry(userId, state, entries, true);
  await flush(e);
  if (entries.length) await insertLedger(userId, entries);
  return e;
}

/* ------------------------------------ Save ------------------------------------ */

async function upsert(client: { query: (q: string, v: unknown[]) => Promise<unknown> }, userId: string, spec: Spec, rows: Row[]) {
  if (!rows.length) return;
  const colNames = Object.keys(rows[0].cols);
  const all = ["user_id", "id", ...colNames, ...(spec.hasData ? ["data"] : [])];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const vals: unknown[] = [];
    const ph = chunk.map((r, k) => {
      vals.push(userId, r.id, ...colNames.map((c) => r.cols[c]), ...(spec.hasData ? [JSON.stringify(r.data)] : []));
      return `(${all.map((c, j) => `$${k * all.length + j + 1}${c === "data" ? "::jsonb" : ""}`).join(",")})`;
    });
    const sets = [...colNames, ...(spec.hasData ? ["data"] : [])].map((c) => `${c} = excluded.${c}`);
    if (spec.updatedAt) sets.push("updated_at = now()");
    await client.query(`insert into ${spec.table} (${all.join(",")}) values ${ph.join(",")} on conflict (user_id, id) do update set ${sets.join(", ")}`, vals);
  }
}

async function flush(e: UserEntry): Promise<void> {
  const changed: { spec: Spec; rows: Row[] }[] = [];
  const gone: { spec: Spec; ids: string[] }[] = [];
  const next = new Map<string, string>();
  for (const spec of SPECS) {
    const rows = spec.rows(e.state);
    const ch: Row[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${spec.table}:${r.id}`;
      const j = rowJson(r);
      seen.add(key);
      next.set(key, j);
      if (e.snap.get(key) !== j) ch.push(r);
    }
    if (ch.length) changed.push({ spec, rows: ch });
    const del = [...e.snap.keys()].filter((k) => k.startsWith(`${spec.table}:`) && !seen.has(k)).map((k) => k.slice(spec.table.length + 1));
    if (del.length) gone.push({ spec, ids: del });
  }
  const settings = JSON.stringify(settingsOf(e.state));
  next.set("user_state", settings);
  const settingsChanged = e.snap.get("user_state") !== settings;
  if (!changed.length && !gone.length && !settingsChanged) return;

  const client = await db().connect();
  try {
    await client.query("begin");
    if (settingsChanged) {
      await client.query("insert into user_state (user_id, data) values ($1, $2::jsonb) on conflict (user_id) do update set data = excluded.data, updated_at = now()", [e.userId, settings]);
    }
    for (const { spec, rows } of changed) await upsert(client, e.userId, spec, rows);
    for (const { spec, ids } of gone) await client.query(`delete from ${spec.table} where user_id = $1 and id = any($2)`, [e.userId, ids]);
    await client.query("commit");
    e.snap = next;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error(`flush failed for ${e.userId}:`, (err as Error).message);
    schedule(e, 2000); // try again shortly; memory still has the truth
  } finally {
    client.release();
  }
}

function schedule(e: UserEntry, ms = 150) {
  clearTimeout(e.timer);
  e.timer = setTimeout(() => { e.flushing = e.flushing.then(() => flush(e)); }, ms);
}

/** Called by saveState(): persist soon, and tell this user's open screens something changed. */
export function markChanged(e: UserEntry) {
  if (pgEnabled()) schedule(e);
  for (const l of e.listeners) l();
}

/** Write everything now (shutdown, tests). */
export async function flushAll() {
  await Promise.all(allEntries().map(async (e) => {
    clearTimeout(e.timer);
    e.flushing = e.flushing.then(() => flush(e));
    await e.flushing;
    await e.ledgerQueue;
  }));
}

/* ------------------------------------ File mode (no DATABASE_URL) ------------------------------------ */

/** Single local user from data/state.json + data/ledger.jsonl, exactly as before. */
export function localEntry(loadFile: () => AppState): UserEntry {
  return cache.get(LOCAL_USER) ?? (() => {
    const e = newEntry(LOCAL_USER, loadFile(), [], false);
    e.recorder = new FlightRecorder("data/ledger.jsonl");
    return e;
  })();
}

/** The old single-user files, for importing into the first account. */
export function readLegacyFiles(): { state: AppState; entries: Entry[] } | null {
  if (!existsSync("data/state.json")) return null;
  try {
    const state = JSON.parse(readFileSync("data/state.json", "utf8")) as AppState;
    const entries = existsSync("data/ledger.jsonl") ? readFileSync("data/ledger.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry) : [];
    return { state, entries };
  } catch {
    return null;
  }
}
