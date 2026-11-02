# Agent Pocket + Black Box

A fenced-off PayPal wallet your AI agent can spend from, with buyer protection built in for when the agent gets it wrong.

**Rules decide, AI explains, PayPal pays.**

> Work in progress for the PayPal AI Hackathon (deadline Nov 12, 2026).

## What's built so far

| Part | File | What it does |
|---|---|---|
| Signed mandates | `src/core/mandate.ts` | Ed25519-signs the user's structured rules; any edit breaks the signature |
| Policy guard | `src/core/guard.ts` | Plain code (no AI) that checks every proposed order: signature, expiry, merchant, attributes, price, quantity, pocket balance, daily limit, kill switch |
| Flight recorder | `src/core/recorder.ts` | Append-only, hash-chained log; `verify()` finds the first tampered entry |
| Arbiter rules | `src/core/arbiter.ts` | Compares mandate / agent claim / page snapshot / delivered item to decide merchant at fault, agent at fault, or instruction unclear |
| PayPal client | `src/paypal/` | OAuth, Vault v3, Orders v2, Refunds, Payouts, Disputes, Webhooks |
| Sandbox spike | `scripts/sandbox-spike.ts` | Checks which PayPal capabilities the sandbox allows for our app |

## Run

```bash
npm install
npm test                 # 16 unit tests for guard, recorder, arbiter
cp .env.example .env     # fill in sandbox credentials
npm run spike            # sandbox capability check (opens the browser twice for approvals)
```

## License

MIT, see [LICENSE](LICENSE).
