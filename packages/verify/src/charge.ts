import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { DisdkError, formatTokenAmount } from '@disdk/protocol';
import { MEMO_PROGRAM_ADDRESS } from './build.js';
import { deriveAta, readTokenAccount } from './token.js';
import { withRpc, type SolanaRpc } from './rpc.js';

export interface ChargeConfig {
  mint: Address;
  decimals: number;
  symbol: string;
  /** Where funds land. Configuration, never a caller-supplied value. */
  treasury: Address;
  tokenProgram?: Address;
  createTreasuryAtaIfMissing?: boolean;
}

export interface BuiltCharge {
  transactionBase64: string;
  owner: Address;
  from: Address;
  to: Address;
  amount: bigint;
  amountUi: string;
  /** The payer's balance when the charge was built. */
  balanceAtBuild: bigint;
  /** Allowance remaining after this charge, if it lands. */
  allowanceAfter: bigint;
  feePayer: Address;
  blockhash: string;
  lastValidBlockHeight: bigint;
}

/**
 * Build the transfer a delegate is entitled to make.
 *
 * This is the other side of `buildPermitTransaction`: the user is not present
 * and does not sign. The delegate's own signature is the entire authority, and
 * the on-chain `delegatedAmount` is the only thing bounding it — which is why
 * every precondition is checked here before a signature is produced, and why
 * the destination comes from configuration rather than from the caller.
 */
export async function buildChargeTransaction(
  rpc: SolanaRpc,
  delegate: TransactionSigner,
  owner: Address,
  amount: bigint,
  config: ChargeConfig,
  options: { reference?: string; feePayer?: TransactionSigner } = {},
): Promise<BuiltCharge> {
  if (amount <= 0n) {
    throw new DisdkError('AMOUNT_TOO_SMALL', 'A charge must be greater than zero.');
  }

  const tokenProgram = config.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const view = await readTokenAccount(rpc, owner, config.mint, tokenProgram);
  const money = (value: bigint) => `${formatTokenAmount(value, config.decimals)} ${config.symbol}`;

  if (!view.exists) {
    throw new DisdkError(
      'INSUFFICIENT_BALANCE',
      `That wallet has no ${config.symbol} token account.`,
    );
  }

  // The delegate recorded on chain is the authority the token program will
  // check. If the user revoked, or approved someone else since, this charge
  // would fail at execution — catching it here turns a cryptic simulation error
  // into a clear one, and avoids paying a fee to learn it.
  if (view.delegate === null) {
    throw new DisdkError(
      'CHARGE_REFUSED',
      'That wallet has no active allowance. It was never approved, or it has been revoked.',
    );
  }
  if (view.delegate !== delegate.address) {
    throw new DisdkError(
      'CHARGE_REFUSED',
      `That wallet's allowance belongs to ${view.delegate}, not to this service.`,
    );
  }
  if (view.delegatedAmount < amount) {
    throw new DisdkError(
      'CHARGE_REFUSED',
      `The remaining allowance is ${money(view.delegatedAmount)}, less than the ${money(amount)} charge. Ask the user to top up.`,
    );
  }
  if (view.balance < amount) {
    throw new DisdkError(
      'INSUFFICIENT_BALANCE',
      `That wallet holds ${money(view.balance)}, less than the ${money(amount)} charge.`,
    );
  }

  const treasuryAta = await deriveAta(config.treasury, config.mint, tokenProgram);
  const payer = options.feePayer ?? delegate;
  const instructions: Instruction[] = [];

  if (options.reference) {
    instructions.push(memoInstruction(options.reference));
  }

  if (config.createTreasuryAtaIfMissing) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: treasuryAta,
        owner: config.treasury,
        mint: config.mint,
        tokenProgram,
      }),
    );
  } else {
    const treasuryView = await readTokenAccount(rpc, config.treasury, config.mint, tokenProgram);
    if (!treasuryView.exists) {
      throw new DisdkError(
        'INTERNAL_ERROR',
        `The treasury ${config.treasury} has no ${config.symbol} token account. Create one, or set CHARGE_CREATE_TREASURY_ATA=true.`,
      );
    }
  }

  instructions.push(
    getTransferCheckedInstruction(
      {
        source: view.ata,
        mint: config.mint,
        destination: treasuryAta,
        // The delegate signs as the authority. The owner is not involved.
        authority: delegate,
        amount,
        decimals: config.decimals,
      },
      { programAddress: tokenProgram },
    ),
  );

  const { value: latest } = await withRpc('preparing the charge', () =>
    rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  // Fully signed: unlike a permit, there is no empty signature slot waiting on
  // a wallet.
  const transaction = await signTransactionMessageWithSigners(message);

  return {
    transactionBase64: getBase64EncodedWireTransaction(transaction),
    owner,
    from: view.ata,
    to: treasuryAta,
    amount,
    amountUi: formatTokenAmount(amount, config.decimals),
    balanceAtBuild: view.balance,
    allowanceAfter: view.delegatedAmount - amount,
    feePayer: payer.address,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

/** A memo carries arbitrary bytes and no accounts, so it cannot affect funds. */
function memoInstruction(reference: string): Instruction {
  return {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: new TextEncoder().encode(`disdk:charge:${reference}`),
  };
}
