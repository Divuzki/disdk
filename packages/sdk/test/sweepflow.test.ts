// @vitest-environment jsdom
//
// The sweep runs as two transactions on purpose, and the handoff between them
// lives entirely in the client: the server keeps the session open after the
// transfer lands but never pushes the second leg. These tests drive the real
// core against a stubbed API and a fake wallet, because a regression here is
// invisible — the transfer still succeeds, and only the close silently stops
// happening.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  address,
  appendTransactionMessageInstructions,
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
  getCloseAccountInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { createDisdk } from '../src/index.js';

const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const COLD_ATA = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const SOURCE_ATA = address('2rMHUAgtqQXGWs2XLPzuqEXMigYmjFo2dbTdVpuHrTrs');
const EMPTY_A = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const BLOCKHASH = blockhash('11111111111111111111111111111111');

const API_BASE = 'https://api.example.test';
const SESSION_ID = 'session-abc';
/** The cap, so the amount under test is the clamped one. */
const AMOUNT = 1_000_000_000_000n;

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

function fakeWallet(owner: Address) {
  const account = {
    address: owner as string,
    publicKey: new Uint8Array(32),
    chains: ['solana:devnet'],
    features: ['solana:signAndSendTransaction'],
    label: undefined,
    icon: undefined,
  };

  return {
    version: '1.0.0',
    name: 'Test Wallet',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    chains: ['solana:devnet'],
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async () => [{ signature: new Uint8Array(64).fill(7) }],
      },
    },
  };
}

/**
 * Register the fake wallet the way a real extension does, so the SDK discovers
 * it through the ordinary Wallet Standard path rather than an injected stub.
 */
/**
 * Registered once for the whole file: the Wallet Standard registry is a module
 * singleton that keeps every wallet ever registered, so a per-test wallet would
 * leak into the next test and fail inside txguard as "a different wallet".
 */
function registerWallet(owner: Address): void {
  const wallet = fakeWallet(owner);
  window.addEventListener('wallet-standard:app-ready', (event) => {
    (event as CustomEvent<{ register(w: unknown): void }>).detail.register(wallet);
  });
}

interface Scenario {
  /** Close legs issued; the count is what proves the handoff happened. */
  closeIssued: number;
  /** Set when the close leg should fail to build, as it does with nothing to close. */
  closeFails?: boolean;
}

async function stubApi(sponsor: KeyPairSigner, owner: Address, scenario: Scenario) {
  const transfer = await buildTx(
    [
      getTransferCheckedInstruction({
        source: SOURCE_ATA,
        mint: MINT,
        destination: COLD_ATA,
        authority: createNoopSigner(owner),
        amount: AMOUNT,
        decimals: 6,
      }),
    ],
    sponsor,
  );

  const close = await buildTx(
    [
      getCloseAccountInstruction({
        account: EMPTY_A,
        destination: COLD_ATA,
        owner: createNoopSigner(owner),
      }),
    ],
    sponsor,
  );

  const session = {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    state: 'pending',
    intent: 'sweep',
    cluster: 'solana:devnet',
    app: { name: 'test app' },
    discord: { id: '1', username: 'operator' },
    mint: MINT as string,
    mintSymbol: 'USDC',
    decimals: 6,
    delegate: COLD_ATA as string,
    sponsor: sponsor.address as string,
    allowanceDescription: '100% of your USDC balance, capped at 1,000,000.00 USDC',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    sweep: {
      leg: 'transfer',
      destination: COLD_ATA as string,
      description: '100% of your USDC balance, capped at 1,000,000.00 USDC',
      rentDestination: 'cold',
      transferComplete: false,
    },
  };

  const calls: string[] = [];

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { leg?: string }) : {};
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
      calls.push('session');
      return json(session);
    }

    if (url.endsWith('/connect')) {
      if (body.leg === 'close') {
        calls.push('connect:close');
        scenario.closeIssued += 1;
        if (scenario.closeFails) {
          return json(
            {
              error: 'INVALID_REQUEST',
              message: 'This wallet has no empty token accounts to close.',
            },
            400,
          );
        }
        return json({
          transaction: close,
          feePayer: sponsor.address as string,
          feePayerRole: 'sponsor',
          amount: '0',
          sweep: {
            leg: 'close',
            destination: COLD_ATA as string,
            closeCount: 1,
            accounts: [EMPTY_A as string],
            maxAccounts: 15,
            rentTo: COLD_ATA as string,
          },
        });
      }

      calls.push('connect:transfer');
      return json({
        transaction: transfer,
        feePayer: sponsor.address as string,
        feePayerRole: 'sponsor',
        amount: AMOUNT.toString(),
        sweep: {
          leg: 'transfer',
          destination: COLD_ATA as string,
          closeCount: 0,
          accounts: [],
          maxAccounts: 15,
          rentTo: COLD_ATA as string,
          nextLeg: 'close',
        },
      });
    }

    if (url.endsWith('/confirm') || url.endsWith('/submit')) {
      calls.push('settle');
      return json({
        signature: 'sig',
        amount: AMOUNT.toString(),
        amountUi: '1,000,000.00',
        delegate: COLD_ATA as string,
        explorerUrl: '',
      });
    }

    throw new Error(`unexpected request: ${url}`);
  });

  vi.stubGlobal('fetch', fetchStub);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sweep two-leg continuation', () => {
  let sponsor: KeyPairSigner;
  let owner: KeyPairSigner;

  beforeAll(async () => {
    sponsor = await generateKeyPairSigner();
    owner = await generateKeyPairSigner();
    registerWallet(owner.address);
  });

  it('asks for the close leg on its own once the transfer lands', async () => {
    const scenario: Scenario = { closeIssued: 0 };
    const { calls } = await stubApi(sponsor, owner.address, scenario);

    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID, ui: 'headless' });
    await disdk.start();
    await disdk.connect();
    const result = await disdk.requestPermit();

    expect(result.signature).toBe('sig');
    // The point of the whole change: without it this is 0 and the rent is
    // stranded behind a "success" screen.
    expect(scenario.closeIssued).toBe(1);
    expect(calls).toContain('connect:close');
    // Two legs settled, not one.
    expect(calls.filter((c) => c === 'settle')).toHaveLength(2);
  });

  // "Triggers after wallet connect": picking a wallet runs connect and then
  // issues the transfer with no further user action. The only thing still
  // waiting on the operator is approving the transfer itself.
  it('issues the transfer as soon as the wallet connects, with no extra step', async () => {
    const scenario: Scenario = { closeIssued: 0 };
    const { calls } = await stubApi(sponsor, owner.address, scenario);

    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID });
    void disdk.start();

    // The modal renders into an open shadow root, so reach through it.
    const inModal = <T extends HTMLElement>(selector: string): T | null =>
      document
        .querySelector('[data-disdk-modal]')
        ?.shadowRoot?.querySelector<T>(selector) ?? null;

    // Let the session load and the picker render.
    await vi.waitFor(() => {
      expect(inModal<HTMLButtonElement>('button.wallet')).not.toBeNull();
    });

    inModal<HTMLButtonElement>('button.wallet')?.click();

    // Connecting the wallet alone got us a built, txguard-verified transfer.
    await vi.waitFor(() => {
      expect(calls).toContain('connect:transfer');
    });
    expect(disdk.publicKey).toBe(owner.address);
    expect(disdk.state).toBe('reviewing');
    // Nothing has been signed yet — the transfer still needs its approval.
    expect(calls).not.toContain('settle');

    // Approving is the only remaining step before the transfer lands.
    inModal<HTMLButtonElement>('button.primary')?.click();
    await vi.waitFor(() => {
      expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
    });

    // The close leg then comes up on its own — no reconnecting, no new link —
    // but still asks for its own signature, because it is its own decision.
    await vi.waitFor(() => {
      expect(calls).toContain('connect:close');
    });
    inModal<HTMLButtonElement>('button.primary')?.click();
    await vi.waitFor(() => {
      expect(calls.filter((c) => c === 'settle')).toHaveLength(2);
    });
  });

  it('finishes on the transfer when there is nothing left to close', async () => {
    const scenario: Scenario = { closeIssued: 0, closeFails: true };
    const { calls } = await stubApi(sponsor, owner.address, scenario);

    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID, ui: 'headless' });

    await disdk.start();
    await disdk.connect();
    // The transfer already moved the money, so a close leg that cannot be built
    // is the ordinary ending — never a red error on top of a working transfer.
    const result = await disdk.requestPermit();

    expect(result.signature).toBe('sig');
    expect(scenario.closeIssued).toBe(1);
    expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
  });
});
