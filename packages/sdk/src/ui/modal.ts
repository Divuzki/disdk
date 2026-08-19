import {
  formatTokenAmount,
  type FeePayerRole,
  type RentDestination,
  type SessionPublic,
} from '@disdk/protocol';
import type { DiscoveredWallet } from '../wallets.js';
import type { EscapeRoute } from '../deeplinks.js';
import { MODAL_CSS } from './styles.js';

export type Theme = 'auto' | 'light' | 'dark';

export interface ReviewDetails {
  /** Read out of the transaction bytes, not from the server's JSON. */
  amount: bigint;
  decimals: number;
  symbol: string;
  delegate: string;
  walletName: string;
  publicKey: string;
  createsAccount: boolean;
  isUnlimited: boolean;
  /**
   * Who pays the network fee. Shown plainly, because "paid for you" is the
   * promise this SDK makes and a fallback to the user paying is a change to
   * that promise, not a detail.
   */
  feePayerRole?: FeePayerRole;
  /**
   * Present only for a sweep. Its presence changes the screen from "you are
   * granting an allowance" to "you are moving funds", which are different enough
   * that sharing one layout without a discriminator would be a bug waiting to
   * happen.
   */
  sweep?: SweepReviewDetails;
  /**
   * Present only for a charge. Same reasoning as `sweep`: money leaves now, so
   * it gets its own screen rather than a reworded allowance one.
   */
  charge?: ChargeReviewDetails;
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

/** What the user-priced amount-entry screen needs to render and bound its input. */
export interface AmountEntryDetails {
  symbol: string;
  decimals: number;
  /** Treasury wallet, for display. */
  treasury: string;
  /** Server ceiling in base units; the input is capped at it. */
  maxAmount?: bigint;
  description?: string;
}

export interface AmountEntryHandlers {
  /** Called with the chosen amount in base units, once it passes local checks. */
  onSubmit(baseUnits: string): void;
  onCancel(): void;
}

export interface SweepReviewDetails {
  leg: 'transfer' | 'close';
  /** Destination token account, read out of the bytes. */
  destination: string;
  /** Number of accounts the close leg will close. */
  closeCount: number;
  /** Where reclaimed rent goes. */
  rentTo: string;
}

/** What the sweep offer screen needs to state the case honestly. */
export interface SweepOfferDetails {
  /** The allowance that just landed. Shown so the offer never masks its result. */
  permitAmountUi: string;
  symbol: string;
  explorerUrl: string;
  /** Server's own words for the policy, e.g. "80% of your USDC balance". */
  description: string;
  /** Cold wallet the transfer would credit. */
  destination: string;
  /** Where rent from closing empty accounts would go. */
  rentDestination: RentDestination;
}

/**
 * The two ways out of the offer screen, and there are only two.
 *
 * Neither is a default the screen picks on the user's behalf: closing the modal,
 * pressing Escape, or clicking away all route to `onDecline`, so the sweep can
 * only start by someone pressing the button that says so.
 */
export interface SweepOfferHandlers {
  onAccept(): void;
  onDecline(): void;
}

export interface SuccessDetails {
  amountUi: string;
  symbol: string;
  explorerUrl: string;
  /**
   * What just happened. Defaults to `permit`, which is the only one of the
   * three that leaves anything behind to revoke — telling a user who just paid
   * an invoice that they can revoke it would be both wrong and alarming.
   */
  kind?: 'permit' | 'sweep' | 'charge';
}

export interface ModalCallbacks {
  onSelectWallet(entry: DiscoveredWallet): void;
  onApprove(): void;
  onCancel(): void;
  onRetry(): void;
}

/** Offered when a desktop browser has no wallet at all, so the modal is not a dead end. */
const INSTALL_LINKS = [
  { name: 'Phantom', url: 'https://phantom.app/download' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/downloads' },
];

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

    if (wallets.length > 0) {
      const list = el('ul', 'wallet-list');
      for (const entry of wallets) {
        const item = document.createElement('li');
        const button = el('button', 'wallet') as HTMLButtonElement;
        button.type = 'button';

        const icon = safeIcon(entry.icon);
        if (icon) {
          const img = document.createElement('img');
          img.src = icon;
          img.alt = '';
          button.append(img);
        }
        button.append(text('span', entry.name));
        button.append(el('span', 'chev', '›'));
        button.addEventListener('click', () => this.callbacks.onSelectWallet(entry));

        item.append(button);
        list.append(item);
      }
      fragment.append(list);
    }

    if (escape.needed) {
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
    }

    if (wallets.length === 0 && !escape.needed) {
      // Desktop with nothing installed. Saying "none found" and stopping leaves
      // the user with nowhere to go, so offer the install step directly.
      fragment.append(
        this.#centered('', 'No Solana wallet found', 'Install one of these, then reload this page.'),
      );

      const list = el('ul', 'wallet-list');
      for (const wallet of INSTALL_LINKS) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'wallet';
        link.href = wallet.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.append(text('span', `Install ${wallet.name}`));
        link.append(el('span', 'chev', '↗'));
        item.append(link);
        list.append(item);
      }
      fragment.append(list);
      fragment.append(
        el('p', 'hint', 'Already installed? Unlock the extension, then reload.'),
      );
    }

    this.#setBody(fragment);
  }

  showConnecting(walletName: string): void {
    this.#setBody(
      this.#centered('spinner', `Waiting for ${walletName}`, 'Approve the connection in your wallet.'),
    );
  }

  /**
   * Ask the payer to name their own amount, for a user-priced charge.
   *
   * This is the whole difference between a checkout and a sweep: the amount is
   * the payer's to choose, entered here before anything is signed and bounded by
   * the server's ceiling. The value is validated locally only to give an
   * immediate error; the server re-checks it against the same ceiling and the
   * per-wallet window regardless.
   */
  showAmountEntry(details: AmountEntryDetails, handlers: AmountEntryHandlers): void {
    const fragment = document.createDocumentFragment();

    const box = el('div', 'amount');
    const inputRow = el('div', 'amount-input');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `Amount in ${details.symbol}`);
    input.placeholder = '0';
    inputRow.append(input, el('span', 'sym', details.symbol));
    box.append(inputRow);
    box.append(
      el(
        'div',
        'label',
        details.maxAmount === undefined
          ? 'Amount you are paying'
          : `Amount you are paying · up to ${formatTokenAmount(details.maxAmount, details.decimals)} ${details.symbol}`,
      ),
    );
    fragment.append(box);

    const rows = el('dl', 'rows');
    if (details.description) rows.append(this.#row('For', details.description));
    rows.append(this.#row('To', SHORT(details.treasury, 6, 6), true));
    fragment.append(rows);

    const error = el('p', 'amount-error');
    fragment.append(error);

    fragment.append(
      this.#note(
        'You pay once, now, the amount you enter above. It is not an allowance — nothing is left behind that could charge you again.',
      ),
    );

    const actions = el('div', 'actions');
    const cont = el('button', 'primary', 'Continue') as HTMLButtonElement;
    cont.type = 'button';
    const cancel = el('button', 'secondary', 'Cancel') as HTMLButtonElement;
    cancel.type = 'button';
    actions.append(cont, cancel);
    fragment.append(actions);

    const submit = () => {
      const parsed = parseAmount(input.value, details.decimals);
      if (parsed === null) {
        error.textContent = `Enter an amount in ${details.symbol}.`;
        return;
      }
      if (parsed <= 0n) {
        error.textContent = 'Amount must be greater than zero.';
        return;
      }
      if (details.maxAmount !== undefined && parsed > details.maxAmount) {
        error.textContent = `The most you can pay here is ${formatTokenAmount(details.maxAmount, details.decimals)} ${details.symbol}.`;
        return;
      }
      error.textContent = '';
      handlers.onSubmit(parsed.toString());
    };

    cont.addEventListener('click', submit);
    input.addEventListener('input', () => {
      error.textContent = '';
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    cancel.addEventListener('click', () => handlers.onCancel());

    this.#setBody(fragment, input);
  }

  showReview(details: ReviewDetails): void {
    if (details.sweep) return this.#showSweepReview(details, details.sweep);
    if (details.charge) return this.#showChargeReview(details, details.charge);

    const fragment = document.createDocumentFragment();

    const amountBox = el('div', 'amount');
    const value = el('div', 'value');
    value.textContent = details.isUnlimited
      ? `Unlimited ${details.symbol}`
      : `${formatTokenAmount(details.amount, details.decimals)} ${details.symbol}`;
    amountBox.append(value);
    amountBox.append(el('div', 'label', `Spending allowance you are granting`));
    fragment.append(amountBox);

    const rows = el('dl', 'rows');
    rows.append(this.#row('Wallet', `${details.walletName} · ${SHORT(details.publicKey)}`));
    rows.append(this.#row('Spender', SHORT(details.delegate, 6, 6), true));
    rows.append(this.#row('Network fee', feeNote(details.feePayerRole)));
    fragment.append(rows);

    fragment.append(
      this.#note(
        details.isUnlimited
          ? 'This allowance has no limit and no expiry. The spender can move this token from your wallet, including funds you deposit later, until you revoke it.'
          : 'This allowance does not expire. The spender can move up to this amount from your wallet at any time until you revoke it.',
        details.isUnlimited,
      ),
    );

    if (details.createsAccount) {
      fragment.append(el('p', 'hint', rentNote(details.feePayerRole)));
    }

    const actions = el('div', 'actions');
    const approve = el('button', 'primary', 'Approve in wallet') as HTMLButtonElement;
    approve.type = 'button';
    approve.addEventListener('click', () => this.callbacks.onApprove());
    const cancel = el('button', 'secondary', 'Cancel') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.callbacks.onCancel());
    actions.append(approve, cancel);
    fragment.append(actions);

    this.#setBody(fragment, approve);
  }

  /**
   * The sweep review screen.
   *
   * Kept deliberately separate from the allowance screen rather than
   * parameterised into it. An allowance is revocable and this is not, so every
   * reassurance that belongs on the permit screen ("you can revoke this any
   * time") would be a lie here.
   */
  #showSweepReview(details: ReviewDetails, sweep: SweepReviewDetails): void {
    const fragment = document.createDocumentFragment();

    const amountBox = el('div', 'amount');
    const value = el('div', 'value');

    if (sweep.leg === 'close') {
      value.textContent = `${sweep.closeCount} account${sweep.closeCount === 1 ? '' : 's'}`;
      amountBox.append(value);
      amountBox.append(el('div', 'label', 'Empty token accounts you are closing'));
    } else {
      value.textContent = `${formatTokenAmount(details.amount, details.decimals)} ${details.symbol}`;
      amountBox.append(value);
      amountBox.append(el('div', 'label', 'Amount leaving your wallet'));
    }
    fragment.append(amountBox);

    const rows = el('dl', 'rows');
    rows.append(this.#row('Wallet', `${details.walletName} · ${SHORT(details.publicKey)}`));
    if (sweep.leg === 'transfer') {
      rows.append(this.#row('To', SHORT(sweep.destination, 6, 6), true));
    } else {
      rows.append(this.#row('Rent to', SHORT(sweep.rentTo, 6, 6), true));
    }
    rows.append(this.#row('Network fee', feeNote(details.feePayerRole)));
    fragment.append(rows);

    fragment.append(
      this.#note(
        sweep.leg === 'close'
          ? 'Closing an empty token account returns its rent deposit. No tokens move in this step.'
          : 'This moves tokens out of your wallet now. It is not an allowance, and it cannot be revoked or undone from this page.',
        sweep.leg === 'transfer',
      ),
    );

    if (sweep.leg === 'transfer') {
      fragment.append(
        el('p', 'hint', 'After this you will be asked to sign once more to close empty accounts.'),
      );
    }

    const actions = el('div', 'actions');
    const approve = el(
      'button',
      'primary',
      sweep.leg === 'close' ? 'Close accounts' : 'Transfer in wallet',
    ) as HTMLButtonElement;
    approve.type = 'button';
    approve.addEventListener('click', () => this.callbacks.onApprove());
    const cancel = el('button', 'secondary', 'Cancel') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.callbacks.onCancel());
    actions.append(approve, cancel);
    fragment.append(actions);

    this.#setBody(fragment, approve);
  }

  /**
   * The payment review screen.
   *
   * Separate from both siblings for the same reason they are separate from each
   * other. Against the allowance screen: nothing here is revocable, so none of
   * its reassurances apply. Against the sweep screen: a sweep is an operator
   * moving their own float and reads as a warning, while a charge is a purchase
   * and should read as a receipt — but a calm screen still has to be an honest
   * one, so the irreversibility is stated rather than softened.
   */
  #showChargeReview(details: ReviewDetails, charge: ChargeReviewDetails): void {
    const fragment = document.createDocumentFragment();

    const amountBox = el('div', 'amount');
    const value = el('div', 'value');
    value.textContent = `${formatTokenAmount(details.amount, details.decimals)} ${details.symbol}`;
    amountBox.append(value);
    amountBox.append(el('div', 'label', 'Amount you are paying'));
    fragment.append(amountBox);

    const rows = el('dl', 'rows');
    if (charge.description) rows.append(this.#row('For', charge.description));
    rows.append(this.#row('Wallet', `${details.walletName} · ${SHORT(details.publicKey)}`));
    rows.append(this.#row('To', SHORT(charge.treasury, 6, 6), true));
    if (charge.reference) rows.append(this.#row('Reference', charge.reference));
    rows.append(this.#row('Network fee', feeNote(details.feePayerRole)));
    fragment.append(rows);

    fragment.append(
      this.#note(
        'This pays once, now. It is not an allowance: nothing is left behind that could charge you again, and nothing needs revoking afterwards.',
        false,
      ),
    );

    if (details.createsAccount) {
      fragment.append(el('p', 'hint', rentNote(details.feePayerRole)));
    }

    const actions = el('div', 'actions');
    const approve = el('button', 'primary', 'Pay in wallet') as HTMLButtonElement;
    approve.type = 'button';
    approve.addEventListener('click', () => this.callbacks.onApprove());
    const cancel = el('button', 'secondary', 'Cancel') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.callbacks.onCancel());
    actions.append(approve, cancel);
    fragment.append(actions);

    this.#setBody(fragment, approve);
  }

  /**
   * Offer the sweep, after the permit has landed. Asks; does nothing else.
   *
   * The screen has three jobs and they are in tension, so the order matters.
   * First it reports the thing the user actually came for — the allowance is
   * granted, with a link to it — because an offer stacked on top of an
   * unacknowledged result reads as a step in a flow the user is still inside.
   * Only then does it put the sweep, in the server's own words, with the
   * destination shown in full rather than shortened: this is the one address on
   * any screen here that the user has no prior reason to expect, and truncating
   * it would hide the only part worth checking.
   *
   * Nothing is pre-selected and nothing is pending. Declining is the focused
   * button, and every other way of leaving this screen declines too — because a
   * transfer that cannot be undone should never be reachable by a stray Enter
   * on a screen the user did not ask to see.
   */
  showSweepOffer(details: SweepOfferDetails, handlers: SweepOfferHandlers): void {
    const fragment = document.createDocumentFragment();

    const done = el('div', 'center compact');
    done.append(el('div', 'tick', '✓'));
    done.append(text('h3', 'Allowance approved'));
    done.append(
      text(
        'p',
        `You approved ${details.permitAmountUi} ${details.symbol}. That part is finished — you can revoke it at any time with /revoke in Discord.`,
      ),
    );
    if (details.explorerUrl) {
      const link = document.createElement('a');
      link.className = 'link';
      link.href = details.explorerUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'View transaction ↗';
      done.append(link);
    }
    fragment.append(done);

    const amountBox = el('div', 'amount');
    amountBox.append(el('div', 'value phrase', details.description));
    amountBox.append(el('div', 'label', 'A separate transfer, if you want it'));
    fragment.append(amountBox);

    const rows = el('dl', 'rows');
    rows.append(this.#row('Would go to', details.destination, true));
    rows.append(
      this.#row(
        'Reclaimed rent',
        details.rentDestination === 'cold' ? 'Also to that address' : 'Back to your wallet',
      ),
    );
    fragment.append(rows);

    fragment.append(
      this.#note(
        'This is different from what you just approved. It moves USDC out of your wallet immediately, to the address above, and cannot be revoked or undone afterwards. Nothing has been started and nothing will be unless you choose it here.',
        true,
      ),
    );

    const actions = el('div', 'actions');
    const decline = el('button', 'primary', 'No — keep my USDC') as HTMLButtonElement;
    decline.type = 'button';
    decline.addEventListener('click', () => handlers.onDecline());
    const accept = el('button', 'secondary', 'Yes, move my USDC') as HTMLButtonElement;
    accept.type = 'button';
    accept.addEventListener('click', () => handlers.onAccept());
    actions.append(decline, accept);
    fragment.append(actions);

    fragment.append(
      el(
        'p',
        'hint',
        'Choosing yes only shows you the transfer to review. You still sign it in your wallet, and can stop there.',
      ),
    );

    this.#setBody(fragment, decline);
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
    box.append(text('h3', details.kind === 'charge' ? 'Payment sent' : 'All set'));
    box.append(text('p', successMessage(details)));

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
    sheet.setAttribute('aria-label', 'Connect your wallet');

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
    titles.append(text('p', this.#session?.app.name ?? 'Connect wallet', 'title'));
    if (this.#session) {
      titles.append(
        text('p', `Linking @${this.#session.discord.username}`, 'sub'),
      );
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
      'button:not(:disabled), a[href], input, [tabindex]:not([tabindex="-1"])',
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

/**
 * What to tell the user once it has landed.
 *
 * Only the permit branch mentions revoking, because only the permit branch left
 * something revocable. The other two moved funds that are now gone, and saying
 * anything reassuring about undoing that would be a lie told at the exact
 * moment it is least checkable.
 */
function successMessage(details: SuccessDetails): string {
  switch (details.kind) {
    case 'charge':
      return `You paid ${details.amountUi} ${details.symbol}. This was a one-off payment — nothing was left authorized on your wallet.`;
    case 'sweep':
      return `${details.amountUi} ${details.symbol} was transferred. This moved funds and cannot be undone.`;
    default:
      return `You approved ${details.amountUi} ${details.symbol}. You can revoke this at any time with /revoke in Discord.`;
  }
}

/**
 * Parse a user-typed decimal amount into base units, or null if it is not a
 * clean non-negative decimal with no more fractional digits than the token has.
 *
 * Deliberately string-based: the value goes on to authorize a transfer, and a
 * float round-trip would be exactly the wrong place to lose a base unit. The
 * server re-derives the amount from the signed bytes regardless, so this only
 * has to be honest, not authoritative.
 */
export function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim().replace(/,/g, '');
  if (trimmed === '' || !/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') return null;

  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > decimals) return null;

  const padded = frac.padEnd(decimals, '0');
  try {
    return BigInt(`${whole || '0'}${padded}`);
  } catch {
    return null;
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
