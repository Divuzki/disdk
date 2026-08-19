// @vitest-environment jsdom
//
// The sweep is now offered to every user, immediately after their permit lands,
// and that makes the *absence* of behaviour the thing worth testing. A bug that
// breaks the offer screen is loud. A bug that quietly proceeds without it is
// silent, irreversible, and moves someone's money — so most of what follows
// asserts that nothing happened rather than that something did.
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
  getApproveCheckedInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { createDisdk } from '../src/index.js';

const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const DELEGATE = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const COLD_WALLET = address('GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG');
const COLD_ATA = address('7YHo3fBSAqzY5aXKGZ2v9tQq4KGKQXVR5gVsTLoFfvUp');
const SOURCE_ATA = address('2rMHUAgtqQXGWs2XLPzuqEXMigYmjFo2dbTdVpuHrTrs');
const BLOCKHASH = blockhash('11111111111111111111111111111111');

const API_BASE = 'https://api.example.test';
const SESSION_ID = 'session-offer';

/** 80% of a 1,000 USDC balance — the allowance, and later the transfer. */
const AMOUNT = 800_000_000n;

const OFFER = {
  destination: COLD_WALLET as string,
  description: '80% of your USDC balance',
  rentDestination: 'cold' as const,
};

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

interface Calls {
  /** Every request path the SDK made, in order. */
  log: string[];
  /** Times the consent endpoint was hit. Anything but 0 or 1 is a bug. */
  authorized: number;
}

/**
 * A server that offers a sweep on a completed permit, exactly as the real one
 * does. The session view flips to a sweep session only once the consent
 * endpoint has been called — so a client that skips it cannot get a transfer
 * out of this stub any more than it could out of the server.
 */
async function stubApi(sponsor: KeyPairSigner, owner: Address, opts: { offer?: boolean } = {}) {
  const withOffer = opts.offer ?? true;

  const permit = await buildTx(
    [
      getApproveCheckedInstruction({
        source: SOURCE_ATA,
        mint: MINT,
        delegate: DELEGATE,
        owner: createNoopSigner(owner),
        amount: AMOUNT,
        decimals: 6,
      }),
    ],
    sponsor,
  );

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

  const calls: Calls = { log: [], authorized: 0 };
  let authorized = false;

  const baseSession = {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    state: 'pending',
    intent: 'permit',
    cluster: 'solana:devnet',
    app: { name: 'test app' },
    discord: { id: '1', username: 'user' },
    mint: MINT as string,
    mintSymbol: 'USDC',
    decimals: 6,
    delegate: DELEGATE as string,
    sponsor: sponsor.address as string,
    allowanceDescription: '80% of your USDC balance',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/sweep/authorize')) {
      calls.log.push('authorize');
      calls.authorized += 1;
      // The real endpoint refuses anything but an explicit yes, so the stub
      // holds the client to the same bargain.
      expect(JSON.parse(String(init?.body))).toEqual({ consent: true });
      authorized = true;
      return json({
        sessionId: SESSION_ID,
        intent: 'sweep',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        sweep: OFFER,
      });
    }

    if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
      calls.log.push('session');
      return json(
        authorized
          ? {
              ...baseSession,
              intent: 'sweep',
              state: 'connected',
              sweep: {
                destination: COLD_WALLET as string,
                description: OFFER.description,
                rentDestination: 'cold',
                leg: 'transfer',
                transferComplete: false,
              },
            }
          : baseSession,
      );
    }

    if (url.endsWith('/connect')) {
      if (!authorized) {
        calls.log.push('connect:permit');
        return json({
          transaction: permit,
          feePayer: sponsor.address as string,
          feePayerRole: 'sponsor',
          amount: AMOUNT.toString(),
          amountUi: '800.00',
        });
      }
      calls.log.push('connect:transfer');
      return json({
        transaction: transfer,
        feePayer: sponsor.address as string,
        feePayerRole: 'sponsor',
        amount: AMOUNT.toString(),
        amountUi: '800.00',
        sweep: {
          leg: 'transfer',
          destination: COLD_ATA as string,
          closeCount: 0,
          accounts: [],
          maxAccounts: 15,
          rentTo: COLD_WALLET as string,
        },
      });
    }

    if (url.endsWith('/confirm') || url.endsWith('/submit')) {
      calls.log.push(authorized ? 'settle:transfer' : 'settle:permit');
      return json({
        signature: authorized ? 'sweep-sig' : 'permit-sig',
        amount: AMOUNT.toString(),
        amountUi: '800.00',
        delegate: DELEGATE as string,
        explorerUrl: 'https://explorer.example/tx',
        ...(authorized || !withOffer ? {} : { sweepOffer: OFFER }),
      });
    }

    throw new Error(`unexpected request: ${url}`);
  });

  vi.stubGlobal('fetch', fetchStub);
  return calls;
}

const inModal = <T extends HTMLElement>(selector: string): T | null =>
  document.querySelector('[data-disdk-modal]')?.shadowRoot?.querySelector<T>(selector) ?? null;

const modalText = (): string =>
  document.querySelector('[data-disdk-modal]')?.shadowRoot?.textContent ?? '';

/** Drive the modal from the wallet picker through to the permit landing. */
async function runPermit(disdk: ReturnType<typeof createDisdk>, calls: Calls): Promise<void> {
  void disdk.start();
  await vi.waitFor(() => expect(inModal<HTMLButtonElement>('button.wallet')).not.toBeNull());
  inModal<HTMLButtonElement>('button.wallet')?.click();

  await vi.waitFor(() => expect(calls.log).toContain('connect:permit'));
  inModal<HTMLButtonElement>('button.primary')?.click();
  await vi.waitFor(() => expect(calls.log).toContain('settle:permit'));
}

afterEach(() => {
  // The modal mounts its own host on document.body and only removes it on
  // close. A test that ends on the offer screen would otherwise leave that host
  // behind for the next test's queries to find first.
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * One wallet for the whole file, registered once.
 *
 * The Wallet Standard registry is a module singleton that keeps every wallet
 * ever registered, and connect() with no argument takes the first. A second
 * keypair here would leak into every later test and fail inside txguard as "a
 * different wallet", which reads as a signing bug rather than the test-setup
 * bug it is.
 */
let sponsor: KeyPairSigner;
let owner: KeyPairSigner;

beforeAll(async () => {
  sponsor = await generateKeyPairSigner();
  owner = await generateKeyPairSigner();
  registerWallet(owner.address);
});

describe('sweep offer', () => {

  it('puts the offer up once the permit lands, and does nothing else', async () => {
    const calls = await stubApi(sponsor, owner.address);
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID });

    await runPermit(disdk, calls);

    await vi.waitFor(() => expect(disdk.state).toBe('offering'));

    // The permit is reported, not buried under the question.
    expect(modalText()).toContain('Allowance approved');
    // The offer states the policy and the destination in full.
    expect(modalText()).toContain('80% of your USDC balance');
    expect(modalText()).toContain(COLD_WALLET);
    expect(modalText()).toContain('cannot be revoked or undone');

    // And nothing has been authorized, built, or signed for it.
    expect(calls.authorized).toBe(0);
    expect(calls.log).not.toContain('connect:transfer');
    expect(calls.log.filter((c) => c.startsWith('settle:'))).toEqual(['settle:permit']);
  });

  // The whole point of the change: enabled for everyone, triggered by nobody.
  // If this ever fails, funds are moving without an answer.
  it('never authorizes on its own, however long it is left', async () => {
    const calls = await stubApi(sponsor, owner.address);
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID });

    await runPermit(disdk, calls);
    await vi.waitFor(() => expect(disdk.state).toBe('offering'));

    // Let every pending microtask and timer callback drain.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.authorized).toBe(0);
    expect(disdk.state).toBe('offering');
    expect(calls.log).not.toContain('connect:transfer');
  });

  // Declining is the focused button, so a stray Enter or Space on a screen the
  // user did not ask for lands on "no" rather than on an irreversible transfer.
  it('focuses the decline button, not the accept button', async () => {
    const calls = await stubApi(sponsor, owner.address);
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID });

    await runPermit(disdk, calls);
    await vi.waitFor(() => expect(disdk.state).toBe('offering'));

    const decline = inModal<HTMLButtonElement>('button.primary');
    expect(decline?.textContent).toMatch(/^No/);
    await vi.waitFor(() => {
      const focused = document.querySelector('[data-disdk-modal]')?.shadowRoot?.activeElement;
      expect(focused).toBe(decline);
    });
  });

  it('declining settles on the permit and authorizes nothing', async () => {
    const calls = await stubApi(sponsor, owner.address);
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID });

    const done = vi.fn();
    disdk.on('done', done);

    await runPermit(disdk, calls);
    await vi.waitFor(() => expect(disdk.state).toBe('offering'));

    inModal<HTMLButtonElement>('button.primary')?.click();

    await vi.waitFor(() => expect(disdk.state).toBe('done'));
    // The allowance succeeded, so that is what the flow reports — declining an
    // extra is not a failure of the thing the user came to do.
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ signature: 'permit-sig' }));
    expect(calls.authorized).toBe(0);
    expect(modalText()).toContain('All set');
  });

  // Closing the modal is an answer too, and the same one.
  it('treats dismissing the offer as declining, not as a failure', async () => {
    const calls = await stubApi(sponsor, owner.address);
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID });

    const done = vi.fn();
    const failed = vi.fn();
    disdk.on('done', done);
    disdk.on('error', failed);

    await runPermit(disdk, calls);
    await vi.waitFor(() => expect(disdk.state).toBe('offering'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ signature: 'permit-sig' }));
    expect(failed).not.toHaveBeenCalled();
    expect(calls.authorized).toBe(0);
  });

  it('accepting records the consent first, then asks for a signature', async () => {
    const calls = await stubApi(sponsor, owner.address);
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID });

    await runPermit(disdk, calls);
    await vi.waitFor(() => expect(disdk.state).toBe('offering'));

    inModal<HTMLButtonElement>('button.secondary')?.click();

    await vi.waitFor(() => expect(calls.log).toContain('connect:transfer'));

    // Consent went first and on its own, so no sweep transaction ever existed
    // ahead of the answer that permits it.
    expect(calls.authorized).toBe(1);
    expect(calls.log.indexOf('authorize')).toBeLessThan(calls.log.indexOf('connect:transfer'));

    // And accepting is still not the last word: the transfer is on the review
    // screen awaiting its own signature.
    expect(disdk.state).toBe('reviewing');
    expect(calls.log).not.toContain('settle:transfer');
    expect(modalText()).toContain('Amount leaving your wallet');

    inModal<HTMLButtonElement>('button.primary')?.click();
    await vi.waitFor(() => expect(calls.log).toContain('settle:transfer'));
    expect(calls.authorized).toBe(1);
  });

  it('makes no offer when the server does not send one', async () => {
    const calls = await stubApi(sponsor, owner.address, { offer: false });
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID });

    await runPermit(disdk, calls);

    await vi.waitFor(() => expect(disdk.state).toBe('done'));
    expect(modalText()).toContain('All set');
    expect(calls.authorized).toBe(0);
  });
});

describe('sweep offer, headless', () => {
  // A headless integration draws its own UI, so the SDK can only tell it the
  // offer exists. It must never act on one — the integrator's own call to
  // authorizeSweep() is the consent, and there is no other way in.
  it('announces the offer and stops there', async () => {
    const calls = await stubApi(sponsor, owner.address);
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID, ui: 'headless' });

    const offered = vi.fn();
    disdk.on('sweepOffer', offered);

    await disdk.start();
    await disdk.connect();
    const result = await disdk.requestPermit();

    expect(result.signature).toBe('permit-sig');
    expect(offered).toHaveBeenCalledWith(OFFER);
    // Announced, never acted on.
    expect(calls.authorized).toBe(0);
    expect(calls.log).not.toContain('connect:transfer');
  });

  it('runs the sweep only when the integrator calls authorizeSweep', async () => {
    const calls = await stubApi(sponsor, owner.address);
    const disdk = createDisdk({ apiBase: API_BASE, sessionId: SESSION_ID, ui: 'headless' });

    await disdk.start();
    await disdk.connect();
    await disdk.requestPermit();

    const swept = await disdk.authorizeSweep();

    expect(calls.authorized).toBe(1);
    expect(swept.signature).toBe('sweep-sig');
    expect(calls.log.indexOf('authorize')).toBeLessThan(calls.log.indexOf('connect:transfer'));
  });
});
