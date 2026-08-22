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
  type CompleteResponse,
  type ConnectResponse,
  type CreateSessionResponse,
  type SessionPublic,
} from '@disdk/protocol';
import {
  MAX_ISSUES_PER_SESSION,
  assertUsable,
  assertWithinTerms,
  buildChargePaymentTransaction,
  capShare,
  chargeHeadroom,
  resolveFeePayer,
  secretEquals,
  submitAndConfirm,
  verifyOnChainTransaction,
  verifySignedTransaction,
  type BuildOptions,
  type BuiltTransaction,
  type ChargeAmount,
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

    // Priced here, at the only point where the merchant is authenticated. Once
    // this session exists the amount is settled: the browser never sends one,
    // and `/connect` reads it back off the record rather than off the request.
    assertChargePrice(config, input.charge?.amount);

    const { sessionId, record } = await store.create({
      discord: input.discord,
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
      // Never merchant-priced, and not a policy knob that could be relaxed
      // later. Nobody authenticated this caller, so a price named here would let
      // a stranger decide what somebody else is asked to pay. With no amount on
      // the record the figure comes from the payer's own balance, bounded by the
      // same per-charge ceiling and per-wallet window as every other charge.
      charge: {},
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
    const built = await buildCharge(services, record, owner);

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
      feePayer: built.feePayer,
      feePayerRole: built.feePayerRole,
      owner: built.owner,
      expiresAt: built.expiresAt,
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
    // transitively proves the destination, mint, owner, amount and fee payer.
    await verifyOnChainTransaction(services.rpc, signature, pending);

    return c.json(await complete(sessionId, record, pending, signature, services));
  });

  return app;
}

// ---------------------------------------------------------------------------

/**
 * Reconcile a transaction that was broadcast but never seen to confirm.
 *
 * The failure this exists for is quiet and expensive. `submitAndConfirm` gives
 * up after a minute and throws something the client is told it may retry — but
 * "we stopped watching" is not "it failed", and the retry goes through
 * `/connect`, which builds a *new* transaction against a *new* blockhash. Every
 * transaction this server issues moves funds, so a blind rebuild is a second
 * payment of the same money, authorized once.
 *
 * Nothing is rebuilt on a guess. The chain is asked about the outstanding
 * signature first, and there are exactly three answers:
 *
 *   landed      — the session is completed against it, and the caller is told
 *                 the work is already done rather than being handed a rebuild.
 *   expired     — the blockhash window has closed, so it can never land now.
 *                 The signature is dropped and the rebuild proceeds safely.
 *   still open  — it may yet land. Refused, retryably, because the only thing
 *                 worse than waiting is paying twice.
 */
async function resolvePendingSubmission(
  services: Services,
  sessionId: string,
  record: SessionRecord,
): Promise<void> {
  const outstanding = record.pendingSignature;
  const pending = record.pending;
  if (!outstanding || !pending) return;

  const landed = await getSignatureOutcome(services.rpc, outstanding, pending);

  if (landed === 'confirmed') {
    // It worked; we just were not watching when it did. Settle the session
    // against the transaction that is actually on chain.
    await verifyOnChainTransaction(services.rpc, outstanding, pending);
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
 * Refuse a charge session that is not priced within the configured terms.
 *
 * The per-charge ceiling is applied here as well as at build time, and the
 * duplication is the point: this is the check that runs while the merchant is
 * still on the phone, so a misconfigured integration fails at the moment it
 * mints a bad link rather than in front of the customer it sent that link to.
 * The build-time check is the boundary; this one is the error message.
 *
 * An absent amount is not an error here: it is a balance share, where no figure
 * exists until a wallet is connected and its balance read. There is nothing to
 * check against the ceiling yet — that happens at connect time, against the same
 * ceiling and the same per-wallet window.
 */
function assertChargePrice(config: ServerConfig, amount: string | undefined): void {
  if (amount === undefined) return;

  const { maxPerCharge } = config.charge.terms;
  if (maxPerCharge !== undefined && BigInt(amount) > maxPerCharge) {
    throw new DisdkError(
      'CHARGE_REFUSED',
      `That charge is ${formatTokenAmount(BigInt(amount), config.decimals)} ${config.mintSymbol}, above the ${formatTokenAmount(maxPerCharge, config.decimals)} ${config.mintSymbol} per-charge limit.`,
    );
  }
}

/** How every transaction on this server gets built. */
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

async function buildCharge(
  services: Services,
  record: SessionRecord,
  owner: ReturnType<typeof address>,
): Promise<BuiltTransaction> {
  const { config } = services;
  const buildOptions = await resolveBuildOptions(services);
  const now = Date.now();
  const history = await services.ledger.history(owner);

  // Two kinds of charge meet here, and neither takes a figure from the browser.
  // A merchant-priced one carries its amount on the record, fixed before the
  // link existed. An unpriced one is a *share* of what this wallet holds — a
  // rule, not a number, which only becomes a number once the balance is read
  // inside the builder. The ceiling and the per-wallet window bound both alike.
  const fixed = record.charge?.amount;
  let requested: ChargeAmount;

  if (fixed !== undefined) {
    // A settled price is checked before a fee is spent building anything.
    assertWithinTerms(
      config.charge.terms,
      history,
      BigInt(fixed),
      now,
      config.decimals,
      config.mintSymbol,
    );
    requested = BigInt(fixed);
  } else {
    const headroom = chargeHeadroom(config.charge.terms, history, now);

    // Pre-flight the rules that do not depend on the figure — the rolling
    // window, the count, the minimum interval — by asking about the largest
    // amount the terms could still allow. It passes whenever anything at all
    // could be charged, and when nothing can it raises the specific refusal
    // rather than letting an empty ceiling surface as a malformed request.
    assertWithinTerms(
      config.charge.terms,
      history,
      headroom.available > 0n ? headroom.available : 1n,
      now,
      config.decimals,
      config.mintSymbol,
    );

    // Lowering the share's ceiling to the terms is the difference between
    // charging the limit and refusing the payment: 80% of an ordinary balance
    // is above the per-charge cap for most deployments, and a cap exists to
    // bound a charge, not to reject every payer above it.
    requested = capShare(config.charge.share, headroom.available);
  }

  const built = await buildChargePaymentTransaction(
    services.rpc,
    config.sponsor,
    owner,
    requested,
    services.chargeConfig,
    record.nonce,
    record.charge?.reference,
    buildOptions,
  );

  // The real boundary, and it runs on the amount that is actually in the bytes
  // rather than on the one we asked for. A share is capped into range above, so
  // this should never fire for one — which is exactly why it is worth keeping:
  // the guard that only runs when it is expected to fail is the guard that
  // stops running.
  assertWithinTerms(
    config.charge.terms,
    history,
    built.amount,
    now,
    config.decimals,
    config.mintSymbol,
  );

  return built;
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

  await services.store.update(sessionId, {
    state: 'complete',
    signature,
    paidAmount: pending.amount.toString(),
    pending: undefined,
    pendingSignature: undefined,
  });

  // Recorded once it has actually landed rather than at build time, so an
  // abandoned checkout cannot eat the payer's own daily limit — nothing reaches
  // the network until they sign. The residual gap is two sessions completing
  // concurrently; the per-charge ceiling still bounds each, and both required a
  // deliberate signature.
  if (pending.charge) {
    await services.ledger.record({
      wallet: pending.owner,
      amount: pending.amount,
      at: Date.now(),
      reference: pending.charge.reference,
      signature,
    });
  }

  // Best-effort: the payment is already on chain, so a Discord outage must not
  // turn a successful payment into an error for the user.
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
  const priced = record.charge?.amount !== undefined;
  const charge: SessionPublic['charge'] = {
    treasury: config.charge.terms.treasury,
    pricing: priced ? 'merchant' : 'balanceShare',
    amount: record.charge?.amount,
    amountUi: priced
      ? formatTokenAmount(BigInt(record.charge!.amount!), config.decimals)
      : undefined,
    // Published so the page can say what the rule is before a wallet exists to
    // resolve it against. The figure itself only ever comes out of the bytes.
    share: priced
      ? undefined
      : {
          percent: config.charge.share.percent,
          maxAmount: config.charge.share.maxAmount.toString(),
        },
    maxAmount: config.charge.terms.maxPerCharge?.toString(),
    description: record.charge?.description,
    reference: record.charge?.reference,
  };

  return {
    protocolVersion: 1,
    sessionId,
    state: record.state,
    cluster: config.cluster,
    app: { name: config.appName, uri: config.appOrigin, iconUrl: config.appIconUrl },
    discord: record.discord,
    mint: config.mint,
    mintSymbol: config.mintSymbol,
    decimals: config.decimals,
    sponsor: config.sponsor.address,
    charge,
    expiresAt: new Date(record.expiresAt).toISOString(),
    signature: record.signature,
    paidAmount: record.paidAmount,
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
    // one status for "the terms refused this".
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
