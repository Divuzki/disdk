/**
 * In-memory Solana stand-in.
 *
 * Lets the whole checkout protocol — issue, sign, verify, submit, confirm — run
 * in CI with no network and no funded keypair. Only the RPC methods this
 * project actually calls are implemented.
 */

import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  none,
  some,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';
import {
  AccountState,
  TOKEN_PROGRAM_ADDRESS,
  getMintEncoder,
  getTokenEncoder,
} from '@solana-program/token';
import { deriveAta } from './token.js';
import type { SolanaRpc } from './rpc.js';

export interface MockTokenAccount {
  mint: Address;
  owner: Address;
  amount: bigint;
  delegate?: Address;
  delegatedAmount?: bigint;
  /** Defaults to the classic token program. Set for Token-2022 accounts. */
  tokenProgram?: Address;
}

export interface MockMint {
  decimals: number;
  /** Defaults to the classic token program. Set for Token-2022 mints. */
  tokenProgram?: Address;
}

/**
 * The address lookup table account layout, as the on-chain program writes it:
 * a u32 discriminator, the deactivation slot, the last-extended slot and its
 * start index, an optional authority, two bytes of padding, then the addresses.
 */
const ALT_HEADER_SIZE = 56;

function encodeLookupTable(addresses: readonly Address[]): Uint8Array {
  const bytes = new Uint8Array(ALT_HEADER_SIZE + addresses.length * 32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  // Never deactivated: u64 max.
  view.setBigUint64(4, 0xffffffffffffffffn, true);
  view.setBigUint64(12, 0n, true);
  bytes[20] = 0;
  // No authority, so nothing can extend it out from under a test.
  bytes[21] = 0;

  const encoder = getBase58Encoder();
  addresses.forEach((address, index) => {
    bytes.set(encoder.encode(address), ALT_HEADER_SIZE + index * 32);
  });
  return bytes;
}

function encodeTokenAccount(account: MockTokenAccount): ReadonlyUint8Array {
  return getTokenEncoder().encode({
    mint: account.mint,
    owner: account.owner,
    amount: account.amount,
    delegate: account.delegate ? some(account.delegate) : none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: account.delegatedAmount ?? 0n,
    closeAuthority: none(),
  });
}

export interface MockRpcOptions {
  tokenAccounts?: Map<Address, MockTokenAccount>;
  blockHeight?: bigint;
  /** Force submission to fail, to exercise the error paths. */
  failSubmit?: boolean;
}

export interface MockRpc {
  rpc: SolanaRpc;
  /** Transactions accepted by `sendTransaction`, keyed by signature. */
  submitted: Map<string, string>;
  setTokenAccount(ata: Address, account: MockTokenAccount): void;
  /** Set an account's SOL balance, for exercising the fee-payer fallback. */
  setLamports(addr: Address, lamports: bigint): void;
  /** Register a mint, so the builder can read its real decimals and program. */
  setMint(mint: Address, mint_: MockMint): void;
  /** Register an address lookup table with the addresses it contains. */
  setLookupTable(table: Address, addresses: readonly Address[]): void;
}

const TEST_BLOCKHASH = '11111111111111111111111111111111';

export function createMockRpc(options: MockRpcOptions = {}): MockRpc {
  const tokenAccounts = options.tokenAccounts ?? new Map<Address, MockTokenAccount>();
  const mints = new Map<Address, MockMint>();
  const lookupTables = new Map<Address, readonly Address[]>();
  const submitted = new Map<string, string>();
  const lamports = new Map<Address, bigint>();

  const accountInfoFor = (addr: Address) => {
    const account = tokenAccounts.get(addr);
    if (account) {
      const encoded = encodeTokenAccount(account);
      return {
        data: [getBase64Decoder().decode(encoded), 'base64'],
        executable: false,
        lamports: 2_039_280n,
        owner: account.tokenProgram ?? TOKEN_PROGRAM_ADDRESS,
        rentEpoch: 0n,
        space: BigInt(encoded.length),
      };
    }

    const mint = mints.get(addr);
    if (mint) {
      const encoded = getMintEncoder().encode({
        mintAuthority: none(),
        supply: 0n,
        decimals: mint.decimals,
        isInitialized: true,
        freezeAuthority: none(),
      });
      return {
        data: [getBase64Decoder().decode(encoded), 'base64'],
        executable: false,
        lamports: 1_461_600n,
        owner: mint.tokenProgram ?? TOKEN_PROGRAM_ADDRESS,
        rentEpoch: 0n,
        space: BigInt(encoded.length),
      };
    }

    const table = lookupTables.get(addr);
    if (table) {
      const encoded = encodeLookupTable(table);
      return {
        data: [getBase64Decoder().decode(encoded), 'base64'],
        executable: false,
        lamports: 1_000_000n,
        owner: 'AddressLookupTab1e1111111111111111111111111' as Address,
        rentEpoch: 0n,
        space: BigInt(encoded.length),
      };
    }

    return null;
  };

  const rpc = {
    // Defaults to a comfortably funded sponsor, so every existing test keeps
    // the sponsor-pays behaviour without opting in to anything.
    getBalance(addr: Address) {
      return {
        send: async () => ({
          context: { slot: 1n },
          value: lamports.get(addr) ?? 1_000_000_000n,
        }),
      };
    },
    getAccountInfo(addr: Address) {
      return {
        send: async () => ({ context: { slot: 1n }, value: accountInfoFor(addr) }),
      };
    },

    getMultipleAccounts(addresses: readonly Address[]) {
      return {
        send: async () => ({
          context: { slot: 1n },
          value: addresses.map((addr) => accountInfoFor(addr)),
        }),
      };
    },

    getTokenAccountsByOwner(
      owner: Address,
      filter: { programId: Address },
      _config: { encoding: 'base64' },
    ) {
      return {
        send: async () => ({
          context: { slot: 1n },
          value: [...tokenAccounts.entries()]
            .filter(
              ([, account]) =>
                account.owner === owner &&
                (account.tokenProgram ?? TOKEN_PROGRAM_ADDRESS) === filter.programId,
            )
            .map(([pubkey, account]) => ({
              pubkey,
              account: {
                data: [getBase64Decoder().decode(encodeTokenAccount(account)), 'base64'],
                executable: false,
                lamports: 2_039_280n,
                owner: filter.programId,
                rentEpoch: 0n,
                space: 165n,
              },
            })),
        }),
      };
    },

    getLatestBlockhash() {
      return {
        send: async () => ({
          context: { slot: 1n },
          value: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: 1000n },
        }),
      };
    },

    getBlockHeight() {
      return { send: async () => options.blockHeight ?? 500n };
    },

    sendTransaction(transactionBase64: string) {
      return {
        send: async () => {
          if (options.failSubmit) throw new Error('simulated RPC failure');
          const signature = signatureOf(transactionBase64);
          submitted.set(signature, transactionBase64);
          return signature;
        },
      };
    },

    getSignatureStatuses(signatures: string[]) {
      return {
        send: async () => ({
          context: { slot: 1n },
          value: signatures.map((signature) =>
            submitted.has(signature)
              ? { confirmationStatus: 'confirmed', err: null, slot: 1n, confirmations: 1n }
              : null,
          ),
        }),
      };
    },

    getTransaction(signature: string) {
      return {
        send: async () => {
          const stored = submitted.get(signature);
          if (!stored) return null;
          return { meta: { err: null }, transaction: [stored, 'base64'], slot: 1n };
        },
      };
    },
  };

  return {
    rpc: rpc as unknown as SolanaRpc,
    submitted,
    setTokenAccount(ata, account) {
      tokenAccounts.set(ata, account);
    },
    setLamports(addr, value) {
      lamports.set(addr, value);
    },
    setMint(mint, value) {
      mints.set(mint, value);
    },
    setLookupTable(table, addresses) {
      lookupTables.set(table, addresses);
    },
  };
}

/**
 * A transaction's id is its first signature, so this mirrors what a real
 * cluster would report back from `sendTransaction`.
 */
export function signatureOf(transactionBase64: string): string {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(transactionBase64),
  );
  const first = Object.values(transaction.signatures)[0];
  if (!first) throw new Error('transaction carries no signatures');
  return getBase58Decoder().decode(first);
}

/** Register a token account for `owner` at the correct associated address. */
export async function mockTokenAccountFor(
  mock: MockRpc,
  owner: Address,
  mint: Address,
  amount: bigint,
  extra: { delegate?: Address; delegatedAmount?: bigint } = {},
): Promise<Address> {
  const ata = await deriveAta(owner, mint);
  mock.setTokenAccount(ata, { mint, owner, amount, ...extra });
  return ata;
}
