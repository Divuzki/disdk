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
const COLD_WALLET = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const OTHER_MINT = address('So11111111111111111111111111111111111111112');
const BOT_SECRET = 'test-bot-secret';
const ORIGIN = 'http://localhost:5173';

const OPERATOR_ID = '1001';
const RANDOM_USER_ID = '2002';

/** 1,000 USDC. */
const BALANCE = 1_000_000_000n;

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
    OPERATOR_DISCORD_IDS: OPERATOR_ID,
    COLD_WALLET_PUBKEY: COLD_WALLET,
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const mock = createMockRpc();
  const owner = await generateKeyPairSigner();
  await mockTokenAccountFor(mock, owner.address, MINT, BALANCE);
  await mockTokenAccountFor(mock, owner.address, OTHER_MINT, 0n);

  const services = createServices(config, { rpc: mock.rpc });
  return { app: createApi(services), mock, owner, config };
}

async function createSession(app: Hono, discordId: string, intent: string): Promise<Response> {
  return app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-disdk-bot-secret': BOT_SECRET },
    body: JSON.stringify({
      discord: { id: discordId, username: 'tester', displayName: 'Tester' },
      intent,
    }),
  });
}

async function connect(
  app: Hono,
  sessionId: string,
  publicKey: string,
  leg?: string,
): Promise<Response> {
  return app.request(`/api/sessions/${encodeURIComponent(sessionId)}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey, ...(leg ? { leg } : {}) }),
  });
}

async function walletSign(transactionBase64: string, owner: KeyPairSigner): Promise<string> {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
  const signed = await partiallySignTransactionWithSigners([owner], transaction);
  return getBase64EncodedWireTransaction(signed);
}

describe('sweep authorization', () => {
  // The threat this allowlist exists for: /connect and POST /api/sessions are
  // reachable by any Discord user, so without a hard operator check every other
  // connecting user would also have their balance swept to the cold wallet.
  it('refuses a sweep session for a non-operator holding a valid bot secret', async () => {
    const { app } = await harness();
    const response = await createSession(app, RANDOM_USER_ID, 'sweep');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('still allows that same user an ordinary permit session', async () => {
    const { app } = await harness();
    const response = await createSession(app, RANDOM_USER_ID, 'permit');

    expect(response.status).toBe(201);
  });

  // A denied sweep must fail closed, never silently fall back to another intent.
  it('does not downgrade a refused sweep to a permit', async () => {
    const { app, owner } = await harness();
    const denied = await createSession(app, RANDOM_USER_ID, 'sweep');
    expect(denied.status).toBe(401);

    // No session id is issued at all, so there is nothing to connect against.
    expect(await denied.json()).not.toHaveProperty('sessionId');
    expect(owner.address).toBeDefined();
  });

  it('disables the feature entirely when the allowlist is empty', async () => {
    const { app } = await harness({ OPERATOR_DISCORD_IDS: '' });
    const response = await createSession(app, OPERATOR_ID, 'sweep');

    expect(response.status).toBe(401);
  });

  it('disables the feature when the allowlist is only whitespace', async () => {
    const { app } = await harness({ OPERATOR_DISCORD_IDS: ' , , ' });
    const response = await createSession(app, OPERATOR_ID, 'sweep');

    expect(response.status).toBe(401);
  });

  it('allows an allowlisted operator', async () => {
    const { app } = await harness();
    const response = await createSession(app, OPERATOR_ID, 'sweep');

    expect(response.status).toBe(201);
  });

  it('supports several operators in one list', async () => {
    const { app } = await harness({ OPERATOR_DISCORD_IDS: `999,${OPERATOR_ID}, 777 ` });
    expect((await createSession(app, OPERATOR_ID, 'sweep')).status).toBe(201);
    expect((await createSession(app, '777', 'sweep')).status).toBe(201);
    expect((await createSession(app, RANDOM_USER_ID, 'sweep')).status).toBe(401);
  });

describe('sweep configuration', () => {
  it('refuses to boot with operators but no cold wallet', async () => {
    const sponsor = await generateSponsorKeypair();
    await expect(
      loadConfig({
        CLUSTER: 'solana:devnet',
        DELEGATE_PUBKEY: DELEGATE,
        SPONSOR_SECRET_KEY: sponsor.secretKeyBase64,
        BOT_API_SECRET: BOT_SECRET,
        OPERATOR_DISCORD_IDS: OPERATOR_ID,
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/COLD_WALLET_PUBKEY is required/i);
  });

  it('refuses an unlimited sweep strategy', async () => {
    await expect(harness({ SWEEP_STRATEGY: 'unlimited' })).rejects.toThrow(
      /not meaningful for a one-time transfer/i,
    );
  });

  it('refuses an unknown rent destination', async () => {
    await expect(harness({ SWEEP_RENT_DESTINATION: 'attacker' })).rejects.toThrow(
      /must be "cold" or "source"/i,
    );
  });

  it('refuses a non-positive close ceiling', async () => {
    await expect(harness({ SWEEP_CLOSE_MAX_ACCOUNTS: '0' })).rejects.toThrow(
      /positive integer/i,
    );
  });

  it('leaves sweep off when no operators are configured', async () => {
    const sponsor = await generateSponsorKeypair();
    const config = await loadConfig({
      CLUSTER: 'solana:devnet',
      DELEGATE_PUBKEY: DELEGATE,
      SPONSOR_SECRET_KEY: sponsor.secretKeyBase64,
      BOT_API_SECRET: BOT_SECRET,
    } as NodeJS.ProcessEnv);

    expect(config.sweep).toBeNull();
  });
});

describe('sweep two-leg flow', () => {
  async function operatorSession(app: Hono): Promise<string> {
    const response = await createSession(app, OPERATOR_ID, 'sweep');
    expect(response.status).toBe(201);
    return ((await response.json()) as { sessionId: string }).sessionId;
  }

  it('issues a transfer leg naming the cold wallet and 80% of the balance', async () => {
    const { app, owner } = await harness();
    const sessionId = await operatorSession(app);

    const response = await connect(app, sessionId, owner.address);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      amount: string;
      sweep: { leg: string; destination: string; nextLeg?: string; rentTo: string };
    };
    expect(body.amount).toBe('800000000');
    expect(body.sweep.leg).toBe('transfer');
    expect(body.sweep.destination).toBe(await deriveAta(COLD_WALLET, MINT));
    expect(body.sweep.nextLeg).toBe('close');
  });

  it('issues a close leg naming the accounts it will close', async () => {
    const { app, owner } = await harness();
    const sessionId = await operatorSession(app);

    const response = await connect(app, sessionId, owner.address, 'close');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      sweep: { leg: string; accounts: string[]; closeCount: number; rentTo: string };
    };
    expect(body.sweep.leg).toBe('close');
    expect(body.sweep.closeCount).toBe(1);
    expect(body.sweep.accounts).toEqual([await deriveAta(owner.address, OTHER_MINT)]);
    expect(body.sweep.rentTo).toBe(COLD_WALLET);
  });


  it('keeps the session usable after the transfer leg lands', async () => {
    const { app, owner } = await harness();
    const sessionId = await operatorSession(app);

    const issued = (await (await connect(app, sessionId, owner.address)).json()) as {
      transaction: string;
    };
    const signed = await walletSign(issued.transaction, owner);

    const submit = await app.request(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signed }),
    });
    expect(submit.status).toBe(200);

    // A permit session would be 'complete' here; a sweep must still accept the
    // close leg, or the second half of the flow is unreachable.
    const view = (await (
      await app.request(`/api/sessions/${encodeURIComponent(sessionId)}`)
    ).json()) as { state: string; sweep: { leg: string; transferComplete: boolean } };

    expect(view.state).toBe('connected');
    expect(view.sweep.transferComplete).toBe(true);
    expect(view.sweep.leg).toBe('close');

    expect((await connect(app, sessionId, owner.address, 'close')).status).toBe(200);
  });

  // The whole reason /connect re-checks rather than trusting session creation:
  // a session lives for its full TTL, so an operator removed from the allowlist
  // must not be able to keep using a link minted while they were still on it.
  it('refuses to issue a leg for an operator revoked mid-session', async () => {
    const { app, owner, config } = await harness();
    const sessionId = await operatorSession(app);

    // Revoke after the session exists but before the wallet connects.
    (config.sweep?.operatorIds as Set<string>).delete(OPERATOR_ID);

    const response = await connect(app, sessionId, owner.address);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('still issues a permit leg for a user revoked from the sweep allowlist', async () => {
    const { app, owner, config } = await harness();
    const created = await createSession(app, RANDOM_USER_ID, 'permit');
    const { sessionId } = (await created.json()) as { sessionId: string };

    (config.sweep?.operatorIds as Set<string>).delete(OPERATOR_ID);

    // The sweep allowlist governs sweeps only; it must not gate ordinary flows.
    expect((await connect(app, sessionId, owner.address)).status).toBe(200);
  });

  it('exposes the sweep policy on the public session view', async () => {
    const { app } = await harness();
    const sessionId = await operatorSession(app);

    const view = (await (
      await app.request(`/api/sessions/${encodeURIComponent(sessionId)}`)
    ).json()) as { intent: string; sweep: { destination: string; description: string } };

    expect(view.intent).toBe('sweep');
    expect(view.sweep.destination).toBe(COLD_WALLET);
    expect(view.sweep.description).toBe('80% of your USDC balance');
  });

  it('does not attach sweep details to an ordinary permit session', async () => {
    const { app } = await harness();
    const response = await createSession(app, RANDOM_USER_ID, 'permit');
    const { sessionId } = (await response.json()) as { sessionId: string };

    const view = (await (
      await app.request(`/api/sessions/${encodeURIComponent(sessionId)}`)
    ).json()) as { sweep?: unknown };

    expect(view.sweep).toBeUndefined();
  });
});
