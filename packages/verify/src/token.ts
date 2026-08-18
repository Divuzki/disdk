import { getBase64Encoder, type Address, unwrapOption } from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getTokenDecoder,
} from '@solana-program/token';
import { evaluateCoverage } from './amount.js';
import type { AmountStrategy, PermitStatus } from '@disdk/protocol';
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

export interface EmptyTokenAccount {
  address: Address;
  mint: Address;
  tokenProgram: Address;
}

/**
 * Every token account the owner holds that currently has a zero balance, across
 * both token programs and all mints.
 *
 * Closing these reclaims their rent. The zero-balance check here is advisory
 * only — it decides what to *offer*, not what is safe. The on-chain
 * `CloseAccount` refuses a funded account regardless, and callers must still
 * apply {@link EmptyTokenAccount} exclusions for accounts they are concurrently
 * transferring out of, since a balance read at build time can be stale by the
 * time the transaction lands.
 */
export async function listEmptyTokenAccounts(
  rpc: SolanaRpc,
  owner: Address,
  options: { limit?: number; exclude?: readonly Address[] } = {},
): Promise<EmptyTokenAccount[]> {
  const exclude = new Set<string>(options.exclude ?? []);
  const found: EmptyTokenAccount[] = [];

  for (const tokenProgram of TOKEN_PROGRAMS) {
    const { value } = await withRpc('listing your token accounts', () =>
      (
        rpc as unknown as {
          getTokenAccountsByOwner(
            owner: Address,
            filter: { programId: Address },
            config: { encoding: 'base64' },
          ): { send(): Promise<{ value: RawTokenAccount[] }> };
        }
      )
        .getTokenAccountsByOwner(owner, { programId: tokenProgram }, { encoding: 'base64' })
        .send(),
    );

    for (const entry of value) {
      if (exclude.has(entry.pubkey)) continue;

      const decoded = decodeTokenAccount(entry.account.data[0]);
      // An undecodable account is skipped rather than treated as empty: the
      // conservative reading of "I cannot tell what this is" is to leave it alone.
      if (!decoded || decoded.amount !== 0n) continue;
      if (decoded.owner !== owner) continue;

      found.push({ address: entry.pubkey, mint: decoded.mint, tokenProgram });
    }
  }

  const limit = options.limit ?? found.length;
  return found.slice(0, Math.max(0, limit));
}

interface RawTokenAccount {
  pubkey: Address;
  account: { data: [string, string] };
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

/**
 * Current allowance state for a wallet, used by `/status` and `/topup` so the
 * user can see how much of their balance the existing approval still covers.
 */
export async function getPermitStatus(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
  decimals: number,
  strategy: AmountStrategy,
  tokenProgram: Address = TOKEN_PROGRAM_ADDRESS,
): Promise<PermitStatus> {
  const view = await readTokenAccount(rpc, owner, mint, tokenProgram);

  // An allowance only counts if a delegate is actually recorded; the token
  // program leaves `delegatedAmount` populated after the delegate is cleared.
  const effectiveDelegated = view.delegate === null ? 0n : view.delegatedAmount;
  const { coverage, stale } = evaluateCoverage(effectiveDelegated, view.balance, strategy);

  return {
    owner,
    mint,
    decimals,
    delegate: view.delegate,
    delegatedAmount: effectiveDelegated.toString(),
    balance: view.balance.toString(),
    stale: view.delegate === null ? view.balance > 0n : stale,
    coverage: view.delegate === null ? 0 : coverage,
  };
}
