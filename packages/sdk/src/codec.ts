/**
 * Base58 and base64 helpers.
 *
 * Deliberately dependency-free: the SDK ships as a CDN bundle that runs on a
 * page holding a user's wallet, so every byte in it should be readable. These
 * are also the only encoding primitives `txguard` needs, which is why the SDK
 * pulls in no Solana library at all.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const BASE58_MAP: Record<string, number> = /* @__PURE__ */ (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    map[BASE58_ALPHABET[i] as string] = i;
  }
  return map;
})();

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] as number) << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // The accumulator seeds with a 0 digit, so drop any that remain at the top;
  // leading zeros are carried by the '1' prefix instead, never by a digit.
  while (digits.length > 1 && digits[digits.length - 1] === 0) digits.pop();
  if (digits.length === 1 && digits[0] === 0) digits.pop();

  let result = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result += '1';
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i] as number];
  }
  return result;
}

export function base58Decode(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);

  const bytes: number[] = [0];
  for (const char of value) {
    const digit = BASE58_MAP[char];
    if (digit === undefined) {
      throw new Error(`Invalid base58 character "${char}"`);
    }
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Same as above: the seed 0 must not become a byte. Leading zero bytes are
  // reconstructed from the '1' prefix only.
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop();

  let leadingZeros = 0;
  for (let i = 0; i < value.length && value[i] === '1'; i++) leadingZeros++;

  const result = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    result[leadingZeros + i] = bytes[bytes.length - 1 - i] as number;
  }
  return result;
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a large transaction cannot blow the argument limit of apply().
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
