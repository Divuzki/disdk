import {
  AccountRole,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type AddressesByLookupTableAddress,
  type Instruction,
  type InstructionWithSigners,
  type TransactionSigner,
} from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import {
  DisdkError,
  formatTokenAmount,
  type FeePayerRole,
} from '@disdk/protocol';
import { deriveAta, readTokenAccount } from './token.js';
import { resolveChargeAmount, type ChargeAmount } from './amount.js';
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
 * Everything a charge needs, all of it server configuration except the amount —
 * and that comes either from the merchant-authenticated call that created the
 * session or, on a balance share, from the payer's own balance read here. Never
 * from a browser, on either path.
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

/**
 * Everything needed to hold a client's returned transaction to account.
 *
 * Split out of {@link BuiltTransaction} so the verifier can be stated in terms
 * of what it actually checks. A charge carries an amount and a token account; a
 * batch settlement carries neither in the singular. Both compile to a message,
 * and the message is the whole of what verification compares — so both satisfy
 * this, and `verifySignedTransaction` needs no per-flow variant.
 */
export interface TransactionExpectation {
  /**
   * The exact compiled message the sponsor signed. Submission must check the
   * client's returned transaction against these bytes.
   */
  expectedMessageBytes: Uint8Array;
  owner: Address;
  feePayer: Address;
  /** Which account `feePayer` is, so callers can report it without comparing keys. */
  feePayerRole: FeePayerRole;
  lastValidBlockHeight: bigint;
}

export interface BuiltTransaction extends TransactionExpectation {
  /** Base64 wire transaction, already carrying the sponsor's signature. */
  transactionBase64: string;
  ata: Address;
  amount: bigint;
  amountUi: string;
  balanceAtBuild: bigint;
  blockhash: string;
  expiresAt: string;
  /** Present once the charge instructions have been assembled. */
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

/**
 * A one-off payment the user authorizes themselves, with the sponsor paying the
 * network fee.
 *
 * The only kind of transaction this package builds, and deliberately so. It is
 * signed by the *owner*, at the moment they are looking at the amount. It needs
 * no allowance, grants none, and leaves nothing behind to revoke — the
 * transaction is the entire authorization and it is spent on use.
 *
 * The alternative it replaced was a standing SPL delegate, which let a service
 * pull funds later while the user was absent. That is a strictly larger ask of
 * the user, and every wallet warns about it, so nothing here offers one.
 */
export async function buildChargePaymentTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  /**
   * A settled price, or a share of the payer's balance. A share cannot become a
   * figure until the balance below has been read, which is why this is resolved
   * here rather than by the caller.
   */
  requested: ChargeAmount,
  config: ChargeSessionConfig,
  sessionNonce?: string,
  reference?: string,
  options: BuildOptions = {},
): Promise<BuiltTransaction> {
  if (typeof requested === 'bigint' && requested <= 0n) {
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

  const amount = resolveChargeAmount(requested, view.balance);

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

  // Binds the payment to one session. Without it, two sessions charging the
  // same wallet the same price inside one blockhash window compile to identical
  // bytes, and either could settle the other's invoice.
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

/**
 * Solana's maximum serialized transaction size, in bytes — one IPv6 MTU minus
 * headers. A transaction over this is not merely expensive, it is unsendable,
 * so it is measured rather than estimated.
 */
export const MAX_TRANSACTION_BYTES = 1232;

/** A blockhash and the height past which it can no longer land. */
export interface Lifetime {
  blockhash: string;
  lastValidBlockHeight: bigint;
}

export interface CompiledTransaction {
  transactionBase64: string;
  expectedMessageBytes: Uint8Array;
  feePayer: Address;
  feePayerRole: FeePayerRole;
  /** Serialized wire size, so callers can judge it against {@link MAX_TRANSACTION_BYTES}. */
  wireBytes: number;
}

/** Who signs for the fee, given the role the caller settled on. */
export function resolvePayerSigner(
  sponsor: TransactionSigner,
  owner: Address,
  options: BuildOptions,
): { payer: TransactionSigner; feePayerRole: FeePayerRole } {
  const feePayerRole = options.feePayerRole ?? 'sponsor';
  // When the owner pays, the sponsor is not a signer at all: the owner already
  // signs every flow here as the token authority, so the transaction goes from
  // two signatures to one rather than gaining any.
  return {
    payer: feePayerRole === 'owner' ? createNoopSigner(owner) : sponsor,
    feePayerRole,
  };
}

/**
 * Compile a version-0 message, sign what the server can sign, and measure it.
 *
 * The single place any flow in this package turns instructions into a
 * transaction. A charge and a batch settlement differ in what they put in the
 * list and in nothing else — the version, the ordering rule for ComputeBudget,
 * the signing model, and the byte measurement are identical, so they are stated
 * once here rather than once per flow.
 *
 * `lookupTables`, when given, moves every non-signer account it covers out of
 * the static account list and into a lookup reference. It changes which bytes
 * the message contains, never which accounts the instructions name.
 */
export async function compileAndSign(
  payer: TransactionSigner,
  feePayerRole: FeePayerRole,
  lifetime: Lifetime,
  instructions: Instruction[],
  options: BuildOptions = {},
  lookupTables?: AddressesByLookupTableAddress,
): Promise<CompiledTransaction> {
  // ComputeBudget instructions must come first to be honoured, and they are
  // prepended here rather than in each builder so no flow can forget them.
  const budget: Instruction[] = [];
  if (options.computeUnitLimit !== undefined) {
    budget.push(computeUnitLimitInstruction(options.computeUnitLimit));
  }
  if (options.priorityFeeMicroLamports !== undefined) {
    budget.push(computeUnitPriceInstruction(options.priorityFeeMicroLamports));
  }

  const base = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: lifetime.blockhash as Parameters<
            typeof setTransactionMessageLifetimeUsingBlockhash
          >[0]['blockhash'],
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions([...budget, ...instructions], m),
  );

  const message =
    lookupTables && Object.keys(lookupTables).length > 0
      ? compressTransactionMessageUsingAddressLookupTables(base, lookupTables)
      : base;

  // The owner is a noop signer, so this fills in the sponsor's signature and
  // leaves the owner's slot empty for the wallet. Critically, the sponsor's
  // signature covers the compiled message: any change the client makes to the
  // instructions, the amount, the lookup tables, or the fee payer invalidates it
  // and the network rejects the transaction.
  //
  // Under `owner` there is no sponsor signature to bind it. Tamper protection
  // does not rest on it either way: the server keeps `expectedMessageBytes` and
  // compares them byte-for-byte on submit, and the SDK decodes the bytes before
  // handing them to a wallet.
  const transaction = await partiallySignTransactionMessageWithSigners(message);
  const transactionBase64 = getBase64EncodedWireTransaction(transaction);

  return {
    transactionBase64,
    expectedMessageBytes: new Uint8Array(transaction.messageBytes),
    feePayer: payer.address,
    feePayerRole,
    // Base64 inflates by 4/3, so the encoded string is not the size the network
    // sees. Measure the bytes it decodes to.
    wireBytes: base64ByteLength(transactionBase64),
  };
}

/** Decoded length of a base64 string, without allocating the buffer. */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
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

  const { payer, feePayerRole } = resolvePayerSigner(sponsor, owner, options);
  const compiled = await compileAndSign(payer, feePayerRole, latest, instructions, options);

  return {
    transactionBase64: compiled.transactionBase64,
    expectedMessageBytes: compiled.expectedMessageBytes,
    owner,
    ata,
    feePayer: compiled.feePayer,
    feePayerRole: compiled.feePayerRole,
    amount: amounts.amount,
    amountUi: amounts.amountUi,
    balanceAtBuild: amounts.balanceAtBuild,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    expiresAt: new Date(Date.now() + BLOCKHASH_HINT_MS).toISOString(),
  };
}

/** A memo carries arbitrary bytes and no accounts, so it cannot affect funds. */
export function memoInstruction(note: string): Instruction {
  return {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: new TextEncoder().encode(`disdk:${note}`),
  };
}

/** System Program. Moves lamports; owns every account that holds only SOL. */
export const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111' as Address;

/**
 * System Program `Transfer`: a u32 discriminator and a u64 of lamports.
 *
 * Hand-built for the same reason the ComputeBudget instructions above are — the
 * layout is twelve bytes and a dependency for it is not worth the supply chain.
 * The source signs, which is what makes this an authorization rather than a
 * pull: there is no lamport equivalent of a delegate here and none is wanted.
 */
export function systemTransferInstruction(
  source: TransactionSigner,
  destination: Address,
  lamports: bigint,
): Instruction & InstructionWithSigners {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);

  const accounts: readonly [AccountSignerMeta, AccountMeta] = [
    { address: source.address, role: AccountRole.WRITABLE_SIGNER, signer: source },
    { address: destination, role: AccountRole.WRITABLE },
  ];

  return { programAddress: SYSTEM_PROGRAM_ADDRESS, accounts, data };
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
