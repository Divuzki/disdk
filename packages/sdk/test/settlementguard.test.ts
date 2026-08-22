/**
 * What the browser refuses to sign.
 *
 * The server already binds the message it built, and re-checks the bytes on
 * submit. This guard exists for the case that check cannot cover: a server that
 * is itself wrong or compromised. So every test here builds a transaction the
 * *server* would happily accept and asks whether the client would still put it
 * in front of a user.
 */

import { describe, expect, it } from 'vitest';
import {
  appendTransactionMessageInstructions,
  address,
  blockhash,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  AccountRole,
  type Address,
  type AddressesByLookupTableAddress,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  getCloseAccountInstruction,
  getApproveCheckedInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from '@solana-program/token';
import type { SettlementObligation } from '@disdk/protocol';
import { verifySettlementTransaction, type SettlementExpectation } from '../src/txguard.js';

const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const DESTINATION = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const DESTINATION_USDC = address('2rMHUAgtqQXGWs2XLPzuqEXMigYmjFo2dbTdVpuHrTrs');
const DESTINATION_BONK = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ATTACKER_ATA = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const SOURCE_USDC = address('So11111111111111111111111111111111111111112');
const SOURCE_BONK = address('SysvarRent111111111111111111111111111111111');
const BLOCKHASH = blockhash('11111111111111111111111111111111');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

const OBLIGATIONS: SettlementObligation[] = [
  { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
  { type: 'spl', mint: BONK, amount: '1250000000', decimals: 5 },
  { type: 'sol', amount: '2000000' },
];

async function buildTx(
  instructions: Instruction[],
  feePayer: KeyPairSigner,
  lookupTables?: AddressesByLookupTableAddress,
): Promise<string> {
  const base = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const message = lookupTables
    ? compressTransactionMessageUsingAddressLookupTables(base, lookupTables)
    : base;
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

function splIx(
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
    source: overrides.source ?? SOURCE_USDC,
    mint: overrides.mint ?? USDC,
    destination: overrides.destination ?? DESTINATION_USDC,
    authority: createNoopSigner(owner),
    amount: overrides.amount ?? 25_000_000n,
    decimals: overrides.decimals ?? 6,
  });
}

function bonkIx(owner: Address, overrides: Partial<{ amount: bigint }> = {}) {
  return getTransferCheckedInstruction({
    source: SOURCE_BONK,
    mint: BONK,
    destination: DESTINATION_BONK,
    authority: createNoopSigner(owner),
    amount: overrides.amount ?? 1_250_000_000n,
    decimals: 5,
  });
}

/** A System Program transfer, laid out as the runtime expects it. */
function solIx(
  owner: Address,
  overrides: Partial<{ destination: Address; lamports: bigint }> = {},
): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, overrides.lamports ?? 2_000_000n, true);

  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER, signer: createNoopSigner(owner) },
      { address: overrides.destination ?? DESTINATION, role: AccountRole.WRITABLE },
    ],
    data,
  } as Instruction;
}

async function setup() {
  const sponsor = await generateKeyPairSigner();
  const owner = await generateKeyPairSigner();

  const expectation: SettlementExpectation = {
    feePayer: sponsor.address,
    owner: owner.address,
    destination: DESTINATION,
    obligations: OBLIGATIONS,
    destinationAccounts: {
      [USDC]: DESTINATION_USDC,
      [BONK]: DESTINATION_BONK,
    },
  };

  const honest = [splIx(owner.address), bonkIx(owner.address), solIx(owner.address)];
  return { sponsor, owner, expectation, honest };
}

describe('accepting an honest settlement', () => {
  it('reads every obligation back out of the bytes', async () => {
    const { sponsor, expectation, honest } = await setup();
    const verified = verifySettlementTransaction(await buildTx(honest, sponsor), expectation);

    expect(verified.transfers.map((t) => t.amount)).toEqual([
      25_000_000n,
      1_250_000_000n,
      2_000_000n,
    ]);
    expect(verified.lookupTables).toEqual([]);
  });

  it('accepts a destination token account being created alongside', async () => {
    const { sponsor, owner, expectation, honest } = await setup();
    const createAta: Instruction = {
      programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      accounts: [
        { address: owner.address, role: AccountRole.WRITABLE_SIGNER, signer: createNoopSigner(owner.address) },
        { address: DESTINATION_USDC, role: AccountRole.WRITABLE },
      ],
      data: new Uint8Array([1]),
    } as Instruction;

    const verified = verifySettlementTransaction(
      await buildTx([createAta, ...honest], sponsor),
      expectation,
    );
    expect(verified.createsAccount).toBe(true);
  });
});

describe('refusing a settlement that is not what was shown', () => {
  it('refuses a redirected SPL destination', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        splIx(owner.address, { destination: ATTACKER_ATA }),
        bonkIx(owner.address),
        solIx(owner.address),
      ],
      sponsor,
    );

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/destination/i);
  });

  it('refuses a redirected SOL destination', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        splIx(owner.address),
        bonkIx(owner.address),
        solIx(owner.address, { destination: ATTACKER_ATA }),
      ],
      sponsor,
    );

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/destination/i);
  });

  it('refuses an inflated SPL amount', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        splIx(owner.address, { amount: 95_000_000n }),
        bonkIx(owner.address),
        solIx(owner.address),
      ],
      sponsor,
    );

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/amount/i);
  });

  it('refuses an inflated SOL amount', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        splIx(owner.address),
        bonkIx(owner.address),
        solIx(owner.address, { lamports: 900_000_000n }),
      ],
      sponsor,
    );

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/SOL amount/i);
  });

  it('refuses a substituted mint', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [
        splIx(owner.address, { mint: BONK, destination: DESTINATION_BONK }),
        bonkIx(owner.address),
        solIx(owner.address),
      ],
      sponsor,
    );

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/different token/i);
  });

  it('refuses altered decimals', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx(
      [splIx(owner.address, { decimals: 9 }), bonkIx(owner.address), solIx(owner.address)],
      sponsor,
    );

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/decimals/i);
  });

  it('refuses a transfer from a different wallet', async () => {
    const { sponsor, expectation } = await setup();
    const stranger = await generateKeyPairSigner();
    const tx = await buildTx(
      [splIx(stranger.address), bonkIx(stranger.address), solIx(stranger.address)],
      sponsor,
    );

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/different wallet/i);
  });

  it('refuses an unexpected fee payer', async () => {
    const { expectation, honest } = await setup();
    const stranger = await generateKeyPairSigner();
    const tx = await buildTx(honest, stranger);

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/paid for/i);
  });

  it('refuses an extra transfer smuggled in', async () => {
    const { sponsor, owner, expectation, honest } = await setup();
    const extra = getTransferCheckedInstruction({
      source: SOURCE_USDC,
      mint: USDC,
      destination: ATTACKER_ATA,
      authority: createNoopSigner(owner.address),
      amount: 1_000_000n,
      decimals: 6,
    });

    const tx = await buildTx([...honest, extra], sponsor);
    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/more tokens/i);
  });

  it('refuses an extra SOL transfer smuggled in', async () => {
    const { sponsor, owner, expectation, honest } = await setup();
    const tx = await buildTx(
      [...honest, solIx(owner.address, { destination: ATTACKER_ATA, lamports: 1n })],
      sponsor,
    );

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/more SOL/i);
  });

  it('refuses a dropped obligation', async () => {
    const { sponsor, owner, expectation } = await setup();
    const tx = await buildTx([splIx(owner.address), solIx(owner.address)], sponsor);

    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/every transfer/i);
  });

  it('refuses an unchecked transfer, which cannot name its token', async () => {
    const { sponsor, owner, expectation } = await setup();
    const unchecked = getTransferInstruction({
      source: SOURCE_USDC,
      destination: DESTINATION_USDC,
      authority: createNoopSigner(owner.address),
      amount: 25_000_000n,
    });

    const tx = await buildTx([unchecked, bonkIx(owner.address), solIx(owner.address)], sponsor);
    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/unchecked/i);
  });

  it('refuses a settlement that also grants an allowance', async () => {
    const { sponsor, owner, expectation, honest } = await setup();
    const approve = getApproveCheckedInstruction({
      source: SOURCE_USDC,
      mint: USDC,
      delegate: ATTACKER_ATA,
      owner: createNoopSigner(owner.address),
      amount: 1_000_000_000n,
      decimals: 6,
    });

    const tx = await buildTx([...honest, approve], sponsor);
    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/allowance/i);
  });

  it('refuses a settlement that closes a token account', async () => {
    const { sponsor, owner, expectation, honest } = await setup();
    const close = getCloseAccountInstruction({
      account: SOURCE_USDC,
      destination: ATTACKER_ATA,
      owner: createNoopSigner(owner.address),
    });

    const tx = await buildTx([...honest, close], sponsor);
    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/close/i);
  });

  it('refuses a system instruction that is not a transfer', async () => {
    const { sponsor, owner, expectation, honest } = await setup();
    // System `Assign` (1) would hand the wallet's account to another program.
    const assign = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        {
          address: owner.address,
          role: AccountRole.WRITABLE_SIGNER,
          signer: createNoopSigner(owner.address),
        },
      ],
      data: (() => {
        const data = new Uint8Array(36);
        new DataView(data.buffer).setUint32(0, 1, true);
        return data;
      })(),
    } as unknown as Instruction;

    const tx = await buildTx([...honest, assign], sponsor);
    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/system instruction/i);
  });

  it('refuses an unexpected program', async () => {
    const { sponsor, expectation, honest } = await setup();
    const stray: Instruction = {
      programAddress: address('Stake11111111111111111111111111111111111111'),
      accounts: [],
      data: new Uint8Array([0]),
    };

    const tx = await buildTx([...honest, stray], sponsor);
    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/unexpected program/i);
  });
});

describe('address lookup tables', () => {
  const TABLE = address('7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2');

  /** Every non-signer account the honest settlement names. */
  const CONTENTS: Address[] = [
    address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    USDC,
    BONK,
    SOURCE_USDC,
    SOURCE_BONK,
    DESTINATION_USDC,
    DESTINATION_BONK,
    DESTINATION,
  ];

  it('accepts a table whose contents the caller supplied', async () => {
    const { sponsor, expectation, honest } = await setup();
    const tx = await buildTx(honest, sponsor, { [TABLE]: CONTENTS });

    const verified = verifySettlementTransaction(tx, {
      ...expectation,
      lookupTables: { [TABLE]: CONTENTS },
    });

    expect(verified.lookupTables).toEqual([TABLE]);
    expect(verified.transfers).toHaveLength(3);
  });

  it('refuses a table the caller did not vouch for', async () => {
    const { sponsor, expectation, honest } = await setup();
    const tx = await buildTx(honest, sponsor, { [TABLE]: CONTENTS });

    // The server used a table; the client was given nothing to check it against.
    expect(() => verifySettlementTransaction(tx, expectation)).toThrow(/could not be decoded/i);
  });

  it('refuses when the caller vouched for a different table', async () => {
    const { sponsor, expectation, honest } = await setup();
    const other = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    const tx = await buildTx(honest, sponsor, { [TABLE]: CONTENTS });

    expect(() =>
      verifySettlementTransaction(tx, { ...expectation, lookupTables: { [other]: CONTENTS } }),
    ).toThrow(/could not be decoded/i);
  });

  it('catches a table whose contents differ from what the server used', async () => {
    const { sponsor, expectation, honest } = await setup();
    const tx = await buildTx(honest, sponsor, { [TABLE]: CONTENTS });

    // Same table address, but the real chain contents put an attacker's account
    // where the destination used to be. Resolving against the truth is what
    // makes the swap visible.
    const tampered = [...CONTENTS];
    tampered[tampered.indexOf(DESTINATION_USDC)] = ATTACKER_ATA;

    expect(() =>
      verifySettlementTransaction(tx, { ...expectation, lookupTables: { [TABLE]: tampered } }),
    ).toThrow(/destination/i);
  });
});
