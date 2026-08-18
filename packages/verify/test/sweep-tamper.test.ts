import { describe, expect, it } from 'vitest';
import { DisdkError } from '@disdk/protocol';
import {
  address,
  getBase64EncodedWireTransaction,
  signBytes,
  type Address,
} from '@solana/kit';
import { buildSweepCloseTransaction, buildSweepTransferTransaction } from '../src/build.js';
import { verifySignedTransaction } from '../src/verifyTx.js';
import { deriveAta, listEmptyTokenAccounts } from '../src/token.js';
import { createMockRpc, mockTokenAccountFor } from '../src/testing.js';
import { TEST_MINT, decodeTransaction, newSigner, walletSign } from './helpers.js';
import type { SweepConfig } from '../src/build.js';
import type { SolanaRpc } from '../src/rpc.js';

const COLD_WALLET = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const ATTACKER = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const OTHER_MINT = address('So11111111111111111111111111111111111111112');
const THIRD_MINT = address('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');

const BASE_CONFIG: SweepConfig = {
  mint: TEST_MINT,
  decimals: 6,
  symbol: 'USDC',
  destination: COLD_WALLET,
  strategy: { kind: 'percentOfBalance', percent: 0.8 },
  rentDestination: 'cold',
  closeMaxAccounts: 15,
};

/** 1,000 USDC. */
const BALANCE = 1_000_000_000n;

async function setup(
  overrides: Partial<SweepConfig> = {},
  balance = BALANCE,
): Promise<{
  sponsor: Awaited<ReturnType<typeof newSigner>>;
  owner: Awaited<ReturnType<typeof newSigner>>;
  rpc: SolanaRpc;
  built: Awaited<ReturnType<typeof buildSweepTransferTransaction>>;
  config: SweepConfig;
}> {
  const sponsor = await newSigner();
  const owner = await newSigner();
  const mock = createMockRpc();
  const config = { ...BASE_CONFIG, ...overrides };
  await mockTokenAccountFor(mock, owner.address, config.mint, balance);
  const built = await buildSweepTransferTransaction(mock.rpc, sponsor, owner.address, config);
  return { sponsor, owner, rpc: mock.rpc, built, config };
}

describe('sponsored sweep transfer', () => {
  it('moves 80% of the balance by default', async () => {
    const { built } = await setup();
    expect(built.amount).toBe(800_000_000n);
    expect(built.amountUi).toBe('800.00');
    expect(built.balanceAtBuild).toBe(BALANCE);
  });

  it('sends funds to the configured cold wallet, not the owner', async () => {
    const { built, owner } = await setup();
    const expected = await deriveAta(COLD_WALLET, TEST_MINT);
    expect(built.sweep?.destination).toBe(expected);
    expect(built.sweep?.destinationOwner).toBe(COLD_WALLET);
    expect(built.sweep?.destination).not.toBe(await deriveAta(owner.address, TEST_MINT));
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

  it('carries no close instructions in the transfer leg', async () => {
    const { built } = await setup();
    expect(built.sweep?.leg).toBe('transfer');
    expect(built.sweep?.closes).toEqual([]);
  });

  it('refuses an unlimited strategy outright', async () => {
    await expect(setup({ strategy: { kind: 'unlimited' } })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('refuses a fixed amount larger than the balance', async () => {
    await expect(
      setup({ strategy: { kind: 'fixed', amount: '2000000000' } }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('refuses a wallet with no token account', async () => {
    const sponsor = await newSigner();
    const owner = await newSigner();
    const mock = createMockRpc();
    await expect(
      buildSweepTransferTransaction(mock.rpc, sponsor, owner.address, BASE_CONFIG),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });
});

describe('sweep tamper matrix', () => {
  // Each case produces a transaction that is internally valid but is not the
  // one this session issued. All must be rejected before broadcast.

  it('rejects a swapped destination', async () => {
    const { built, owner, rpc, sponsor } = await setup();
    const evil = await buildSweepTransferTransaction(rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      destination: ATTACKER,
    });
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toThrow(DisdkError);
    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects an inflated amount', async () => {
    const { built, owner, rpc, sponsor } = await setup();
    const evil = await buildSweepTransferTransaction(rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      strategy: { kind: 'percentOfBalance', percent: 1 },
    });
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a different fee payer', async () => {
    const { built, owner, rpc } = await setup();
    const otherSponsor = await newSigner();
    const evil = await buildSweepTransferTransaction(
      rpc,
      otherSponsor,
      owner.address,
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
    const mock = createMockRpc();
    await mockTokenAccountFor(mock, otherOwner.address, TEST_MINT, BALANCE);
    const evil = await buildSweepTransferTransaction(
      mock.rpc,
      sponsor,
      otherOwner.address,
      BASE_CONFIG,
    );
    const signed = await walletSign(evil.transactionBase64, otherOwner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a transaction with no wallet signature', async () => {
    const { built } = await setup();
    await expect(verifySignedTransaction(built.transactionBase64, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a wallet signature produced by the wrong key', async () => {
    const { built, owner } = await setup();
    const impostor = await newSigner();

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
    const mock = createMockRpc();
    await mockTokenAccountFor(mock, owner.address, OTHER_MINT, BALANCE);
    const evil = await buildSweepTransferTransaction(mock.rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      mint: OTHER_MINT,
    });
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('rejects a close leg replayed as the transfer leg', async () => {
    const { built, owner, sponsor } = await setup();
    const mock = createMockRpc();
    await mockTokenAccountFor(mock, owner.address, TEST_MINT, 0n);
    const closeLeg = await buildSweepCloseTransaction(
      mock.rpc,
      sponsor,
      owner.address,
      BASE_CONFIG,
    );
    const signed = await walletSign(closeLeg.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });
});

describe('sweep close leg', () => {
  /** A wallet holding `usdc` USDC plus a set of fully-empty accounts. */
  async function closeSetup(usdc: bigint, emptyMints: Address[] = [OTHER_MINT, THIRD_MINT]) {
    const sponsor = await newSigner();
    const owner = await newSigner();
    const mock = createMockRpc();
    await mockTokenAccountFor(mock, owner.address, TEST_MINT, usdc);
    for (const mint of emptyMints) {
      await mockTokenAccountFor(mock, owner.address, mint, 0n);
    }
    return { sponsor, owner, mock, rpc: mock.rpc };
  }

  it('closes the empty accounts and sends rent to the cold wallet', async () => {
    const { sponsor, owner, rpc } = await closeSetup(200_000_000n);
    const built = await buildSweepCloseTransaction(rpc, sponsor, owner.address, BASE_CONFIG);

    expect(built.sweep?.leg).toBe('close');
    expect(built.sweep?.rentTo).toBe(COLD_WALLET);
    expect(built.sweep?.closes).toHaveLength(2);
    expect(built.sweep?.closes.map((c) => c.mint).sort()).toEqual(
      [OTHER_MINT, THIRD_MINT].sort(),
    );
  });

  // The invariant that matters most. Under the default 80% strategy the source
  // account still holds the remaining 20% after the transfer leg, so including
  // it here would try to close a funded account — and, if the balance read were
  // ever stale, would risk destroying the remainder.
  it('never closes the source account while it still holds a balance', async () => {
    const { sponsor, owner, rpc } = await closeSetup(200_000_000n);
    const sourceAta = await deriveAta(owner.address, TEST_MINT);
    const built = await buildSweepCloseTransaction(rpc, sponsor, owner.address, BASE_CONFIG);

    expect(built.sweep?.closes.map((c) => c.account)).not.toContain(sourceAta);
  });

  it('closes the source account once it is fully drained', async () => {
    const { sponsor, owner, rpc } = await closeSetup(0n);
    const sourceAta = await deriveAta(owner.address, TEST_MINT);
    const built = await buildSweepCloseTransaction(rpc, sponsor, owner.address, BASE_CONFIG);

    expect(built.sweep?.closes.map((c) => c.account)).toContain(sourceAta);
  });

  it('sends rent back to the owner when configured for source', async () => {
    const { sponsor, owner, rpc } = await closeSetup(200_000_000n);
    const built = await buildSweepCloseTransaction(rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      rentDestination: 'source',
    });

    expect(built.sweep?.rentTo).toBe(owner.address);
    expect(built.sweep?.rentTo).not.toBe(COLD_WALLET);
  });

  it('respects the configured close ceiling', async () => {
    const { sponsor, owner, rpc } = await closeSetup(200_000_000n);
    const built = await buildSweepCloseTransaction(rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      closeMaxAccounts: 1,
    });

    expect(built.sweep?.closes).toHaveLength(1);
  });

  it('refuses when there is nothing to close', async () => {
    const { sponsor, owner, rpc } = await closeSetup(200_000_000n, []);
    await expect(
      buildSweepCloseTransaction(rpc, sponsor, owner.address, BASE_CONFIG),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('accepts the honest round trip', async () => {
    const { sponsor, owner, rpc } = await closeSetup(200_000_000n);
    const built = await buildSweepCloseTransaction(rpc, sponsor, owner.address, BASE_CONFIG);
    const signed = await walletSign(built.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).resolves.toBeDefined();
  });

  it('rejects a close leg rebuilt with a different rent destination', async () => {
    const { sponsor, owner, rpc } = await closeSetup(200_000_000n);
    const built = await buildSweepCloseTransaction(rpc, sponsor, owner.address, BASE_CONFIG);
    const evil = await buildSweepCloseTransaction(rpc, sponsor, owner.address, {
      ...BASE_CONFIG,
      destination: ATTACKER,
    });
    const signed = await walletSign(evil.transactionBase64, owner);

    await expect(verifySignedTransaction(signed, built)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });
});

describe('listEmptyTokenAccounts', () => {
  it('reports only zero-balance accounts owned by the wallet', async () => {
    const owner = await newSigner();
    const stranger = await newSigner();
    const mock = createMockRpc();
    await mockTokenAccountFor(mock, owner.address, TEST_MINT, 5n);
    await mockTokenAccountFor(mock, owner.address, OTHER_MINT, 0n);
    await mockTokenAccountFor(mock, stranger.address, THIRD_MINT, 0n);

    const found = await listEmptyTokenAccounts(mock.rpc, owner.address);

    expect(found).toHaveLength(1);
    expect(found[0]?.mint).toBe(OTHER_MINT);
  });

  it('honours the exclude list', async () => {
    const owner = await newSigner();
    const mock = createMockRpc();
    const ata = await mockTokenAccountFor(mock, owner.address, OTHER_MINT, 0n);

    const found = await listEmptyTokenAccounts(mock.rpc, owner.address, { exclude: [ata] });

    expect(found).toEqual([]);
  });
});
