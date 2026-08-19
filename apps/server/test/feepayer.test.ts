// The fallback exists so a sponsor that has run out of SOL degrades to a
// working transaction instead of a failure. Two things must stay true: it never
// engages unless it was switched on, and when it does the response says so
// rather than letting the client keep believing the sponsor paid.
import { describe, expect, it } from 'vitest';
import {
  address,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { createMockRpc, mockTokenAccountFor } from '@disdk/verify/testing';
import { generateSponsorKeypair } from '@disdk/verify';
import { USDC_MINTS } from '@disdk/protocol';
import { createApi } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { createServices } from '../src/services.ts';
import type { Hono } from 'hono';

const MINT = address(USDC_MINTS['solana:devnet']);
const DELEGATE = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const BOT_SECRET = 'test-bot-secret';
const BALANCE = 1_000_000_000n;

/** Below the default floor (one token account's rent plus a few signatures). */
const DRY = 1_000n;
/** Comfortably above it. */
const FUNDED = 1_000_000_000n;

async function harness(envOverrides: Record<string, string> = {}, sponsorLamports?: bigint) {
  const sponsor = await generateSponsorKeypair();
  const config = await loadConfig({
    CLUSTER: 'solana:devnet',
    DELEGATE_PUBKEY: DELEGATE,
    SPONSOR_SECRET_KEY: sponsor.secretKeyBase64,
    BOT_API_SECRET: BOT_SECRET,
    APP_ORIGIN: 'http://localhost:5173',
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const mock = createMockRpc();
  const owner = await generateKeyPairSigner();
  await mockTokenAccountFor(mock, owner.address, MINT, BALANCE);
  if (sponsorLamports !== undefined) {
    mock.setLamports(config.sponsor.address, sponsorLamports);
  }

  const services = createServices(config, { rpc: mock.rpc });
  return { app: createApi(services), owner, config };
}

async function connect(app: Hono, owner: string) {
  const created = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
    body: JSON.stringify({ discord: { id: '1', username: 'tester' } }),
  });
  const { sessionId } = (await created.json()) as { sessionId: string };

  return app.request(`/api/sessions/${encodeURIComponent(sessionId)}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey: owner }),
  });
}

describe('fee payer fallback', () => {
  it('keeps the sponsor paying when it has SOL', async () => {
    const { app, owner, config } = await harness({ FEE_PAYER_FALLBACK: 'true' }, FUNDED);

    const body = (await (await connect(app, owner.address)).json()) as {
      feePayer: string;
      feePayerRole: string;
    };

    expect(body.feePayerRole).toBe('sponsor');
    expect(body.feePayer).toBe(config.sponsor.address);
  });

  it('moves the fee to the wallet when the sponsor is dry', async () => {
    const { app, owner } = await harness({ FEE_PAYER_FALLBACK: 'true' }, DRY);

    const body = (await (await connect(app, owner.address)).json()) as {
      feePayer: string;
      feePayerRole: string;
    };

    expect(body.feePayerRole).toBe('owner');
    expect(body.feePayer).toBe(owner.address);
  });

  // The premise of this SDK is that the user needs no SOL. A deployment that
  // never asked for the fallback must not start charging its users because the
  // sponsor happened to run low.
  it('lets the build fail rather than charging the user when the fallback is off', async () => {
    const { app, owner, config } = await harness({}, DRY);

    const body = (await (await connect(app, owner.address)).json()) as {
      feePayer: string;
      feePayerRole: string;
    };

    expect(body.feePayerRole).toBe('sponsor');
    expect(body.feePayer).toBe(config.sponsor.address);
  });

  it('respects a custom floor', async () => {
    // Sponsor holds more than the default floor but less than this one.
    const { app, owner } = await harness(
      { FEE_PAYER_FALLBACK: 'true', SPONSOR_MIN_LAMPORTS: '900000000000' },
      FUNDED,
    );

    const body = (await (await connect(app, owner.address)).json()) as { feePayerRole: string };
    expect(body.feePayerRole).toBe('owner');
  });

  it('publishes the sponsor on the session so the client can judge for itself', async () => {
    const { app, config } = await harness();
    const created = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
      body: JSON.stringify({ discord: { id: '1', username: 'tester' } }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const view = (await (
      await app.request(`/api/sessions/${encodeURIComponent(sessionId)}`)
    ).json()) as { sponsor: string };

    expect(view.sponsor).toBe(config.sponsor.address);
  });

  it('refuses a malformed sponsor floor at boot', async () => {
    await expect(harness({ SPONSOR_MIN_LAMPORTS: 'plenty' })).rejects.toThrow(
      /SPONSOR_MIN_LAMPORTS must be a whole number/i,
    );
  });
});

describe('priority fee', () => {
  const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

  /**
   * The programs a built transaction actually invokes, read out of the compiled
   * message. Checking the bytes rather than the config is the point: a priority
   * fee that is configured but never reaches the transaction buys nothing.
   */
  async function programsIn(app: Hono, owner: string): Promise<string[]> {
    const body = (await (await connect(app, owner)).json()) as { transaction: string };
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(body.transaction));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    return message.instructions.map(
      (ix) => message.staticAccounts[ix.programAddressIndex] as string,
    );
  }

  it('adds no ComputeBudget instruction when unconfigured', async () => {
    const { app, owner } = await harness();
    expect(await programsIn(app, owner.address)).not.toContain(COMPUTE_BUDGET);
  });

  it('puts the ComputeBudget instructions first when configured', async () => {
    const { app, owner } = await harness({
      PRIORITY_FEE_MICROLAMPORTS: '50000',
      COMPUTE_UNIT_LIMIT: '60000',
    });

    const programs = await programsIn(app, owner.address);

    // Both legs of the budget, and ahead of everything else — the runtime only
    // honours ComputeBudget instructions that precede the work they pay for.
    expect(programs[0]).toBe(COMPUTE_BUDGET);
    expect(programs[1]).toBe(COMPUTE_BUDGET);
    expect(programs.filter((p) => p === COMPUTE_BUDGET)).toHaveLength(2);
  });

  it('adds only the price instruction when no unit limit is set', async () => {
    const { app, owner } = await harness({ PRIORITY_FEE_MICROLAMPORTS: '50000' });

    const programs = await programsIn(app, owner.address);
    expect(programs.filter((p) => p === COMPUTE_BUDGET)).toHaveLength(1);
    expect(programs[0]).toBe(COMPUTE_BUDGET);
  });

  it('refuses a malformed priority fee at boot', async () => {
    await expect(harness({ PRIORITY_FEE_MICROLAMPORTS: 'fast' })).rejects.toThrow(
      /PRIORITY_FEE_MICROLAMPORTS must be a whole number/i,
    );
  });

  it('refuses an out-of-range compute unit limit at boot', async () => {
    await expect(harness({ COMPUTE_UNIT_LIMIT: '9999999' })).rejects.toThrow(
      /COMPUTE_UNIT_LIMIT must be a positive integer/i,
    );
  });

  it('accepts a configured priority fee and unit limit', async () => {
    const { config } = await harness({
      PRIORITY_FEE_MICROLAMPORTS: '50000',
      COMPUTE_UNIT_LIMIT: '60000',
    });
    expect(config.priorityFeeMicroLamports).toBe(50_000n);
    expect(config.computeUnitLimit).toBe(60_000);
  });
});
