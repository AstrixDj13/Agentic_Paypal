// Row counts per table, plus one example query: `npx tsx --env-file=.env scripts/db-stats.ts [schema]`.
import pg from "pg";

const schema = process.argv[2] ?? "public";
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Bad schema name");
// The pooled endpoint doesn't allow changing search_path at startup, so this uses the direct endpoint.
const url = (process.env.DATABASE_URL ?? "").replace(/sslmode=require/, "sslmode=verify-full").replace("-pooler", "");
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query(`set search_path to ${schema}`);
const tables = ["users", "sessions", "user_state", "agents", "mandates", "purchases", "proposals", "chat_messages", "signals", "images", "ledger"];
const counts = await Promise.all(tables.map(async (t) => `${t} ${(await c.query(`select count(*)::int as n from ${t}`)).rows[0].n}`));
console.log(`[${schema}] rows: ${counts.join(" · ")}`);
const p = await c.query("select status, count(*)::int as n, coalesce(sum(total), 0)::float as total from purchases group by status order by status");
console.log(`[${schema}] purchases by status: ${p.rows.map((x) => `${x.status} ${x.n} ($${x.total})`).join(", ") || "none"}`);
await c.end();
