/**
 * Shared wire contract between the browser SDK, the server, and the verifier.
 *
 * This package intentionally has zero runtime dependencies: it is imported by
 * `@disdk/sdk`, which ships as a CDN bundle where every byte is visible to the
 * integrating page.
 */

export const DISDK_PROTOCOL_VERSION = 1;

/** Wallet Standard chain identifiers this project supports. */
export type Cluster = 'solana:mainnet' | 'solana:devnet';

export const CLUSTERS: readonly Cluster[] = ['solana:mainnet', 'solana:devnet'];

/**
 * Well-known USDC mints. Re-verify before pointing a deployment at mainnet —
 * an incorrect mint here means approving an allowance on the wrong token.
 */
export const USDC_MINTS: Record<Cluster, string> = {
  'solana:mainnet': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'solana:devnet': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

export const USDC_DECIMALS = 6;

/** Largest value an SPL token amount can hold; used by the `unlimited` strategy. */
export const U64_MAX = 18446744073709551615n;

// ---------------------------------------------------------------------------
// Allowance sizing
// ---------------------------------------------------------------------------

/**
 * How large an allowance to grant.
 *
 * An SPL delegate allowance is a fixed u64 recorded on the token account — it
 * does not track the balance. `percentOfBalance` therefore resolves against the
 * balance read at build time and goes stale as the owner deposits more, which
 * is why the re-approve flow exists.
 */
export type AmountStrategy =
  | { kind: 'percentOfBalance'; percent: number }
  | { kind: 'fixed'; amount: string }
  | { kind: 'unlimited' };

export type SessionState =
  | 'pending'
  | 'connected'
  | 'awaiting_signature'
  | 'submitted'
  | 'complete'
  | 'expired'
  | 'failed';

export type SessionIntent = 'permit' | 'reapprove' | 'revoke';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DisdkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_ALREADY_COMPLETE'
  | 'INVALID_REQUEST'
  | 'INVALID_PUBLIC_KEY'
  | 'INSUFFICIENT_BALANCE'
  | 'AMOUNT_TOO_SMALL'
  | 'TRANSACTION_MISMATCH'
  | 'TRANSACTION_EXPIRED'
  | 'SUBMIT_FAILED'
  | 'ON_CHAIN_VERIFY_FAILED'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'NO_WALLET_FOUND'
  | 'WALLET_REJECTED'
  | 'UNSUPPORTED_WALLET'
  | 'UNSAFE_TRANSACTION'
  | 'NETWORK_ERROR'
  | 'INTERNAL_ERROR';

export interface DisdkErrorBody {
  error: DisdkErrorCode;
  message: string;
  /** Present on retryable failures such as an expired blockhash. */
  retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Session payloads
// ---------------------------------------------------------------------------

export interface DiscordIdentity {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  guildName?: string;
}

/** App metadata shown in the wallet picker so the user knows who is asking. */
export interface AppIdentity {
  name: string;
  uri: string;
  iconUrl?: string;
}

/**
 * The public view of a session. Returned to any holder of the session id, so it
 * must never carry the sponsor key, the bot secret, or the Discord interaction
 * token.
 */
export interface SessionPublic {
  protocolVersion: number;
  sessionId: string;
  state: SessionState;
  intent: SessionIntent;
  cluster: Cluster;
  app: AppIdentity;
  discord: DiscordIdentity;
  /** Server-configured. The client cannot influence any of these. */
  mint: string;
  mintSymbol: string;
  decimals: number;
  delegate: string;
  /** Human-readable description of the allowance policy, e.g. "80% of your USDC balance". */
  allowanceDescription: string;
  expiresAt: string;
  /** Set once the flow has completed successfully. */
  signature?: string;
  /** Base-unit allowance actually granted, set once complete. */
  approvedAmount?: string;
}

export interface ConnectRequest {
  publicKey: string;
}

export interface ConnectResponse {
  /** Base64 transaction, already partially signed by the sponsor fee payer. */
  transaction: string;
  /** Base-unit amount encoded in the transaction. The SDK verifies this against the bytes. */
  amount: string;
  /** Formatted for display, e.g. "40.00". */
  amountUi: string;
  /** Owner balance the amount was resolved against, in base units. */
  balanceAtBuild: string;
  mint: string;
  decimals: number;
  delegate: string;
  feePayer: string;
  owner: string;
  /** Blockhash validity horizon. Past this the transaction must be rebuilt. */
  expiresAt: string;
}

export interface SubmitRequest {
  /** Base64 transaction carrying both sponsor and owner signatures. */
  signedTransaction: string;
}

export interface ConfirmRequest {
  /** Signature returned by a wallet that broadcast the transaction itself. */
  signature: string;
}

export interface CompleteResponse {
  signature: string;
  amount: string;
  amountUi: string;
  delegate: string;
  explorerUrl: string;
}

export interface PermitStatus {
  owner: string;
  mint: string;
  decimals: number;
  /** Delegate currently recorded on the token account, if any. */
  delegate: string | null;
  /** Allowance remaining on the token account, in base units. */
  delegatedAmount: string;
  /** Current token balance, in base units. */
  balance: string;
  /** True when the allowance no longer covers the configured share of the balance. */
  stale: boolean;
  /** Fraction of the current balance the allowance still covers, 0..1. */
  coverage: number;
}

export interface CreateSessionRequest {
  discord: DiscordIdentity;
  intent?: SessionIntent;
  /** Discord interaction token, so the bot can edit its original reply on completion. */
  interactionToken?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  url: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------
//
// Hand-written rather than schema-library-based to keep the SDK dependency-free.

export class DisdkError extends Error {
  readonly code: DisdkErrorCode;
  readonly retryable: boolean;

  constructor(code: DisdkErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'DisdkError';
    this.code = code;
    this.retryable = retryable;
  }

  toBody(): DisdkErrorBody {
    return { error: this.code, message: this.message, retryable: this.retryable };
  }
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Cheap shape check. Real validation happens when the address is decoded on the server. */
export function isLikelyBase58Address(value: unknown): value is string {
  return typeof value === 'string' && BASE58_RE.test(value);
}

export function isBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

export function isCluster(value: unknown): value is Cluster {
  return CLUSTERS.includes(value as Cluster);
}

export function assertConnectRequest(body: unknown): ConnectRequest {
  const record = asRecord(body);
  if (!isLikelyBase58Address(record.publicKey)) {
    throw new DisdkError('INVALID_PUBLIC_KEY', 'publicKey must be a base58 Solana address');
  }
  return { publicKey: record.publicKey };
}

export function assertSubmitRequest(body: unknown): SubmitRequest {
  const record = asRecord(body);
  if (!isBase64(record.signedTransaction)) {
    throw new DisdkError('INVALID_REQUEST', 'signedTransaction must be a base64 string');
  }
  return { signedTransaction: record.signedTransaction };
}

export function assertConfirmRequest(body: unknown): ConfirmRequest {
  const record = asRecord(body);
  // Transaction signatures are 64 bytes, which is 87-88 base58 characters.
  if (typeof record.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(record.signature)) {
    throw new DisdkError('INVALID_REQUEST', 'signature must be a base58 transaction signature');
  }
  return { signature: record.signature };
}

export function assertCreateSessionRequest(body: unknown): CreateSessionRequest {
  const record = asRecord(body);
  const discord = asRecord(record.discord);
  if (typeof discord.id !== 'string' || discord.id.length === 0) {
    throw new DisdkError('INVALID_REQUEST', 'discord.id is required');
  }
  if (typeof discord.username !== 'string' || discord.username.length === 0) {
    throw new DisdkError('INVALID_REQUEST', 'discord.username is required');
  }
  const intent = record.intent;
  if (intent !== undefined && intent !== 'permit' && intent !== 'reapprove' && intent !== 'revoke') {
    throw new DisdkError('INVALID_REQUEST', 'intent must be permit, reapprove, or revoke');
  }
  return {
    discord: {
      id: discord.id,
      username: discord.username,
      displayName: typeof discord.displayName === 'string' ? discord.displayName : undefined,
      avatarUrl: typeof discord.avatarUrl === 'string' ? discord.avatarUrl : undefined,
      guildName: typeof discord.guildName === 'string' ? discord.guildName : undefined,
    },
    intent: (intent as SessionIntent | undefined) ?? 'permit',
    interactionToken:
      typeof record.interactionToken === 'string' ? record.interactionToken : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DisdkError('INVALID_REQUEST', 'expected a JSON object body');
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Amount formatting
// ---------------------------------------------------------------------------

/** Format a base-unit amount for display, trimming trailing zeros past 2 decimals. */
export function formatTokenAmount(baseUnits: bigint, decimals: number): string {
  if (baseUnits >= U64_MAX) return 'Unlimited';
  const divisor = 10n ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const fraction = baseUnits % divisor;

  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimals === 0) return groupedWhole;

  let fractionStr = fraction.toString().padStart(decimals, '0');
  // Keep at least 2 decimal places, drop insignificant trailing zeros beyond that.
  fractionStr = fractionStr.replace(/0+$/, '');
  while (fractionStr.length < 2) fractionStr += '0';

  return `${groupedWhole}.${fractionStr}`;
}

/** Parse a decimal string such as "12.5" into base units. Throws on bad input. */
export function parseTokenAmount(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) {
    throw new DisdkError('INVALID_REQUEST', `"${value}" is not a valid token amount`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || '0');
}

/** Human-readable summary of an allowance policy, shown in the wallet picker. */
export function describeStrategy(strategy: AmountStrategy, symbol: string, decimals: number): string {
  switch (strategy.kind) {
    case 'unlimited':
      return `an unlimited ${symbol} allowance (covers future deposits too)`;
    case 'fixed':
      return `${formatTokenAmount(BigInt(strategy.amount), decimals)} ${symbol}`;
    case 'percentOfBalance':
      return `${Math.round(strategy.percent * 100)}% of your ${symbol} balance`;
  }
}

export function explorerUrl(signature: string, cluster: Cluster): string {
  const suffix = cluster === 'solana:devnet' ? '?cluster=devnet' : '';
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}
