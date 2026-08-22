import { describe, expect, it } from 'vitest';
import {
  appendTransactionMessageInstructions,
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  getApproveCheckedInstruction,
  getApproveInstruction,
  getCloseAccountInstruction,
  getRevokeInstruction,
} from '@solana-program/token';
import { base58Decode, base58Encode, base64Decode, base64Encode } from '../src/codec.js';
import { decodeTransaction, inspectTransaction } from '../src/txguard.js';

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

function approveIx(
  owner: Address,
  overrides: Partial<{ delegate: Address; mint: Address; amount: bigint; decimals: number }> = {},
) {
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
  return { sponsor, owner };
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

/**
 * The decoder still understands approvals, revokes and closes even though this
 * SDK no longer builds any of them.
 *
 * That is the whole point and it is worth a test of its own: a guard that only
 * recognised the instructions it expected to find could not refuse the ones it
 * did not. These assertions are what keeps `verifyChargeTransaction`'s refusals
 * meaningful — if `inspectTransaction` ever stopped reporting an approval, the
 * charge guard would start silently accepting one.
 */
describe('inspectTransaction still sees what nothing here builds', () => {
  it('reports a checked approval in full', async () => {
    const { sponsor, owner } = await setup();
    const tx = await buildTx([approveIx(owner.address)], sponsor);

    const { approve } = inspectTransaction(tx);
    expect(approve).toMatchObject({
      source: ATA,
      mint: MINT,
      delegate: DELEGATE,
      owner: owner.address,
      amount: AMOUNT,
      decimals: 6,
      unchecked: false,
    });
  });

  it('reports the unchecked Approve variant, which cannot name its token', async () => {
    const { sponsor, owner } = await setup();
    const unchecked = getApproveInstruction({
      source: ATA,
      delegate: DELEGATE,
      owner: createNoopSigner(owner.address),
      amount: AMOUNT,
    });
    const tx = await buildTx([unchecked], sponsor);

    const { approve } = inspectTransaction(tx);
    expect(approve).toMatchObject({ delegate: DELEGATE, amount: AMOUNT, unchecked: true });
    expect(approve?.mint).toBe('');
  });

  it('counts revokes', async () => {
    const { sponsor, owner } = await setup();
    const revoke = getRevokeInstruction({ source: ATA, owner: createNoopSigner(owner.address) });
    const tx = await buildTx([revoke], sponsor);

    expect(inspectTransaction(tx).revokes).toBe(1);
  });

  it('reports a close and where its rent would go', async () => {
    const { sponsor, owner } = await setup();
    const close = getCloseAccountInstruction({
      account: ATA,
      destination: OTHER,
      owner: createNoopSigner(owner.address),
    });
    const tx = await buildTx([close], sponsor);

    expect(inspectTransaction(tx).closes).toEqual([
      { account: ATA, destination: OTHER, owner: owner.address },
    ]);
  });

  it('names a program that is not on the allowlist', async () => {
    const { sponsor, owner } = await setup();
    const evil: Instruction = {
      programAddress: address('Stake11111111111111111111111111111111111111'),
      accounts: [],
      data: new Uint8Array([1, 2, 3]),
    };
    const tx = await buildTx([approveIx(owner.address), evil], sponsor);

    expect(inspectTransaction(tx).disallowedPrograms).toEqual([
      'Stake11111111111111111111111111111111111111',
    ]);
  });

  it('identifies the fee payer out of the bytes rather than trusting a claim', async () => {
    const { sponsor, owner } = await setup();
    const tx = await buildTx([approveIx(owner.address)], sponsor);

    const { decoded } = inspectTransaction(tx);
    expect(decoded.feePayer).toBe(sponsor.address);
    expect(decoded.feePayer).not.toBe(owner.address);
    expect(decoded.usesAddressLookupTables).toBe(false);
  });

  it('refuses input it cannot decode at all', () => {
    expect(() => decodeTransaction('!!!not-base64!!!')).toThrowError(/could not be decoded/i);
    expect(() => decodeTransaction('AAAA')).toThrowError(/could not be decoded/i);
  });
});
