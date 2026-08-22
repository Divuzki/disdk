/**
 * The facts the settlement guard refuses to take the server's word for.
 *
 * Two questions cannot be answered from the transaction bytes alone:
 *
 *   - **What is in that lookup table?** A version-0 message names looked-up
 *     accounts by index. The index means nothing without the table's contents,
 *     and the party that sent the transaction is the last party who should be
 *     supplying them.
 *   - **Whose token account is that?** A transfer names a destination token
 *     account, not a wallet. An attacker's account holding the same mint looks
 *     identical in the bytes; the difference is the `owner` field inside the
 *     account, which lives on chain.
 *
 * Both are answered here, by asking a Solana RPC directly. Deriving the
 * associated-token address instead would need PDA maths and an on-curve check
 * in a bundle that deliberately ships no crypto library — and would prove less:
 * a derived address says where the account *should* be, while reading it says
 * who it actually belongs to.
 */

import { DisdkError } from '@disdk/protocol';
import { base58Encode, base64Decode } from './codec.js';

/** Offsets into the SPL token account layout, shared by both token programs. */
const TOKEN_MINT_OFFSET = 0;
const TOKEN_OWNER_OFFSET = 32;

/**
 * Metadata size of an address lookup table, before its addresses begin.
 * Mirrors the on-chain layout; see `packages/verify/src/alt.ts`.
 */
const ALT_META_SIZE = 56;

const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

interface RpcAccount {
  owner: string;
  data: [string, string];
}

/** What a settlement needs looked up before it can be judged. */
export interface ResolvedChainFacts {
  /** Contents of each lookup table, keyed by table address. */
  lookupTables: Record<string, string[]>;
  /** The destination token account for each mint, keyed by mint. */
  destinationAccounts: Record<string, string>;
}

export interface ResolveOptions {
  rpcUrl: string;
  /** Table addresses the transaction references. */
  lookupTables: readonly string[];
  /** Candidate destination token accounts, keyed by the mint they should hold. */
  candidates: Record<string, string>;
  /** The wallet every candidate must belong to. */
  destination: string;
  fetchImpl?: typeof fetch;
}

/**
 * Read the chain for everything the guard cannot infer.
 *
 * Fails closed throughout: an account that cannot be read, is owned by the
 * wrong program, or belongs to the wrong wallet stops the settlement rather
 * than being skipped. A settlement the client cannot fully check is one it
 * should not be putting in front of a user.
 */
export async function resolveChainFacts(options: ResolveOptions): Promise<ResolvedChainFacts> {
  const mints = Object.keys(options.candidates);
  const addresses = [...options.lookupTables, ...mints.map((mint) => options.candidates[mint] as string)];

  const accounts = await getMultipleAccounts(options.rpcUrl, addresses, options.fetchImpl);

  const lookupTables: Record<string, string[]> = {};
  options.lookupTables.forEach((table, index) => {
    const account = accounts[index];
    const contents = decodeLookupTable(account ?? null);
    if (!contents) {
      throw new DisdkError(
        'UNSAFE_TRANSACTION',
        `The lookup table ${table} could not be read, so the accounts it hides cannot be checked.`,
      );
    }
    lookupTables[table] = contents;
  });

  const destinationAccounts: Record<string, string> = {};
  mints.forEach((mint, i) => {
    const candidate = options.candidates[mint] as string;
    const account = accounts[options.lookupTables.length + i];

    if (!account) {
      // A destination account that does not exist yet is legitimate — the
      // transaction may be creating it — but then nothing on chain vouches for
      // it, so the address itself is all there is to go on.
      destinationAccounts[mint] = candidate;
      return;
    }

    const decoded = decodeTokenAccount(account);
    if (!decoded) {
      throw new DisdkError(
        'UNSAFE_TRANSACTION',
        `The destination account ${candidate} is not a token account.`,
      );
    }
    if (decoded.owner !== options.destination) {
      throw new DisdkError(
        'SETTLEMENT_MISMATCH',
        `The destination account ${candidate} belongs to ${decoded.owner}, not to ${options.destination}.`,
      );
    }
    if (decoded.mint !== mint) {
      throw new DisdkError(
        'SETTLEMENT_MISMATCH',
        `The destination account ${candidate} holds a different token.`,
      );
    }

    destinationAccounts[mint] = candidate;
  });

  return { lookupTables, destinationAccounts };
}

function decodeLookupTable(account: RpcAccount | null): string[] | null {
  if (!account || account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) return null;

  const bytes = base64Decode(account.data[0]);
  if (bytes.length < ALT_META_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 1) return null;
  // Deactivated tables stop resolving, so a transaction using one cannot land.
  if (view.getBigUint64(4, true) !== 0xffffffffffffffffn) return null;

  const body = bytes.length - ALT_META_SIZE;
  if (body < 0 || body % 32 !== 0) return null;

  const addresses: string[] = [];
  for (let i = 0; i < body / 32; i++) {
    const start = ALT_META_SIZE + i * 32;
    addresses.push(base58Encode(bytes.subarray(start, start + 32)));
  }
  return addresses;
}

function decodeTokenAccount(account: RpcAccount): { mint: string; owner: string } | null {
  const bytes = base64Decode(account.data[0]);
  // Token-2022 appends extensions past the base layout; the mint and owner sit
  // in the fixed prefix both programs share.
  if (bytes.length < TOKEN_OWNER_OFFSET + 32) return null;

  return {
    mint: base58Encode(bytes.subarray(TOKEN_MINT_OFFSET, TOKEN_MINT_OFFSET + 32)),
    owner: base58Encode(bytes.subarray(TOKEN_OWNER_OFFSET, TOKEN_OWNER_OFFSET + 32)),
  };
}

async function getMultipleAccounts(
  rpcUrl: string,
  addresses: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<(RpcAccount | null)[]> {
  if (addresses.length === 0) return [];

  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [addresses, { encoding: 'base64', commitment: 'confirmed' }],
      }),
    });
  } catch (error) {
    throw new DisdkError(
      'NETWORK_ERROR',
      `Could not reach the Solana network to check this settlement: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
      true,
    );
  }

  if (!response.ok) {
    throw new DisdkError(
      'NETWORK_ERROR',
      `The Solana network responded with ${response.status} while checking this settlement.`,
      response.status >= 500,
    );
  }

  const body = (await response.json()) as {
    result?: { value?: (RpcAccount | null)[] };
    error?: { message?: string };
  };

  if (body.error) {
    throw new DisdkError(
      'NETWORK_ERROR',
      `The Solana network refused the lookup: ${body.error.message ?? 'unknown error'}`,
      true,
    );
  }

  return body.result?.value ?? addresses.map(() => null);
}
