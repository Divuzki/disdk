import { describe, expect, it } from 'vitest';
import {
  MAX_SETTLEMENT_OBLIGATIONS,
  assertCreateSettlementSessionRequest,
  assertSettlementObligations,
  canonicalManifestPayload,
  type SettlementObligation,
} from '../src/index.js';

const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const DESTINATION = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

describe('validating requested obligations', () => {
  it('accepts a mixed batch', () => {
    const obligations = assertSettlementObligations([
      { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
      { type: 'sol', amount: '2000000' },
    ]);

    expect(obligations).toHaveLength(2);
    expect(obligations[0]).toMatchObject({ type: 'spl', mint: USDC, amount: '25000000' });
  });

  it('refuses an empty settlement rather than treating it as a no-op', () => {
    expect(() => assertSettlementObligations([])).toThrow(/at least one obligation/i);
  });

  it('refuses anything that is not a list', () => {
    expect(() => assertSettlementObligations({})).toThrow(/must be an array/i);
    expect(() => assertSettlementObligations(undefined)).toThrow(/must be an array/i);
  });

  it('refuses a zero or negative amount', () => {
    expect(() =>
      assertSettlementObligations([{ type: 'spl', mint: USDC, amount: '0' }]),
    ).toThrow(/greater than zero/i);
    expect(() => assertSettlementObligations([{ type: 'sol', amount: '0' }])).toThrow(
      /greater than zero/i,
    );
  });

  it('refuses a JSON number, which cannot carry base units exactly', () => {
    expect(() =>
      assertSettlementObligations([{ type: 'spl', mint: USDC, amount: 25000000 }]),
    ).toThrow(/cannot carry it exactly/i);
  });

  it('refuses an unknown obligation type', () => {
    expect(() => assertSettlementObligations([{ type: 'nft', mint: USDC, amount: '1' }])).toThrow(
      /must be "spl" or "sol"/i,
    );
  });

  it('refuses a malformed mint', () => {
    expect(() =>
      assertSettlementObligations([{ type: 'spl', mint: 'not-an-address', amount: '1' }]),
    ).toThrow(/base58/i);
  });

  it('refuses the same mint twice, which would read as one charge and settle as two', () => {
    expect(() =>
      assertSettlementObligations([
        { type: 'spl', mint: USDC, amount: '1000000' },
        { type: 'spl', mint: USDC, amount: '2000000' },
      ]),
    ).toThrow(/more than once/i);
  });

  it('refuses two SOL lines, which the reviewer would have to add up', () => {
    expect(() =>
      assertSettlementObligations([
        { type: 'sol', amount: '1000000' },
        { type: 'sol', amount: '2000000' },
      ]),
    ).toThrow(/at most one SOL/i);
  });

  it('refuses implausible decimals', () => {
    expect(() =>
      assertSettlementObligations([{ type: 'spl', mint: USDC, amount: '1', decimals: 40 }]),
    ).toThrow(/0-18/);
  });

  it('bounds how many obligations one settlement may carry', () => {
    const many = Array.from({ length: MAX_SETTLEMENT_OBLIGATIONS + 1 }, () => ({
      type: 'sol',
      amount: '1',
    }));
    expect(() => assertSettlementObligations(many)).toThrow(/at most/i);
  });
});

describe('validating a settlement session request', () => {
  const base = {
    discord: { id: '42', username: 'tester' },
    obligations: [{ type: 'spl', mint: USDC, amount: '25000000' }],
  };

  it('accepts a well-formed request', () => {
    const request = assertCreateSettlementSessionRequest(base);
    expect(request.discord.id).toBe('42');
    expect(request.obligations).toHaveLength(1);
  });

  it('requires a discord identity', () => {
    expect(() => assertCreateSettlementSessionRequest({ ...base, discord: {} })).toThrow(
      /discord\.id/,
    );
  });

  it('bounds the description and reference, which reach an on-chain memo', () => {
    expect(() =>
      assertCreateSettlementSessionRequest({ ...base, reference: 'x'.repeat(121) }),
    ).toThrow(/120 characters/i);
    expect(() =>
      assertCreateSettlementSessionRequest({ ...base, description: 'x'.repeat(201) }),
    ).toThrow(/200 characters/i);
  });

  it('takes no destination from the caller', () => {
    const request = assertCreateSettlementSessionRequest({
      ...base,
      destination: 'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG',
    });

    // A destination in the request body is dropped, not honoured: where a
    // settlement lands is server configuration.
    expect(request).not.toHaveProperty('destination');
  });
});

describe('canonicalizing a manifest for hashing', () => {
  const obligations: SettlementObligation[] = [
    { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
    { type: 'sol', amount: '2000000' },
  ];
  const base = {
    sessionId: 'session-1',
    owner: DESTINATION,
    destination: DESTINATION,
    obligations,
    expiresAt: '2026-01-01T00:00:00.000Z',
  };

  it('is stable for the same manifest', () => {
    expect(canonicalManifestPayload(base)).toBe(canonicalManifestPayload(base));
  });

  it('changes when any field changes', () => {
    const payload = canonicalManifestPayload(base);

    expect(canonicalManifestPayload({ ...base, sessionId: 'session-2' })).not.toBe(payload);
    expect(canonicalManifestPayload({ ...base, destination: USDC })).not.toBe(payload);
    expect(canonicalManifestPayload({ ...base, owner: USDC })).not.toBe(payload);
    expect(canonicalManifestPayload({ ...base, expiresAt: '2027-01-01T00:00:00.000Z' })).not.toBe(
      payload,
    );
    expect(
      canonicalManifestPayload({
        ...base,
        obligations: [{ type: 'spl', mint: USDC, amount: '25000001', decimals: 6 }, obligations[1]!],
      }),
    ).not.toBe(payload);
  });

  it('distinguishes obligations that differ only in order', () => {
    const reversed = canonicalManifestPayload({
      ...base,
      obligations: [...obligations].reverse(),
    });
    expect(reversed).not.toBe(canonicalManifestPayload(base));
  });

  it('cannot be confused by a mint that looks like a separator', () => {
    // Field and record separators cannot appear inside a base58 address or a
    // digit string, so no two distinct manifests canonicalize alike.
    const payload = canonicalManifestPayload(base);
    expect(payload.split('|')).toHaveLength(6);
  });
});
