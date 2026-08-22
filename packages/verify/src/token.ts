import { getBase64Encoder, type Address, unwrapOption } from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getMintDecoder,
  getMintSize,
  getTokenDecoder,
} from '@solana-program/token';
import { DisdkError } from '@disdk/protocol';
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

/** What the chain says a mint is, as opposed to what a request claims. */
export interface MintView {
  /** Decimals read from the mint account, never from a caller. */
  decimals: number;
  /** The program that owns the mint, and therefore the one that can move it. */
  tokenProgram: Address;
}

/**
 * Read a mint's real decimals and owning token program.
 *
 * Both matter for a reason worth stating. `TransferChecked` carries decimals in
 * its data and the program rejects the transfer if they disagree with the mint,
 * so a wrong figure here is a failed transaction rather than a wrong one — but
 * it is *shown to the user first*, and a review screen reading "25.00" for a
 * transfer of 25,000,000 base units of a 3-decimal token is a lie the chain
 * never gets asked about. The program is resolved the same way, because a batch
 * may name any mint and Token-2022 mints cannot be moved by the Token program.
 */
export async function readMint(rpc: SolanaRpc, mint: Address): Promise<MintView> {
  const account = await withRpc('reading the token mint', () =>
    rpc.getAccountInfo(mint, { commitment: 'confirmed', encoding: 'base64' }).send(),
  );

  const value = account.value;
  if (!value) {
    throw new DisdkError('UNSUPPORTED_TOKEN', `The mint ${mint} does not exist on this cluster.`);
  }

  const tokenProgram = value.owner;
  if (!TOKEN_PROGRAMS.includes(tokenProgram)) {
    throw new DisdkError(
      'UNSUPPORTED_TOKEN',
      `The mint ${mint} is owned by ${tokenProgram}, which is not an SPL token program.`,
    );
  }

  const [encoded] = value.data as unknown as [string, string];
  const bytes = getBase64Encoder().encode(encoded);
  const size = getMintSize();
  if (bytes.length < size) {
    throw new DisdkError('UNSUPPORTED_TOKEN', `The mint ${mint} is not a readable mint account.`);
  }

  // Token-2022 appends extension data past the base layout, so decode only the
  // fixed prefix both programs share.
  const decoded = getMintDecoder().decode(bytes.slice(0, size));
  return { decimals: decoded.decimals, tokenProgram };
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
