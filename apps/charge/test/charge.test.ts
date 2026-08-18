import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { MemoryChargeLedger, generateSponsorKeypair } from '@disdk/verify';
import { createMockRpc, mockTokenAccountFor, type MockRpc } from '@disdk/verify/testing';
import { createApi } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { createServices } from '../src/services.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;
const MERCHANT_SECRET = 'merchant-secret-for-tests';
const usdc = (whole: number) => BigInt(whole) * 1_000_000n;

interface Harness {
  app: Hono;
  mock: MockRpc;
  payer: KeyPairSigner;
  treasury: Address;
  delegateAddress: Address;
}

/**
 * A wallet that has already approved this service, holding `balance` with
 * `allowance` delegated — the state every charge starts from.
 */
async function harness(
  envOverrides: Record<string, string> = {},
  account: { balance?: bigint; allowance?: bigint; delegate?: Address } = {},
): Promise<Harness> {
  const delegate = await generateSponsorKeypair();
  const treasuryOwner = await generateKeyPairSigner();

  const config = await loadConfig({
    CLUSTER: 'solana:mainnet',
    DELEGATE_SECRET_KEY: delegate.secretKeyBase64,
    MERCHANT_API_SECRET: MERCHANT_SECRET,
    TREASURY_ADDRESS: treasuryOwner.address,
    CHARGE_MAX_PER_CHARGE: '20000000',
    CHARGE_MAX_PER_PERIOD: '100000000',
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const mock = createMockRpc();
  const payer = await generateKeyPairSigner();

  await mockTokenAccountFor(mock, payer.address, MINT, account.balance ?? usdc(500), {
    delegate: account.delegate ?? (delegate.address as Address),
    delegatedAmount: account.allowance ?? usdc(400),
  });
  // The treasury must already hold a token account, as in a real deployment.
  await mockTokenAccountFor(mock, treasuryOwner.address, MINT, 0n);

  const services = createServices(config, { rpc: mock.rpc, ledger: new MemoryChargeLedger() });
  return {
    app: createApi(services),
    mock,
    payer,
    treasury: treasuryOwner.address,
    delegateAddress: delegate.address as Address,
  };
}

function post(app: Hono, path: string, body: unknown, secret = MERCHANT_SECRET) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-disdk-merchant-secret': secret },
    body: JSON.stringify(body),
  });
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('authentication', () => {
  it('refuses a charge with no merchant secret', async () => {
    const response = await h.app.request('/api/charges', { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('refuses a wrong merchant secret', async () => {
    const response = await post(h.app, '/api/charges', { wallet: h.payer.address, amount: '1' }, 'nope');
    expect(response.status).toBe(401);
  });

  it('leaves /health open so a load balancer can probe it', async () => {
    expect((await h.app.request('/health')).status).toBe(200);
  });
});

describe('charging an approved wallet', () => {
  it('moves the requested amount and reports where it went', async () => {
    const response = await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: usdc(15).toString(),
      reference: 'order-1',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(body.amountUi).toBe('15.00');
    expect(body.treasury).toBe(h.treasury);
    expect(body.reference).toBe('order-1');
    expect(body.signature).toBeTruthy();
    // 400 approved, 15 taken.
    expect(body.allowanceAfter).toBe(usdc(385).toString());
  });

  it('actually broadcasts the transaction', async () => {
    await post(h.app, '/api/charges', { wallet: h.payer.address, amount: usdc(1).toString() });
    expect(h.mock.submitted.size).toBe(1);
  });

  it('reports headroom before anything is charged', async () => {
    const response = await h.app.request(`/api/wallets/${h.payer.address}`, {
      headers: { 'x-disdk-merchant-secret': MERCHANT_SECRET },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.delegateIsUs).toBe(true);
    // Bounded by the 20 per-charge limit, not by the 400 allowance.
    expect(body.chargeable).toBe(usdc(20).toString());
  });
});

describe('the terms are enforced, not advisory', () => {
  it('refuses a charge above the per-charge limit', async () => {
    const response = await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: usdc(25).toString(),
    });
    expect(response.status).toBe(402);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'CHARGE_REFUSED',
    });
  });

  it('refuses once the period total is reached', async () => {
    const { app, payer } = await harness({
      CHARGE_MAX_PER_CHARGE: '20000000',
      CHARGE_MAX_PER_PERIOD: '30000000',
    });

    expect((await post(app, '/api/charges', { wallet: payer.address, amount: usdc(20).toString() })).status).toBe(200);
    const second = await post(app, '/api/charges', { wallet: payer.address, amount: usdc(20).toString() });
    expect(second.status).toBe(402);
  });

  it('refuses once the charge count is reached, whatever the amounts', async () => {
    const { app, payer } = await harness({ CHARGE_MAX_PER_PERIOD_COUNT: '1' });

    expect((await post(app, '/api/charges', { wallet: payer.address, amount: '1' })).status).toBe(200);
    expect((await post(app, '/api/charges', { wallet: payer.address, amount: '1' })).status).toBe(402);
  });

  it('refuses a second charge inside the minimum interval', async () => {
    const { app, payer } = await harness({ CHARGE_MIN_INTERVAL_MS: '600000' });

    expect((await post(app, '/api/charges', { wallet: payer.address, amount: '1' })).status).toBe(200);
    const second = await post(app, '/api/charges', { wallet: payer.address, amount: '1' });
    expect(second.status).toBe(402);
    expect(((await second.json()) as { message: string }).message).toMatch(/Too soon/);
  });

  it('never lets the caller choose the destination', async () => {
    const response = await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: usdc(1).toString(),
      treasury: 'Attacker1111111111111111111111111111111111',
      destination: 'Attacker1111111111111111111111111111111111',
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { treasury: string }).treasury).toBe(h.treasury);
  });
});

describe('what the chain says wins', () => {
  it('refuses when the allowance has been spent down to nothing', async () => {
    const { app, payer } = await harness({}, { balance: usdc(500), allowance: 0n });

    const response = await post(app, '/api/charges', {
      wallet: payer.address,
      amount: usdc(1).toString(),
    });
    expect(response.status).toBe(402);
    expect(((await response.json()) as { message: string }).message).toMatch(/remaining allowance/);
  });

  it('refuses when the allowance belongs to someone else', async () => {
    const other = await generateKeyPairSigner();
    const { app, payer } = await harness({}, { delegate: other.address });

    const response = await post(app, '/api/charges', {
      wallet: payer.address,
      amount: usdc(1).toString(),
    });
    expect(response.status).toBe(402);
    expect(((await response.json()) as { message: string }).message).toMatch(/belongs to/);
  });

  it('refuses when the allowance is smaller than the charge', async () => {
    const { app, payer } = await harness({}, { allowance: usdc(5) });

    const response = await post(app, '/api/charges', {
      wallet: payer.address,
      amount: usdc(10).toString(),
    });
    expect(response.status).toBe(402);
    expect(((await response.json()) as { message: string }).message).toMatch(/remaining allowance/);
  });

  it('refuses when the wallet cannot cover it, even with allowance to spare', async () => {
    const { app, payer } = await harness({}, { balance: usdc(2), allowance: usdc(400) });

    const response = await post(app, '/api/charges', {
      wallet: payer.address,
      amount: usdc(10).toString(),
    });
    expect(response.status).toBe(402);
    expect(((await response.json()) as { message: string }).message).toMatch(/holds/);
  });
});

describe('idempotency', () => {
  it('charges once when the same key is replayed', async () => {
    const key = 'invoice-42';
    const first = await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: usdc(5).toString(),
      idempotencyKey: key,
    });
    const second = await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: usdc(5).toString(),
      idempotencyKey: key,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(h.mock.submitted.size).toBe(1);
  });

  it('refuses to reuse a key for a different amount', async () => {
    const key = 'invoice-43';
    await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: usdc(5).toString(),
      idempotencyKey: key,
    });
    const response = await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: usdc(6).toString(),
      idempotencyKey: key,
    });

    expect(response.status).toBe(400);
  });
});

describe('amounts', () => {
  it('rejects a decimal, which would otherwise be read as base units', async () => {
    const response = await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: '1.5',
    });
    expect(response.status).toBe(400);
  });

  it('rejects a JSON number too large to be exact', async () => {
    const response = await post(h.app, '/api/charges', {
      wallet: h.payer.address,
      amount: 9_007_199_254_740_993,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a zero charge', async () => {
    const response = await post(h.app, '/api/charges', { wallet: h.payer.address, amount: '0' });
    expect(response.status).toBe(400);
  });

  it('rejects a wallet that is not an address', async () => {
    const response = await post(h.app, '/api/charges', { wallet: 'not-a-wallet', amount: '1' });
    expect(response.status).toBe(400);
  });
});
