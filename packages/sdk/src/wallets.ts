/**
 * Wallet discovery via the Wallet Standard.
 *
 * Every current Solana wallet — Phantom, Solflare, Backpack, Coinbase, Trust,
 * OKX, Exodus, Glow, Atomic and the rest — announces itself through the Wallet
 * Standard, so there is no per-wallet adapter here. Mobile Wallet Adapter
 * registers through the same mechanism, so Android phones appear in the same
 * list as desktop extensions.
 *
 * `catalog.ts` names those wallets, but only for the jobs discovery cannot do:
 * recognising a wallet's own in-app browser, linking into it, and pointing a
 * bare desktop browser at a download. Nothing on this path consults it.
 */

import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
} from '@wallet-standard/features';
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import { DisdkError, type Cluster } from '@disdk/protocol';

export interface DiscoveredWallet {
  wallet: Wallet;
  name: string;
  icon: string;
  /** The preferred path: the wallet signs and broadcasts in one step. */
  supportsSignAndSend: boolean;
  /** The fallback: the wallet returns signed bytes for the server to broadcast. */
  supportsSignTransaction: boolean;
}

function hasFeature(wallet: Wallet, name: string): boolean {
  return name in wallet.features;
}

export function describeWallet(wallet: Wallet): DiscoveredWallet | null {
  // A wallet is only usable here if it can connect and can sign a transaction
  // one way or the other.
  if (!hasFeature(wallet, StandardConnect)) return null;

  const supportsSignAndSend = hasFeature(wallet, SolanaSignAndSendTransaction);
  const supportsSignTransaction = hasFeature(wallet, SolanaSignTransaction);
  if (!supportsSignAndSend && !supportsSignTransaction) return null;

  return {
    wallet,
    name: wallet.name,
    icon: wallet.icon,
    supportsSignAndSend,
    supportsSignTransaction,
  };
}

export function supportsChain(wallet: Wallet, chain: Cluster): boolean {
  return (wallet.chains as readonly string[]).includes(chain);
}

export function listWallets(chain: Cluster): DiscoveredWallet[] {
  const { get } = getWallets();
  return get()
    .filter((wallet) => supportsChain(wallet, chain))
    .map(describeWallet)
    .filter((entry): entry is DiscoveredWallet => entry !== null);
}

/**
 * Subscribe to the wallet list.
 *
 * Wallets register asynchronously — an extension may inject itself after the
 * page has already run its scripts — so reading the list once is a classic way
 * to show "no wallets found" on a machine that has three. The callback fires
 * immediately with whatever is present, then again on every registration.
 */
export function watchWallets(
  chain: Cluster,
  onChange: (wallets: DiscoveredWallet[]) => void,
): () => void {
  const { on } = getWallets();
  const emit = () => onChange(listWallets(chain));

  emit();
  const unsubscribeRegister = on('register', emit);
  const unsubscribeUnregister = on('unregister', emit);

  return () => {
    unsubscribeRegister();
    unsubscribeUnregister();
  };
}

export interface MwaOptions {
  appName: string;
  appUri: string;
  appIcon?: string;
  chain: Cluster;
  /**
   * Enables the desktop QR flow, where a phone wallet signs for a desktop
   * browser. Requires a reflector host provided by the Solana Mobile stack.
   */
  remoteHostAuthority?: string;
}

/** Shape of `@solana-mobile/wallet-standard-mobile`, loaded on demand. */
export interface MwaModule {
  registerMwa(config: Record<string, unknown>): void;
  createDefaultChainSelector(): unknown;
  createDefaultAuthorizationCache(): unknown;
  createDefaultWalletNotFoundHandler(): unknown;
}

export type MwaLoader = () => Promise<MwaModule>;

let mwaLoader: MwaLoader | null = null;
let mwaRegistered = false;

/**
 * Choose how the Mobile Wallet Adapter package is obtained.
 *
 * The npm entry point wires the optional dependency directly. The CDN bundle
 * wires a runtime URL instead, which keeps ~150 KB of Android-only code —
 * and a QR library — out of the drop-in script that every desktop visitor
 * downloads.
 */
export function setMwaLoader(loader: MwaLoader | null): void {
  mwaLoader = loader;
}

/**
 * Register Mobile Wallet Adapter so Android wallets show up as ordinary entries
 * in the picker. Loaded on demand: desktop users never fetch it.
 */
export async function registerMobileWalletAdapter(options: MwaOptions): Promise<boolean> {
  if (mwaRegistered) return true;
  if (!mwaLoader) return false;

  try {
    const mobile = await mwaLoader();
    const config: Record<string, unknown> = {
      appIdentity: {
        name: options.appName,
        uri: options.appUri,
        ...(options.appIcon ? { icon: options.appIcon } : {}),
      },
      chains: [options.chain],
      chainSelector: mobile.createDefaultChainSelector(),
      authorizationCache: mobile.createDefaultAuthorizationCache(),
      onWalletNotFound: mobile.createDefaultWalletNotFoundHandler(),
    };
    if (options.remoteHostAuthority) {
      config.remoteHostAuthority = options.remoteHostAuthority;
    }

    mobile.registerMwa(config);
    mwaRegistered = true;
    return true;
  } catch {
    // The package is absent, or MWA cannot serve this browser. Not fatal:
    // extension wallets and the deeplink fallback still work.
    return false;
  }
}

export async function connectWallet(
  entry: DiscoveredWallet,
  chain: Cluster,
): Promise<WalletAccount> {
  const feature = entry.wallet.features[StandardConnect] as
    | StandardConnectFeature[typeof StandardConnect]
    | undefined;

  if (!feature) {
    throw new DisdkError('UNSUPPORTED_WALLET', `${entry.name} cannot connect.`);
  }

  let accounts: readonly WalletAccount[];
  try {
    ({ accounts } = await feature.connect());
  } catch (error) {
    throw toWalletError(error, `${entry.name} did not connect.`);
  }

  const usable = accounts.find((account) =>
    (account.chains as readonly string[]).includes(chain),
  ) ?? accounts[0];

  if (!usable) {
    throw new DisdkError('WALLET_REJECTED', `${entry.name} returned no accounts.`);
  }

  return usable;
}

export async function disconnectWallet(entry: DiscoveredWallet): Promise<void> {
  const feature = entry.wallet.features[StandardDisconnect] as
    | StandardDisconnectFeature[typeof StandardDisconnect]
    | undefined;
  try {
    await feature?.disconnect();
  } catch {
    // Disconnect is advisory; a wallet refusing it should not surface an error.
  }
}

/** Subscribe to wallet-side account changes (user switches account or locks up). */
export function onWalletChange(entry: DiscoveredWallet, handler: () => void): () => void {
  const events = entry.wallet.features[StandardEvents] as
    | { on(event: 'change', listener: () => void): () => void }
    | undefined;
  return events?.on('change', handler) ?? (() => {});
}

export function toWalletError(error: unknown, fallback: string): DisdkError {
  if (error instanceof DisdkError) return error;

  const message = error instanceof Error ? error.message : String(error);
  // Wallets signal user cancellation in a variety of ways; treat them all as a
  // deliberate decline rather than a failure to report.
  if (/reject|denied|declin|cancel|user close/i.test(message)) {
    return new DisdkError('WALLET_REJECTED', 'You declined the request in your wallet.');
  }
  return new DisdkError('NETWORK_ERROR', `${fallback} ${message}`.trim());
}

export type { Wallet, WalletAccount };
export { SolanaSignAndSendTransaction, SolanaSignTransaction };
export type { SolanaSignAndSendTransactionFeature, SolanaSignTransactionFeature };
