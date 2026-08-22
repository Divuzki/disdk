/**
 * Where is this page running?
 *
 * The link posted in Discord is an ordinary https URL and the expected path is
 * a real browser: a desktop extension wallet, or mobile Chrome where Mobile
 * Wallet Adapter is available. This module exists to recognise the one case a
 * browser cannot serve — an embedded webview, where no wallet can ever inject
 * itself — so the UI can offer a way out instead of showing an empty list.
 */

import { WALLET_BROWSER_PATTERN } from './catalog.js';

export type Platform = 'ios' | 'android' | 'desktop' | 'unknown';

export interface Environment {
  platform: Platform;
  isMobile: boolean;
  /** Any embedded webview: Discord, Twitter, Instagram, Slack, and friends. */
  isInAppBrowser: boolean;
  /** Discord's webview specifically, the one this project cares about. */
  isDiscordBrowser: boolean;
  /**
   * True inside a wallet's own in-app browser, where injection does work. The
   * wallets recognised here are the ones listed in `catalog.ts`.
   */
  isWalletBrowser: boolean;
}

const IN_APP_PATTERNS: Array<[RegExp, string]> = [
  [/Discord/i, 'discord'],
  [/FBAN|FBAV|FB_IAB/i, 'facebook'],
  [/Instagram/i, 'instagram'],
  [/Twitter/i, 'twitter'],
  [/Line\//i, 'line'],
  [/Slack/i, 'slack'],
  [/Telegram/i, 'telegram'],
];

export function detectEnvironment(userAgent: string = navigatorUserAgent()): Environment {
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
  // iPadOS 13+ reports as a Mac; the touch-point count is the usual giveaway.
  const isIPadDesktopUA =
    /Macintosh/i.test(userAgent) &&
    typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints ?? 0) > 1;
  const isAndroid = /Android/i.test(userAgent);

  const platform: Platform = isIOS || isIPadDesktopUA
    ? 'ios'
    : isAndroid
      ? 'android'
      : /Windows|Macintosh|Linux|CrOS/i.test(userAgent)
        ? 'desktop'
        : 'unknown';

  const isWalletBrowser = WALLET_BROWSER_PATTERN.test(userAgent);
  const isDiscordBrowser = /Discord/i.test(userAgent);
  const isInAppBrowser =
    !isWalletBrowser && IN_APP_PATTERNS.some(([pattern]) => pattern.test(userAgent));

  return {
    platform,
    isMobile: platform === 'ios' || platform === 'android',
    isInAppBrowser,
    isDiscordBrowser,
    isWalletBrowser,
  };
}

function navigatorUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

/** Name of the embedded app, for a message like "Discord's browser can't...". */
export function inAppBrowserName(userAgent: string = navigatorUserAgent()): string | null {
  if (WALLET_BROWSER_PATTERN.test(userAgent)) return null;
  for (const [pattern, name] of IN_APP_PATTERNS) {
    if (pattern.test(userAgent)) return name;
  }
  return null;
}
