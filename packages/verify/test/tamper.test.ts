import { describe, expect, it } from 'vitest';
import { DisdkError } from '@disdk/protocol';
import { address, getBase64EncodedWireTransaction, signBytes } from '@solana/kit';
import { buildChargePaymentTransaction } from '../src/build.js';
import { verifySignedTransaction } from '../src/verifyTx.js';
import { createMockRpc, mockTokenAccountFor } from '../src/testing.js';
import { deriveAta } from '../src/token.js';
import { TEST_MINT, decodeTransaction, newSigner, walletSign } from './helpers.js';
import type { ChargeSessionConfig } from '../src/build.js';

const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const OTHER_TREASURY = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');

/** 1,000 USDC held, 20 USDC charged. */
const BALANCE = 1_000_000_000n;
const PRICE = 20_000_000n;

const BASE_CONFIG: ChargeSessionConfig = {
  mint: TEST_MINT,
  decimals: 6,
  symbol: 'USDC',
  treasury: TREASURY,
};

async function setup(
  configOverrides: Partial<ChargeSessionConfig> = {},
  options: { balance?: bigint; mint?: typeof TEST_MINT } = {},
) {
  const sponsor = await newSigner();
  const owner = await newSigner();
  const mint = options.mint ?? TEST_MINT;
  const mock = createMockRpc();

  await mockTokenAccountFor(mock, owner.address, mint, options.balance ?? BALANCE);
  await mockTokenAccountFor(mock, configOverrides.treasury ?? TREASURY, mint, 0n);

  const config = { ...BASE_CONFIG, mint, ...configOverrides };
  const built = await buildChargePaymentTransaction(
    mock.rpc,
    sponsor,
    owner.address,
    PRICE,
    config,
  );
  return { sponsor, owner, mock, built, config };
}

describe('sponsored payment transaction', () => {
  it('transfers exactly the price', async () => {
    const { built } = await setup();
    expect(built.amount).toBe(PRICE);
    expect(built.amountUi).toBe('20.00');
  });

  it('makes the sponsor the fee payer, not the user', async () => {
    const { built, sponsor, owner } = await setup();
    expect(built.feePayer).toBe(sponsor.address);
    expect(built.feePayerRole).toBe('sponsor');
    expect(built.feePayer).not.toBe(owner.address);
  });

  it('settles to the configured treasury account', async () => {
    const { built } = await setup();
    expect(built.charge?.treasury).toBe(TREASURY);
    expect(built.charge?.destination).toBe(await deriveAta(TREASURY, TEST_MINT));
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

  it('rejects a redirected destination', async () => {
    const { built, owner, mock, sponsor } = await setup();
    await mockTokenAccountFor(mock, OTHER_TREASURY, TEST_MINT, 0n);
    const evil = await buildChargePaymentTransaction(mock.rpc, sponsor, owner.address, PRICE, {
      ...BASE_CONFIG,
      treasury: OTHER_TREASURY,
    });
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toThrow(DisdkError);
    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects an inflated amount', async () => {
    const { built, owner, mock, sponsor } = await setup();
    const evil = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE * 10n,
      BASE_CONFIG,
    );
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a different fee payer', async () => {
    const { built, owner, mock } = await setup();
    const otherSponsor = await newSigner();
    const evil = await buildChargePaymentTransaction(
      mock.rpc,
      otherSponsor,
      owner.address,
      PRICE,
      BASE_CONFIG,
    );
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a transaction issued for a different owner', async () => {
    const { built, sponsor } = await setup();
    const otherOwner = await newSigner();
    const otherMock = createMockRpc();
    await mockTokenAccountFor(otherMock, otherOwner.address, TEST_MINT, BALANCE);
    await mockTokenAccountFor(otherMock, TREASURY, TEST_MINT, 0n);

    const evil = await buildChargePaymentTransaction(
      otherMock.rpc,
      sponsor,
      otherOwner.address,
      PRICE,
      BASE_CONFIG,
    );
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
    const otherMock = createMockRpc();
    await mockTokenAccountFor(otherMock, owner.address, otherMint, BALANCE);
    await mockTokenAccountFor(otherMock, TREASURY, otherMint, 0n);

    const evil = await buildChargePaymentTransaction(
      otherMock.rpc,
      sponsor,
      owner.address,
      PRICE,
      { ...BASE_CONFIG, mint: otherMint },
    );
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });
});
