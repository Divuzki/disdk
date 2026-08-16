/**
 * A minimal Solana transaction decoder, so the SDK can tell the user what they
 * are actually signing.
 *
 * The server says what the transaction contains; this module checks that claim
 * against the bytes. The amount shown in the modal comes from here, not from
 * the server's JSON, and anything outside a narrow instruction allowlist is
 * refused before the wallet is ever asked to sign.
 */

import { DisdkError } from '@disdk/protocol';
import { base58Encode, base64Decode } from './codec.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** SPL Token instruction discriminators, from the token program's layout. */
const IX_APPROVE = 4;
const IX_REVOKE = 5;
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

export interface TransactionInspection {
  decoded: DecodedTransaction;
  approve: ApproveDetails | null;
  revokes: number;
  createsAccount: boolean;
  /** Programs present that are not on the allowlist. */
  disallowedPrograms: string[];
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
]);

export function inspectTransaction(transactionBase64: string): TransactionInspection {
  const decoded = decodeTransaction(transactionBase64);

  let approve: ApproveDetails | null = null;
  let revokes = 0;
  let createsAccount = false;
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
    } else {
      // Any other token instruction — Transfer, Burn, SetAuthority, CloseAccount
      // — has no business in a permit transaction.
      throw new DisdkError(
        'UNSAFE_TRANSACTION',
        `This transaction contains an unexpected token instruction (${tag ?? 'empty'}).`,
      );
    }
  }

  return { decoded, approve, revokes, createsAccount, disallowedPrograms };
}

export interface PermitExpectation {
  feePayer: string;
  owner: string;
  mint: string;
  delegate: string;
  /** Base-unit amount the server said it encoded. */
  amount: bigint;
  decimals: number;
}

export interface VerifiedPermit {
  /** The amount read out of the transaction bytes — this is what the UI shows. */
  amount: bigint;
  delegate: string;
  mint: string;
  owner: string;
  createsAccount: boolean;
}

/**
 * Refuse to sign anything that is not exactly the approval we were promised.
 *
 * Every check here is about what the *user* is agreeing to. The server cannot
 * widen the allowance, redirect it to another delegate, swap the token, or
 * smuggle in a transfer without this failing first.
 */
export function verifyPermitTransaction(
  transactionBase64: string,
  expected: PermitExpectation,
): VerifiedPermit {
  const inspection = inspectTransaction(transactionBase64);
  const { decoded, approve } = inspection;

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

  if (decoded.feePayer !== expected.feePayer) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction would be paid for by an unexpected account.',
    );
  }

  if (!approve) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'This transaction contains no approval.');
  }

  if (approve.unchecked) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'This transaction uses an unchecked approval, which cannot confirm the token.',
    );
  }

  if (approve.mint !== expected.mint) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'This approval is for a different token.');
  }

  if (approve.delegate !== expected.delegate) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'This approval names an unexpected delegate.');
  }

  if (approve.owner !== expected.owner) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'This approval is for a different wallet.');
  }

  if (approve.decimals !== expected.decimals) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'This approval declares unexpected token decimals.');
  }

  if (approve.amount !== expected.amount) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'The amount in this transaction does not match the amount you were shown.',
    );
  }

  return {
    amount: approve.amount,
    delegate: approve.delegate,
    mint: approve.mint,
    owner: approve.owner,
    createsAccount: inspection.createsAccount,
  };
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}
