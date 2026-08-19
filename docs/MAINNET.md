# Running disdk locally against mainnet

A step-by-step setup for running the real thing on your own machine: real USDC, real SOL, mainnet RPC, no devnet and no mocks anywhere in the running system.

Everything here is checked against the code. Every environment variable named below is one `apps/server/src/config.ts` actually reads — nothing is aspirational.

> **This spends real money.** The sponsor pays a real network fee for every transaction it builds. Depending on the flow you run, a user's approval can also grant a standing allowance over their real USDC. Read [What each flow actually does](#what-each-flow-actually-does) before you click anything.

---

## 1. What you need first

| | Why |
|---|---|
| Node 20+ and `pnpm` | `packageManager` is pinned to pnpm 10.33.0 |
| A funded Solana account for the **sponsor** | It pays every network fee. Needs SOL, not USDC. |
| A separate account for the **delegate** | Only its *public* key goes in the server env. See step 4. |
| A dedicated mainnet RPC endpoint | The public one will rate-limit you. See step 3. |
| A browser wallet (Phantom / Solflare / Backpack) | The thing you actually connect with |

```bash
git clone <your fork>
cd disdk
pnpm install
pnpm build          # required: apps consume packages through built dist/
```

`pnpm build` is not optional. `apps/server` and `apps/demo` import `@disdk/protocol` and `@disdk/verify` through their compiled `dist/`, so a fresh clone that skips it resolves nothing.

---

## 2. Create `apps/server/.env`

```bash
cp apps/server/.env.example apps/server/.env
```

`.env.example` is a **template and nothing else** — it is never read at runtime. Both server scripts load `.env` only:

```json
"dev":   "node --env-file-if-exists=.env --watch --experimental-strip-types src/main.ts",
"start": "node --env-file-if-exists=.env --experimental-strip-types src/main.ts"
```

If you edit `.env.example` and restart, nothing changes. Edit `.env`.

### Three variables are mandatory

The server refuses to boot without them (`required()` in `config.ts`):

| Variable | What it is |
|---|---|
| `SPONSOR_SECRET_KEY` | Base64 secret key of the fee payer. A hot key. |
| `DELEGATE_PUBKEY` | **Public** key that receives allowances. Never the secret. |
| `BOT_API_SECRET` | Shared secret for minting sessions. Any long random string. |

---

## 3. Point it at mainnet, with an RPC that can keep up

```bash
CLUSTER=solana:mainnet
RPC_URL=https://your-endpoint.example.com
```

`CLUSTER` accepts exactly two values — `solana:mainnet` or `solana:devnet`. Setting it to mainnet also selects the real USDC mint automatically (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), so leave `USDC_MINT` unset unless you are deliberately using a different token.

**Do not ship on `api.mainnet-beta.solana.com`.** It is a public endpoint, aggressively rate-limited, and the first thing that will break under any real use. The code already turns a 429 into a clear retryable error (`withRpc` in `packages/verify/src/rpc.ts`), but that is damage control, not a fix. Get a dedicated endpoint from Helius, Triton, QuickNode, or Alchemy — any of them will do; what matters is that it is yours.

The server makes these RPC calls per connect: `getLatestBlockhash`, `getAccountInfo` for the token account, plus `getBalance` if the fee-payer fallback is on, and `getTokenAccountsByOwner` on a sweep close leg. All at `confirmed` commitment.

### Priority fees — this is what "fast" means on mainnet

```bash
PRIORITY_FEE_MICROLAMPORTS=50000
COMPUTE_UNIT_LIMIT=60000
```

Both are unset by default, which means **no priority bid at all**. That is fine on devnet and a genuine liability on mainnet: under congestion a transaction with no bid can sit until its blockhash expires (~60–90 seconds) and the user just sees it fail.

Set both together. The bid is *per compute unit*, so the limit matters — the default 200,000 CU reservation is far more than these transactions use, and leaving it unset pays for headroom you never touch. A permit or transfer fits comfortably in 60,000 CU. At 50,000 µlamports/CU that is roughly 0.000003 SOL of priority on top of the 5,000-lamport base fee.

Raise the bid when the network is busy. These are set once at boot, so a restart is how you change them.

---

## 4. Decide who the delegate is — before you connect anything

`DELEGATE_PUBKEY` is the account that receives the standing allowance in a permit flow. **Whoever holds its secret key can move up to the approved amount of a connected user's USDC, at any time, until revoked.** SPL delegates have no on-chain expiry.

Two rules that follow from that:

- It must be an account **you control**. If you paste in a key you found somewhere, you are handing that party a claim on every wallet that connects.
- It must **not** be the same account as the sponsor. The sponsor is a hot key that signs constantly; the delegate is custody-grade. The server prints a warning if you set them to the same account, but it will not stop you.

Only the delegate's *secret* key is needed by `apps/charge`, which is a separate process for exactly this reason. The session server never sees it.

### Importing your sponsor key

```bash
cd apps/server
pnpm import-sponsor mainnet
```

It reads the secret from **stdin**, never argv, so it stays out of shell history and the process table. It accepts base58 (Phantom/Solflare export), a JSON byte array (`id.json` from `solana-keygen`), or base64, and writes `SPONSOR_SECRET_KEY` into `.env`.

`pnpm keygen` also exists but generates a *fresh, empty* keypair — useful on devnet where it also requests an airdrop, useless on mainnet where you need an already-funded account.

### How much SOL the sponsor needs

| Cost | Lamports |
|---|---|
| Base fee, per signature | 5,000 |
| Priority fee (at the settings above) | ~3,000 |
| **Creating one token account** | **2,039,280** |

The third row is the one that matters. Rent is roughly 400× a fee, and it is the reason sponsors run dry. A sponsor holding 0.1 SOL covers thousands of ordinary approvals but only ~49 token-account creations.

---

## 5. Choose your flow

Set the rest of `.env` according to what you actually want. **All three of these are off by default** and stay off unless you configure them.

### Permit — the default

```bash
APPROVE_STRATEGY=percentOfBalance
APPROVE_PERCENT=0.8
# APPROVE_MAX_AMOUNT=          # optional hard ceiling, base units
```

Connecting and approving grants a standing allowance. **No USDC moves.** `APPROVE_STRATEGY` accepts `percentOfBalance`, `fixed` (with `APPROVE_FIXED_AMOUNT`), or `unlimited`.

`unlimited` approves `u64::MAX` — it covers future deposits, never goes stale, and produces the worst wallet warning. Use it only deliberately.

### Checkout — user-signed one-off payment

```bash
TREASURY_ADDRESS=<where charges settle>
CHARGE_MAX_PER_CHARGE=50000000          # mandatory once treasury is set
CHARGE_MAX_PER_PERIOD=200000000
CHARGE_MAX_PER_PERIOD_COUNT=10
CHARGE_PERIOD_MS=86400000
CHARGE_MIN_INTERVAL_MS=5000
```

The per-charge ceiling is mandatory and the server refuses to boot without it, because sessions are minted with `BOT_API_SECRET` — a leaked secret could otherwise name any price and the user's own balance would be the only limit.

If you only need to be paid once, this is strictly the smaller ask than a permit. Nothing is left behind to revoke.

### Sweep — operator-only, moves funds now

```bash
OPERATOR_DISCORD_IDS=<your discord id>   # empty = feature does not exist
COLD_WALLET_PUBKEY=<fixed destination>
SWEEP_STRATEGY=percentOfBalance
SWEEP_PERCENT=0.8
SWEEP_MAX_AMOUNT=1000000000000           # 1,000,000 USDC ceiling
SWEEP_RENT_DESTINATION=cold
SWEEP_CLOSE_MAX_ACCOUNTS=15
```

Leaving `OPERATOR_DISCORD_IDS` empty disables it entirely, which is the default. It is gated on a server-side allowlist checked at session creation *and again* at issue time, because `/connect` is reachable by any Discord user — without that gate it would sweep every visitor's balance to your cold wallet.

`SWEEP_MAX_AMOUNT` is a hard ceiling on top of whatever the strategy computes, and it is named in the confirmation you read before signing.

### Fee-payer fallback

```bash
FEE_PAYER_FALLBACK=false
# SPONSOR_MIN_LAMPORTS=
```

Off by default. On, a sponsor that has dropped below the floor hands the fee to the connecting wallet instead of failing. It applies to **every** flow including ordinary `/connect`, so leave it off if "you need no SOL" is a promise you are making to your users. When it engages, the review screen says the user is paying before they sign.

---

## 6. Discord (optional)

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_ROLE_ID=
```

Leave all of these blank and the bot stays disabled — you will see `[disdk] DISCORD_TOKEN/DISCORD_CLIENT_ID not set — bot disabled.` on boot. The HTTP API works fully without it.

**`/sweep` and `/revoke` are bot commands.** With the bot off, you can still reach both over the API (see step 9), but there is no one-click revoke. Decide that before you approve anything.

To run the demo without Discord at all:

```bash
ALLOW_ANONYMOUS_SESSIONS=true
```

The connect page then mints its own session. It proves nothing about who is asking, which is why it is opt-in.

---

## 7. Run it

```bash
pnpm dev
```

Two processes: the API on `:8787` and the demo on `:5173`. Boot output tells you what you are pointed at — read it every time:

```
[disdk] api listening on http://localhost:8787
[disdk] cluster solana:mainnet, mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
[disdk] sponsor (fee payer) <address>
[disdk] delegate (spender)  <address>
[disdk] allowance policy: 80% of your USDC balance
```

If the cluster line does not say what you expect, stop.

Open **http://localhost:5173**.

---

## 8. Verify before you connect a real wallet

```bash
curl -s localhost:8787/health
# {"ok":true,"cluster":"solana:mainnet"}

# Mint a session and read back the exact policy the browser will be shown
curl -s -X POST localhost:8787/api/sessions \
  -H "x-disdk-bot-secret: $BOT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"discord":{"id":"1","username":"you"}}'
```

Open the returned `url`. The page shows the live policy read from the server before you connect anything — the delegate, the amount, and who pays the fee. Check the delegate address against the one you meant.

---

## 9. Revoking

Revoke is a session intent, so it works with or without the bot:

```bash
curl -X POST localhost:8787/api/sessions \
  -H "x-disdk-bot-secret: $BOT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"discord":{"id":"1","username":"you"},"intent":"revoke"}'
```

Open the link and sign. Have this ready **before** you approve an allowance, not after.

To see what a wallet has currently granted:

```bash
curl "localhost:8787/api/permits/<wallet>?session=<sessionId>"
```

---

## What each flow actually does

| | Who signs | When | What is left behind |
|---|---|---|---|
| **Permit** | The user | Once, up front | A standing allowance, until revoked |
| **Charge** (pull) | Your delegate key | Later, user absent | The allowance, minus what you pulled |
| **Checkout** | The user | At the moment they pay | Nothing |
| **Sweep** | The user (an operator) | Once, deliberately | Nothing |

A permit moves no money by itself. A checkout and a sweep move money immediately and there is nothing to revoke afterwards.

---

## Before you call this production

`pnpm dev` is a Vite dev server plus `node --watch`. It is right for local testing and wrong for a deployment. What still needs doing:

- **The session store is in memory.** Every session and every charge-limit ledger entry resets on restart. `CHARGE_MAX_PER_PERIOD` is not enforced across a restart. Point it at a database.
- **Serve the demo built**, not from Vite: `pnpm --filter @disdk/demo build`.
- **Real origin over HTTPS.** Set `APP_ORIGIN` and `CORS_ORIGINS` to it. Wallets warn harder on origins they do not recognise, and a cold domain gets warned about regardless.
- **Split the keys.** Sponsor is hot, delegate is custody. `apps/charge` is a separate process precisely so the session server never holds the delegate secret.
- **Rate limits** are in-process only, so they reset on restart and do not coordinate across instances.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Config change did nothing | You edited `.env.example`. Edit `.env`. |
| Stale behaviour after editing a package | Run `pnpm build` — apps resolve `dist/`. |
| `429` / rate limit errors | Public RPC. Get a dedicated endpoint. |
| Transaction never lands | No priority fee. Set `PRIORITY_FEE_MICROLAMPORTS`. |
| `INSUFFICIENT_BALANCE` on a wallet holding USDC | Its token account may not exist yet, or the sweep amount exceeds the balance. |
| Server refuses to boot | Read the message — every config error is thrown eagerly at boot with the variable named. |
| `/sweep` missing in Discord | `OPERATOR_DISCORD_IDS` empty, or `DISCORD_GUILD_ID` unset. |
| Wallet shows a scam warning on approval | Expected for a large delegation from an unrecognised origin. |
