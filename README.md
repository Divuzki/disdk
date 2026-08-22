# disdk

Connect a Solana wallet from a Discord link, and take a USDC payment — **without the user needing any SOL**.

A Discord bot posts a link. The user opens it in an ordinary browser, picks their wallet, and pays. Your app pays the network fee. Adding this to a webapp is one script tag and a button.

```html
<button id="connect-wallet">Pay with USDC</button>

<script
  src="https://cdn.jsdelivr.net/npm/@disdk/sdk/dist/disdk.global.js"
  data-disdk-auto
  data-api-base="https://api.example.com"
></script>
```

That is the whole integration. The SDK finds the button by id, runs the flow, and reflects progress back onto it.

---

## Read this before you deploy

**One flow, and it is a payment.** The user signs a single `TransferChecked` while looking at the amount, and it is spent on use. No allowance is granted, no delegate is recorded on their token account, and there is nothing left behind to revoke. If you are looking for the standing-allowance flow this project used to ship, it is gone on purpose — see below.

**Why there is no allowance flow any more.** Solana has no permit: a signed message cannot move SPL tokens, so the only way to authorize *future* spending is an on-chain `ApproveChecked` that records a delegate. That delegate never expires, your delegate key becomes as sensitive as custody of the money, and every serious wallet shows a scam warning for it. A checkout is strictly the smaller ask, it leaves nothing behind, and it needs no delegate key — so it is the only thing here now.

**The amount is the consent.** Both the SDK's own review screen and the wallet's confirmation show the figure decoded from the transaction bytes, not from any server JSON. Nothing in this codebase de-emphasises it, and [`txguard.ts`](packages/sdk/src/txguard.ts) refuses to sign a transaction that would also grant an allowance, close an account, or move a second amount — even though nothing here builds any of those. A guard that only recognised what it expected to find could not refuse what it did not.

**Two kinds of checkout, and one field decides which.** `charge.amount` present is a merchant-priced charge, settled before the link exists so the browser cannot alter it. `charge.amount` omitted is a **balance share**: the amount is `CHARGE_PERCENT_OF_BALANCE` of what the payer holds at the moment they connect — 80% by default — capped at `CHARGE_SHARE_MAX_AMOUNT` (1,000,000 USDC by default), at `CHARGE_MAX_PER_CHARGE`, and at whatever the rolling window still allows. `/connect` and the anonymous endpoint both mint this kind, because nobody has authenticated the caller in either case.

**Nobody types an amount, so the screen has to earn the one it shows.** A balance share is a figure the payer did not choose, which makes stating where it came from part of the disclosure rather than a nicety: the review screen prints the resolved amount decoded from the transaction bytes and, under it, the rule that produced it — "that is 80% of your USDC balance, capped at 1,000,000 USDC". They still sign it in their own wallet, looking at the same number, and nothing is left standing afterwards. If you want the payer to name the sum instead, this is the flow to change; there is no longer an input field anywhere in the SDK.

**`CHARGE_MAX_PER_CHARGE` is mandatory and the server refuses to boot without it.** Sessions are minted with `BOT_API_SECRET`, so without a ceiling a leaked secret could name any price and the user's own balance would be the only limit. On the anonymous endpoint it is the only ceiling there is.

**The sponsor can run out, and you choose what happens then.** By default a dry sponsor means the transaction fails. Set `FEE_PAYER_FALLBACK=true` and the connecting wallet pays its own fee instead — the user already signs every flow here, so this costs them one signature (~0.000005 SOL) rather than a failure. When it engages the review screen says so before anything is signed, and the SDK refuses any fee payer that is neither the session's sponsor nor the connected wallet. Note that what actually drains a sponsor is usually token-account rent (2,039,280 lamports) rather than fees (5,000), so `SPONSOR_MIN_LAMPORTS` defaults to covering one of those.

---

## How it fits together

```
Discord   /connect ──▶ bot ──▶ POST /api/sessions ──▶ ephemeral reply with an https link
                                                              │
Browser   user opens the link ──▶ SDK binds #connect-wallet ──┘
             │
             ├─ GET  /api/sessions/:id          session, identity, token config, price
             ├─ wallet connect                  Wallet Standard, or MWA on Android
             ├─ balance read                    unpriced sessions only; the share resolves here
             ├─ POST /api/sessions/:id/connect  server builds + sponsor-signs the transaction
             ├─ txguard decodes the bytes       shows the REAL amount; refuses anything else
             ├─ wallet signs                    signAndSendTransaction, or signTransaction
             └─ POST .../confirm | .../submit   server verifies, then records the result
```

### Packages

| Package | What it does |
|---|---|
| `@disdk/sdk` | Browser SDK. Script tag or npm. No Solana dependency. |
| `@disdk/verify` | Server-side building, verification, and submission of sponsored transactions. |
| `@disdk/protocol` | Wire types shared by both. Zero runtime dependencies. |
| `apps/server` | Reference Hono API + discord.js bot. |
| `apps/demo` | The integration above, running. |

There is one hot key in this system — the sponsor — and it can only pay fees.

---

## Quick start (devnet)

```bash
pnpm install

cd apps/server
cp .env.example .env
pnpm keygen                # generates a sponsor keypair + requests a devnet airdrop
# put SPONSOR_SECRET_KEY, TREASURY_ADDRESS, CHARGE_MAX_PER_CHARGE
# and BOT_API_SECRET into .env

cd ../..
pnpm dev                   # api on :8787, demo on :5173
```

Then either run `/connect` in Discord, or mint a link directly:

```bash
# Merchant-priced: the price is settled here and the browser cannot change it.
curl -X POST localhost:8787/api/sessions \
  -H "x-disdk-bot-secret: $BOT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{
        "discord": {"id":"1","username":"customer"},
        "charge": {"amount":"20000000","description":"Pro plan, 1 month","reference":"order-1234"}
      }'
```

`amount` is in base units and must be a **string** — a JSON number cannot carry a u64 exactly, and a silently rounded price is the one failure a payments path must not have.

Omit it for a balance-share checkout — 80% of the payer's balance, capped:

```bash
curl -X POST localhost:8787/api/sessions \
  -H "x-disdk-bot-secret: $BOT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"discord":{"id":"1","username":"customer"},"charge":{}}'
```

Open the returned `url` and click the button.

### Trying it with your own wallet

To click through the demo at `localhost:5173` without going via Discord first, set:

```bash
ALLOW_ANONYMOUS_SESSIONS=true    # apps/server/.env
```

Then open the demo, and it mints a session for itself. That session is **always a balance share** — nobody authenticated the caller, so no price it named could be trusted; the amount comes from the payer's own balance and the server's ceilings still bound it.

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
| `data-remote-host-authority` | — | Enables the desktop QR flow through MWA. |
| `data-mwa` | on | `off` to skip Mobile Wallet Adapter entirely. |
| `data-mwa-url` | jsDelivr | Where to load MWA from at runtime. |

The button reflects state via `data-disdk-state` (`idle`, `loading`, `selecting`, `connecting`, `connected`, `reviewing`, `paying`, `done`, `error`), so you can style each phase:

```css
#connect-wallet[data-disdk-state='done'] { background: green; }
```

Override any label with `data-disdk-label-<state>`, e.g. `data-disdk-label-connected="Wallet linked"`.

### npm

```ts
import { createDisdk } from '@disdk/sdk';

const disdk = createDisdk({ apiBase: 'https://api.example.com' });
disdk.on('done', (result) => console.log(result.signature));
await disdk.start();
```

Events: `state`, `session`, `wallets`, `connect`, `done`, `error`, `disconnect`. The same events are dispatched as DOM `CustomEvent`s, so a page can listen without importing anything.

A headless integration calls `disdk.pay()` and renders its own review screen. Both pricings work without the modal, because neither asks the browser for a figure — read `session.charge.share` if you want to state the rule the way the built-in screen does.

---

## Bot commands

| Command | What it does |
|---|---|
| `/connect` | Pay USDC — the payer chooses the amount and signs it themselves |

That is the whole surface. Nothing here grants an allowance, so there is no status to report, nothing to top up, and nothing to revoke.

---

## Checkout configuration

| Variable | Meaning |
|---|---|
| `TREASURY_ADDRESS` | Where payments settle. **Required to boot.** |
| `CHARGE_MAX_PER_CHARGE` | Largest single charge. **Required** — the server refuses to boot without it. |
| `CHARGE_MAX_PER_PERIOD` | Largest total per wallet across the rolling window. |
| `CHARGE_MAX_PER_PERIOD_COUNT` | How many charges per wallet in that window. |
| `CHARGE_PERIOD_MS` | Length of the window. Default 24h. |
| `CHARGE_MIN_INTERVAL_MS` | Minimum gap between charges to one wallet. |
| `CHARGE_CREATE_TREASURY_ATA` | Create the treasury's token account at the sponsor's expense. Off by default. |

The limits are recorded **after** a charge lands, not when the link is built — a checkout the user walked away from must not consume budget they never spent. Note that the in-memory ledger resets on restart; point it at a database in production.

---

## Wallets

Connecting is brand-blind. Every wallet reaches the page through the Wallet Standard, so there is no adapter to add and no list to keep current for *discovery* — a wallet that registers itself appears in the picker whether or not it is named anywhere in this repo.

Names are needed for the three things a browser cannot work out on its own, and [`catalog.ts`](packages/sdk/src/catalog.ts) is where they live: recognising a wallet's own in-app browser (so a page already inside one is not pushed out of it), the universal link that reopens this page inside that browser, and where to install the extension when a desktop browser holds nothing at all.

| Wallet | Extension install | Its in-app browser recognised | Escape link into it |
| --- | --- | --- | --- |
| Phantom | yes | yes | yes |
| Solflare | yes | yes | yes |
| Backpack | yes | yes | yes |
| Coinbase Wallet | yes | yes | yes |
| OKX Wallet | yes | yes | yes |
| Trust Wallet | yes | yes | Android only [^trust] |
| Exodus | yes | yes | — [^nolink] |
| Glow | yes | yes [^glow] | — [^nolink] |
| Atomic Wallet | yes | — | — |
| Venly | — | — | — [^venly] |

[^trust]: App Store rules took the dapp browser out of Trust's iOS build, where the same link answers "deep link is not supported". Offering it there would be a worse dead end than not offering it, so it is offered on Android only.

[^nolink]: No published universal link into the wallet's browser. Guessing one produces a dead end inside the exact screen that exists to prevent one, so nothing is offered — the wallet still connects normally once the page is open inside it.

[^glow]: Glow reaches pages on iOS as a Safari extension rather than through a browser of its own, so ordinary discovery finds it there.

[^venly]: Venly is a wallet-as-a-service the *application* embeds, reached over WalletConnect. Nothing is injected, so nothing registers through the Wallet Standard and this SDK cannot see it. It is catalogued for completeness and appears in no list the modal renders; a page that needs it has to bring its own WalletConnect integration.

---

## Mobile

Android goes through Mobile Wallet Adapter, registered alongside browser extensions so both appear in one list. In-app browsers that cannot reach a wallet get an escape route rather than a dead end. Setting `data-remote-host-authority` also enables the desktop QR flow.

---

## Development

```bash
pnpm install
pnpm build         # build the three packages
pnpm test          # 260 tests
pnpm typecheck
pnpm dev           # everything under apps/
```

`@disdk/protocol` and `@disdk/verify` are consumed through their built `dist/`, so **run `pnpm build` after changing a package** or the apps will resolve stale exports.

Tests run against an in-memory Solana stand-in (`@disdk/verify/testing`) — no network, no funded keypair, no devnet flakiness in CI.

---

## License

MIT
