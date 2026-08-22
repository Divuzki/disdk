// The one piece of arithmetic that decides how much money moves when nobody
// named a price. Everything here is integer maths on u64-sized values, so the
// cases that matter are the ones a float would get wrong and the ones where a
// rounding direction decides whether a payer is overcharged.
import { describe, expect, it } from 'vitest';
import { DisdkError } from '@disdk/protocol';
import {
  DEFAULT_SHARE_MAX_AMOUNT,
  DEFAULT_SHARE_PERCENT,
  capShare,
  isBalanceShare,
  parseBalanceShare,
  resolveChargeAmount,
} from '../src/amount.js';

/** 1,000 USDC at six decimals. */
const THOUSAND = 1_000_000_000n;
const SHARE = { percent: DEFAULT_SHARE_PERCENT, maxAmount: DEFAULT_SHARE_MAX_AMOUNT };

describe('resolveChargeAmount', () => {
  it('passes a settled price through untouched, whatever the balance', () => {
    expect(resolveChargeAmount(20_000_000n, THOUSAND)).toBe(20_000_000n);
    expect(resolveChargeAmount(20_000_000n, 20_000_000n)).toBe(20_000_000n);
  });

  it('takes 80% of the balance by default', () => {
    expect(resolveChargeAmount(SHARE, THOUSAND)).toBe(800_000_000n);
  });

  it('caps at 1,000,000 USDC however large the balance', () => {
    // 80% of 10,000,000 USDC is 8,000,000 — the cap is what the payer sees.
    expect(resolveChargeAmount(SHARE, 10_000_000_000_000n)).toBe(1_000_000_000_000n);
  });

  it('stays exact on a balance beyond what a float can hold', () => {
    // Above Number.MAX_SAFE_INTEGER, where `balance * 0.8` stops being the
    // number anybody meant. With the cap lifted, the answer must still be exact.
    const balance = 9_007_199_254_740_993n; // 2^53 + 1
    const uncapped = { percent: 0.8, maxAmount: balance };
    expect(resolveChargeAmount(uncapped, balance)).toBe((balance * 800_000n) / 1_000_000n);
  });

  it('rounds down, never up', () => {
    // 80% of 7 base units is 5.6. A payer is charged 5, not 6.
    expect(resolveChargeAmount({ percent: 0.8, maxAmount: 100n }, 7n)).toBe(5n);
  });

  it('refuses a wallet holding nothing', () => {
    expect(() => resolveChargeAmount(SHARE, 0n)).toThrowError(/nothing to charge/i);
  });

  it('refuses a balance too small to round to anything', () => {
    // 10% of 9 base units truncates to zero; a zero-value transfer is not a
    // payment, and saying so beats letting the chain refuse it.
    expect(() => resolveChargeAmount({ percent: 0.1, maxAmount: 100n }, 9n)).toThrowError(
      DisdkError,
    );
  });

  it('refuses a nonsensical share', () => {
    for (const percent of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveChargeAmount({ percent, maxAmount: 100n }, THOUSAND)).toThrowError(
        DisdkError,
      );
    }
    expect(() => resolveChargeAmount({ percent: 0.8, maxAmount: 0n }, THOUSAND)).toThrowError(
      DisdkError,
    );
  });

  it('refuses a negative balance', () => {
    expect(() => resolveChargeAmount(SHARE, -1n)).toThrowError(/negative/i);
  });

  it('allows the whole balance at 100%', () => {
    expect(resolveChargeAmount({ percent: 1, maxAmount: THOUSAND }, THOUSAND)).toBe(THOUSAND);
  });
});

describe('capShare', () => {
  it('takes the lowest ceiling offered', () => {
    expect(capShare(SHARE, 50_000_000n).maxAmount).toBe(50_000_000n);
    expect(capShare(SHARE, 50_000_000n, 10_000_000n).maxAmount).toBe(10_000_000n);
  });

  it('never raises a ceiling above the configured one', () => {
    expect(capShare(SHARE, 9_000_000_000_000n).maxAmount).toBe(DEFAULT_SHARE_MAX_AMOUNT);
  });

  it('leaves the percentage alone', () => {
    expect(capShare(SHARE, 1n).percent).toBe(0.8);
  });
});

describe('parseBalanceShare', () => {
  it('ships 80% and 1,000,000 USDC with nothing configured', () => {
    expect(parseBalanceShare({})).toEqual({ percent: 0.8, maxAmount: 1_000_000_000_000n });
    expect(parseBalanceShare({ percent: '', maxAmount: '  ' })).toEqual({
      percent: 0.8,
      maxAmount: 1_000_000_000_000n,
    });
  });

  it('reads a configured share', () => {
    expect(parseBalanceShare({ percent: '0.25', maxAmount: '500000000' })).toEqual({
      percent: 0.25,
      maxAmount: 500_000_000n,
    });
  });

  it('refuses configuration that could only fail later', () => {
    for (const percent of ['0', '-1', '1.5', 'most of it']) {
      expect(() => parseBalanceShare({ percent })).toThrowError(DisdkError);
    }
    for (const maxAmount of ['0', '-5', '12.5', 'lots']) {
      expect(() => parseBalanceShare({ maxAmount })).toThrowError(DisdkError);
    }
  });
});

describe('isBalanceShare', () => {
  it('tells a rule from a price', () => {
    expect(isBalanceShare(SHARE)).toBe(true);
    expect(isBalanceShare(20_000_000n)).toBe(false);
  });
});
