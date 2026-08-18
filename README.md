# disdk

Connect a Solana wallet from a Discord link, and grant a USDC spending allowance — **without the user needing any SOL**.

A Discord bot posts a link. The user opens it in an ordinary browser, picks their wallet, and approves. Your app pays the network fee. Adding this to a webapp is one script tag and a button.

```html
<button id="connect-wallet">Connect Wallet</button>

<script
  src="https://cdn.jsdelivr.net/npm/@disdk/sdk/dist/disdk.global.js"
  data-disdk-auto
  data-api-base="https://api.example.com"
></script>
```

That is the whole integration. The SDK finds the button by id, runs the flow, and reflects progress back onto it.

---

## Read this before you deploy

**Solana has no permit.** There is no EIP-2612 equivalent — a signed message cannot move SPL tokens. The only way to authorize spending is an on-chain `ApproveChecked` instruction that records a *delegate* on the user's token account. disdk builds that transaction server-side with your sponsor keypair as fee payer and partially signs it; the wallet only adds the owner signature. That is why the user needs no SOL.

**The allowance is large and it never expires.** At the default setting a delegate can move 80% of the user's USDC at any time, until revoked. There is no on-chain expiry for an SPL delegate. Three consequences you should design around:

- Your delegate key is as sensitive as custody of that money. Keep it separate from the sponsor key, which is a hot key.
- Wallets know this pattern. Phantom and Solflare simulate approvals and will show a scam warning for a large delegation from a domain they do not recognize. The SDK counters this by showing the exact amount decoded from the transaction bytes, naming the delegate, and stating plainly that the approval persists — but a cold domain will still get warned about.
- `/revoke` ships on day one and is not optional. Users need a visible way out.

**A token account holds exactly one delegate.** Approving again *replaces* the previous delegate and amount rather than adding to it.

---

## How it fits together

```
Discord   /connect ──▶ bot ──▶ POST /api/sessions ──▶ ephemeral reply with an https link
                                                              │
Browser   user opens the link ──▶ SDK binds #connect-wallet ──┘
             │
             ├─ GET  /api/sessions/:id          session, Discord identity, token config
             ├─ wallet connect                  Wallet Standard, or MWA on Android
             ├─ POST /api/sessions/:id/connect  server builds + sponsor-signs the approval
             ├─ txguard decodes the bytes       shows the REAL amount; refuses anything else
             ├─ wallet signs                    signAndSendTransaction, or signTransaction
             └─ POST .../confirm | .../submit   server verifies, then records the link
```

### Packages

| Package | What it does |
|---|---|
| `@disdk/sdk` | Browser SDK. Script tag or npm. 13 KB gzipped, no Solana dependency. |
| `@disdk/verify` | Server-side building, verification, and submission of the sponsored approval. |
| `@disdk/protocol` | Wire types shared by both. Zero runtime dependencies. |
| `apps/server` | Reference Hono API + discord.js bot. |
| `apps/demo` | The integration above, running. |

---

## Quick start (devnet)

```bash
pnpm install

cd apps/server
cp .env.example .env
pnpm keygen                # generates a sponsor keypair + requests a devnet airdrop
# put SPONSOR_SECRET_KEY, DELEGATE_PUBKEY and BOT_API_SECRET into .env

cd ../..
pnpm dev                   # api on :8787, demo on :5173
```

Then either run `/connect` in Discord, or mint a link directly:

```bash
curl -X POST localhost:8787/api/sessions \
  -H "x-disdk-bot-secret: $BOT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"discord":{"id":"1","username":"you"}}'
```

Open the returned `url` and click the button.

---

## Integrating

### Script tag

Every option is a `data-` attribute on the script tag.

| Attribute | Default | Meaning |
|---|---|---|
| `data-disdk-auto` | — | Required, to auto-bind. Omit it to configure by hand. |
| `data-api-base` | — | **Required.** Your disdk server. |
| `data-selector` | `#connect-wallet, [data-disdk-connect]` | What to bind. |
| `data-session-param` | `ds` | URL parameter carrying the session id. |
| `data-session-id` | from URL | Pin a session explicitly. |
| `data-theme` | `auto` | `auto`, `light`, or `dark`. |
| `data-ui` | `modal` | `headless` to render your own UI. |
| `data-observe` | `true` | Keep binding buttons added later (for SPAs). |
| `data-mwa` | on | `off` to skip Mobile Wallet Adapter entirely. |
| `data-mwa-url` | jsDelivr | Where to load MWA from at runtime. |

The button reflects state via `data-disdk-state` (`idle`, `connecting`, `connected`, `reviewing`, `permitting`, `done`, `error`), so you can style each phase:

```css
#connect-wallet[data-disdk-state='done'] { background: green; }
```

Override any label with `data-disdk-label-<state>`, e.g. `data-disdk-label-connected="Wallet linked"`.

DOM events fire on the button and on `window`:

```js
addEventListener('disdk:connect', (e) => console.log(e.detail.publicKey));
addEventListener('disdk:done',    (e) => console.log(e.detail.amountUi, e.detail.explorerUrl));
addEventListener('disdk:error',   (e) => console.log(e.detail.code, e.detail.message));
```

### npm

```bash
npm install @disdk/sdk
```

```ts
import { createDisdk } from '@disdk/sdk';

const disdk = createDisdk({ apiBase: 'https://api.example.com', theme: 'auto' });

disdk.attach('#connect-wallet');          // or drive it yourself:
const { publicKey } = await disdk.connect();
const permit = await disdk.requestPermit();

disdk.on('state', (s) => console.log(s));
```

Pass `ui: 'headless'` to keep the wallet discovery, deeplink handling, transaction guard and signing negotiation while rendering your own interface. `listWallets()` and `connect(wallet)` are exposed for that.

---

## Allowance sizing

An SPL allowance is a fixed `u64`. It does **not** track the balance, so a percentage is resolved against the balance at approval time and goes stale as the user deposits more. That is what `/topup` is for.

```bash
APPROVE_STRATEGY=percentOfBalance   # default
APPROVE_PERCENT=0.8                 # default
```

| Strategy | Behaviour |
|---|---|
| `percentOfBalance` | Approve this share of the balance right now. Goes stale on deposit. |
| `fixed` | Always `APPROVE_FIXED_AMOUNT` base units. |
| `unlimited` | `u64::MAX`. Covers future deposits, never goes stale, worst warning surface. |

`APPROVE_MAX_AMOUNT` caps any strategy. An empty wallet is rejected with `INSUFFICIENT_BALANCE` rather than approving zero, so the sponsor never pays rent for nothing.

### Bot commands

`/connect` link a wallet · `/status` show the current allowance and its coverage · `/topup` re-approve against the current balance · `/revoke` clear the delegate.

`/sweep` is operator-only and off by default — see below.

---

## Sweep (operator-only, off by default)

Every other flow here grants a **revocable allowance**, which moves nothing by
itself. `/sweep` is different in kind: it **transfers funds immediately**, to a
cold wallet fixed in server config, and there is nothing to revoke afterwards.
It then closes empty token accounts to reclaim their rent.

**It is disabled unless `OPERATOR_DISCORD_IDS` is set**, and it is restricted to
exactly the Discord user IDs listed there. That restriction is not cosmetic:
`/connect` and `POST /api/sessions` are reachable by any Discord user in the
server, so without a hard operator check, wiring an automatic 80% transfer into
that flow would sweep *every other connecting user's* balance to the same cold
wallet. The allowlist is what makes the feature mean "consolidate my own funds"
rather than "drain whoever clicks".

Three checks, only two of which are security boundaries:

1. **`POST /api/sessions`** — rejects a `sweep` intent from a non-operator with
   `401` before any session exists. Holds even against a caller who bypasses the
   bot entirely with a valid `BOT_API_SECRET`, because the check is on
   `discord.id` in the body, not on how the request arrived.
2. **`POST /api/sessions/:id/connect`** — re-checked independently, so an
   operator removed from the allowlist cannot keep using a link minted while
   they were still on it.
3. **The `/sweep` command handler** — UX only. It produces an honest "not
   available to you" instead of a link that would fail later, and is trivially
   bypassed by calling the API directly. That is exactly why 1 and 2 do not
   depend on it.

A denied sweep **fails closed** — it is refused outright, never quietly
downgraded to a permit.

**Two transactions, not one.** The transfer and the closes are signed
separately. Solana transactions are atomic, so bundling them would mean a single
un-closeable dust account — Token-2022 accounts can carry extensions that reject
`CloseAccount` even at zero balance — reverts the fund transfer along with it.
Splitting the legs costs one extra signature and makes the consolidation
independent of any individual account's close-ability.

The client guard is stricter here than for a permit: `verifySweepTransfer`
refuses **any** approval instruction in a sweep. Hiding a fresh delegate
allowance inside a transaction the user has already decided to accept is the
classic drainer move — the transfer they reviewed completes, and the allowance
they never saw outlives it.

**Residual risk worth knowing.** `discord.id` is trusted because
`BOT_API_SECRET` is assumed to be held only by the real bot. If that secret
leaked, someone who also knew an operator's Discord ID (not secret — it is
visible in any server they post in) could force a sweep. The ceiling is lower
than a classic drainer, though: `COLD_WALLET_PUBKEY` is server config, not
attacker-supplied, so the worst case is an unwanted sweep to *your own already
configured* cold wallet, not redirection to an attacker address. Treat
`BOT_API_SECRET` as higher-sensitivity once this is on. `/sweep` also requires a
second explicit confirmation click in Discord before a link is generated.

---

## Security model

The sponsor's signature covers the compiled transaction message, so **a client cannot alter the delegate, mint, amount, or fee payer** — any change invalidates that signature and the network rejects the transaction. Everything below is defence layered on top of that.

- **The client chooses nothing that matters.** Mint, delegate, fee payer and allowance policy all come from server config. The client supplies only a public key.
- **The server verifies before broadcasting.** On the `signTransaction` path it checks the returned bytes are byte-identical to what it issued. On the `signAndSendTransaction` path — where the wallet broadcasts and the server never sees the bytes — it fetches the confirmed transaction and compares the on-chain message.
- **Each approval is bound to one session.** Two sessions for the same wallet would otherwise compile to identical transactions, and since signatures are public on chain, anyone could replay a stranger's approval into their own session to bind that wallet to their own Discord account. A per-session nonce is written as an SPL memo to prevent this.
- **The SDK does not trust the server's JSON.** `txguard` decodes the transaction itself and refuses to sign on a wrong delegate, mint, owner or decimals; an amount that disagrees with what was displayed; a smuggled transfer or burn; the unchecked `Approve` variant, which cannot confirm the token; (on a sweep) any approval at all, a redirected destination or rent destination, or a close of an account it was not shown; any program outside a narrow allowlist; or accounts hidden behind an address lookup table. The amount in the modal comes from those bytes.
- **Sessions are bearer tokens.** 32 bytes of CSPRNG, stored SHA-256 hashed, 10-minute TTL, single completion. Bot replies are ephemeral so a link never sits in a public channel. Sessions stay re-openable within their TTL, because a wallet deeplink reloads the same URL in a different browser.
- **Sponsor spend is bounded.** Per-session issue cap plus per-IP and per-Discord-user rate limits, because every issued transaction costs the sponsor a fee and a new token account costs rent.
- **`approveChecked`, never `approve`,** so the mint and decimals are verified on chain.

---

## Mobile

The link is an ordinary `https://` URL, so the normal path is a real browser: an extension wallet on desktop, or Mobile Wallet Adapter on Android, which registers into the same wallet list.

The exception is an embedded webview — Discord's, typically on iOS — where no wallet can ever inject itself. The SDK detects this and offers to reopen the page in a wallet's own browser (Phantom, Solflare, Backpack) or in Chrome on Android. The session id travels in the URL, so the flow resumes where it left off.

---

## Development

```bash
pnpm install
pnpm -r typecheck
pnpm -r test        # 144 tests, no network required
pnpm build
```

Tests run against an in-memory Solana stand-in (`@disdk/verify/testing`), so the whole protocol — issue, sign, verify, submit, confirm — is exercised in CI with no RPC and no funded keypair.

**Not covered by automated tests, and worth a manual pass before you ship:** a real devnet transaction landing on chain, and the Discord mobile deeplink path on iOS and Android. Both need credentials and network access that CI does not have.

## License

MIT
