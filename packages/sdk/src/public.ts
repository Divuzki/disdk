export { createDisdk, readSessionIdFromUrl } from './core.js';
export type { Disdk, DisdkConfig } from './core.js';

export { autoAttach, readScriptConfig, DEFAULT_SELECTOR } from './autoattach.js';
export type { AutoAttachOptions } from './autoattach.js';

export { DisdkApi } from './api.js';
export type { DisdkEventMap, DisdkState } from './events.js';

export {
  listWallets,
  watchWallets,
  connectWallet,
  disconnectWallet,
  registerMobileWalletAdapter,
  setMwaLoader,
} from './wallets.js';
export type { DiscoveredWallet, MwaLoader, MwaModule, Wallet, WalletAccount } from './wallets.js';

export { signSponsoredTransaction } from './signing.js';
export type { SignOutcome } from './signing.js';

export {
  decodeTransaction,
  inspectTransaction,
  verifyPermitTransaction,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
} from './txguard.js';
export type {
  ApproveDetails,
  DecodedTransaction,
  PermitExpectation,
  TransactionInspection,
  VerifiedPermit,
} from './txguard.js';

export { detectEnvironment, inAppBrowserName } from './environment.js';
export type { Environment, Platform } from './environment.js';

export {
  planEscape,
  buildDeeplinks,
  phantomBrowseLink,
  solflareBrowseLink,
  backpackBrowseLink,
  chromeIntentLink,
} from './deeplinks.js';
export type { EscapeRoute, WalletDeeplink } from './deeplinks.js';

export { base58Encode, base58Decode, base64Encode, base64Decode } from './codec.js';

export { DisdkModal } from './ui/modal.js';
export type { Theme } from './ui/modal.js';

export {
  DisdkError,
  formatTokenAmount,
  parseTokenAmount,
  explorerUrl,
  USDC_MINTS,
  USDC_DECIMALS,
  U64_MAX,
} from '@disdk/protocol';
export type {
  AmountStrategy,
  Cluster,
  CompleteResponse,
  ConnectResponse,
  DisdkErrorCode,
  PermitStatus,
  SessionPublic,
} from '@disdk/protocol';
