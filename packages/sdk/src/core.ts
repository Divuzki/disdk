import {
  DisdkError,
  U64_MAX,
  type CompleteResponse,
  type Cluster,
  type ConnectResponse,
  type SessionPublic,
  type SweepOfferPublic,
} from '@disdk/protocol';
import { DisdkApi } from './api.js';
import { Emitter, type DisdkEventMap, type DisdkState } from './events.js';
import { detectEnvironment, type Environment } from './environment.js';
import { planEscape, type EscapeRoute } from './deeplinks.js';
import {
  assertFeePayerAllowed,
  verifyChargeTransfer,
  verifyPermitTransaction,
  verifySweepClose,
  verifySweepTransfer,
} from './txguard.js';
import { signSponsoredTransaction } from './signing.js';
import {
  connectWallet,
  disconnectWallet,
  listWallets,
  registerMobileWalletAdapter,
  watchWallets,
  type DiscoveredWallet,
  type WalletAccount,
} from './wallets.js';
import { DisdkModal, type ReviewDetails, type Theme } from './ui/modal.js';

export interface DisdkConfig {
  /** Base URL of your disdk server, e.g. https://api.example.com */
  apiBase: string;
  /** Defaults to the `ds` query parameter placed in the Discord link. */
  sessionId?: string;
  sessionParam?: string;
  theme?: Theme;
  /** `headless` skips all built-in UI and emits events instead. */
  ui?: 'modal' | 'headless';
  /** Enables the desktop QR flow through Mobile Wallet Adapter. */
  remoteHostAuthority?: string;
}

export interface Disdk {
  readonly state: DisdkState;
  readonly session: SessionPublic | null;
  readonly publicKey: string | null;
  start(): Promise<CompleteResponse | null>;
  connect(entry?: DiscoveredWallet): Promise<{ publicKey: string; walletName: string }>;
  requestPermit(): Promise<CompleteResponse>;
  /**
   * Accept a sweep offer, and only ever in answer to one.
   *
   * The modal wires this to its own button; a headless integration calls it from
   * whatever it puts in front of the user after the `sweepOffer` event. It is
   * the single entry point to a sweep in this SDK, deliberately: nothing else
   * reaches the authorization endpoint, so there is no path to a transfer that
   * does not start with someone choosing one.
   *
   * Records the consent, then puts the transfer up for review. It still has to
   * be signed in the wallet afterwards, so calling this is not the last word.
   */
  authorizeSweep(): Promise<CompleteResponse>;
  disconnect(): Promise<void>;
  listWallets(): DiscoveredWallet[];
  escapeRoute(): EscapeRoute;
  attach(target: string | HTMLElement): () => void;
  close(): void;
  on<K extends keyof DisdkEventMap>(event: K, listener: (payload: DisdkEventMap[K]) => void): () => void;
  off<K extends keyof DisdkEventMap>(event: K, listener: (payload: DisdkEventMap[K]) => void): void;
}

export function readSessionIdFromUrl(param = 'ds'): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);

  const fromQuery = url.searchParams.get(param);
  if (fromQuery) return fromQuery;

  // Also accept the fragment, which keeps the id out of server logs and
  // Referer headers if a deployment prefers that.
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const fromHash = new URLSearchParams(hash).get(param);
  if (fromHash) return fromHash;

  // …and a path-style link such as /c/<id>.
  const match = /\/c\/([A-Za-z0-9_-]{16,})/.exec(url.pathname);
  return match?.[1] ?? null;
}

export function createDisdk(config: DisdkConfig): Disdk {
  return new DisdkClient(config);
}

class DisdkClient implements Disdk {
  readonly #config: DisdkConfig;
  readonly #api: DisdkApi;
  readonly #emitter = new Emitter();
  readonly #environment: Environment;
  #modal: DisdkModal | null = null;

  #state: DisdkState = 'idle';
  #session: SessionPublic | null = null;
  #wallets: DiscoveredWallet[] = [];
  #unwatch: (() => void) | null = null;

  #selected: DiscoveredWallet | null = null;
  #account: WalletAccount | null = null;
  #pending: ConnectResponse | null = null;

  /**
   * Result of a sweep's transfer leg, held while the optional close leg runs.
   * The transfer is the irreversible half: once it lands the sweep has
   * succeeded, so every later outcome — declining the close, or failing to
   * build it — still resolves to this rather than to an error.
   */
  #sweepTransfer: CompleteResponse | null = null;

  /**
   * A sweep offered but not yet answered, with the permit result it followed.
   *
   * Held together because they are only ever useful together: the offer screen
   * reports the permit and asks the question, and declining has to land on that
   * same permit rather than on nothing. Both are cleared the moment the flow
   * settles, either way.
   */
  #sweepOffer: SweepOfferPublic | null = null;
  #permitResult: CompleteResponse | null = null;

  #flow: { resolve(value: CompleteResponse | null): void; reject(error: unknown): void } | null = null;

  constructor(config: DisdkConfig) {
    this.#config = config;
    this.#api = new DisdkApi(config.apiBase);
    this.#environment = detectEnvironment();
  }

  get state(): DisdkState {
    return this.#state;
  }

  get session(): SessionPublic | null {
    return this.#session;
  }

  get publicKey(): string | null {
    return this.#account?.address ?? null;
  }

  on<K extends keyof DisdkEventMap>(
    event: K,
    listener: (payload: DisdkEventMap[K]) => void,
  ): () => void {
    return this.#emitter.on(event, listener);
  }

  off<K extends keyof DisdkEventMap>(
    event: K,
    listener: (payload: DisdkEventMap[K]) => void,
  ): void {
    this.#emitter.off(event, listener);
  }

  listWallets(): DiscoveredWallet[] {
    return this.#wallets;
  }

  escapeRoute(): EscapeRoute {
    return planEscape({
      environment: this.#environment,
      href: typeof window === 'undefined' ? '' : window.location.href,
      origin: typeof window === 'undefined' ? '' : window.location.origin,
    });
  }

  attach(target: string | HTMLElement): () => void {
    const elements =
      typeof target === 'string'
        ? Array.from(document.querySelectorAll<HTMLElement>(target))
        : [target];

    const handler = (event: Event) => {
      event.preventDefault();
      void this.start().catch(() => {
        // start() already surfaces failures through the error event.
      });
    };

    for (const element of elements) {
      element.addEventListener('click', handler);
    }
    return () => {
      for (const element of elements) element.removeEventListener('click', handler);
    };
  }

  async start(): Promise<CompleteResponse | null> {
    const sessionId = this.#sessionId();
    if (!sessionId) {
      const error = new DisdkError(
        'SESSION_NOT_FOUND',
        'No connect link found. Run /connect in Discord to get one.',
      );
      this.#fail(error);
      throw error;
    }

    if (this.#usesModal()) {
      this.#ensureModal().open();
      this.#modal?.showLoading('Loading your link…');
    }
    this.#setState('loading');

    try {
      const session = await this.#api.getSession(sessionId);
      this.#session = session;
      this.#emitter.emit('session', session);
      this.#modal?.setSession(session);

      if (session.state === 'complete' && session.signature) {
        const result: CompleteResponse = {
          signature: session.signature,
          amount: session.approvedAmount ?? '0',
          amountUi: session.approvedAmount ?? '0',
          delegate: session.delegate,
          explorerUrl: '',
          sweepOffer: session.sweepOffer,
        };

        // A finished link, reopened. The offer is announced — a custom UI may
        // still want to put it — but the modal deliberately does not re-ask.
        //
        // Re-prompting on every refresh would turn one question into a standing
        // one, and a standing question about an irreversible transfer is how
        // consent gets worn down rather than given. It is offered once, when the
        // permit lands and the wallet that signed is still connected; a reload
        // is not a new occasion to ask.
        this.#setState('done');
        if (session.sweepOffer) this.#emitter.emit('sweepOffer', session.sweepOffer);
        this.#modal?.showSuccess({
          amountUi: result.amountUi,
          symbol: session.mintSymbol,
          explorerUrl: result.explorerUrl,
          kind: successKind(session.intent),
        });
        return result;
      }

      await this.#prepareWallets(session.cluster);
    } catch (error) {
      this.#fail(error);
      throw error;
    }

    if (!this.#usesModal()) {
      this.#setState('selecting');
      return null;
    }

    // The modal drives the rest; resolve when the flow finishes or is dismissed.
    return new Promise<CompleteResponse | null>((resolve, reject) => {
      this.#flow = { resolve, reject };
      this.#showPicker();
    });
  }

  async connect(entry?: DiscoveredWallet): Promise<{ publicKey: string; walletName: string }> {
    const session = this.#session;
    if (!session) throw new DisdkError('SESSION_NOT_FOUND', 'Load a session before connecting.');

    const target = entry ?? this.#wallets[0];
    if (!target) {
      throw new DisdkError('NO_WALLET_FOUND', 'No Solana wallet is available in this browser.');
    }

    this.#setState('connecting');
    this.#modal?.showConnecting(target.name);

    const account = await connectWallet(target, session.cluster);
    this.#selected = target;
    this.#account = account;

    const payload = { publicKey: account.address, walletName: target.name };
    this.#setState('connected');
    this.#emitter.emit('connect', payload);
    return payload;
  }

  async requestPermit(): Promise<CompleteResponse> {
    const session = this.#session;
    const account = this.#account;
    const entry = this.#selected;

    if (!session || !account || !entry) {
      throw new DisdkError('INVALID_REQUEST', 'Connect a wallet before requesting a permit.');
    }

    this.#setState('reviewing');
    const leg = session.intent === 'sweep' ? (session.sweep?.leg ?? 'transfer') : undefined;
    this.#sweepTransfer = null;

    // A user-priced charge has no amount yet: the payer names it here, before
    // anything is issued or signed. Every other flow already knows its amount.
    const chargeAmount =
      session.intent === 'charge' && session.charge?.userPriced
        ? await this.#promptChargeAmount(session)
        : undefined;

    const issued = await this.#api.connect(session.sessionId, account.address, leg, chargeAmount);

    // Check the server's claim against the transaction it actually sent. The
    // amount shown to the user comes from these bytes, so a server that lies in
    // its JSON cannot get a larger allowance signed than the one displayed.
    const review =
      session.intent === 'sweep'
        ? reviewSweep(session, account.address, entry.name, issued)
        : session.intent === 'charge'
          ? reviewCharge(session, account.address, entry.name, issued)
          : reviewPermit(session, account.address, entry.name, issued);

    this.#pending = issued;

    if (this.#usesModal()) {
      this.#modal?.showReview(review);
      // The modal resolves this leg when the user presses Approve. For a sweep
      // this promise spans both legs, so declining the close leg lands on the
      // completed transfer instead of reading as a rejected sweep.
      return new Promise<CompleteResponse>((resolve, reject) => {
        this.#flow = {
          resolve: (value) => {
            // Falls back through everything that has actually succeeded, newest
            // first. A landed permit counts: once the sweep offer is on screen,
            // dismissing the modal is an answer to the offer, not a rejection of
            // the allowance that was already granted.
            const settled = value ?? this.#sweepTransfer ?? this.#permitResult;
            if (settled) resolve(settled);
            else reject(new DisdkError('WALLET_REJECTED', 'Cancelled.'));
          },
          reject,
        };
      });
    }

    const result = await this.#sign();
    if (!result) throw new DisdkError('INVALID_REQUEST', 'Nothing to sign.');
    return result;
  }

  /**
   * Put the amount-entry screen up and resolve with the payer's choice, in base
   * units. Rejects as a cancellation if they back out — handled exactly like a
   * declined signature, since nothing has been issued yet.
   *
   * Requires the modal UI: a headless integration prices the charge itself and
   * would never reach here with a user-priced session.
   */
  #promptChargeAmount(session: SessionPublic): Promise<string> {
    const modal = this.#modal;
    if (!this.#usesModal() || !modal) {
      return Promise.reject(
        new DisdkError(
          'INVALID_REQUEST',
          'A user-priced charge needs an amount, which only the modal UI can collect.',
        ),
      );
    }

    return new Promise<string>((resolve, reject) => {
      modal.showAmountEntry(
        {
          symbol: session.mintSymbol,
          decimals: session.decimals,
          treasury: session.charge?.treasury ?? '',
          maxAmount: session.charge?.maxAmount ? BigInt(session.charge.maxAmount) : undefined,
          description: session.charge?.description,
        },
        {
          onSubmit: (baseUnits) => resolve(baseUnits),
          onCancel: () => {
            this.#cancel();
            reject(new DisdkError('WALLET_REJECTED', 'Cancelled.'));
          },
        },
      );
    });
  }

  /**
   * Turn a sweep offer into a session a transfer can be built for.
   *
   * Order matters and is not incidental. The consent goes to the server first,
   * on its own, and only once it has been recorded does the session become one
   * the server will issue a sweep against — so a sweep transaction can never
   * exist ahead of the answer that permits it, not even briefly and not even if
   * this method throws halfway through.
   */
  async authorizeSweep(): Promise<CompleteResponse> {
    const session = this.#session;
    if (!session) {
      throw new DisdkError('SESSION_NOT_FOUND', 'Load a session before authorizing a transfer.');
    }
    if (!this.#account || !this.#selected) {
      // The server pins a sweep to the wallet that signed the permit, so there
      // is no useful way to authorize one from a page that has forgotten which
      // wallet that was. Saying so beats recording a consent the transfer would
      // then be refused against.
      throw new DisdkError(
        'INVALID_REQUEST',
        'Connect the wallet that approved the allowance before authorizing a transfer.',
      );
    }

    this.#setState('loading');
    this.#modal?.showLoading('Preparing the transfer…');

    await this.#api.authorizeSweep(session.sessionId);

    // Re-read rather than patched locally: the session's intent, leg and policy
    // are the server's to state, and the review screen is built from them.
    const refreshed = await this.#api.getSession(session.sessionId);
    this.#session = refreshed;
    this.#emitter.emit('session', refreshed);
    this.#modal?.setSession(refreshed);

    return this.requestPermit();
  }

  async disconnect(): Promise<void> {
    if (this.#selected) await disconnectWallet(this.#selected);
    this.#selected = null;
    this.#account = null;
    this.#pending = null;
    this.#setState('idle');
    this.#emitter.emit('disconnect', undefined);
  }

  close(): void {
    this.#modal?.close();
    this.#unwatch?.();
    this.#unwatch = null;
    this.#flow?.resolve(null);
    this.#flow = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #sessionId(): string | null {
    return this.#config.sessionId ?? readSessionIdFromUrl(this.#config.sessionParam ?? 'ds');
  }

  #usesModal(): boolean {
    return (this.#config.ui ?? 'modal') === 'modal';
  }

  #ensureModal(): DisdkModal {
    if (!this.#modal) {
      this.#modal = new DisdkModal(
        {
          onSelectWallet: (entry) => void this.#runFromWallet(entry),
          onApprove: () => void this.#approve(),
          onCancel: () => this.#cancel(),
          onRetry: () => void this.#retry(),
        },
        this.#config.theme ?? 'auto',
      );
      if (this.#session) this.#modal.setSession(this.#session);
    }
    return this.#modal;
  }

  async #prepareWallets(cluster: Cluster): Promise<void> {
    const session = this.#session;
    if (this.#environment.platform === 'android' || this.#config.remoteHostAuthority) {
      // Puts Android wallets (and optionally a desktop QR flow) into the same
      // list as browser extensions.
      await registerMobileWalletAdapter({
        appName: session?.app.name ?? 'disdk',
        appUri: session?.app.uri ?? (typeof window === 'undefined' ? '' : window.location.origin),
        appIcon: session?.app.iconUrl,
        chain: cluster,
        remoteHostAuthority: this.#config.remoteHostAuthority,
      });
    }

    this.#wallets = listWallets(cluster);
    this.#unwatch?.();
    this.#unwatch = watchWallets(cluster, (wallets) => {
      this.#wallets = wallets;
      this.#emitter.emit('wallets', wallets);
      // Wallets can register after first paint; refresh the list if it is showing.
      if (this.#state === 'selecting') this.#showPicker();
    });
  }

  #showPicker(): void {
    this.#setState('selecting');
    this.#modal?.showWallets(this.#wallets, this.escapeRoute());
  }

  async #runFromWallet(entry: DiscoveredWallet): Promise<void> {
    try {
      await this.connect(entry);
      await this.requestPermit();
    } catch (error) {
      this.#fail(error);
    }
  }

  async #approve(): Promise<void> {
    try {
      const result = await this.#sign();
      // `null` means another leg is now on screen awaiting its own approval.
      // Leave the flow open so it resolves once, at the end of the last leg.
      if (result === null) return;
      this.#flow?.resolve(result);
      this.#flow = null;
    } catch (error) {
      this.#fail(error);
    }
  }

  async #sign(): Promise<CompleteResponse | null> {
    const session = this.#session;
    const entry = this.#selected;
    const account = this.#account;
    const issued = this.#pending;

    if (!session || !entry || !account || !issued) {
      throw new DisdkError('INVALID_REQUEST', 'Nothing to sign.');
    }

    this.#setState('permitting');
    this.#modal?.showSigning(entry.name);

    const outcome = await signSponsoredTransaction({
      entry,
      account,
      chain: session.cluster,
      transactionBase64: issued.transaction,
    });

    this.#modal?.showSubmitting();

    const result =
      outcome.mode === 'sent'
        ? await this.#api.confirm(session.sessionId, outcome.signature)
        : await this.#api.submit(session.sessionId, outcome.signedTransaction);

    // A sweep is deliberately two transactions. The server keeps the session
    // open for the close leg, but nothing used to ask for it — the operator saw
    // "success" after the transfer and the rent was never reclaimed.
    if (session.intent === 'sweep' && issued.sweep?.nextLeg === 'close') {
      this.#sweepTransfer = result;
      if (await this.#offerSweepClose()) return null;
    }

    // The sweep offer, which the server attaches to a permit the moment it
    // lands. Everything below puts a question on a screen and stops there.
    //
    // Note what is absent: there is no branch here that continues into a sweep,
    // no timer, and no "if the user seems to want it". The next sweep-related
    // call in this file is authorizeSweep(), and the only things that reach it
    // are a button on the offer screen and an integrator's own deliberate call.
    const offer = result.sweepOffer;
    if (offer && session.intent !== 'sweep') {
      this.#emitter.emit('sweepOffer', offer);
      if (this.#usesModal()) {
        this.#showSweepOffer(result, offer);
        // The flow stays open. The permit has succeeded, but a question is in
        // front of the user and the flow settles on their answer, not before.
        return null;
      }
    }

    return this.#finish(result);
  }

  /** Put the offer on screen and wait. Does nothing else, by design. */
  #showSweepOffer(permit: CompleteResponse, offer: SweepOfferPublic): void {
    this.#permitResult = permit;
    this.#sweepOffer = offer;
    this.#setState('offering');

    this.#modal?.showSweepOffer(
      {
        permitAmountUi: permit.amountUi,
        symbol: this.#session?.mintSymbol ?? '',
        explorerUrl: permit.explorerUrl,
        description: offer.description,
        destination: offer.destination,
        rentDestination: offer.rentDestination,
      },
      {
        onAccept: () => void this.#acceptSweepOffer(),
        onDecline: () => this.#declineSweepOffer(),
      },
    );
  }

  async #acceptSweepOffer(): Promise<void> {
    try {
      await this.authorizeSweep();
    } catch (error) {
      this.#fail(error);
    }
  }

  /**
   * Answer the offer with no.
   *
   * Lands on the permit that already succeeded rather than on a cancellation:
   * declining an extra is not a failure of the thing the user came to do, and
   * reporting it as one would tell them their allowance had not been granted
   * when it had.
   *
   * `dismiss` distinguishes the two ways of saying no. The button leaves the
   * success screen up, because the user is still reading; closing the modal
   * takes them at their word and shuts it.
   */
  #declineSweepOffer(dismiss = false): void {
    const permit = this.#permitResult;
    if (!permit) return;

    const settled = this.#finish(permit);

    if (dismiss) {
      this.#modal?.close();
      this.#unwatch?.();
      this.#unwatch = null;
    }

    const flow = this.#flow;
    this.#flow = null;
    flow?.resolve(settled);
  }

  /**
   * Land the flow on success. A completed sweep transfer outranks the result
   * passed in, so a close leg that was skipped, declined, or retried to
   * exhaustion still reports the transfer that actually moved the money.
   */
  #finish(result: CompleteResponse): CompleteResponse {
    const session = this.#session;
    const settled = this.#sweepTransfer ?? result;
    this.#sweepTransfer = null;
    // An offer that is still pending here has been answered by getting this far,
    // one way or the other. Clearing it keeps a stale question from being
    // re-shown by a later retry.
    this.#sweepOffer = null;
    this.#permitResult = null;

    this.#setState('done');
    this.#emitter.emit('permit', settled);
    this.#emitter.emit('done', settled);
    this.#modal?.showSuccess({
      amountUi: settled.amountUi,
      symbol: session?.mintSymbol ?? '',
      explorerUrl: settled.explorerUrl,
      kind: successKind(session?.intent ?? 'permit'),
    });
    return settled;
  }

  /** Finish a sweep on its transfer leg, when the close leg cannot proceed. */
  #finishSweep(): void {
    const transfer = this.#sweepTransfer;
    if (!transfer) return;
    const settled = this.#finish(transfer);
    this.#flow?.resolve(settled);
    this.#flow = null;
  }

  /**
   * Put the close leg on screen after a completed transfer. Returns true when it
   * is now awaiting the user, false when the sweep should simply finish.
   *
   * Best-effort on purpose: the transfer has already moved the money and cannot
   * be undone, so a wallet with nothing left to close — or any failure to build
   * the leg at all — ends as the success it is, rather than showing a red error
   * on top of a transfer that worked.
   */
  async #offerSweepClose(): Promise<boolean> {
    const session = this.#session;
    const account = this.#account;
    const entry = this.#selected;
    if (!session || !account || !entry) return false;

    let issued: ConnectResponse;
    try {
      this.#setState('reviewing');
      issued = await this.#api.connect(session.sessionId, account.address, 'close');
    } catch {
      return false;
    }

    let review: ReviewDetails;
    try {
      review = reviewSweep(session, account.address, entry.name, issued);
    } catch (error) {
      // A close leg whose bytes do not match the claim is not best-effort —
      // refusing to sign is the whole point of txguard.
      throw error;
    }

    this.#pending = issued;

    if (!this.#usesModal()) {
      await this.#sign();
      return false;
    }

    this.#modal?.showReview(review);
    return true;
  }

  async #retry(): Promise<void> {
    this.#pending = null;

    if (!this.#selected || !this.#account) {
      this.#showPicker();
      return;
    }

    try {
      // An authorization that failed leaves the permit landed and the session
      // still a permit session. Retrying has to put the question back rather
      // than run requestPermit(), which would build a second allowance for
      // someone who was answering a question about a transfer.
      if (this.#permitResult && this.#sweepOffer && this.#session?.intent !== 'sweep') {
        this.#showSweepOffer(this.#permitResult, this.#sweepOffer);
        return;
      }

      // A landed transfer means the failure being retried was the *close* leg.
      // requestPermit() would derive the leg from the cached session, which is
      // still frozen at 'transfer' from page load — so "Try again" after a
      // close-leg timeout would quietly build a second transfer and move funds
      // again. Retry the leg that actually failed.
      if (this.#sweepTransfer) {
        if (!(await this.#offerSweepClose())) this.#finishSweep();
        return;
      }

      await this.requestPermit();
    } catch (error) {
      this.#fail(error);
    }
  }

  #cancel(): void {
    // Closing, Escape, or a click on the backdrop, while the offer is up. That
    // is an answer to the offer — no — and it must settle on the permit that
    // already succeeded rather than read as a cancelled flow.
    if (this.#state === 'offering' && this.#permitResult) {
      this.#declineSweepOffer(true);
      return;
    }

    this.#modal?.close();
    this.#unwatch?.();
    this.#unwatch = null;
    const flow = this.#flow;
    this.#flow = null;
    if (this.#state !== 'done') this.#setState('idle');
    flow?.resolve(null);
  }

  #fail(error: unknown): void {
    const wrapped =
      error instanceof DisdkError
        ? error
        : new DisdkError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));

    this.#setState('error');
    this.#emitter.emit('error', wrapped);
    this.#modal?.showError(wrapped.message, wrapped.retryable || wrapped.code === 'TRANSACTION_EXPIRED');
  }

  #setState(state: DisdkState): void {
    this.#state = state;
    this.#emitter.emit('state', state);
  }
}

// ---------------------------------------------------------------------------
// Review construction
// ---------------------------------------------------------------------------
//
// Both of these verify the server's JSON against the transaction bytes before
// anything reaches the screen. Whatever the server claims in `issued`, the
// numbers and addresses the user sees are the ones actually encoded.

function reviewPermit(
  session: SessionPublic,
  owner: string,
  walletName: string,
  issued: ConnectResponse,
): ReviewDetails {
  const feePayerRole = assertFeePayerAllowed(issued, session.sponsor, owner);
  const verified = verifyPermitTransaction(issued.transaction, {
    feePayer: issued.feePayer,
    owner,
    mint: session.mint,
    delegate: session.delegate,
    amount: BigInt(issued.amount),
    decimals: session.decimals,
  });

  return {
    amount: verified.amount,
    decimals: session.decimals,
    symbol: session.mintSymbol,
    delegate: verified.delegate,
    walletName,
    publicKey: owner,
    createsAccount: verified.createsAccount,
    isUnlimited: verified.amount >= U64_MAX,
    feePayerRole,
  };
}

function reviewSweep(
  session: SessionPublic,
  owner: string,
  walletName: string,
  issued: ConnectResponse,
): ReviewDetails {
  const feePayerRole = assertFeePayerAllowed(issued, session.sponsor, owner);
  const claim = issued.sweep;
  if (!claim) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'The server did not describe this sweep.');
  }

  const base = {
    decimals: session.decimals,
    symbol: session.mintSymbol,
    delegate: session.delegate,
    walletName,
    publicKey: owner,
    isUnlimited: false,
    feePayerRole,
  };

  if (claim.leg === 'close') {
    const verified = verifySweepClose(issued.transaction, {
      feePayer: issued.feePayer,
      owner,
      rentTo: claim.rentTo,
      accounts: claim.accounts,
      maxAccounts: claim.maxAccounts,
    });

    return {
      ...base,
      amount: 0n,
      createsAccount: false,
      sweep: {
        leg: 'close',
        destination: claim.destination,
        closeCount: verified.accounts.length,
        rentTo: verified.rentTo,
      },
    };
  }

  const verified = verifySweepTransfer(issued.transaction, {
    feePayer: issued.feePayer,
    owner,
    mint: session.mint,
    destination: claim.destination,
    amount: BigInt(issued.amount),
    decimals: session.decimals,
  });

  return {
    ...base,
    amount: verified.amount,
    createsAccount: verified.createsAccount,
    sweep: {
      leg: 'transfer',
      destination: verified.destination,
      closeCount: 0,
      rentTo: claim.rentTo,
    },
  };
}

function reviewCharge(
  session: SessionPublic,
  owner: string,
  walletName: string,
  issued: ConnectResponse,
): ReviewDetails {
  const feePayerRole = assertFeePayerAllowed(issued, session.sponsor, owner);
  const claim = issued.charge;
  if (!claim) {
    throw new DisdkError('UNSAFE_TRANSACTION', 'The server did not describe this charge.');
  }

  // The price is pinned to the session, not to this response. A server that
  // quotes one amount in the session the user was shown and issues a larger one
  // at connect time fails here, before the wallet is ever opened.
  const quoted = session.charge?.amount;
  if (quoted !== undefined && quoted !== issued.amount) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'The amount being charged does not match the amount this link was created for.',
    );
  }

  const verified = verifyChargeTransfer(issued.transaction, {
    feePayer: issued.feePayer,
    owner,
    mint: session.mint,
    destination: claim.destination,
    amount: BigInt(issued.amount),
    decimals: session.decimals,
  });

  return {
    amount: verified.amount,
    decimals: session.decimals,
    symbol: session.mintSymbol,
    delegate: session.delegate,
    walletName,
    publicKey: owner,
    createsAccount: verified.createsAccount,
    isUnlimited: false,
    feePayerRole,
    charge: {
      destination: verified.destination,
      treasury: claim.treasury,
      description: claim.description ?? session.charge?.description,
      reference: claim.reference ?? session.charge?.reference,
    },
  };
}

/** Which success copy applies. See {@link SuccessDetails.kind}. */
function successKind(intent: SessionPublic['intent']): 'permit' | 'sweep' | 'charge' {
  if (intent === 'sweep') return 'sweep';
  if (intent === 'charge') return 'charge';
  return 'permit';
}
