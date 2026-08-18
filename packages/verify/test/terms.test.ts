import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import {
  assertWithinTerms,
  chargeHeadroom,
  describeTerms,
  parseChargeTerms,
  type ChargeRecord,
  type ChargeTerms,
} from '../src/terms.js';

const TREASURY = 'Trea5uryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' as Address;
const WALLET = 'Wa11etttttttttttttttttttttttttttttttttttttt' as Address;
const usdc = (whole: number) => BigInt(whole) * 1_000_000n;
const NOW = 1_700_000_000_000;

function terms(overrides: Partial<ChargeTerms> = {}): ChargeTerms {
  return { treasury: TREASURY, periodMs: 24 * 60 * 60 * 1000, ...overrides };
}

function charge(amount: bigint, at: number): ChargeRecord {
  return { wallet: WALLET, amount, at };
}

describe('parseChargeTerms', () => {
  it('requires a treasury', () => {
    expect(() => parseChargeTerms({})).toThrowError(/TREASURY_ADDRESS is required/);
  });

  it('reads base units, not decimals', () => {
    const parsed = parseChargeTerms({ treasury: TREASURY, maxPerCharge: '20000000' });
    expect(parsed.maxPerCharge).toBe(usdc(20));
  });

  it('rejects a per-charge limit above the period limit', () => {
    expect(() =>
      parseChargeTerms({
        treasury: TREASURY,
        maxPerCharge: '100000000',
        maxPerPeriod: '20000000',
      }),
    ).toThrowError(/can never be reached/);
  });

  it('rejects a negative or zero limit rather than treating it as unset', () => {
    expect(() => parseChargeTerms({ treasury: TREASURY, maxPerCharge: '0' })).toThrowError(
      /greater than zero/,
    );
    expect(() => parseChargeTerms({ treasury: TREASURY, minIntervalMs: '-5' })).toThrowError(
      /positive integer/,
    );
  });

  it('leaves every limit unset when only a treasury is given', () => {
    const parsed = parseChargeTerms({ treasury: TREASURY });
    expect(parsed.maxPerCharge).toBeUndefined();
    expect(parsed.maxPerPeriod).toBeUndefined();
    expect(parsed.periodMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe('assertWithinTerms', () => {
  it('refuses a zero or negative charge', () => {
    expect(() => assertWithinTerms(terms(), [], 0n, NOW)).toThrowError(/greater than zero/);
  });

  it('allows a charge inside every limit', () => {
    const t = terms({ maxPerCharge: usdc(20), maxPerPeriod: usdc(100) });
    expect(() => assertWithinTerms(t, [], usdc(15), NOW)).not.toThrow();
  });

  it('refuses a charge above the per-charge limit', () => {
    const t = terms({ maxPerCharge: usdc(20) });
    expect(() => assertWithinTerms(t, [], usdc(25), NOW)).toThrowError(/per-charge limit/);
  });

  it('adds up the rolling window rather than looking at one charge', () => {
    const t = terms({ maxPerPeriod: usdc(100) });
    const history = [charge(usdc(60), NOW - 1000), charge(usdc(30), NOW - 500)];
    expect(() => assertWithinTerms(t, history, usdc(20), NOW)).toThrowError(/above the/);
    expect(() => assertWithinTerms(t, history, usdc(10), NOW)).not.toThrow();
  });

  it('lets the window roll off', () => {
    const t = terms({ maxPerPeriod: usdc(100), periodMs: 60_000 });
    const history = [charge(usdc(90), NOW - 61_000)];
    expect(() => assertWithinTerms(t, history, usdc(90), NOW)).not.toThrow();
  });

  it('enforces a count limit independently of value', () => {
    const t = terms({ maxChargesPerPeriod: 2 });
    const history = [charge(1n, NOW - 2000), charge(1n, NOW - 1000)];
    expect(() => assertWithinTerms(t, history, 1n, NOW)).toThrowError(/times this period/);
  });

  it('enforces a minimum gap between charges', () => {
    const t = terms({ minIntervalMs: 60_000 });
    const history = [charge(usdc(1), NOW - 30_000)];
    expect(() => assertWithinTerms(t, history, usdc(1), NOW)).toThrowError(/Too soon/);
    expect(() => assertWithinTerms(t, history, usdc(1), NOW + 31_000)).not.toThrow();
  });

  it('measures the gap from the most recent charge, not the last one recorded', () => {
    const t = terms({ minIntervalMs: 60_000 });
    const history = [charge(usdc(1), NOW - 10_000), charge(usdc(1), NOW - 90_000)];
    expect(() => assertWithinTerms(t, history, usdc(1), NOW)).toThrowError(/Too soon/);
  });
});

describe('chargeHeadroom', () => {
  it('reports the smaller of the per-charge and remaining-period limits', () => {
    const t = terms({ maxPerCharge: usdc(20), maxPerPeriod: usdc(100) });
    expect(chargeHeadroom(t, [charge(usdc(90), NOW)], NOW).available).toBe(usdc(10));
    expect(chargeHeadroom(t, [charge(usdc(10), NOW)], NOW).available).toBe(usdc(20));
  });

  it('goes to zero once the period is spent', () => {
    const t = terms({ maxPerPeriod: usdc(100) });
    expect(chargeHeadroom(t, [charge(usdc(100), NOW)], NOW).available).toBe(0n);
  });

  it('goes to zero once the count is used up, whatever the value', () => {
    const t = terms({ maxPerCharge: usdc(20), maxChargesPerPeriod: 1 });
    expect(chargeHeadroom(t, [charge(1n, NOW)], NOW).available).toBe(0n);
  });

  it('never reports a negative remainder when history exceeds the cap', () => {
    const t = terms({ maxPerPeriod: usdc(100) });
    expect(chargeHeadroom(t, [charge(usdc(150), NOW)], NOW).available).toBe(0n);
  });
});

describe('describeTerms', () => {
  it('says plainly what the service will and will not do', () => {
    const text = describeTerms(
      terms({ maxPerCharge: usdc(20), maxPerPeriod: usdc(100), minIntervalMs: 60_000 }),
    );
    expect(text).toContain('at most 20.00 USDC per charge');
    expect(text).toContain('at most 100.00 USDC per day');
    expect(text).toContain('every minute');
    expect(text).toContain(TREASURY);
  });

  it('is explicit when there is no per-charge ceiling', () => {
    expect(describeTerms(terms())).toContain('no per-charge limit');
  });
});
