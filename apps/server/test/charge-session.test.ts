import { describe, expect, it } from 'vitest';
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransactionWithSigners,
  type KeyPairSigner,
} from '@solana/kit';
import { createMockRpc, mockTokenAccountFor, type MockRpc } from '@disdk/verify/testing';
import { deriveAta, generateSponsorKeypair } from '@disdk/verify';
import { USDC_MINTS } from '@disdk/protocol';
import { createApi } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { createServices } from '../src/services.ts';
import type { Hono } from 'hono';

const MINT = address(USDC_MINTS['solana:devnet']);
const DELEGATE = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const TREASURY = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const BOT_SECRET = 'test-bot-secret';
const ORIGIN = 'http://localhost:5173';
const MERCHANT_ID = '4004';

/** 1,000 USDC held; 20 USDC is the default price under test. */
const BALANCE = 1_000_000_000n;
const PRICE = '20000000';

interface Harness {
  app: Hono;
  mock: MockRpc;
  owner: KeyPairSigner;
  config: Awaited<ReturnType<typeof loadConfig>>;
}

async function harness(envOverrides: Record<string, string> = {}): Promise<Harness> {
  const sponsor = await generateSponsorKeypair();
  const config = await loadConfig({
    CLUSTER: 'solana:devnet',
    DELEGATE_PUBKEY: DELEGATE,
    SPONSOR_SECRET_KEY: sponsor.secretKeyBase64,
    BOT_API_SECRET: BOT_SECRET,
    APP_ORIGIN: ORIGIN,
    TREASURY_ADDRESS: TREASURY,
    CHARGE_MAX_PER_CHARGE: '50000000',
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const mock = createMockRpc();
  const owner = await generateKeyPairSigner();
  await mockTokenAccountFor(mock, owner.address, MINT, BALANCE);
  await mockTokenAccountFor(mock, TREASURY, MINT, 0n);

  const services = createServices(config, { rpc: mock.rpc });
  return { app: createApi(services), mock, owner, config };
}

async function createCharge(
  app: Hono,
  charge: Record<string, unknown> | undefined,
  discordId = MERCHANT_ID,
): Promise<Response> {
  return app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
    body: JSON.stringify({
      discord: { id: discordId, username: 'merchant' },
      intent: 'charge',
      ...(charge ? { charge } : {}),
    }),
  });
}

async function sessionId(app: Hono, charge: Record<string, unknown> = { amount: PRICE }) {
  const response = await createCharge(app, charge);
  expect(response.status).toBe(201);
  return (await readJson<{ sessionId: string }>(response)).sessionId;
}

async function connect(app: Hono, id: string, publicKey: string): Promise<Response> {
  return app.request(`/api/sessions/${encodeURIComponent(id)}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
}

async function walletSign(transactionBase64: string, owner: KeyPairSigner): Promise<string> {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
  const signed = await partiallySignTransactionWithSigners([owner], transaction);
  return getBase64EncodedWireTransaction(signed);
}

/**
 * Response bodies here are asserted field by field rather than typed against
 * the protocol, so one cast at the read keeps the assertions readable.
 */
async function readJson<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Run a whole checkout to completion and return the submit response. */
async function pay(h: Harness, id: string): Promise<Response> {
  const issued = await connect(h.app, id, h.owner.address);
  expect(issued.status).toBe(200);
  const { transaction } = await readJson<{ transaction: string }>(issued);

  return h.app.request(`/api/sessions/${encodeURIComponent(id)}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedTransaction: await walletSign(transaction, h.owner) }),
  });
}

describe('charge configuration', () => {
  it('leaves the feature off when no treasury is configured', async () => {
    const h = await harness({ TREASURY_ADDRESS: '' });
    const response = await createCharge(h.app, { amount: PRICE });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  // Without a per-charge ceiling the only bound on a charge is the user's
  // balance, so a leaked bot secret could name any price. Refusing to boot is
  // the difference between a limit someone forgot and a limit that never was.
  it('refuses to boot with a treasury but no per-charge ceiling', async () => {
    const sponsor = await generateSponsorKeypair();
    await expect(
      loadConfig({
        CLUSTER: 'solana:devnet',
        DELEGATE_PUBKEY: DELEGATE,
        SPONSOR_SECRET_KEY: sponsor.secretKeyBase64,
        BOT_API_SECRET: BOT_SECRET,
        TREASURY_ADDRESS: TREASURY,
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/CHARGE_MAX_PER_CHARGE is required/i);
  });

  it('refuses a per-charge limit above the period limit', async () => {
    await expect(
      harness({ CHARGE_MAX_PER_CHARGE: '50000000', CHARGE_MAX_PER_PERIOD: '10000000' }),
    ).rejects.toThrow(/can never be reached/i);
  });

  it('still serves ordinary permit sessions while checkout is enabled', async () => {
    const h = await harness();
    const response = await h.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
      body: JSON.stringify({ discord: { id: '1', username: 'user' }, intent: 'permit' }),
    });

    expect(response.status).toBe(201);
  });
});

describe('charge session creation', () => {
  it('requires the bot secret', async () => {
    const h = await harness();
    const response = await h.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        discord: { id: MERCHANT_ID, username: 'merchant' },
        intent: 'charge',
        charge: { amount: PRICE },
      }),
    });

    expect(response.status).toBe(401);
  });

  it('requires an amount', async () => {
    const h = await harness();
    const response = await createCharge(h.app, undefined);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'INVALID_REQUEST' });
  });

  it('refuses a zero amount', async () => {
    const h = await harness();
    const response = await createCharge(h.app, { amount: '0' });

    expect(response.status).toBe(400);
  });

  // A JSON number cannot carry a u64 exactly, and rounding a price is the one
  // failure a payments path must never do quietly.
  it('refuses an amount sent as a JSON number', async () => {
    const h = await harness();
    const response = await createCharge(h.app, { amount: 20000000 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'INVALID_REQUEST' });
  });

  it('refuses a non-integer amount', async () => {
    const h = await harness();
    expect((await createCharge(h.app, { amount: '20.5' })).status).toBe(400);
  });

  // Rejected while the merchant is still the one making the call, rather than
  // in front of the customer they would otherwise have sent the link to.
  it('refuses a price above the per-charge ceiling at creation time', async () => {
    const h = await harness();
    const response = await createCharge(h.app, { amount: '60000000' });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: 'CHARGE_REFUSED' });
  });

  it('refuses an over-long reference', async () => {
    const h = await harness();
    const response = await createCharge(h.app, { amount: PRICE, reference: 'x'.repeat(200) });

    expect(response.status).toBe(400);
  });
});

describe('charge session view', () => {
  it('publishes the price the merchant fixed', async () => {
    const h = await harness();
    const id = await sessionId(h.app, {
      amount: PRICE,
      description: 'Pro plan, 1 month',
      reference: 'order-1234',
    });

    const view = await readJson(await h.app.request(`/api/sessions/${encodeURIComponent(id)}`));

    expect(view.intent).toBe('charge');
    expect(view.charge).toMatchObject({
      treasury: TREASURY,
      amount: PRICE,
      amountUi: '20.00',
      description: 'Pro plan, 1 month',
      reference: 'order-1234',
    });
  });

  it('does not attach charge details to an ordinary permit session', async () => {
    const h = await harness();
    const created = await h.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
      body: JSON.stringify({ discord: { id: '1', username: 'user' }, intent: 'permit' }),
    });
    const { sessionId: id } = await readJson<{ sessionId: string }>(created);

    const view = await readJson(await h.app.request(`/api/sessions/${encodeURIComponent(id)}`));
    expect(view.charge).toBeUndefined();
  });
});

describe('charge checkout', () => {
  it('issues a transfer for exactly the price, to the configured treasury', async () => {
    const h = await harness();
    const id = await sessionId(h.app);

    const response = await connect(h.app, id, h.owner.address);
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.amount).toBe(PRICE);
    expect(body.amountUi).toBe('20.00');
    expect(body.charge.treasury).toBe(TREASURY);
    expect(body.charge.destination).toBe(await deriveAta(TREASURY, MINT));
  });

  // The browser sends only a public key. There is no field it could put a
  // price in, which is the property that makes the review screen meaningful.
  it('ignores any amount the browser tries to supply', async () => {
    const h = await harness();
    const id = await sessionId(h.app);

    const response = await h.app.request(`/api/sessions/${encodeURIComponent(id)}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: h.owner.address, amount: '999000000', charge: { amount: '999000000' } }),
    });

    expect((await readJson(response)).amount).toBe(PRICE);
  });

  it('completes and reports the signature', async () => {
    const h = await harness();
    const id = await sessionId(h.app);

    const response = await pay(h, id);
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.signature).toBeTruthy();
    expect(body.amount).toBe(PRICE);
  });

  it('marks the session complete and refuses a second use', async () => {
    const h = await harness();
    const id = await sessionId(h.app);
    expect((await pay(h, id)).status).toBe(200);

    const again = await connect(h.app, id, h.owner.address);
    expect(again.status).toBe(409);
  });

  it('refuses a wallet that cannot cover the price', async () => {
    const h = await harness();
    const id = await sessionId(h.app);
    const poor = await generateKeyPairSigner();
    await mockTokenAccountFor(h.mock, poor.address, MINT, 1n);

    const response = await connect(h.app, id, poor.address);
    expect(await response.json()).toMatchObject({ error: 'INSUFFICIENT_BALANCE' });
  });

  it('refuses a wallet with no token account at all', async () => {
    const h = await harness();
    const id = await sessionId(h.app);
    const stranger = await generateKeyPairSigner();

    const response = await connect(h.app, id, stranger.address);
    expect(await response.json()).toMatchObject({ error: 'INSUFFICIENT_BALANCE' });
  });
});

describe('charge terms', () => {
  it('enforces the number of charges per period', async () => {
    const h = await harness({ CHARGE_MAX_PER_PERIOD_COUNT: '2' });

    expect((await pay(h, await sessionId(h.app))).status).toBe(200);
    expect((await pay(h, await sessionId(h.app))).status).toBe(200);

    const third = await connect(h.app, await sessionId(h.app), h.owner.address);
    expect(third.status).toBe(402);
    expect(await third.json()).toMatchObject({ error: 'CHARGE_REFUSED' });
  });

  it('enforces the total per period', async () => {
    const h = await harness({
      CHARGE_MAX_PER_CHARGE: '20000000',
      CHARGE_MAX_PER_PERIOD: '30000000',
    });

    expect((await pay(h, await sessionId(h.app))).status).toBe(200);

    // 20 spent, 30 allowed — a second 20 would take it to 40.
    const second = await connect(h.app, await sessionId(h.app), h.owner.address);
    expect(second.status).toBe(402);
    expect(await second.json()).toMatchObject({ error: 'CHARGE_REFUSED' });
  });

  it('enforces a minimum interval between charges to one wallet', async () => {
    const h = await harness({ CHARGE_MIN_INTERVAL_MS: '600000' });

    expect((await pay(h, await sessionId(h.app))).status).toBe(200);

    const second = await connect(h.app, await sessionId(h.app), h.owner.address);
    expect(second.status).toBe(402);
    expect(await second.json()).toMatchObject({ error: 'CHARGE_REFUSED' });
  });

  it('applies the limits per wallet, not globally', async () => {
    const h = await harness({ CHARGE_MAX_PER_PERIOD_COUNT: '1' });
    expect((await pay(h, await sessionId(h.app))).status).toBe(200);

    const other = await generateKeyPairSigner();
    await mockTokenAccountFor(h.mock, other.address, MINT, BALANCE);

    const response = await connect(h.app, await sessionId(h.app), other.address);
    expect(response.status).toBe(200);
  });

  // Nothing reaches the network until the user signs, so a checkout they walked
  // away from must not consume the budget they never spent.
  it('does not charge budget for a checkout that was never completed', async () => {
    const h = await harness({ CHARGE_MAX_PER_PERIOD_COUNT: '1' });

    // Issued, reviewed, abandoned.
    expect((await connect(h.app, await sessionId(h.app), h.owner.address)).status).toBe(200);

    // The one charge this wallet is allowed is still available.
    expect((await pay(h, await sessionId(h.app))).status).toBe(200);
  });

  it('still refuses a price above the ceiling at connect time', async () => {
    // Created while the ceiling was high, then connected against a server whose
    // terms are tighter — the build-time check is the boundary, not creation.
    const h = await harness({ CHARGE_MAX_PER_CHARGE: '50000000' });
    const id = await sessionId(h.app, { amount: '40000000' });

    const tight = await harness({ CHARGE_MAX_PER_CHARGE: '10000000' });
    expect((await createCharge(tight.app, { amount: '40000000' })).status).toBe(402);

    // The original server, with its own terms, still honours its own link.
    expect((await connect(h.app, id, h.owner.address)).status).toBe(200);
  });
});
