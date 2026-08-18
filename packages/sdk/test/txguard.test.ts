import { describe, expect, it } from 'vitest';
import {
  appendTransactionMessageInstructions,
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  none,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  AccountState,
  TOKEN_PROGRAM_ADDRESS,
  getApproveCheckedInstruction,
  getApproveInstruction,
  getBurnInstruction,
  getRevokeInstruction,
  getTokenEncoder,
  getTransferInstruction,
} from '@solana-program/token';
import { base58Decode, base58Encode, base64Decode, base64Encode } from '../src/codec.js';
import { inspectTransaction, verifyPermitTransaction } from '../src/txguard.js';

const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const DELEGATE = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const OTHER = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const ATA = address('2rMHUAgtqQXGWs2XLPzuqEXMigYmjFo2dbTdVpuHrTrs');
const BLOCKHASH = blockhash('11111111111111111111111111111111');

const AMOUNT = 800_000_000n;

async function buildTx(
  instructions: Instruction[],
  sponsor: KeyPairSigner,
): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sponsor, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
      m,
    ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

function approveIx(owner: Address, overrides: Partial<{ delegate: Address; mint: Address; amount: bigint; decimals: number }> = {}) {
  return getApproveCheckedInstruction({
    source: ATA,
    mint: overrides.mint ?? MINT,
    delegate: overrides.delegate ?? DELEGATE,
    owner: createNoopSigner(owner),
    amount: overrides.amount ?? AMOUNT,
    decimals: overrides.decimals ?? 6,
  });
}

async function setup() {
  const sponsor = await generateKeyPairSigner();
  const owner = await generateKeyPairSigner();
  const expectation = {
    feePayer: sponsor.address as string,
    owner: owner.address as string,
    mint: MINT as string,
    delegate: DELEGATE as string,
    amount: AMOUNT,
    decimals: 6,
  };
  return { sponsor, owner, expectation };
}

describe('codec', () => {
  it('round-trips base58 addresses', () => {
    for (const value of [MINT, DELEGATE, ATA, '11111111111111111111111111111111']) {
      const bytes = base58Decode(value);
      expect(bytes.length).toBe(32);
      expect(base58Encode(bytes)).toBe(value);
    }
  });

  it('preserves leading zero bytes', () => {
    const bytes = new Uint8Array(32);
    bytes[31] = 1;
    expect(base58Encode(bytes)).toBe('11111111111111111111111111111112');
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it('rejects invalid base58 characters', () => {
    expect(() => base58Decode('0OIl')).toThrowError(/Invalid base58/);
  });

  it('round-trips base64 over a large payload', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
  });
});

describe('decoding a real sponsored permit', () => {
  it('reads the amount, delegate, mint and owner out of the bytes', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([approveIx(owner.address)], sponsor);

    const result = verifyPermitTransaction(tx, expectation);
    expect(result.amount).toBe(AMOUNT);
    expect(result.delegate).toBe(DELEGATE);
    expect(result.mint).toBe(MINT);
    expect(result.owner).toBe(owner.address);
  });

  it('identifies the sponsor as fee payer, not the user', async () => {
    const { sponsor, owner } = await setup();
    const tx = await buildTx([approveIx(owner.address)], sponsor);

    const { decoded } = inspectTransaction(tx);
    expect(decoded.feePayer).toBe(sponsor.address);
    expect(decoded.feePayer).not.toBe(owner.address);
  });

  it('accepts the session-binding memo', async () => {
    const { sponsor, owner, expectation } = await setup();
    // The server writes a per-session marker so an approval cannot be replayed
    // into someone else's session. It holds no accounts, so it is harmless.
    const memo: Instruction = {
      programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      accounts: [],
      data: new TextEncoder().encode('disdk:9f2c1ab4de77'),
    };
    const tx = await buildTx([memo, approveIx(owner.address)], sponsor);

    const result = verifyPermitTransaction(tx, expectation);
    expect(result.amount).toBe(AMOUNT);
  });

  it('accepts an accompanying token-account creation', async () => {
    const { sponsor, owner, expectation } = await setup();
    // Mirrors what the server emits for a wallet that has never held USDC.
    const create: Instruction = {
      programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      accounts: [],
      data: new Uint8Array([1]),
    };
    const tx = await buildTx([create, approveIx(owner.address)], sponsor);

    const result = verifyPermitTransaction(tx, expectation);
    expect(result.createsAccount).toBe(true);
  });
});

describe('refusing unsafe transactions', () => {
  it('refuses an amount larger than the one displayed', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([approveIx(owner.address, { amount: AMOUNT * 2n })], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(
      /amount in this transaction does not match/i,
    );
  });

  it('refuses a redirected delegate', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([approveIx(owner.address, { delegate: OTHER })], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(/unexpected delegate/i);
  });

  it('refuses a swapped token', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([approveIx(owner.address, { mint: OTHER })], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(/different token/i);
  });

  it('refuses an approval for a different wallet', async () => {
    const { sponsor, expectation } = await setup();
    const someoneElse = await generateKeyPairSigner();
    const tx = await buildTx([approveIx(someoneElse.address)], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(/different wallet/i);
  });

  it('refuses a smuggled transfer', async () => {
    const { sponsor, owner, expectation } = await setup();
    const transfer = getTransferInstruction({
      source: ATA,
      destination: OTHER,
      authority: createNoopSigner(owner.address),
      amount: 1_000_000n,
    });
    const tx = await buildTx([approveIx(owner.address), transfer], sponsor);

    // Still refused after `inspectTransaction` was changed to collect transfers
    // rather than throw on them — now by a dedicated rule in the permit guard,
    // which is why the message is more specific than the generic bucket below.
    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(
      /move tokens, which an approval must never do/i,
    );
  });

  it('refuses a smuggled burn', async () => {
    const { sponsor, owner, expectation } = await setup();
    const burn = getBurnInstruction({
      account: ATA,
      mint: MINT,
      authority: createNoopSigner(owner.address),
      amount: 1n,
    });
    const tx = await buildTx([approveIx(owner.address), burn], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(
      /unexpected token instruction/i,
    );
  });

  it('refuses the unchecked Approve variant, which cannot confirm the token', async () => {
    const { sponsor, owner, expectation } = await setup();
    const unchecked = getApproveInstruction({
      source: ATA,
      delegate: DELEGATE,
      owner: createNoopSigner(owner.address),
      amount: AMOUNT,
    });
    const tx = await buildTx([unchecked], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(/unchecked approval/i);
  });

  it('refuses a call to an unknown program', async () => {
    const { sponsor, owner, expectation } = await setup();
    const evil: Instruction = {
      programAddress: address('Stake11111111111111111111111111111111111111'),
      accounts: [],
      data: new Uint8Array([1, 2, 3]),
    };
    const tx = await buildTx([approveIx(owner.address), evil], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(/unexpected program/i);
  });

  it('refuses a transaction paid for by someone else', async () => {
    const { owner, expectation } = await setup();
    const otherSponsor = await generateKeyPairSigner();
    const tx = await buildTx([approveIx(owner.address)], otherSponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(/unexpected account/i);
  });

  it('refuses a transaction with no approval at all', async () => {
    const { sponsor, owner, expectation } = await setup();
    const revoke = getRevokeInstruction({ source: ATA, owner: createNoopSigner(owner.address) });
    const tx = await buildTx([revoke], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(/no approval/i);
  });

  it('refuses mismatched decimals', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([approveIx(owner.address, { decimals: 9 })], sponsor);

    expect(() => verifyPermitTransaction(tx, expectation)).toThrowError(/unexpected token decimals/i);
  });

  it('refuses garbage input', async () => {
    const { expectation } = await setup();
    expect(() => verifyPermitTransaction('!!!not-base64!!!', expectation)).toThrowError(
      /could not be decoded/i,
    );
    expect(() => verifyPermitTransaction('AAAA', expectation)).toThrowError(/could not be decoded/i);
  });
});
