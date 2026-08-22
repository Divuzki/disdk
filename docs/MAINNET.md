# Running disdk locally against mainnet

A step-by-step setup for running the real thing on your own machine: real USDC, real SOL, mainnet RPC, no devnet and no mocks anywhere in the running system.

Everything here is checked against the code. Every environment variable named below is one `apps/server/src/config.ts` actually reads — nothing is aspirational.

> **This spends real money.** The sponsor pays a real network fee for every transaction it builds, and every completed checkout moves a user's real USDC to your treasury immediately and irreversibly. What it never does is leave a standing claim on anyone's wallet — see [What the flow actually does](#what-the-flow-actually-does).

---

## 1. What you need first

| | Why |
|---|---|
| Node 20+ and `pnpm` | `packageManager` is pinned to pnpm 10.33.0 |
| A funded Solana account for the **sponsor** | It pays every network fee. Needs SOL, not USDC. |
| An account for the **treasury** | Where payments settle. Only its public key goes in the env. |
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

### Four variables are mandatory

The server refuses to boot without them:

| Variable | What it is |
|---|---|
| `SPONSOR_SECRET_KEY` | Base64 secret key of the fee payer. A hot key. |
| `BOT_API_SECRET` | Shared secret for minting sessions. Any long random string. |
| `TREASURY_ADDRESS` | **Public** key where payments settle. Never a secret. |
| `CHARGE_MAX_PER_CHARGE` | Largest single charge, in base units. |

The last one is mandatory for a reason worth stating: sessions are minted with `BOT_API_SECRET`, so without a ceiling a leaked secret could name any price and the user's own balance would be the only limit.

---

## 3. Point it at mainnet, with an RPC that can keep up

```bash
CLUSTER=solana:mainnet
RPC_URL=https://your-endpoint.example.com
```

`CLUSTER` accepts exactly two values — `solana:mainnet` or `solana:devnet`. Setting it to mainnet also selects the real USDC mint automatically (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), so leave `USDC_MINT` unset unless you are deliberately using a different token.

**Do not ship on `api.mainnet-beta.solana.com`.** It is a public endpoint, aggressively rate-limited, and the first thing that will break under any real use. The code already turns a 429 into a clear retryable error (`withRpc` in `packages/verify/src/rpc.ts`), but that is damage control, not a fix. Get a dedicated endpoint from Helius, Triton, QuickNode, or Alchemy — any of them will do; what matters is that it is yours.

The server makes these RPC calls per connect: `getLatestBlockhash`, `getAccountInfo` for the payer's token account and the treasury's, plus `getBalance` if the fee-payer fallback is on. All at `confirmed` commitment.

### Priority fees — this is what "fast" means on mainnet

```bash
PRIORITY_FEE_MICROLAMPORTS=50000
COMPUTE_UNIT_LIMIT=60000
```

Both are unset by default, which means **no priority bid at all**. That is fine on devnet and a genuine liability on mainnet: under congestion a transaction with no bid can sit until its blockhash expires (~60–90 seconds) and the user just sees it fail.

Set both together. The bid is *per compute unit*, so the limit matters — the default 200,000 CU reservation is far more than these transactions use, and leaving it unset pays for headroom you never touch. A transfer fits comfortably in 60,000 CU. At 50,000 µlamports/CU that is roughly 0.000003 SOL of priority on top of the 5,000-lamport base fee.

Raise the bid when the network is busy. These are set once at boot, so a restart is how you change them.

---

## 4. Keys: there is one hot key, and it can only pay fees

The sponsor signs constantly and holds SOL. That is the only secret this server needs.

`TREASURY_ADDRESS` is a **public** key. The server never spends from it — it only names it as a transfer destination — so use an account this server has no key for. That is the whole point: a full compromise of this process cannot move money out of the treasury, only into it.

There is no delegate key anywhere in this system any more. The standing-allowance flow that needed one has been removed, so there is no custody-grade secret to protect, no `apps/charge` process, and nothing that can pull funds while a user is away.

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

The third row is the one that matters. Rent is roughly 400× a fee, and it is the reason sponsors run dry. A sponsor holding 0.1 SOL covers thousands of ordinary payments but only ~49 token-account creations — and it only creates one at all if you set `CHARGE_CREATE_TREASURY_ATA=true`.

---

## 5. Configure the checkout

```bash
TREASURY_ADDRESS=<where payments settle>
CHARGE_MAX_PER_CHARGE=50000000          # mandatory
CHARGE_MAX_PER_PERIOD=200000000
CHARGE_MAX_PER_PERIOD_COUNT=10
CHARGE_PERIOD_MS=86400000
CHARGE_MIN_INTERVAL_MS=5000
CHARGE_CREATE_TREASURY_ATA=false
```

The rolling-window limits are all per wallet. They are a product guarantee rather than a security boundary: this server enforces them, so they bound a buggy or compromised merchant integration, not somebody holding the sponsor key.

They are recorded **after** a charge lands, not when the link is built, so a checkout the user walked away from does not consume budget they never spent.

### Two kinds of checkout

`charge.amount` present on `POST /api/sessions` is **merchant-priced**: the price is settled before the link exists, and the browser cannot alter it. The server ignores any amount a later request supplies.

`charge.amount` omitted is a **balance share**: the amount is `CHARGE_PERCENT_OF_BALANCE` of what the payer holds when they connect — 80% by default — resolved server-side from the balance and capped at `CHARGE_SHARE_MAX_AMOUNT` (1,000,000 USDC by default), at `CHARGE_MAX_PER_CHARGE`, and at the room left in the rolling window. No figure is taken from the browser on either kind. Both `/connect` and the anonymous endpoint mint this kind, because nobody has authenticated the caller in either case.

On mainnet the share is the setting to look at hardest before you open the doors: it is the one number that decides how much a stranger's payment is, and it is not a number they chose. Set `CHARGE_MAX_PER_CHARGE` to what a single payment should really be worth to you — it caps the share as well — and lower `CHARGE_SHARE_MAX_AMOUNT` if 1,000,000 USDC is not a sum you ever intend to take in one transfer.

### Fee-payer fallback

```bash
FEE_PAYER_FALLBACK=false
# SPONSOR_MIN_LAMPORTS=
```

Off by default. On, a sponsor that has dropped below the floor hands the fee to the connecting wallet instead of failing. Leave it off if "you need no SOL" is a promise you are making to your users. When it engages, the review screen says the user is paying — and moves the fee and rent lines back into the primary summary, because they are now the user's money.

---

## 6. Discord (optional)

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_ROLE_ID=
```

Leave all of these blank and the bot stays disabled — you will see `[disdk] DISCORD_TOKEN/DISCORD_CLIENT_ID not set — bot disabled.` on boot. The HTTP API works fully without it.

There is exactly one command, `/connect`, and it mints a balance-share checkout link. Nothing about the flow requires Discord; the bot is a convenient way to hand somebody a link.

To run the demo without Discord at all:

```bash
ALLOW_ANONYMOUS_SESSIONS=true
```

The connect page then mints its own session. It proves nothing about who is asking, which is why it is opt-in — and why it is always a balance share.

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
[disdk] treasury (settles to) <address>
[disdk] terms: up to 50.00 USDC per charge…
```

If the cluster line does not say what you expect, stop. If the treasury line is not the account you meant, stop.

Open **http://localhost:5173**.

---

## 8. Verify before you connect a real wallet

```bash
curl -s localhost:8787/health
# {"ok":true,"cluster":"solana:mainnet"}

# Mint a session and read back the exact terms the browser will be shown
curl -s -X POST localhost:8787/api/sessions \
  -H "x-disdk-bot-secret: $BOT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"discord":{"id":"1","username":"you"},"charge":{"amount":"1000000"}}'
```

Open the returned `url`. The page shows the live terms read from the server before you connect anything — the treasury, the amount, and who pays the fee. Check the treasury address against the one you meant.

Then check what the wallet itself shows. A correct checkout produces **no approval warning and no "up to" line** in Phantom, because the transaction carries a `TransferChecked` and nothing else. If you ever see a wallet warn about future withdrawals on this flow, stop and read the bytes — something is building an `ApproveChecked` that should not exist.

---

## What the flow actually does

| | Who signs | When | What is left behind |
|---|---|---|---|
| **Checkout** | The user | At the moment they pay | Nothing |

That is the entire table now. The user signs one transfer, for one amount, once. Nothing outlives it, which is why there is nothing to revoke afterwards and no `/revoke` command to run.

---

## Before you call this production

`pnpm dev` is a Vite dev server plus `node --watch`. It is right for local testing and wrong for a deployment. What still needs doing:

- **The session store is in memory.** Every session and every charge-limit ledger entry resets on restart. `CHARGE_MAX_PER_PERIOD` is not enforced across a restart. Point it at a database.
- **Serve the demo built**, not from Vite: `pnpm --filter @disdk/demo build`.
- **Real origin over HTTPS.** Set `APP_ORIGIN` and `CORS_ORIGINS` to it. Wallets warn harder on origins they do not recognise, and a cold domain gets warned about regardless.
- **Keep the treasury unspendable from here.** The server only ever names it as a destination; do not give this process a key for it.
- **Rate limits** are in-process only, so they reset on restart and do not coordinate across instances.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Config change did nothing | You edited `.env.example`. Edit `.env`. |
| Stale behaviour after editing a package | Run `pnpm build` — apps resolve `dist/`. |
| `429` / rate limit errors | Public RPC. Get a dedicated endpoint. |
| Transaction never lands | No priority fee. Set `PRIORITY_FEE_MICROLAMPORTS`. |
| `INSUFFICIENT_BALANCE` on a wallet holding USDC | Its token account may not exist yet, or the price exceeds the balance. |
| `The treasury … has no USDC token account` | Create it, or set `CHARGE_CREATE_TREASURY_ATA=true` to have the sponsor pay its rent. |
| Server refuses to boot | Read the message — every config error is thrown eagerly at boot with the variable named. |
| `intent must be charge` | An old integration is still sending `intent: "permit"`. There is one flow now. |
