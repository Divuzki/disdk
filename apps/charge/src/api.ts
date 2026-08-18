import { Hono } from 'hono';
import {
  DisdkError,
  formatTokenAmount,
  explorerUrl,
  isLikelyBase58Address,
} from '@disdk/protocol';
import {
  assertWithinTerms,
  buildChargeTransaction,
  chargeHeadroom,
  describeTerms,
  getPermitStatus,
  secretEquals,
  submitAndConfirm,
  type ChargeRecord,
} from '@disdk/verify';
import { address, type Address } from '@solana/kit';
import type { ChargeServices } from './services.ts';

export function createApi(services: ChargeServices): Hono {
  const app = new Hono();
  const { config, ledger } = services;

  app.onError((error, c) => {
    if (error instanceof DisdkError) {
      return c.json(error.toBody(), statusFor(error));
    }
    console.error('[disdk] unhandled error', error);
    return c.json({ error: 'INTERNAL_ERROR', message: 'Something went wrong.' }, 500);
  });

  // Every route here can move money, so authentication is not per-route.
  app.use('/api/*', async (c, next) => {
    const secret = c.req.header('x-disdk-merchant-secret') ?? '';
    if (!secretEquals(secret, config.merchantSecret)) {
      throw new DisdkError('UNAUTHORIZED', 'Invalid merchant credentials.');
    }
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true, cluster: config.cluster }));

  /** The terms this service will honour, so callers need not guess. */
  app.get('/api/terms', (c) =>
    c.json({
      cluster: config.cluster,
      mint: config.mint,
      symbol: config.mintSymbol,
      decimals: config.decimals,
      delegate: config.delegate.address,
      treasury: config.terms.treasury,
      description: describeTerms(config.terms, config.mintSymbol, config.decimals),
      maxPerCharge: config.terms.maxPerCharge?.toString(),
      maxPerPeriod: config.terms.maxPerPeriod?.toString(),
      maxChargesPerPeriod: config.terms.maxChargesPerPeriod,
      periodMs: config.terms.periodMs,
      minIntervalMs: config.terms.minIntervalMs,
    }),
  );

  /**
   * What this wallet's allowance and remaining terms allow right now. Callers
   * should check this before promising a user that a charge will succeed.
   */
  app.get('/api/wallets/:wallet', async (c) => {
    const wallet = requireAddress(c.req.param('wallet'));

    const [permit, history] = await Promise.all([
      getPermitStatus(
        services.rpc,
        wallet,
        config.mint,
        config.decimals,
        { kind: 'unlimited' },
      ),
      ledger.history(wallet),
    ]);

    const headroom = chargeHeadroom(config.terms, history);
    const allowance = BigInt(permit.delegatedAmount);
    const balance = BigInt(permit.balance);

    // What the user can actually be charged is the smallest of three separate
    // ceilings, and they fail for different reasons — report all of them rather
    // than a single opaque number.
    const chargeable = min(min(headroom.available, allowance), balance);

    return c.json({
      wallet,
      delegate: permit.delegate,
      delegateIsUs: permit.delegate === config.delegate.address,
      balance: permit.balance,
      allowance: permit.delegatedAmount,
      spentThisPeriod: headroom.spentThisPeriod.toString(),
      chargesThisPeriod: headroom.chargesThisPeriod,
      nextChargeAllowedAt: headroom.nextChargeAllowedAt
        ? new Date(headroom.nextChargeAllowedAt).toISOString()
        : undefined,
      chargeable: chargeable.toString(),
      chargeableUi: formatTokenAmount(chargeable, config.decimals),
    });
  });

  /**
   * Charge an approved wallet.
   *
   * The caller chooses the wallet and the amount; it does not choose where the
   * money goes, and it cannot exceed the configured terms.
   */
  app.post('/api/charges', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      wallet?: string;
      amount?: string | number;
      reference?: string;
      idempotencyKey?: string;
    } | null;
    if (!body) throw new DisdkError('INVALID_REQUEST', 'A JSON body is required.');

    const wallet = requireAddress(body.wallet);
    const amount = requireAmount(body.amount);
    const key = body.idempotencyKey;

    // Retrying a charge must not charge twice. Checked before the terms, so a
    // repeat of an accepted charge returns the original rather than tripping a
    // period limit that the original itself consumed.
    if (key) {
      const existing = await ledger.findByKey(key);
      if (existing) {
        if (existing.wallet !== wallet || existing.amount !== amount) {
          throw new DisdkError(
            'INVALID_REQUEST',
            'That idempotency key was used for a different wallet or amount.',
          );
        }
        return c.json(describeCharge(existing, services, true));
      }
    }

    const history = await ledger.history(wallet);
    assertWithinTerms(
      config.terms,
      history,
      amount,
      Date.now(),
      config.decimals,
      config.mintSymbol,
    );

    const built = await buildChargeTransaction(
      services.rpc,
      config.delegate,
      wallet,
      amount,
      {
        mint: config.mint,
        decimals: config.decimals,
        symbol: config.mintSymbol,
        treasury: config.terms.treasury,
        createTreasuryAtaIfMissing: config.terms.createTreasuryAtaIfMissing,
      },
      { reference: body.reference },
    );

    // Recorded before submission: a charge that broadcasts but never confirms
    // still consumed period budget, and failing closed is the safer error.
    const entry: ChargeRecord = {
      wallet,
      amount,
      at: Date.now(),
      reference: body.reference,
    };
    await ledger.record(entry, key);

    const signature = await submitAndConfirm(services.rpc, built.transactionBase64, {
      lastValidBlockHeight: built.lastValidBlockHeight,
    });

    await ledger.settle(key, entry, signature);

    return c.json({
      ...describeCharge(entry, services, false),
      signature,
      explorerUrl: explorerUrl(signature, config.cluster),
      allowanceAfter: built.allowanceAfter.toString(),
      treasury: config.terms.treasury,
    });
  });

  return app;
}

function describeCharge(
  entry: ChargeRecord,
  { config }: ChargeServices,
  replayed: boolean,
): Record<string, unknown> {
  return {
    wallet: entry.wallet,
    amount: entry.amount.toString(),
    amountUi: formatTokenAmount(entry.amount, config.decimals),
    symbol: config.mintSymbol,
    reference: entry.reference,
    chargedAt: new Date(entry.at).toISOString(),
    signature: entry.signature,
    explorerUrl: entry.signature ? explorerUrl(entry.signature, config.cluster) : undefined,
    replayed,
  };
}

function requireAddress(value: string | undefined): Address {
  if (!value || !isLikelyBase58Address(value)) {
    throw new DisdkError('INVALID_PUBLIC_KEY', 'Not a Solana address.');
  }
  return address(value);
}

/**
 * Amounts are base units and arrive as a string. A JSON number would lose
 * precision above 2^53, and silently — the one failure mode a payments path
 * cannot have.
 */
function requireAmount(value: string | number | undefined): bigint {
  if (value === undefined || value === null || value === '') {
    throw new DisdkError('INVALID_REQUEST', 'An amount in base units is required.');
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new DisdkError(
        'INVALID_REQUEST',
        'Send the amount as a string of base units; a JSON number cannot carry it exactly.',
      );
    }
    return BigInt(value);
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new DisdkError('INVALID_REQUEST', 'The amount must be an integer in base units.');
  }
  return BigInt(value.trim());
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function statusFor(error: DisdkError): 400 | 401 | 402 | 404 | 409 | 429 | 500 {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'CHARGE_REFUSED':
    case 'INSUFFICIENT_BALANCE':
      return 402;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL_ERROR':
    case 'SUBMIT_FAILED':
      return 500;
    default:
      return 400;
  }
}
