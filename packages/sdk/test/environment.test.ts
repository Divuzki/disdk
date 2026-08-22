import { describe, expect, it } from 'vitest';
import { detectEnvironment, inAppBrowserName } from '../src/environment.js';
import {
  buildDeeplinks,
  chromeIntentLink,
  coinbaseBrowseLink,
  okxBrowseLink,
  phantomBrowseLink,
  planEscape,
  solflareBrowseLink,
  trustBrowseLink,
} from '../src/deeplinks.js';
import { WALLET_CATALOG, browsableWallets, installableWallets } from '../src/catalog.js';

// Real user-agent strings, since this whole module is UA pattern matching.
const UA = {
  discordIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Discord/220.0',
  discordAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Discord/220.0',
  phantomIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Phantom/24.0',
  trustAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Trust/8.0',
  okxAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 OKApp/6.60.0',
  exodusIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Exodus/24.10.1',
  coinbaseIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CoinbaseWallet/1.0',
  glowIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Glow/1.6.3',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  safariIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

describe('detectEnvironment', () => {
  it('recognises the Discord webview on iOS', () => {
    const env = detectEnvironment(UA.discordIOS);
    expect(env).toMatchObject({
      platform: 'ios',
      isMobile: true,
      isInAppBrowser: true,
      isDiscordBrowser: true,
      isWalletBrowser: false,
    });
  });

  it('recognises the Discord webview on Android', () => {
    const env = detectEnvironment(UA.discordAndroid);
    expect(env.platform).toBe('android');
    expect(env.isInAppBrowser).toBe(true);
  });

  it('does not treat a wallet browser as an in-app browser', () => {
    // Phantom's browser injects a provider, so it must not get the escape UI.
    const env = detectEnvironment(UA.phantomIOS);
    expect(env.isWalletBrowser).toBe(true);
    expect(env.isInAppBrowser).toBe(false);
    expect(inAppBrowserName(UA.phantomIOS)).toBeNull();
  });

  it('recognises every catalogued wallet browser, not just Phantom', () => {
    // Each of these ships a browser that injects a Solana provider, so the page
    // is already where it needs to be and must not be pushed out of it.
    for (const ua of [UA.trustAndroid, UA.okxAndroid, UA.exodusIOS, UA.coinbaseIOS, UA.glowIOS]) {
      const env = detectEnvironment(ua);
      expect(env.isWalletBrowser).toBe(true);
      expect(env.isInAppBrowser).toBe(false);
      expect(inAppBrowserName(ua)).toBeNull();
    }
  });

  it('treats ordinary mobile browsers as normal', () => {
    for (const ua of [UA.chromeAndroid, UA.safariIOS]) {
      const env = detectEnvironment(ua);
      expect(env.isInAppBrowser).toBe(false);
      expect(env.isMobile).toBe(true);
    }
  });

  it('treats desktop as non-mobile', () => {
    const env = detectEnvironment(UA.chromeDesktop);
    expect(env.platform).toBe('desktop');
    expect(env.isMobile).toBe(false);
    expect(env.isInAppBrowser).toBe(false);
  });

  it('names the embedding app', () => {
    expect(inAppBrowserName(UA.discordIOS)).toBe('discord');
    expect(inAppBrowserName(UA.chromeDesktop)).toBeNull();
  });
});

describe('deeplinks', () => {
  const href = 'https://app.example.com/connect?ds=abc123XYZ_-';
  const origin = 'https://app.example.com';

  it('encodes the Phantom browse link so the session id survives', () => {
    const link = phantomBrowseLink(href, origin);
    expect(link.startsWith('https://phantom.app/ul/browse/')).toBe(true);

    // The session id must come back out intact on the other side.
    const encoded = link.slice('https://phantom.app/ul/browse/'.length).split('?')[0] as string;
    expect(decodeURIComponent(encoded)).toBe(href);
    expect(link).toContain(`ref=${encodeURIComponent(origin)}`);
  });

  it('encodes the Solflare browse link', () => {
    const link = solflareBrowseLink(href, origin);
    expect(link.startsWith('https://solflare.com/ul/v1/browse/')).toBe(true);
    const encoded = link.slice('https://solflare.com/ul/v1/browse/'.length).split('?')[0] as string;
    expect(decodeURIComponent(encoded)).toBe(href);
  });

  it('puts the page in a query parameter for Trust, on the Solana coin id', () => {
    const link = trustBrowseLink(href);
    expect(link.startsWith('https://link.trustwallet.com/open_url?coin_id=501&url=')).toBe(true);
    expect(new URL(link).searchParams.get('url')).toBe(href);
  });

  it('encodes the Coinbase Wallet browse link', () => {
    const link = coinbaseBrowseLink(href);
    expect(link.startsWith('https://go.cb-w.com/dapp?cb_url=')).toBe(true);
    expect(new URL(link).searchParams.get('cb_url')).toBe(href);
  });

  it('double-encodes the OKX link so the session id survives both hops', () => {
    // The universal link carries an okx:// scheme, which carries the page: two
    // layers, and the session id is in the innermost query string.
    const link = okxBrowseLink(href);
    const scheme = new URL(link).searchParams.get('deeplink') as string;
    expect(scheme.startsWith('okx://wallet/dapp/url?dappUrl=')).toBe(true);
    expect(decodeURIComponent(scheme.slice('okx://wallet/dapp/url?dappUrl='.length))).toBe(href);
  });

  it('builds an Android intent that reopens the page in Chrome', () => {
    const link = chromeIntentLink(href);
    expect(link).toBe(
      'intent://app.example.com/connect?ds=abc123XYZ_-#Intent;scheme=https;package=com.android.chrome;end',
    );
  });

  it('offers Trust on Android but not on iOS, which has no dapp browser', () => {
    expect(buildDeeplinks(href, origin, 'android').map((w) => w.id)).toContain('trust');
    expect(buildDeeplinks(href, origin, 'ios').map((w) => w.id)).not.toContain('trust');
    // No platform stated means no platform filtering.
    expect(buildDeeplinks(href, origin).map((w) => w.id)).toContain('trust');
  });
});

describe('wallet catalog', () => {
  it('only offers a browse link for a wallet that has a browser to land in', () => {
    for (const wallet of browsableWallets()) {
      expect(wallet.browserPattern).toBeDefined();
      expect(wallet.connectivity).toBe('standard');
    }
  });

  it('keeps WalletConnect-only wallets out of every list the modal renders', () => {
    // Venly is reachable over a relay this SDK does not carry, so listing it as
    // somewhere to open or install would be pointing at a door that is shut.
    const venly = WALLET_CATALOG.find((wallet) => wallet.id === 'venly');
    expect(venly?.connectivity).toBe('walletconnect');
    expect(browsableWallets().map((w) => w.id)).not.toContain('venly');
    expect(installableWallets().map((w) => w.id)).not.toContain('venly');
  });

  it('covers the wallets the README promises', () => {
    const ids = WALLET_CATALOG.map((wallet) => wallet.id);
    for (const id of [
      'phantom',
      'solflare',
      'backpack',
      'coinbase',
      'okx',
      'trust',
      'exodus',
      'glow',
      'atomic',
      'venly',
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('planEscape', () => {
  const href = 'https://app.example.com/c/abc';
  const origin = 'https://app.example.com';

  it('offers wallet links and a Chrome escape inside the Discord Android webview', () => {
    const route = planEscape({
      environment: detectEnvironment(UA.discordAndroid),
      href,
      origin,
    });
    expect(route.needed).toBe(true);
    expect(route.wallets.map((w) => w.id)).toEqual([
      'phantom',
      'solflare',
      'backpack',
      'coinbase',
      'okx',
      'trust',
    ]);
    expect(route.chromeIntent).toContain('com.android.chrome');
  });

  it('offers wallet links but no Chrome intent on iOS', () => {
    const route = planEscape({ environment: detectEnvironment(UA.discordIOS), href, origin });
    expect(route.needed).toBe(true);
    expect(route.chromeIntent).toBeUndefined();
    // Trust drops out here and nowhere else: its iOS build has no dapp browser.
    expect(route.wallets.map((w) => w.id)).toEqual([
      'phantom',
      'solflare',
      'backpack',
      'coinbase',
      'okx',
    ]);
  });

  it('stays out of the way inside a wallet browser', () => {
    const route = planEscape({ environment: detectEnvironment(UA.phantomIOS), href, origin });
    expect(route.needed).toBe(false);
    expect(route.wallets).toEqual([]);
  });

  it('offers nothing on desktop, where the fix is installing an extension', () => {
    const route = planEscape({ environment: detectEnvironment(UA.chromeDesktop), href, origin });
    expect(route.needed).toBe(false);
  });

  it('still offers deeplinks in a plain mobile browser with no wallet', () => {
    const route = planEscape({ environment: detectEnvironment(UA.safariIOS), href, origin });
    expect(route.needed).toBe(true);
    expect(route.wallets.length).toBeGreaterThan(0);
  });
});
