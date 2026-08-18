import { DisdkError, formatTokenAmount } from '@disdk/protocol';
import type { Address } from '@solana/kit';

/**
 * The terms under which a delegate is allowed to pull funds.
 *
 * An SPL allowance is a single number with no expiry and no rate limit: on
 * chain, nothing stops a delegate from moving the whole approved amount the
 * moment it is granted. These terms are the off-chain half of the bargain —
 * they are what turns "this key could take 80% of your balance" into "this key
 * charges at most 20 USDC, at most twice a day, and only to one account".
 *
 * Enforcement therefore lives entirely in the service holding the delegate key.
 * Anyone who steals that key ignores all of it, which is why these terms are a
 * product guarantee rather than a security boundary.
 */
export interface ChargeTerms {
  /**
   * Where funds land. Fixed by configuration and never read from the caller, so
   * a buggy or compromised caller cannot redirect a charge.
   */
  treasury: Address;

  /** Largest single charge, in base units. */
  maxPerCharge?: bigint;
  /** Largest total across a rolling window, in base units. */
  maxPerPeriod?: bigint;
  /** How many charges may land inside that window. */
  maxChargesPerPeriod?: number;
  /** Length of the rolling window. */
  periodMs: number;
  /** Minimum gap between two charges to the same wallet. */
  minIntervalMs?: number;

  /**
   * Create the treasury's associated token account if missing, at the charging
   * service's expense. Off by default: the treasury is your own account, so a
   * missing one usually means it is misconfigured rather than new.
   */
  createTreasuryAtaIfMissing?: boolean;
}

export interface ChargeRecord {
  wallet: Address;
  amount: bigint;
  /** Epoch milliseconds when the charge was accepted. */
  at: number;
  /** The caller's own order or invoice id, carried into the on-chain memo. */
  reference?: string;
  /** Set once the transaction confirms. */
  signature?: string;
}

export const DEFAULT_PERIOD_MS = 24 * 60 * 60 * 1000;

/** Largest value a u64 token amount can hold. */
const U64_CEILING = 18_446_744_073_709_551_615n;

/**
 * Read terms from string configuration. Amounts are base units, matching every
 * other amount in disdk, because accepting a decimal here would silently round.
 */
export function parseChargeTerms(input: {
  treasury?: string;
  maxPerCharge?: string;
  maxPerPeriod?: string;
  maxChargesPerPeriod?: string;
  periodMs?: string;
  minIntervalMs?: string;
  createTreasuryAtaIfMissing?: string;
}): ChargeTerms {
  if (!input.treasury) {
    throw new DisdkError('INTERNAL_ERROR', 'TREASURY_ADDRESS is required. See .env.example.');
  }

  const terms: ChargeTerms = {
    treasury: input.treasury as Address,
    periodMs: positiveInt('CHARGE_PERIOD_MS', input.periodMs) ?? DEFAULT_PERIOD_MS,
    createTreasuryAtaIfMissing: input.createTreasuryAtaIfMissing === 'true',
  };

  const maxPerCharge = positiveBigint('CHARGE_MAX_PER_CHARGE', input.maxPerCharge);
  if (maxPerCharge !== undefined) terms.maxPerCharge = maxPerCharge;

  const maxPerPeriod = positiveBigint('CHARGE_MAX_PER_PERIOD', input.maxPerPeriod);
  if (maxPerPeriod !== undefined) terms.maxPerPeriod = maxPerPeriod;

  const maxCharges = positiveInt('CHARGE_MAX_PER_PERIOD_COUNT', input.maxChargesPerPeriod);
  if (maxCharges !== undefined) terms.maxChargesPerPeriod = maxCharges;

  const minInterval = positiveInt('CHARGE_MIN_INTERVAL_MS', input.minIntervalMs);
  if (minInterval !== undefined) terms.minIntervalMs = minInterval;

  if (
    terms.maxPerCharge !== undefined &&
    terms.maxPerPeriod !== undefined &&
    terms.maxPerCharge > terms.maxPerPeriod
  ) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      'CHARGE_MAX_PER_CHARGE is above CHARGE_MAX_PER_PERIOD, so the per-charge limit can never be reached.',
    );
  }

  return terms;
}

export interface ChargeHeadroom {
  /** Largest amount that would be accepted right now, in base units. */
  available: bigint;
  spentThisPeriod: bigint;
  chargesThisPeriod: number;
  /** Epoch ms before which no charge is accepted, when an interval applies. */
  nextChargeAllowedAt?: number;
}

/** What the terms would allow for this wallet at this instant. */
export function chargeHeadroom(
  terms: ChargeTerms,
  history: readonly ChargeRecord[],
  now: number = Date.now(),
): ChargeHeadroom {
  const inPeriod = history.filter((entry) => now - entry.at < terms.periodMs);
  const spentThisPeriod = inPeriod.reduce((total, entry) => total + entry.amount, 0n);

  const limits: bigint[] = [];
  if (terms.maxPerCharge !== undefined) limits.push(terms.maxPerCharge);
  if (terms.maxPerPeriod !== undefined) {
    limits.push(terms.maxPerPeriod > spentThisPeriod ? terms.maxPerPeriod - spentThisPeriod : 0n);
  }

  let available = limits.length ? limits.reduce((a, b) => (a < b ? a : b)) : U64_CEILING;
  if (terms.maxChargesPerPeriod !== undefined && inPeriod.length >= terms.maxChargesPerPeriod) {
    available = 0n;
  }

  const headroom: ChargeHeadroom = {
    available,
    spentThisPeriod,
    chargesThisPeriod: inPeriod.length,
  };

  if (terms.minIntervalMs !== undefined && history.length) {
    const latest = history.reduce((a, b) => (a.at > b.at ? a : b));
    headroom.nextChargeAllowedAt = latest.at + terms.minIntervalMs;
  }

  return headroom;
}

/**
 * Throw unless `amount` is allowed for this wallet under these terms.
 *
 * `history` is every charge recorded for the wallet; the rolling window is
 * applied here rather than by the caller, so a storage layer cannot widen the
 * terms by returning too little.
 */
export function assertWithinTerms(
  terms: ChargeTerms,
  history: readonly ChargeRecord[],
  amount: bigint,
  now: number = Date.now(),
  decimals = 6,
  symbol = 'USDC',
): void {
  if (amount <= 0n) {
    throw new DisdkError('AMOUNT_TOO_SMALL', 'A charge must be greater than zero.');
  }

  const money = (value: bigint) => `${formatTokenAmount(value, decimals)} ${symbol}`;

  if (terms.maxPerCharge !== undefined && amount > terms.maxPerCharge) {
    throw new DisdkError(
      'CHARGE_REFUSED',
      `That charge is ${money(amount)}, above the ${money(terms.maxPerCharge)} per-charge limit.`,
    );
  }

  const { available, spentThisPeriod, chargesThisPeriod, nextChargeAllowedAt } = chargeHeadroom(
    terms,
    history,
    now,
  );

  if (nextChargeAllowedAt !== undefined && now < nextChargeAllowedAt) {
    const waitSeconds = Math.ceil((nextChargeAllowedAt - now) / 1000);
    throw new DisdkError(
      'CHARGE_REFUSED',
      `Too soon after the last charge to this wallet. Try again in ${waitSeconds}s.`,
      true,
    );
  }

  if (terms.maxChargesPerPeriod !== undefined && chargesThisPeriod >= terms.maxChargesPerPeriod) {
    throw new DisdkError(
      'CHARGE_REFUSED',
      `This wallet has been charged ${chargesThisPeriod} times this period, which is the limit.`,
    );
  }

  if (terms.maxPerPeriod !== undefined && spentThisPeriod + amount > terms.maxPerPeriod) {
    throw new DisdkError(
      'CHARGE_REFUSED',
      `That charge would take this period to ${money(spentThisPeriod + amount)}, above the ${money(
        terms.maxPerPeriod,
      )} limit. ${money(available)} remains.`,
    );
  }
}

/** One line describing the terms, for a boot log or an operator endpoint. */
export function describeTerms(terms: ChargeTerms, symbol = 'USDC', decimals = 6): string {
  const money = (value: bigint) => `${formatTokenAmount(value, decimals)} ${symbol}`;
  const parts: string[] = [
    terms.maxPerCharge !== undefined
      ? `at most ${money(terms.maxPerCharge)} per charge`
      : 'no per-charge limit',
  ];

  if (terms.maxPerPeriod !== undefined) {
    parts.push(`at most ${money(terms.maxPerPeriod)} per ${humanPeriod(terms.periodMs)}`);
  }
  if (terms.maxChargesPerPeriod !== undefined) {
    parts.push(`at most ${terms.maxChargesPerPeriod} charges per ${humanPeriod(terms.periodMs)}`);
  }
  if (terms.minIntervalMs !== undefined) {
    parts.push(`no more often than every ${humanPeriod(terms.minIntervalMs)}`);
  }
  parts.push(`paid to ${terms.treasury}`);
  return parts.join(', ');
}

function humanPeriod(ms: number): string {
  if (ms % 3_600_000 === 0) {
    const hours = ms / 3_600_000;
    if (hours % 24 === 0) return hours === 24 ? 'day' : `${hours / 24} days`;
    return hours === 1 ? 'hour' : `${hours} hours`;
  }
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? 'minute' : `${minutes} minutes`;
  }
  return `${Math.round(ms / 1000)}s`;
}

function positiveBigint(name: string, raw?: string): bigint | undefined {
  if (raw === undefined || raw === '') return undefined;
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new DisdkError('INTERNAL_ERROR', `${name} must be an integer in base units.`);
  }
  if (value <= 0n) throw new DisdkError('INTERNAL_ERROR', `${name} must be greater than zero.`);
  return value;
}

function positiveInt(name: string, raw?: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new DisdkError('INTERNAL_ERROR', `${name} must be a positive integer.`);
  }
  return value;
}
