import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  DisdkError,
  assertConfirmRequest,
  assertConnectRequest,
  assertCreateSessionRequest,
  assertSubmitRequest,
  explorerUrl,
  formatTokenAmount,
  isLikelyBase58Address,
  type CompleteResponse,
  type ConnectResponse,
  type CreateSessionResponse,
  type SessionPublic,
} from '@disdk/protocol';
import {
  MAX_ISSUES_PER_SESSION,
  assertUsable,
  buildPermitTransaction,
  buildRevokeTransaction,
  getPermitStatus,
  secretEquals,
  submitAndConfirm,
  verifyOnChainPermit,
  verifySignedTransaction,
  type BuiltTransaction,
  type SessionRecord,
} from '@disdk/verify';
import { address } from '@solana/kit';
import type { Services } from './services.js';

export function createApi(services: Services): Hono {
  const app = new Hono();
  const { config, store } = services;

  app.use(
    '/api/*',
    cors({
      origin: (origin) => (config.corsOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'x-disdk-bot-secret'],
      maxAge: 600,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof DisdkError) {
      return c.json(error.toBody(), statusFor(error));
    }
    console.error('[disdk] unhandled error', error);
    return c.json({ error: 'INTERNAL_ERROR', message: 'Something went wrong.' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, cluster: config.cluster }));

  // -------------------------------------------------------------------------
  // Session creation — bot only
  // -------------------------------------------------------------------------

  app.post('/api/sessions', async (c) => {
    const secret = c.req.header('x-disdk-bot-secret') ?? '';
    if (!secretEquals(secret, config.botApiSecret)) {
      throw new DisdkError('UNAUTHORIZED', 'Invalid bot credentials.');
    }

    const input = assertCreateSessionRequest(await c.req.json().catch(() => null));
    const { sessionId, record } = await store.create({
      discord: input.discord,
      intent: input.intent ?? 'permit',
      interactionToken: input.interactionToken,
      ttlMs: config.sessionTtlMs,
    });

    const response: CreateSessionResponse = {
      sessionId,
      url: `${config.appOrigin}/?ds=${encodeURIComponent(sessionId)}`,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
    return c.json(response, 201);
  });

  // -------------------------------------------------------------------------
  // Public session view
  // -------------------------------------------------------------------------

  app.get('/api/sessions/:id', async (c) => {
    const sessionId = c.req.param('id');
    services.limiters.session.check(`view:${clientKey(c)}`);

    const record = await store.get(sessionId);
    if (!record) throw new DisdkError('SESSION_NOT_FOUND', 'This link is not valid.');

    return c.json(toPublic(sessionId, record, services));
  });

  // -------------------------------------------------------------------------
  // Issue the sponsored transaction
  // -------------------------------------------------------------------------

  app.post('/api/sessions/:id/connect', async (c) => {
    const sessionId = c.req.param('id');
    const record = assertUsable(await store.get(sessionId));

    const { publicKey } = assertConnectRequest(await c.req.json().catch(() => null));

    // Issuing costs the sponsor a fee, so bound it per session and per caller.
    services.limiters.issue.check(`issue:${clientKey(c)}`);
    services.limiters.issue.check(`issue:discord:${record.discord.id}`);

    if (record.issueCount >= MAX_ISSUES_PER_SESSION) {
      throw new DisdkError(
        'RATE_LIMITED',
        'This link has been used too many times. Run /connect again in Discord.',
      );
    }

    const owner = address(publicKey);
    const built =
      record.intent === 'revoke'
        ? await buildRevokeTransaction(
            services.rpc,
            config.sponsor,
            owner,
            { mint: config.mint, decimals: config.decimals },
            record.nonce,
          )
        : await buildPermitTransaction(
            services.rpc,
            config.sponsor,
            owner,
            services.permitConfig,
            record.nonce,
          );

    await store.update(sessionId, {
      state: 'awaiting_signature',
      owner: publicKey,
      pending: built,
      issueCount: record.issueCount + 1,
    });

    const response: ConnectResponse = {
      transaction: built.transactionBase64,
      amount: built.amount.toString(),
      amountUi: built.amountUi,
      balanceAtBuild: built.balanceAtBuild.toString(),
      mint: config.mint,
      decimals: config.decimals,
      delegate: config.delegate,
      feePayer: built.feePayer,
      owner: built.owner,
      expiresAt: built.expiresAt,
    };
    return c.json(response);
  });

  // -------------------------------------------------------------------------
  // Completion — two paths, depending on what the wallet supports
  // -------------------------------------------------------------------------

  app.post('/api/sessions/:id/submit', async (c) => {
    const sessionId = c.req.param('id');
    const record = assertUsable(await store.get(sessionId));
    const pending = requirePending(record);

    const { signedTransaction } = assertSubmitRequest(await c.req.json().catch(() => null));

    // The sponsor's signature already binds the message, so a tampered
    // transaction cannot reach the chain. Checking here anyway means tampering
    // fails loudly, and a transaction issued for another session can never be
    // submitted under this one.
    await verifySignedTransaction(signedTransaction, pending);
    const signature = await submitAndConfirm(services.rpc, signedTransaction, pending);

    return c.json(await complete(sessionId, record, pending, signature, services));
  });

  app.post('/api/sessions/:id/confirm', async (c) => {
    const sessionId = c.req.param('id');
    const record = assertUsable(await store.get(sessionId));
    const pending = requirePending(record);

    const { signature } = assertConfirmRequest(await c.req.json().catch(() => null));

    // The wallet broadcast it, so the server never saw the signed bytes. Verify
    // the confirmed transaction is byte-identical to the one we issued, which
    // transitively proves the delegate, mint, owner, amount and fee payer.
    await verifyOnChainPermit(services.rpc, signature, pending);

    return c.json(await complete(sessionId, record, pending, signature, services));
  });

  // -------------------------------------------------------------------------
  // Allowance status, top-up, and revoke
  // -------------------------------------------------------------------------

  app.get('/api/permits/:wallet', async (c) => {
    const wallet = c.req.param('wallet');
    const sessionId = c.req.query('session');
    if (!sessionId) throw new DisdkError('UNAUTHORIZED', 'A session is required.');
    if (!(await store.get(sessionId))) {
      throw new DisdkError('SESSION_NOT_FOUND', 'This link is not valid.');
    }
    if (!isLikelyBase58Address(wallet)) {
      throw new DisdkError('INVALID_PUBLIC_KEY', 'Not a Solana address.');
    }

    services.limiters.session.check(`status:${clientKey(c)}`);

    return c.json(
      await getPermitStatus(
        services.rpc,
        address(wallet),
        config.mint,
        config.decimals,
        config.strategy,
      ),
    );
  });

  app.post('/api/permits/:wallet/revoke', async (c) => {
    const wallet = c.req.param('wallet');
    const body = (await c.req.json().catch(() => ({}))) as { session?: string };
    const sessionId = body.session;
    if (!sessionId) throw new DisdkError('UNAUTHORIZED', 'A session is required.');

    const record = assertUsable(await store.get(sessionId));
    if (!isLikelyBase58Address(wallet)) {
      throw new DisdkError('INVALID_PUBLIC_KEY', 'Not a Solana address.');
    }
    services.limiters.issue.check(`revoke:${clientKey(c)}`);

    const built = await buildRevokeTransaction(
      services.rpc,
      config.sponsor,
      address(wallet),
      { mint: config.mint, decimals: config.decimals },
      record.nonce,
    );

    await store.update(sessionId, {
      state: 'awaiting_signature',
      owner: wallet,
      pending: built,
      issueCount: record.issueCount + 1,
    });

    const response: ConnectResponse = {
      transaction: built.transactionBase64,
      amount: '0',
      amountUi: '0',
      balanceAtBuild: built.balanceAtBuild.toString(),
      mint: config.mint,
      decimals: config.decimals,
      delegate: config.delegate,
      feePayer: built.feePayer,
      owner: built.owner,
      expiresAt: built.expiresAt,
    };
    return c.json(response);
  });

  return app;
}

// ---------------------------------------------------------------------------

async function complete(
  sessionId: string,
  record: SessionRecord,
  pending: BuiltTransaction,
  signature: string,
  services: Services,
): Promise<CompleteResponse> {
  const { config } = services;
  const amountUi = formatTokenAmount(pending.amount, config.decimals);
  const url = explorerUrl(signature, config.cluster);

  await services.store.update(sessionId, {
    state: 'complete',
    signature,
    approvedAmount: pending.amount.toString(),
    pending: undefined,
  });

  // Best-effort: the permit is already on chain, so a Discord outage must not
  // turn a successful approval into an error for the user.
  try {
    await services.notifier.onComplete({
      discordUserId: record.discord.id,
      interactionToken: record.interactionToken,
      wallet: pending.owner,
      amountUi,
      symbol: config.mintSymbol,
      explorerUrl: url,
    });
  } catch (error) {
    console.error('[disdk] could not notify Discord', error);
  }

  return {
    signature,
    amount: pending.amount.toString(),
    amountUi,
    delegate: config.delegate,
    explorerUrl: url,
  };
}

function requirePending(record: SessionRecord): BuiltTransaction {
  if (!record.pending) {
    throw new DisdkError(
      'INVALID_REQUEST',
      'No transaction is pending for this session. Start again.',
      true,
    );
  }
  return record.pending;
}

function toPublic(
  sessionId: string,
  record: SessionRecord,
  { config }: Services,
): SessionPublic {
  return {
    protocolVersion: 1,
    sessionId,
    state: record.state,
    intent: record.intent,
    cluster: config.cluster,
    app: { name: config.appName, uri: config.appOrigin, iconUrl: config.appIconUrl },
    discord: record.discord,
    mint: config.mint,
    mintSymbol: config.mintSymbol,
    decimals: config.decimals,
    delegate: config.delegate,
    allowanceDescription: config.allowanceDescription,
    expiresAt: new Date(record.expiresAt).toISOString(),
    signature: record.signature,
    approvedAmount: record.approvedAmount,
  };
}

function clientKey(c: { req: { header(name: string): string | undefined } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

function statusFor(error: DisdkError): 400 | 401 | 404 | 409 | 410 | 429 | 500 {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'SESSION_NOT_FOUND':
      return 404;
    case 'SESSION_EXPIRED':
      return 410;
    case 'SESSION_ALREADY_COMPLETE':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL_ERROR':
      return 500;
    default:
      return 400;
  }
}
