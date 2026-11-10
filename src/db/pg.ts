import pg from "pg";

/**
 * PostgreSQL (Neon). Every table is scoped by user_id. Each row keeps the full record as
 * `data` (jsonb) plus the columns worth querying and indexing on their own.
 */

let pool: pg.Pool | undefined;

export const pgEnabled = () => !!process.env.DATABASE_URL && process.env.STORAGE_MODE !== "file";

export function db(): pg.Pool {
  if (!pool) {
    // Strictest TLS: verify the server certificate and host name.
    const url = (process.env.DATABASE_URL ?? "").replace(/sslmode=(require|prefer|verify-ca)/, "sslmode=verify-full");
    pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
    pool.on("error", (e) => console.error("postgres pool error", e.message));
  }
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}

const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  pw_salt text not null,
  pw_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user on sessions(user_id);

-- Settings and everything small that isn't its own table (PIN hash, vault, kill switch, learning settings).
create table if not exists user_state (
  user_id text primary key references users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists agents (
  user_id text not null references users(id) on delete cascade,
  id text not null,
  name text not null,
  balance numeric(12,2) not null,
  closed_at timestamptz,
  created_at timestamptz,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Signed rules. active = the agent's current job; retired versions stay for old purchases and history.
create table if not exists mandates (
  user_id text not null references users(id) on delete cascade,
  id text not null,
  agent_id text not null,
  active boolean not null,
  item text,
  max_unit_price numeric(12,2),
  expires_at timestamptz,
  created_at timestamptz,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists mandates_agent on mandates(user_id, agent_id);

create table if not exists purchases (
  user_id text not null references users(id) on delete cascade,
  id text not null,
  agent_id text not null,
  status text not null,
  title text,
  total numeric(12,2),
  paypal_order_id text,
  created_at timestamptz,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists purchases_agent on purchases(user_id, agent_id, created_at desc);
create index if not exists purchases_status on purchases(user_id, status);

create table if not exists proposals (
  user_id text not null references users(id) on delete cascade,
  id text not null,
  agent_id text not null,
  kind text not null,
  status text not null,
  created_at timestamptz,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists proposals_pending on proposals(user_id, status);

create table if not exists chat_messages (
  user_id text not null references users(id) on delete cascade,
  id text not null,
  agent_id text not null,
  sender text not null,
  at timestamptz,
  data jsonb not null,
  primary key (user_id, id)
);
create index if not exists chat_agent on chat_messages(user_id, agent_id, at);

-- What Pocket learned (browsing, searches, photos, decisions).
create table if not exists signals (
  user_id text not null references users(id) on delete cascade,
  id text not null,
  source text not null,
  kind text not null,
  domain text,
  title text,
  at timestamptz,
  data jsonb not null,
  primary key (user_id, id)
);
create index if not exists signals_at on signals(user_id, at desc);

-- Reference photos for rules ("describe it"), keyed by hash.
create table if not exists images (
  user_id text not null references users(id) on delete cascade,
  id text not null,
  data_url text not null,
  primary key (user_id, id)
);

-- The Black Box: append-only and hash-chained. Rows are only ever inserted (the demo tamper button is the one exception).
create table if not exists ledger (
  user_id text not null references users(id) on delete cascade,
  seq integer not null,
  ts timestamptz not null,
  purchase_id text not null,
  kind text not null,
  payload jsonb,
  prev_hash text not null,
  hash text not null,
  primary key (user_id, seq)
);
`;

export async function migrateSchema() {
  await db().query(SCHEMA);
}
