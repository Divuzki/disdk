/**
 * npm entry point.
 *
 * Wires Mobile Wallet Adapter to the optional dependency, so bundlers resolve
 * it normally and it is only fetched when an Android visitor actually needs it.
 * The CDN build (`src/global.ts`) wires a runtime URL instead, keeping the
 * drop-in script small.
 */

import { setMwaLoader, type MwaModule } from './wallets.js';

export * from './public.js';

setMwaLoader(
  () => import('@solana-mobile/wallet-standard-mobile') as unknown as Promise<MwaModule>,
);
