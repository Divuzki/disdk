import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  DisdkError,
  assertAuthorizeSweepRequest,
  assertConfirmRequest,
  assertConnectRequest,
  assertCreateSessionRequest,
  assertSubmitRequest,
  explorerUrl,
  formatTokenAmount,
  isLikelyBase58Address,
  type AuthorizeSweepResponse,
  type CompleteResponse,
  type ConnectResponse,
  type CreateSessionResponse,
  type SessionPublic,
  type SweepLeg,
  type SweepOfferPublic,
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
import type { ServerConfig } from './config.ts';
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

    // A sweep has no creator but the wallet owner.
    //
    // It is not that this caller is untrusted — they hold the bot secret. It is
    // that a sweep is authorized by the person whose funds move, on a session
    // they have already signed on, and no third party can stand in for that. So
    // the intent is refused outright here, and reached only through
    // POST /api/sessions/:id/sweep/authorize, which nothing but the user's own
    // answer can satisfy.
    if (input.intent === 'sweep') {
      throw new DisdkError(
        'UNAUTHORIZED',
        'A sweep session cannot be created directly. It is offered to the wallet owner after they sign, and exists only once they authorize it.',
      );
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

    const { publicKey, leg, amount: requestedAmount } = assertConnectRequest(
      await c.req.json().catch(() => null),
    );

    // Re-checked independently of the authorization call, and not because that
    // check is unreliable. A session lives for its whole window, and no code
    // path should ever assume "something upstream already authorized this"
    // about an irreversible transfer.
    if (record.intent === 'sweep') {
      assertSweepAuthorized(config, record, publicKey, leg ?? 'transfer');
    }

    // Settle any transaction that was broadcast but never seen to confirm,
    // before building anything that would move the same funds again.
    await resolvePendingSubmission(services, sessionId, record);

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
    const built = await buildForIntent(services, record, owner, leg ?? 'transfer', requestedAmount);

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

    // A confirmation timeout below throws on a transaction that may still be
    // live. Recording the signature at broadcast is what lets the next request
    // ask the chain what happened instead of assuming it failed.
    const signature = await submitAndConfirm(services.rpc, signedTransaction, pending, {
      onBroadcast: async (broadcast) => {
        await store.update(sessionId, { pendingSignature: broadcast });
      },
    });

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
  // Sweep authorization — the user's own answer, on their own session
  //
  // The whole of a sweep's authorization lives in this one endpoint. Nothing
  // upstream of it can produce a sweepable session, and nothing downstream of it
  // runs without the record it writes. It is called by the user's own browser,
  // on a session they have just signed on, in answer to a screen that stated
  // plainly what a sweep would do — never on a timer, never on page load, and
  // never as a side effect of the permit landing.
  // -------------------------------------------------------------------------

  app.post('/api/sessions/:id/sweep/authorize', async (c) => {
    const sessionId = c.req.param('id');
    services.limiters.session.check(`sweep:${clientKey(c)}`);

    if (!config.sweep) {
      throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
    }

    const record = await store.get(sessionId);
    if (!record) throw new DisdkError('SESSION_NOT_FOUND', 'This link is not valid.');

    // Must be an unambiguous yes. See assertAuthorizeSweepRequest.
    assertAuthorizeSweepRequest(await c.req.json().catch(() => null));

    // Already answered. Idempotent rather than an error, because a retry from a
    // flaky connection is not a second decision — and must not open a second
    // window or hand out a second issue budget.
    if (record.sweepAuthorizedAt !== undefined) {
      return c.json(authorizeResponse(sessionId, record, config));
    }

    // "Offered immediately after signing" is a precondition here, not a figure
    // of speech. The offer means something only to someone who has just granted
    // an allowance and watched it land; a session that has not done that has
    // shown its holder nothing to consent to.
    if (record.intent !== 'permit' && record.intent !== 'reapprove') {
      throw new DisdkError(
        'INVALID_REQUEST',
        'Only a completed allowance session can authorize a transfer.',
      );
    }
    if (record.state !== 'complete' || !record.signature) {
      throw new DisdkError(
        'INVALID_REQUEST',
        'Approve the allowance first. The transfer is offered afterwards.',
      );
    }
    // A completed session outlives its own window on purpose, so the success
    // screen survives a refresh — which would leave the offer standing open for
    // as long as the record is retained. It is checked explicitly here instead:
    // an offer answered an hour later is not the "immediately after signing"
    // this endpoint exists for, and a stale link should not still be able to
    // move money. The window it is measured against is refreshed when the offer
    // is made, so answering always gets a full one.
    if (Date.now() > record.expiresAt) {
      throw new DisdkError(
        'SESSION_EXPIRED',
        'This offer has expired. Run /connect again in Discord to start over.',
      );
    }
    if (!record.owner) {
      throw new DisdkError('INVALID_REQUEST', 'No wallet is connected to this session.');
    }

    const now = Date.now();
    const updated = await store.update(sessionId, {
      intent: 'sweep',
      // Reopened for the two sweep legs. The permit's own signature moves aside
      // rather than being overwritten, so completing a sweep cannot erase the
      // record of the allowance approved before it.
      state: 'connected',
      permitSignature: record.signature,
      signature: undefined,
      approvedAmount: undefined,
      pending: undefined,
      sweepAuthorizedAt: now,
      // A fresh window and a fresh issue budget, because the permit has already
      // spent most of both. Reachable exactly once per session — every later
      // call returns from the idempotent branch above — so this doubles what one
      // link can cost the sponsor rather than uncapping it.
      issueCount: 0,
      expiresAt: now + config.sessionTtlMs,
    });

    return c.json(authorizeResponse(sessionId, updated, config));
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
 * Refuse a sweep the wallet owner has not explicitly authorized.
 *
 * This replaced an operator allowlist, and it is the stricter of the two rather
 * than the looser one. The allowlist answered "is this person permitted to
 * sweep?" — a question a session could satisfy without anyone having asked the
 * owner of the funds anything at all. This answers "did the owner of this
 * wallet, on this session, say yes?", and no configuration can answer it on
 * their behalf.
 *
 * Fails closed in every direction: an unconfigured feature refuses everyone, an
 * unauthorized session refuses its own holder, a wallet other than the one that
 * consented is refused, and a transfer that already landed is not built twice.
 */
function assertSweepAuthorized(
  config: ServerConfig,
  record: SessionRecord,
  publicKey: string,
  leg: SweepLeg,
): void {
  if (!config.sweep) {
    throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
  }
  if (record.sweepAuthorizedAt === undefined) {
    throw new DisdkError(
      'UNAUTHORIZED',
      'This transfer has not been authorized. It is offered after you approve your allowance, and happens only if you choose it.',
    );
  }
  // The consent came from the wallet that had just signed. A different wallet
  // arriving on the same link is not covered by it, however the link was come by.
  if (record.owner && record.owner !== publicKey) {
    throw new DisdkError(
      'UNAUTHORIZED',
      'This transfer was authorized for a different wallet. Reconnect the wallet that approved it.',
    );
  }
  // One answer, one transfer. Without this the transfer leg could be rebuilt
  // after it had already landed, and the second one would carry no fresh answer
  // from anyone.
  if (leg === 'transfer' && record.sweepTransferSignature) {
    throw new DisdkError('SESSION_ALREADY_COMPLETE', 'This transfer has already been made.');
  }
}

/**
 * Reconcile a transaction that was broadcast but never seen to confirm.
 *
 * The failure this exists for is quiet and expensive. `submitAndConfirm` gives
 * up after a minute and throws something the client is told it may retry — but
 * "we stopped watching" is not "it failed", and the retry goes through
 * `/connect`, which builds a *new* transaction against a *new* blockhash. For an
 * allowance that is harmless: approving twice sets the same absolute number.
 * For a transfer it is a second transfer of the same funds, authorized once.
 *
 * So a leg that moves money does not get rebuilt on a guess. The chain is asked
 * about the outstanding signature first, and there are exactly three answers:
 *
 *   landed      — the session is completed against it, and the caller is told
 *                 the work is already done rather than being handed a rebuild.
 *   expired     — the blockhash window has closed, so it can never land now.
 *                 The signature is dropped and the rebuild proceeds safely.
 *   still open  — it may yet land. Refused, retryably, because the only thing
 *                 worse than waiting is transferring twice.
 *
 * Idempotent legs skip all of this: they are rebuilt freely, as they always
 * were, and carry no outstanding signature to reconcile.
 */
async function resolvePendingSubmission(
  services: Services,
  sessionId: string,
  record: SessionRecord,
): Promise<void> {
  const outstanding = record.pendingSignature;
  const pending = record.pending;
  if (!outstanding || !pending) return;

  if (!movesFunds(pending)) {
    // Nothing irreversible is at stake, so the stale marker is simply dropped.
    await services.store.update(sessionId, { pendingSignature: undefined });
    return;
  }

  const landed = await getSignatureOutcome(services.rpc, outstanding, pending);

  if (landed === 'confirmed') {
    // It worked; we just were not watching when it did. Settle the session
    // against the transaction that is actually on chain.
    await verifyOnChainPermit(services.rpc, outstanding, pending);
    await complete(sessionId, record, pending, outstanding, services);
    throw new DisdkError(
      'SESSION_ALREADY_COMPLETE',
      'That transaction had already gone through. Reload this page to see it.',
    );
  }

  if (landed === 'expired') {
    await services.store.update(sessionId, { pendingSignature: undefined });
    return;
  }

  throw new DisdkError(
    'SUBMIT_FAILED',
    'A transaction from this session is still being confirmed. Wait a moment and try again — retrying now could send it twice.',
    true,
  );
}

/** Whether rebuilding this leg would move funds a second time. */
function movesFunds(pending: BuiltTransaction): boolean {
  if (pending.charge) return true;
  return pending.sweep?.leg === 'transfer';
}

/**
 * What became of a broadcast signature: confirmed, definitively expired, or
 * still in flight.
 *
 * `searchTransactionHistory` is on deliberately. The status cache only holds
 * recent signatures, and this is asked precisely when time has passed — a cache
 * miss read as "never landed" is the exact wrong answer here.
 */
async function getSignatureOutcome(
  rpc: Services['rpc'],
  signature: string,
  pending: BuiltTransaction,
): Promise<'confirmed' | 'expired' | 'pending'> {
  const { value } = await rpc
    .getSignatureStatuses([signature as Parameters<typeof rpc.getSignatureStatuses>[0][number]], {
      searchTransactionHistory: true,
    })
    .send();

  const status = value[0];
  if (status && !status.err) {
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return 'confirmed';
    }
    return 'pending';
  }

  // A transaction that failed on chain moved nothing, so rebuilding is safe —
  // as is one whose blockhash window has closed without it landing.
  if (status?.err) return 'expired';

  const blockHeight = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
  return blockHeight > pending.lastValidBlockHeight ? 'expired' : 'pending';
}

/**
 * The sweep offer that goes with a permit, or `undefined` when there is none.
 *
 * Derived rather than stored, deliberately. An offer is not a state a session
 * enters; it is a description of what its owner could choose next. Nothing about
 * the record changes when one is shown — only when it is answered.
 */
function sweepOfferFor(
  record: SessionRecord,
  config: ServerConfig,
): SweepOfferPublic | undefined {
  if (!config.sweep) return undefined;
  if (record.intent !== 'permit' && record.intent !== 'reapprove') return undefined;

  return {
    destination: config.sweep.coldWallet,
    description: config.sweep.description,
    rentDestination: config.sweep.rentDestination,
  };
}

function authorizeResponse(
  sessionId: string,
  record: SessionRecord,
  config: ServerConfig,
): AuthorizeSweepResponse {
  const sweep = config.sweep as NonNullable<ServerConfig['sweep']>;
  return {
    sessionId,
    intent: record.intent,
    expiresAt: new Date(record.expiresAt).toISOString(),
    sweep: {
      destination: sweep.coldWallet,
      description: sweep.description,
      rentDestination: sweep.rentDestination,
    },
  };
}

/**
 * Refuse a charge session that is not priced within the configured terms.
 *
 * The per-charge ceiling is applied here as well as at build time, and the
 * duplication is the point: this is the check that runs while the merchant is
 * still on the phone, so a misconfigured integration fails at the moment it
 * mints a bad link rather than in front of the customer it sent that link to.
 * The build-time check is the boundary; this one is the error message.
 *
 * An absent amount is not an error here: it is a user-priced charge, where the
 * price is unknown until the payer names it at pay time. There is nothing to
 * check against the ceiling yet — that happens at connect time, against the same
 * ceiling and the same per-wallet window.
 */
function assertChargePrice(config: ServerConfig, amount: string | undefined): void {
  if (!config.charge) {
    throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
  }
  if (amount === undefined) return;

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
  /** The payer's chosen amount, base units. Only a user-priced charge reads it. */
  requestedAmount?: string,
): Promise<BuiltTransaction> {
  const { config } = services;
  const buildOptions = await resolveBuildOptions(services);

  if (record.intent === 'charge') {
    if (!services.chargeConfig || !config.charge) {
      throw new DisdkError('UNAUTHORIZED', 'This feature is not enabled.');
    }

    // Two kinds of charge meet here. A merchant-priced one carries its amount on
    // the record, fixed before the link existed; the browser cannot influence
    // it, so any amount a request supplies is ignored, not honoured. A
    // user-priced one has no record amount and the payer supplies it now —
    // authorizing their own payment, which is why accepting it from the browser
    // is safe. The ceiling and the per-wallet window below bound both alike.
    const fixed = record.charge?.amount;
    const chosen = fixed ?? requestedAmount;
    if (chosen === undefined) {
      throw new DisdkError('INVALID_REQUEST', 'This checkout needs an amount to charge.');
    }

    const amount = BigInt(chosen);

    // The real boundary. Re-checked against the ledger rather than trusted from
    // session creation, because the terms are per-wallet and the wallet is not
    // known until now. For a user-priced charge this is also where the payer's
    // chosen amount first meets the ceiling.
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
      record.charge?.reference,
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
  const offer = sweepOfferFor(record, config);

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
          pendingSignature: undefined,
        }
      : {
          state: 'complete',
          signature,
          approvedAmount: pending.amount.toString(),
          pending: undefined,
          pendingSignature: undefined,
          // An offer with no deadline is a standing invitation, and a standing
          // invitation to move funds is not what "offered after signing" means.
          // It gets the same life every other link here does, measured from the
          // moment it appeared rather than from whatever was left of the window
          // the user spent deciding whether to approve their allowance.
          ...(offer ? { expiresAt: Date.now() + config.sessionTtlMs } : {}),
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
    // What "available immediately after signing" amounts to on the wire: the
    // allowance has landed, so the option now exists and is described here. It
    // is returned to be shown, not to be acted on — no sweep transaction exists
    // at this point, and none will until this user, on this session, says they
    // want one.
    sweepOffer: offer,
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
    record.intent === 'charge' && config.charge
      ? {
          treasury: config.charge.terms.treasury,
          userPriced: record.charge?.amount === undefined,
          amount: record.charge?.amount,
          amountUi:
            record.charge?.amount !== undefined
              ? formatTokenAmount(BigInt(record.charge.amount), config.decimals)
              : undefined,
          maxAmount: config.charge.terms.maxPerCharge?.toString(),
          description: record.charge?.description,
          reference: record.charge?.reference,
        }
      : undefined;

  return {
    protocolVersion: 1,
    sessionId,
    state: record.state,
    intent: record.intent,
    // Only once the permit has actually landed, so reopening a finished link
    // shows the same offer the signing flow did — and an unsigned session shows
    // none, because there is nothing yet to have consented to.
    sweepOffer: record.state === 'complete' ? sweepOfferFor(record, config) : undefined,
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
