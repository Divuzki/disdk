import {
  address,
  blockhash,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  none,
  partiallySignTransactionWithSigners,
  some,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from '@solana/kit';
import { AccountState, TOKEN_PROGRAM_ADDRESS, getTokenEncoder } from '@solana-program/token';
import { deriveAta } from '../src/token.js';
import type { SolanaRpc } from '../src/rpc.js';

export const TEST_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const TEST_DELEGATE = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
export const OTHER_DELEGATE = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
export const TEST_BLOCKHASH = blockhash('11111111111111111111111111111111');

export interface MockRpcOptions {
  /** Token accounts keyed by address. Absent entries read as "account does not exist". */
  tokenAccounts?: Map<
    Address,
    { mint: Address; owner: Address; amount: bigint; delegate?: Address; delegatedAmount?: bigint }
  >;
  blockHeight?: bigint;
}

/**
 * Minimal RPC stand-in covering only the methods the verifier touches, so the
 * transaction-building and tamper tests run with no network.
 */
export function createMockRpc(options: MockRpcOptions = {}): SolanaRpc {
  const tokenAccounts = options.tokenAccounts ?? new Map();

  const rpc = {
    getAccountInfo(addr: Address) {
      return {
        send: async () => {
          const account = tokenAccounts.get(addr);
          if (!account) return { context: { slot: 1n }, value: null };

          const encoded = getTokenEncoder().encode({
            mint: account.mint,
            owner: account.owner,
            amount: account.amount,
            delegate: account.delegate ? some(account.delegate) : none(),
            state: AccountState.Initialized,
            isNative: none(),
            delegatedAmount: account.delegatedAmount ?? 0n,
            closeAuthority: none(),
          });

          return {
            context: { slot: 1n },
            value: {
              data: [getBase64Decoder().decode(encoded), 'base64'],
              executable: false,
              lamports: 2_039_280n,
              owner: TOKEN_PROGRAM_ADDRESS,
              rentEpoch: 0n,
              space: BigInt(encoded.length),
            },
          };
        },
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
  };

  return rpc as unknown as SolanaRpc;
}

export async function makeTokenAccount(
  owner: Address,
  amount: bigint,
  extra: { mint?: Address; delegate?: Address; delegatedAmount?: bigint } = {},
) {
  const mint = extra.mint ?? TEST_MINT;
  const ata = await deriveAta(owner, mint);
  const map = new Map();
  map.set(ata, {
    mint,
    owner,
    amount,
    delegate: extra.delegate,
    delegatedAmount: extra.delegatedAmount,
  });
  return { ata, map };
}

/**
 * Stand in for a browser wallet: take the sponsor-signed transaction and add the
 * owner's signature, exactly as `signTransaction` would.
 */
export async function walletSign(
  transactionBase64: string,
  owner: KeyPairSigner,
): Promise<string> {
  const transaction = decodeTransaction(transactionBase64);
  const signed = await partiallySignTransactionWithSigners([owner], transaction);
  return getBase64EncodedWireTransaction(signed);
}

export function decodeTransaction(base64: string): Transaction {
  return getTransactionDecoder().decode(getBase64Encoder().encode(base64));
}

export function encodeTransaction(transaction: Transaction): string {
  return getBase64EncodedWireTransaction(
    transaction as Parameters<typeof getBase64EncodedWireTransaction>[0],
  );
}

export async function newSigner(): Promise<KeyPairSigner> {
  return generateKeyPairSigner();
}
