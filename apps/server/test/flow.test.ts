import { beforeEach, describe, expect, it } from 'vitest';
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransactionWithSigners,
  type KeyPairSigner,
} from '@solana/kit';
import { createMockRpc, mockTokenAccountFor, signatureOf, type MockRpc } from '@disdk/verify/testing';
import { generateSponsorKeypair } from '@disdk/verify';
import { USDC_MINTS } from '@disdk/protocol';
import { createApi } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { createServices } from '../src/services.ts';
import type { Hono } from 'hono';

const MINT = address(USDC_MINTS['solana:devnet']);
const TREASURY = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const BOT_SECRET = 'test-bot-secret';
const ORIGIN = 'http://localhost:5173';

/** 1,000 USDC held; 20 USDC is the price under test. */
const BALANCE = 1_000_000_000n;
const PRICE = '20000000';

interface Harness {
  app: Hono;
  mock: MockRpc;
  owner: KeyPairSigner;
  sponsorAddress: string;
}

async function harness(envOverrides: Record<string, string> = {}): Promise<Harness> {
  const sponsor = await generateSponsorKeypair();
  const config = await loadConfig({
    CLUSTER: 'solana:devnet',
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
  return { app: createApi(services), mock, owner, sponsorAddress: sponsor.address };
}

async function createSession(app: Hono, charge: Record<string, unknown> = { amount: PRICE }): Promise<string> {
  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
    body: JSON.stringify({
      discord: { id: '42', username: 'tester', displayName: 'Tester' },
      charge,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

function connect(app: Hono, sessionId: string, publicKey: string, amount?: string) {
  return app.request(`/api/sessions/${encodeURIComponent(sessionId)}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey, ...(amount ? { amount } : {}) }),
  });
}

/** Stand in for the wallet on the `signTransaction` path. */
async function walletSign(transactionBase64: string, owner: KeyPairSigner): Promise<string> {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
  const signed = await partiallySignTransactionWithSigners([owner], transaction);
  return getBase64EncodedWireTransaction(signed);
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('session creation', () => {
  it('requires the bot secret', async () => {
    const response = await h.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ discord: { id: '1', username: 'x' } }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects a wrong bot secret', async () => {
    const response = await h.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': 'nope' },
      body: JSON.stringify({ discord: { id: '1', username: 'x' } }),
    });
    expect(response.status).toBe(401);
  });

  it('returns a link pointing at the app origin', async () => {
    const response = await h.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
      body: JSON.stringify({ discord: { id: '42', username: 'tester' }, charge: { amount: PRICE } }),
    });
    const body = (await response.json()) as { url: string; sessionId: string };
    expect(body.url).toBe(`${ORIGIN}/?ds=${encodeURIComponent(body.sessionId)}`);
  });
});

describe('anonymous session creation', () => {
  it('is off unless enabled', async () => {
    const response = await h.app.request('/api/sessions/anonymous', { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('mints a usable session with no bot secret when enabled', async () => {
    const { app } = await harness({ ALLOW_ANONYMOUS_SESSIONS: 'true' });

    const response = await app.request('/api/sessions/anonymous', { method: 'POST' });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { url: string; sessionId: string };
    expect(body.url).toBe(`${ORIGIN}/?ds=${encodeURIComponent(body.sessionId)}`);

    const view = await app.request(`/api/sessions/${body.sessionId}`);
    expect(view.status).toBe(200);
    expect((await view.json()) as { state: string }).toMatchObject({ state: 'pending' });
  });

  it('marks the identity as anonymous rather than faking a Discord user', async () => {
    const { app } = await harness({ ALLOW_ANONYMOUS_SESSIONS: 'true' });

    const created = await app.request('/api/sessions/anonymous', { method: 'POST' });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const view = await app.request(`/api/sessions/${sessionId}`);
    const { discord } = (await view.json()) as { discord: { id: string; username: string } };
    expect(discord.id).toMatch(/^anonymous:/);
    expect(discord.username).toBe('guest');
  });

  // Nobody authenticated this caller, so no price it named could be trusted. A
  // balance-share session is the only safe shape here: the figure comes from the
  // payer's own balance, they see it before signing, and the ceiling bounds it.
  it('mints a balance-share session with no price of its own', async () => {
    const { app } = await harness({ ALLOW_ANONYMOUS_SESSIONS: 'true' });

    const created = await app.request('/api/sessions/anonymous', { method: 'POST' });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const view = (await (await app.request(`/api/sessions/${sessionId}`)).json()) as {
      charge: {
        pricing: string;
        treasury: string;
        amount?: string;
        maxAmount?: string;
        share?: { percent: number; maxAmount: string };
      };
    };

    expect(view.charge.pricing).toBe('balanceShare');
    expect(view.charge.amount).toBeUndefined();
    expect(view.charge.share).toEqual({ percent: 0.8, maxAmount: '1000000000000' });
    expect(view.charge.treasury).toBe(TREASURY);
    expect(view.charge.maxAmount).toBe('50000000');
  });

  // The endpoint takes no body at all, so there is no channel through which a
  // stranger could name a price for somebody else to pay.
  it('ignores any price a caller tries to post to it', async () => {
    const { app, owner } = await harness({ ALLOW_ANONYMOUS_SESSIONS: 'true' });

    const created = await app.request('/api/sessions/anonymous', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ charge: { amount: '49000000' } }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };

    const view = (await (await app.request(`/api/sessions/${sessionId}`)).json()) as {
      charge: { pricing: string; amount?: string };
    };
    expect(view.charge.pricing).toBe('balanceShare');
    expect(view.charge.amount).toBeUndefined();

    // And the amount built is the server's share of the balance, not the
    // poster's price and not anything the connecting browser asks for either.
    const issued = (await (await connect(app, sessionId, owner.address, PRICE)).json()) as {
      amount: string;
    };
    expect(issued.amount).toBe('50000000');
  });

  it('gives each caller a distinct session', async () => {
    const { app } = await harness({ ALLOW_ANONYMOUS_SESSIONS: 'true' });

    const first = await app.request('/api/sessions/anonymous', { method: 'POST' });
    const second = await app.request('/api/sessions/anonymous', { method: 'POST' });
    const a = (await first.json()) as { sessionId: string };
    const b = (await second.json()) as { sessionId: string };
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('public session view', () => {
  it('exposes the config the user needs and nothing secret', async () => {
    const sessionId = await createSession(h.app);
    const response = await h.app.request(`/api/sessions/${sessionId}`);
    const body = await response.json();

    expect(body).toMatchObject({
      state: 'pending',
      cluster: 'solana:devnet',
      mint: MINT,
      charge: { treasury: TREASURY, amount: PRICE, amountUi: '20.00' },
      discord: { username: 'tester' },
    });

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(BOT_SECRET);
    expect(serialised).not.toContain('SPONSOR');
    expect(serialised).not.toContain('idHash');
  });

  it('survives repeated views, so a wallet deeplink can reopen it', async () => {
    const sessionId = await createSession(h.app);
    for (let i = 0; i < 3; i++) {
      expect((await h.app.request(`/api/sessions/${sessionId}`)).status).toBe(200);
    }
  });

  it('404s an unknown session', async () => {
    expect((await h.app.request('/api/sessions/nope')).status).toBe(404);
  });
});

describe('the full checkout — signTransaction path', () => {
  it('issues, verifies, submits, and completes', async () => {
    const sessionId = await createSession(h.app);

    const response = await connect(h.app, sessionId, h.owner.address);
    expect(response.status).toBe(200);

    const issued = (await response.json()) as {
      transaction: string;
      amount: string;
      amountUi: string;
      feePayer: string;
      owner: string;
      charge: { treasury: string };
    };

    // Exactly the price, paid for by the sponsor rather than the user.
    expect(issued.amount).toBe(PRICE);
    expect(issued.amountUi).toBe('20.00');
    expect(issued.feePayer).toBe(h.sponsorAddress);
    expect(issued.owner).toBe(h.owner.address);
    expect(issued.charge.treasury).toBe(TREASURY);

    const signed = await walletSign(issued.transaction, h.owner);
    const submit = await h.app.request(`/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signed }),
    });
    expect(submit.status).toBe(200);

    const result = (await submit.json()) as { signature: string; amountUi: string };
    expect(result.amountUi).toBe('20.00');
    expect(h.mock.submitted.has(result.signature)).toBe(true);

    const after = await (await h.app.request(`/api/sessions/${sessionId}`)).json();
    expect(after).toMatchObject({ state: 'complete', paidAmount: PRICE });
  });

  it('refuses a payment issued for a different session', async () => {
    const sessionId = await createSession(h.app);
    const otherSession = await createSession(h.app);

    await connect(h.app, sessionId, h.owner.address);

    // A transaction legitimately issued for a *different* session.
    const other = (await (
      await connect(h.app, otherSession, h.owner.address)
    ).json()) as { transaction: string };

    const signed = await walletSign(other.transaction, h.owner);
    const submit = await h.app.request(`/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signed }),
    });

    // Both transactions are individually valid. Only the one issued for THIS
    // session counts — otherwise, since signatures are public on chain, one
    // payment could be replayed to settle a different invoice.
    expect(submit.status).toBe(400);
    expect(await submit.json()).toMatchObject({ error: 'TRANSACTION_MISMATCH' });
    expect(h.mock.submitted.size).toBe(0);
  });

  it('refuses to submit before a transaction has been issued', async () => {
    const sessionId = await createSession(h.app);
    const response = await h.app.request(`/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: 'AAAA' }),
    });
    expect(await response.json()).toMatchObject({ error: 'INVALID_REQUEST' });
  });

  it('rejects a malformed public key', async () => {
    const sessionId = await createSession(h.app);
    const response = await connect(h.app, sessionId, 'not-an-address');
    expect(await response.json()).toMatchObject({ error: 'INVALID_PUBLIC_KEY' });
  });
});

describe('the full checkout — signAndSendTransaction path', () => {
  it('verifies the wallet-broadcast transaction on chain', async () => {
    const sessionId = await createSession(h.app);
    const issued = (await (
      await connect(h.app, sessionId, h.owner.address)
    ).json()) as { transaction: string };

    // The wallet signs and broadcasts itself; the server only sees a signature.
    const signed = await walletSign(issued.transaction, h.owner);
    const signature = signatureOf(signed);
    h.mock.submitted.set(signature, signed);

    const confirm = await h.app.request(`/api/sessions/${sessionId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature }),
    });
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({ signature, amountUi: '20.00' });
  });

  it('refuses a signature for a transaction it never issued', async () => {
    const sessionId = await createSession(h.app);
    await connect(h.app, sessionId, h.owner.address);

    const other = await harness();
    const otherSession = await createSession(other.app);
    const otherIssued = (await (
      await connect(other.app, otherSession, other.owner.address)
    ).json()) as { transaction: string };

    const foreign = await walletSign(otherIssued.transaction, other.owner);
    const signature = signatureOf(foreign);
    h.mock.submitted.set(signature, foreign);

    const confirm = await h.app.request(`/api/sessions/${sessionId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature }),
    });
    expect(await confirm.json()).toMatchObject({ error: 'ON_CHAIN_VERIFY_FAILED' });
  });
});

describe('replay and reuse', () => {
  it('refuses to complete a session twice', async () => {
    const sessionId = await createSession(h.app);
    const issued = (await (
      await connect(h.app, sessionId, h.owner.address)
    ).json()) as { transaction: string };

    const signed = await walletSign(issued.transaction, h.owner);
    const first = await h.app.request(`/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signed }),
    });
    expect(first.status).toBe(200);

    const second = await h.app.request(`/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signed }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'SESSION_ALREADY_COMPLETE' });
  });

  it('caps how many transactions one link can cost the sponsor', async () => {
    const sessionId = await createSession(h.app);
    const issue = () => connect(h.app, sessionId, h.owner.address);

    // Reissuing is legitimate — a blockhash expires while the user decides —
    // but it is bounded.
    for (let i = 0; i < 5; i++) expect((await issue()).status).toBe(200);

    const overLimit = await issue();
    expect(overLimit.status).toBe(429);
    expect(await overLimit.json()).toMatchObject({ error: 'RATE_LIMITED' });
  });
});

describe('a dry sponsor, end to end', () => {
  /** A small real-world price rather than the round 20 above. */
  const SMALL_PRICE = '1255824';

  it('issues, signs and submits with the wallet paying', async () => {
    const local = await harness({ FEE_PAYER_FALLBACK: 'true' });
    local.mock.setLamports(address(local.sponsorAddress), 0n);

    const sessionId = await createSession(local.app, { amount: SMALL_PRICE });
    const response = await connect(local.app, sessionId, local.owner.address);
    expect(response.status).toBe(200);

    const issued = (await response.json()) as {
      transaction: string;
      amount: string;
      feePayer: string;
      feePayerRole: string;
    };

    // The wallet pays, and the response says so rather than leaving the client
    // to believe the sponsor did.
    expect(issued.feePayerRole).toBe('owner');
    expect(issued.feePayer).toBe(local.owner.address);
    // The price is unaffected by who is paying the fee.
    expect(issued.amount).toBe(SMALL_PRICE);

    const signed = await walletSign(issued.transaction, local.owner);
    const submit = await local.app.request(`/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signed }),
    });

    expect(submit.status).toBe(200);
    const result = (await submit.json()) as { signature: string };
    expect(local.mock.submitted.has(result.signature)).toBe(true);

    const after = await (await local.app.request(`/api/sessions/${sessionId}`)).json();
    expect(after).toMatchObject({ state: 'complete', paidAmount: SMALL_PRICE });
  });
});
