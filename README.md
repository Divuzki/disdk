# disdk

Connect a Solana wallet from a Discord link, and move USDC — **without the user needing any SOL**.

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

**Solana has no permit.** There is no EIP-2612 equivalent — a signed message cannot move SPL tokens. The only way to authorize *future* spending is an on-chain `ApproveChecked` instruction that records a *delegate* on the user's token account. disdk builds that transaction server-side with your sponsor keypair as fee payer and partially signs it; the wallet only adds the owner signature. That is why the user needs no SOL.

**An allowance is large and it never expires.** At the default setting a delegate can move 80% of the user's USDC at any time, until revoked. There is no on-chain expiry for an SPL delegate. Three consequences you should design around:

- Your delegate key is as sensitive as custody of that money. Keep it separate from the sponsor key, which is a hot key.
- Wallets know this pattern. Phantom and Solflare simulate approvals and will show a scam warning for a large delegation from a domain they do not recognize. The SDK counters this by showing the exact amount decoded from the transaction bytes, naming the delegate, and stating plainly that the approval persists — but a cold domain will still get warned about.
- `/revoke` ships on day one and is not optional. Users need a visible way out.

**A token account holds exactly one delegate.** Approving again *replaces* the previous delegate and amount rather than adding to it.

**The sponsor can run out, and you choose what happens then.** By default a dry sponsor means the transaction fails. Set `FEE_PAYER_FALLBACK=true` and the connecting wallet pays its own fee instead — the user already signs every flow here, so this costs them one signature (~0.000005 SOL) rather than a failure. It applies to **every** flow, `/connect` included, so leave it off if "you need no SOL" is a promise you are making to your users. When it engages the review screen says so before anything is signed, and the SDK refuses any fee payer that is neither the session's sponsor nor the connected wallet. Note that what actually drains a sponsor is usually token-account rent (2,039,280 lamports) rather than fees (5,000), so `SPONSOR_MIN_LAMPORTS` defaults to covering one of those.

**If you only need to be paid once, do not ask for an allowance at all.** Use [checkout](#checkout-user-signed-charges) instead. It is the smaller ask, it leaves nothing behind, and it needs no delegate key.

---

## Four flows, and what each one asks of the user

These are genuinely different things, and the difference is worth holding onto — most of the design in this repo follows from it.

| | Who signs | When | What is left behind |
|---|---|---|---|
| **Permit** | The user | Once, up front | A standing allowance, until revoked |
| **Charge** (pull) | Your delegate key | Later, user absent | The allowance, minus what you pulled |
| **Checkout** | The user | At the moment they pay | Nothing |
| **Sweep** | The user | Once, after being asked | Nothing |

A permit **moves no money by itself**. It is a permission. A checkout and a sweep move money immediately and there is nothing to revoke afterwards. A pull charge is the one that needs the permit to exist first.

Pick by whether the user can be in front of the screen. If they can, checkout is strictly less to ask for. If they cannot — a subscription renewing at 3am — you need the permit, and the user has to trust your delegate key.

---

## How it fits together

```
Discord   /connect ──▶ bot ──▶ POST /api/sessions ──▶ ephemeral reply with an https link
                                                              │
Browser   user opens the link ──▶ SDK binds #connect-wallet ──┘
             │
             ├─ GET  /api/sessions/:id          session, identity, token config, price
             ├─ wallet connect                  Wallet Standard, or MWA on Android
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
| `apps/server` | Reference Hono API + discord.js bot. Permits, revokes, sweeps, checkout. |
| `apps/charge` | The pull-payment service. Holds the delegate key; charges approved wallets. |
| `apps/demo` | The integration above, running. |

`apps/charge` is a **separate process on purpose**: it is the only thing here that holds the delegate secret. The session server never does.

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

### Trying it with your own wallet

To click through the demo at `localhost:5173` without going via Discord first, set:

```bash
ALLOW_ANONYMOUS_SESSIONS=true    # apps/server/.env
```

Then open the demo, and it mints a session for itself. The page shows the live policy — read from the server, not hardcoded — before you connect anything.

The share approved is configurable, and 80% is only the default:

```bash
APPROVE_STRATEGY=percentOfBalance
APPROVE_PERCENT=0.8              # 0.5 for half, 0.25 for a quarter…
```

Restart the server and the demo, the modal, and the signed transaction all move together, because all three read the same server-side config.

**What approving actually does.** It grants an allowance of that share to `DELEGATE_PUBKEY`. **No USDC moves.** It authorises the delegate to move up to that amount later. To then actually move it, use one of:

- **The sweep offer** — set `COLD_WALLET_PUBKEY` and, the moment an allowance is signed and lands, the page asks the user whether they also want to transfer `SWEEP_PERCENT` (default 0.8) of their balance to that address and close their empty accounts. `SWEEP_MAX_AMOUNT` puts a hard ceiling on top of whatever the strategy computes — the shipped default is `1000000000000`, i.e. 1,000,000 USDC — and the ceiling is named in the question. It does not use the allowance at all: the user signs the transfer themselves.
- **`apps/charge`** — the pull-payment service, which *does* use the allowance and runs while you are away.

The sweep is offered to everyone and started by nobody. Configuring it decides where funds would go and how much; whether any of it moves is answered per user, per session, after they have signed. There is no setting that makes it automatic — see [Sweep](#sweep-offered-after-signing-off-by-default).

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

The button reflects state via `data-disdk-state` (`idle`, `loading`, `selecting`, `connecting`, `connected`, `reviewing`, `permitting`, `done`, `error`), so you can style each phase:

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

Events: `state`, `session`, `wallets`, `connect`, `permit`, `done`, `error`, `disconnect`. The same events are dispatched as DOM `CustomEvent`s, so a page can listen without importing anything.

---

## Allowance sizing

Set on the server; the client cannot influence it.

| `APPROVE_STRATEGY` | Meaning |
|---|---|
| `percentOfBalance` | Approve this share of the balance right now. Goes stale on deposit. |
| `fixed` | Always `APPROVE_FIXED_AMOUNT` base units. |
| `unlimited` | `u64::MAX`. Covers future deposits, never goes stale, worst warning surface. |

An allowance is a fixed number recorded on the token account — it does not track the balance. `percentOfBalance` is therefore a snapshot, which is why `/topup` exists.

### Bot commands

| Command | What it does |
|---|---|
| `/connect` | Link a wallet and approve a USDC allowance |
| `/status` | Show the allowance currently granted from a wallet |
| `/topup` | Refresh the allowance to cover the current balance |
| `/revoke` | Revoke the allowance |
| `/pay` | Pay USDC to the treasury — the payer chooses the amount. Appears only when checkout is enabled |

There is no sweep command. A sweep is offered in the browser after an allowance is signed, and happens only if the user says yes there — see [Sweep](#sweep-offered-after-signing-off-by-default).

---

## Checkout (user-signed charges)

**Off by default.** Set `TREASURY_ADDRESS` to enable it.

A `charge` session asks the user to pay a specific price. They sign the transfer themselves, while looking at the amount, and your sponsor pays the network fee. No allowance is granted, none is required, and nothing is left behind to revoke.

Mint the link from your backend with the bot secret — this is the only place the price is set:

```bash
curl -X POST localhost:8787/api/sessions \
  -H "x-disdk-bot-secret: $BOT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{
        "discord": {"id":"1","username":"customer"},
        "intent": "charge",
        "charge": {"amount":"20000000","description":"Pro plan, 1 month","reference":"order-1234"}
      }'
```

`amount` is in base units and must be a **string** — a JSON number cannot carry a u64 exactly, and a silently rounded price is the one failure a payments path must not have. The browser never sends an amount; `/connect` reads it back off the session record.

### User-priced checkout — `/pay`

Omit `charge.amount` and you get the other kind: a checkout where the **payer** names the amount, on the review screen, before signing. The bot's `/pay` command mints exactly this — reachable by anyone, no operator allowlist, because the payer is authorising their own payment of their own funds and sees the amount before it is signed. It registers automatically whenever checkout is enabled.

```bash
# A user-priced session carries no price; the payer chooses it at pay time.
curl -X POST localhost:8787/api/sessions \
  -H "x-disdk-bot-secret: $BOT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"discord":{"id":"1","username":"customer"},"intent":"charge","charge":{}}'
```

The chosen amount travels with `/connect` (it is safe to accept from the browser here, unlike a merchant-named price), and is bounded server-side by exactly the same `CHARGE_MAX_PER_CHARGE` ceiling and per-wallet window as a merchant-priced charge. A merchant-priced session, by contrast, ignores any amount the browser tries to supply.

This is the checkout to reach for when you want *contributions* — a tip jar, a shared pool, pay-what-you-want — rather than a fixed price. It is deliberately **not** a sweep: it moves only the amount the payer typed, to your treasury, once. A sweep moves a share of whatever the wallet holds, which is why it is never priced up front and never starts without its own explicit answer (see [Sweep](#sweep-offered-after-signing-off-by-default)).

Configuration:

| Variable | Meaning |
|---|---|
| `TREASURY_ADDRESS` | Where charges settle. **Required to enable.** |
| `CHARGE_MAX_PER_CHARGE` | Largest single charge. **Required** — the server refuses to boot without it. |
| `CHARGE_MAX_PER_PERIOD` | Largest total per wallet across the rolling window. |
| `CHARGE_MAX_PER_PERIOD_COUNT` | How many charges per wallet in that window. |
| `CHARGE_PERIOD_MS` | Length of the window. Default 24h. |
| `CHARGE_MIN_INTERVAL_MS` | Minimum gap between charges to one wallet. |
| `CHARGE_CREATE_TREASURY_ATA` | Create the treasury's token account at the sponsor's expense. Off by default. |

The per-charge ceiling is mandatory because sessions are minted with `BOT_API_SECRET`. Without it, a leaked secret could name any price and the user's own balance would be the only limit.

The limits are recorded **after** a charge lands, not when the link is built — a checkout the user walked away from must not consume budget they never spent. Note that the in-memory ledger resets on restart; point it at a database in production.

---

## Charging an allowance (pull payments)

`apps/charge` is the other half: it holds the delegate key and charges wallets that have already approved one, while the user is absent.

```bash
cd apps/charge
cp .env.example .env       # DELEGATE_SECRET_KEY, MERCHANT_API_SECRET, TREASURY_ADDRESS
pnpm dev                   # :8788
```

```bash
curl -X POST localhost:8788/api/charges \
  -H "x-disdk-merchant-secret: $MERCHANT_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"wallet":"...","amount":"20000000","idempotencyKey":"order-1234"}'
```

The caller chooses the wallet and the amount. It does **not** choose where the money goes — the treasury is configuration — and it cannot exceed the configured terms. `GET /api/wallets/:wallet` reports what the allowance, the balance, and the terms would allow right now; `GET /api/terms` reports the policy itself.

These terms are a **product guarantee, not a security boundary**. They are enforced by the service holding the delegate key, so anyone who steals that key ignores all of them.

---

## Sweep (offered after signing, off by default)

Moves a configured share of a user's USDC to a fixed cold wallet, then closes their empty token accounts to reclaim rent.

**Leave `COLD_WALLET_PUBKEY` empty to disable it entirely.** That is the default. Setting it makes the sweep *offerable* to every user, immediately after their allowance is signed and lands — and offerable is all it makes it.

### How it is authorized

The user's answer is the authorization. There is nothing else.

1. They run `/connect` and approve their allowance as normal. Nothing about a sweep has happened.
2. The permit lands, and the same response that reports it carries the offer. The page shows what would move (the server's own policy description, ceiling included), the destination **in full**, that it is immediate and irreversible, and that declining changes nothing.
3. They answer. Declining ends the flow on the allowance they came for. Closing the modal, pressing Escape, or clicking away all count as declining — the transfer is reachable only by pressing the button that says so, and declining is the focused default.
4. Only on yes does the browser call `POST /api/sessions/:id/sweep/authorize`, whose body must be literally `{"consent": true}`. The server records the consent on the session **before** it will build anything.
5. Only then is the transfer built, and it still has to be signed in the wallet. Saying yes to the offer is not the last word.

Everything about that is enforced server-side, not just in the UI:

- `POST /api/sessions` **refuses `intent: "sweep"` outright**, bot secret or not. A sweep session cannot be created; it can only be authorized into existence by its own owner.
- `/connect` refuses to issue either sweep leg for a session with no recorded consent, so an intent alone is never enough.
- The consent is pinned to the wallet that signed the permit. A different wallet on the same link is refused.
- One answer buys one transfer. Once it has landed, the transfer leg will not be built again.

There is deliberately **no `/sweep` command and no `OPERATOR_DISCORD_IDS`**. Both answered "is this person allowed to sweep?", which a session could satisfy without anyone having asked the owner of the funds anything at all. The question that matters is whether that owner said yes, and no configuration can answer it for them.

It runs as **two transactions, not one**. Solana transactions are atomic, so bundling the transfer with the closes would let a single un-closeable dust account — Token-2022 extensions can reject `CloseAccount` even at zero balance — revert the fund transfer alongside it.

### If you are building your own UI

Headless integrations get a `sweepOffer` event and nothing else happens. The SDK never authorizes on its own; `disdk.authorizeSweep()` is the single entry point, and it exists to be wired to a deliberate choice in your own interface:

```js
disdk.on('sweepOffer', (offer) => {
  // offer.description, offer.destination, offer.rentDestination
  // Put your own screen up. Call disdk.authorizeSweep() only if they say yes.
});
```

**What this is not for:** it collects funds only from people who were asked and agreed, one wallet and one session at a time. Make the screen you show them an honest one — this is an irreversible transfer to an address they had no prior reason to expect, and the built-in modal states it that way for a reason.

---

## Mobile

Android goes through Mobile Wallet Adapter, registered alongside browser extensions so both appear in one list. In-app browsers that cannot reach a wallet get an escape route rather than a dead end. Setting `data-remote-host-authority` also enables the desktop QR flow.

---

## Development

```bash
pnpm install
pnpm build         # build the three packages
pnpm test          # 409 tests
pnpm typecheck
pnpm dev           # everything under apps/
```

`@disdk/protocol` and `@disdk/verify` are consumed through their built `dist/`, so **run `pnpm build` after changing a package** or the apps will resolve stale exports.

Tests run against an in-memory Solana stand-in (`@disdk/verify/testing`) — no network, no funded keypair, no devnet flakiness in CI.

---

## License

MIT
