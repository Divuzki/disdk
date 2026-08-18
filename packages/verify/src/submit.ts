import type { Signature } from '@solana/kit';
import { DisdkError } from '@disdk/protocol';
import type { BuiltTransaction } from './build.js';
import { withRpc, type SolanaRpc } from './rpc.js';

export interface ConfirmOptions {
  /** How long to wait for confirmation before giving up. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Broadcast a transaction the server has already verified, then wait for it to
 * confirm. Confirmation is polled rather than driven by a websocket so that a
 * deployment only needs an HTTP RPC URL.
 */
export async function submitAndConfirm(
  rpc: SolanaRpc,
  signedTransactionBase64: string,
  expected: Pick<BuiltTransaction, 'lastValidBlockHeight'>,
  options: ConfirmOptions = {},
): Promise<string> {
  let signature: Signature;
  try {
    signature = await rpc
      .sendTransaction(signedTransactionBase64 as Parameters<SolanaRpc['sendTransaction']>[0], {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
        maxRetries: 3n,
      })
      .send();
  } catch (error) {
    throw new DisdkError(
      'SUBMIT_FAILED',
      `Could not broadcast the transaction: ${describe(error)}`,
      isBlockhashExpiry(error),
    );
  }

  await confirmSignature(rpc, signature, expected, options);
  return signature;
}

export async function confirmSignature(
  rpc: SolanaRpc,
  signature: string,
  expected: Pick<BuiltTransaction, 'lastValidBlockHeight'>,
  { timeoutMs = 60_000, pollIntervalMs = 1_000 }: ConfirmOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await withRpc('checking the transaction status', () =>
      rpc
        .getSignatureStatuses([signature as Signature], { searchTransactionHistory: false })
        .send(),
    );
    const status = value[0];

    if (status) {
      if (status.err) {
        throw new DisdkError(
          'SUBMIT_FAILED',
          `Transaction failed on chain: ${JSON.stringify(status.err)}`,
        );
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return;
      }
    }

    // If the chain has moved past the blockhash's validity window and the
    // transaction still has not landed, it never will.
    const blockHeight = await withRpc('checking the block height', () =>
      rpc.getBlockHeight({ commitment: 'confirmed' }).send(),
    );
    if (blockHeight > expected.lastValidBlockHeight) {
      throw new DisdkError(
        'TRANSACTION_EXPIRED',
        'The transaction expired before it was confirmed. Please try again.',
        true,
      );
    }

    await sleep(pollIntervalMs);
  }

  throw new DisdkError(
    'SUBMIT_FAILED',
    'Timed out waiting for the transaction to confirm.',
    true,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBlockhashExpiry(error: unknown): boolean {
  return describe(error).toLowerCase().includes('blockhash');
}
