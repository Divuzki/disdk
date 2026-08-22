/**
 * The wallets this SDK supports by name, and what "supported" means for each.
 *
 * Connecting is deliberately brand-blind: every wallet here reaches the page
 * through the Wallet Standard, and `wallets.ts` never names one. What names are
 * still needed for is the three things a browser cannot work out on its own:
 *
 *   1. **Its own in-app browser.** A page opened inside a wallet's browser must
 *      not be offered an escape route out of the one place a wallet is already
 *      reachable, and only the user-agent string says where we are.
 *   2. **The universal link back in.** The escape route itself — the link that
 *      reopens *this* URL, session id and all, inside that wallet's browser.
 *   3. **Where to install it**, for a desktop browser holding nothing at all.
 *
 * A wallet fills in a column only where that column is real. Inventing a browse
 * link a wallet does not publish produces a dead end inside the exact screen
 * that exists to prevent one, so most fields are optional and several entries
 * leave them empty on purpose.
 */

import type { Platform } from './environment.js';

/**
 * How a wallet can reach a web page at all.
 *
 * `standard` is the only one this SDK speaks: the wallet registers itself
 * through the Wallet Standard, either as a desktop extension or as the provider
 * injected into its own in-app browser. A `walletconnect` wallet is listed for
 * completeness and is *not* reachable here — it needs a WalletConnect relay,
 * which this SDK does not carry.
 */
export type WalletConnectivity = 'standard' | 'walletconnect';

export interface WalletProfile {
  id: string;
  name: string;
  connectivity: WalletConnectivity;
  /**
   * Fragment matching this wallet's in-app browser in a user-agent string.
   * Present only for wallets that ship a browser which injects a Solana
   * provider — that injection is what makes the escape route unnecessary.
   */
  browserPattern?: string;
  /** Reopens `target` inside the wallet's browser. Only where documented. */
  browse?: (target: string, ref: string) => string;
  /**
   * Platforms where that link lands somewhere useful. Omitted means "anywhere";
   * it is spelled out only for a wallet whose browser exists on one platform
   * and not the other, where offering the link everywhere offers a dead end.
   */
  browseOn?: readonly Platform[];
  /** Extension download, for a desktop browser with no wallet at all. */
  install?: string;
  /**
   * Shown next to the name when a wallet is *not* currently discovered, so it
   * is not blank in a list that otherwise shows a real icon for every entry a
   * browser actually announces. Each wallet's own site, not a third party —
   * `safeIcon` only trusts `https://` and `data:image/` sources, the same rule
   * an injected wallet's own icon has to pass.
   */
  icon?: string;
}

/**
 * Phantom: `https://phantom.app/ul/browse/<url>?ref=<ref>`, both components
 * URL-encoded.
 */
export function phantomBrowseLink(target: string, ref: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(target)}?ref=${encodeURIComponent(ref)}`;
}

export function solflareBrowseLink(target: string, ref: string): string {
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(target)}?ref=${encodeURIComponent(ref)}`;
}

export function backpackBrowseLink(target: string, ref: string): string {
  return `https://backpack.app/ul/v1/browse/${encodeURIComponent(target)}?ref=${encodeURIComponent(ref)}`;
}

/**
 * Trust Wallet: the page travels as a query parameter rather than a path
 * segment, and `coin_id` is the SLIP-44 index — 501 is Solana — which puts the
 * browser on the right network before the page loads.
 */
export function trustBrowseLink(target: string): string {
  return `https://link.trustwallet.com/open_url?coin_id=501&url=${encodeURIComponent(target)}`;
}

/** Coinbase Wallet: one universal link into its dapp browser tab. */
export function coinbaseBrowseLink(target: string): string {
  return `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(target)}`;
}

/**
 * OKX: encoded twice, and it has to be. The universal link carries a private
 * `okx://` scheme as one of its query values, so the page is escaped once for
 * the scheme and the whole scheme escaped again for the link. Skip either pass
 * and it is the session id in the query string that gets eaten.
 */
export function okxBrowseLink(target: string): string {
  const scheme = `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(target)}`;
  return `https://web3.okx.com/download?deeplink=${encodeURIComponent(scheme)}`;
}

/**
 * A wallet's own site, standing in for its logo when nothing has injected one.
 *
 * The favicon convention rather than a hand-picked asset: every wallet here
 * already serves one at its own domain, so this needs no bundled image, no
 * third-party aggregator, and no per-wallet upkeep as brands redesign.
 */
function favicon(domain: string): string {
  return `https://${domain}/favicon.ico`;
}

/**
 * Ordered the way the picker reads them: the wallets a stuck page can be handed
 * off to first, then the ones it can only point at.
 */
export const WALLET_CATALOG: readonly WalletProfile[] = [
  {
    id: 'phantom',
    name: 'Phantom',
    connectivity: 'standard',
    browserPattern: 'Phantom',
    browse: phantomBrowseLink,
    install: 'https://phantom.app/download',
    icon: favicon('phantom.app'),
  },
  {
    id: 'solflare',
    name: 'Solflare',
    connectivity: 'standard',
    browserPattern: 'Solflare',
    browse: solflareBrowseLink,
    install: 'https://solflare.com/download',
    icon: favicon('solflare.com'),
  },
  {
    id: 'backpack',
    name: 'Backpack',
    connectivity: 'standard',
    browserPattern: 'Backpack',
    browse: backpackBrowseLink,
    install: 'https://backpack.app/downloads',
    icon: favicon('backpack.app'),
  },
  {
    id: 'coinbase',
    name: 'Coinbase Wallet',
    connectivity: 'standard',
    browserPattern: 'Coinbase(Wallet|Browser)',
    browse: (target) => coinbaseBrowseLink(target),
    install: 'https://www.coinbase.com/wallet/downloads',
    icon: favicon('www.coinbase.com'),
  },
  {
    id: 'okx',
    name: 'OKX Wallet',
    connectivity: 'standard',
    // The OKX app tags its webview with its own build name, not the brand.
    browserPattern: 'OKApp|OKEx',
    browse: (target) => okxBrowseLink(target),
    install: 'https://web3.okx.com/download',
    icon: favicon('web3.okx.com'),
  },
  {
    id: 'trust',
    name: 'Trust Wallet',
    connectivity: 'standard',
    browserPattern: 'Trust',
    browse: (target) => trustBrowseLink(target),
    // Android only. App Store rules took the dapp browser out of Trust's iOS
    // build, where this same link answers "deep link is not supported" — which
    // is a worse dead end than not offering it.
    browseOn: ['android'],
    install: 'https://trustwallet.com/download',
    icon: favicon('trustwallet.com'),
  },
  {
    id: 'exodus',
    name: 'Exodus',
    connectivity: 'standard',
    // Its Web3 browser injects, so being inside it is fine; there is no
    // published link for getting into it, so we cannot send anyone there.
    browserPattern: 'Exodus',
    install: 'https://www.exodus.com/download/',
    icon: favicon('www.exodus.com'),
  },
  {
    id: 'glow',
    name: 'Glow',
    connectivity: 'standard',
    // Mobile-first, but it reaches pages as a Safari extension on iOS rather
    // than through a browser of its own, so ordinary discovery finds it there.
    browserPattern: 'Glow',
    install: 'https://glow.app/download',
    icon: favicon('glow.app'),
  },
  {
    id: 'atomic',
    name: 'Atomic Wallet',
    connectivity: 'standard',
    // Extension only: no in-app browser to be inside of, hence no user agent to
    // match and nowhere for a browse link to land.
    install: 'https://atomicwallet.io/web3-wallet',
    icon: favicon('atomicwallet.io'),
  },
  {
    id: 'venly',
    name: 'Venly',
    connectivity: 'walletconnect',
    // Listed, but reachable from no list below. Venly is a wallet-as-a-service
    // the *application* embeds; a visitor brings it to someone else's page over
    // WalletConnect. Nothing is injected, so nothing registers through the
    // Wallet Standard, and there is no extension to install or browser to open.
    icon: favicon('www.venly.io'),
  },
];

export function findWallet(id: string): WalletProfile | undefined {
  return WALLET_CATALOG.find((wallet) => wallet.id === id);
}

/**
 * Matches any catalogued wallet's own in-app browser.
 *
 * Derived from the catalog rather than written out beside it, because the cost
 * of the two drifting apart is a wallet browser being told it cannot reach a
 * wallet — and then being offered a link to itself.
 */
export const WALLET_BROWSER_PATTERN: RegExp = new RegExp(
  WALLET_CATALOG.map((wallet) => wallet.browserPattern)
    .filter((pattern): pattern is string => Boolean(pattern))
    .join('|'),
  'i',
);

/** Wallets that publish a universal link into their browser, for `platform`. */
export function browsableWallets(platform?: Platform): readonly WalletProfile[] {
  return WALLET_CATALOG.filter(
    (wallet) =>
      wallet.browse !== undefined &&
      (!wallet.browseOn || !platform || wallet.browseOn.includes(platform)),
  );
}

/** Wallets a desktop visitor with nothing installed can actually go and get. */
export function installableWallets(): readonly WalletProfile[] {
  return WALLET_CATALOG.filter((wallet) => wallet.install !== undefined);
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether a name a wallet registered itself under is the wallet catalogued
 * here. The two disagree about punctuation and about the word "Wallet" more
 * often than not — Trust registers as "Trust", OKX as "OKX Wallet" — and the
 * cost of getting it wrong is offering someone an install link for the wallet
 * they are already looking at.
 */
export function isSameWallet(registeredName: string, cataloguedName: string): boolean {
  const registered = normalize(registeredName);
  const catalogued = normalize(cataloguedName);
  if (!registered || !catalogued) return false;
  return registered.includes(catalogued) || catalogued.includes(registered);
}

/**
 * Wallets worth suggesting to a browser that already has one.
 *
 * The picker can only ever show what is *installed* — that is what the Wallet
 * Standard announces — so a wallet supported here but absent from this machine
 * is invisible in it. This is the list that says otherwise, minus whatever the
 * browser has already announced.
 */
export function suggestableWallets(registeredNames: readonly string[]): readonly WalletProfile[] {
  return installableWallets().filter(
    (wallet) => !registeredNames.some((name) => isSameWallet(name, wallet.name)),
  );
}
