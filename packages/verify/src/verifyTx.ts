import {
  getBase64Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
  type Address,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import { DisdkError } from '@disdk/protocol';
import type { TransactionExpectation } from './build.js';
import { withRpc, type SolanaRpc } from './rpc.js';

export interface VerifiedTransaction {
  transaction: Transaction;
  ownerSignature: SignatureBytes;
}

/**
 * Check a client-returned transaction against the one the server built.
 *
 * The sponsor's signature already binds the exact message cryptographically, so
 * a tampered transaction cannot reach the chain. This check exists so tampering
 * is rejected loudly and locally rather than as an opaque RPC error, and so a
 * transaction from a different session can never be submitted under this one.
 */
export async function verifySignedTransaction(
  signedTransactionBase64: string,
  expected: TransactionExpectation,
): Promise<VerifiedTransaction> {
  let transaction: Transaction;
  try {
    const bytes = getBase64Encoder().encode(signedTransactionBase64);
    transaction = getTransactionDecoder().decode(bytes);
  } catch {
    throw new DisdkError('TRANSACTION_MISMATCH', 'Returned transaction could not be decoded.');
  }

  if (!bytesEqual(transaction.messageBytes, expected.expectedMessageBytes)) {
    throw new DisdkError(
      'TRANSACTION_MISMATCH',
      'The signed transaction does not match the one issued for this session.',
    );
  }

  // Only when the sponsor is paying. Under the fallback the fee payer *is* the
  // owner, already covered by the check below — and naming the sponsor here
  // would blame an account that is not in this transaction at all.
  if (expected.feePayerRole !== 'owner' && !transaction.signatures[expected.feePayer]) {
    throw new DisdkError('TRANSACTION_MISMATCH', 'The sponsor signature is missing.');
  }

  const ownerSignature = transaction.signatures[expected.owner];
  if (!ownerSignature) {
    throw new DisdkError('TRANSACTION_MISMATCH', 'The wallet signature is missing.');
  }

  // Fail fast on a malformed wallet signature rather than paying an RPC round trip.
  const ownerKey = await getPublicKeyFromAddress(expected.owner);
  const valid = await verifySignature(ownerKey, ownerSignature, transaction.messageBytes);
  if (!valid) {
    throw new DisdkError('TRANSACTION_MISMATCH', 'The wallet signature is not valid for this transaction.');
  }

  return { transaction, ownerSignature };
}

/**
 * Verify a transaction the *wallet* broadcast (the `signAndSendTransaction`
 * path, where the server never sees the signed bytes).
 *
 * The on-chain message must be byte-identical to what the server built, which
 * transitively proves the destination, mint, owner, amount and fee payer.
 */
export async function verifyOnChainTransaction(
  rpc: SolanaRpc,
  signature: string,
  expected: Pick<TransactionExpectation, 'expectedMessageBytes'>,
): Promise<void> {
  const result = await withRpc('confirming the transaction', () =>
    rpc
      .getTransaction(signature as Parameters<SolanaRpc['getTransaction']>[0], {
        commitment: 'confirmed',
        encoding: 'base64',
        maxSupportedTransactionVersion: 0,
      })
      .send(),
  );

  if (!result) {
    throw new DisdkError(
      'ON_CHAIN_VERIFY_FAILED',
      'Transaction not found on chain yet.',
      true,
    );
  }

  if (result.meta?.err) {
    throw new DisdkError(
      'ON_CHAIN_VERIFY_FAILED',
      `Transaction failed on chain: ${JSON.stringify(result.meta.err)}`,
    );
  }

  const [encoded] = result.transaction as unknown as [string, string];
  let onChain: Transaction;
  try {
    onChain = getTransactionDecoder().decode(getBase64Encoder().encode(encoded));
  } catch {
    throw new DisdkError('ON_CHAIN_VERIFY_FAILED', 'Could not decode the on-chain transaction.');
  }

  if (!bytesEqual(onChain.messageBytes, expected.expectedMessageBytes)) {
    throw new DisdkError(
      'ON_CHAIN_VERIFY_FAILED',
      'The confirmed transaction does not match the one issued for this session.',
    );
  }
}

export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

export type { Address };
