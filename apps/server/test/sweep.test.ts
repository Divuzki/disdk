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
import { MemorySessionStore, deriveAta, generateSponsorKeypair } from '@disdk/verify';
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

const USER_ID = '2002';

/** 1,000 USDC. */
const BALANCE = 1_000_000_000n;

/** 1,000,000 USDC — the configured sweep ceiling. */
const CAP = 1_000_000_000_000n;

/** 2,000,000 USDC, so the ceiling actually binds rather than sitting unused. */
const OVER_CAP_BALANCE = 2_000_000_000_000n;

interface Harness {
  app: Hono;
  mock: MockRpc;
  owner: KeyPairSigner;
  config: Awaited<ReturnType<typeof loadConfig>>;
  /** Held so a test can put the store into a state the API refuses to create. */
  store: MemorySessionStore;
}

async function harness(
  envOverrides: Record<string, string> = {},
  balance: bigint = BALANCE,
): Promise<Harness> {
  const sponsor = await generateSponsorKeypair();
  const config = await loadConfig({
    CLUSTER: 'solana:devnet',
    DELEGATE_PUBKEY: DELEGATE,
    SPONSOR_SECRET_KEY: sponsor.secretKeyBase64,
    BOT_API_SECRET: BOT_SECRET,
    APP_ORIGIN: ORIGIN,
    COLD_WALLET_PUBKEY: COLD_WALLET,
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const mock = createMockRpc();
  const owner = await generateKeyPairSigner();
  await mockTokenAccountFor(mock, owner.address, MINT, balance);
  await mockTokenAccountFor(mock, owner.address, OTHER_MINT, 0n);

  const store = new MemorySessionStore();
  const services = createServices(config, { rpc: mock.rpc, store });
  return { app: createApi(services), mock, owner, config, store };
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

async function authorize(app: Hono, sessionId: string, body: unknown = { consent: true }) {
  return app.request(`/api/sessions/${encodeURIComponent(sessionId)}/sweep/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function walletSign(transactionBase64: string, owner: KeyPairSigner): Promise<string> {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
  const signed = await partiallySignTransactionWithSigners([owner], transaction);
  return getBase64EncodedWireTransaction(signed);
}

async function submit(app: Hono, sessionId: string, signedTransaction: string): Promise<Response> {
  return app.request(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedTransaction }),
  });
}

async function view(app: Hono, sessionId: string): Promise<Record<string, unknown>> {
  const response = await app.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Run an ordinary permit to completion.
 *
 * Every sweep in this file starts here, and that is the whole design: a sweep is
 * the continuation of a session whose owner has already signed something and
 * seen it land. There is no shortcut past this in the tests because there is
 * none in the server.
 */
async function completePermit(
  app: Hono,
  owner: KeyPairSigner,
  discordId = USER_ID,
): Promise<string> {
  const created = await createSession(app, discordId, 'permit');
  expect(created.status).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };

  const issued = (await (await connect(app, sessionId, owner.address)).json()) as {
    transaction: string;
  };
  const settled = await submit(app, sessionId, await walletSign(issued.transaction, owner));
  expect(settled.status).toBe(200);

  return sessionId;
}

/** A permit that has landed and whose owner then said yes to the offer. */
async function authorizedSweep(app: Hono, owner: KeyPairSigner): Promise<string> {
  const sessionId = await completePermit(app, owner);
  expect((await authorize(app, sessionId)).status).toBe(200);
  return sessionId;
}

describe('sweep authorization', () => {
  // The shape of the whole feature: consent is the authorization, and it is
  // given by the wallet owner on their own session. Nothing else produces a
  // session a sweep can be built for — not a bot secret, not an intent on a
  // creation request, not a configuration file.
  it('refuses to create a sweep session directly, even with a valid bot secret', async () => {
    const { app } = await harness();
    const response = await createSession(app, USER_ID, 'sweep');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
    // No session id is issued at all, so there is nothing to connect against.
    expect(await createSession(app, USER_ID, 'sweep').then((r) => r.json())).not.toHaveProperty(
      'sessionId',
    );
  });

  it('still allows that same user an ordinary permit session', async () => {
    const { app } = await harness();
    expect((await createSession(app, USER_ID, 'permit')).status).toBe(201);
  });

  it('offers the sweep on the permit that has just completed', async () => {
    const { app, owner } = await harness();
    const created = await createSession(app, USER_ID, 'permit');
    const { sessionId } = (await created.json()) as { sessionId: string };

    const issued = (await (await connect(app, sessionId, owner.address)).json()) as {
      transaction: string;
    };
    const settled = await submit(app, sessionId, await walletSign(issued.transaction, owner));

    // "Enabled immediately after signing": the option is described in the same
    // response that reports the allowance landing.
    const body = (await settled.json()) as {
      sweepOffer?: { destination: string; description: string; rentDestination: string };
    };
    expect(body.sweepOffer).toEqual({
      destination: COLD_WALLET,
      description: '80% of your USDC balance',
      rentDestination: 'cold',
    });
  });

  // An offer is not a state the session enters. Completing the permit must
  // leave the record exactly as it was in every respect that matters.
  it('does not start, schedule, or pre-build anything when it makes the offer', async () => {
    const { app, mock, owner } = await harness();
    const before = mock.submitted.size;

    const sessionId = await completePermit(app, owner);

    // One transaction reached the network: the permit itself.
    expect(mock.submitted.size).toBe(before + 1);

    const session = await view(app, sessionId);
    expect(session.intent).toBe('permit');
    expect(session.state).toBe('complete');
    // Still a permit session, so nothing about a sweep is on it yet.
    expect(session.sweep).toBeUndefined();

    // And the sweep legs are refused outright until it is answered.
    const denied = await connect(app, sessionId, owner.address);
    expect(denied.status).toBe(409);
  });

  // The gate that carries the whole feature, tested against the state no API
  // call can produce: a sweep session with no consent on it. That is what a bug,
  // a bad migration, or a tampered store would leave behind, and the intent
  // alone must never be enough to get a transfer built.
  it('refuses to issue a sweep leg on a session that never authorized one', async () => {
    const { app, owner, store } = await harness();
    const sessionId = await completePermit(app, owner);

    await store.update(sessionId, {
      intent: 'sweep',
      state: 'connected',
      signature: undefined,
      // Deliberately no sweepAuthorizedAt.
    });

    const response = await connect(app, sessionId, owner.address);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('refuses the close leg on that same unauthorized session', async () => {
    const { app, owner, store } = await harness();
    const sessionId = await completePermit(app, owner);

    await store.update(sessionId, {
      intent: 'sweep',
      state: 'connected',
      signature: undefined,
    });

    expect((await connect(app, sessionId, owner.address, 'close')).status).toBe(401);
  });

  it('refuses to authorize before the permit has landed', async () => {
    const { app } = await harness();
    const created = await createSession(app, USER_ID, 'permit');
    const { sessionId } = (await created.json()) as { sessionId: string };

    const response = await authorize(app, sessionId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'INVALID_REQUEST' });
  });

  // The one field the request has, and anything short of an unambiguous yes is
  // a no. An empty retry POST must never read as consent to move funds.
  it.each([{}, { consent: false }, { consent: 'true' }, { consent: 1 }, null])(
    'refuses a body that is not an explicit yes: %j',
    async (body) => {
      const { app, owner } = await harness();
      const sessionId = await completePermit(app, owner);

      const response = await authorize(app, sessionId, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'INVALID_REQUEST' });

      // And the session is untouched, so a refused body cannot half-authorize.
      expect((await view(app, sessionId)).intent).toBe('permit');
    },
  );

  it('converts the session once the owner says yes', async () => {
    const { app, owner } = await harness();
    const sessionId = await completePermit(app, owner);

    const response = await authorize(app, sessionId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId,
      intent: 'sweep',
      sweep: { destination: COLD_WALLET, description: '80% of your USDC balance' },
    });

    const session = await view(app, sessionId);
    expect(session.intent).toBe('sweep');
    expect(session.state).toBe('connected');
  });

  it('is idempotent, so a retried request is not a second decision', async () => {
    const { app, owner } = await harness();
    const sessionId = await completePermit(app, owner);

    const first = (await (await authorize(app, sessionId)).json()) as { expiresAt: string };
    const second = await authorize(app, sessionId);

    expect(second.status).toBe(200);
    // Same window: a repeat must not extend the one the first answer opened.
    expect(((await second.json()) as { expiresAt: string }).expiresAt).toBe(first.expiresAt);
  });

  it('refuses to authorize when the feature is off', async () => {
    const { app, owner } = await harness({ COLD_WALLET_PUBKEY: '' });
    const sessionId = await completePermit(app, owner);

    const response = await authorize(app, sessionId);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('makes no offer at all when the feature is off', async () => {
    const { app, owner } = await harness({ COLD_WALLET_PUBKEY: '' });
    const created = await createSession(app, USER_ID, 'permit');
    const { sessionId } = (await created.json()) as { sessionId: string };

    const issued = (await (await connect(app, sessionId, owner.address)).json()) as {
      transaction: string;
    };
    const settled = await submit(app, sessionId, await walletSign(issued.transaction, owner));

    expect((await settled.json()) as { sweepOffer?: unknown }).not.toHaveProperty('sweepOffer');
    expect(await view(app, sessionId)).not.toHaveProperty('sweepOffer');
  });

  // The consent came from one wallet, on one session. It does not travel.
  it('refuses a sweep leg for a wallet other than the one that consented', async () => {
    const { app, mock, owner } = await harness();
    const sessionId = await authorizedSweep(app, owner);

    const stranger = await generateKeyPairSigner();
    await mockTokenAccountFor(mock, stranger.address, MINT, BALANCE);

    const response = await connect(app, sessionId, stranger.address);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  // One answer, one transfer. Rebuilding the transfer leg after it has landed
  // would move funds a second time on a consent that was already spent.
  it('refuses a second transfer leg once one has landed', async () => {
    const { app, owner } = await harness();
    const sessionId = await authorizedSweep(app, owner);

    const issued = (await (await connect(app, sessionId, owner.address)).json()) as {
      transaction: string;
    };
    expect((await submit(app, sessionId, await walletSign(issued.transaction, owner))).status).toBe(
      200,
    );

    const again = await connect(app, sessionId, owner.address);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'SESSION_ALREADY_COMPLETE' });
  });

  it('does not let a revoke session authorize a sweep', async () => {
    const { app } = await harness();
    const created = await createSession(app, USER_ID, 'revoke');
    const { sessionId } = (await created.json()) as { sessionId: string };

    expect((await authorize(app, sessionId)).status).toBe(400);
  });
});

describe('sweep configuration', () => {
  it('is off when no cold wallet is configured', async () => {
    const sponsor = await generateSponsorKeypair();
    const config = await loadConfig({
      CLUSTER: 'solana:devnet',
      DELEGATE_PUBKEY: DELEGATE,
      SPONSOR_SECRET_KEY: sponsor.secretKeyBase64,
      BOT_API_SECRET: BOT_SECRET,
    } as NodeJS.ProcessEnv);

    expect(config.sweep).toBeNull();
  });

  it('treats a whitespace-only cold wallet as unset', async () => {
    const { config } = await harness({ COLD_WALLET_PUBKEY: '   ' });
    expect(config.sweep).toBeNull();
  });

  it('turns on with a cold wallet alone', async () => {
    const { config } = await harness();
    expect(config.sweep?.coldWallet).toBe(COLD_WALLET);
  });

  it('refuses an unlimited sweep strategy', async () => {
    await expect(harness({ SWEEP_STRATEGY: 'unlimited' })).rejects.toThrow(
      /not meaningful for a one-time transfer/i,
    );
  });

  // A bad ceiling must fail at boot. A negative one in particular used to parse
  // cleanly and only throw deep in amount resolution — at the exact moment
  // someone was about to move money.
  it('refuses a malformed sweep ceiling', async () => {
    await expect(harness({ SWEEP_MAX_AMOUNT: 'lots' })).rejects.toThrow(
      /SWEEP_MAX_AMOUNT must be a whole number/i,
    );
  });

  it('refuses a zero or negative sweep ceiling', async () => {
    await expect(harness({ SWEEP_MAX_AMOUNT: '0' })).rejects.toThrow(
      /SWEEP_MAX_AMOUNT must be greater than zero/i,
    );
    await expect(harness({ SWEEP_MAX_AMOUNT: '-1' })).rejects.toThrow(
      /SWEEP_MAX_AMOUNT must be greater than zero/i,
    );
  });

  it('treats a blank sweep ceiling as no ceiling', async () => {
    const { config } = await harness({ SWEEP_MAX_AMOUNT: '  ' });
    expect(config.sweep?.maxAmount).toBeUndefined();
  });

  it('refuses an unknown rent destination', async () => {
    await expect(harness({ SWEEP_RENT_DESTINATION: 'attacker' })).rejects.toThrow(
      /must be "cold" or "source"/i,
    );
  });

  it('refuses a non-positive close ceiling', async () => {
    await expect(harness({ SWEEP_CLOSE_MAX_ACCOUNTS: '0' })).rejects.toThrow(/positive integer/i);
  });
});

describe('sweep two-leg flow', () => {
  it('issues a transfer leg naming the cold wallet and 80% of the balance', async () => {
    const { app, owner } = await harness();
    const sessionId = await authorizedSweep(app, owner);

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

  // The ceiling is the whole point of SWEEP_MAX_AMOUNT: the strategy alone would
  // move the entire balance here, so this fails the moment the cap stops being
  // read anywhere along config -> services -> build.
  it('clamps the transfer to SWEEP_MAX_AMOUNT when the strategy exceeds it', async () => {
    const { app, owner } = await harness(
      { SWEEP_MAX_AMOUNT: CAP.toString(), SWEEP_PERCENT: '1' },
      OVER_CAP_BALANCE,
    );
    const sessionId = await authorizedSweep(app, owner);

    const response = await connect(app, sessionId, owner.address);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { amount: string }).amount).toBe(CAP.toString());
  });

  it('leaves a transfer under the ceiling untouched', async () => {
    const { app, owner } = await harness({ SWEEP_MAX_AMOUNT: CAP.toString() });
    const sessionId = await authorizedSweep(app, owner);

    const body = (await (await connect(app, sessionId, owner.address)).json()) as {
      amount: string;
    };
    // 80% of 1,000 USDC, nowhere near the ceiling.
    expect(body.amount).toBe('800000000');
  });

  it('issues a close leg naming the accounts it will close', async () => {
    const { app, owner } = await harness();
    const sessionId = await authorizedSweep(app, owner);

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
    const sessionId = await authorizedSweep(app, owner);

    const issued = (await (await connect(app, sessionId, owner.address)).json()) as {
      transaction: string;
    };
    expect((await submit(app, sessionId, await walletSign(issued.transaction, owner))).status).toBe(
      200,
    );

    // A permit session would be 'complete' here; a sweep must still accept the
    // close leg, or the second half of the flow is unreachable.
    const session = (await view(app, sessionId)) as {
      state: string;
      sweep: { leg: string; transferComplete: boolean };
    };
    expect(session.state).toBe('connected');
    expect(session.sweep.transferComplete).toBe(true);
    expect(session.sweep.leg).toBe('close');

    expect((await connect(app, sessionId, owner.address, 'close')).status).toBe(200);
  });

  it('exposes the sweep policy on the public session view once authorized', async () => {
    const { app, owner } = await harness();
    const sessionId = await authorizedSweep(app, owner);

    const session = (await view(app, sessionId)) as {
      intent: string;
      sweep: { destination: string; description: string };
    };
    expect(session.intent).toBe('sweep');
    expect(session.sweep.destination).toBe(COLD_WALLET);
    expect(session.sweep.description).toBe('80% of your USDC balance');
  });

  // The description is the sentence the user reads on the offer screen before
  // anything moves, so a ceiling that binds has to appear in it.
  it('names the ceiling in the policy description', async () => {
    const { app, owner } = await harness({ SWEEP_MAX_AMOUNT: CAP.toString() });
    const sessionId = await completePermit(app, owner);

    const issued = await authorize(app, sessionId);
    const body = (await issued.json()) as { sweep: { description: string } };
    expect(body.sweep.description).toBe('80% of your USDC balance, capped at 1,000,000.00 USDC');
  });

  it('does not attach sweep details to a permit session that has not been answered', async () => {
    const { app, owner } = await harness();
    const sessionId = await completePermit(app, owner);

    const session = await view(app, sessionId);
    // The policy is offered, not applied: `sweepOffer` describes the choice,
    // while `sweep` stays absent until it has actually been made.
    expect(session.sweepOffer).toEqual({
      destination: COLD_WALLET,
      description: '80% of your USDC balance',
      rentDestination: 'cold',
    });
    expect(session.sweep).toBeUndefined();
  });
});
