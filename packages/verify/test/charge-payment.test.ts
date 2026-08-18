import { describe, expect, it } from 'vitest';
import {
  address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { buildChargePaymentTransaction } from '../src/build.js';
import { verifySignedTransaction } from '../src/verifyTx.js';
import { deriveAta } from '../src/token.js';
import { createMockRpc, mockTokenAccountFor } from '../src/testing.js';
import { TEST_MINT, newSigner, walletSign } from './helpers.js';
import type { ChargeSessionConfig } from '../src/build.js';

const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

/** 1,000 USDC held, 20 USDC charged. */
const BALANCE = 1_000_000_000n;
const PRICE = 20_000_000n;

/** SPL token instruction discriminators. */
const IX_TRANSFER = 3;
const IX_APPROVE = 4;
const IX_TRANSFER_CHECKED = 12;
const IX_APPROVE_CHECKED = 13;

const BASE_CONFIG: ChargeSessionConfig = {
  mint: TEST_MINT,
  decimals: 6,
  symbol: 'USDC',
  treasury: TREASURY,
};

async function setup(
  overrides: Partial<ChargeSessionConfig> = {},
  options: { balance?: bigint; treasuryHasAta?: boolean } = {},
) {
  const sponsor = await newSigner();
  const owner = await newSigner();
  const mock = createMockRpc();

  await mockTokenAccountFor(mock, owner.address, TEST_MINT, options.balance ?? BALANCE);
  if (options.treasuryHasAta !== false) {
    await mockTokenAccountFor(mock, TREASURY, TEST_MINT, 0n);
  }

  return {
    sponsor,
    owner,
    mock,
    config: { ...BASE_CONFIG, ...overrides },
    treasuryAta: await deriveAta(TREASURY, TEST_MINT),
  };
}

interface CompiledInstruction {
  programAddressIndex: number;
  data?: ReadonlyUint8Array;
}

/** Token-program instruction tags present in a built transaction, in order. */
function tokenTags(transactionBase64: string): number[] {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  // The decoded message is a union across transaction versions; only some
  // members carry instructions inline, so narrow rather than assert.
  if (!('instructions' in message)) return [];
  const keys = message.staticAccounts as readonly Address[];

  return (message.instructions as readonly CompiledInstruction[])
    .filter((instruction) => keys[instruction.programAddressIndex] === TOKEN_PROGRAM_ADDRESS)
    .map((instruction) => instruction.data?.[0] ?? -1);
}

describe('buildChargePaymentTransaction', () => {
  it('builds a single checked transfer of exactly the price', async () => {
    const { sponsor, owner, mock, config, treasuryAta } = await setup();

    const built = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
    );

    expect(built.amount).toBe(PRICE);
    expect(built.amountUi).toBe('20.00');
    expect(built.charge?.destination).toBe(treasuryAta);
    expect(built.charge?.treasury).toBe(TREASURY);
    expect(built.feePayer).toBe(sponsor.address);
    expect(tokenTags(built.transactionBase64)).toEqual([IX_TRANSFER_CHECKED]);
  });

  // The structural half of the promise the modal makes. The guard in the SDK
  // refuses an approval it finds; this asserts the server never emits one, so
  // the two would have to fail together for a charge to leave anything behind.
  it('emits no approval instruction of either variant', async () => {
    const { sponsor, owner, mock, config } = await setup();

    const built = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
    );

    const tags = tokenTags(built.transactionBase64);
    expect(tags).not.toContain(IX_APPROVE);
    expect(tags).not.toContain(IX_APPROVE_CHECKED);
    // …and the unchecked transfer variant is never used either, since it cannot
    // name the mint.
    expect(tags).not.toContain(IX_TRANSFER);
  });

  it('leaves the owner signature slot empty for the wallet to fill', async () => {
    const { sponsor, owner, mock, config } = await setup();

    const built = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
    );
    const transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(built.transactionBase64),
    );

    expect(transaction.signatures[sponsor.address]).not.toBeNull();
    expect(transaction.signatures[owner.address]).toBeNull();
  });

  it('accepts the wallet-signed transaction it issued', async () => {
    const { sponsor, owner, mock, config } = await setup();

    const built = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
    );
    const signed = await walletSign(built.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).resolves.toBeDefined();
  });

  // Re-pricing after the fact. The sponsor signature covers the compiled
  // message, so a second build at a different price is a different transaction
  // and cannot be submitted against the first.
  it('rejects a transaction rebuilt at a different price', async () => {
    const { sponsor, owner, mock, config } = await setup();

    const quoted = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
    );
    const inflated = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE * 5n,
      config,
    );
    const signed = await walletSign(inflated.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, quoted)).rejects.toThrow(/does not match/i);
  });

  it('binds the payment to a session with a memo', async () => {
    const { sponsor, owner, mock, config } = await setup();

    const withNonce = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
      'session-nonce-a',
    );
    const otherNonce = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
      'session-nonce-b',
    );

    // Same wallet, same price, same blockhash — and still not interchangeable.
    expect(withNonce.transactionBase64).not.toBe(otherNonce.transactionBase64);
  });

  it('carries the merchant reference alongside the nonce', async () => {
    const { sponsor, owner, mock, config } = await setup();

    const built = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
      'session-nonce',
      'order-1234',
    );

    expect(built.charge?.reference).toBe('order-1234');
  });

  it('refuses a zero charge', async () => {
    const { sponsor, owner, mock, config } = await setup();

    await expect(
      buildChargePaymentTransaction(mock.rpc, sponsor, owner.address, 0n, config),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('refuses a negative charge', async () => {
    const { sponsor, owner, mock, config } = await setup();

    await expect(
      buildChargePaymentTransaction(mock.rpc, sponsor, owner.address, -1n, config),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('refuses a charge larger than the balance', async () => {
    const { sponsor, owner, mock, config } = await setup({}, { balance: PRICE - 1n });

    await expect(
      buildChargePaymentTransaction(mock.rpc, sponsor, owner.address, PRICE, config),
    ).rejects.toThrow(/less than the/i);
  });

  it('refuses a wallet with no token account', async () => {
    const { sponsor, mock, config } = await setup();
    const stranger = await newSigner();

    await expect(
      buildChargePaymentTransaction(mock.rpc, sponsor, stranger.address, PRICE, config),
    ).rejects.toThrow(/no USDC token account/i);
  });

  // A missing treasury account is far more likely to be a typo in
  // TREASURY_ADDRESS than a genuinely new wallet, and paying rent to create an
  // account at a mistyped address would put the money somewhere nobody holds
  // the key to.
  it('refuses to invent a treasury account by default', async () => {
    const { sponsor, owner, mock, config } = await setup({}, { treasuryHasAta: false });

    await expect(
      buildChargePaymentTransaction(mock.rpc, sponsor, owner.address, PRICE, config),
    ).rejects.toThrow(/has no USDC token account/i);
  });

  it('creates the treasury account when explicitly told to', async () => {
    const { sponsor, owner, mock, config } = await setup(
      { createTreasuryAtaIfMissing: true },
      { treasuryHasAta: false },
    );

    const built = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
    );

    expect(built.amount).toBe(PRICE);
    expect(tokenTags(built.transactionBase64)).toEqual([IX_TRANSFER_CHECKED]);
  });

  it('charges the exact balance when the price equals it', async () => {
    const { sponsor, owner, mock, config } = await setup({}, { balance: PRICE });

    const built = await buildChargePaymentTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      PRICE,
      config,
    );

    expect(built.amount).toBe(PRICE);
    expect(built.balanceAtBuild).toBe(PRICE);
  });
});
