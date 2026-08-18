import { describe, expect, it } from 'vitest';
import {
  DisdkError,
  U64_MAX,
  USDC_DECIMALS,
  USDC_MINTS,
  assertConfirmRequest,
  assertConnectRequest,
  assertBaseUnitAmount,
  assertChargeSessionRequest,
  assertCreateSessionRequest,
  assertSubmitRequest,
  describeStrategy,
  explorerUrl,
  formatTokenAmount,
  isBase64,
  isCluster,
  isLikelyBase58Address,
  isSessionIntent,
  parseTokenAmount,
} from '../src/index.js';

describe('formatTokenAmount', () => {
  // This is what the user reads in the approval modal and in Discord, so it has
  // to be exact — a display bug here is a consent bug.
  it('formats whole and fractional USDC', () => {
    expect(formatTokenAmount(1_000_000n, 6)).toBe('1.00');
    expect(formatTokenAmount(1_500_000n, 6)).toBe('1.50');
    expect(formatTokenAmount(1_234_567n, 6)).toBe('1.234567');
    expect(formatTokenAmount(0n, 6)).toBe('0.00');
  });

  it('groups thousands', () => {
    expect(formatTokenAmount(1_000_000_000n, 6)).toBe('1,000.00');
    expect(formatTokenAmount(1_234_567_890_123n, 6)).toBe('1,234,567.890123');
  });

  it('keeps two decimals but drops insignificant trailing zeros beyond them', () => {
    expect(formatTokenAmount(1_100_000n, 6)).toBe('1.10');
    expect(formatTokenAmount(1_010_000n, 6)).toBe('1.01');
    expect(formatTokenAmount(1_001_000n, 6)).toBe('1.001');
  });

  it('shows an unlimited allowance as words, never as a huge number', () => {
    expect(formatTokenAmount(U64_MAX, 6)).toBe('Unlimited');
  });

  it('handles sub-cent dust without losing precision', () => {
    expect(formatTokenAmount(1n, 6)).toBe('0.000001');
  });

  it('supports zero-decimal tokens', () => {
    expect(formatTokenAmount(1234n, 0)).toBe('1,234');
  });
});

describe('parseTokenAmount', () => {
  it('round-trips through formatTokenAmount', () => {
    for (const value of ['1', '1.5', '0.000001', '1234.56']) {
      const base = parseTokenAmount(value, 6);
      expect(parseTokenAmount(formatTokenAmount(base, 6).replace(/,/g, ''), 6)).toBe(base);
    }
  });

  it('parses decimals into base units', () => {
    expect(parseTokenAmount('1', 6)).toBe(1_000_000n);
    expect(parseTokenAmount('0.5', 6)).toBe(500_000n);
    expect(parseTokenAmount('1.234567', 6)).toBe(1_234_567n);
  });

  it('truncates precision beyond the token decimals rather than rounding up', () => {
    expect(parseTokenAmount('1.2345678', 6)).toBe(1_234_567n);
  });

  it('rejects nonsense', () => {
    for (const bad of ['', 'abc', '1.2.3', '-1', '1e6']) {
      expect(() => parseTokenAmount(bad, 6)).toThrowError(DisdkError);
    }
  });
});

describe('describeStrategy', () => {
  it('describes a percentage in plain words', () => {
    expect(describeStrategy({ kind: 'percentOfBalance', percent: 0.8 }, 'USDC', 6)).toBe(
      '80% of your USDC balance',
    );
  });

  it('spells out that unlimited covers future deposits', () => {
    expect(describeStrategy({ kind: 'unlimited' }, 'USDC', 6)).toContain('future deposits');
  });

  it('describes a fixed amount with its formatted value', () => {
    expect(describeStrategy({ kind: 'fixed', amount: '50000000' }, 'USDC', 6)).toBe('50.00 USDC');
  });
});

describe('request validators', () => {
  it('accepts a well-formed connect request', () => {
    const key = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    expect(assertConnectRequest({ publicKey: key })).toEqual({ publicKey: key });
  });

  it('rejects a bad public key', () => {
    for (const bad of [null, {}, { publicKey: 'nope' }, { publicKey: 123 }]) {
      expect(() => assertConnectRequest(bad)).toThrowError(DisdkError);
    }
  });

  it('rejects a non-object body', () => {
    for (const bad of [null, 'string', 42, []]) {
      expect(() => assertConnectRequest(bad)).toThrowError(/JSON object/);
    }
  });

  it('requires base64 on submit', () => {
    expect(assertSubmitRequest({ signedTransaction: 'AAAA' })).toEqual({
      signedTransaction: 'AAAA',
    });
    expect(() => assertSubmitRequest({ signedTransaction: 'not base64!' })).toThrowError(
      DisdkError,
    );
  });

  it('requires a base58 signature on confirm', () => {
    const signature = '5'.repeat(88);
    expect(assertConfirmRequest({ signature })).toEqual({ signature });
    expect(() => assertConfirmRequest({ signature: 'short' })).toThrowError(DisdkError);
  });

  it('requires a Discord identity when creating a session', () => {
    expect(
      assertCreateSessionRequest({ discord: { id: '1', username: 'a' } }).intent,
    ).toBe('permit');

    expect(() => assertCreateSessionRequest({ discord: { id: '1' } })).toThrowError(/username/);
    expect(() => assertCreateSessionRequest({ discord: { username: 'a' } })).toThrowError(/id/);
  });

  it('rejects an unknown intent', () => {
    expect(() =>
      assertCreateSessionRequest({ discord: { id: '1', username: 'a' }, intent: 'drain' }),
    ).toThrowError(/intent/);
  });

  it('drops unexpected fields rather than passing them through', () => {
    const result = assertCreateSessionRequest({
      discord: { id: '1', username: 'a', isAdmin: true },
      extra: 'ignored',
    });
    expect(result.discord).not.toHaveProperty('isAdmin');
    expect(result).not.toHaveProperty('extra');
  });
});

describe('shape guards', () => {
  it('recognises plausible base58 addresses', () => {
    expect(isLikelyBase58Address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(true);
    // 0, O, I and l are not in the base58 alphabet.
    expect(isLikelyBase58Address('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl')).toBe(false);
    expect(isLikelyBase58Address('short')).toBe(false);
    expect(isLikelyBase58Address(42)).toBe(false);
  });

  it('recognises base64', () => {
    expect(isBase64('AAAA')).toBe(true);
    expect(isBase64('AAA')).toBe(false); // not a multiple of 4
    expect(isBase64('not base64!')).toBe(false);
    expect(isBase64('')).toBe(false);
  });

  it('accepts only the two supported clusters', () => {
    expect(isCluster('solana:mainnet')).toBe(true);
    expect(isCluster('solana:devnet')).toBe(true);
    expect(isCluster('solana:testnet')).toBe(false);
    expect(isCluster('ethereum')).toBe(false);
  });
});

describe('constants and links', () => {
  it('ships distinct mainnet and devnet USDC mints with 6 decimals', () => {
    expect(USDC_MINTS['solana:mainnet']).not.toBe(USDC_MINTS['solana:devnet']);
    expect(isLikelyBase58Address(USDC_MINTS['solana:mainnet'])).toBe(true);
    expect(isLikelyBase58Address(USDC_MINTS['solana:devnet'])).toBe(true);
    expect(USDC_DECIMALS).toBe(6);
  });

  it('builds explorer links with the cluster query only where needed', () => {
    expect(explorerUrl('abc', 'solana:devnet')).toBe(
      'https://explorer.solana.com/tx/abc?cluster=devnet',
    );
    expect(explorerUrl('abc', 'solana:mainnet')).toBe('https://explorer.solana.com/tx/abc');
  });
});

describe('DisdkError', () => {
  it('serialises to the wire body clients expect', () => {
    const error = new DisdkError('RATE_LIMITED', 'Slow down.', true);
    expect(error.toBody()).toEqual({
      error: 'RATE_LIMITED',
      message: 'Slow down.',
      retryable: true,
    });
    expect(error).toBeInstanceOf(Error);
  });

  it('defaults to not retryable', () => {
    expect(new DisdkError('INVALID_REQUEST', 'no').toBody().retryable).toBe(false);
  });
});

describe('charge session requests', () => {
  it('accepts a priced charge session', () => {
    const parsed = assertCreateSessionRequest({
      discord: { id: '1', username: 'merchant' },
      intent: 'charge',
      charge: { amount: '20000000', description: 'Pro plan', reference: 'order-1' },
    });

    expect(parsed.intent).toBe('charge');
    expect(parsed.charge).toEqual({
      amount: '20000000',
      description: 'Pro plan',
      reference: 'order-1',
    });
  });

  // There is no sane default price, and a charge session that reached a browser
  // without one would be completed for an amount nobody chose.
  it('refuses a charge session with no amount', () => {
    expect(() =>
      assertCreateSessionRequest({
        discord: { id: '1', username: 'merchant' },
        intent: 'charge',
      }),
    ).toThrow(DisdkError);
  });

  it('ignores charge details on every other intent', () => {
    const parsed = assertCreateSessionRequest({
      discord: { id: '1', username: 'user' },
      intent: 'permit',
      charge: { amount: '20000000' },
    });

    expect(parsed.charge).toBeUndefined();
  });

  it('accepts charge as a session intent', () => {
    expect(isSessionIntent('charge')).toBe(true);
  });

  it('bounds the reference and description that reach an on-chain memo', () => {
    expect(() =>
      assertChargeSessionRequest({ amount: '1', reference: 'x'.repeat(121) }),
    ).toThrow(/120 characters/i);
    expect(() =>
      assertChargeSessionRequest({ amount: '1', description: 'x'.repeat(201) }),
    ).toThrow(/200 characters/i);
  });
});

describe('assertBaseUnitAmount', () => {
  it('reads an integer string of base units', () => {
    expect(assertBaseUnitAmount('20000000', 'amount')).toBe(20_000_000n);
  });

  // Above 2^53 a JSON number rounds, and it does so silently. Refusing the type
  // outright is the only way a caller finds out before the money moves.
  it('refuses a JSON number outright', () => {
    expect(() => assertBaseUnitAmount(20000000, 'amount')).toThrow(/cannot carry it exactly/i);
  });

  it('refuses zero, negatives, and decimals', () => {
    expect(() => assertBaseUnitAmount('0', 'amount')).toThrow(/greater than zero/i);
    expect(() => assertBaseUnitAmount('-5', 'amount')).toThrow(/base units/i);
    expect(() => assertBaseUnitAmount('20.5', 'amount')).toThrow(/base units/i);
  });

  it('refuses an amount larger than a u64 can hold', () => {
    expect(() => assertBaseUnitAmount((U64_MAX + 1n).toString(), 'amount')).toThrow(
      /larger than a token amount/i,
    );
  });

  it('names the offending field', () => {
    expect(() => assertBaseUnitAmount('nope', 'charge.amount')).toThrow(/charge\.amount/);
  });
});
