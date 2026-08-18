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
  getBurnInstruction,
  getCloseAccountInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from '@solana-program/token';
import { verifySweepClose, verifySweepTransfer } from '../src/txguard.js';

const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const OTHER_MINT = address('So11111111111111111111111111111111111111112');
const COLD_ATA = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const ATTACKER = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const SOURCE_ATA = address('2rMHUAgtqQXGWs2XLPzuqEXMigYmjFo2dbTdVpuHrTrs');
const EMPTY_A = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const EMPTY_B = address('BPFLoaderUpgradeab1e11111111111111111111111');
const BLOCKHASH = blockhash('11111111111111111111111111111111');

const AMOUNT = 800_000_000n;

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
  }> = {},
) {
  return getTransferCheckedInstruction({
    source: SOURCE_ATA,
    mint: overrides.mint ?? MINT,
    destination: overrides.destination ?? COLD_ATA,
    authority: createNoopSigner(owner),
    amount: overrides.amount ?? AMOUNT,
    decimals: overrides.decimals ?? 6,
  });
}

function closeIx(owner: Address, account: Address, destination: Address) {
  return getCloseAccountInstruction({
    account,
    destination,
    owner: createNoopSigner(owner),
  });
}

async function setup() {
  const sponsor = await generateKeyPairSigner();
  const owner = await generateKeyPairSigner();
  return {
    sponsor,
    owner,
    transferExpectation: {
      feePayer: sponsor.address as string,
      owner: owner.address as string,
      mint: MINT as string,
      destination: COLD_ATA as string,
      amount: AMOUNT,
      decimals: 6,
    },
    closeExpectation: {
      feePayer: sponsor.address as string,
      owner: owner.address as string,
      rentTo: COLD_ATA as string,
      accounts: [EMPTY_A as string, EMPTY_B as string],
      maxAccounts: 15,
    },
  };
}

describe('verifySweepTransfer', () => {
  it('accepts the transfer it was promised', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const tx = await buildTx([transferIx(owner.address)], sponsor);

    const verified = verifySweepTransfer(tx, transferExpectation);
    expect(verified.amount).toBe(AMOUNT);
    expect(verified.destination).toBe(COLD_ATA);
    expect(verified.owner).toBe(owner.address);
  });


  it('refuses a smuggled Revoke', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const revoke = getRevokeInstruction({
      source: SOURCE_ATA,
      owner: createNoopSigner(owner.address),
    });
    const tx = await buildTx([transferIx(owner.address), revoke], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(
      /changes an allowance/i,
    );
  });

  it('refuses a smuggled burn', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const burn = getBurnInstruction({
      account: SOURCE_ATA,
      mint: MINT,
      authority: createNoopSigner(owner.address),
      amount: 1n,
    });
    const tx = await buildTx([transferIx(owner.address), burn], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(
      /unexpected token instruction/i,
    );
  });

  it('refuses the unchecked Transfer variant', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const unchecked = getTransferInstruction({
      source: SOURCE_ATA,
      destination: COLD_ATA,
      authority: createNoopSigner(owner.address),
      amount: AMOUNT,
    });
    const tx = await buildTx([unchecked], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(/unchecked transfer/i);
  });

  it('refuses a redirected destination', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { destination: ATTACKER })], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(
      /unexpected destination/i,
    );
  });

  it('refuses an inflated amount', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { amount: AMOUNT * 2n })], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(/does not match/i);
  });

  it('refuses a different mint', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { mint: OTHER_MINT })], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(/different token/i);
  });

  it('refuses mismatched decimals', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const tx = await buildTx([transferIx(owner.address, { decimals: 9 })], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(
      /unexpected token decimals/i,
    );
  });

  it('refuses a transfer authorised by a different wallet', async () => {
    const { sponsor, transferExpectation } = await setup();
    const someoneElse = await generateKeyPairSigner();
    const tx = await buildTx([transferIx(someoneElse.address)], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(/different wallet/i);
  });

  it('refuses an unexpected fee payer', async () => {
    const { owner, transferExpectation } = await setup();
    const otherSponsor = await generateKeyPairSigner();
    const tx = await buildTx([transferIx(owner.address)], otherSponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(
      /paid for by an unexpected account/i,
    );
  });

  it('refuses a second transfer', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const tx = await buildTx(
      [transferIx(owner.address), transferIx(owner.address, { destination: ATTACKER })],
      sponsor,
    );

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(
      /more than one transfer/i,
    );
  });

  it('refuses a close bundled into the transfer leg', async () => {
    const { sponsor, owner, transferExpectation } = await setup();
    const tx = await buildTx(
      [transferIx(owner.address), closeIx(owner.address, EMPTY_A, COLD_ATA)],
      sponsor,
    );

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(
      /signed separately/i,
    );
  });

  it('refuses a transaction with no transfer at all', async () => {
    const { sponsor, transferExpectation } = await setup();
    const tx = await buildTx([], sponsor);

    expect(() => verifySweepTransfer(tx, transferExpectation)).toThrowError(/no transfer/i);
  });

  it('refuses undecodable input', async () => {
    const { transferExpectation } = await setup();
    expect(() => verifySweepTransfer('not-base64-at-all!!', transferExpectation)).toThrowError(
      /could not be decoded/i,
    );
  });
});

describe('verifySweepClose', () => {
  it('accepts the closes it was promised', async () => {
    const { sponsor, owner, closeExpectation } = await setup();
    const tx = await buildTx(
      [
        closeIx(owner.address, EMPTY_A, COLD_ATA),
        closeIx(owner.address, EMPTY_B, COLD_ATA),
      ],
      sponsor,
    );

    const verified = verifySweepClose(tx, closeExpectation);
    expect(verified.accounts).toHaveLength(2);
    expect(verified.rentTo).toBe(COLD_ATA);
  });

  it('refuses a redirected rent destination', async () => {
    const { sponsor, owner, closeExpectation } = await setup();
    const tx = await buildTx(
      [
        closeIx(owner.address, EMPTY_A, ATTACKER),
        closeIx(owner.address, EMPTY_B, COLD_ATA),
      ],
      sponsor,
    );

    expect(() => verifySweepClose(tx, closeExpectation)).toThrowError(
      /rent to an unexpected account/i,
    );
  });

  it('refuses closing an account that was not shown', async () => {
    const { sponsor, owner, closeExpectation } = await setup();
    const tx = await buildTx(
      [
        closeIx(owner.address, EMPTY_A, COLD_ATA),
        closeIx(owner.address, SOURCE_ATA, COLD_ATA),
      ],
      sponsor,
    );

    expect(() => verifySweepClose(tx, closeExpectation)).toThrowError(
      /account you were not shown/i,
    );
  });

  it('refuses a close owned by a different wallet', async () => {
    const { sponsor, owner, closeExpectation } = await setup();
    const someoneElse = await generateKeyPairSigner();
    const tx = await buildTx(
      [
        closeIx(owner.address, EMPTY_A, COLD_ATA),
        closeIx(someoneElse.address, EMPTY_B, COLD_ATA),
      ],
      sponsor,
    );

    expect(() => verifySweepClose(tx, closeExpectation)).toThrowError(/different wallet/i);
  });

  it('refuses more closes than the configured ceiling', async () => {
    const { sponsor, owner, closeExpectation } = await setup();
    const tx = await buildTx(
      [
        closeIx(owner.address, EMPTY_A, COLD_ATA),
        closeIx(owner.address, EMPTY_B, COLD_ATA),
      ],
      sponsor,
    );

    expect(() => verifySweepClose(tx, { ...closeExpectation, maxAccounts: 1 })).toThrowError(
      /closes more accounts than allowed/i,
    );
  });

  it('refuses a different number of closes than promised', async () => {
    const { sponsor, owner, closeExpectation } = await setup();
    const tx = await buildTx([closeIx(owner.address, EMPTY_A, COLD_ATA)], sponsor);

    expect(() => verifySweepClose(tx, closeExpectation)).toThrowError(
      /different number of accounts/i,
    );
  });

  it('refuses a smuggled approval in the close leg', async () => {
    const { sponsor, owner, closeExpectation } = await setup();
    const approve = getApproveCheckedInstruction({
      source: SOURCE_ATA,
      mint: MINT,
      delegate: ATTACKER,
      owner: createNoopSigner(owner.address),
      amount: AMOUNT,
      decimals: 6,
    });
    const tx = await buildTx(
      [
        closeIx(owner.address, EMPTY_A, COLD_ATA),
        closeIx(owner.address, EMPTY_B, COLD_ATA),
        approve,
      ],
      sponsor,
    );

    expect(() => verifySweepClose(tx, closeExpectation)).toThrowError(
      /grant a spending allowance/i,
    );
  });

  it('refuses a transfer bundled into the close leg', async () => {
    const { sponsor, owner, closeExpectation } = await setup();
    const tx = await buildTx(
      [
        closeIx(owner.address, EMPTY_A, COLD_ATA),
        closeIx(owner.address, EMPTY_B, COLD_ATA),
        transferIx(owner.address, { destination: ATTACKER }),
      ],
      sponsor,
    );

    expect(() => verifySweepClose(tx, closeExpectation)).toThrowError(/move tokens as well/i);
  });

  it('refuses a transaction that closes nothing', async () => {
    const { sponsor, closeExpectation } = await setup();
    const tx = await buildTx([], sponsor);

    expect(() => verifySweepClose(tx, closeExpectation)).toThrowError(/closes no accounts/i);
  });
});
