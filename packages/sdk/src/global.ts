/**
 * CDN entry point.
 *
 * Exposes the API on `window.Disdk` and, when the script tag carries
 * `data-disdk-auto`, wires up the connect button immediately so a page needs no
 * JavaScript of its own.
 *
 * Mobile Wallet Adapter is fetched from a URL at runtime rather than bundled.
 * It is Android-only and pulls in a QR encoder and a second copy of the Solana
 * codecs, which would roughly quadruple this file for every desktop visitor who
 * will never use it. Override with `data-mwa-url`, or switch it off with
 * `data-mwa="off"`.
 */

import { autoAttach, readScriptConfig } from './autoattach.js';
import { createDisdk, readSessionIdFromUrl } from './core.js';
import { setMwaLoader, type MwaModule } from './wallets.js';
import * as api from './public.js';

export const DEFAULT_MWA_URL =
  'https://cdn.jsdelivr.net/npm/@solana-mobile/wallet-standard-mobile@0.5.3/+esm';

const globalApi = {
  ...api,
  /** Set when the script tag auto-initialised, so the page can reuse the instance. */
  instance: null as ReturnType<typeof createDisdk> | null,
};

declare global {
  interface Window {
    Disdk: typeof globalApi;
  }
}

window.Disdk = globalApi;

const script = document.currentScript;
const mwaSetting =
  script instanceof HTMLScriptElement ? script.getAttribute('data-mwa') : null;

if (mwaSetting !== 'off') {
  const url =
    (script instanceof HTMLScriptElement ? script.getAttribute('data-mwa-url') : null) ??
    DEFAULT_MWA_URL;
  // Held in a variable so bundlers treat it as a runtime import and leave the
  // module out of this file.
  setMwaLoader(() => import(/* @vite-ignore */ /* webpackIgnore: true */ url) as Promise<MwaModule>);
}

const config = readScriptConfig(script);
if (config) {
  const { disdk } = autoAttach(config);
  globalApi.instance = disdk;
}

export { createDisdk, readSessionIdFromUrl, autoAttach };
