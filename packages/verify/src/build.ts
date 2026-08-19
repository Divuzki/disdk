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
  type FeePayerRole,
  type RentDestination,
} from '@disdk/protocol';
import { resolveApproveAmount } from './amount.js';
import { deriveAta, listEmptyTokenAccounts, readTokenAccount } from './token.js';
import { withRpc, type SolanaRpc } from './rpc.js';

/** SPL Memo v2. Inert — it cannot move funds or touch accounts. */
export const MEMO_PROGRAM_ADDRESS = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address;

/** ComputeBudget. Sets what the fee payer bids for block space; moves no funds. */
export const COMPUTE_BUDGET_PROGRAM_ADDRESS =
  'ComputeBudget111111111111111111111111111111' as Address;

/**
 * How a transaction is built, beyond the flow-specific config.
 *
 * One object rather than a growing tail of optional positional arguments —
 * every builder takes the same shape, so adding a knob later does not mean
 * touching five signatures and five call sites again.
 */
export interface BuildOptions {
  /** Who pays the network fee. Defaults to the sponsor. */
  feePayerRole?: FeePayerRole;
  /**
   * Priority fee in micro-lamports per compute unit.
   *
   * Mainnet's base fee alone buys no urgency: under congestion a transaction
   * with no bid can sit until its blockhash expires. Omit on a quiet cluster,
   * set it on mainnet.
   */
  priorityFeeMicroLamports?: bigint;
  /**
   * Compute unit limit. Worth setting alongside a priority fee — the bid is
   * per unit, and the default 200k reservation is far more than these
   * transactions use, so leaving it unset overpays for the same priority.
   */
  computeUnitLimit?: number;
}

/**
 * Everything about a permit that the client cannot be allowed to choose. These
 * come from server configuration only.
 */
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
  /** Which account `feePayer` is, so callers can report it without comparing keys. */
  feePayerRole: FeePayerRole;
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

/**
 * Rent-exempt minimum for an SPL token account, in lamports (~0.00204 SOL).
 *
 * Worth stating because it dwarfs the thing people expect to matter: a
 * signature costs 5,000 lamports, so creating one token account costs the
 * sponsor about four hundred times a fee. A sponsor that has "run out of SOL"
 * has almost always run out of rent, not out of fees.
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/** Base fee per signature, in lamports. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Decide who should pay, by asking whether the sponsor can still afford to.
 *
 * Returns `sponsor` whenever the fallback is off, so the default behaviour —
 * the whole premise of this SDK — cannot change by accident. `owner` is only
 * ever the answer when the sponsor genuinely cannot cover the work.
 */
export async function resolveFeePayer(
  rpc: SolanaRpc,
  sponsor: Address,
  options: { fallbackEnabled: boolean; minLamports?: bigint },
): Promise<FeePayerRole> {
  if (!options.fallbackEnabled) return 'sponsor';

  const floor = options.minLamports ?? TOKEN_ACCOUNT_RENT_LAMPORTS + LAMPORTS_PER_SIGNATURE * 4n;

  const { value: lamports } = await withRpc('checking the sponsor balance', () =>
    rpc.getBalance(sponsor, { commitment: 'confirmed' }).send(),
  );

  return lamports < floor ? 'owner' : 'sponsor';
}

/**
 * Who pays the rent for an account this transaction creates.
 *
 * Rent has to follow the fee payer. Naming the sponsor here while the owner
 * pays the fee drags a dry sponsor back in as a required signer, and asks it
 * for 2,039,280 lamports — four hundred times the fee we just handed over
 * precisely because it could not cover one. The fallback would then fail on the
 * rent instead of the fee, which is the failure it exists to prevent, so the
 * two decisions are made together rather than independently.
 */
function rentPayer(
  sponsor: TransactionSigner,
  owner: TransactionSigner,
  options: BuildOptions,
): TransactionSigner {
  return options.feePayerRole === 'owner' ? owner : sponsor;
}

export async function buildPermitTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  config: PermitConfig,
  sessionNonce?: string,
  options: BuildOptions = {},
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
        payer: rentPayer(sponsor, ownerSigner, options),
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
  }, options);
}

export async function buildRevokeTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  config: Pick<PermitConfig, 'mint' | 'decimals' | 'tokenProgram'>,
  sessionNonce?: string,
  options: BuildOptions = {},
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
  }, options);
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
  options: BuildOptions = {},
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
        payer: rentPayer(sponsor, ownerSigner, options),
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
  }, options);

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
  options: BuildOptions = {},
): Promise<BuiltTransaction> {
  const tokenProgram = config.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const sourceAta = await deriveAta(owner, config.mint, tokenProgram);

  const candidates = await listEmptyTokenAccounts(rpc, owner, {
    limit: config.closeMaxAccounts,
  });

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
  }, options);

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
  options: BuildOptions = {},
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
        payer: rentPayer(sponsor, ownerSigner, options),
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
  }, options);

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
  options: BuildOptions = {},
): Promise<BuiltTransaction> {
  const { value: latest } = await withRpc('preparing the transaction', () =>
    rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
  );

  const feePayerRole = options.feePayerRole ?? 'sponsor';

  // When the owner pays, the sponsor is not a signer at all: the owner already
  // signs every flow here as the token authority, so the transaction goes from
  // two signatures to one rather than gaining any.
  const payer: TransactionSigner =
    feePayerRole === 'owner' ? createNoopSigner(owner) : sponsor;

  // ComputeBudget instructions must come first to be honoured, and they are
  // prepended here rather than in each builder so no flow can forget them.
  const budget: Instruction[] = [];
  if (options.computeUnitLimit !== undefined) {
    budget.push(computeUnitLimitInstruction(options.computeUnitLimit));
  }
  if (options.priorityFeeMicroLamports !== undefined) {
    budget.push(computeUnitPriceInstruction(options.priorityFeeMicroLamports));
  }

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions([...budget, ...instructions], m),
  );

  // The owner is a noop signer, so this fills in the sponsor's signature and
  // leaves the owner's slot empty for the wallet. Critically, the sponsor's
  // signature covers the compiled message: any change the client makes to the
  // instructions, the delegate, the amount, or the fee payer invalidates it and
  // the network rejects the transaction.
  //
  // Under `owner` there is no sponsor signature to bind it. Tamper protection
  // does not rest on it either way: the server keeps `expectedMessageBytes` and
  // compares them byte-for-byte on submit, and the SDK decodes the bytes before
  // handing them to a wallet.
  const transaction = await partiallySignTransactionMessageWithSigners(message);

  return {
    transactionBase64: getBase64EncodedWireTransaction(transaction),
    expectedMessageBytes: new Uint8Array(transaction.messageBytes),
    owner,
    ata,
    feePayer: payer.address,
    feePayerRole,
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

/**
 * ComputeBudget `SetComputeUnitPrice`. Takes no accounts and moves no funds; it
 * raises what the fee payer bids per compute unit so a validator picks the
 * transaction up sooner.
 *
 * Built by hand rather than pulling in `@solana-program/compute-budget`: the
 * layout is a discriminator and a u64, and a dependency for nine bytes is not
 * worth the supply chain.
 */
function computeUnitPriceInstruction(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
}

/** ComputeBudget `SetComputeUnitLimit`. A discriminator and a u32. */
function computeUnitLimitInstruction(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
}
