import { describe, expect, it } from 'vitest';
import { resolveChainFacts } from '../src/resolve.js';
import { base58Decode, base64Encode } from '../src/codec.js';

const DESTINATION = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const ATTACKER = 'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DESTINATION_USDC = '2rMHUAgtqQXGWs2XLPzuqEXMigYmjFo2dbTdVpuHrTrs';
const TABLE = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

/** Encode a token account the way the chain stores it. */
function tokenAccount(mint: string, owner: string): { owner: string; data: [string, string] } {
  const bytes = new Uint8Array(165);
  bytes.set(base58Decode(mint), 0);
  bytes.set(base58Decode(owner), 32);
  return { owner: TOKEN_PROGRAM, data: [base64Encode(bytes), 'base64'] };
}

function lookupTable(
  addresses: string[],
  options: { deactivated?: boolean } = {},
): { owner: string; data: [string, string] } {
  const bytes = new Uint8Array(56 + addresses.length * 32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, options.deactivated ? 100n : 0xffffffffffffffffn, true);
  addresses.forEach((a, i) => bytes.set(base58Decode(a), 56 + i * 32));
  return { owner: ALT_PROGRAM, data: [base64Encode(bytes), 'base64'] };
}

/** A fake RPC returning the given accounts, in request order. */
function rpc(accounts: (object | null)[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: accounts } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const BASE = {
  rpcUrl: 'https://rpc.example',
  destination: DESTINATION,
};

describe('reading the chain before signing', () => {
  it('returns a table\'s contents and confirms the destination account', async () => {
    const facts = await resolveChainFacts({
      ...BASE,
      lookupTables: [TABLE],
      candidates: { [USDC]: DESTINATION_USDC },
      fetchImpl: rpc([
        lookupTable([USDC, DESTINATION_USDC]),
        tokenAccount(USDC, DESTINATION),
      ]),
    });

    expect(facts.lookupTables[TABLE]).toEqual([USDC, DESTINATION_USDC]);
    expect(facts.destinationAccounts[USDC]).toBe(DESTINATION_USDC);
  });

  it('refuses a destination account owned by someone else', async () => {
    await expect(
      resolveChainFacts({
        ...BASE,
        lookupTables: [],
        candidates: { [USDC]: DESTINATION_USDC },
        // The right mint, the right-looking address, the wrong owner.
        fetchImpl: rpc([tokenAccount(USDC, ATTACKER)]),
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_MISMATCH' });
  });

  it('refuses a destination account holding a different token', async () => {
    await expect(
      resolveChainFacts({
        ...BASE,
        lookupTables: [],
        candidates: { [USDC]: DESTINATION_USDC },
        fetchImpl: rpc([tokenAccount(ATTACKER, DESTINATION)]),
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_MISMATCH' });
  });

  it('refuses a lookup table that does not exist', async () => {
    await expect(
      resolveChainFacts({
        ...BASE,
        lookupTables: [TABLE],
        candidates: {},
        fetchImpl: rpc([null]),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_TRANSACTION' });
  });

  it('refuses a lookup table owned by the wrong program', async () => {
    await expect(
      resolveChainFacts({
        ...BASE,
        lookupTables: [TABLE],
        candidates: {},
        fetchImpl: rpc([tokenAccount(USDC, DESTINATION)]),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_TRANSACTION' });
  });

  it('refuses a deactivated lookup table', async () => {
    await expect(
      resolveChainFacts({
        ...BASE,
        lookupTables: [TABLE],
        candidates: {},
        fetchImpl: rpc([lookupTable([USDC], { deactivated: true })]),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_TRANSACTION' });
  });

  it('allows a destination account that does not exist yet', async () => {
    // The transaction may be creating it, so absence is not tampering.
    const facts = await resolveChainFacts({
      ...BASE,
      lookupTables: [],
      candidates: { [USDC]: DESTINATION_USDC },
      fetchImpl: rpc([null]),
    });

    expect(facts.destinationAccounts[USDC]).toBe(DESTINATION_USDC);
  });

  it('reports a network failure as retryable rather than as tampering', async () => {
    await expect(
      resolveChainFacts({
        ...BASE,
        lookupTables: [TABLE],
        candidates: {},
        fetchImpl: (async () => {
          throw new Error('offline');
        }) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
  });
});
