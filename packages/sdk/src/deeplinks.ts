/**
 * Escape hatches out of an embedded webview.
 *
 * These are a fallback, not the main route. A wallet's universal link reopens
 * the *same* URL inside the wallet's own browser, where its provider is
 * injected and the normal Wallet Standard flow works. The session id travels in
 * the URL, so the flow resumes exactly where it left off — which is why the
 * session must stay valid across reopens rather than being consumed on first
 * view.
 *
 * Which wallets publish such a link, and where that link actually lands, lives
 * in `catalog.ts`; this module only decides when to offer them.
 */

import type { Environment, Platform } from './environment.js';
import { browsableWallets } from './catalog.js';

export interface WalletDeeplink {
  id: string;
  name: string;
  url: string;
}

export {
  phantomBrowseLink,
  solflareBrowseLink,
  backpackBrowseLink,
  trustBrowseLink,
  coinbaseBrowseLink,
  okxBrowseLink,
} from './catalog.js';

/**
 * Android intent URL that reopens the page in Chrome, escaping the host app's
 * webview without involving a wallet at all.
 */
export function chromeIntentLink(target: string): string {
  const withoutScheme = target.replace(/^https?:\/\//, '');
  return `intent://${withoutScheme}#Intent;scheme=https;package=com.android.chrome;end`;
}

/**
 * Every wallet that can take this page off our hands, minus the ones whose
 * browser does not exist on `platform`. Passing no platform keeps all of them,
 * which is what a caller outside the modal usually wants.
 */
export function buildDeeplinks(target: string, ref: string, platform?: Platform): WalletDeeplink[] {
  return browsableWallets(platform).map(({ id, name, browse }) => ({
    id,
    name,
    // `browsableWallets` selects on `browse` being present; the assertion is
    // narrowing, not a claim.
    url: browse!(target, ref),
  }));
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

  const wallets = () => buildDeeplinks(href, origin, environment.platform);

  if (!environment.isInAppBrowser) {
    // A normal browser with no wallet is an install problem, not a routing one —
    // except on mobile, where deeplinking into a wallet app is still the fix.
    return { needed: environment.isMobile, wallets: environment.isMobile ? wallets() : [] };
  }

  const route: EscapeRoute = { needed: true, wallets: wallets() };
  if (environment.platform === 'android') {
    route.chromeIntent = chromeIntentLink(href);
  }
  return route;
}
