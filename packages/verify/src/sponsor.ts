import {
  createKeyPairSignerFromBytes,
  getAddressFromPublicKey,
  type KeyPairSigner,
} from '@solana/kit';
import { DisdkError } from '@disdk/protocol';

/**
 * Generate a fresh sponsor keypair and return it in the 64-byte encoding
 * `loadSponsorSigner` reads (32-byte seed followed by the public key) — the
 * same layout `solana-keygen` writes.
 *
 * Kit's `generateKeyPairSigner` deliberately produces a non-extractable key,
 * which is the right default for a signer but means it can never be written to
 * a config file. This asks WebCrypto for an extractable key instead, so keep
 * the result out of logs and version control.
 */
export async function generateSponsorKeypair(): Promise<{
  secretKeyBytes: Uint8Array;
  secretKeyBase64: string;
  address: string;
}> {
  // Typed locally: this package targets Node without the DOM lib, which does
  // not declare CryptoKeyPair globally.
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };

  // An Ed25519 PKCS#8 blob ends with the 32-byte private seed.
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));

  const secretKeyBytes = new Uint8Array(64);
  secretKeyBytes.set(pkcs8.slice(-32), 0);
  secretKeyBytes.set(publicKey, 32);

  return {
    secretKeyBytes,
    secretKeyBase64: Buffer.from(secretKeyBytes).toString('base64'),
    address: await getAddressFromPublicKey(keyPair.publicKey),
  };
}

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
