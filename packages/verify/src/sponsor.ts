import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';
import { DisdkError } from '@disdk/protocol';

/**
 * Load the fee-payer keypair that sponsors every permit transaction.
 *
 * Accepts the two formats people actually have on hand: a JSON array of 64
 * bytes (what `solana-keygen` writes) or the same bytes base64-encoded, which
 * is easier to put in an environment variable.
 */
export async function loadSponsorSigner(secret: string): Promise<KeyPairSigner> {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new DisdkError('INTERNAL_ERROR', 'SPONSOR_SECRET_KEY is not set.');
  }

  let bytes: Uint8Array;
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new DisdkError('INTERNAL_ERROR', 'SPONSOR_SECRET_KEY is not valid JSON.');
    }
    if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) {
      throw new DisdkError('INTERNAL_ERROR', 'SPONSOR_SECRET_KEY must be an array of byte values.');
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    bytes = new Uint8Array(Buffer.from(trimmed, 'base64'));
  }

  if (bytes.length !== 64) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      `SPONSOR_SECRET_KEY must decode to 64 bytes, got ${bytes.length}.`,
    );
  }

  return createKeyPairSignerFromBytes(bytes);
}
