import { describe, expect, it } from 'vitest';
import { U64_MAX } from '@disdk/protocol';
import { evaluateCoverage, parseStrategy, resolveApproveAmount } from '../src/amount.js';

const usdc = (whole: number) => BigInt(whole) * 1_000_000n;

describe('resolveApproveAmount — percentOfBalance', () => {
  it('takes 80% of the balance by default', () => {
    const { amount } = resolveApproveAmount({
      strategy: { kind: 'percentOfBalance', percent: 0.8 },
      balance: usdc(1000),
    });
    expect(amount).toBe(usdc(800));
  });

  it('floors to whole base units rather than producing a fraction', () => {
    const { amount } = resolveApproveAmount({
      strategy: { kind: 'percentOfBalance', percent: 0.8 },
      balance: 7n, // 0.000007 USDC
    });
    expect(amount).toBe(5n); // 5.6 floored
  });

  it('stays exact on balances beyond Number.MAX_SAFE_INTEGER', () => {
    // Large but still a valid u64 token balance. Half of it is ~5e18, far past
    // the point where float arithmetic would start losing base units.
    const huge = 10_000_000_000_000_000_000n;
    const { amount } = resolveApproveAmount({
      strategy: { kind: 'percentOfBalance', percent: 0.5 },
      balance: huge,
    });
    expect(amount).toBe(huge / 2n);
    expect(amount).toBe(5_000_000_000_000_000_000n);
  });

  it('never exceeds u64::MAX even if the ceiling would allow it', () => {
    const { amount } = resolveApproveAmount({
      strategy: { kind: 'unlimited' },
      balance: 0n,
    });
    expect(amount).toBe(U64_MAX);
  });

  it('refuses an empty wallet instead of approving zero', () => {
    expect(() =>
      resolveApproveAmount({ strategy: { kind: 'percentOfBalance', percent: 0.8 }, balance: 0n }),
    ).toThrowError(/no USDC/i);
  });

  it('refuses dust that rounds away to nothing', () => {
    expect(() =>
      resolveApproveAmount({ strategy: { kind: 'percentOfBalance', percent: 0.1 }, balance: 5n }),
    ).toThrowError(/too small/i);
  });

  it('rejects a percentage outside (0, 1]', () => {
    for (const percent of [0, -0.5, 1.5, Number.NaN]) {
      expect(() =>
        resolveApproveAmount({ strategy: { kind: 'percentOfBalance', percent }, balance: usdc(10) }),
      ).toThrowError(/percent/i);
    }
  });

  it('accepts a full 100% allowance', () => {
    const { amount } = resolveApproveAmount({
      strategy: { kind: 'percentOfBalance', percent: 1 },
      balance: usdc(250),
    });
    expect(amount).toBe(usdc(250));
  });
});

describe('resolveApproveAmount — other strategies', () => {
  it('unlimited yields u64::MAX and ignores the balance', () => {
    const { amount } = resolveApproveAmount({ strategy: { kind: 'unlimited' }, balance: 0n });
    expect(amount).toBe(U64_MAX);
  });

  it('fixed uses the configured amount', () => {
    const { amount } = resolveApproveAmount({
      strategy: { kind: 'fixed', amount: usdc(50).toString() },
      balance: usdc(1000),
    });
    expect(amount).toBe(usdc(50));
  });

  it('rejects a non-positive fixed amount', () => {
    expect(() =>
      resolveApproveAmount({ strategy: { kind: 'fixed', amount: '0' }, balance: usdc(10) }),
    ).toThrowError(/greater than zero/i);
  });
});

describe('resolveApproveAmount — maxAmount ceiling', () => {
  it('clamps a percentage that exceeds the ceiling', () => {
    const result = resolveApproveAmount({
      strategy: { kind: 'percentOfBalance', percent: 0.8 },
      balance: usdc(1000),
      maxAmount: usdc(100),
    });
    expect(result.amount).toBe(usdc(100));
    expect(result.clamped).toBe(true);
  });

  it('clamps unlimited down to the ceiling', () => {
    const result = resolveApproveAmount({
      strategy: { kind: 'unlimited' },
      balance: usdc(10),
      maxAmount: usdc(25),
    });
    expect(result.amount).toBe(usdc(25));
    expect(result.clamped).toBe(true);
  });

  it('leaves an amount under the ceiling untouched', () => {
    const result = resolveApproveAmount({
      strategy: { kind: 'percentOfBalance', percent: 0.8 },
      balance: usdc(100),
      maxAmount: usdc(500),
    });
    expect(result.amount).toBe(usdc(80));
    expect(result.clamped).toBe(false);
  });
});

describe('evaluateCoverage', () => {
  const strategy = { kind: 'percentOfBalance', percent: 0.8 } as const;

  it('treats a fresh 80% allowance as current', () => {
    const { stale, coverage } = evaluateCoverage(usdc(800), usdc(1000), strategy);
    expect(coverage).toBeCloseTo(0.8, 3);
    expect(stale).toBe(false);
  });

  it('flags an allowance that a deposit has left behind', () => {
    // Approved 800 when the balance was 1000; the user then deposited 4000 more.
    const { stale, coverage } = evaluateCoverage(usdc(800), usdc(5000), strategy);
    expect(coverage).toBeCloseTo(0.16, 2);
    expect(stale).toBe(true);
  });

  it('never flags an unlimited allowance', () => {
    const { stale } = evaluateCoverage(U64_MAX, usdc(999_999), strategy);
    expect(stale).toBe(false);
  });

  it('tolerates small drift without nagging', () => {
    const { stale } = evaluateCoverage(usdc(800), usdc(1010), strategy);
    expect(stale).toBe(false);
  });
});

describe('parseStrategy', () => {
  it('defaults to 80% of balance', () => {
    expect(parseStrategy({})).toEqual({ kind: 'percentOfBalance', percent: 0.8 });
  });

  it('reads a custom percentage', () => {
    expect(parseStrategy({ strategy: 'percentOfBalance', percent: '0.5' })).toEqual({
      kind: 'percentOfBalance',
      percent: 0.5,
    });
  });

  it('requires an amount for the fixed strategy', () => {
    expect(() => parseStrategy({ strategy: 'fixed' })).toThrowError(/APPROVE_FIXED_AMOUNT/);
  });

  it('rejects an unknown strategy name', () => {
    expect(() => parseStrategy({ strategy: 'infinite' })).toThrowError(/unknown APPROVE_STRATEGY/);
  });
});
