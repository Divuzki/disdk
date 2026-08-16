import { describe, expect, it } from 'vitest';
import { DisdkError } from '@disdk/protocol';
import { address, getBase64EncodedWireTransaction, signBytes } from '@solana/kit';
import { buildPermitTransaction } from '../src/build.js';
import { verifySignedTransaction } from '../src/verifyTx.js';
import {
  OTHER_DELEGATE,
  TEST_DELEGATE,
  TEST_MINT,
  decodeTransaction,
  emptyRpc,
  newSigner,
  rpcWithBalance,
  walletSign,
} from './helpers.js';
import type { PermitConfig } from '../src/build.js';

const BASE_CONFIG: PermitConfig = {
  mint: TEST_MINT,
  decimals: 6,
  symbol: 'USDC',
  delegate: TEST_DELEGATE,
  strategy: { kind: 'percentOfBalance', percent: 0.8 },
};

/** 1,000 USDC. */
const BALANCE = 1_000_000_000n;

async function setup(configOverrides: Partial<PermitConfig> = {}, balance = BALANCE) {
  const sponsor = await newSigner();
  const owner = await newSigner();
  const { rpc } = await rpcWithBalance(owner.address, balance, configOverrides.mint ?? TEST_MINT);
  const config = { ...BASE_CONFIG, ...configOverrides };
  const built = await buildPermitTransaction(rpc, sponsor, owner.address, config);
  return { sponsor, owner, rpc, built, config };
}

describe('sponsored permit transaction', () => {
  it('approves 80% of the balance by default', async () => {
    const { built } = await setup();
    expect(built.amount).toBe(800_000_000n);
    expect(built.amountUi).toBe('800.00');
    expect(built.balanceAtBuild).toBe(BALANCE);
  });

  it('makes the sponsor the fee payer, not the user', async () => {
    const { built, sponsor, owner } = await setup();
    expect(built.feePayer).toBe(sponsor.address);
    expect(built.owner).toBe(owner.address);
  });

  it('leaves the owner signature slot empty for the wallet to fill', async () => {
    const { built, sponsor, owner } = await setup();
    const transaction = decodeTransaction(built.transactionBase64);
    expect(transaction.signatures[sponsor.address]).not.toBeNull();
    expect(transaction.signatures[owner.address]).toBeNull();
  });

  it('accepts the honest round trip', async () => {
    const { built, owner } = await setup();
    const signed = await walletSign(built.transactionBase64, owner);
    await expect(verifySignedTransaction(signed, built)).resolves.toBeDefined();
  });
});

describe('tamper matrix', () => {
  // Each case produces a transaction that is internally valid but is not the
  // one this session issued. All must be rejected before broadcast.

  it('rejects a swapped delegate', async () => {
    const { built, owner, rpc, sponsor } = await setup();
    const evil = await buildPermitTransaction(rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      delegate: OTHER_DELEGATE,
    });
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toThrow(DisdkError);
    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects an inflated amount', async () => {
    const { built, owner, rpc, sponsor } = await setup();
    const evil = await buildPermitTransaction(rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      strategy: { kind: 'unlimited' },
    });
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a different fee payer', async () => {
    const { built, owner, rpc } = await setup();
    const otherSponsor = await newSigner();
    const evil = await buildPermitTransaction(rpc, otherSponsor, owner.address, BASE_CONFIG);
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a transaction issued for a different owner', async () => {
    const { built, sponsor } = await setup();
    const otherOwner = await newSigner();
    const { rpc: otherRpc } = await rpcWithBalance(otherOwner.address, BALANCE);
    const evil = await buildPermitTransaction(otherRpc, sponsor, otherOwner.address, BASE_CONFIG);
    const signed = await walletSign(evil.transactionBase64, otherOwner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a transaction with no wallet signature', async () => {
    const { built } = await setup();
    // The sponsor-signed transaction, returned unchanged.
    await expect(verifySignedTransaction(built.transactionBase64, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a wallet signature produced by the wrong key', async () => {
    const { built, owner } = await setup();
    const impostor = await newSigner();

    // Produce a real ed25519 signature over the correct message bytes, but with
    // the wrong key, then file it under the owner's slot.
    const transaction = decodeTransaction(built.transactionBase64);
    const forgedSignature = await signBytes(impostor.keyPair.privateKey, transaction.messageBytes);

    const spliced = {
      messageBytes: transaction.messageBytes,
      signatures: { ...transaction.signatures, [owner.address]: forgedSignature },
    };
    const signed = getBase64EncodedWireTransaction(
      spliced as Parameters<typeof getBase64EncodedWireTransaction>[0],
    );

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects undecodable input', async () => {
    const { built } = await setup();
    await expect(verifySignedTransaction('not-base64-at-all!!', built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a transaction built against a different mint', async () => {
    const { built, owner, sponsor } = await setup();
    const otherMint = address('So11111111111111111111111111111111111111112');
    const { rpc: otherRpc } = await rpcWithBalance(owner.address, BALANCE, otherMint);
    const evil = await buildPermitTransaction(otherRpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      mint: otherMint,
    });
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });
});

describe('account creation', () => {
  it('creates the ATA at the sponsor expense when the wallet has never held USDC', async () => {
    const sponsor = await newSigner();
    const owner = await newSigner();
    const rpc = emptyRpc();

    // percentOfBalance cannot work on an empty wallet, but unlimited can.
    const built = await buildPermitTransaction(rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      strategy: { kind: 'unlimited' },
    });

    expect(built.balanceAtBuild).toBe(0n);
    expect(built.amountUi).toBe('Unlimited');
  });

  it('refuses to spend sponsor rent when the balance cannot support an allowance', async () => {
    const sponsor = await newSigner();
    const owner = await newSigner();
    const rpc = emptyRpc();

    await expect(
      buildPermitTransaction(rpc, sponsor, owner.address, BASE_CONFIG),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });
});
