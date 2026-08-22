/**
 * The headless `settleBatch` lifecycle, with the server and the chain faked.
 *
 * Exists mainly to pin the *order* of the checks. The transaction cannot be
 * read before its lookup tables have been fetched, and the destination accounts
 * cannot be checked before the transaction has been read — a version of this
 * flow that got that order wrong still passed every unit test underneath it,
 * because each piece was correct in isolation.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  appendTransactionMessageInstructions,
  address,
  blockhash,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { createDisdk } from '../src/core.js';
import { base58Decode, base64Encode } from '../src/codec.js';
import type { SettlementConnectResponse, SessionPublic } from '@disdk/protocol';

const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const DESTINATION = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const DESTINATION_USDC = address('2rMHUAgtqQXGWs2XLPzuqEXMigYmjFo2dbTdVpuHrTrs');
const SOURCE_USDC = address('So11111111111111111111111111111111111111112');
const TABLE = address('7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const RPC_URL = 'https://rpc.example';

function tokenAccount(mint: string, owner: string) {
  const bytes = new Uint8Array(165);
  bytes.set(base58Decode(mint), 0);
  bytes.set(base58Decode(owner), 32);
  return { owner: TOKEN_PROGRAM, data: [base64Encode(bytes), 'base64'] };
}

function lookupTable(addresses: string[]) {
  const bytes = new Uint8Array(56 + addresses.length * 32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, 0xffffffffffffffffn, true);
  addresses.forEach((a, i) => bytes.set(base58Decode(a), 56 + i * 32));
  return { owner: ALT_PROGRAM, data: [base64Encode(bytes), 'base64'] };
}

async function buildSettlementTx(
  sponsor: KeyPairSigner,
  owner: Address,
  options: { useTable?: boolean } = {},
): Promise<string> {
  const instructions: Instruction[] = [
    getTransferCheckedInstruction({
      source: SOURCE_USDC,
      mint: USDC,
      destination: DESTINATION_USDC,
      authority: createNoopSigner(owner),
      amount: 25_000_000n,
      decimals: 6,
    }),
    {
      programAddress: address('11111111111111111111111111111111'),
      accounts: [
        { address: owner, role: AccountRole.WRITABLE_SIGNER, signer: createNoopSigner(owner) },
        { address: DESTINATION, role: AccountRole.WRITABLE },
      ],
      data: (() => {
        const data = new Uint8Array(12);
        const view = new DataView(data.buffer);
        view.setUint32(0, 2, true);
        view.setBigUint64(4, 2_000_000n, true);
        return data;
      })(),
    } as unknown as Instruction,
  ];

  const base = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sponsor, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 1000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  const message = options.useTable
    ? compressTransactionMessageUsingAddressLookupTables(base, {
        [TABLE]: [TOKEN_PROGRAM as Address, USDC, SOURCE_USDC, DESTINATION_USDC, DESTINATION],
      })
    : base;

  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

/**
 * A wallet that signs anything, and a server and chain that answer honestly.
 * Each test then breaks exactly one of those assumptions.
 */
async function harness(options: { useTable?: boolean } = {}) {
  const sponsor = await generateKeyPairSigner();
  const owner = await generateKeyPairSigner();
  const transaction = await buildSettlementTx(sponsor, owner.address, options);

  const session: SessionPublic = {
    protocolVersion: 1,
    sessionId: 'session-1',
    state: 'connected',
    cluster: 'solana:devnet',
    app: { name: 'test', uri: 'https://test' },
    discord: { id: '1', username: 'tester' },
    mint: USDC,
    mintSymbol: 'USDC',
    decimals: 6,
    sponsor: sponsor.address,
    charge: { treasury: DESTINATION, pricing: 'merchant' },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };

  const issued: SettlementConnectResponse = {
    transaction,
    manifest: {
      sessionId: 'session-1',
      owner: owner.address,
      destination: DESTINATION,
      obligations: [
        { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
        { type: 'sol', amount: '2000000' },
      ],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      manifestHash: 'a'.repeat(32),
    },
    addressLookupTables: options.useTable ? [TABLE] : [],
    feePayer: sponsor.address,
    feePayerRole: 'sponsor',
    owner: owner.address,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    description: 'Campaign settlement',
  };

  return { sponsor, owner, session, issued, transaction };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('settleBatch', () => {
  it('refuses to run without an RPC to check the settlement against', async () => {
    const disdk = createDisdk({ apiBase: 'https://api.example', ui: 'headless' });

    // Refused for the missing RPC specifically, before a wallet is even asked
    // for: no amount of connecting would make an unverifiable settlement safe.
    await expect(disdk.settleBatch()).rejects.toThrow(/rpcUrl/);
  });
});

describe('reviewing a settlement against the chain', () => {
  /**
   * `settleBatch` needs a connected wallet, which needs a browser extension.
   * These exercise the same checks through the pieces it composes, in the same
   * order, so the ordering bug this file exists for stays caught.
   */
  it('reads the lookup table before trying to read the transaction', async () => {
    const h = await harness({ useTable: true });
    const seen: string[][] = [];

    const { resolveChainFacts } = await import('../src/resolve.js');
    const { inspectTransaction, verifySettlementTransaction } = await import('../src/txguard.js');

    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [string[]] };
      seen.push(body.params[0]);
      return json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          value: body.params[0].map((a) =>
            a === TABLE
              ? lookupTable([TOKEN_PROGRAM, USDC, SOURCE_USDC, DESTINATION_USDC, DESTINATION])
              : tokenAccount(USDC, DESTINATION),
          ),
        },
      });
    }) as unknown as typeof fetch;

    const { lookupTables } = await resolveChainFacts({
      rpcUrl: RPC_URL,
      lookupTables: h.issued.addressLookupTables,
      candidates: {},
      destination: DESTINATION,
      fetchImpl,
    });

    // The table had to be fetched first and on its own; the transaction names
    // its accounts by index into it.
    expect(seen[0]).toEqual([TABLE]);
    expect(lookupTables[TABLE]).toHaveLength(5);

    const inspection = inspectTransaction(h.transaction, (t) => lookupTables[t]);
    expect(inspection.transfers[0]?.destination).toBe(DESTINATION_USDC);

    const { destinationAccounts } = await resolveChainFacts({
      rpcUrl: RPC_URL,
      lookupTables: [],
      candidates: { [USDC]: DESTINATION_USDC },
      destination: DESTINATION,
      fetchImpl,
    });

    const verified = verifySettlementTransaction(h.transaction, {
      feePayer: h.sponsor.address,
      owner: h.owner.address,
      destination: DESTINATION,
      obligations: h.issued.manifest.obligations,
      lookupTables,
      destinationAccounts,
    });

    expect(verified.transfers).toHaveLength(2);
    expect(verified.lookupTables).toEqual([TABLE]);
  });

  it('rejects the settlement when the table cannot be read', async () => {
    const h = await harness({ useTable: true });
    const { resolveChainFacts } = await import('../src/resolve.js');

    await expect(
      resolveChainFacts({
        rpcUrl: RPC_URL,
        lookupTables: h.issued.addressLookupTables,
        candidates: {},
        destination: DESTINATION,
        fetchImpl: (async () =>
          json({ jsonrpc: '2.0', id: 1, result: { value: [null] } })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_TRANSACTION' });
  });
});
