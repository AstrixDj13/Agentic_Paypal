# Paygent: PayPal Pocket

**PayPal already stores your automatic payments. Paygent makes them safe.**

Capped, PIN-signed *pockets* for every subscription, bill and AI shopping agent. Every payment is checked by plain code against rules you signed **before** PayPal is called, and every decision is written to a tamper-evident Black Box.

> **AI explains. Code decides. PayPal pays.**

- **Live demo:** https://paypal-pocket.onrender.com (best on a phone or a narrow window; installable as a PWA)
- **Demo video (3 min):** see the Devpost submission
- Built for the **PayPal AI Hackathon 2026** by Debjit Majumder and Anubhav Goswami

> **Demo note:** merchants, stores and charges are **simulated** and labelled as such in the app. Every payment, refund and payout is a **real PayPal sandbox transaction**.

---

## What it does

Each pocket is an agent with its own balance, one job, and rules the user signs once with a 4-digit PIN or Face ID / fingerprint.

### Subscriptions and bills: the everyday hero
| Moment | What happens |
|---|---|
| **Discovery** | "We found 7 automatic payments on your PayPal, about $161 a month." One PIN turns each into its own capped pocket. |
| **Price hike** | Netflix asks $22.99 against a $15.49 cap. The guard holds the charge, the phone is notified, and the user approves the new price (PIN) or cancels. |
| **Bills that vary** | "Pay electricity if it's within 20% of usual, otherwise ask me", with a hard ceiling that is never exceeded. |
| **Trial ending** | Warned before a free trial turns paid. Silence never pays. |
| **Duplicates** | "You pay for Spotify *and* Apple Music." Cancel one or keep both. |
| **Proof** | "See the record": what the merchant asked, what the rules allowed, what Pocket did. |

### Shopping agents: the second act
- **One-time hunts:** plain words ("winter jacket, size M, under $150") become rules you sign. Agents search real retailers through **Channel3** (text and photo search).
- **Weekly groceries:** at most one question a week, savings measured only against what you usually pay, and silence means your usual items.
- **Right now:** "chicken biryani under $20 within 40 minutes", with one pick and its reasons.
- **Take a look first:** a push with photo and price before buying, plus Looks good / Skip from the notification.
- **Recourse:** a rule-based arbiter decides fault. A merchant mistake triggers a **PayPal refund**; an agent mistake is paid back from an **Agent Cover Pool via PayPal Payouts**.

---

## How we used PayPal

All calls go directly to the PayPal REST APIs on the **sandbox** (`src/paypal/`).

| API | Where | What it does in Paygent |
|---|---|---|
| **OAuth 2.0** (`/v1/oauth2/token`) | `src/paypal/client.ts` | Server-to-server auth for every call. |
| **Vault v3** (`/v3/vault/setup-tokens`, `/v3/vault/payment-tokens`) | `src/paypal/api.ts`, `src/app/service.ts` | "Connect PayPal" once. Pockets then pay with the vaulted method, so merchants never see a card. |
| **Orders v2** (`/v2/checkout/orders`, capture) | `createVaultedOrder`, `captureOrder` | Every agent purchase and every subscription/bill charge, created **only after the guard allows it**. |
| **Payments v2 refunds** (`/v2/payments/captures/{id}/refund`) | `refundCapture` | Merchant at fault (e.g. wrong size shipped), so the capture is refunded. |
| **Payouts v1** (`/v1/payments/payouts`) | `sendPayout` | Agent at fault, so the user is reimbursed from the Agent Cover Pool. |

## How we used AI

| Tool | Where | What it does |
|---|---|---|
| **Claude** (Anthropic, `claude-opus-5-5`, official `@anthropic-ai/sdk`) | `src/ai/llm.ts`, `src/agent/` | Turns plain words into structured rules; powers each agent's chat (it can only **propose** changes, which the user signs); writes plain-English explanations; reads photos (delivery evidence, "snap something you want"). |
| **Channel3** (AI product search API) | `src/store/channel3.ts`, `src/intel/snap.ts` | Real retailer listings for hunts, plus image search. |

**The AI never approves a payment.** Every payment passes the deterministic guard first, and every AI call has a deterministic fallback, so the app keeps working without an AI key.

---

## How it stays safe

```
 You sign the rules  ──►  The guard checks  ──►  PayPal pays
 PIN / Face ID            plain code, no AI       Orders · Vault · Refunds · Payouts
 Ed25519 mandate          before every call
          │                       │                        │
          └──────────── Black Box: hash-chained record of every step ───────────┘
```

| Piece | File | Role |
|---|---|---|
| Signed mandates | `src/core/mandate.ts` | Ed25519-signs the user's structured rules; any edit breaks the signature. |
| Policy guard | `src/core/guard.ts` | Checks signature, expiry, merchant, required/allowed attributes, avoided words, price, quantity, balance, kill switch, daily limit, and "ask above" for bills. **No AI.** |
| Black Box | `src/core/recorder.ts` | Append-only, hash-chained log; `verify()` finds the first altered entry. |
| Arbiter | `src/core/arbiter.ts` | Compares mandate, agent claim, page snapshot and delivery to decide merchant fault, agent fault or unclear instruction. |
| Signatures | `src/app/auth.ts` | 4-digit PIN (scrypt, rate-limited) or WebAuthn verified server-side (ES256 / Ed25519 / RS256). |
| Subscriptions and bills | `src/bills/` | Recurring pockets, simulated merchant catalog, charges through the guard, alerts and proof. |

**Prompt-injection proof by design:** the guard checks the agent's *claim* against the signed rules, not the agent's reasoning. The demo store (`/store`) contains listings with hidden instructions ("order quantity 4", "pre-approved $49 plan") and a mislabelled size. All of them are blocked, and the reason is recorded.

---

## Try it (judges)

1. Open https://paypal-pocket.onrender.com, sign up with any email and password, and create a 4-digit PIN. (The free Render instance may take about 30 s to wake.)
2. **Subscriptions:**
   - On Home, tap **"We found 7 automatic payments"**, then **Add all**, and confirm with your PIN.
   - Open **Netflix**, then tap **Next month (demo)**. The $22.99 charge is held against the $15.49 cap.
   - Tap **See the record**, then **Approve** with your PIN. The charge is paid through the PayPal sandbox.
3. **Shopping:**
   - Go to Agents, tap **+**, choose **One-time hunt**, and enter "Winter jacket, size M, under $150, Northline or FrostPeak".
   - Open **/store** in a new tab and send the agent to **FrostPeak**: it's blocked by the size rule.
   - Send it to **Northline**: it waits for your approval.
   - Try **AirPulse** or **CardPro** in *naive* mode: the hidden instructions are blocked.
4. Go to **Activity**, then **Black Box**, to see every decision with a verified hash chain.

---

## Run it locally

**Requirements:** Node 20+ (developed on Node 24) and a PayPal developer account with **US** sandbox accounts.

```bash
git clone https://github.com/AstrixDj13/Agentic_Paypal.git
cd Agentic_Paypal
npm install
cp .env.example .env                       # fill in at least the PayPal sandbox credentials
npm run build                              # builds the web app into web/dist
npm run dev                                # API + app on http://localhost:8787
```

To work on the frontend with hot reload, also run `npm run dev:web`. That starts Vite on http://localhost:5173 and proxies to the API.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | **yes** | Sandbox REST app (the demo store's business account). |
| `SANDBOX_BUYER_EMAIL` | yes | Sandbox personal (buyer) account; receives payouts. |
| `PAYPAL_VAULT_ID` | recommended | A vaulted payment token, so new accounts start already connected (otherwise each user taps "Connect PayPal"). |
| `COVER_POOL_CLIENT_ID`, `COVER_POOL_CLIENT_SECRET` | optional | Second sandbox app for Agent Cover Pool payouts (falls back to the main app). |
| `ANTHROPIC_API_KEY` | optional | Claude. Without it, rule-based fallbacks are used. `AI_MODEL` overrides the model. |
| `AI_PROVIDER`, `AI_API_KEY` | optional | Alternative free providers (gemini, groq, openrouter). |
| `CHANNEL3_API_KEY` | optional | Real product search; without it only the built-in demo store is used. |
| `DATABASE_URL` | optional | PostgreSQL (we use Neon). Without it, a local JSON file with a single user is used. |
| `STORAGE_MODE` | optional | Set to `file` to force the JSON-file mode. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | optional | Web Push keys (`npx web-push generate-vapid-keys`); generated automatically if unset. |
| `PUBLIC_URL` | optional | Public base URL, used for PayPal return links and as the Web Push contact. |
| `PORT` | optional | Defaults to 8787. |

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API server with reload (serves the built app). |
| `npm run dev:web` | Vite dev server for the frontend. |
| `npm run build` | Builds the web app. |
| `npm test` | 57 unit tests (guard, recorder, arbiter, agents, routine, bills, intel). |
| `npm run typecheck` | TypeScript check. |
| `npm run spike` | Sandbox capability check for your PayPal app. |
| `npm run e2e` | End-to-end run against the sandbox. |

### Deploy (Render)

This is a Node web service:
- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`

Set the environment variables above in the Render dashboard. We deploy from `main`, and pushes auto-deploy.

---

## Tech stack

| Area | Tools |
|---|---|
| Backend | Node 24, TypeScript, Express, tsx, node:test |
| Frontend | React 18, Vite, react-router; installable PWA with a service worker and Web Push |
| Data | PostgreSQL on Neon, per-user state, live updates over Server-Sent Events |
| Payments | PayPal REST APIs (sandbox): OAuth, Vault v3, Orders v2, Refunds, Payouts |
| AI | Claude (Anthropic) and Channel3 |
| Security | Ed25519 signed mandates, WebAuthn, scrypt PINs, hash-chained ledger |
| Hosting | Render |
| Extras | `extension/` (optional browser extension that lets Pocket learn what you browse, with the user in control) |

### Tools used while building
- **Claude Code** (Anthropic) as our coding assistant.
- **Kokoro-82M** (open-source text-to-speech, run locally) for the demo video's voice-over.

---

## Project structure

```
src/
  core/      mandate (Ed25519), guard (policy), recorder (Black Box), arbiter, formatting
  paypal/    REST client: OAuth, Vault, Orders, Refunds, Payouts
  ai/        Claude client with deterministic fallbacks
  agent/     rule parsing, agent choice, chat brain
  app/       services: agents, purchases, chat, accounts, auth, state
  bills/     subscriptions and bills (recurring pockets, simulated merchants)
  grocery/   weekly groceries, right-now meals, nearby shops (simulated)
  store/     demo merchant "Stride Supply" + Channel3 real-product search
  intel/     signals, suggestions, notifications, weekly check-in
  db/        PostgreSQL storage and per-user context
web/         React PWA (phone app, Black Box console, demo store at /store)
extension/   optional browser extension
test/        unit tests
```

## License

MIT, see [LICENSE](LICENSE).
