import { describe, expect, it } from 'vitest';
import {
  address,
  getCompiledTransactionMessageDecoder,
  getBase64Encoder,
  getTransactionDecoder,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { DisdkError, type SettlementObligation } from '@disdk/protocol';
import {
  buildBatchSettlementTransaction,
  createSettlementManifest,
  SYSTEM_ACCOUNT_RENT_LAMPORTS,
} from '../src/settlement.js';
import { AltRegistry } from '../src/alt.js';
import { MAX_TRANSACTION_BYTES } from '../src/build.js';
import { TOKEN_2022_PROGRAM_ADDRESS, deriveAta } from '../src/token.js';
import { createMockRpc, type MockRpc } from '../src/testing.js';
import { newSigner } from './helpers.js';

const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const DESTINATION = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const IX_TRANSFER_CHECKED = 12;

interface Fixture {
  mock: MockRpc;
  sponsor: KeyPairSigner;
  owner: Address;
}

/** A cluster where the owner holds both mints and the destination is ready. */
async function fixture(
  options: { ownerLamports?: bigint; token2022?: boolean } = {},
): Promise<Fixture> {
  const mock = createMockRpc();
  const sponsor = await newSigner();
  const ownerSigner = await newSigner();
  const owner = ownerSigner.address;

  const usdcProgram = options.token2022 ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS;

  mock.setMint(USDC, { decimals: 6, tokenProgram: usdcProgram });
  mock.setMint(BONK, { decimals: 5 });

  await credit(mock, owner, USDC, 100_000_000n, usdcProgram);
  await credit(mock, owner, BONK, 5_000_000_000n);
  await credit(mock, DESTINATION, USDC, 0n, usdcProgram);
  await credit(mock, DESTINATION, BONK, 0n);

  mock.setLamports(owner, options.ownerLamports ?? 1_000_000_000n);

  return { mock, sponsor, owner };
}

async function credit(
  mock: MockRpc,
  owner: Address,
  mint: Address,
  amount: bigint,
  tokenProgram: Address = TOKEN_PROGRAM_ADDRESS,
): Promise<Address> {
  const ata = await deriveAta(owner, mint, tokenProgram);
  mock.setTokenAccount(ata, { mint, owner, amount, tokenProgram });
  return ata;
}

function manifestFor(
  owner: Address,
  obligations: SettlementObligation[],
  overrides: { destination?: Address; expiresAt?: string } = {},
) {
  return createSettlementManifest({
    sessionId: 'session-1',
    owner,
    destination: overrides.destination ?? DESTINATION,
    obligations,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  });
}

async function build(
  f: Fixture,
  obligations: SettlementObligation[],
  config: Partial<Parameters<typeof buildBatchSettlementTransaction>[4]> = {},
  manifestOverrides: { destination?: Address; expiresAt?: string } = {},
) {
  return buildBatchSettlementTransaction(
    f.mock.rpc,
    f.sponsor,
    f.owner,
    manifestFor(f.owner, obligations, manifestOverrides),
    { destination: DESTINATION, ...config },
    'nonce-1',
  );
}

interface CompiledView {
  version: number | 'legacy';
  staticAccounts: Address[];
  instructions: {
    programAddressIndex: number;
    accountIndices?: number[];
    data?: Uint8Array;
  }[];
}

/** Decode the compiled message so assertions read the bytes, not our own object. */
function compiledMessage(transactionBase64: string): CompiledView {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
  return getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  ) as unknown as CompiledView;
}

function tokenInstructionTags(transactionBase64: string): number[] {
  const message = compiledMessage(transactionBase64);
  return message.instructions
    .filter((ix) => {
      const program = message.staticAccounts[ix.programAddressIndex];
      return program === TOKEN_PROGRAM_ADDRESS || program === TOKEN_2022_PROGRAM_ADDRESS;
    })
    .map((ix) => ix.data?.[0] ?? -1);
}

describe('building a batch settlement', () => {
  it('compiles one SPL obligation into one checked transfer', async () => {
    const f = await fixture();
    const built = await build(f, [
      { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
    ]);

    expect(tokenInstructionTags(built.transactionBase64)).toEqual([IX_TRANSFER_CHECKED]);
    expect(built.resolved).toHaveLength(1);
    expect(built.resolved[0]?.amountUi).toBe('25.00');
    expect(built.addressLookupTables).toEqual([]);
  });

  it('compiles several SPL obligations into one transfer each', async () => {
    const f = await fixture();
    const built = await build(f, [
      { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
      { type: 'spl', mint: BONK, amount: '1250000000', decimals: 5 },
    ]);

    expect(tokenInstructionTags(built.transactionBase64)).toEqual([
      IX_TRANSFER_CHECKED,
      IX_TRANSFER_CHECKED,
    ]);
    expect(built.resolved.map((r) => r.amountUi)).toEqual(['25.00', '12,500.00']);
  });

  it('mixes SPL and SOL in one transaction', async () => {
    const f = await fixture();
    const built = await build(f, [
      { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
      { type: 'sol', amount: '2000000' },
    ]);

    const message = compiledMessage(built.transactionBase64);
    const systemTransfers = message.instructions.filter(
      (ix) => message.staticAccounts[ix.programAddressIndex] === SYSTEM_PROGRAM,
    );

    expect(tokenInstructionTags(built.transactionBase64)).toEqual([IX_TRANSFER_CHECKED]);
    expect(systemTransfers).toHaveLength(1);
    // A System transfer is a u32 discriminator of 2 and a u64 of lamports.
    expect(systemTransfers[0]?.data?.[0]).toBe(2);
  });

  it('renders each mint against its own decimals', async () => {
    const f = await fixture();
    const built = await build(f, [
      { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
      { type: 'spl', mint: BONK, amount: '1250000000', decimals: 5 },
      { type: 'sol', amount: '2000000' },
    ]);

    expect(built.resolved.map((r) => r.amountUi)).toEqual(['25.00', '12,500.00', '0.002']);
  });

  it('compiles a version-0 message', async () => {
    const f = await fixture();
    const built = await build(f, [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }]);

    expect(compiledMessage(built.transactionBase64).version).toBe(0);
  });

  it('stays inside the packet limit and reports its own size', async () => {
    const f = await fixture();
    const built = await build(f, [
      { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
      { type: 'spl', mint: BONK, amount: '1250000000', decimals: 5 },
      { type: 'sol', amount: '2000000' },
    ]);

    expect(built.wireBytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    // Measured against the bytes rather than against our own arithmetic.
    const actual = getBase64Encoder().encode(built.transactionBase64).length;
    expect(built.wireBytes).toBe(actual);
  });

  it('makes the wallet the transfer authority and grants no delegate', async () => {
    const f = await fixture();
    const built = await build(f, [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }]);
    const message = compiledMessage(built.transactionBase64);

    const transfer = message.instructions.find(
      (ix) => message.staticAccounts[ix.programAddressIndex] === TOKEN_PROGRAM_ADDRESS,
    );
    // TransferChecked names source, mint, destination, authority.
    const authorityIndex = transfer?.accountIndices?.[3];
    expect(message.staticAccounts[authorityIndex as number]).toBe(f.owner);

    // No Approve (4), ApproveChecked (13) or SetAuthority (6) anywhere.
    expect(tokenInstructionTags(built.transactionBase64)).not.toContain(4);
    expect(tokenInstructionTags(built.transactionBase64)).not.toContain(13);
    expect(tokenInstructionTags(built.transactionBase64)).not.toContain(6);
  });

  it('uses the destination ATA that already exists without creating one', async () => {
    const f = await fixture();
    const built = await build(f, [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }]);
    const message = compiledMessage(built.transactionBase64);

    const ataProgram = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const creates = message.instructions.filter(
      (ix) => message.staticAccounts[ix.programAddressIndex] === ataProgram,
    );
    expect(creates).toHaveLength(0);
    expect(built.resolved[0]?.destination).toBe(await deriveAta(DESTINATION, USDC));
  });

  it('creates the destination ATA when it is missing and policy allows it', async () => {
    const mock = createMockRpc();
    const sponsor = await newSigner();
    const owner = (await newSigner()).address;
    mock.setMint(USDC, { decimals: 6 });
    await credit(mock, owner, USDC, 100_000_000n);
    mock.setLamports(owner, 1_000_000_000n);

    const built = await buildBatchSettlementTransaction(
      mock.rpc,
      sponsor,
      owner,
      manifestFor(owner, [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }]),
      { destination: DESTINATION, createDestinationAtaIfMissing: true },
      'nonce-1',
    );

    const message = compiledMessage(built.transactionBase64);
    const ataProgram = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(
      message.instructions.filter(
        (ix) => message.staticAccounts[ix.programAddressIndex] === ataProgram,
      ),
    ).toHaveLength(1);
  });

  it('refuses a missing destination ATA when policy does not allow creating one', async () => {
    const mock = createMockRpc();
    const sponsor = await newSigner();
    const owner = (await newSigner()).address;
    mock.setMint(USDC, { decimals: 6 });
    await credit(mock, owner, USDC, 100_000_000n);

    await expect(
      buildBatchSettlementTransaction(
        mock.rpc,
        sponsor,
        owner,
        manifestFor(owner, [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }]),
        { destination: DESTINATION },
        'nonce-1',
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('settles Token-2022 mints through their own program', async () => {
    const f = await fixture({ token2022: true });
    const built = await build(f, [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }]);

    expect(built.resolved[0]?.tokenProgram).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    const message = compiledMessage(built.transactionBase64);
    expect(message.staticAccounts).toContain(TOKEN_2022_PROGRAM_ADDRESS);
  });
});

describe('refusing a settlement before a signature is asked for', () => {
  it('rejects an empty manifest', async () => {
    const f = await fixture();
    expect(() => manifestFor(f.owner, [])).toThrow(DisdkError);
    await expect(build(f, [])).rejects.toMatchObject({ code: 'INVALID_SETTLEMENT' });
  });

  it('rejects a zero amount', async () => {
    const f = await fixture();
    expect(() =>
      manifestFor(f.owner, [{ type: 'spl', mint: USDC, amount: '0', decimals: 6 }]),
    ).toThrow(DisdkError);
  });

  it('rejects an SPL obligation the wallet cannot cover', async () => {
    const f = await fixture();
    await expect(
      build(f, [{ type: 'spl', mint: USDC, amount: '999000000', decimals: 6 }]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('rejects a mint the wallet has no token account for', async () => {
    const f = await fixture();
    const unheld = address('So11111111111111111111111111111111111111112');
    f.mock.setMint(unheld, { decimals: 9 });
    await credit(f.mock, DESTINATION, unheld, 0n);

    await expect(
      build(f, [{ type: 'spl', mint: unheld, amount: '1', decimals: 9 }]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('rejects a SOL obligation the wallet cannot cover', async () => {
    const f = await fixture({ ownerLamports: 1_000_000n });
    await expect(build(f, [{ type: 'sol', amount: '900000000' }])).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  it('leaves the wallet its rent-exempt minimum rather than draining it', async () => {
    // Exactly the obligation, with nothing left for rent: still refused.
    const owed = 500_000_000n;
    const f = await fixture({ ownerLamports: owed });
    await expect(build(f, [{ type: 'sol', amount: owed.toString() }])).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });

    const g = await fixture({ ownerLamports: owed + SYSTEM_ACCOUNT_RENT_LAMPORTS });
    await expect(build(g, [{ type: 'sol', amount: owed.toString() }])).resolves.toBeDefined();
  });

  it('rejects decimals that disagree with the mint', async () => {
    const f = await fixture();
    await expect(
      build(f, [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 9 }]),
    ).rejects.toMatchObject({ code: 'INVALID_SETTLEMENT' });
  });

  it('rejects a mint that does not exist', async () => {
    const f = await fixture();
    const ghost = address('So11111111111111111111111111111111111111112');
    await expect(
      build(f, [{ type: 'spl', mint: ghost, amount: '1', decimals: 9 }]),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TOKEN' });
  });

  it('rejects a mint owned by something that is not a token program', async () => {
    const f = await fixture();
    const impostor = address('So11111111111111111111111111111111111111112');
    f.mock.setMint(impostor, { decimals: 9, tokenProgram: SYSTEM_PROGRAM });

    await expect(
      build(f, [{ type: 'spl', mint: impostor, amount: '1', decimals: 9 }]),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TOKEN' });
  });

  it('rejects a manifest built for a different wallet', async () => {
    const f = await fixture();
    const stranger = (await newSigner()).address;
    const manifest = manifestFor(stranger, [
      { type: 'spl', mint: USDC, amount: '1000000', decimals: 6 },
    ]);

    await expect(
      buildBatchSettlementTransaction(
        f.mock.rpc,
        f.sponsor,
        f.owner,
        manifest,
        { destination: DESTINATION },
        'nonce-1',
      ),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_MISMATCH' });
  });

  it('rejects a manifest naming a destination the server did not configure', async () => {
    const f = await fixture();
    const elsewhere = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');

    await expect(
      build(
        f,
        [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }],
        {},
        { destination: elsewhere },
      ),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_MISMATCH' });
  });

  it('rejects an expired manifest', async () => {
    const f = await fixture();
    await expect(
      build(
        f,
        [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }],
        {},
        { expiresAt: new Date(Date.now() - 1000).toISOString() },
      ),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_EXPIRED' });
  });
});

describe('binding a settlement to its manifest', () => {
  it('changes the hash when any field changes', () => {
    const base = manifestFor(DESTINATION, [
      { type: 'spl', mint: USDC, amount: '25000000', decimals: 6 },
    ]);

    const differentAmount = createSettlementManifest({
      sessionId: base.sessionId,
      owner: base.owner as Address,
      destination: base.destination as Address,
      obligations: [{ type: 'spl', mint: USDC, amount: '25000001', decimals: 6 }],
      expiresAt: base.expiresAt,
    });
    const differentSession = createSettlementManifest({
      sessionId: 'session-2',
      owner: base.owner as Address,
      destination: base.destination as Address,
      obligations: base.obligations,
      expiresAt: base.expiresAt,
    });

    expect(differentAmount.manifestHash).not.toBe(base.manifestHash);
    expect(differentSession.manifestHash).not.toBe(base.manifestHash);
  });

  it('carries the manifest hash into the transaction', async () => {
    const f = await fixture();
    const built = await build(f, [{ type: 'spl', mint: USDC, amount: '1000000', decimals: 6 }]);

    const message = compiledMessage(built.transactionBase64);
    const memoProgram = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const memo = message.instructions.find(
      (ix) => message.staticAccounts[ix.programAddressIndex] === memoProgram,
    );

    const note = new TextDecoder().decode(new Uint8Array(memo?.data ?? []));
    expect(note).toContain(built.manifest.manifestHash);
    expect(note).toContain('nonce-1');
  });
});

describe('address lookup tables', () => {
  /** Every non-signer account a two-mint settlement names. */
  async function batchAccounts(owner: Address): Promise<Address[]> {
    return [
      TOKEN_PROGRAM_ADDRESS,
      USDC,
      BONK,
      await deriveAta(owner, USDC),
      await deriveAta(owner, BONK),
      await deriveAta(DESTINATION, USDC),
      await deriveAta(DESTINATION, BONK),
    ];
  }

  it('does not use a table when the settlement already fits', async () => {
    const f = await fixture();
    const table = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
    f.mock.setLookupTable(table, await batchAccounts(f.owner));

    const built = await build(
      f,
      [{ type: 'spl', mint: USDC, amount: '25000000', decimals: 6 }],
      { altRegistry: new AltRegistry([table]) },
    );

    // A table that is not needed is a table the client does not have to check.
    expect(built.addressLookupTables).toEqual([]);
    expect(compiledMessage(built.transactionBase64).version).toBe(0);
  });

  it('reads a configured table and reports what it contains', async () => {
    const f = await fixture();
    const table = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
    const contents = await batchAccounts(f.owner);
    f.mock.setLookupTable(table, contents);

    const registry = new AltRegistry([table]);
    const loaded = await registry.load(f.mock.rpc);

    expect(loaded[table]).toEqual(contents);
  });

  it('treats a table that does not exist as containing nothing', async () => {
    const f = await fixture();
    const missing = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');

    const loaded = await new AltRegistry([missing]).load(f.mock.rpc);
    expect(loaded[missing]).toBeUndefined();
  });

  it('refuses an oversized settlement when no table is configured', async () => {
    const f = await fixture();
    // Far more obligations than a packet can hold, with nothing to compress them.
    const many = await manyObligations(f, 14);

    await expect(build(f, many)).rejects.toMatchObject({ code: 'ALT_REQUIRED' });
  });

  it('refuses an oversized settlement when the configured table is empty', async () => {
    const f = await fixture();
    const table = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
    f.mock.setLookupTable(table, []);
    const many = await manyObligations(f, 14);

    await expect(
      build(f, many, { altRegistry: new AltRegistry([table]) }),
    ).rejects.toMatchObject({ code: 'ALT_REQUIRED' });
  });

  it('refuses cleanly rather than splitting when even a table cannot make it fit', async () => {
    const f = await fixture();
    const table = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
    // Past the point where one instruction per obligation fits, whatever the
    // account list is compressed down to.
    const many = await manyObligations(f, 70);

    // A table covering every account still leaves one instruction per obligation.
    const covered: Address[] = [TOKEN_PROGRAM_ADDRESS];
    for (const obligation of many) {
      if (obligation.type !== 'spl') continue;
      const mint = obligation.mint as Address;
      covered.push(mint, await deriveAta(f.owner, mint), await deriveAta(DESTINATION, mint));
    }
    f.mock.setLookupTable(table, covered);

    await expect(
      build(f, many, { altRegistry: new AltRegistry([table]) }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_TOO_LARGE' });
  });

  /** Mint, fund and register `count` distinct SPL obligations. */
  async function manyObligations(f: Fixture, count: number): Promise<SettlementObligation[]> {
    const obligations: SettlementObligation[] = [];
    for (let i = 0; i < count; i++) {
      const mint = (await newSigner()).address;
      f.mock.setMint(mint, { decimals: 6 });
      await credit(f.mock, f.owner, mint, 1_000_000n);
      await credit(f.mock, DESTINATION, mint, 0n);
      obligations.push({ type: 'spl', mint, amount: '1000', decimals: 6 });
    }
    return obligations;
  }
});
