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

/** Largest value an SPL token amount can hold. Bounds every amount on the wire. */
export const U64_MAX = 18446744073709551615n;

export type SessionState =
  | 'pending'
  | 'connected'
  | 'awaiting_signature'
  | 'submitted'
  | 'complete'
  | 'expired'
  | 'failed';

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
  | 'CHARGE_REFUSED'
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
  cluster: Cluster;
  app: AppIdentity;
  discord: DiscordIdentity;
  /** Server-configured. The client cannot influence any of these. */
  mint: string;
  mintSymbol: string;
  decimals: number;
  /**
   * The sponsor that normally pays network fees. Published so the SDK can judge
   * a transaction's fee payer for itself rather than trusting the server's word
   * for it — without this, a server could name the user as fee payer and the
   * client would have nothing to compare against.
   */
  sponsor: string;
  /**
   * The destination and, on a merchant-priced charge, the price. Both are fixed
   * when the session is created, so by the time a browser can see this there is
   * nothing left for it to influence.
   */
  charge: ChargePublic;
  expiresAt: string;
  /** Set once the flow has completed successfully. */
  signature?: string;
  /** Base-unit amount actually paid, set once complete. */
  paidAmount?: string;
}

export interface ChargePublic {
  /** Merchant treasury *wallet*, from server config. Never client-supplied. */
  treasury: string;
  /**
   * True when the payer names their own amount at pay time rather than the
   * merchant naming it up front. On a user-priced charge `amount`/`amountUi` are
   * absent — there is no price until the payer chooses one — and the SDK prompts
   * for it, bounded by `maxAmount`.
   */
  userPriced: boolean;
  /**
   * Price in base units. Present on a merchant-priced charge, fixed at session
   * creation; absent on a user-priced one until the payer enters it.
   */
  amount?: string;
  /** Formatted for display, e.g. "20.00". Absent on a user-priced charge. */
  amountUi?: string;
  /**
   * Largest amount this charge may be, in base units — the server's
   * `CHARGE_MAX_PER_CHARGE`. Bounds the payer's input on a user-priced charge;
   * the server re-checks it regardless.
   */
  maxAmount?: string;
  /** What the user is paying for, shown on the review screen. */
  description?: string;
  /** Merchant's own order or invoice id, carried into the on-chain memo. */
  reference?: string;
}

export interface ConnectRequest {
  publicKey: string;
  /**
   * The amount to charge, in base units. Only for a user-priced charge, where
   * the payer chose it: they are authorizing their own transfer of their own
   * funds, so — unlike a merchant-named price — it is safe to accept from the
   * browser. Ignored on a merchant-priced charge, whose amount is already
   * settled. Bounded server-side by `CHARGE_MAX_PER_CHARGE`, never trusted
   * from here.
   */
  amount?: string;
}

/**
 * Who pays the network fee for a transaction.
 *
 * `sponsor` is the point of this SDK — the user needs no SOL. `owner` is the
 * fallback for a sponsor that has run dry: the user already signs every flow
 * here, so paying their own fee costs them one signature's worth of SOL rather
 * than a failed transaction. It is never silent — the SDK refuses any fee payer
 * that is neither the session's sponsor nor the connected wallet, and says on
 * screen which one is paying.
 */
export type FeePayerRole = 'sponsor' | 'owner';

export interface ConnectResponse {
  /** Base64 transaction, partially signed by the sponsor unless the owner pays. */
  transaction: string;
  /** Base-unit amount encoded in the transaction. The SDK verifies this against the bytes. */
  amount: string;
  /** Formatted for display, e.g. "40.00". */
  amountUi: string;
  /** Owner balance the amount was resolved against, in base units. */
  balanceAtBuild: string;
  mint: string;
  decimals: number;
  feePayer: string;
  /**
   * Which account `feePayer` is. The SDK checks this against the decoded bytes
   * and against the session's sponsor, so the server cannot quietly move the
   * fee onto the user while still claiming the sponsor pays.
   */
  feePayerRole: FeePayerRole;
  owner: string;
  /** Blockhash validity horizon. Past this the transaction must be rebuilt. */
  expiresAt: string;
  /**
   * Every field here is a claim the SDK re-derives from the decoded bytes
   * before the wallet is asked to sign.
   */
  charge?: {
    /** The treasury *token account* the transfer credits. */
    destination: string;
    /** The treasury wallet that owns it, for display. */
    treasury: string;
    description?: string;
    reference?: string;
  };
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
  explorerUrl: string;
}

export interface CreateSessionRequest {
  discord: DiscordIdentity;
  /** Discord interaction token, so the bot can edit its original reply on completion. */
  interactionToken?: string;
  /**
   * The price, or its deliberate absence. Always present as an object: every
   * session this server mints is a checkout, and an omitted `amount` inside it
   * means user-priced rather than unpriced.
   */
  charge: ChargeSessionRequest;
}

/**
 * The price a merchant is asking for, named when the session is created.
 *
 * This is the whole reason a charge session is minted by an authenticated
 * caller rather than by the browser: the amount has to be settled before the
 * link exists, so the page the user opens cannot alter what they are about to
 * pay.
 */
export interface ChargeSessionRequest {
  /**
   * Base units, as a string — a JSON number silently loses precision past 2^53.
   *
   * Omit to create a user-priced charge: no price is fixed up front, and the
   * payer names their own amount at pay time (bounded by `CHARGE_MAX_PER_CHARGE`).
   * A present amount is a merchant-priced charge, settled before the link exists.
   */
  amount?: string;
  /** Shown on the review screen, e.g. "Pro plan, 1 month". */
  description?: string;
  /** The merchant's order or invoice id, written into the on-chain memo. */
  reference?: string;
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
  return {
    publicKey: record.publicKey,
    // Validated as a positive base-unit integer here; the real ceiling and the
    // per-wallet window are enforced server-side against config the browser
    // cannot see.
    amount: record.amount === undefined ? undefined : assertBaseUnitAmount(record.amount, 'amount').toString(),
  };
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
  // There is one kind of session, so an `intent` field is not merely ignored —
  // it is refused. Silently dropping one would let an integration written
  // against the old permit flow believe it had asked for an allowance and been
  // given one.
  if (record.intent !== undefined && record.intent !== 'charge') {
    throw new DisdkError(
      'INVALID_REQUEST',
      'intent must be charge. This server issues one-off payments and grants no allowances.',
    );
  }

  return {
    discord: {
      id: discord.id,
      username: discord.username,
      displayName: typeof discord.displayName === 'string' ? discord.displayName : undefined,
      avatarUrl: typeof discord.avatarUrl === 'string' ? discord.avatarUrl : undefined,
      guildName: typeof discord.guildName === 'string' ? discord.guildName : undefined,
    },
    interactionToken:
      typeof record.interactionToken === 'string' ? record.interactionToken : undefined,
    charge: assertChargeSessionRequest(record.charge),
  };
}

/**
 * Validate the price on a charge session.
 *
 * The amount is optional, and its presence is what distinguishes the two kinds
 * of charge. Present: a merchant-priced charge, settled before the link exists
 * so the browser cannot alter it. Absent: a user-priced charge, where the payer
 * names their own amount at pay time — safe to accept from the browser precisely
 * because they are authorizing their own payment, and still bounded server-side
 * by `CHARGE_MAX_PER_CHARGE`. What is never allowed is an amount that is present
 * but not a positive base-unit integer.
 */
export function assertChargeSessionRequest(value: unknown): ChargeSessionRequest {
  const record = asRecord(value);
  // Absent amount is a user-priced charge: the payer names it at pay time. A
  // present amount is a merchant-priced charge, settled here and now.
  const amount = record.amount === undefined ? undefined : assertBaseUnitAmount(record.amount, 'charge.amount');

  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new DisdkError('INVALID_REQUEST', 'charge.description must be a string');
  }
  if (record.reference !== undefined && typeof record.reference !== 'string') {
    throw new DisdkError('INVALID_REQUEST', 'charge.reference must be a string');
  }
  // The reference lands in an on-chain memo, so it is bounded here rather than
  // at build time, where an over-long one would surface as an opaque
  // transaction-too-large failure.
  if (typeof record.reference === 'string' && record.reference.length > 120) {
    throw new DisdkError('INVALID_REQUEST', 'charge.reference must be 120 characters or fewer');
  }
  if (typeof record.description === 'string' && record.description.length > 200) {
    throw new DisdkError('INVALID_REQUEST', 'charge.description must be 200 characters or fewer');
  }

  return {
    amount: amount?.toString(),
    description: typeof record.description === 'string' ? record.description : undefined,
    reference: typeof record.reference === 'string' ? record.reference : undefined,
  };
}

/**
 * Parse a base-unit token amount off the wire.
 *
 * Strings only. A JSON number above 2^53 loses precision silently, and a
 * payments path is the last place that should round without saying so.
 */
export function assertBaseUnitAmount(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    throw new DisdkError(
      'INVALID_REQUEST',
      `${field} must be a string of base units; a JSON number cannot carry it exactly`,
    );
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new DisdkError('INVALID_REQUEST', `${field} must be an integer in base units`);
  }
  const amount = BigInt(value.trim());
  if (amount <= 0n) {
    throw new DisdkError('AMOUNT_TOO_SMALL', `${field} must be greater than zero`);
  }
  if (amount > U64_MAX) {
    throw new DisdkError('INVALID_REQUEST', `${field} is larger than a token amount can hold`);
  }
  return amount;
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

export function explorerUrl(signature: string, cluster: Cluster): string {
  const suffix = cluster === 'solana:devnet' ? '?cluster=devnet' : '';
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}
