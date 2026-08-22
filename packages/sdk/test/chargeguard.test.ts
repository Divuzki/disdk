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
  getBurnInstruction,
  getCloseAccountInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from '@solana-program/token';
import { verifyChargeTransaction } from '../src/txguard.js';

const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const OTHER_MINT = address('So11111111111111111111111111111111111111112');
const TREASURY_ATA = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const ATTACKER = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const SOURCE_ATA = address('2rMHUAgtqQXGWs2XLPzuqEXMigYmjFo2dbTdVpuHrTrs');
const BLOCKHASH = blockhash('11111111111111111111111111111111');

/** 20 USDC — a price, not a share of anything. */
const AMOUNT = 20_000_000n;

async function buildTx(instructions: Instruction[], sponsor: KeyPairSigner): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sponsor, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

function transferIx(
  owner: Address,
  overrides: Partial<{
    mint: Address;
    destination: Address;
    amount: bigint;
    decimals: number;
    source: Address;
  }> = {},
) {
  return getTransferCheckedInstruction({
    source: overrides.source ?? SOURCE_ATA,
    mint: overrides.mint ?? MINT,
    destination: overrides.destination ?? TREASURY_ATA,
    authority: createNoopSigner(owner),
    amount: overrides.amount ?? AMOUNT,
    decimals: overrides.decimals ?? 6,
  });
}

async function setup() {
  const sponsor = await generateKeyPairSigner();
  const owner = await generateKeyPairSigner();
  return {
    sponsor,
    owner,
    expectation: {
      feePayer: sponsor.address as string,
      owner: owner.address as string,
      mint: MINT as string,
      destination: TREASURY_ATA as string,
      amount: AMOUNT,
      decimals: 6,
    },
  };
}

describe('verifyChargeTransaction', () => {
  it('accepts the payment it was promised', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([transferIx(owner.address)], sponsor);

    const verified = verifyChargeTransaction(tx, expectation);
    expect(verified.amount).toBe(AMOUNT);
    expect(verified.destination).toBe(TREASURY_ATA);
    expect(verified.owner).toBe(owner.address);
    expect(verified.createsAccount).toBe(false);
  });

  // The reason this guard exists at all.
  //
  // A checkout is the easiest place in this project to slip a standing
  // allowance past someone: they have already decided to pay, they are looking
  // for the confirm button, and the transfer they reviewed really does happen.
  // The approval is the part that outlives the purchase, so it is refused
  // outright rather than merely displayed.
  it('refuses a payment that also grants an allowance', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        transferIx(owner.address),
        getApproveCheckedInstruction({
          source: SOURCE_ATA,
          mint: MINT,
          delegate: ATTACKER,
          owner: createNoopSigner(owner.address),
          amount: 1_000_000_000n,
          decimals: 6,
        }),
      ],
      sponsor,
    );

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/spending allowance/i);
  });

  it('refuses the unchecked approval variant just as firmly', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        transferIx(owner.address),
        getApproveInstruction({
          source: SOURCE_ATA,
          delegate: ATTACKER,
          owner: createNoopSigner(owner.address),
          amount: 1_000_000_000n,
        }),
      ],
      sponsor,
    );

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/spending allowance/i);
  });

  // Not obviously an attack, which is exactly why it is listed. A payment has no
  // business editing a permission the user set up somewhere else, and a flow
  // that may quietly revoke may later be extended to quietly re-approve.
  it('refuses a payment that also revokes an allowance', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        transferIx(owner.address),
        getRevokeInstruction({ source: SOURCE_ATA, owner: createNoopSigner(owner.address) }),
      ],
      sponsor,
    );

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/changes an allowance/i);
  });

  it('refuses a payment that also closes an account', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        transferIx(owner.address),
        getCloseAccountInstruction({
          account: SOURCE_ATA,
          destination: ATTACKER,
          owner: createNoopSigner(owner.address),
        }),
      ],
      sponsor,
    );

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/close a token account/i);
  });

  it('refuses a second transfer hidden behind the first', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        transferIx(owner.address),
        transferIx(owner.address, { destination: ATTACKER, amount: 5_000_000n }),
      ],
      sponsor,
    );

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/more than one transfer/i);
  });

  it('refuses a payment redirected to another account', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { destination: ATTACKER })], sponsor);

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/unexpected destination/i);
  });

  it('refuses a larger amount than the one displayed', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { amount: AMOUNT * 10n })], sponsor);

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/does not match/i);
  });

  // A smaller amount is refused too. This guard's job is not "stop the user
  // overpaying", it is "the bytes are what you were shown" — and a mismatch in
  // either direction means the server and the screen disagree.
  it('refuses a smaller amount than the one displayed', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { amount: 1n })], sponsor);

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/does not match/i);
  });

  it('refuses a different token', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { mint: OTHER_MINT })], sponsor);

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/different token/i);
  });

  it('refuses a transfer from a different wallet', async () => {
    const { sponsor, expectation } = await setup();
    const other = await generateKeyPairSigner();
    const tx = await buildTx([transferIx(other.address)], sponsor);

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/different wallet/i);
  });

  // The unchecked variant carries no mint account, so the token program itself
  // cannot confirm which token is moving. Nothing downstream can recover that.
  it('refuses the unchecked transfer variant', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        getTransferInstruction({
          source: SOURCE_ATA,
          destination: TREASURY_ATA,
          authority: createNoopSigner(owner.address),
          amount: AMOUNT,
        }),
      ],
      sponsor,
    );

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/unchecked transfer/i);
  });

  it('refuses mismatched decimals', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { decimals: 9 })], sponsor);

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/unexpected token decimals/i);
  });

  it('refuses a transaction paid for by an unexpected account', async () => {
    const { owner, expectation } = await setup();
    const stranger = await generateKeyPairSigner();
    const tx = await buildTx([transferIx(owner.address)], stranger);

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/unexpected account/i);
  });

  it('refuses an unrecognised token instruction such as a burn', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        transferIx(owner.address),
        getBurnInstruction({
          account: SOURCE_ATA,
          mint: MINT,
          authority: createNoopSigner(owner.address),
          amount: 1n,
        }),
      ],
      sponsor,
    );

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(
      /unexpected token instruction/i,
    );
  });

  it('refuses an empty transaction', async () => {
    const { sponsor, expectation } = await setup();
    const tx = await buildTx([], sponsor);

    expect(() => verifyChargeTransaction(tx, expectation)).toThrowError(/no transfer/i);
  });

  it('refuses input that is not a transaction', async () => {
    const { expectation } = await setup();

    expect(() => verifyChargeTransaction('not-base64-at-all!!', expectation)).toThrowError(
      /could not be decoded/i,
    );
  });
});
