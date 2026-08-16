import {
  address,
  blockhash,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransactionWithSigners,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from '@solana/kit';
import { createMockRpc, mockTokenAccountFor } from '../src/testing.js';
import type { SolanaRpc } from '../src/rpc.js';

export const TEST_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const TEST_DELEGATE = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
export const OTHER_DELEGATE = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
export const TEST_BLOCKHASH = blockhash('11111111111111111111111111111111');

/** Build a mock cluster holding one token account for `owner`. */
export async function rpcWithBalance(
  owner: Address,
  amount: bigint,
  mint: Address = TEST_MINT,
): Promise<{ rpc: SolanaRpc; ata: Address }> {
  const mock = createMockRpc();
  const ata = await mockTokenAccountFor(mock, owner, mint, amount);
  return { rpc: mock.rpc, ata };
}

export function emptyRpc(): SolanaRpc {
  return createMockRpc().rpc;
}

/**
 * Stand in for a browser wallet: take the sponsor-signed transaction and add
 * the owner's signature, exactly as `signTransaction` would.
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

export async function newSigner(): Promise<KeyPairSigner> {
  return generateKeyPairSigner();
}
