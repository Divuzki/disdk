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
  type SweepLeg,
} from '@disdk/protocol';
import {
  MAX_ISSUES_PER_SESSION,
  assertUsable,
  assertWithinTerms,
  buildChargePaymentTransaction,
  buildPermitTransaction,
  buildRevokeTransaction,
  buildSweepCloseTransaction,
  buildSweepTransferTransaction,
  getPermitStatus,
  resolveFeePayer,
  secretEquals,
  submitAndConfirm,
  verifyOnChainPermit,
  verifySignedTransaction,
  type BuildOptions,
  type BuiltTransaction,
  type SessionRecord,
} from '@disdk/verify';
import { address } from '@solana/kit';
import { randomUUID } from 'node:crypto';
import { isSweepOperator, type ServerConfig } from './config.ts';
import type { Services } from './services.ts';

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

    // The primary authorization gate for sweeps.
    //
    // This is checked here, on the request body, rather than in the bot's
    // command handler — the handler's check is UX only and is trivially
    // bypassed by calling this endpoint directly with a valid bot secret. A
    // sweep session is never created for a non-operator, whatever route the
    // request arrived by.
    if (input.intent === 'sweep') {
      assertSweepOperator(config, input.discord.id);
    }

    // Priced here, at the only point where the merchant is authenticated. Once
    // this session exists the amount is settled: the browser never sends one,
    // and `/connect` reads it back off the record rather than off the request.
    if (input.intent === 'charge') {
      assertChargePrice(config, input.charge?.amount);
    }

    const { sessionId, record } = await store.create({
      discord: input.discord,
      intent: input.intent ?? 'permit',
      charge: input.charge,
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
  // Session creation — browser, no Discord identity
  //
  // The connect page calls this when it was opened without a `?ds=` link, so a
  // visitor can run the flow without a Discord round trip. The resulting
  // session proves nothing about who the user is, which is why it is opt-in and
  // why the identity it carries is explicitly marked anonymous.
  // -------------------------------------------------------------------------

  app.post('/api/sessions/anonymous', async (c) => {
    if (!config.allowAnonymousSessions) {
      throw new DisdkError(
        'UNAUTHORIZED',
        'Anonymous sessions are disabled. Run /connect in Discord to get a link.',
      );
    }

    // Unauthenticated, so it is the one creation path a stranger can reach.
    services.limiters.session.check(`anon:${clientKey(c)}`);

    const { sessionId, record } = await store.create({
      discord: { id: `anonymous:${randomUUID()}`, username: 'guest' },
      intent: 'permit',
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

    const { publicKey, leg } = assertConnectRequest(await c.req.json().catch(() => null));

    // Re-checked independently of session creation, and not because the first
    // check is unreliable. A session lives for its whole TTL, so the allowlist
    // may have been edited since it was created; and no code path should ever
    // assume "something upstream already authorized this" about an irreversible
    // transfer.
    if (record.intent === 'sweep') {
      assertSweepOperator(config, record.discord.id);
    }

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
    const built = await buildForIntent(services, record, owner, leg ?? 'transfer');

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
      feePayerRole: built.feePayerRole,
      owner: built.owner,
      expiresAt: built.expiresAt,
      sweep: sweepResponse(built, services),
      charge: chargeResponse(built, record),
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
      await resolveBuildOptions(services),
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
      feePayerRole: built.feePayerRole,
      owner: built.owner,
      expiresAt: built.expiresAt,
    };
    return c.json(response);
  });

  return app;
}

// ---------------------------------------------------------------------------

/**
 * Refuse a sweep for anyone not on the operator allowlist.
 *
 * Fails closed in both directions: an unconfigured feature refuses everyone, and
 * a configured one refuses everyone not named. There is deliberately no fallback
 * to a different intent — silently downgrading a sweep request to a permit would
 * be a worse outcome than an error, because the caller would believe something
 * happened that did not.
 */
function assertSweepOperator(config: ServerConfig, discordUserId: string): void {
  if (!config.sweep) {
    throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
  }
  if (!isSweepOperator(config.sweep, discordUserId)) {
    throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
  }
}

/**
 * Refuse a charge session that is not priced within the configured terms.
 *
 * The per-charge ceiling is applied here as well as at build time, and the
 * duplication is the point: this is the check that runs while the merchant is
 * still on the phone, so a misconfigured integration fails at the moment it
 * mints a bad link rather than in front of the customer it sent that link to.
 * The build-time check is the boundary; this one is the error message.
 */
function assertChargePrice(config: ServerConfig, amount: string | undefined): void {
  if (!config.charge) {
    throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
  }
  // `assertCreateSessionRequest` guarantees this for a charge intent; restated
  // so this function is safe to call from anywhere.
  if (amount === undefined) {
    throw new DisdkError('INVALID_REQUEST', 'A charge session requires charge.amount.');
  }

  const { maxPerCharge } = config.charge.terms;
  if (maxPerCharge !== undefined && BigInt(amount) > maxPerCharge) {
    throw new DisdkError(
      'CHARGE_REFUSED',
      `That charge is ${formatTokenAmount(BigInt(amount), config.decimals)} ${config.mintSymbol}, above the ${formatTokenAmount(maxPerCharge, config.decimals)} ${config.mintSymbol} per-charge limit.`,
    );
  }
}

/**
 * How every transaction on this server gets built.
 *
 * Shared rather than inlined because the revoke endpoint builds outside
 * {@link buildForIntent}, and the one time these were computed separately the
 * revoke path silently kept a sponsor fee payer and no priority fee — so a user
 * whose sponsor had run dry could be left unable to revoke.
 */
async function resolveBuildOptions(services: Services): Promise<BuildOptions> {
  const { config } = services;
  return {
    // With the fallback off this short-circuits and costs no RPC call.
    feePayerRole: await resolveFeePayer(services.rpc, config.sponsor.address, {
      fallbackEnabled: config.feePayerFallback,
      minLamports: config.sponsorMinLamports,
    }),
    priorityFeeMicroLamports: config.priorityFeeMicroLamports,
    computeUnitLimit: config.computeUnitLimit,
  };
}

async function buildForIntent(
  services: Services,
  record: SessionRecord,
  owner: ReturnType<typeof address>,
  leg: SweepLeg,
): Promise<BuiltTransaction> {
  const { config } = services;
  const buildOptions = await resolveBuildOptions(services);

  if (record.intent === 'charge') {
    if (!services.chargeConfig || !config.charge) {
      throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
    }
    if (!record.charge) {
      throw new DisdkError('INVALID_REQUEST', 'This link carries no amount to charge.');
    }

    const amount = BigInt(record.charge.amount);

    // The real boundary. Re-read from the record rather than the request, and
    // re-checked against the ledger rather than trusted from session creation,
    // because the terms are per-wallet and the wallet is not known until now.
    assertWithinTerms(
      config.charge.terms,
      await services.ledger.history(owner),
      amount,
      Date.now(),
      config.decimals,
      config.mintSymbol,
    );

    return buildChargePaymentTransaction(
      services.rpc,
      config.sponsor,
      owner,
      amount,
      services.chargeConfig,
      record.nonce,
      record.charge.reference,
      buildOptions,
    );
  }

  if (record.intent === 'sweep') {
    // Unreachable via the API — both gates above run first — but a builder that
    // cannot run without its config is better than one that trusts a caller.
    if (!services.sweepConfig) {
      throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
    }
    return leg === 'close'
      ? buildSweepCloseTransaction(
          services.rpc,
          config.sponsor,
          owner,
          services.sweepConfig,
          record.nonce,
          buildOptions,
        )
      : buildSweepTransferTransaction(
          services.rpc,
          config.sponsor,
          owner,
          services.sweepConfig,
          record.nonce,
          buildOptions,
        );
  }

  if (record.intent === 'revoke') {
    return buildRevokeTransaction(
      services.rpc,
      config.sponsor,
      owner,
      { mint: config.mint, decimals: config.decimals },
      record.nonce,
      buildOptions,
    );
  }

  return buildPermitTransaction(
    services.rpc,
    config.sponsor,
    owner,
    services.permitConfig,
    record.nonce,
    buildOptions,
  );
}

function sweepResponse(
  built: BuiltTransaction,
  { config }: Services,
): ConnectResponse['sweep'] {
  if (!built.sweep || !config.sweep) return undefined;

  return {
    leg: built.sweep.leg,
    destination: built.sweep.destination ?? config.sweep.coldWallet,
    closeCount: built.sweep.closes.length,
    accounts: built.sweep.closes.map((close) => close.account),
    maxAccounts: config.sweep.closeMaxAccounts,
    rentTo: built.sweep.rentTo ?? config.sweep.coldWallet,
    // The transfer is the leg that matters; closes are offered afterwards and
    // the user is free to stop there.
    nextLeg: built.sweep.leg === 'transfer' ? 'close' : undefined,
  };
}

function chargeResponse(
  built: BuiltTransaction,
  record: SessionRecord,
): ConnectResponse['charge'] {
  if (!built.charge) return undefined;

  return {
    destination: built.charge.destination,
    treasury: built.charge.treasury,
    description: record.charge?.description,
    reference: built.charge.reference,
  };
}

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

  // A sweep's transfer leg landing is not the end of the session: the close leg
  // still has to be issued and signed against it. Marking it complete here would
  // make `assertUsable` reject the second leg outright.
  const transferLegOnly =
    record.intent === 'sweep' && pending.sweep?.leg === 'transfer';

  await services.store.update(
    sessionId,
    transferLegOnly
      ? {
          state: 'connected',
          sweepTransferSignature: signature,
          approvedAmount: pending.amount.toString(),
          pending: undefined,
        }
      : {
          state: 'complete',
          signature,
          approvedAmount: pending.amount.toString(),
          pending: undefined,
        },
  );

  // Recorded once it has actually landed, which is the opposite of what the
  // delegate-pull charge service does — and for a reason specific to this flow.
  // There, the service submits, so a broadcast-but-unconfirmed charge might
  // still settle and has to count. Here nothing reaches the network until the
  // user signs, so recording at build time would let an abandoned checkout eat
  // the user's own daily limit. The residual gap is two sessions completing
  // concurrently; `maxPerCharge` still bounds each, and both required a
  // deliberate signature.
  if (record.intent === 'charge' && pending.charge) {
    await services.ledger.record({
      wallet: pending.owner,
      amount: pending.amount,
      at: Date.now(),
      reference: pending.charge.reference,
      signature,
    });
  }

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
  const sweep: SessionPublic['sweep'] =
    record.intent === 'sweep' && config.sweep
      ? {
          destination: config.sweep.coldWallet,
          description: config.sweep.description,
          rentDestination: config.sweep.rentDestination,
          leg: record.sweepTransferSignature ? 'close' : 'transfer',
          transferComplete: record.sweepTransferSignature !== undefined,
        }
      : undefined;

  const charge: SessionPublic['charge'] =
    record.intent === 'charge' && record.charge && config.charge
      ? {
          treasury: config.charge.terms.treasury,
          amount: record.charge.amount,
          amountUi: formatTokenAmount(BigInt(record.charge.amount), config.decimals),
          description: record.charge.description,
          reference: record.charge.reference,
        }
      : undefined;

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
    sponsor: config.sponsor.address,
    allowanceDescription: config.allowanceDescription,
    sweep,
    charge,
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

function statusFor(error: DisdkError): 400 | 401 | 402 | 404 | 409 | 410 | 429 | 500 {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 401;
    // Matches the charge service, so a merchant integrating against both sees
    // one status for "the terms refused this". `INSUFFICIENT_BALANCE` is
    // deliberately left as-is: it predates charges and is reachable from the
    // permit flow, where changing it would alter an existing contract.
    case 'CHARGE_REFUSED':
      return 402;
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
