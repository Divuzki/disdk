/**
 * The batch settlement, end to end, against a mock cluster.
 *
 * Deliberately built as a mirror of `flow.test.ts`: same harness shape, same
 * request sequence, same two completion paths. If the batch flow ever needs a
 * fundamentally different set of steps, that is worth noticing here rather than
 * discovering in the SDK.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransactionWithSigners,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { createMockRpc, signatureOf, type MockRpc } from '@disdk/verify/testing';
import { deriveAta, generateSponsorKeypair } from '@disdk/verify';
import { USDC_MINTS, type SettlementManifest } from '@disdk/protocol';
import { createApi } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { createServices } from '../src/services.ts';
import type { Hono } from 'hono';

const USDC = address(USDC_MINTS['solana:devnet']);
const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const DESTINATION = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const BOT_SECRET = 'test-bot-secret';
const ORIGIN = 'http://localhost:5173';

const OBLIGATIONS = [
  { type: 'spl', mint: USDC, amount: '25000000' },
  { type: 'spl', mint: BONK, amount: '1250000000' },
  { type: 'sol', amount: '2000000' },
];

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
    TREASURY_ADDRESS: DESTINATION,
    CHARGE_MAX_PER_CHARGE: '50000000',
    ENABLE_BATCH_SETTLEMENT: 'true',
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const mock = createMockRpc();
  const owner = await generateKeyPairSigner();

  mock.setMint(USDC, { decimals: 6 });
  mock.setMint(BONK, { decimals: 5 });

  await credit(mock, owner.address, USDC, 100_000_000n);
  await credit(mock, owner.address, BONK, 5_000_000_000n);
  await credit(mock, DESTINATION, USDC, 0n);
  await credit(mock, DESTINATION, BONK, 0n);
  mock.setLamports(owner.address, 1_000_000_000n);

  const services = createServices(config, { rpc: mock.rpc });
  return { app: createApi(services), mock, owner, sponsorAddress: sponsor.address };
}

async function credit(mock: MockRpc, owner: Address, mint: Address, amount: bigint) {
  mock.setTokenAccount(await deriveAta(owner, mint), { mint, owner, amount });
}

async function createSettlement(
  app: Hono,
  obligations: unknown[] = OBLIGATIONS,
  secret = BOT_SECRET,
): Promise<Response> {
  return app.request('/api/settlements', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': secret },
    body: JSON.stringify({
      discord: { id: '42', username: 'tester' },
      obligations,
      description: 'Campaign settlement',
    }),
  });
}

function connect(app: Hono, sessionId: string, publicKey: string) {
  return app.request(`/api/sessions/${encodeURIComponent(sessionId)}/settlement/connect`, {
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

interface Issued {
  sessionId: string;
  transaction: string;
  manifest: SettlementManifest;
  feePayer: string;
  feePayerRole: string;
  addressLookupTables: string[];
}

async function issue(h: Harness): Promise<Issued> {
  const created = await createSettlement(h.app);
  expect(created.status).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };

  const response = await connect(h.app, sessionId, h.owner.address);
  expect(response.status).toBe(200);
  return { sessionId, ...((await response.json()) as Omit<Issued, 'sessionId'>) };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('creating a settlement session', () => {
  it('requires the bot secret', async () => {
    const response = await createSettlement(h.app, OBLIGATIONS, 'wrong');
    expect(response.status).toBe(401);
  });

  it('refuses an empty settlement', async () => {
    const response = await createSettlement(h.app, []);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('INVALID_SETTLEMENT');
  });

  it('refuses a zero amount', async () => {
    const response = await createSettlement(h.app, [
      { type: 'spl', mint: USDC, amount: '0' },
    ]);
    expect(response.status).toBe(400);
  });

  it('refuses decimals that disagree with the mint', async () => {
    const response = await createSettlement(h.app, [
      { type: 'spl', mint: USDC, amount: '1000000', decimals: 9 },
    ]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('INVALID_SETTLEMENT');
  });

  it('is off unless the server opts in', async () => {
    const off = await harness({ ENABLE_BATCH_SETTLEMENT: 'false' });
    const response = await createSettlement(off.app);
    expect(response.status).toBe(400);
  });
});

describe('issuing the settlement transaction', () => {
  it('returns a manifest matching the configured destination', async () => {
    const issued = await issue(h);

    expect(issued.manifest.destination).toBe(DESTINATION);
    expect(issued.manifest.owner).toBe(h.owner.address);
    expect(issued.manifest.obligations).toHaveLength(3);
    expect(issued.manifest.manifestHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('fills in each mint\'s real decimals', async () => {
    const issued = await issue(h);
    const [usdc, bonk] = issued.manifest.obligations;

    expect(usdc).toMatchObject({ type: 'spl', mint: USDC, decimals: 6 });
    expect(bonk).toMatchObject({ type: 'spl', mint: BONK, decimals: 5 });
  });

  it('keeps the sponsor as the fee payer', async () => {
    const issued = await issue(h);

    expect(issued.feePayerRole).toBe('sponsor');
    expect(issued.feePayer).toBe(h.sponsorAddress);
    expect(issued.feePayer).not.toBe(h.owner.address);
  });

  it('uses no lookup table when the batch already fits', async () => {
    const issued = await issue(h);
    expect(issued.addressLookupTables).toEqual([]);
  });

  it('refuses to settle a wallet that cannot cover an obligation', async () => {
    const poor = await harness();
    await credit(poor.mock, poor.owner.address, USDC, 1n);

    const created = await createSettlement(poor.app);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const response = await connect(poor.app, sessionId, poor.owner.address);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('INSUFFICIENT_BALANCE');
  });

  it('refuses to issue against a charge session', async () => {
    const created = await h.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
      body: JSON.stringify({
        discord: { id: '42', username: 'tester' },
        charge: { amount: '20000000' },
      }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const response = await connect(h.app, sessionId, h.owner.address);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('INVALID_SETTLEMENT');
  });
});

describe('completing a settlement', () => {
  it('accepts the wallet-signed transaction and settles the session', async () => {
    const issued = await issue(h);
    const signed = await walletSign(issued.transaction, h.owner);

    const response = await h.app.request(
      `/api/sessions/${encodeURIComponent(issued.sessionId)}/settlement/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signedTransaction: signed }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      signature: string;
      settled: { amountUi: string }[];
    };
    expect(body.signature).toBeTruthy();
    expect(body.settled.map((s) => s.amountUi)).toEqual(['25.00', '12,500.00', '0.002']);

    const session = await h.app.request(`/api/sessions/${encodeURIComponent(issued.sessionId)}`);
    expect(((await session.json()) as { state: string }).state).toBe('complete');
  });

  it('accepts a wallet that broadcast the transaction itself', async () => {
    const issued = await issue(h);
    const signed = await walletSign(issued.transaction, h.owner);
    await h.mock.rpc.sendTransaction(signed as never, { encoding: 'base64' }).send();

    const response = await h.app.request(
      `/api/sessions/${encodeURIComponent(issued.sessionId)}/settlement/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signature: signatureOf(signed) }),
      },
    );

    expect(response.status).toBe(200);
  });

  it('refuses a transaction issued for a different session', async () => {
    const first = await issue(h);
    const second = await issue(h);
    const signed = await walletSign(second.transaction, h.owner);

    // Distinct sessions produce distinct bytes, so one cannot settle the other.
    expect(second.manifest.manifestHash).not.toBe(first.manifest.manifestHash);

    const response = await h.app.request(
      `/api/sessions/${encodeURIComponent(first.sessionId)}/settlement/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signedTransaction: signed }),
      },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('TRANSACTION_MISMATCH');
  });

  it('refuses a settlement that has already completed', async () => {
    const issued = await issue(h);
    const signed = await walletSign(issued.transaction, h.owner);
    const url = `/api/sessions/${encodeURIComponent(issued.sessionId)}/settlement/submit`;
    const body = JSON.stringify({ signedTransaction: signed });
    const headers = { 'content-type': 'application/json' };

    await h.app.request(url, { method: 'POST', headers, body });
    const again = await h.app.request(url, { method: 'POST', headers, body });

    expect(again.status).toBe(409);
  });

  it('leaves the single-charge flow untouched', async () => {
    // The same server still runs a charge end to end, unchanged.
    const created = await h.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
      body: JSON.stringify({
        discord: { id: '7', username: 'charger' },
        charge: { amount: '20000000' },
      }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const connected = await h.app.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/connect`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: h.owner.address }),
      },
    );
    expect(connected.status).toBe(200);

    const { transaction } = (await connected.json()) as { transaction: string };
    const signed = await walletSign(transaction, h.owner);

    const submitted = await h.app.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signedTransaction: signed }),
      },
    );
    expect(submitted.status).toBe(200);
  });
});
