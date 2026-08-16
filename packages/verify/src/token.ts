import { type Address, unwrapOption } from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeToken,
  findAssociatedTokenPda,
} from '@solana-program/token';
import { evaluateCoverage } from './amount.js';
import type { AmountStrategy, PermitStatus } from '@disdk/protocol';
import { withRpc, type SolanaRpc } from './rpc.js';

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
