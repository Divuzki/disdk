import { formatTokenAmount, type FeePayerRole, type SessionPublic } from '@disdk/protocol';
import type { DiscoveredWallet } from '../wallets.js';
import type { EscapeRoute } from '../deeplinks.js';
import { suggestableWallets } from '../catalog.js';
import { MODAL_CSS } from './styles.js';

export type Theme = 'auto' | 'light' | 'dark';

export interface ReviewDetails {
  /** Read out of the transaction bytes, not from the server's JSON. */
  amount: bigint;
  decimals: number;
  symbol: string;
  walletName: string;
  publicKey: string;
  createsAccount: boolean;
  /**
   * Who pays the network fee. Shown plainly, because "paid for you" is the
   * promise this SDK makes and a fallback to the user paying is a change to
   * that promise, not a detail.
   */
  feePayerRole?: FeePayerRole;
  /**
   * Present when the amount is a share of the payer's balance rather than a
   * price someone set. The screen says so: a figure nobody named, shown with no
   * account of where it came from, is indistinguishable from an arbitrary one.
   */
  share?: { percent: number; maxAmount: bigint };
  charge: ChargeReviewDetails;
}

export interface ChargeReviewDetails {
  /** Treasury token account, read out of the bytes. */
  destination: string;
  /** Treasury wallet that owns it, for display. */
  treasury: string;
  /** What the user is paying for. */
  description?: string;
  reference?: string;
}

export interface SuccessDetails {
  amountUi: string;
  symbol: string;
  explorerUrl: string;
}

export interface ModalCallbacks {
  onSelectWallet(entry: DiscoveredWallet): void;
  onApprove(): void;
  onCancel(): void;
  onRetry(): void;
}

/**
 * One row in the flat wallet picker: either connectable now (`run`, from a
 * discovered wallet) or only catalogued (`href`, an install link). The two
 * shapes never mix on one row, which is what lets `'run' in row` tell them
 * apart cleanly instead of a boolean flag next to data that contradicts it.
 */
type PickerRow =
  | { name: string; searchName?: string; icon: string | null; run: () => void }
  | { name: string; searchName?: string; icon: string | null; href: string };

/**
 * What the fee row says. The fallback case names a number because "you pay the
 * fee" invites the reader to imagine a large one — it is a signature's worth of
 * SOL, and saying so is the difference between a disclosure and a scare.
 */
function feeNote(role: FeePayerRole | undefined): string {
  return role === 'owner' ? 'You pay it (about 0.000005 SOL)' : 'Paid for you';
}

/**
 * What the account-creation hint says.
 *
 * Rent follows the fee payer, so under the fallback this is the user's
 * 2,039,280 lamports — four hundred times the fee row above it, and much the
 * largest number on the screen. "At no cost to you" is true only while the
 * sponsor is paying, and printing it in the other case would be a lie about the
 * one figure the reader would most want to know.
 */
function rentNote(role: FeePayerRole | undefined): string {
  return role === 'owner'
    ? 'A token account will be created for you. You pay its rent, about 0.00204 SOL, which comes back to you if the account is ever closed.'
    : 'A token account will be created for you, at no cost to you.';
}

/**
 * Whether the network fee and the account rent cost this user anything.
 *
 * This is what decides where they belong on the screen. When the sponsor pays
 * they are housekeeping and sit under Details; when the fallback has moved them
 * onto the user they are a cost, and a cost is never something the reader should
 * have to open a disclosure to find.
 */
function userBearsCost(role: FeePayerRole | undefined): boolean {
  return role === 'owner';
}

/**
 * Where the figure came from, in one line, when nobody set a price.
 *
 * The percentage is stated before the cap because the cap is almost never what
 * bit: for all but the largest balances the amount above is simply a share of
 * what the reader holds, and that is the fact that lets them check it.
 */
function shareNote(
  share: { percent: number; maxAmount: bigint },
  symbol: string,
  decimals: number,
): string {
  const percent = `${Number((share.percent * 100).toFixed(2))}%`;
  const cap = `${formatTokenAmount(share.maxAmount, decimals)} ${symbol}`;
  return `That is ${percent} of your ${symbol} balance, capped at ${cap} — this checkout is priced from your balance, not by a price someone set.`;
}

const SHORT = (value: string, lead = 4, tail = 4) =>
  value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;

/** Only render image sources we are willing to load. */
function safeIcon(icon: string | undefined): string | null {
  if (!icon) return null;
  return /^(data:image\/|https:\/\/)/i.test(icon) ? icon : null;
}

export class DisdkModal {
  readonly #host: HTMLElement;
  readonly #root: ShadowRoot;
  #overlay: HTMLDivElement | null = null;
  #body: HTMLDivElement | null = null;
  #session: SessionPublic | null = null;
  #lastFocused: Element | null = null;
  #keyHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly callbacks: ModalCallbacks,
    theme: Theme = 'auto',
  ) {
    this.#host = document.createElement('div');
    this.#host.setAttribute('data-disdk-modal', '');
    if (theme !== 'auto') this.#host.setAttribute('data-theme', theme);
    this.#root = this.#host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = MODAL_CSS;
    this.#root.append(style);
  }

  setSession(session: SessionPublic): void {
    this.#session = session;
    this.#renderChrome();
  }

  open(): void {
    if (this.#overlay) return;
    this.#lastFocused = document.activeElement;
    document.body.append(this.#host);
    this.#renderChrome();

    this.#keyHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.callbacks.onCancel();
      } else if (event.key === 'Tab') {
        this.#trapFocus(event);
      }
    };
    document.addEventListener('keydown', this.#keyHandler, true);
  }

  close(): void {
    if (this.#keyHandler) {
      document.removeEventListener('keydown', this.#keyHandler, true);
      this.#keyHandler = null;
    }
    this.#host.remove();
    this.#overlay = null;
    this.#body = null;
    if (this.#lastFocused instanceof HTMLElement) this.#lastFocused.focus();
  }

  get isOpen(): boolean {
    return this.#overlay !== null;
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  showLoading(message = 'Loading…'): void {
    this.#setBody(this.#centered('spinner', message, ''));
  }

  showWallets(wallets: DiscoveredWallet[], escape: EscapeRoute): void {
    const fragment = document.createDocumentFragment();

    // A webview that cannot reach a wallet at all is a different problem from
    // "pick one" — the fix is leaving this browser, not searching a list of
    // wallets none of which are reachable from here — so it keeps its own
    // screen rather than folding into the picker below. A wallet the page did
    // still manage to find (unusual, but not impossible inside a webview) is
    // shown above it exactly as it would be anywhere else.
    if (escape.needed) {
      if (wallets.length > 0) {
        const list = el('ul', 'wallet-list');
        for (const entry of wallets) {
          const item = document.createElement('li');
          item.append(this.#walletButton({
            name: entry.name,
            icon: safeIcon(entry.icon),
            run: () => this.callbacks.onSelectWallet(entry),
          }));
          list.append(item);
        }
        fragment.append(list);
      }

      if (wallets.length === 0) {
        fragment.append(
          this.#note(
            'This browser cannot reach a wallet. Open this page in a wallet app to continue — your link will carry over.',
          ),
        );
      } else {
        fragment.append(el('p', 'hint', 'Or open this page in a wallet app:'));
      }

      const list = el('ul', 'wallet-list');
      for (const wallet of escape.wallets) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'wallet';
        link.href = wallet.url;
        link.rel = 'noopener noreferrer';
        link.append(text('span', `Open in ${wallet.name}`));
        link.append(el('span', 'chev', '›'));
        item.append(link);
        list.append(item);
      }
      if (escape.chromeIntent) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'wallet';
        link.href = escape.chromeIntent;
        link.append(text('span', 'Open in Chrome'));
        link.append(el('span', 'chev', '›'));
        item.append(link);
        list.append(item);
      }
      fragment.append(list);
      this.#setBody(fragment);
      return;
    }

    // One flat, searchable list: whatever this browser actually announced,
    // ranked first because it is immediately usable, followed by every
    // catalogued wallet it did not — each with a logo, none of it hidden
    // behind a fold. The picker above can only ever show what is *installed*,
    // so the second group is the only way a supported-but-absent wallet is
    // findable at all, and burying that behind a disclosure just relocates the
    // same "no wallets found" dead end one click deeper.
    const others = suggestableWallets(wallets.map((entry) => entry.name));

    if (wallets.length === 0) {
      fragment.append(
        this.#centered('', 'No Solana wallet found', 'Search below, or install one and reload this page.'),
      );
    }

    const rows: PickerRow[] = [
      ...wallets.map(
        (entry): PickerRow => ({
          name: entry.name,
          icon: safeIcon(entry.icon),
          run: () => this.callbacks.onSelectWallet(entry),
        }),
      ),
      ...others.map(
        (wallet): PickerRow => ({
          name: `Install ${wallet.name}`,
          searchName: wallet.name,
          icon: safeIcon(wallet.icon),
          href: wallet.install as string,
        }),
      ),
    ];

    const { node: picker, search } = this.#walletPicker(rows);
    fragment.append(picker);

    if (wallets.length === 0) {
      fragment.append(el('p', 'hint', 'Already installed? Unlock the extension, then reload.'));
    }

    this.#setBody(fragment, search);
  }

  /**
   * A search box over a flat wallet list. Filters by substring on `name`
   * (falling back to `searchName`, so "Install OKX Wallet" still matches a
   * search for "OKX"), case-insensitively, entirely client-side — the list
   * this filters is never long enough to need anything more than that.
   */
  #walletPicker(rows: readonly PickerRow[]): { node: HTMLElement; search: HTMLInputElement } {
    const container = el('div', 'wallet-picker');

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'wallet-search';
    search.placeholder = 'Search wallets';
    search.setAttribute('aria-label', 'Search wallets');
    search.autocomplete = 'off';
    container.append(search);

    const list = el('ul', 'wallet-list');
    const empty = el('p', 'hint', 'No wallet matches your search.');
    empty.hidden = true;

    for (const row of rows) {
      const item = document.createElement('li');
      item.dataset.name = (row.searchName ?? row.name).toLowerCase();
      item.append('run' in row ? this.#walletButton(row) : this.#walletLink(row));
      list.append(item);
    }

    container.append(list, empty);

    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      let visible = 0;
      for (const item of Array.from(list.children) as HTMLLIElement[]) {
        const match = (item.dataset.name ?? '').includes(query);
        item.hidden = !match;
        if (match) visible += 1;
      }
      empty.hidden = visible > 0;
    });

    return { node: container, search };
  }

  #walletButton(row: { name: string; icon: string | null; run: () => void }): HTMLButtonElement {
    const button = el('button', 'wallet') as HTMLButtonElement;
    button.type = 'button';
    if (row.icon) button.append(this.#walletIcon(row.icon));
    button.append(text('span', row.name));
    button.append(el('span', 'chev', '›'));
    button.addEventListener('click', row.run);
    return button;
  }

  #walletLink(row: { name: string; icon: string | null; href: string }): HTMLAnchorElement {
    const link = document.createElement('a');
    link.className = 'wallet';
    link.href = row.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (row.icon) link.append(this.#walletIcon(row.icon));
    link.append(text('span', row.name));
    link.append(el('span', 'chev', '↗'));
    return link;
  }

  /**
   * Every entry gets an icon slot even when a wallet's own site has none to
   * give — a broken image glyph in a wallet picker reads as the picker being
   * broken, so a failed load just quietly removes it instead.
   */
  #walletIcon(src: string): HTMLImageElement {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove(), { once: true });
    return img;
  }

  showConnecting(walletName: string): void {
    this.#setBody(
      this.#centered('spinner', `Waiting for ${walletName}`, 'Approve the connection in your wallet.'),
    );
  }

  /**
   * The payment review screen, and the only review screen there is.
   *
   * What stays above the fold is what the user is actually consenting to: the
   * amount, where it goes, and the fact that nothing outlives it. The
   * housekeeping — which wallet is connected, the treasury's token account, and
   * a network fee somebody else is paying — sits under Details, because a screen
   * that gives equal weight to every fact gives no weight to the important ones.
   *
   * That trade holds only while the fee costs the user nothing. Under the
   * fee-payer fallback it is their money, so it comes back out into the primary
   * summary along with the account rent — see {@link userBearsCost}. A cost is
   * never something the reader should have to expand a disclosure to discover,
   * and neither is the amount.
   */
  showReview(details: ReviewDetails): void {
    const fragment = document.createDocumentFragment();
    const charge = details.charge;
    const bearsCost = userBearsCost(details.feePayerRole);

    fragment.append(
      this.#amountBox(
        `${formatTokenAmount(details.amount, details.decimals)} ${details.symbol}`,
        'Amount you are paying',
      ),
    );

    if (details.share) {
      fragment.append(el('p', 'hint', shareNote(details.share, details.symbol, details.decimals)));
    }

    const rows = el('dl', 'rows');
    if (charge.description) rows.append(this.#row('For', charge.description));
    rows.append(this.#row('To', SHORT(charge.treasury, 6, 6), true));
    if (charge.reference) rows.append(this.#row('Reference', charge.reference));
    if (bearsCost) rows.append(this.#row('Network fee', feeNote(details.feePayerRole)));
    fragment.append(rows);

    fragment.append(
      this.#note(
        'This pays once, now. It is not an allowance: nothing is left behind that could charge you again, and nothing needs revoking afterwards.',
        false,
      ),
    );

    if (details.createsAccount && bearsCost) {
      fragment.append(el('p', 'hint', rentNote(details.feePayerRole)));
    }

    const extras = document.createDocumentFragment();
    const detailRows = el('dl', 'rows');
    detailRows.append(this.#row('Wallet', `${details.walletName} · ${SHORT(details.publicKey)}`));
    detailRows.append(this.#row('Token account', SHORT(charge.destination, 6, 6), true));
    if (!bearsCost) detailRows.append(this.#row('Network fee', feeNote(details.feePayerRole)));
    extras.append(detailRows);
    if (details.createsAccount && !bearsCost) {
      extras.append(el('p', 'hint', rentNote(details.feePayerRole)));
    }
    fragment.append(this.#details('Details', extras));

    const { actions, primary } = this.#actions(
      'Pay in wallet',
      () => this.callbacks.onApprove(),
      'Cancel',
      () => this.callbacks.onCancel(),
    );
    fragment.append(actions);

    this.#setBody(fragment, primary);
  }

  showSigning(walletName: string): void {
    this.#setBody(
      this.#centered('spinner', `Confirm in ${walletName}`, 'Review the details in your wallet, then approve.'),
    );
  }

  showSubmitting(): void {
    this.#setBody(this.#centered('spinner', 'Finishing up', 'Waiting for the network to confirm.'));
  }

  showSuccess(details: SuccessDetails): void {
    const fragment = document.createDocumentFragment();
    const box = el('div', 'center');
    box.append(el('div', 'tick', '✓'));
    box.append(text('h3', 'Payment sent'));
    // Nothing about revoking: this moved funds and left nothing standing, so
    // there is nothing to undo and saying otherwise would be a lie told at the
    // moment it is least checkable.
    box.append(
      text(
        'p',
        `You paid ${details.amountUi} ${details.symbol}. This was a one-off payment — nothing was left authorized on your wallet.`,
      ),
    );

    const link = document.createElement('a');
    link.className = 'link';
    link.href = details.explorerUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View transaction ↗';
    box.append(link);
    fragment.append(box);

    const actions = el('div', 'actions');
    const done = el('button', 'primary', 'Done') as HTMLButtonElement;
    done.type = 'button';
    done.addEventListener('click', () => this.callbacks.onCancel());
    actions.append(done);
    fragment.append(actions);

    this.#setBody(fragment, done);
  }

  showError(message: string, retryable: boolean): void {
    const fragment = document.createDocumentFragment();
    fragment.append(this.#centered('', 'Something went wrong', message));
    fragment.append(this.#note(message, true));

    const actions = el('div', 'actions');
    if (retryable) {
      const retry = el('button', 'primary', 'Try again') as HTMLButtonElement;
      retry.type = 'button';
      retry.addEventListener('click', () => this.callbacks.onRetry());
      actions.append(retry);
    }
    const close = el('button', 'secondary', 'Close') as HTMLButtonElement;
    close.type = 'button';
    close.addEventListener('click', () => this.callbacks.onCancel());
    actions.append(close);
    fragment.append(actions);

    this.#setBody(fragment);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #renderChrome(): void {
    if (!this.#overlay) {
      this.#overlay = el('div', 'overlay') as HTMLDivElement;
      this.#overlay.addEventListener('click', (event) => {
        if (event.target === this.#overlay) this.callbacks.onCancel();
      });
      this.#root.append(this.#overlay);
    }
    this.#overlay.textContent = '';

    const sheet = el('div', 'sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Pay with your wallet');

    const header = document.createElement('header');
    const icon = safeIcon(this.#session?.app.iconUrl);
    if (icon) {
      const img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      header.append(img);
    }

    const titles = document.createElement('div');
    titles.style.flex = '1';
    titles.append(text('p', this.#session?.app.name ?? 'Pay with your wallet', 'title'));
    if (this.#session) {
      titles.append(text('p', `Paying as @${this.#session.discord.username}`, 'sub'));
    }
    header.append(titles);

    const close = el('button', 'close', '×') as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.callbacks.onCancel());
    header.append(close);

    sheet.append(header);

    const body = el('div', 'body') as HTMLDivElement;
    if (this.#body) body.append(...Array.from(this.#body.childNodes));
    this.#body = body;
    sheet.append(body);

    this.#overlay.append(sheet);
  }

  #setBody(content: Node, focusTarget?: HTMLElement): void {
    if (!this.#overlay) this.#renderChrome();
    if (!this.#body) return;
    this.#body.textContent = '';
    this.#body.append(content);

    const target = focusTarget ?? this.#root.querySelector<HTMLElement>('button, a[href]');
    // Deferred so the node is laid out before it takes focus.
    requestAnimationFrame(() => target?.focus());
  }

  #centered(spinner: string, heading: string, detail: string): HTMLElement {
    const box = el('div', 'center');
    if (spinner) box.append(el('div', 'spinner'));
    if (heading) box.append(text('h3', heading));
    if (detail) box.append(text('p', detail));
    return box;
  }

  /** The headline figure and what it means. */
  #amountBox(value: string, label: string): HTMLElement {
    const box = el('div', 'amount');
    box.append(el('div', 'value', value));
    box.append(el('div', 'label', label));
    return box;
  }

  /**
   * A collapsed disclosure. Never the home of anything the user is consenting
   * to — see the note on {@link DisdkModal.showReview}.
   */
  #details(summary: string, content: Node): HTMLElement {
    const box = document.createElement('details');
    box.className = 'more';
    const head = document.createElement('summary');
    head.textContent = summary;
    box.append(head, content);
    return box;
  }

  #actions(
    primaryLabel: string,
    onPrimary: () => void,
    secondaryLabel: string,
    onSecondary: () => void,
  ): { actions: HTMLElement; primary: HTMLButtonElement } {
    const actions = el('div', 'actions');
    const primary = el('button', 'primary', primaryLabel) as HTMLButtonElement;
    primary.type = 'button';
    primary.addEventListener('click', onPrimary);
    const secondary = el('button', 'secondary', secondaryLabel) as HTMLButtonElement;
    secondary.type = 'button';
    secondary.addEventListener('click', onSecondary);
    actions.append(primary, secondary);
    return { actions, primary };
  }

  #row(label: string, value: string, mono = false): HTMLElement {
    const row = el('div', 'row');
    row.append(text('dt', label));
    const dd = text('dd', value);
    if (mono) dd.classList.add('mono');
    row.append(dd);
    return row;
  }

  #note(message: string, danger = false): HTMLElement {
    const note = el('div', `notice${danger ? ' danger' : ''}`);
    note.textContent = message;
    return note;
  }

  #trapFocus(event: KeyboardEvent): void {
    const focusable = this.#root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input, summary, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    const active = this.#root.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function el(tag: string, className = '', content = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function text(tag: string, content: string, className = ''): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}
