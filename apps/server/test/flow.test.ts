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
const DELEGATE = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const BOT_SECRET = 'test-bot-secret';
const ORIGIN = 'http://localhost:5173';

/** 1,000 USDC. */
const BALANCE = 1_000_000_000n;

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
    DELEGATE_PUBKEY: DELEGATE,
    SPONSOR_SECRET_KEY: sponsor.secretKeyBase64,
    BOT_API_SECRET: BOT_SECRET,
    APP_ORIGIN: ORIGIN,
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const mock = createMockRpc();
  const owner = await generateKeyPairSigner();
  await mockTokenAccountFor(mock, owner.address, MINT, BALANCE);

  const services = createServices(config, { rpc: mock.rpc });
  return { app: createApi(services), mock, owner, sponsorAddress: sponsor.address };
}

async function createSession(app: Hono, intent = 'permit'): Promise<string> {
  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
    body: JSON.stringify({
      discord: { id: '42', username: 'tester', displayName: 'Tester' },
      intent,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { sessionId: string }).sessionId;
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
      body: JSON.stringify({ discord: { id: '42', username: 'tester' } }),
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
    expect((await view.json()) as { state: string }).toMatchObject({
      state: 'pending',
      intent: 'permit',
    });
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

  // The demo page renders these four fields before the user connects anything,
  // and the percentage it shows has to be the one the server will actually
  // build into the approval. Locked here because apps/demo is plain HTML with
  // no tests of its own.
  it('advertises the configured allowance policy to the connect page', async () => {
    const { app } = await harness({ ALLOW_ANONYMOUS_SESSIONS: 'true' });

    const created = await app.request('/api/sessions/anonymous', { method: 'POST' });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const view = (await (await app.request(`/api/sessions/${sessionId}`)).json()) as {
      allowanceDescription: string;
      mintSymbol: string;
      cluster: string;
      delegate: string;
    };

    expect(view.allowanceDescription).toBe('80% of your USDC balance');
    expect(view.mintSymbol).toBe('USDC');
    expect(view.cluster).toBe('solana:devnet');
    expect(view.delegate).toBe(DELEGATE);
  });

  it('follows APPROVE_PERCENT when it is reconfigured', async () => {
    const { app } = await harness({ ALLOW_ANONYMOUS_SESSIONS: 'true', APPROVE_PERCENT: '0.5' });

    const created = await app.request('/api/sessions/anonymous', { method: 'POST' });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const view = (await (await app.request(`/api/sessions/${sessionId}`)).json()) as {
      allowanceDescription: string;
    };

    expect(view.allowanceDescription).toBe('50% of your USDC balance');
  });

  // …and the number on the page is the number in the bytes. A policy string
  // that drifted from the built transaction would be worse than no string.
  it('approves exactly the advertised share of the balance', async () => {
    const { app, owner } = await harness({ ALLOW_ANONYMOUS_SESSIONS: 'true' });

    const created = await app.request('/api/sessions/anonymous', { method: 'POST' });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const issued = await app.request(`/api/sessions/${sessionId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: owner.address }),
    });
    const body = (await issued.json()) as { amount: string; amountUi: string };

    // 80% of the 1,000 USDC the harness funds.
    expect(body.amount).toBe((BALANCE * 8n / 10n).toString());
    expect(body.amountUi).toBe('800.00');
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
      delegate: DELEGATE,
      allowanceDescription: '80% of your USDC balance',
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

describe('the full permit flow — signTransaction path', () => {
  it('issues, verifies, submits, and completes', async () => {
    const sessionId = await createSession(h.app);

    const connect = await h.app.request(`/api/sessions/${sessionId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: h.owner.address }),
    });
    expect(connect.status).toBe(200);

    const issued = (await connect.json()) as {
      transaction: string;
      amount: string;
      amountUi: string;
      feePayer: string;
      owner: string;
    };

    // 80% of 1,000 USDC, paid for by the sponsor rather than the user.
    expect(issued.amount).toBe('800000000');
    expect(issued.amountUi).toBe('800.00');
    expect(issued.feePayer).toBe(h.sponsorAddress);
    expect(issued.owner).toBe(h.owner.address);

    const signed = await walletSign(issued.transaction, h.owner);
    const submit = await h.app.request(`/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signed }),
    });
    expect(submit.status).toBe(200);

    const result = (await submit.json()) as { signature: string; amountUi: string };
    expect(result.amountUi).toBe('800.00');
    expect(h.mock.submitted.has(result.signature)).toBe(true);

    const after = await (await h.app.request(`/api/sessions/${sessionId}`)).json();
    expect(after).toMatchObject({ state: 'complete', approvedAmount: '800000000' });
  });

  it('refuses an approval issued for a different session', async () => {
    const sessionId = await createSession(h.app);
    const otherSession = await createSession(h.app);

    await h.app.request(`/api/sessions/${sessionId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: h.owner.address }),
    });

    // A transaction legitimately issued for a *different* session.
    const other = (await (
      await h.app.request(`/api/sessions/${otherSession}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: h.owner.address }),
      })
    ).json()) as { transaction: string };

    const signed = await walletSign(other.transaction, h.owner);
    const submit = await h.app.request(`/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signed }),
    });

    // Both transactions are individually valid. Only the one issued for THIS
    // session counts — otherwise, since signatures are public on chain, anyone
    // could replay someone else's approval to bind that wallet to their own
    // Discord account.
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
    const response = await h.app.request(`/api/sessions/${sessionId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: 'not-an-address' }),
    });
    expect(await response.json()).toMatchObject({ error: 'INVALID_PUBLIC_KEY' });
  });
});

describe('the full permit flow — signAndSendTransaction path', () => {
  it('verifies the wallet-broadcast transaction on chain', async () => {
    const sessionId = await createSession(h.app);
    const issued = (await (
      await h.app.request(`/api/sessions/${sessionId}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: h.owner.address }),
      })
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
    expect(await confirm.json()).toMatchObject({ signature, amountUi: '800.00' });
  });

  it('refuses a signature for a transaction it never issued', async () => {
    const sessionId = await createSession(h.app);
    await h.app.request(`/api/sessions/${sessionId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: h.owner.address }),
    });

    const other = await harness();
    const otherSession = await createSession(other.app);
    const otherIssued = (await (
      await other.app.request(`/api/sessions/${otherSession}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: other.owner.address }),
      })
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
      await h.app.request(`/api/sessions/${sessionId}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: h.owner.address }),
      })
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
    const issue = () =>
      h.app.request(`/api/sessions/${sessionId}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: h.owner.address }),
      });

    // Reissuing is legitimate — a blockhash expires while the user decides —
    // but it is bounded.
    for (let i = 0; i < 5; i++) expect((await issue()).status).toBe(200);

    const overLimit = await issue();
    expect(overLimit.status).toBe(429);
    expect(await overLimit.json()).toMatchObject({ error: 'RATE_LIMITED' });
  });
});

describe('allowance policy', () => {
  it('honours a configured percentage', async () => {
    const custom = await harness({ APPROVE_PERCENT: '0.5' });
    const sessionId = await createSession(custom.app);
    const issued = (await (
      await custom.app.request(`/api/sessions/${sessionId}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: custom.owner.address }),
      })
    ).json()) as { amount: string };

    expect(issued.amount).toBe('500000000');
  });

  it('honours the unlimited strategy', async () => {
    const custom = await harness({ APPROVE_STRATEGY: 'unlimited' });
    const sessionId = await createSession(custom.app);
    const issued = (await (
      await custom.app.request(`/api/sessions/${sessionId}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: custom.owner.address }),
      })
    ).json()) as { amount: string; amountUi: string };

    expect(issued.amount).toBe('18446744073709551615');
    expect(issued.amountUi).toBe('Unlimited');
  });

  it('applies a maximum ceiling on top of the percentage', async () => {
    const custom = await harness({ APPROVE_MAX_AMOUNT: '100000000' });
    const sessionId = await createSession(custom.app);
    const issued = (await (
      await custom.app.request(`/api/sessions/${sessionId}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: custom.owner.address }),
      })
    ).json()) as { amount: string };

    expect(issued.amount).toBe('100000000');
  });

  it('reports an empty wallet rather than approving nothing', async () => {
    const empty = await harness();
    const stranger = await generateKeyPairSigner();
    const sessionId = await createSession(empty.app);

    const response = await empty.app.request(`/api/sessions/${sessionId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: stranger.address }),
    });
    expect(await response.json()).toMatchObject({ error: 'INSUFFICIENT_BALANCE' });
  });
});

describe('permit status', () => {
  it('requires a session', async () => {
    const response = await h.app.request(`/api/permits/${h.owner.address}`);
    expect(response.status).toBe(401);
  });

  it('reports no allowance before one is granted', async () => {
    const sessionId = await createSession(h.app);
    const response = await h.app.request(
      `/api/permits/${h.owner.address}?session=${encodeURIComponent(sessionId)}`,
    );
    expect(await response.json()).toMatchObject({ delegate: null, coverage: 0 });
  });

  it('flags an allowance a deposit has left behind', async () => {
    const sessionId = await createSession(h.app);
    // Approved 800 when the balance was 1,000; the balance is now 5,000.
    await mockTokenAccountFor(h.mock, h.owner.address, MINT, 5_000_000_000n, {
      delegate: DELEGATE,
      delegatedAmount: 800_000_000n,
    });

    const response = await h.app.request(
      `/api/permits/${h.owner.address}?session=${encodeURIComponent(sessionId)}`,
    );
    expect(await response.json()).toMatchObject({ delegate: DELEGATE, stale: true });
  });
});

/**
 * The fallback, carried all the way to a submitted transaction.
 *
 * Every other fee-payer test stops at the issued bytes, which is exactly where
 * this arrangement still looks fine: the interesting part is downstream, in
 * `verifySignedTransaction`, which looks up a signature under the fee payer's
 * address. With the sponsor paying, that address is the sponsor and its
 * signature is already there. With the owner paying, the sponsor never signs at
 * all — so an implementation that reached for the sponsor's slot would fail on
 * submit, after the user had approved in their wallet, which is the worst
 * possible place to discover it.
 */
describe('a dry sponsor, end to end', () => {
  /** A small real-world balance rather than the round 1,000 above. */
  const HELD = 1_569_780n;

  it('issues, signs and submits with the wallet paying', async () => {
    const local = await harness({ FEE_PAYER_FALLBACK: 'true' });
    local.mock.setLamports(address(local.sponsorAddress), 0n);
    await mockTokenAccountFor(local.mock, local.owner.address, MINT, HELD);

    const sessionId = await createSession(local.app);
    const connect = await local.app.request(`/api/sessions/${sessionId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: local.owner.address }),
    });
    expect(connect.status).toBe(200);

    const issued = (await connect.json()) as {
      transaction: string;
      amount: string;
      feePayer: string;
      feePayerRole: string;
    };

    // The wallet pays, and the response says so rather than leaving the client
    // to believe the sponsor did.
    expect(issued.feePayerRole).toBe('owner');
    expect(issued.feePayer).toBe(local.owner.address);
    // 80% of what the wallet holds, unaffected by who is paying the fee.
    expect(issued.amount).toBe('1255824');

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
    expect(after).toMatchObject({ state: 'complete', approvedAmount: '1255824' });
  });
});
