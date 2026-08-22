import {
  DisdkError,
  formatTokenAmount,
  type CompleteResponse,
  type Cluster,
  type ConnectResponse,
  type SessionPublic,
  type SettlementCompleteResponse,
  type SettlementConnectResponse,
} from '@disdk/protocol';
import { DisdkApi } from './api.js';
import { Emitter, type DisdkEventMap, type DisdkState } from './events.js';
import { detectEnvironment, type Environment } from './environment.js';
import { planEscape, type EscapeRoute } from './deeplinks.js';
import {
  assertFeePayerAllowed,
  inspectTransaction,
  verifyChargeTransaction,
  verifySettlementTransaction,
} from './txguard.js';
import { resolveChainFacts } from './resolve.js';
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
import {
  DisdkModal,
  type ReviewDetails,
  type SettlementReviewDetails,
  type Theme,
} from './ui/modal.js';

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
  /**
   * A Solana RPC endpoint, used only to check a batch settlement against the
   * chain before signing it — the contents of any lookup table it uses, and who
   * the destination token accounts actually belong to.
   *
   * Required for {@link Disdk.settleBatch}, and for that alone. The charge flow
   * needs no RPC because a charge names every account in the message, where the
   * bytes are the whole story.
   */
  rpcUrl?: string;
}

export interface Disdk {
  readonly state: DisdkState;
  readonly session: SessionPublic | null;
  readonly publicKey: string | null;
  start(): Promise<CompleteResponse | null>;
  connect(entry?: DiscoveredWallet): Promise<{ publicKey: string; walletName: string }>;
  /**
   * Put the payment up for review and, once the user approves it, sign and
   * settle it.
   *
   * The whole flow, and the only one. It grants no allowance and leaves nothing
   * standing behind it — the transaction the user signs is the entire
   * authorization, and it is spent on use.
   */
  pay(): Promise<CompleteResponse>;
  /**
   * Put a batch settlement up for review and, once the user approves it, sign
   * and settle it with one signature.
   *
   * The same bargain as {@link pay}, over a list: the transaction is the entire
   * authorization, it grants no allowance, and nothing outlives it. Every
   * transfer in it corresponds to an obligation the user was shown, and the
   * correspondence is re-derived here from the transaction bytes before a
   * wallet is asked for anything.
   */
  settleBatch(): Promise<SettlementCompleteResponse>;
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
  #pendingSettlement: SettlementConnectResponse | null = null;

  #flow: { resolve(value: CompleteResponse | null): void; reject(error: unknown): void } | null = null;
  #settlementFlow: {
    resolve(value: SettlementCompleteResponse | null): void;
    reject(error: unknown): void;
  } | null = null;

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
    const element =
      typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
    if (!element) return () => {};

    const handler = (event: Event) => {
      event.preventDefault();
      void this.start();
    };
    element.addEventListener('click', handler);
    return () => element.removeEventListener('click', handler);
  }

  async start(): Promise<CompleteResponse | null> {
    const sessionId = this.#sessionId();
    if (!sessionId) {
      const error = new DisdkError(
        'SESSION_NOT_FOUND',
        'No payment link found. Run /connect in Discord to get one.',
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
          amount: session.paidAmount ?? '0',
          amountUi: session.paidAmount ?? '0',
          explorerUrl: '',
        };

        this.#setState('done');
        this.#modal?.showSuccess({
          amountUi: result.amountUi,
          symbol: session.mintSymbol,
          explorerUrl: result.explorerUrl,
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

  async pay(): Promise<CompleteResponse> {
    const session = this.#session;
    const account = this.#account;
    const entry = this.#selected;

    if (!session || !account || !entry) {
      throw new DisdkError('INVALID_REQUEST', 'Connect a wallet before paying.');
    }

    this.#setState('reviewing');
    // No amount travels from here. A merchant-priced charge settled its figure
    // before the link existed; a balance share resolves against the balance the
    // server reads for this wallet. Either way the number the payer sees is
    // decoded from the bytes below, never taken from the JSON beside them.
    const issued = await this.#api.connect(session.sessionId, account.address);

    // Check the server's claim against the transaction it actually sent. The
    // amount shown to the user comes from these bytes, so a server that lies in
    // its JSON cannot get a larger transfer signed than the one displayed.
    const review = reviewCharge(session, account.address, entry.name, issued);

    this.#pending = issued;

    if (this.#usesModal()) {
      this.#modal?.showReview(review);
      // The modal resolves this once the user presses Pay.
      return new Promise<CompleteResponse>((resolve, reject) => {
        this.#flow = {
          resolve: (value) => {
            if (value) resolve(value);
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

  async settleBatch(): Promise<SettlementCompleteResponse> {
    const session = this.#session;
    const account = this.#account;
    const entry = this.#selected;

    // The configuration is checked before the wallet, so a deployment that
    // forgot the RPC finds out on the first call rather than at the moment a
    // user has already connected. Refused rather than degraded: without an RPC
    // the SDK cannot read a lookup table or confirm who a destination token
    // account belongs to, and a settlement it cannot check is one it must not
    // present as checked.
    if (!this.#config.rpcUrl) {
      throw new DisdkError(
        'INVALID_REQUEST',
        'settleBatch needs an rpcUrl so the settlement can be checked against the chain before signing.',
      );
    }
    if (!session || !account || !entry) {
      throw new DisdkError('INVALID_REQUEST', 'Connect a wallet before settling.');
    }

    this.#setState('reviewing');
    const issued = await this.#api.connectSettlement(session.sessionId, account.address);

    const review = await this.#reviewSettlement(session, account.address, entry.name, issued);
    this.#pendingSettlement = issued;

    if (this.#usesModal()) {
      this.#modal?.showSettlementReview(review);
      return new Promise<SettlementCompleteResponse>((resolve, reject) => {
        this.#settlementFlow = {
          resolve: (value) => {
            if (value) resolve(value);
            else reject(new DisdkError('WALLET_REJECTED', 'Cancelled.'));
          },
          reject,
        };
      });
    }

    const result = await this.#signSettlement();
    if (!result) throw new DisdkError('INVALID_REQUEST', 'Nothing to sign.');
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.#selected) await disconnectWallet(this.#selected);
    this.#selected = null;
    this.#account = null;
    this.#pending = null;
    this.#pendingSettlement = null;
    this.#setState('idle');
    this.#emitter.emit('disconnect', undefined);
  }

  close(): void {
    this.#modal?.close();
    this.#unwatch?.();
    this.#unwatch = null;
    this.#flow?.resolve(null);
    this.#flow = null;
    this.#settlementFlow?.resolve(null);
    this.#settlementFlow = null;
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
      await this.pay();
    } catch (error) {
      this.#fail(error);
    }
  }

  async #approve(): Promise<void> {
    try {
      // One approve button, two flows behind it. Which one is live is decided
      // by what was issued, not by a mode flag that could disagree with it.
      if (this.#pendingSettlement) {
        const settled = await this.#signSettlement();
        if (settled === null) return;
        this.#settlementFlow?.resolve(settled);
        this.#settlementFlow = null;
        return;
      }

      const result = await this.#sign();
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

    this.#setState('paying');
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

    return this.#finish(result);
  }

  /**
   * Check the issued settlement against the chain and against its own manifest,
   * before anything is shown to the user or handed to a wallet.
   *
   * Three separate questions, none of which the server gets to answer for
   * itself: is the fee payer one of the two accounts it may be; do the lookup
   * tables and destination accounts hold what the transaction implies; and do
   * the transfers in the bytes correspond exactly to the obligations on screen.
   */
  async #reviewSettlement(
    session: SessionPublic,
    owner: string,
    walletName: string,
    issued: SettlementConnectResponse,
  ): Promise<SettlementReviewDetails> {
    const feePayerRole = assertFeePayerAllowed(issued, session.sponsor, owner);
    const manifest = issued.manifest;

    if (manifest.owner !== owner) {
      throw new DisdkError(
        'SETTLEMENT_MISMATCH',
        'This settlement was prepared for a different wallet.',
      );
    }
    if (Date.parse(manifest.expiresAt) <= Date.now()) {
      throw new DisdkError('SETTLEMENT_EXPIRED', 'This settlement has expired. Start again.');
    }

    const rpcUrl = this.#config.rpcUrl as string;

    // The tables come first, and on their own. Nothing in the transaction can
    // be read until they are: an instruction that names an account by index
    // into a table is unreadable without that table's contents, so there is no
    // earlier point at which the destinations could be picked out.
    const { lookupTables } = await resolveChainFacts({
      rpcUrl,
      lookupTables: issued.addressLookupTables,
      candidates: {},
      destination: manifest.destination,
    });

    // Now the transaction can be read. The destination each transfer credits is
    // taken from the bytes and then checked on chain — reading it here is not
    // trusting it, because `verifySettlementTransaction` below requires the
    // transfer to credit exactly the account confirmed to belong to the
    // destination wallet.
    const inspection = inspectTransaction(
      issued.transaction,
      (table) => lookupTables[table],
    );
    const candidates: Record<string, string> = {};
    for (const transfer of inspection.transfers) {
      if (transfer.mint) candidates[transfer.mint] = transfer.destination;
    }

    const { destinationAccounts } = await resolveChainFacts({
      rpcUrl,
      lookupTables: [],
      candidates,
      destination: manifest.destination,
    });

    const verified = verifySettlementTransaction(issued.transaction, {
      feePayer: issued.feePayer,
      owner,
      destination: manifest.destination,
      obligations: manifest.obligations,
      lookupTables,
      destinationAccounts,
    });

    return {
      lines: verified.transfers.map(({ obligation, amount }) => ({
        symbol: obligation.type === 'sol' ? 'SOL' : SHORT_MINT(obligation.mint),
        amountUi: formatTokenAmount(amount, obligation.type === 'sol' ? 9 : obligation.decimals),
      })),
      destination: manifest.destination,
      walletName,
      publicKey: owner,
      createsAccount: verified.createsAccount,
      feePayerRole,
      lookupTables: verified.lookupTables,
      description: issued.description,
      reference: issued.reference,
    };
  }

  async #signSettlement(): Promise<SettlementCompleteResponse | null> {
    const session = this.#session;
    const entry = this.#selected;
    const account = this.#account;
    const issued = this.#pendingSettlement;

    if (!session || !entry || !account || !issued) {
      throw new DisdkError('INVALID_REQUEST', 'Nothing to sign.');
    }

    this.#setState('paying');
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
        ? await this.#api.confirmSettlement(session.sessionId, outcome.signature)
        : await this.#api.submitSettlement(session.sessionId, outcome.signedTransaction);

    this.#setState('done');
    this.#modal?.showSuccess({
      amountUi: result.settled.map((s) => s.amountUi).join(' · '),
      symbol: '',
      explorerUrl: result.explorerUrl,
    });
    return result;
  }

  #finish(result: CompleteResponse): CompleteResponse {
    const session = this.#session;

    this.#setState('done');
    this.#emitter.emit('done', result);
    this.#modal?.showSuccess({
      amountUi: result.amountUi,
      symbol: session?.mintSymbol ?? '',
      explorerUrl: result.explorerUrl,
    });
    return result;
  }

  async #retry(): Promise<void> {
    this.#pending = null;

    if (!this.#selected || !this.#account) {
      this.#showPicker();
      return;
    }

    try {
      await this.pay();
    } catch (error) {
      this.#fail(error);
    }
  }

  #cancel(): void {
    this.#modal?.close();
    this.#unwatch?.();
    this.#unwatch = null;
    const flow = this.#flow;
    const settlementFlow = this.#settlementFlow;
    this.#flow = null;
    this.#settlementFlow = null;
    if (this.#state !== 'done') this.#setState('idle');
    flow?.resolve(null);
    settlementFlow?.resolve(null);
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

/**
 * Verify the server's JSON against the transaction bytes before anything
 * reaches the screen. Whatever the server claims in `issued`, the numbers and
 * addresses the user sees are the ones actually encoded.
 */
/**
 * A mint address, shortened for a review row.
 *
 * A settlement may name any mint, and this bundle carries no token registry to
 * turn one into a ticker. Showing the address is honest about that; inventing a
 * symbol from an untrusted source would be worse than showing none, since a
 * label is exactly what a reader would rely on.
 */
function SHORT_MINT(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
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
    throw new DisdkError('UNSAFE_TRANSACTION', 'The server did not describe this payment.');
  }

  // The price is pinned to the session, not to this response. A server that
  // quotes one amount in the session the user was shown and issues a larger one
  // at connect time fails here, before the wallet is ever opened.
  const quoted = session.charge.amount;
  if (quoted !== undefined && quoted !== issued.amount) {
    throw new DisdkError(
      'UNSAFE_TRANSACTION',
      'The amount being charged does not match the amount this link was created for.',
    );
  }

  const verified = verifyChargeTransaction(issued.transaction, {
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
    walletName,
    publicKey: owner,
    createsAccount: verified.createsAccount,
    feePayerRole,
    // Carried through so the screen can say where the figure came from. On a
    // balance share nobody named a price, and a number with no stated origin is
    // the one thing a payment screen must not show.
    ...(session.charge.share
      ? {
          share: {
            percent: session.charge.share.percent,
            maxAmount: BigInt(session.charge.share.maxAmount),
          },
        }
      : {}),
    charge: {
      destination: verified.destination,
      treasury: claim.treasury,
      description: claim.description ?? session.charge.description,
      reference: claim.reference ?? session.charge.reference,
    },
  };
}
