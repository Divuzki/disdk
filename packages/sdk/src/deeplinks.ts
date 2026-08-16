/**
 * Escape hatches out of an embedded webview.
 *
 * These are a fallback, not the main route. A wallet's universal link reopens
 * the *same* URL inside the wallet's own browser, where its provider is
 * injected and the normal Wallet Standard flow works. The session id travels in
 * the URL, so the flow resumes exactly where it left off — which is why the
 * session must stay valid across reopens rather than being consumed on first
 * view.
 */

import type { Environment } from './environment.js';

export interface WalletDeeplink {
  id: string;
  name: string;
  url: string;
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
 * Android intent URL that reopens the page in Chrome, escaping the host app's
 * webview without involving a wallet at all.
 */
export function chromeIntentLink(target: string): string {
  const withoutScheme = target.replace(/^https?:\/\//, '');
  return `intent://${withoutScheme}#Intent;scheme=https;package=com.android.chrome;end`;
}

export function buildDeeplinks(target: string, ref: string): WalletDeeplink[] {
  return [
    { id: 'phantom', name: 'Phantom', url: phantomBrowseLink(target, ref) },
    { id: 'solflare', name: 'Solflare', url: solflareBrowseLink(target, ref) },
    { id: 'backpack', name: 'Backpack', url: backpackBrowseLink(target, ref) },
  ];
}

export interface EscapeOptions {
  environment: Environment;
  /** The page to reopen. Must carry the session id. */
  href: string;
  origin: string;
}

export interface EscapeRoute {
  /** True when the page cannot reach a wallet where it currently is. */
  needed: boolean;
  wallets: WalletDeeplink[];
  /** Android only: reopen in Chrome, where MWA works. */
  chromeIntent?: string;
}

/**
 * Work out how to get the user somewhere a wallet can actually be reached.
 * Only meaningful once wallet discovery has come up empty.
 */
export function planEscape({ environment, href, origin }: EscapeOptions): EscapeRoute {
  if (environment.isWalletBrowser) {
    return { needed: false, wallets: [] };
  }

  if (!environment.isInAppBrowser) {
    // A normal browser with no wallet is an install problem, not a routing one —
    // except on mobile, where deeplinking into a wallet app is still the fix.
    return { needed: environment.isMobile, wallets: environment.isMobile ? buildDeeplinks(href, origin) : [] };
  }

  const route: EscapeRoute = { needed: true, wallets: buildDeeplinks(href, origin) };
  if (environment.platform === 'android') {
    route.chromeIntent = chromeIntentLink(href);
  }
  return route;
}
