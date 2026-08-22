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

export { resolveChainFacts } from './resolve.js';
export type { ResolvedChainFacts, ResolveOptions } from './resolve.js';

export {
  decodeTransaction,
  inspectTransaction,
  verifyChargeTransaction,
  verifySettlementTransaction,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
  SYSTEM_PROGRAM,
} from './txguard.js';
export type {
  AddressTableLookup,
  DecodedTransaction,
  ChargeExpectation,
  LookupResolver,
  SettlementExpectation,
  SolTransferDetails,
  TransactionInspection,
  VerifiedCharge,
  VerifiedSettlement,
} from './txguard.js';

export { detectEnvironment, inAppBrowserName } from './environment.js';
export type { Environment, Platform } from './environment.js';

export {
  planEscape,
  buildDeeplinks,
  phantomBrowseLink,
  solflareBrowseLink,
  backpackBrowseLink,
  trustBrowseLink,
  coinbaseBrowseLink,
  okxBrowseLink,
  chromeIntentLink,
} from './deeplinks.js';
export type { EscapeRoute, WalletDeeplink } from './deeplinks.js';

export {
  WALLET_CATALOG,
  WALLET_BROWSER_PATTERN,
  browsableWallets,
  installableWallets,
  suggestableWallets,
  isSameWallet,
  findWallet,
} from './catalog.js';
export type { WalletConnectivity, WalletProfile } from './catalog.js';

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
  Cluster,
  CompleteResponse,
  ConnectResponse,
  DisdkErrorCode,
  SessionPublic,
  SettlementCompleteResponse,
  SettlementConnectResponse,
  SettlementManifest,
  SettlementObligation,
} from '@disdk/protocol';
