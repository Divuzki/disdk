import { describe, expect, it } from 'vitest';
import { detectEnvironment, inAppBrowserName } from '../src/environment.js';
import {
  chromeIntentLink,
  phantomBrowseLink,
  planEscape,
  solflareBrowseLink,
} from '../src/deeplinks.js';

// Real user-agent strings, since this whole module is UA pattern matching.
const UA = {
  discordIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Discord/220.0',
  discordAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Discord/220.0',
  phantomIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Phantom/24.0',
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

  it('builds an Android intent that reopens the page in Chrome', () => {
    const link = chromeIntentLink(href);
    expect(link).toBe(
      'intent://app.example.com/connect?ds=abc123XYZ_-#Intent;scheme=https;package=com.android.chrome;end',
    );
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
    expect(route.wallets.map((w) => w.id)).toEqual(['phantom', 'solflare', 'backpack']);
    expect(route.chromeIntent).toContain('com.android.chrome');
  });

  it('offers wallet links but no Chrome intent on iOS', () => {
    const route = planEscape({ environment: detectEnvironment(UA.discordIOS), href, origin });
    expect(route.needed).toBe(true);
    expect(route.chromeIntent).toBeUndefined();
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
