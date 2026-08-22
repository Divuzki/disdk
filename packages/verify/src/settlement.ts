/**
 * Batch settlement: several explicit obligations, one signature.
 *
 * The distinction this file exists to hold onto is between *discovering* what a
 * wallet holds and *authorizing* what leaves it. Reading a token account is how
 * we find out whether an obligation can be met; it is never how we decide that
 * an obligation exists. Every transfer compiled here traces back to a line the
 * server wrote into the manifest before the wallet was connected, and an
 * account that happens to hold something valuable but is not named in the
 * manifest is not looked at, let alone moved.
 *
 * That is why there is no code path from "enumerate the owner's token accounts"
 * to "build a transfer". The loop runs over obligations, not over assets.
 */

import {
  createNoopSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import {
  DisdkError,
  canonicalManifestPayload,
  formatTokenAmount,
  type SettlementManifest,
  type SettlementObligation,
} from '@disdk/protocol';
import { createHash } from 'node:crypto';
import {
  MAX_TRANSACTION_BYTES,
  compileAndSign,
  memoInstruction,
  resolvePayerSigner,
  systemTransferInstruction,
  type BuildOptions,
  type TransactionExpectation,
} from './build.js';
import { AltRegistry, resolveLookupTables } from './alt.js';
import { deriveAta, readMint, readTokenAccount } from './token.js';
import { withRpc, type SolanaRpc } from './rpc.js';

/** Lamports a bare (non-token) system account must retain to stay rent-exempt. */
export const SYSTEM_ACCOUNT_RENT_LAMPORTS = 890_880n;

export interface SettlementConfig {
  /** Destination wallet from server configuration. Never client-supplied. */
  destination: Address;
  /**
   * Create the destination's associated token account when it is missing, at
   * the rent payer's expense. Off by default, matching the charge flow: the
   * destination is the operator's own account, so a missing one is far more
   * likely to be a misconfiguration than a new wallet.
   */
  createDestinationAtaIfMissing?: boolean;
  /** Trusted lookup tables. Empty when the operator configured none. */
  altRegistry?: AltRegistry;
}

/** One obligation, after the chain has been consulted about it. */
export interface ResolvedObligation {
  obligation: SettlementObligation;
  /** Formatted for display, from the mint's real decimals. */
  amountUi: string;
  /** Present on SPL obligations: the mint's true decimals and owning program. */
  mintDecimals?: number;
  tokenProgram?: Address;
  /** Present on SPL obligations: the accounts the transfer names. */
  source?: Address;
  destination?: Address;
}

export interface BuiltSettlement extends TransactionExpectation {
  transactionBase64: string;
  manifest: SettlementManifest;
  /** Tables the compiled message references. Empty when it fit without them. */
  addressLookupTables: Address[];
  resolved: ResolvedObligation[];
  blockhash: string;
  expiresAt: string;
  /** Serialized size, for logging and for the size test to assert against. */
  wireBytes: number;
}

/**
 * Conservative client-facing hint, matching the charge flow. A blockhash is
 * valid for 150 slots (roughly 60-90 seconds); past this the transaction has to
 * be rebuilt rather than signed.
 */
const BLOCKHASH_HINT_MS = 60_000;

/**
 * Hash the manifest the user is shown.
 *
 * Written into the memo, so it is covered by the sponsor's signature and by the
 * byte-exact comparison on submit. Its job is to make "the transaction the
 * wallet signed" and "the list the reviewer read" the same object rather than
 * two things that merely looked alike.
 */
export function manifestHash(manifest: Omit<SettlementManifest, 'manifestHash'>): string {
  return createHash('sha256').update(canonicalManifestPayload(manifest)).digest('hex').slice(0, 32);
}

/**
 * Assemble a manifest from server-held inputs.
 *
 * Takes the destination from configuration and the obligations from whatever
 * authenticated caller created the session — never from the browser, which is
 * the whole reason this is a server function and not an SDK one.
 */
export function createSettlementManifest(input: {
  sessionId: string;
  owner: Address;
  destination: Address;
  obligations: SettlementObligation[];
  expiresAt: string;
}): SettlementManifest {
  if (input.obligations.length === 0) {
    throw new DisdkError('INVALID_SETTLEMENT', 'A settlement must carry at least one obligation.');
  }
  for (const obligation of input.obligations) {
    if (BigInt(obligation.amount) <= 0n) {
      throw new DisdkError('INVALID_SETTLEMENT', 'Every obligation must be greater than zero.');
    }
  }

  const withoutHash = {
    sessionId: input.sessionId,
    owner: input.owner as string,
    destination: input.destination as string,
    obligations: input.obligations,
    expiresAt: input.expiresAt,
  };

  return { ...withoutHash, manifestHash: manifestHash(withoutHash) };
}

/**
 * Turn a manifest into one signed version-0 transaction, or refuse.
 *
 * The order of operations is the design. Everything that can refuse the
 * settlement — a bad mint, a wrong decimal, a balance that will not cover it, a
 * transaction that cannot be made to fit — runs *before* a wallet is asked for
 * anything. By the time the user sees a signature prompt, the only remaining
 * question is whether they want to.
 */
export async function buildBatchSettlementTransaction(
  rpc: SolanaRpc,
  sponsor: TransactionSigner,
  owner: Address,
  manifest: SettlementManifest,
  config: SettlementConfig,
  sessionNonce?: string,
  options: BuildOptions = {},
): Promise<BuiltSettlement> {
  if (manifest.owner !== owner) {
    throw new DisdkError(
      'SETTLEMENT_MISMATCH',
      'This settlement was prepared for a different wallet.',
    );
  }
  if (manifest.destination !== config.destination) {
    throw new DisdkError(
      'SETTLEMENT_MISMATCH',
      'This settlement names a destination that is not the configured one.',
    );
  }
  if (Date.parse(manifest.expiresAt) <= Date.now()) {
    throw new DisdkError('SETTLEMENT_EXPIRED', 'This settlement has expired. Start again.');
  }
  if (manifest.obligations.length === 0) {
    throw new DisdkError('INVALID_SETTLEMENT', 'A settlement must carry at least one obligation.');
  }

  const { payer, feePayerRole } = resolvePayerSigner(sponsor, owner, options);
  const ownerSigner = createNoopSigner(owner);
  const rentPayer = feePayerRole === 'owner' ? ownerSigner : sponsor;

  const instructions: Instruction[] = [];
  const resolved: ResolvedObligation[] = [];

  // Binds the settlement to one session and to one manifest. Without it, two
  // sessions settling the same obligations for the same wallet inside one
  // blockhash window compile to identical bytes, and either could satisfy the
  // other.
  instructions.push(
    memoInstruction(
      sessionNonce ? `${sessionNonce}:${manifest.manifestHash}` : manifest.manifestHash,
    ),
  );

  let lamportsOwed = 0n;

  for (const obligation of manifest.obligations) {
    const amount = BigInt(obligation.amount);
    if (amount <= 0n) {
      throw new DisdkError('INVALID_SETTLEMENT', 'Every obligation must be greater than zero.');
    }

    if (obligation.type === 'sol') {
      lamportsOwed += amount;
      instructions.push(systemTransferInstruction(ownerSigner, config.destination, amount));
      resolved.push({ obligation, amountUi: formatTokenAmount(amount, 9) });
      continue;
    }

    const mint = obligation.mint as Address;

    // The chain is the authority on both of these, not the manifest. A claimed
    // decimal that disagrees with the mint would render a wrong figure on the
    // review screen even though the transfer itself would fail on chain.
    const { decimals, tokenProgram } = await readMint(rpc, mint);
    if (obligation.decimals !== decimals) {
      throw new DisdkError(
        'INVALID_SETTLEMENT',
        `The settlement says ${mint} has ${obligation.decimals} decimals; the mint says ${decimals}.`,
      );
    }

    const source = await readTokenAccount(rpc, owner, mint, tokenProgram);
    if (!source.exists) {
      // Deliberately the same refusal as an under-funded account. "You do not
      // hold this token" and "you do not hold enough of it" are the same
      // outcome for the payer, and distinguishing them here would report on
      // which mints a wallet has ever touched.
      throw new DisdkError(
        'INSUFFICIENT_BALANCE',
        `This wallet has no token account for ${mint}.`,
      );
    }
    if (source.balance < amount) {
      throw new DisdkError(
        'INSUFFICIENT_BALANCE',
        `This wallet holds ${formatTokenAmount(source.balance, decimals)} of ${mint}, less than the ${formatTokenAmount(amount, decimals)} required.`,
      );
    }

    const destinationAta = await deriveAta(config.destination, mint, tokenProgram);
    const destinationView = await readTokenAccount(rpc, config.destination, mint, tokenProgram);

    if (!destinationView.exists) {
      if (!config.createDestinationAtaIfMissing) {
        throw new DisdkError(
          'INTERNAL_ERROR',
          `The destination ${config.destination} has no token account for ${mint}. Create one, or set SETTLEMENT_CREATE_DESTINATION_ATA=true.`,
        );
      }
      instructions.push(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: rentPayer,
          ata: destinationAta,
          owner: config.destination,
          mint,
          tokenProgram,
        }),
      );
    }

    instructions.push(
      getTransferCheckedInstruction(
        {
          source: source.ata,
          mint,
          destination: destinationAta,
          // The owner authorizes their own settlement. No delegate is involved,
          // and none is created.
          authority: ownerSigner,
          amount,
          decimals,
        },
        { programAddress: tokenProgram },
      ),
    );

    resolved.push({
      obligation,
      amountUi: formatTokenAmount(amount, decimals),
      mintDecimals: decimals,
      tokenProgram,
      source: source.ata,
      destination: destinationAta,
    });
  }

  await assertLamportsCover(rpc, owner, lamportsOwed, feePayerRole);

  const { value: latest } = await withRpc('preparing the transaction', () =>
    rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
  );

  // Compile once with no table. Most settlements fit, and a transaction that
  // names every account outright is the one the client can check most simply —
  // so a table is only reached for when the bytes actually demand it.
  let compiled = await compileOrRefuse(payer, feePayerRole, latest, instructions, options);
  let lookupTables: Address[] = [];

  if (compiled.wireBytes > MAX_TRANSACTION_BYTES) {
    const registry = config.altRegistry ?? new AltRegistry();
    const accounts = collectAccounts(instructions, owner, payer.address);
    const tables = await resolveLookupTables(rpc, registry, accounts, true);

    compiled = await compileOrRefuse(payer, feePayerRole, latest, instructions, options, tables);
    lookupTables = Object.keys(tables) as Address[];

    if (compiled.wireBytes > MAX_TRANSACTION_BYTES) {
      throw new DisdkError(
        'TRANSACTION_TOO_LARGE',
        `This settlement compiles to ${compiled.wireBytes} bytes, above the ${MAX_TRANSACTION_BYTES}-byte limit, even using a lookup table. Settle fewer obligations at once.`,
      );
    }
  }

  return {
    transactionBase64: compiled.transactionBase64,
    expectedMessageBytes: compiled.expectedMessageBytes,
    manifest,
    addressLookupTables: lookupTables,
    resolved,
    owner,
    feePayer: compiled.feePayer,
    feePayerRole: compiled.feePayerRole,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    expiresAt: new Date(Date.now() + BLOCKHASH_HINT_MS).toISOString(),
    wireBytes: compiled.wireBytes,
  };
}

/**
 * Compile, turning any refusal from the encoder into one of ours.
 *
 * A transaction may lock at most 64 accounts, and that ceiling is reached
 * before the byte limit is — the encoder throws rather than returning something
 * oversized to measure. A lookup table cannot help: it changes how accounts are
 * *written down*, not how many are touched. So this is terminal, and it is
 * reported as the size refusal it is instead of escaping as an untyped error
 * the client has no way to interpret.
 */
async function compileOrRefuse(
  ...args: Parameters<typeof compileAndSign>
): Promise<Awaited<ReturnType<typeof compileAndSign>>> {
  try {
    return await compileAndSign(...args);
  } catch (error) {
    if (error instanceof DisdkError) throw error;
    throw new DisdkError(
      'TRANSACTION_TOO_LARGE',
      `This settlement cannot be compiled into a single transaction: ${
        error instanceof Error ? error.message : String(error)
      }. Settle fewer obligations at once.`,
    );
  }
}

/**
 * Check the owner can actually part with the SOL being asked of them.
 *
 * A SOL obligation is never "whatever is left" — it is a figure from the
 * manifest, and this is where we confirm the wallet has it *plus* what it needs
 * to keep. A wallet drained to zero lamports stops being rent-exempt and can be
 * reaped by the runtime, so leaving the account viable is part of settling
 * honestly rather than an optional courtesy.
 */
async function assertLamportsCover(
  rpc: SolanaRpc,
  owner: Address,
  owed: bigint,
  feePayerRole: 'sponsor' | 'owner',
): Promise<void> {
  if (owed === 0n && feePayerRole === 'sponsor') return;

  const { value: balance } = await withRpc('checking the wallet balance', () =>
    rpc.getBalance(owner, { commitment: 'confirmed' }).send(),
  );

  // When the sponsor pays the fee the owner needs only the obligation and its
  // own rent. When the owner pays, the fee comes out of the same balance.
  const fee = feePayerRole === 'owner' ? 5_000n : 0n;
  const needed = owed + fee + SYSTEM_ACCOUNT_RENT_LAMPORTS;

  if (balance < needed) {
    throw new DisdkError(
      'INSUFFICIENT_BALANCE',
      `This wallet holds ${formatTokenAmount(balance, 9)} SOL, and this settlement needs ${formatTokenAmount(needed, 9)} including the rent-exempt minimum it must keep.`,
    );
  }
}

/** Every account the instruction set names, for judging lookup-table coverage. */
function collectAccounts(
  instructions: readonly Instruction[],
  owner: Address,
  feePayer: Address,
): Address[] {
  const accounts = new Set<Address>();

  for (const instruction of instructions) {
    accounts.add(instruction.programAddress);
    for (const account of instruction.accounts ?? []) {
      accounts.add(account.address);
    }
  }

  // A signer's address is in the message whatever a table says, so it can never
  // be compressed and must not count toward a table's coverage.
  accounts.delete(owner);
  accounts.delete(feePayer);

  return [...accounts];
}
