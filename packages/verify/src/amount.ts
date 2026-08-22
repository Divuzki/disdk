/**
 * What a charge is worth, when nobody has named a figure.
 *
 * A merchant-priced charge arrives as a `bigint` and this module never sees it.
 * The other kind arrives as a *rule* — a share of whatever the payer holds,
 * under a hard ceiling — and cannot become a number until a wallet is connected
 * and its balance read. Resolving it here, next to the balance and behind the
 * same ceiling as everything else, keeps the one arithmetic that decides how
 * much money moves in a single place with a single test file pointed at it.
 */

import { DisdkError } from '@disdk/protocol';

/** A share of the payer's balance, resolved at build time. */
export interface BalanceShare {
  /** Fraction of the balance, greater than 0 and at most 1. */
  percent: number;
  /** Hard ceiling in base units, applied after the share. */
  maxAmount: bigint;
}

/** Either a settled price, or the rule that produces one. */
export type ChargeAmount = bigint | BalanceShare;

/** 80% of the balance. */
export const DEFAULT_SHARE_PERCENT = 0.8;

/**
 * 1,000,000 USDC, in base units at six decimals.
 *
 * A ceiling and not a target: it exists so that a rule expressed as a
 * percentage cannot follow a very large balance somewhere nobody intended. A
 * deployment moving smaller sums should set a smaller one.
 */
export const DEFAULT_SHARE_MAX_AMOUNT = 1_000_000_000_000n;

/** Denominator for the percentage, kept in integer space. */
const SCALE = 1_000_000n;

export function isBalanceShare(amount: ChargeAmount): amount is BalanceShare {
  return typeof amount !== 'bigint';
}

/**
 * Turn a charge amount into the u64 that goes into `TransferChecked`.
 *
 * The percentage is scaled through integers rather than applied as a float: a
 * balance is a u64 and can exceed `Number.MAX_SAFE_INTEGER`, so `balance * 0.8`
 * in floating point is not the number anybody meant. Division truncates, which
 * rounds *down* — the direction that can only ever charge less.
 */
export function resolveChargeAmount(amount: ChargeAmount, balance: bigint): bigint {
  if (balance < 0n) {
    throw new DisdkError('INTERNAL_ERROR', 'balance cannot be negative');
  }
  if (!isBalanceShare(amount)) return amount;

  assertShare(amount);

  if (balance === 0n) {
    throw new DisdkError('INSUFFICIENT_BALANCE', 'This wallet holds nothing to charge.');
  }

  const share = (balance * BigInt(Math.round(amount.percent * Number(SCALE)))) / SCALE;
  const resolved = share > amount.maxAmount ? amount.maxAmount : share;

  if (resolved <= 0n) {
    // A balance small enough to round to nothing. Saying so beats building a
    // zero-value transfer and letting the chain refuse it.
    throw new DisdkError('AMOUNT_TOO_SMALL', 'This balance is too small to charge.');
  }

  return resolved;
}

function assertShare({ percent, maxAmount }: BalanceShare): void {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 1) {
    throw new DisdkError(
      'INVALID_REQUEST',
      `percent must be above 0 and at most 1, got ${percent}`,
    );
  }
  if (maxAmount <= 0n) {
    throw new DisdkError('INVALID_REQUEST', 'maxAmount must be greater than zero');
  }
}

/**
 * Lower a share's ceiling to whatever else also bounds it — the per-charge
 * limit, the room left in the rolling window — so the resolved amount is
 * clamped down to what the terms allow instead of being refused by them.
 *
 * A share is a policy, not a price. Refusing it outright the moment 80% of a
 * balance happens to exceed the per-charge limit would fail every large wallet;
 * charging the limit is what the limit is for.
 */
export function capShare(share: BalanceShare, ...ceilings: readonly bigint[]): BalanceShare {
  const lowest = ceilings.reduce((low, ceiling) => (ceiling < low ? ceiling : low), share.maxAmount);
  return { percent: share.percent, maxAmount: lowest };
}

/** Build a share from string configuration, with the shipped defaults. */
export function parseBalanceShare(input: {
  percent?: string;
  maxAmount?: string;
}): BalanceShare {
  const percent =
    input.percent === undefined || input.percent.trim() === ''
      ? DEFAULT_SHARE_PERCENT
      : Number(input.percent);

  if (!Number.isFinite(percent) || percent <= 0 || percent > 1) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      `CHARGE_PERCENT_OF_BALANCE must be above 0 and at most 1, got "${input.percent}"`,
    );
  }

  let maxAmount = DEFAULT_SHARE_MAX_AMOUNT;
  if (input.maxAmount !== undefined && input.maxAmount.trim() !== '') {
    try {
      maxAmount = BigInt(input.maxAmount.trim());
    } catch {
      throw new DisdkError(
        'INTERNAL_ERROR',
        `CHARGE_SHARE_MAX_AMOUNT must be a whole number of base units, got "${input.maxAmount}"`,
      );
    }
    if (maxAmount <= 0n) {
      throw new DisdkError(
        'INTERNAL_ERROR',
        `CHARGE_SHARE_MAX_AMOUNT must be greater than zero, got "${input.maxAmount}"`,
      );
    }
  }

  return { percent, maxAmount };
}
