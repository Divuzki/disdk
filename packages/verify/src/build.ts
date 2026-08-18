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
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import {
  DisdkError,
  formatTokenAmount,
  type AmountStrategy,
  type RentDestination,
} from '@disdk/protocol';
import { resolveApproveAmount } from './amount.js';
import { deriveAta, listEmptyTokenAccounts, readTokenAccount } from './token.js';
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

/**
 * Everything a sweep needs, all of it server configuration.
 *
 * The destination is deliberately not derivable from anything the client sends.
 * A sweep moves funds irreversibly, so the one thing an attacker would most want
 * to control — where the money goes — is fixed at boot.
 */
export interface SweepConfig {
  mint: Address;
  decimals: number;
  symbol: string;
  /** Fixed cold-wallet destination from server config. */
  destination: Address;
  strategy: AmountStrategy;
  maxAmount?: bigint;
  tokenProgram?: Address;
  /** Where rent from closed accounts is sent. */
  rentDestination: RentDestination;
  /** Upper bound on close instructions in one transaction. */
  closeMaxAccounts: number;
}

/**
 * Everything a charge needs, all of it server configuration except the amount —
 * and that comes from the merchant-authenticated call that created the session,
 * never from the browser.
 *
 * Compare {@link SweepConfig}: a sweep sizes itself from a *strategy* applied to
 * whatever the user happens to hold, so the number is only known at build time.
 * A charge is a price. It is decided before the link is minted, and the build
 * step's job is to refuse anything that does not match it.
 */
export interface ChargeSessionConfig {
  mint: Address;
  decimals: number;
  symbol: string;
  /** Merchant treasury wallet from server config. Never client-supplied. */
  treasury: Address;
  tokenProgram?: Address;
  /**
   * Create the treasury's associated token account if missing, at the sponsor's
   * expense. Off by default: the treasury is the merchant's own account, so a
   * missing one is far more likely to be a typo than a new wallet.
   */
  createTreasuryAtaIfMissing?: boolean;
}

export interface SweepCloseDetail {
  account: string;
  mint: string;
  tokenProgram: string;
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
  /** Present only on sweep legs. */
  sweep?: {
    leg: 'transfer' | 'close';
    /** Transfer destination token account, for the transfer leg. */
    destination?: string;
    /** Owner of the destination token account. */
    destinationOwner?: string;
    /** Accounts the close leg closes. */
    closes: SweepCloseDetail[];
    /** Where reclaimed rent goes. */
    rentTo?: string;
  };
  /** Present only on a charge. */
  charge?: {
    /** Treasury token account credited by the transfer. */
    destination: string;
    /** Wallet owning that token account. */
    treasury: string;
    reference?: string;
  };
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

/**
 * Leg one of a sweep: move the configured share of the owner's USDC to the cold
 * wallet, with the sponsor paying the fee.
 *
 * Deliberately does *not* close anything. See {@link buildSweepCloseTransaction}
 * for why the legs are separate.
 */
export async function buildSweepTransferTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  config: SweepConfig,
  sessionNonce?: string,
): Promise<BuiltTransaction> {
  const tokenProgram = config.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;

  if (config.strategy.kind === 'unlimited') {
    throw new DisdkError(
      'INVALID_REQUEST',
      'an unlimited strategy cannot size a one-time transfer',
    );
  }

  const view = await readTokenAccount(rpc, owner, config.mint, tokenProgram);
  if (!view.exists) {
    throw new DisdkError('INSUFFICIENT_BALANCE', 'This wallet has no USDC token account.');
  }

  const resolved = resolveApproveAmount({
    strategy: config.strategy,
    balance: view.balance,
    maxAmount: config.maxAmount,
  });

  if (resolved.amount > view.balance) {
    // A `fixed` strategy can exceed the balance; the transfer would fail on
    // chain anyway, but failing here says why.
    throw new DisdkError(
      'INSUFFICIENT_BALANCE',
      'This wallet does not hold enough USDC for the configured sweep amount.',
    );
  }

  const destinationAta = await deriveAta(config.destination, config.mint, tokenProgram);
  const destinationView = await readTokenAccount(
    rpc,
    config.destination,
    config.mint,
    tokenProgram,
  );

  const instructions: Instruction[] = [];
  const ownerSigner = createNoopSigner(owner);

  if (sessionNonce) instructions.push(memoInstruction(sessionNonce));

  // The cold wallet may never have held this mint. Creating it is idempotent and
  // costs the sponsor rent, which is bounded by the operator allowlist upstream.
  if (!destinationView.exists) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: sponsor,
        ata: destinationAta,
        owner: config.destination,
        mint: config.mint,
        tokenProgram,
      }),
    );
  }

  instructions.push(
    getTransferCheckedInstruction(
      {
        source: view.ata,
        mint: config.mint,
        destination: destinationAta,
        authority: ownerSigner,
        amount: resolved.amount,
        decimals: config.decimals,
      },
      { programAddress: tokenProgram },
    ),
  );

  const built = await finalize(rpc, sponsor, owner, view.ata, instructions, {
    amount: resolved.amount,
    amountUi: formatTokenAmount(resolved.amount, config.decimals),
    balanceAtBuild: view.balance,
  });

  return {
    ...built,
    sweep: {
      leg: 'transfer',
      destination: destinationAta,
      destinationOwner: config.destination,
      closes: [],
    },
  };
}

/**
 * Leg two of a sweep: close the owner's empty token accounts to reclaim rent.
 *
 * Kept separate from the transfer for a correctness reason, not a stylistic one.
 * Solana transactions are atomic, so bundling these together means one
 * un-closeable account — a Token-2022 account whose extensions reject
 * `CloseAccount` even at zero balance — reverts the fund transfer with it. The
 * consolidation is the point; dust hygiene is not worth failing it over.
 */
export async function buildSweepCloseTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  config: SweepConfig,
  sessionNonce?: string,
): Promise<BuiltTransaction> {
  const tokenProgram = config.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const sourceAta = await deriveAta(owner, config.mint, tokenProgram);

  const candidates = await listEmptyTokenAccounts(rpc, owner, {
    limit: config.closeMaxAccounts,
  });

  // Hard invariant, restated here rather than trusted from the enumerator: under
  // the default 80% strategy the source USDC account still holds the remaining
  // 20% after the transfer leg. Closing a funded account would fail on chain,
  // but a *stale* zero reading is the dangerous case — so re-read it directly
  // and drop it unless it is genuinely drained.
  const sourceView = await readTokenAccount(rpc, owner, config.mint, tokenProgram);
  const closes = candidates.filter(
    (candidate) => candidate.address !== sourceAta || sourceView.balance === 0n,
  );

  if (closes.length === 0) {
    throw new DisdkError(
      'INVALID_REQUEST',
      'This wallet has no empty token accounts to close.',
    );
  }

  const rentTo = config.rentDestination === 'cold' ? config.destination : owner;

  const instructions: Instruction[] = [];
  const ownerSigner = createNoopSigner(owner);

  if (sessionNonce) instructions.push(memoInstruction(sessionNonce));

  for (const close of closes) {
    instructions.push(
      getCloseAccountInstruction(
        { account: close.address, destination: rentTo, owner: ownerSigner },
        { programAddress: close.tokenProgram },
      ),
    );
  }

  const built = await finalize(rpc, sponsor, owner, sourceAta, instructions, {
    amount: 0n,
    amountUi: '0',
    balanceAtBuild: sourceView.balance,
  });

  return {
    ...built,
    sweep: {
      leg: 'close',
      closes: closes.map((close) => ({
        account: close.address,
        mint: close.mint,
        tokenProgram: close.tokenProgram,
      })),
      rentTo,
    },
  };
}

/**
 * A one-off payment the user authorizes themselves, with the sponsor paying the
 * network fee.
 *
 * This is the user-present sibling of {@link buildChargeTransaction}. The two
 * reach the same place by opposite routes, and the difference is worth stating
 * plainly because it decides which one a deployment should want:
 *
 * - `buildChargeTransaction` is signed by a *delegate*, off a standing
 *   allowance, while the user is absent. It is how a subscription renews at
 *   3am. It needs a permit first, and the permit is what the user has to trust.
 * - This function is signed by the *owner*, at the moment they are looking at
 *   the amount. It needs no allowance, grants none, and leaves nothing behind
 *   to revoke — the transaction is the entire authorization and it is spent on
 *   use.
 *
 * So this path is strictly the smaller ask of the user, and where a checkout
 * can put them in front of the screen, it should be preferred.
 */
export async function buildChargePaymentTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  amount: bigint,
  config: ChargeSessionConfig,
  sessionNonce?: string,
  reference?: string,
): Promise<BuiltTransaction> {
  if (amount <= 0n) {
    throw new DisdkError('AMOUNT_TOO_SMALL', 'A charge must be greater than zero.');
  }

  const tokenProgram = config.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const money = (value: bigint) => `${formatTokenAmount(value, config.decimals)} ${config.symbol}`;

  const view = await readTokenAccount(rpc, owner, config.mint, tokenProgram);
  if (!view.exists) {
    throw new DisdkError(
      'INSUFFICIENT_BALANCE',
      `This wallet has no ${config.symbol} token account.`,
    );
  }
  if (view.balance < amount) {
    // The transfer would fail on chain anyway. Failing here says why, and does
    // it before the sponsor pays a fee to find out.
    throw new DisdkError(
      'INSUFFICIENT_BALANCE',
      `This wallet holds ${money(view.balance)}, less than the ${money(amount)} charge.`,
    );
  }

  const treasuryAta = await deriveAta(config.treasury, config.mint, tokenProgram);
  const treasuryView = await readTokenAccount(rpc, config.treasury, config.mint, tokenProgram);

  const instructions: Instruction[] = [];
  const ownerSigner = createNoopSigner(owner);

  // Binds the payment to one session, exactly as it does for a permit: without
  // it, two sessions charging the same wallet the same price inside one
  // blockhash window compile to identical bytes, and either could settle the
  // other's invoice.
  if (sessionNonce) {
    instructions.push(memoInstruction(reference ? `${sessionNonce}:${reference}` : sessionNonce));
  }

  if (!treasuryView.exists) {
    if (!config.createTreasuryAtaIfMissing) {
      throw new DisdkError(
        'INTERNAL_ERROR',
        `The treasury ${config.treasury} has no ${config.symbol} token account. Create one, or set CHARGE_CREATE_TREASURY_ATA=true.`,
      );
    }
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: sponsor,
        ata: treasuryAta,
        owner: config.treasury,
        mint: config.mint,
        tokenProgram,
      }),
    );
  }

  instructions.push(
    getTransferCheckedInstruction(
      {
        source: view.ata,
        mint: config.mint,
        destination: treasuryAta,
        // The owner authorizes their own payment. No delegate is involved, and
        // none is created.
        authority: ownerSigner,
        amount,
        decimals: config.decimals,
      },
      { programAddress: tokenProgram },
    ),
  );

  const built = await finalize(rpc, sponsor, owner, view.ata, instructions, {
    amount,
    amountUi: formatTokenAmount(amount, config.decimals),
    balanceAtBuild: view.balance,
  });

  return {
    ...built,
    charge: {
      destination: treasuryAta,
      treasury: config.treasury,
      reference,
    },
  };
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
