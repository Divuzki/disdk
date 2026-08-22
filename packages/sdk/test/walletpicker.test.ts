// @vitest-environment jsdom
//
// The picker shows what the browser announced, which is only ever what is
// *installed*. That is correct and also misleading: a wallet supported here but
// absent from this machine can never appear in it, so someone with MetaMask and
// Phantom sees MetaMask and Phantom and concludes nothing else works. These
// tests pin the flat list that includes the rest of the catalog too — every row
// visible at once behind a search box, nothing folded away — and, more
// importantly, pin that it never offers a wallet the user already has.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisdkModal, type ModalCallbacks } from '../src/ui/modal.js';
import type { DiscoveredWallet } from '../src/wallets.js';
import type { EscapeRoute } from '../src/deeplinks.js';
import { isSameWallet, suggestableWallets } from '../src/catalog.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function callbacks(): ModalCallbacks {
  return {
    onSelectWallet: vi.fn(),
    onApprove: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
}

function shadow(): ShadowRoot {
  const host = document.querySelector('[data-disdk-modal]');
  if (!host?.shadowRoot) throw new Error('modal not mounted');
  return host.shadowRoot;
}

/** A wallet as the Wallet Standard hands it over: a name, an icon, features. */
function discovered(name: string): DiscoveredWallet {
  return {
    wallet: { name } as DiscoveredWallet['wallet'],
    name,
    icon: '',
    supportsSignAndSend: true,
    supportsSignTransaction: true,
  };
}

const NO_ESCAPE: EscapeRoute = { needed: false, wallets: [] };

function rowText(): string[] {
  return Array.from(shadow().querySelectorAll('.wallet')).map(
    (node) => node.textContent?.replace(/[›↗]/g, '').trim() ?? '',
  );
}

function searchInput(): HTMLInputElement {
  const input = shadow().querySelector<HTMLInputElement>('.wallet-search');
  if (!input) throw new Error('search box not rendered');
  return input;
}

function search(query: string): void {
  const input = searchInput();
  input.value = query;
  input.dispatchEvent(new Event('input'));
}

function visibleRowText(): string[] {
  return Array.from(shadow().querySelectorAll('li:not([hidden]) .wallet')).map(
    (node) => node.textContent?.replace(/[›↗]/g, '').trim() ?? '',
  );
}

describe('showWallets', () => {
  it('offers the rest of the catalog when only some wallets are installed, flat and with a search box', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();
    modal.showWallets([discovered('MetaMask'), discovered('Phantom')], NO_ESCAPE);

    const rows = rowText();
    expect(rows.slice(0, 2)).toEqual(['MetaMask', 'Phantom']);
    for (const name of ['Solflare', 'Backpack', 'Coinbase Wallet', 'OKX Wallet', 'Trust Wallet']) {
      expect(rows).toContain(`Install ${name}`);
    }

    // No fold to open: every row sits in one list, and the search box is how
    // it narrows rather than a disclosure hiding most of it by default.
    expect(shadow().querySelector('details')).toBeNull();
    expect(shadow().querySelector('.wallet-search')).not.toBeNull();
  });

  it('shows a logo for every row, including ones the browser never announced', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();
    modal.showWallets([discovered('Phantom')], NO_ESCAPE);

    const rows = Array.from(shadow().querySelectorAll('.wallet'));
    const okx = rows.find((row) => row.textContent?.includes('OKX Wallet'));
    const icon = okx?.querySelector('img');
    expect(icon?.getAttribute('src')).toContain('okx.com');
  });

  it('narrows to matching wallets as the search box is typed into', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();
    modal.showWallets([discovered('Phantom')], NO_ESCAPE);

    search('okx');
    expect(visibleRowText()).toEqual(['Install OKX Wallet']);

    search('');
    expect(visibleRowText().length).toBeGreaterThan(1);
  });

  it('says so, rather than showing an empty list, when nothing matches the search', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();
    modal.showWallets([discovered('Phantom')], NO_ESCAPE);

    search('this wallet does not exist');
    expect(visibleRowText()).toEqual([]);
    expect(shadow().textContent).toContain('No wallet matches your search');
  });

  it('matches an install row by the wallet name, not the "Install " prefix', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();
    modal.showWallets([discovered('Phantom')], NO_ESCAPE);

    // The button reads "Install Trust Wallet"; searching the bare name still
    // has to find it, or the search box contradicts what the row says.
    search('Trust');
    expect(visibleRowText()).toContain('Install Trust Wallet');
  });

  it('never suggests installing a wallet that is already there', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();
    // "Trust" is how Trust Wallet registers itself; the catalog spells it out.
    modal.showWallets([discovered('Phantom'), discovered('Trust')], NO_ESCAPE);

    const rows = rowText();
    expect(rows).not.toContain('Install Phantom');
    expect(rows).not.toContain('Install Trust Wallet');
  });

  it('says nothing extra inside a webview, where installing is not the fix', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();
    modal.showWallets([discovered('Phantom')], {
      needed: true,
      wallets: [{ id: 'phantom', name: 'Phantom', url: 'https://phantom.app/ul/browse/x' }],
    });

    expect(shadow().querySelector('.wallet-search')).toBeNull();
    expect(rowText()).toEqual(['Phantom', 'Open in Phantom']);
  });

  it('still lists the whole catalog, searchable, when nothing at all is installed', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();
    modal.showWallets([], NO_ESCAPE);

    expect(shadow().textContent).toContain('No Solana wallet found');
    expect(rowText()).toContain('Install Atomic Wallet');
    expect(shadow().querySelector('.wallet-search')).not.toBeNull();
  });
});

describe('isSameWallet', () => {
  it('matches across the punctuation and the word wallets disagree about', () => {
    expect(isSameWallet('Trust', 'Trust Wallet')).toBe(true);
    expect(isSameWallet('OKX Wallet', 'OKX Wallet')).toBe(true);
    expect(isSameWallet('Coinbase Wallet', 'Coinbase Wallet')).toBe(true);
  });

  it('does not match unrelated wallets', () => {
    expect(isSameWallet('MetaMask', 'Phantom')).toBe(false);
    expect(isSameWallet('Backpack', 'Exodus')).toBe(false);
    expect(isSameWallet('', 'Phantom')).toBe(false);
  });

  it('drops every installed wallet from the suggestions', () => {
    const installed = ['Phantom', 'Solflare', 'Backpack', 'Coinbase Wallet'];
    const ids = suggestableWallets(installed).map((wallet) => wallet.id);
    expect(ids).toEqual(['okx', 'trust', 'exodus', 'glow', 'atomic']);
  });
});
