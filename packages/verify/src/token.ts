import { getBase64Encoder, type Address, unwrapOption } from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getTokenDecoder,
} from '@solana-program/token';
import { withRpc, type SolanaRpc } from './rpc.js';

/**
 * Token-2022. A public, well-known program address, hardcoded the same way
 * every Solana client hardcodes it — there is no secret here despite what
 * entropy-based secret scanners conclude about base58 public keys.
 */
export const TOKEN_2022_PROGRAM_ADDRESS =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;

/** Both SPL token programs, in the order accounts are enumerated. */
export const TOKEN_PROGRAMS: readonly Address[] = [
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
];

/** Base SPL token account layout size. Token-2022 appends extensions past this. */
const TOKEN_ACCOUNT_BASE_SIZE = 165;

export interface TokenAccountView {
  ata: Address;
  exists: boolean;
  balance: bigint;
  delegate: Address | null;
  delegatedAmount: bigint;
}

export async function deriveAta(
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM_ADDRESS,
): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  return ata;
}

/**
 * Read the owner's associated token account. A missing account is a normal
 * outcome (the wallet has never held this mint), reported as `exists: false`
 * with a zero balance rather than throwing.
 */
export async function readTokenAccount(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM_ADDRESS,
): Promise<TokenAccountView> {
  const ata = await deriveAta(owner, mint, tokenProgram);
  const account = await withRpc('reading your token account', () =>
    fetchMaybeToken(rpc, ata),
  );

  if (!account.exists) {
    return { ata, exists: false, balance: 0n, delegate: null, delegatedAmount: 0n };
  }

  return {
    ata,
    exists: true,
    balance: account.data.amount,
    delegate: unwrapOption(account.data.delegate),
    delegatedAmount: account.data.delegatedAmount,
  };
}

function decodeTokenAccount(
  base64: string,
): { mint: Address; owner: Address; amount: bigint } | null {
  try {
    const bytes = getBase64Encoder().encode(base64);
    if (bytes.length < TOKEN_ACCOUNT_BASE_SIZE) return null;
    // Token-2022 appends extension data past the base layout, so decode only
    // the fixed prefix both programs share.
    const account = getTokenDecoder().decode(bytes.slice(0, TOKEN_ACCOUNT_BASE_SIZE));
    return { mint: account.mint, owner: account.owner, amount: account.amount };
  } catch {
    return null;
  }
}
