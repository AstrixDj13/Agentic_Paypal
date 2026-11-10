import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { llmStatus } from "./ai/llm.ts";
import { PHOTO_PRESETS } from "./agent/agents.ts";
import { loadState, publicState, resetState } from "./app/state.ts";
import * as svc from "./app/service.ts";
import * as agentsSvc from "./app/agentService.ts";
import { sweepExceptions } from "./app/chat.ts";
import * as auth from "./app/auth.ts";
import * as intel from "./intel/signals.ts";
import { agentSuggestions, buildProfile, ruleTips } from "./intel/profile.ts";
import * as push from "./intel/push.ts";
import { shareLink, snap } from "./intel/snap.ts";
import { buildCheckin, maybeWeeklyCheckin, sendCheckin } from "./intel/checkin.ts";
import * as routine from "./grocery/routine.ts";
import { placeNow } from "./grocery/now.ts";
import { GROCERY_STORES, STARTER_LIST, catalogView } from "./grocery/catalog.ts";
import * as store from "./store/catalog.ts";
import { channel3Enabled } from "./store/channel3.ts";
import * as accounts from "./app/accounts.ts";
import { closeDb, migrateSchema, pgEnabled } from "./db/pg.ts";
import { allEntries, flushAll, runAs, type UserEntry } from "./db/store.ts";
import { currentUserEntry } from "./app/state.ts";

const PORT = Number(process.env.PORT ?? 8787);
const baseUrl = (req: Request) => process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;

const app = express();
app.set("trust proxy", 1); // Render terminates HTTPS in front of us; needed for secure cookies
app.use(express.json({ limit: "8mb" })); // photos arrive as data URLs

// The browser extension talks to two endpoints only (pairing, and sending shopping signals).
app.use(["/api/intel/pair", "/api/intel/signals"], (req, res, next) => {
  const origin = req.get("origin") ?? "";
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "content-type, authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ------------------------------ Accounts & who is asking ------------------------------ */

const sessionCookie = (req: Request) => accounts.readCookie(req.get("cookie"), accounts.SESSION_COOKIE);
const setSession = (req: Request, res: Response, s: { token: string; maxAgeSec: number }) =>
  res.cookie(accounts.SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: s.maxAgeSec * 1000, path: "/" });

app.get("/api/account/me", async (req, res, next) => {
  try {
    if (!pgEnabled()) return res.json({ mode: "local", user: { id: "local", email: null } });
    const u = await accounts.userForSession(sessionCookie(req));
    res.json({ mode: "accounts", user: u ? { id: u.id, email: u.email } : null });
  } catch (e) { next(e); }
});
app.post("/api/account/signup", async (req, res, next) => {
  try { const r = await accounts.signUp(req.body?.email, req.body?.password); setSession(req, res, r); res.json({ user: r.user }); } catch (e) { next(e); }
});
app.post("/api/account/login", async (req, res, next) => {
  try { const r = await accounts.signIn(req.body?.email, req.body?.password); setSession(req, res, r); res.json({ user: r.user }); } catch (e) { next(e); }
});
app.post("/api/account/logout", async (req, res, next) => {
  try { await accounts.signOut(sessionCookie(req)); res.clearCookie(accounts.SESSION_COOKIE, { path: "/" }); res.json({ ok: true }); } catch (e) { next(e); }
});

// Pairing codes are tried across all accounts, so limit guesses per address.
const pairTries = new Map<string, { n: number; until: number }>();

/** Every other API call runs as one user: the session's account, or the account a paired browser belongs to. */
app.use("/api", async (req, res, next) => {
  if (!pgEnabled() || req.path.startsWith("/account/")) return next();
  try {
    let entry: UserEntry | undefined;
    if (req.path === "/intel/pair") {
      const ip = req.ip ?? "?";
      const t = pairTries.get(ip);
      if (t && t.n >= 20 && t.until > Date.now()) return res.status(429).json({ error: "Too many tries. Wait a few minutes." });
      const code = String(req.body?.code ?? "").trim();
      entry = allEntries().find((e) => runAs(e, () => { const pc = intel.intel().pairCode; return !!pc && pc.code === code && pc.expiresAt > Date.now(); }));
      if (!entry) {
        pairTries.set(ip, { n: (t && t.until > Date.now() ? t.n : 0) + 1, until: Date.now() + 10 * 60_000 });
        return res.status(400).json({ error: "That code is wrong or expired. Get a new one in Pocket." });
      }
    } else if (req.path === "/intel/signals") {
      const h = req.get("authorization");
      entry = allEntries().find((e) => runAs(e, () => !!intel.deviceForToken(h)));
      if (!entry) return res.status(401).json({ error: "This browser isn't paired with Pocket." });
    } else {
      entry = (await accounts.userForSession(sessionCookie(req)))?.entry;
      if (!entry) return res.status(401).json({ error: "Sign in first.", code: "signin" });
    }
    runAs(entry, () => next());
  } catch (e) { next(e); }
});

/* ------------------------------ Live updates (server-sent events) ------------------------------ */
// Instead of every screen asking every 2 seconds, the server says "something changed" the moment it does.
app.get("/api/events", (req, res) => {
  const e = currentUserEntry();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  let pending: ReturnType<typeof setTimeout> | undefined;
  const changed = () => { clearTimeout(pending); pending = setTimeout(() => res.write("data: changed\n\n"), 80); };
  const beat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  e.listeners.add(changed);
  req.on("close", () => { clearInterval(beat); clearTimeout(pending); e.listeners.delete(changed); });
});

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await h(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    next(e);
  }
};

const origin = (req: Request) => ({ host: req.get("host") ?? "" });
/** Routes that spend money or change rules need the user's PIN or Face ID, verified here. */
const signed = (h: Handler) => route((req, res) => {
  auth.requireSignature(req.body?.auth, origin(req));
  return h(req, res);
});

/* ------------------------------ What Pocket knows (behaviour memory) ------------------------------ */
app.get("/api/intel", route(() => ({ ...intel.publicIntel(), profile: buildProfile(), suggestions: agentSuggestions() })));
app.post("/api/intel/pause", route((req) => (intel.setPaused(!!req.body.paused), { paused: !!req.body.paused })));
app.post("/api/intel/forget", route((req) => (intel.forget(String(req.body.id ?? "")), { ok: true })));
app.post("/api/intel/forget-interest", route((req) => (intel.forgetMatching((req.body.words ?? []).map(String)), intel.dismiss(String(req.body.key ?? "")), { ok: true })));
app.post("/api/intel/forget-all", route(() => (intel.forgetAll(), { ok: true })));
app.post("/api/intel/dismiss", route((req) => (intel.dismiss(String(req.body.key ?? "")), { ok: true })));
app.post("/api/intel/pair-code", route(() => intel.newPairCode()));
app.post("/api/intel/unpair", route((req) => (intel.unpair(String(req.body.id ?? "")), { ok: true })));
app.post("/api/intel/tips", route((req) => ruleTips(req.body.draft)));
app.post("/api/intel/image", route((req) => ({ hash: intel.storeImage(String(req.body.dataUrl ?? "")) })));
app.get("/api/intel/image/:hash", (req, res) => {
  const d = intel.imageFor(req.params.hash);
  const m = d?.match(/^data:(image\/[a-z]+);base64,(.*)$/);
  if (!m) return res.sendStatus(404);
  res.type(m[1]).set("Cache-Control", "private, max-age=86400").send(Buffer.from(m[2], "base64"));
});
// Extension: trade a 6-digit code for a token, then send signals with it.
app.post("/api/intel/pair", route((req) => intel.pair(req.body.code, req.body.label)));
app.post("/api/intel/signals", route((req) => {
  const device = intel.deviceForToken(req.get("authorization"));
  if (!device) throw new auth.AuthError("This browser isn't paired with Pocket.");
  const list = Array.isArray(req.body.signals) ? req.body.signals.slice(0, 50) : [req.body];
  const kept = list.map((x: any) => intel.record({ ...x, source: "extension", kind: ["view", "search", "cart"].includes(x?.kind) ? x.kind : "view" })).filter(Boolean).length;
  return { kept, paused: intel.intel().paused };
}));

/* ------------------------------ Snap to want, share to Pocket ------------------------------ */
app.post("/api/snap", route((req) => snap(String(req.body.imageDataUrl ?? ""))));
app.post("/api/share", route((req) => shareLink({ url: req.body.url, title: req.body.title, text: req.body.text })));

/* ------------------------------ Push notifications ------------------------------ */
app.get("/api/push/key", route(() => push.publicKey()));
app.post("/api/push/subscribe", route((req) => push.subscribe(req.body.subscription)));
app.post("/api/push/unsubscribe", route((req) => push.unsubscribe(req.body.endpoint)));
// Weekly check-in: one bundled notification instead of a ping per item. "Send now" is for the demo.
app.get("/api/checkin", route(() => buildCheckin()));
app.post("/api/checkin/send", route(() => sendCheckin()));
app.post("/api/push/test", route(async () => ({ sent: await push.notify({ title: "PayPal Pocket", body: "Notifications are on. Your agents will ask you here before they buy.", url: "/" }) })));

/* ------------------------------ PIN & Face ID ------------------------------ */
app.get("/api/auth/status", route(() => auth.authStatus()));
app.post("/api/auth/pin", route((req) => (auth.setupPin(req.body.pin), auth.authStatus())));
app.post("/api/auth/challenge", route(() => auth.newChallenge()));
app.post("/api/auth/unlock", route((req) => (auth.requireSignature(req.body?.auth, origin(req)), { ok: true })));
app.post("/api/auth/biometric", signed((req) => (auth.registerCredential(req.body.credential, origin(req)), auth.authStatus())));

/* ------------------------------ App state ------------------------------ */
app.get("/api/state", route(() => (sweepExceptions(), { ...publicState(), ai: llmStatus(), products: store.listProducts(), photoPresets: Object.keys(PHOTO_PRESETS), channel3: { enabled: channel3Enabled() } })));

/* ------------------------------ Agents (pocket = agent) ------------------------------ */
app.post("/api/agents", signed((req) => agentsSvc.createAgent(req.body)));
app.post("/api/agents/:id/job", signed((req) => agentsSvc.giveJob(req.params.id, String(req.body.instruction ?? ""), req.body.draft)));
app.post("/api/agents/:id/settings", route((req) => agentsSvc.updateAgent(req.params.id, req.body ?? {})));
app.post("/api/agents/:id/chat", route((req) => agentsSvc.chat(req.params.id, req.body.text, baseUrl(req))));
app.post("/api/agents/:id/read", route((req) => agentsSvc.markRead(req.params.id)));
app.post("/api/agents/:id/check", route((req) => agentsSvc.checkNow(req.params.id, baseUrl(req))));
app.post("/api/agents/:id/find", route((req) => agentsSvc.findReal(req.params.id, baseUrl(req))));
app.post("/api/agents/:id/end-exception", route((req) => agentsSvc.endExceptionNow(req.params.id)));
// Closing only stops spending, so no PIN. Restoring lets it spend again, so it needs a signature.
app.post("/api/agents/:id/close", route((req) => agentsSvc.closeAgent(req.params.id)));
app.post("/api/agents/:id/restore", signed((req) => agentsSvc.restoreAgent(req.params.id)));
app.post("/api/agents/:id/delete", route((req) => agentsSvc.deleteAgent(req.params.id)));
app.post("/api/agents/:id/transfer", signed((req) => agentsSvc.transfer(String(req.body.fromId ?? ""), req.params.id, Number(req.body.amount))));
app.post("/api/proposals/:id/approve", signed((req) => agentsSvc.approveProposal(req.params.id, baseUrl(req))));
app.post("/api/proposals/:id/decline", route((req) => agentsSvc.declineProposal(req.params.id)));

/* ------------------------------ PayPal connect (Vault) ------------------------------ */
app.post("/api/paypal/connect", route(async (req) => ({ approveUrl: await svc.startPaypalConnect(baseUrl(req)) })));
app.get("/api/paypal/return", async (_req, res) => {
  try {
    await svc.finishPaypalConnect();
    res.redirect("/?paypal=connected");
  } catch (e) {
    res.redirect(`/?paypal=error&reason=${encodeURIComponent(String(e))}`);
  }
});

/* ------------------------------ Pockets & mandates ------------------------------ */
app.post("/api/pockets", route((req) => svc.createPocket(req.body.name, Number(req.body.amount))));
app.post("/api/mandates/draft", route((req) => svc.draftMandate(String(req.body.instruction ?? ""))));
app.post("/api/mandates", signed((req) => svc.signNewMandate(req.body.pocketId, req.body.instruction, req.body.draft)));
app.post("/api/killswitch", route((req) => (svc.setKillSwitch(Boolean(req.body.on)), { killSwitch: loadState().killSwitch })));

/* ------------------------------ Agent & purchases ------------------------------ */
app.post("/api/agent/run", route((req) => svc.runAgent(req.body.mandateId, { mode: req.body.mode, productId: req.body.productId, baseUrl: baseUrl(req) })));
app.post("/api/agent/find", route((req) => svc.findAndBuy(req.body.mandateId, baseUrl(req))));
app.post("/api/store/import", route((req) => svc.importRealProducts(String(req.body.query ?? ""), req.body.maxPrice ? Number(req.body.maxPrice) : undefined)));
app.post("/api/purchases/:id/approve", signed((req) => svc.approvePurchase(req.params.id)));
/* ------------------------------ Weekly orders, right-now orders, buy in store ------------------------------ */
app.get("/api/grocery/catalog", route(() => ({ stores: GROCERY_STORES, groups: catalogView(0), starter: STARTER_LIST, simulated: true })));
// Swap and picking a substitute change what you pay, so they need the PIN. Keep usual and skip don't.
app.post("/api/orders/:id/swap", signed((req) => routine.acceptSwap(req.params.id, String(req.body.itemId ?? ""))));
app.post("/api/orders/:id/keep", route((req) => routine.keepUsual(req.params.id, String(req.body.itemId ?? ""))));
app.post("/api/orders/:id/stockout", route((req) => {
  const productId = req.body.productId ? String(req.body.productId) : null;
  if (productId) auth.requireSignature(req.body?.auth, origin(req));
  return routine.answerStockout(req.params.id, String(req.body.itemId ?? ""), productId);
}));
app.post("/api/orders/:id/place", signed((req) => routine.placeOrder(req.params.id, "user")));
app.post("/api/orders/:id/order-now", signed((req) => placeNow(req.params.id, Number(req.body.choice) || 0)));
app.post("/api/agents/:id/next-week", route((req) => routine.nextWeek(req.params.id)));
// In store: no money moves through Pocket. Online instead: only an in-rules purchase that was already found.
app.post("/api/purchases/:id/store", route((req) => svc.resolveStore(req.params.id, req.body.decision === "online" ? "online" : "in_store")));

// "Take a look before I buy": skipping is always safe; "looks good" only brings forward a purchase that is already within the rules.
app.post("/api/purchases/:id/look", route((req) => svc.resolveLook(req.params.id, req.body.decision === "skip" ? "skip" : "buy")));
app.post("/api/purchases/:id/wrong", route((req) => svc.reportWrong(req.params.id, req.body)));
app.post("/api/purchases/:id/apply-fix", signed((req) => svc.applyMandateFix(req.params.id)));

/* ------------------------------ Black Box ledger ------------------------------ */
app.get("/api/ledger", route(() => ({ entries: svc.recorder.all(), verify: svc.recorder.verify() })));
app.get("/api/ledger/verify", route(() => svc.recorder.verify()));
app.post("/api/ledger/tamper", route((req) => {
  // Demo only: rewrite a stored field without re-hashing, to show the chain catching it.
  const seq = Number(req.body.seq);
  svc.recorder.tamperForDemo(seq, (p) => {
    if (p?.attributes?.size_us) p.attributes.size_us = String(Number(p.attributes.size_us) + 1);
    else if (p && typeof p === "object") p.tampered = true;
  });
  return svc.recorder.verify();
}));

/* ------------------------------ Demo store (agent-ready merchant) ------------------------------ */
app.get("/api/store/products", route(() => store.listProducts()));
app.post("/api/store/:id/restock", route((req) => svc.restock(req.params.id, req.body.inStock !== false)));
app.post("/api/store/:id/warehouse-error", route((req) => svc.setWarehouseError(req.params.id, req.body.shipsAs ?? null)));
app.post("/api/demo/reset", route(() => {
  store.resetCatalog();
  resetState(true);
  return { ok: true };
}));

/* ------------------------------ Frontend ------------------------------ */
const web = resolve("web/dist");
if (existsSync(web)) {
  app.use(express.static(web));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(web, "index.html")));
} else {
  app.get("/", (_req, res) => res.type("text").send("Agent Pocket API is running. Frontend not built yet (web/dist missing)."));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof accounts.AccountError) return res.status(err.status).json({ error: err.message });
  const denied = err instanceof auth.AuthError;
  const user = err instanceof svc.UserError || denied || err instanceof intel.PairError;
  if (!user) console.error(err);
  res.status(denied ? 401 : user ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
});

// Look-first purchases go ahead when their window ends (after a fresh rule check).
const forEveryone = (job: () => Promise<unknown>, label: string) => async () => {
  const list = pgEnabled() ? allEntries() : [currentUserEntry()];
  for (const e of list) await runAs(e, job).catch((err) => console.error(label, err));
};
setInterval(forEveryone(() => svc.sweepLooks(), "look sweep"), 3000).unref();
setInterval(forEveryone(() => maybeWeeklyCheckin(), "weekly check-in"), 5 * 60_000).unref();
setInterval(forEveryone(() => routine.sweepOrders(), "order deadlines"), 5000).unref();

async function start() {
  let mode = "local file (single user)";
  if (pgEnabled()) {
    await migrateSchema();
    const n = await accounts.preloadAll();
    mode = `PostgreSQL · ${n} account${n === 1 ? "" : "s"} loaded`;
  } else {
    loadState(); // file mode: load the single local user now
  }
  app.listen(PORT, () => {
    const ai = llmStatus();
    console.log(`Agent Pocket listening on http://localhost:${PORT}`);
    console.log(`Storage: ${mode}  ·  AI: ${ai.enabled ? `${ai.provider} / ${ai.model}` : "off (deterministic fallbacks)"}`);
  });
}

// On shutdown (Render redeploys send SIGTERM), write any pending changes before exiting.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    try { if (pgEnabled()) { await flushAll(); await closeDb(); } } finally { process.exit(0); }
  });
}

start().catch((e) => { console.error("Failed to start:", e); process.exit(1); });
