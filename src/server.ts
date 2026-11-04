import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { llmStatus } from "./ai/llm.ts";
import { PHOTO_PRESETS } from "./agent/agents.ts";
import { loadState, publicState, resetState } from "./app/state.ts";
import * as svc from "./app/service.ts";
import * as store from "./store/catalog.ts";

const PORT = Number(process.env.PORT ?? 8787);
const baseUrl = (req: Request) => process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;

const app = express();
app.use(express.json({ limit: "8mb" })); // photos arrive as data URLs

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await h(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    next(e);
  }
};

/* ------------------------------ App state ------------------------------ */
app.get("/api/state", route(() => ({ ...publicState(), ai: llmStatus(), products: store.listProducts(), photoPresets: Object.keys(PHOTO_PRESETS) })));

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
app.post("/api/mandates", route((req) => svc.signNewMandate(req.body.pocketId, req.body.instruction, req.body.draft)));
app.post("/api/killswitch", route((req) => (svc.setKillSwitch(Boolean(req.body.on)), { killSwitch: loadState().killSwitch })));

/* ------------------------------ Agent & purchases ------------------------------ */
app.post("/api/agent/run", route((req) => svc.runAgent(req.body.mandateId, { mode: req.body.mode, productId: req.body.productId, baseUrl: baseUrl(req) })));
app.post("/api/purchases/:id/approve", route((req) => svc.approvePurchase(req.params.id)));
app.post("/api/purchases/:id/wrong", route((req) => svc.reportWrong(req.params.id, req.body)));
app.post("/api/purchases/:id/apply-fix", route((req) => svc.applyMandateFix(req.params.id)));

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
  const user = err instanceof svc.UserError;
  if (!user) console.error(err);
  res.status(user ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
});

app.listen(PORT, () => {
  loadState();
  const ai = llmStatus();
  console.log(`Agent Pocket listening on http://localhost:${PORT}`);
  console.log(`AI: ${ai.enabled ? `${ai.provider} / ${ai.model}` : "off (deterministic fallbacks)"}  ·  Vault: ${loadState().vault ? "connected" : "not connected"}`);
});
