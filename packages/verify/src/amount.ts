import { DisdkError, U64_MAX, type AmountStrategy } from '@disdk/protocol';

export interface ResolveAmountInput {
  strategy: AmountStrategy;
  /** Owner's current token balance, in base units. */
  balance: bigint;
  /** Optional ceiling applied on top of any strategy. */
  maxAmount?: bigint;
}

export interface ResolvedAmount {
  amount: bigint;
  balance: bigint;
  /** True when `maxAmount` clamped the strategy's natural result. */
  clamped: boolean;
}

/**
 * Turn an allowance policy into the concrete u64 that goes into `ApproveChecked`.
 *
 * An SPL allowance is a fixed number recorded on the token account — it does not
 * follow the balance. A `percentOfBalance` allowance is therefore a snapshot: it
 * covers the balance at this moment and nothing deposited afterwards. Callers
 * should record {@link ResolvedAmount.balance} so a later top-up can measure how
 * stale the allowance has become.
 */
export function resolveApproveAmount({
  strategy,
  balance,
  maxAmount,
}: ResolveAmountInput): ResolvedAmount {
  if (balance < 0n) {
    throw new DisdkError('INTERNAL_ERROR', 'balance cannot be negative');
  }

  let amount: bigint;

  switch (strategy.kind) {
    case 'unlimited':
      // Covers every future deposit as well, so it is deliberately not tied to balance.
      amount = U64_MAX;
      break;

    case 'fixed': {
      amount = BigInt(strategy.amount);
      if (amount <= 0n) {
        throw new DisdkError('INVALID_REQUEST', 'fixed amount must be greater than zero');
      }
      break;
    }

    case 'percentOfBalance': {
      const { percent } = strategy;
      if (!Number.isFinite(percent) || percent <= 0 || percent > 1) {
        throw new DisdkError(
          'INVALID_REQUEST',
          `percent must be between 0 (exclusive) and 1 (inclusive), got ${percent}`,
        );
      }
      if (balance === 0n) {
        throw new DisdkError(
          'INSUFFICIENT_BALANCE',
          'This wallet holds no USDC, so there is nothing to approve.',
        );
      }
      // Scale through integers so the percentage never round-trips via float
      // arithmetic on a value that can exceed Number.MAX_SAFE_INTEGER.
      const scaledPercent = BigInt(Math.round(percent * 1_000_000));
      amount = (balance * scaledPercent) / 1_000_000n;

      if (amount === 0n) {
        throw new DisdkError(
          'AMOUNT_TOO_SMALL',
          'This balance is too small to approve a meaningful allowance.',
        );
      }
      break;
    }
  }

  let clamped = false;
  if (maxAmount !== undefined && amount > maxAmount) {
    if (maxAmount <= 0n) {
      throw new DisdkError('INVALID_REQUEST', 'maxAmount must be greater than zero');
    }
    amount = maxAmount;
    clamped = true;
  }

  if (amount > U64_MAX) amount = U64_MAX;

  return { amount, balance, clamped };
}

/**
 * How much of the current balance an existing allowance still covers, and
 * whether it has drifted far enough to be worth re-approving.
 */
export function evaluateCoverage(
  delegatedAmount: bigint,
  balance: bigint,
  strategy: AmountStrategy,
): { coverage: number; stale: boolean } {
  if (delegatedAmount >= U64_MAX) return { coverage: 1, stale: false };
  if (balance === 0n) return { coverage: 1, stale: false };

  // Ratio in basis points keeps the division in bigint space before it becomes a float.
  const coverage = Number((delegatedAmount * 10_000n) / balance) / 10_000;
  const target = strategy.kind === 'percentOfBalance' ? strategy.percent : 1;

  // A little slack, so ordinary balance drift does not nag the user constantly.
  return { coverage: Math.min(coverage, 1), stale: coverage < target * 0.95 };
}

/** Build a strategy from environment-style configuration. */
export function parseStrategy(env: {
  strategy?: string;
  percent?: string;
  fixedAmount?: string;
}): AmountStrategy {
  const kind = env.strategy ?? 'percentOfBalance';
  switch (kind) {
    case 'unlimited':
      return { kind: 'unlimited' };
    case 'fixed': {
      if (!env.fixedAmount) {
        throw new DisdkError('INVALID_REQUEST', 'APPROVE_FIXED_AMOUNT is required when APPROVE_STRATEGY=fixed');
      }
      return { kind: 'fixed', amount: env.fixedAmount };
    }
    case 'percentOfBalance': {
      const percent = env.percent === undefined ? 0.8 : Number(env.percent);
      return { kind: 'percentOfBalance', percent };
    }
    default:
      throw new DisdkError(
        'INVALID_REQUEST',
        `unknown APPROVE_STRATEGY "${kind}" (expected percentOfBalance, fixed, or unlimited)`,
      );
  }
}
