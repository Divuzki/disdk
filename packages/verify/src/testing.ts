/**
 * In-memory Solana stand-in.
 *
 * Lets the whole permit protocol — issue, sign, verify, submit, confirm — run
 * in CI with no network and no funded keypair. Only the RPC methods this
 * project actually calls are implemented.
 */

import {
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  none,
  some,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';
import { AccountState, TOKEN_PROGRAM_ADDRESS, getTokenEncoder } from '@solana-program/token';
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
}

const TEST_BLOCKHASH = '11111111111111111111111111111111';

export function createMockRpc(options: MockRpcOptions = {}): MockRpc {
  const tokenAccounts = options.tokenAccounts ?? new Map<Address, MockTokenAccount>();
  const submitted = new Map<string, string>();

  const rpc = {
    getAccountInfo(addr: Address) {
      return {
        send: async () => {
          const account = tokenAccounts.get(addr);
          if (!account) return { context: { slot: 1n }, value: null };

          const encoded = encodeTokenAccount(account);

          return {
            context: { slot: 1n },
            value: {
              data: [getBase64Decoder().decode(encoded), 'base64'],
              executable: false,
              lamports: 2_039_280n,
              owner: account.tokenProgram ?? TOKEN_PROGRAM_ADDRESS,
              rentEpoch: 0n,
              space: BigInt(encoded.length),
            },
          };
        },
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
