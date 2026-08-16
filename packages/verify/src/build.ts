import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  getApproveCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRevokeInstruction,
} from '@solana-program/token';
import { DisdkError, formatTokenAmount, type AmountStrategy } from '@disdk/protocol';
import { resolveApproveAmount } from './amount.js';
import { readTokenAccount } from './token.js';
import { withRpc, type SolanaRpc } from './rpc.js';

/**
 * Everything about a permit that the client cannot be allowed to choose. These
 * come from server configuration only.
 */
/** SPL Memo v2. Inert — it cannot move funds or touch accounts. */
export const MEMO_PROGRAM_ADDRESS = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address;

export interface PermitConfig {
  mint: Address;
  decimals: number;
  symbol: string;
  delegate: Address;
  strategy: AmountStrategy;
  /** Optional ceiling applied on top of the strategy. */
  maxAmount?: bigint;
  tokenProgram?: Address;
  /**
   * Create the owner's associated token account if it is missing, at the
   * sponsor's expense (~0.002 SOL of rent). Keep rate limits tight when this is
   * on: it is the only part of the flow that costs the sponsor more than a fee.
   */
  createAtaIfMissing?: boolean;
}

export interface BuiltTransaction {
  /** Base64 wire transaction, already carrying the sponsor's signature. */
  transactionBase64: string;
  /**
   * The exact compiled message the sponsor signed. Submission must check the
   * client's returned transaction against these bytes.
   */
  expectedMessageBytes: Uint8Array;
  owner: Address;
  ata: Address;
  feePayer: Address;
  amount: bigint;
  amountUi: string;
  balanceAtBuild: bigint;
  blockhash: string;
  lastValidBlockHeight: bigint;
  expiresAt: string;
}

/**
 * Conservative client-facing hint. A blockhash is valid for 150 slots (roughly
 * 60-90 seconds); past this the transaction has to be rebuilt.
 */
const BLOCKHASH_HINT_MS = 60_000;

export async function buildPermitTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  config: PermitConfig,
  sessionNonce?: string,
): Promise<BuiltTransaction> {
  const tokenProgram = config.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const view = await readTokenAccount(rpc, owner, config.mint, tokenProgram);

  // Resolve the amount *before* deciding to create an account, so a wallet with
  // no balance fails cleanly instead of costing the sponsor rent for nothing.
  const resolved = resolveApproveAmount({
    strategy: config.strategy,
    balance: view.balance,
    maxAmount: config.maxAmount,
  });

  if (!view.exists && config.createAtaIfMissing === false) {
    throw new DisdkError(
      'INSUFFICIENT_BALANCE',
      'This wallet has no USDC token account yet.',
    );
  }

  const instructions: Instruction[] = [];
  const ownerSigner = createNoopSigner(owner);

  // Ties this transaction to one session, so an approval cannot be replayed
  // into a different session to bind the wallet to the wrong Discord account.
  if (sessionNonce) instructions.push(memoInstruction(sessionNonce));

  if (!view.exists) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: sponsor,
        ata: view.ata,
        owner,
        mint: config.mint,
        tokenProgram,
      }),
    );
  }

  instructions.push(
    getApproveCheckedInstruction(
      {
        source: view.ata,
        mint: config.mint,
        delegate: config.delegate,
        owner: ownerSigner,
        amount: resolved.amount,
        decimals: config.decimals,
      },
      { programAddress: tokenProgram },
    ),
  );

  return finalize(rpc, sponsor, owner, view.ata, instructions, {
    amount: resolved.amount,
    amountUi: formatTokenAmount(resolved.amount, config.decimals),
    balanceAtBuild: view.balance,
  });
}

export async function buildRevokeTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  config: Pick<PermitConfig, 'mint' | 'decimals' | 'tokenProgram'>,
  sessionNonce?: string,
): Promise<BuiltTransaction> {
  const tokenProgram = config.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const view = await readTokenAccount(rpc, owner, config.mint, tokenProgram);

  if (!view.exists) {
    throw new DisdkError('INSUFFICIENT_BALANCE', 'This wallet has no USDC token account to revoke.');
  }

  const instructions: Instruction[] = [];
  if (sessionNonce) instructions.push(memoInstruction(sessionNonce));
  instructions.push(
    getRevokeInstruction(
      { source: view.ata, owner: createNoopSigner(owner) },
      { programAddress: tokenProgram },
    ),
  );

  return finalize(rpc, sponsor, owner, view.ata, instructions, {
    amount: 0n,
    amountUi: '0',
    balanceAtBuild: view.balance,
  });
}

async function finalize(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  ata: Address,
  instructions: Instruction[],
  amounts: { amount: bigint; amountUi: string; balanceAtBuild: bigint },
): Promise<BuiltTransaction> {
  const { value: latest } = await withRpc('preparing the transaction', () =>
    rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sponsor, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  // The owner is a noop signer, so this fills in the sponsor's signature and
  // leaves the owner's slot empty for the wallet. Critically, the sponsor's
  // signature covers the compiled message: any change the client makes to the
  // instructions, the delegate, the amount, or the fee payer invalidates it and
  // the network rejects the transaction.
  const transaction = await partiallySignTransactionMessageWithSigners(message);

  return {
    transactionBase64: getBase64EncodedWireTransaction(transaction),
    expectedMessageBytes: new Uint8Array(transaction.messageBytes),
    owner,
    ata,
    feePayer: sponsor.address,
    amount: amounts.amount,
    amountUi: amounts.amountUi,
    balanceAtBuild: amounts.balanceAtBuild,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    expiresAt: new Date(Date.now() + BLOCKHASH_HINT_MS).toISOString(),
  };
}

/** A memo carries arbitrary bytes and no accounts, so it cannot affect funds. */
function memoInstruction(note: string): Instruction {
  return {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: new TextEncoder().encode(`disdk:${note}`),
  };
}
