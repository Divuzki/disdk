/**
 * A minimal Solana transaction decoder, so the SDK can tell the user what they
 * are actually signing.
 *
 * The server says what the transaction contains; this module checks that claim
 * against the bytes. The amount shown in the modal comes from here, not from
 * the server's JSON, and anything outside a narrow instruction allowlist is
 * refused before the wallet is ever asked to sign.
 */

import { DisdkError, type FeePayerRole } from '@disdk/protocol';
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

export interface DecodedTransaction {
  version: 'legacy' | number;
  numRequiredSignatures: number;
  feePayer: string;
  accountKeys: string[];
  recentBlockhash: string;
  instructions: DecodedInstruction[];
  /**
   * Address lookup tables let a transaction reference accounts that are not in
   * the message itself, which would defeat this whole inspection. Our server
   * never emits them, so their presence is treated as hostile.
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

export interface TransactionInspection {
  decoded: DecodedTransaction;
  approve: ApproveDetails | null;
  transfers: TransferDetails[];
  closes: CloseDetails[];
  revokes: number;
  createsAccount: boolean;
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

export function decodeTransaction(transactionBase64: string): DecodedTransaction {
  let reader: Reader;
  try {
    reader = new Reader(base64Decode(transactionBase64));
  } catch {
    throw new DisdkError('UNSAFE_TRANSACTION', 'The transaction could not be decoded.');
  }

  try {
    return readTransaction(reader);
  } catch (error) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      `The transaction could not be decoded: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

function readTransaction(reader: Reader): DecodedTransaction {
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
  const instructions: DecodedInstruction[] = [];
  for (let i = 0; i < instructionCount; i++) {
    const programIdIndex = reader.u8();
    const accountIndexCount = reader.compactU16();
    const accounts: string[] = [];
    for (let j = 0; j < accountIndexCount; j++) {
      const index = reader.u8();
      const key = accountKeys[index];
      if (key === undefined) throw new Error('instruction references an unknown account');
      accounts.push(key);
    }
    const dataLength = reader.compactU16();
    const data = new Uint8Array(reader.take(dataLength));

    const programId = accountKeys[programIdIndex];
    if (programId === undefined) throw new Error('instruction references an unknown program');
    instructions.push({ programId, accounts, data });
  }

  let usesAddressLookupTables = false;
  if (version !== 'legacy' && reader.remaining > 0) {
    usesAddressLookupTables = reader.compactU16() > 0;
  }

  const feePayer = accountKeys[0];
  if (feePayer === undefined) throw new Error('transaction has no accounts');

  return {
    version,
    numRequiredSignatures,
    feePayer,
    accountKeys,
    recentBlockhash,
    instructions,
    usesAddressLookupTables,
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
export function inspectTransaction(transactionBase64: string): TransactionInspection {
  const decoded = decodeTransaction(transactionBase64);

  let approve: ApproveDetails | null = null;
  let revokes = 0;
  let createsAccount = false;
  const transfers: TransferDetails[] = [];
  const closes: CloseDetails[] = [];
  const unknownTokenInstructions: number[] = [];
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
    closes,
    revokes,
    createsAccount,
    disallowedPrograms,
    unknownTokenInstructions,
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

  const transfer = verifyExactTransfer(inspection, expected);

  return {
    amount: transfer.amount,
    mint: transfer.mint,
    destination: transfer.destination,
    owner: transfer.owner,
    createsAccount: inspection.createsAccount,
  };
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
