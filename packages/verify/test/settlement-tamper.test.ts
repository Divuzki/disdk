/**
 * The tamper matrix for batch settlement.
 *
 * Every case here builds an honest settlement and an "evil" one differing in
 * exactly one respect, signs the evil one as a wallet would, and submits it
 * against the honest expectation. The point is not that the server notices some
 * particular field — it is that the server compares compiled messages, so
 * noticing is not a property of the check but of the design. A field nobody
 * thought to assert on is still covered.
 */

import { describe, expect, it } from 'vitest';
import { address, getBase64EncodedWireTransaction, type Address, type KeyPairSigner } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  buildBatchSettlementTransaction,
  createSettlementManifest,
} from '../src/settlement.js';
import { AltRegistry } from '../src/alt.js';
import { verifyOnChainTransaction, verifySignedTransaction } from '../src/verifyTx.js';
import { createMockRpc, signatureOf, type MockRpc } from '../src/testing.js';
import { TOKEN_2022_PROGRAM_ADDRESS, deriveAta } from '../src/token.js';
import { decodeTransaction, newSigner, walletSign } from './helpers.js';
import type { SettlementObligation } from '@disdk/protocol';

const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const DESTINATION = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const OTHER_DESTINATION = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');

const OBLIGATIONS: SettlementObligation[] = [
  { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
  { type: 'sol', amount: '2000000' },
];

interface World {
  mock: MockRpc;
  sponsor: KeyPairSigner;
  owner: KeyPairSigner;
}

async function world(): Promise<World> {
  const mock = createMockRpc();
  const sponsor = await newSigner();
  const owner = await newSigner();

  mock.setMint(USDC, { decimals: 6 });
  mock.setMint(BONK, { decimals: 5 });

  for (const [holder, mint, amount] of [
    [owner.address, USDC, 100_000_000n],
    [owner.address, BONK, 5_000_000_000n],
    [DESTINATION, USDC, 0n],
    [DESTINATION, BONK, 0n],
    [OTHER_DESTINATION, USDC, 0n],
  ] as const) {
    mock.setTokenAccount(await deriveAta(holder, mint), {
      mint,
      owner: holder,
      amount,
    });
  }

  mock.setLamports(owner.address, 1_000_000_000n);
  return { mock, sponsor, owner };
}

async function settle(
  w: World,
  overrides: {
    obligations?: SettlementObligation[];
    destination?: Address;
    owner?: Address;
    sponsor?: KeyPairSigner;
    sessionId?: string;
    nonce?: string;
    feePayerRole?: 'sponsor' | 'owner';
    altRegistry?: AltRegistry;
  } = {},
) {
  const owner = overrides.owner ?? w.owner.address;
  const destination = overrides.destination ?? DESTINATION;

  const manifest = createSettlementManifest({
    sessionId: overrides.sessionId ?? 'session-1',
    owner,
    destination,
    obligations: overrides.obligations ?? OBLIGATIONS,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  return buildBatchSettlementTransaction(
    w.mock.rpc,
    overrides.sponsor ?? w.sponsor,
    owner,
    manifest,
    { destination, altRegistry: overrides.altRegistry },
    overrides.nonce ?? 'nonce-1',
    overrides.feePayerRole ? { feePayerRole: overrides.feePayerRole } : {},
  );
}

/** Sign `evil` as the wallet would, then submit it against `honest`. */
async function submitCrossed(
  honest: Awaited<ReturnType<typeof settle>>,
  evil: Awaited<ReturnType<typeof settle>>,
  owner: KeyPairSigner,
) {
  const signed = await walletSign(evil.transactionBase64, owner);
  return verifySignedTransaction(signed, honest);
}

describe('an honest settlement', () => {
  it('round trips', async () => {
    const w = await world();
    const built = await settle(w);
    const signed = await walletSign(built.transactionBase64, w.owner);

    const verified = await verifySignedTransaction(signed, built);
    expect(verified.transaction).toBeDefined();
  });

  it('is accepted when read back off the chain', async () => {
    const w = await world();
    const built = await settle(w);
    const signed = await walletSign(built.transactionBase64, w.owner);

    await w.mock.rpc.sendTransaction(signed as never, { encoding: 'base64' }).send();
    await expect(
      verifyOnChainTransaction(w.mock.rpc, signatureOf(signed), built),
    ).resolves.toBeUndefined();
  });
});

describe('refusing a tampered settlement', () => {
  it('refuses a redirected destination', async () => {
    const w = await world();
    const honest = await settle(w);
    const evil = await settle(w, { destination: OTHER_DESTINATION });

    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses an inflated SPL amount', async () => {
    const w = await world();
    const honest = await settle(w);
    const evil = await settle(w, {
      obligations: [
        { type: 'spl', mint: USDC, amount: '95000000', decimals: 6 },
        { type: 'sol', amount: '2000000' },
      ],
    });

    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses an inflated SOL amount', async () => {
    const w = await world();
    const honest = await settle(w);
    const evil = await settle(w, {
      obligations: [
        { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
        { type: 'sol', amount: '900000000' },
      ],
    });

    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses a substituted mint', async () => {
    const w = await world();
    const honest = await settle(w);
    const evil = await settle(w, {
      obligations: [{ type: 'spl', mint: BONK, amount: '25000000', decimals: 5 }],
    });

    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses a substituted token program', async () => {
    const w = await world();
    const honest = await settle(w, {
      obligations: [{ type: 'spl', mint: USDC, amount: '25000000', decimals: 6 }],
    });

    // The same mint, now claimed by Token-2022: different program, different
    // token accounts, different bytes.
    const other = await world();
    other.mock.setMint(USDC, { decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    for (const holder of [other.owner.address, DESTINATION]) {
      other.mock.setTokenAccount(
        await deriveAta(holder, USDC, TOKEN_2022_PROGRAM_ADDRESS),
        {
          mint: USDC,
          owner: holder,
          amount: holder === DESTINATION ? 0n : 100_000_000n,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        },
      );
    }
    const evil = await settle(other, {
      obligations: [{ type: 'spl', mint: USDC, amount: '25000000', decimals: 6 }],
      owner: other.owner.address,
    });

    await expect(submitCrossed(honest, evil, other.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses a settlement issued for a different wallet', async () => {
    const w = await world();
    const stranger = await world();
    const honest = await settle(w);
    const evil = await settle(stranger, { owner: stranger.owner.address });

    await expect(submitCrossed(honest, evil, stranger.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses a different fee payer', async () => {
    const w = await world();
    const honest = await settle(w);
    const evil = await settle(w, { sponsor: await newSigner() });

    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses the fee moving onto the owner', async () => {
    const w = await world();
    const honest = await settle(w);
    const evil = await settle(w, { feePayerRole: 'owner' });

    expect(evil.feePayer).toBe(w.owner.address);
    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses an extra transfer smuggled alongside the agreed ones', async () => {
    const w = await world();
    const honest = await settle(w);
    const evil = await settle(w, {
      obligations: [
        ...OBLIGATIONS,
        { type: 'spl', mint: BONK, amount: '1250000000', decimals: 5 },
      ],
    });

    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses a dropped obligation', async () => {
    const w = await world();
    const honest = await settle(w);
    const evil = await settle(w, {
      obligations: [{ type: 'spl', mint: USDC, amount: '25000000', decimals: 6 }],
    });

    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses a settlement replayed from another session', async () => {
    const w = await world();
    const honest = await settle(w, { sessionId: 'session-1', nonce: 'nonce-1' });
    const other = await settle(w, { sessionId: 'session-2', nonce: 'nonce-2' });

    // Identical obligations, identical wallet, identical destination — and still
    // distinct bytes, because the session marker is part of the message.
    expect(other.manifest.manifestHash).not.toBe(honest.manifest.manifestHash);
    await expect(submitCrossed(honest, other, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses a settlement whose lookup table was swapped', async () => {
    const w = await world();
    const accounts = [
      TOKEN_PROGRAM_ADDRESS,
      USDC,
      BONK,
      await deriveAta(w.owner.address, USDC),
      await deriveAta(w.owner.address, BONK),
      await deriveAta(DESTINATION, USDC),
      await deriveAta(DESTINATION, BONK),
    ];

    const tableA = (await newSigner()).address;
    const tableB = (await newSigner()).address;

    // Enough obligations that compression is actually used, so the table
    // reference is genuinely part of the compiled message.
    const many: SettlementObligation[] = [];
    for (let i = 0; i < 14; i++) {
      const mint = (await newSigner()).address;
      w.mock.setMint(mint, { decimals: 6 });
      w.mock.setTokenAccount(await deriveAta(w.owner.address, mint), {
        mint,
        owner: w.owner.address,
        amount: 1_000_000n,
      });
      w.mock.setTokenAccount(await deriveAta(DESTINATION, mint), {
        mint,
        owner: DESTINATION,
        amount: 0n,
      });
      many.push({ type: 'spl', mint, amount: '1000', decimals: 6 });
      accounts.push(mint, await deriveAta(w.owner.address, mint), await deriveAta(DESTINATION, mint));
    }
    w.mock.setLookupTable(tableA, accounts);
    w.mock.setLookupTable(tableB, accounts);

    const honest = await settle(w, {
      obligations: many,
      altRegistry: new AltRegistry([tableA]),
    });
    const evil = await settle(w, {
      obligations: many,
      altRegistry: new AltRegistry([tableB]),
    });

    expect(honest.addressLookupTables).toEqual([tableA]);
    expect(evil.addressLookupTables).toEqual([tableB]);

    await expect(submitCrossed(honest, evil, w.owner)).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
  });

  it('refuses a transaction with no wallet signature', async () => {
    const w = await world();
    const built = await settle(w);

    await expect(
      verifySignedTransaction(built.transactionBase64, built),
    ).rejects.toMatchObject({ code: 'TRANSACTION_MISMATCH' });
  });

  it('refuses a signature from the wrong wallet', async () => {
    const w = await world();
    const built = await settle(w);
    const impostor = await newSigner();

    // A real signature over the right bytes, made by the wrong key.
    const transaction = decodeTransaction(built.transactionBase64);
    const forged = {
      ...transaction,
      signatures: {
        ...transaction.signatures,
        [built.owner]: (
          await (await import('@solana/kit')).signBytes(
            impostor.keyPair.privateKey,
            transaction.messageBytes,
          )
        ),
      },
    };

    await expect(
      verifySignedTransaction(getBase64EncodedWireTransaction(forged as never), built),
    ).rejects.toMatchObject({ code: 'TRANSACTION_MISMATCH' });
  });
});
