/**
 * A minimal Solana transaction decoder, so the SDK can tell the user what they
 * are actually signing.
 *
 * The server says what the transaction contains; this module checks that claim
 * against the bytes. The amount shown in the modal comes from here, not from
 * the server's JSON, and anything outside a narrow instruction allowlist is
 * refused before the wallet is ever asked to sign.
 */

import {
  DisdkError,
  type FeePayerRole,
  type SettlementObligation,
} from '@disdk/protocol';
import { base58Encode, base64Decode } from './codec.js';

/**
 * Judge the server's fee-payer claim before any per-flow check trusts it.
 *
 * Every other guard here compares the bytes against what the server said. That
 * is not enough for the fee payer: the server chooses the claim too, so on its
 * own a compromised server could name the *user* as fee payer and the client
 * would have nothing to disagree with. Only two accounts are ever legitimate —
 * the session's sponsor, or the wallet doing the signing — and which one it is
 * has to match the role the server declared, so the fee cannot move onto the
 * user while the screen still says the sponsor is paying.
 */
export function assertFeePayerAllowed(
  claim: { feePayer: string; feePayerRole?: FeePayerRole },
  sponsor: string,
  owner: string,
): FeePayerRole {
  const role: FeePayerRole = claim.feePayerRole ?? 'sponsor';
  const expected = role === 'owner' ? owner : sponsor;

  if (claim.feePayer !== expected) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      role === 'owner'
        ? 'This transaction says you pay the network fee, but names a different account.'
        : 'This transaction would be paid for by an account that is not the sponsor.',
    );
  }

  return role;
}

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/**
 * SPL Memo. The server writes a per-session marker here so an approval cannot
 * be replayed into a different session. A memo takes no accounts and moves no
 * funds, so allowing it costs the user nothing.
 */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

/** System Program `Transfer`. Its discriminator is a u32, unlike the token program's u8. */
const SYS_IX_TRANSFER = 2;

/** SPL Token instruction discriminators, from the token program's layout. */
const IX_TRANSFER = 3;
const IX_APPROVE = 4;
const IX_REVOKE = 5;
const IX_CLOSE_ACCOUNT = 9;
const IX_TRANSFER_CHECKED = 12;
const IX_APPROVE_CHECKED = 13;

export interface DecodedInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

/**
 * One table a version-0 message draws accounts from.
 *
 * The indexes are positions *inside the table*, not addresses. Resolving them
 * requires the table's real contents, which is why they are carried unresolved:
 * anything that wants the addresses has to go and fetch them, rather than
 * accepting a list the server was kind enough to supply.
 */
export interface AddressTableLookup {
  lookupTableAddress: string;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

export interface DecodedTransaction {
  version: 'legacy' | number;
  numRequiredSignatures: number;
  feePayer: string;
  /**
   * Accounts written into the message itself. On a version-0 message that draws
   * on a lookup table this is not the full set — see {@link lookups}.
   */
  accountKeys: string[];
  recentBlockhash: string;
  instructions: DecodedInstruction[];
  /** Tables this message references, empty when it names every account outright. */
  lookups: AddressTableLookup[];
  /**
   * Whether any account is hidden behind a lookup table.
   *
   * A charge never uses one, and {@link verifyChargeTransaction} still refuses
   * outright when it sees one. A batch settlement may, because several
   * obligations will not otherwise fit in a packet — but only against a table
   * the caller has independently fetched and vouched for.
   */
  usesAddressLookupTables: boolean;
}

export interface ApproveDetails {
  source: string;
  mint: string;
  delegate: string;
  owner: string;
  amount: bigint;
  decimals: number;
  /** True for `Approve`, which skips the on-chain mint and decimals check. */
  unchecked: boolean;
}

export interface TransferDetails {
  source: string;
  /** Empty for the unchecked `Transfer` variant, which omits the mint account. */
  mint: string;
  destination: string;
  owner: string;
  amount: bigint;
  /** -1 for the unchecked variant, which carries no decimals. */
  decimals: number;
  /** True for `Transfer`, which skips the on-chain mint and decimals check. */
  unchecked: boolean;
}

export interface CloseDetails {
  account: string;
  /** Where the reclaimed rent lamports go. */
  destination: string;
  owner: string;
}

/** A System Program transfer of native SOL. */
export interface SolTransferDetails {
  source: string;
  destination: string;
  lamports: bigint;
}

export interface TransactionInspection {
  decoded: DecodedTransaction;
  approve: ApproveDetails | null;
  transfers: TransferDetails[];
  /** Native SOL movements, separate because they name no mint. */
  solTransfers: SolTransferDetails[];
  closes: CloseDetails[];
  revokes: number;
  createsAccount: boolean;
  /**
   * System Program instructions that are not a plain transfer — Assign,
   * CreateAccount, and the rest. Collected rather than thrown on, so each
   * `verify*` decides for itself; no caller should accept a non-empty list,
   * because `Assign` hands an account to another program outright.
   */
  unknownSystemInstructions: number[];
  /** Programs present that are not on the allowlist. */
  disallowedPrograms: string[];
  /**
   * Token instructions that are neither approve, revoke, transfer nor close —
   * Burn, SetAuthority, MintTo and friends. Collected rather than thrown on, so
   * each `verify*` function decides what is acceptable in its own context. No
   * caller should ever accept a non-empty list.
   */
  unknownTokenInstructions: number[];
}

// ---------------------------------------------------------------------------
// Wire-format reader
// ---------------------------------------------------------------------------

class Reader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.bytes.length - this.#offset;
  }

  u8(): number {
    if (this.#offset >= this.bytes.length) throw new Error('unexpected end of transaction');
    return this.bytes[this.#offset++] as number;
  }

  peek(): number {
    if (this.#offset >= this.bytes.length) throw new Error('unexpected end of transaction');
    return this.bytes[this.#offset] as number;
  }

  take(length: number): Uint8Array {
    if (this.#offset + length > this.bytes.length) {
      throw new Error('unexpected end of transaction');
    }
    const slice = this.bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  skip(length: number): void {
    if (this.#offset + length > this.bytes.length) {
      throw new Error('unexpected end of transaction');
    }
    this.#offset += length;
  }

  /** Solana's shortvec: up to three bytes, seven bits of payload each. */
  compactU16(): number {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const byte = this.u8();
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('malformed compact-u16 length');
  }
}

/**
 * Supplies the contents of a lookup table, by address.
 *
 * Deliberately a caller-provided function rather than data read out of the
 * transaction. The whole risk of a lookup table is that the bytes do not say
 * which accounts they mean, so the only safe source for that answer is one the
 * verifier trusts — the chain, via the caller — never the party that sent the
 * transaction.
 */
export type LookupResolver = (lookupTableAddress: string) => string[] | undefined;

export function decodeTransaction(
  transactionBase64: string,
  resolver?: LookupResolver,
): DecodedTransaction {
  let reader: Reader;
  try {
    reader = new Reader(base64Decode(transactionBase64));
  } catch {
    throw new DisdkError('UNSAFE_TRANSACTION', 'The transaction could not be decoded.');
  }

  try {
    return readTransaction(reader, resolver);
  } catch (error) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      `The transaction could not be decoded: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

function readTransaction(reader: Reader, resolver?: LookupResolver): DecodedTransaction {
  const signatureCount = reader.compactU16();
  reader.skip(signatureCount * 64);

  let version: 'legacy' | number = 'legacy';
  const prefix = reader.peek();
  if ((prefix & 0x80) !== 0) {
    version = reader.u8() & 0x7f;
  }

  const numRequiredSignatures = reader.u8();
  reader.u8(); // readonly signed accounts
  reader.u8(); // readonly unsigned accounts

  const accountCount = reader.compactU16();
  const accountKeys: string[] = [];
  for (let i = 0; i < accountCount; i++) {
    accountKeys.push(base58Encode(reader.take(32)));
  }

  const recentBlockhash = base58Encode(reader.take(32));

  const instructionCount = reader.compactU16();
  // Instructions are read before the lookup section, but their account indexes
  // may point into it, so the raw indexes are kept and resolved afterwards.
  const rawInstructions: { programIdIndex: number; indexes: number[]; data: Uint8Array }[] = [];
  for (let i = 0; i < instructionCount; i++) {
    const programIdIndex = reader.u8();
    const accountIndexCount = reader.compactU16();
    const indexes: number[] = [];
    for (let j = 0; j < accountIndexCount; j++) {
      indexes.push(reader.u8());
    }
    const dataLength = reader.compactU16();
    rawInstructions.push({
      programIdIndex,
      indexes,
      data: new Uint8Array(reader.take(dataLength)),
    });
  }

  const lookups: AddressTableLookup[] = [];
  if (version !== 'legacy' && reader.remaining > 0) {
    const lookupCount = reader.compactU16();
    for (let i = 0; i < lookupCount; i++) {
      const lookupTableAddress = base58Encode(reader.take(32));
      const writableCount = reader.compactU16();
      const writableIndexes: number[] = [];
      for (let j = 0; j < writableCount; j++) writableIndexes.push(reader.u8());
      const readonlyCount = reader.compactU16();
      const readonlyIndexes: number[] = [];
      for (let j = 0; j < readonlyCount; j++) readonlyIndexes.push(reader.u8());
      lookups.push({ lookupTableAddress, writableIndexes, readonlyIndexes });
    }
  }

  // The runtime builds the account list as: static keys, then every writable
  // looked-up account in table order, then every readonly one. An instruction's
  // index reads into that concatenation, so the same order must be rebuilt here
  // or an index would resolve to the wrong account.
  const resolvedKeys = [...accountKeys];
  if (lookups.length > 0) {
    const writable: string[] = [];
    const readonly: string[] = [];

    for (const lookup of lookups) {
      const contents = resolver?.(lookup.lookupTableAddress);
      if (!contents) {
        throw new Error(
          `no contents supplied for lookup table ${lookup.lookupTableAddress}`,
        );
      }
      for (const index of lookup.writableIndexes) {
        const key = contents[index];
        if (key === undefined) {
          throw new Error(`lookup table ${lookup.lookupTableAddress} has no entry ${index}`);
        }
        writable.push(key);
      }
      for (const index of lookup.readonlyIndexes) {
        const key = contents[index];
        if (key === undefined) {
          throw new Error(`lookup table ${lookup.lookupTableAddress} has no entry ${index}`);
        }
        readonly.push(key);
      }
    }

    resolvedKeys.push(...writable, ...readonly);
  }

  const instructions: DecodedInstruction[] = rawInstructions.map((raw) => {
    const accounts = raw.indexes.map((index) => {
      const key = resolvedKeys[index];
      if (key === undefined) throw new Error('instruction references an unknown account');
      return key;
    });
    // A program is never looked up — the runtime requires it in the static
    // list — so an out-of-range program index is malformed, not merely unresolved.
    const programId = accountKeys[raw.programIdIndex];
    if (programId === undefined) throw new Error('instruction references an unknown program');
    return { programId, accounts, data: raw.data };
  });

  const feePayer = accountKeys[0];
  if (feePayer === undefined) throw new Error('transaction has no accounts');

  return {
    version,
    numRequiredSignatures,
    feePayer,
    accountKeys,
    recentBlockhash,
    instructions,
    lookups,
    usesAddressLookupTables: lookups.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

const ALLOWED_PROGRAMS = new Set([
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  MEMO_PROGRAM,
  MEMO_PROGRAM_V1,
]);

/**
 * Decode a transaction into the operations it actually performs.
 *
 * This function *reports*; it does not judge. It still decodes approvals,
 * revokes and closes even though nothing here builds them — that is the point.
 * A guard that only looked for what it expected to find could not refuse what it
 * did not. {@link verifyChargeTransaction} applies the judgement.
 *
 * The only things it still throws on are instructions it cannot parse at all,
 * where reporting a half-decoded operation would be worse than refusing.
 */
export function inspectTransaction(
  transactionBase64: string,
  resolver?: LookupResolver,
): TransactionInspection {
  const decoded = decodeTransaction(transactionBase64, resolver);

  let approve: ApproveDetails | null = null;
  let revokes = 0;
  let createsAccount = false;
  const transfers: TransferDetails[] = [];
  const solTransfers: SolTransferDetails[] = [];
  const closes: CloseDetails[] = [];
  const unknownTokenInstructions: number[] = [];
  const unknownSystemInstructions: number[] = [];
  const disallowedPrograms: string[] = [];

  for (const instruction of decoded.instructions) {
    if (!ALLOWED_PROGRAMS.has(instruction.programId)) {
      if (!disallowedPrograms.includes(instruction.programId)) {
        disallowedPrograms.push(instruction.programId);
      }
      continue;
    }

    if (instruction.programId === ASSOCIATED_TOKEN_PROGRAM) {
      createsAccount = true;
      continue;
    }

    if (instruction.programId === MEMO_PROGRAM || instruction.programId === MEMO_PROGRAM_V1) {
      continue;
    }

    if (instruction.programId === SYSTEM_PROGRAM) {
      // System instruction discriminators are a little-endian u32.
      const tag = instruction.data.length >= 4 ? readU32LE(instruction.data, 0) : -1;
      if (tag === SYS_IX_TRANSFER) {
        // data: [tag u32 LE][lamports u64 LE]
        if (instruction.data.length < 12 || instruction.accounts.length < 2) {
          throw new DisdkError('UNSAFE_TRANSACTION', 'Malformed SOL transfer instruction.');
        }
        solTransfers.push({
          source: instruction.accounts[0] as string,
          destination: instruction.accounts[1] as string,
          lamports: readU64LE(instruction.data, 4),
        });
      } else {
        unknownSystemInstructions.push(tag);
      }
      continue;
    }

    if (
      instruction.programId !== TOKEN_PROGRAM &&
      instruction.programId !== TOKEN_2022_PROGRAM
    ) {
      continue;
    }

    const tag = instruction.data[0];

    if (tag === IX_APPROVE_CHECKED) {
      // data: [tag u8][amount u64 LE][decimals u8]
      if (instruction.data.length < 10 || instruction.accounts.length < 4) {
        throw new DisdkError('UNSAFE_TRANSACTION', 'Malformed approval instruction.');
      }
      approve = {
        source: instruction.accounts[0] as string,
        mint: instruction.accounts[1] as string,
        delegate: instruction.accounts[2] as string,
        owner: instruction.accounts[3] as string,
        amount: readU64LE(instruction.data, 1),
        decimals: instruction.data[9] as number,
        unchecked: false,
      };
    } else if (tag === IX_APPROVE) {
      // The unchecked variant omits the mint, so the on-chain program cannot
      // confirm which token is being approved. We never emit it.
      if (instruction.data.length < 9 || instruction.accounts.length < 3) {
        throw new DisdkError('UNSAFE_TRANSACTION', 'Malformed approval instruction.');
      }
      approve = {
        source: instruction.accounts[0] as string,
        mint: '',
        delegate: instruction.accounts[1] as string,
        owner: instruction.accounts[2] as string,
        amount: readU64LE(instruction.data, 1),
        decimals: -1,
        unchecked: true,
      };
    } else if (tag === IX_REVOKE) {
      revokes++;
    } else if (tag === IX_TRANSFER_CHECKED) {
      // data: [tag u8][amount u64 LE][decimals u8]
      if (instruction.data.length < 10 || instruction.accounts.length < 4) {
        throw new DisdkError('UNSAFE_TRANSACTION', 'Malformed transfer instruction.');
      }
      transfers.push({
        source: instruction.accounts[0] as string,
        mint: instruction.accounts[1] as string,
        destination: instruction.accounts[2] as string,
        owner: instruction.accounts[3] as string,
        amount: readU64LE(instruction.data, 1),
        decimals: instruction.data[9] as number,
        unchecked: false,
      });
    } else if (tag === IX_TRANSFER) {
      // The unchecked variant omits the mint, so the on-chain program cannot
      // confirm which token is moving. We never emit it.
      if (instruction.data.length < 9 || instruction.accounts.length < 3) {
        throw new DisdkError('UNSAFE_TRANSACTION', 'Malformed transfer instruction.');
      }
      transfers.push({
        source: instruction.accounts[0] as string,
        mint: '',
        destination: instruction.accounts[1] as string,
        owner: instruction.accounts[2] as string,
        amount: readU64LE(instruction.data, 1),
        decimals: -1,
        unchecked: true,
      });
    } else if (tag === IX_CLOSE_ACCOUNT) {
      if (instruction.accounts.length < 3) {
        throw new DisdkError('UNSAFE_TRANSACTION', 'Malformed close instruction.');
      }
      closes.push({
        account: instruction.accounts[0] as string,
        destination: instruction.accounts[1] as string,
        owner: instruction.accounts[2] as string,
      });
    } else {
      // Burn, SetAuthority, MintTo and the rest. No flow accepts these; they are
      // collected so the refusal message can name the tag.
      unknownTokenInstructions.push(tag ?? -1);
    }
  }

  return {
    decoded,
    approve,
    transfers,
    solTransfers,
    closes,
    revokes,
    createsAccount,
    disallowedPrograms,
    unknownTokenInstructions,
    unknownSystemInstructions,
  };
}

/**
 * Checks every flow shares: no lookup tables, no unexpected programs, no
 * unrecognized token instructions, and the fee payer we were promised.
 */
function assertCommonSafety(
  inspection: TransactionInspection,
  expectedFeePayer: string,
): void {
  const { decoded } = inspection;

  if (decoded.usesAddressLookupTables) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction hides accounts behind a lookup table and will not be signed.',
    );
  }

  if (inspection.disallowedPrograms.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      `This transaction calls an unexpected program: ${inspection.disallowedPrograms.join(', ')}.`,
    );
  }

  if (inspection.unknownTokenInstructions.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      `This transaction contains an unexpected token instruction (${inspection.unknownTokenInstructions.join(', ')}).`,
    );
  }

  if (inspection.unknownSystemInstructions.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      `This transaction contains an unexpected system instruction (${inspection.unknownSystemInstructions.join(', ')}).`,
    );
  }

  if (decoded.feePayer !== expectedFeePayer) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction would be paid for by an unexpected account.',
    );
  }
}

/**
 * The core question, asked of the decoded bytes rather than of the server:
 * "is this exactly one checked transfer, of this token, for this amount, from
 * this wallet, to this account?"
 *
 * Kept separate from its caller so what the transfer must be stays legible
 * apart from what else the transaction is allowed to contain.
 */
function verifyExactTransfer(
  inspection: TransactionInspection,
  expected: { mint: string; destination: string; owner: string; amount: bigint; decimals: number },
): TransferDetails {
  if (inspection.transfers.length !== 1) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      inspection.transfers.length === 0
        ? 'This transaction contains no transfer.'
        : 'This transaction contains more than one transfer.',
    );
  }

  const transfer = inspection.transfers[0] as TransferDetails;

  if (transfer.unchecked) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction uses an unchecked transfer, which cannot confirm the token.',
    );
  }

  if (transfer.mint !== expected.mint) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'This transfer is for a different token.');
  }

  if (transfer.destination !== expected.destination) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transfer names an unexpected destination.',
    );
  }

  if (transfer.owner !== expected.owner) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'This transfer is from a different wallet.');
  }

  if (transfer.decimals !== expected.decimals) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transfer declares unexpected token decimals.',
    );
  }

  if (transfer.amount !== expected.amount) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'The amount in this transaction does not match the amount you were shown.',
    );
  }

  return transfer;
}

// ---------------------------------------------------------------------------
// Charge
// ---------------------------------------------------------------------------

export interface ChargeExpectation {
  feePayer: string;
  owner: string;
  mint: string;
  /** Treasury *token account*, not the merchant's wallet address. */
  destination: string;
  amount: bigint;
  decimals: number;
}

export interface VerifiedCharge {
  /** Read out of the bytes — this is what the UI shows. */
  amount: bigint;
  mint: string;
  destination: string;
  owner: string;
  createsAccount: boolean;
}

/**
 * Refuse to sign anything that is not exactly the payment we were promised.
 *
 * This is the only guard left, and it is the strict one. Funds leave
 * immediately and nothing undoes it, so an approval is refused outright: a
 * checkout is the most natural place in this whole project to slip a standing
 * allowance past someone, since the user has already decided to part with money
 * and is looking for the confirm button. The one thing they must not be able to
 * agree to by accident is the thing that would outlive the purchase.
 *
 * This server no longer builds approvals at all, which makes the check more
 * important rather than less: it is now the thing that would notice if one ever
 * reappeared.
 */
export function verifyChargeTransaction(
  transactionBase64: string,
  expected: ChargeExpectation,
): VerifiedCharge {
  const inspection = inspectTransaction(transactionBase64);

  assertCommonSafety(inspection, expected.feePayer);
  assertNoApproval(inspection);

  if (inspection.closes.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction would close a token account, which a payment must never do.',
    );
  }

  // A charge is denominated in one token. Lamports leaving alongside it are not
  // part of the price the user was quoted, whoever moved them.
  if (inspection.solTransfers.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction would also transfer SOL, which a payment must never do.',
    );
  }

  const transfer = verifyExactTransfer(inspection, expected);

  return {
    amount: transfer.amount,
    mint: transfer.mint,
    destination: transfer.destination,
    owner: transfer.owner,
    createsAccount: inspection.createsAccount,
  };
}

// ---------------------------------------------------------------------------
// Batch settlement
// ---------------------------------------------------------------------------

export interface SettlementExpectation {
  feePayer: string;
  owner: string;
  /** The destination *wallet*. Token transfers credit its associated accounts. */
  destination: string;
  obligations: SettlementObligation[];
  /**
   * Contents of every lookup table the transaction may reference, keyed by
   * table address, as fetched by the caller from a source it trusts.
   *
   * A transaction referencing a table that is absent here is refused rather
   * than resolved. That is the whole point: the SDK will not sign for accounts
   * it cannot name, and the server's say-so is not naming them.
   */
  lookupTables?: Record<string, string[]>;
  /**
   * The token account each SPL obligation must credit, keyed by mint — the
   * destination's associated token account, derived by the caller.
   *
   * Derived rather than read off the transaction because a destination ATA is
   * a PDA of (destination, mint, token program), and checking that the transfer
   * credits the *right* account is exactly the check that catches a transfer
   * pointed at an attacker's account that happens to hold the same mint.
   */
  destinationAccounts: Record<string, string>;
}

export interface VerifiedSettlement {
  /** Read out of the bytes, in manifest order — this is what the UI shows. */
  transfers: { obligation: SettlementObligation; amount: bigint }[];
  owner: string;
  destination: string;
  createsAccount: boolean;
  lookupTables: string[];
}

/**
 * Refuse to sign anything that is not exactly the settlement we were promised.
 *
 * The charge guard asks "is this one transfer, of this token, for this amount?".
 * This asks the same question of a list, and adds the one that only a list can
 * get wrong: **nothing extra**. Every transfer in the transaction must be
 * accounted for by an obligation, and every obligation by a transfer, matched
 * pairwise and in order. A transaction carrying all the agreed transfers plus a
 * quiet fourth one is the failure mode this exists to make impossible, so a
 * surplus transfer is as fatal as a wrong one.
 */
export function verifySettlementTransaction(
  transactionBase64: string,
  expected: SettlementExpectation,
): VerifiedSettlement {
  const inspection = inspectTransaction(
    transactionBase64,
    (table) => expected.lookupTables?.[table],
  );

  assertSettlementSafety(inspection, expected);
  assertNoApproval(inspection);

  if (inspection.closes.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction would close a token account, which a settlement must never do.',
    );
  }

  const splObligations = expected.obligations.filter((o) => o.type === 'spl');
  const solObligations = expected.obligations.filter((o) => o.type === 'sol');

  if (inspection.transfers.length !== splObligations.length) {
    throw new DisdkError(
      'SETTLEMENT_MISMATCH',
      inspection.transfers.length > splObligations.length
        ? 'This transaction moves more tokens than the settlement you were shown.'
        : 'This transaction does not contain every transfer in the settlement.',
    );
  }
  if (inspection.solTransfers.length !== solObligations.length) {
    throw new DisdkError(
      'SETTLEMENT_MISMATCH',
      inspection.solTransfers.length > solObligations.length
        ? 'This transaction moves more SOL than the settlement you were shown.'
        : 'This transaction is missing the SOL transfer in the settlement.',
    );
  }

  const transfers: VerifiedSettlement['transfers'] = [];
  let splIndex = 0;
  let solIndex = 0;

  for (const obligation of expected.obligations) {
    if (obligation.type === 'sol') {
      const actual = inspection.solTransfers[solIndex++] as SolTransferDetails;
      if (actual.source !== expected.owner) {
        throw new DisdkError('SETTLEMENT_MISMATCH', 'A SOL transfer is from a different wallet.');
      }
      if (actual.destination !== expected.destination) {
        throw new DisdkError(
          'SETTLEMENT_MISMATCH',
          'A SOL transfer names an unexpected destination.',
        );
      }
      if (actual.lamports !== BigInt(obligation.amount)) {
        throw new DisdkError(
          'SETTLEMENT_MISMATCH',
          'The SOL amount in this transaction is not the one you were shown.',
        );
      }
      transfers.push({ obligation, amount: actual.lamports });
      continue;
    }

    const actual = inspection.transfers[splIndex++] as TransferDetails;

    if (actual.unchecked) {
      throw new DisdkError(
        'UNSAFE_TRANSACTION',
        'This transaction uses an unchecked transfer, which cannot confirm the token.',
      );
    }
    if (actual.mint !== obligation.mint) {
      throw new DisdkError('SETTLEMENT_MISMATCH', 'A transfer is for a different token.');
    }
    if (actual.owner !== expected.owner) {
      throw new DisdkError('SETTLEMENT_MISMATCH', 'A transfer is from a different wallet.');
    }
    if (actual.decimals !== obligation.decimals) {
      throw new DisdkError(
        'SETTLEMENT_MISMATCH',
        'A transfer declares unexpected token decimals.',
      );
    }
    if (actual.amount !== BigInt(obligation.amount)) {
      throw new DisdkError(
        'SETTLEMENT_MISMATCH',
        'An amount in this transaction does not match the amount you were shown.',
      );
    }

    const wanted = expected.destinationAccounts[obligation.mint];
    if (!wanted) {
      throw new DisdkError(
        'SETTLEMENT_MISMATCH',
        `No destination account was derived for ${obligation.mint}.`,
      );
    }
    if (actual.destination !== wanted) {
      throw new DisdkError(
        'SETTLEMENT_MISMATCH',
        'A transfer credits an account that is not the settlement destination.',
      );
    }

    transfers.push({ obligation, amount: actual.amount });
  }

  return {
    transfers,
    owner: expected.owner,
    destination: expected.destination,
    createsAccount: inspection.createsAccount,
    lookupTables: inspection.decoded.lookups.map((l) => l.lookupTableAddress),
  };
}

/**
 * The shared safety checks, in the settlement's version.
 *
 * Identical to a charge's except on lookup tables, which a settlement may use
 * and a charge may not. "May use" is still narrow: only a table the caller
 * supplied the contents of, which in practice means one it fetched from the
 * chain and matched against the operator's configured set.
 */
function assertSettlementSafety(
  inspection: TransactionInspection,
  expected: SettlementExpectation,
): void {
  const { decoded } = inspection;

  for (const lookup of decoded.lookups) {
    if (!expected.lookupTables?.[lookup.lookupTableAddress]) {
      throw new DisdkError(
        'UNSAFE_TRANSACTION',
        `This transaction hides accounts behind the lookup table ${lookup.lookupTableAddress}, which was not verified.`,
      );
    }
  }

  if (inspection.disallowedPrograms.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      `This transaction calls an unexpected program: ${inspection.disallowedPrograms.join(', ')}.`,
    );
  }

  if (inspection.unknownTokenInstructions.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      `This transaction contains an unexpected token instruction (${inspection.unknownTokenInstructions.join(', ')}).`,
    );
  }

  // Assign or CreateAccount here would hand an account to another program, or
  // spend the wallet's lamports on rent for something it never agreed to.
  if (inspection.unknownSystemInstructions.length > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      `This transaction contains an unexpected system instruction (${inspection.unknownSystemInstructions.join(', ')}).`,
    );
  }

  if (decoded.feePayer !== expected.feePayer) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction would be paid for by an unexpected account.',
    );
  }
}

/**
 * A payment must never also change an allowance. Both approve variants are
 * refused — the unchecked one cannot even name the token it is delegating — and
 * so is a revoke, since a flow that moves funds has no business quietly editing
 * a permission the user set up elsewhere.
 */
function assertNoApproval(inspection: TransactionInspection): void {
  if (inspection.approve) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction would also grant a spending allowance. It will not be signed.',
    );
  }
  if (inspection.revokes > 0) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction changes an allowance, which a payment must never do.',
    );
  }
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getUint32(0, true);
}
