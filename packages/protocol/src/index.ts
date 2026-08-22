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
 * an incorrect mint here means taking payment in the wrong token.
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
  | 'INTERNAL_ERROR'
  // Batch settlement — see packages/verify/src/settlement.ts.
  | 'INVALID_SETTLEMENT'
  | 'SETTLEMENT_MISMATCH'
  | 'SETTLEMENT_EXPIRED'
  | 'UNSUPPORTED_TOKEN'
  | 'TRANSACTION_TOO_LARGE'
  | 'ALT_REQUIRED';

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

/**
 * Where a charge's amount comes from.
 *
 * `merchant` is a price settled before the link existed. `balanceShare` is a
 * share of whatever the payer holds at the moment they connect, capped — the
 * amount is not known to anyone until the wallet is known, and the payer is
 * shown the resolved figure, decoded from the transaction bytes, before signing.
 */
export type ChargePricing = 'merchant' | 'balanceShare';

/** The rule a `balanceShare` charge resolves through. */
export interface BalanceSharePublic {
  /** Fraction of the payer's balance, e.g. 0.8 for 80%. */
  percent: number;
  /** Hard ceiling in base units, applied after the share. */
  maxAmount: string;
}

export interface ChargePublic {
  /** Merchant treasury *wallet*, from server config. Never client-supplied. */
  treasury: string;
  /**
   * How this charge is priced. `merchant` carries `amount`/`amountUi` here,
   * fixed at session creation. `balanceShare` carries neither — there is no
   * figure until a wallet is connected and its balance read — and carries
   * {@link ChargePublic.share} instead, so the page can state the rule before
   * it can state the number.
   */
  pricing: ChargePricing;
  /**
   * Price in base units. Present on a merchant-priced charge only; a balance
   * share has no amount until the wallet is known.
   */
  amount?: string;
  /** Formatted for display, e.g. "20.00". Absent on a balance share. */
  amountUi?: string;
  /** The rule, on a balance share. Absent on a merchant-priced charge. */
  share?: BalanceSharePublic;
  /**
   * Largest amount this charge may be, in base units — the server's
   * `CHARGE_MAX_PER_CHARGE`. The server re-checks it regardless.
   */
  maxAmount?: string;
  /** What the user is paying for, shown on the review screen. */
  description?: string;
  /** Merchant's own order or invoice id, carried into the on-chain memo. */
  reference?: string;
}

/**
 * A connect request carries a wallet and nothing else.
 *
 * There is deliberately no amount here. Both pricings are settled server-side —
 * one before the link existed, the other from the balance the server reads at
 * build time — so there is no number a browser could send that the server would
 * be willing to use.
 */
export interface ConnectRequest {
  publicKey: string;
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
   * means priced from the payer's balance rather than not priced at all.
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
   * Omit to create a balance-share charge: no price is fixed up front, and the
   * amount becomes a configured share of what the payer holds when they connect
   * (bounded by `CHARGE_MAX_PER_CHARGE` and by the share's own cap). A present
   * amount is a merchant-priced charge, settled before the link exists.
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
// Batch settlement
// ---------------------------------------------------------------------------
//
// A settlement is several explicit obligations authorized by one signature. It
// is not a sweep: nothing here discovers assets and decides to move them. Every
// transfer in the resulting transaction traces back to an obligation the server
// wrote down before a wallet was ever connected, and the client re-derives that
// correspondence from the transaction bytes before signing.

/**
 * One thing the user is being asked to settle.
 *
 * `mint`, `decimals` and every amount are server-authoritative. `decimals` is
 * carried so the review screen can render a figure without a mint lookup, but
 * it is checked against the mint on chain before it is used to build anything —
 * a manifest cannot talk the builder into the wrong denomination.
 */
export type SettlementObligation =
  | {
      type: 'spl';
      mint: string;
      /** Integer base units, as a string. */
      amount: string;
      decimals: number;
    }
  | {
      type: 'sol';
      /** Lamports, as a string. */
      amount: string;
    };

/**
 * The complete, closed list of what one signature authorizes.
 *
 * Closed is the operative word: the verifier requires the transaction's
 * transfers to correspond one-for-one with these obligations, so an instruction
 * that is not here cannot ride along, and an obligation listed here cannot be
 * quietly dropped.
 */
export interface SettlementManifest {
  sessionId: string;
  owner: string;
  /** Server-configured destination wallet. Never client-supplied. */
  destination: string;
  obligations: SettlementObligation[];
  expiresAt: string;
  /**
   * Hash over the canonical form of everything above. Written into the on-chain
   * memo, so the manifest the user reviewed is bound to the transaction they
   * signed and to no other.
   */
  manifestHash: string;
}

/** What a batch obligation looks like when a merchant asks for the session. */
export type SettlementObligationRequest =
  | { type: 'spl'; mint: string; amount: string; decimals?: number }
  | { type: 'sol'; amount: string };

export interface CreateSettlementSessionRequest {
  discord: DiscordIdentity;
  interactionToken?: string;
  obligations: SettlementObligationRequest[];
  description?: string;
  reference?: string;
}

export interface SettlementConnectResponse {
  /** Base64 version-0 transaction, partially signed by the sponsor unless the owner pays. */
  transaction: string;
  manifest: SettlementManifest;
  /**
   * Lookup tables the compiled message actually references, empty when the batch
   * fit without them. The SDK fetches each one's contents itself rather than
   * trusting a resolved account list from the server.
   */
  addressLookupTables: string[];
  feePayer: string;
  feePayerRole: FeePayerRole;
  owner: string;
  /** Blockhash validity horizon. Past this the transaction must be rebuilt. */
  expiresAt: string;
  description?: string;
  reference?: string;
}

export interface SettlementCompleteResponse {
  signature: string;
  /** What actually settled, each with the figure it was shown as. */
  settled: (SettlementObligation & { amountUi: string })[];
  explorerUrl: string;
}

/**
 * How many obligations one settlement may carry.
 *
 * Not a packet-size limit — that is measured exactly at build time, against the
 * real encoder. This is the cheap upstream bound that stops a caller from
 * asking for ten thousand transfers and making the server do the arithmetic to
 * find out it cannot have them.
 */
export const MAX_SETTLEMENT_OBLIGATIONS = 24;

export function assertCreateSettlementSessionRequest(
  body: unknown,
): CreateSettlementSessionRequest {
  const record = asRecord(body);
  const discord = asRecord(record.discord);
  if (typeof discord.id !== 'string' || discord.id.length === 0) {
    throw new DisdkError('INVALID_REQUEST', 'discord.id is required');
  }
  if (typeof discord.username !== 'string' || discord.username.length === 0) {
    throw new DisdkError('INVALID_REQUEST', 'discord.username is required');
  }

  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new DisdkError('INVALID_REQUEST', 'description must be a string');
  }
  if (typeof record.description === 'string' && record.description.length > 200) {
    throw new DisdkError('INVALID_REQUEST', 'description must be 200 characters or fewer');
  }
  if (record.reference !== undefined && typeof record.reference !== 'string') {
    throw new DisdkError('INVALID_REQUEST', 'reference must be a string');
  }
  if (typeof record.reference === 'string' && record.reference.length > 120) {
    throw new DisdkError('INVALID_REQUEST', 'reference must be 120 characters or fewer');
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
    obligations: assertSettlementObligations(record.obligations),
    description: typeof record.description === 'string' ? record.description : undefined,
    reference: typeof record.reference === 'string' ? record.reference : undefined,
  };
}

/**
 * Validate a requested obligation list.
 *
 * An empty settlement is refused rather than treated as a no-op: "authorize
 * nothing" is never what anyone meant, and a signature prompt showing an empty
 * list is worse than an error at the point the mistake was made.
 */
export function assertSettlementObligations(value: unknown): SettlementObligationRequest[] {
  if (!Array.isArray(value)) {
    throw new DisdkError('INVALID_SETTLEMENT', 'obligations must be an array');
  }
  if (value.length === 0) {
    throw new DisdkError('INVALID_SETTLEMENT', 'a settlement must carry at least one obligation');
  }
  if (value.length > MAX_SETTLEMENT_OBLIGATIONS) {
    throw new DisdkError(
      'INVALID_SETTLEMENT',
      `a settlement may carry at most ${MAX_SETTLEMENT_OBLIGATIONS} obligations`,
    );
  }

  const seenMints = new Set<string>();
  let sawSol = false;

  return value.map((entry, index) => {
    const record = asRecord(entry);
    const field = `obligations[${index}]`;

    if (record.type === 'sol') {
      // Two SOL lines would compile to two System transfers the user has to
      // add up themselves. One obligation, one row on the review screen.
      if (sawSol) {
        throw new DisdkError('INVALID_SETTLEMENT', 'a settlement may carry at most one SOL obligation');
      }
      sawSol = true;
      return {
        type: 'sol' as const,
        amount: assertBaseUnitAmount(record.amount, `${field}.amount`).toString(),
      };
    }

    if (record.type !== 'spl') {
      throw new DisdkError('INVALID_SETTLEMENT', `${field}.type must be "spl" or "sol"`);
    }
    if (!isLikelyBase58Address(record.mint)) {
      throw new DisdkError('INVALID_SETTLEMENT', `${field}.mint must be a base58 Solana address`);
    }
    // The same mint twice is two transfers out of one token account. Legal on
    // chain, but on a consent screen it reads as one charge and settles as two.
    if (seenMints.has(record.mint)) {
      throw new DisdkError('INVALID_SETTLEMENT', `${field}.mint appears more than once`);
    }
    seenMints.add(record.mint);

    if (
      record.decimals !== undefined &&
      (typeof record.decimals !== 'number' ||
        !Number.isInteger(record.decimals) ||
        record.decimals < 0 ||
        record.decimals > 18)
    ) {
      throw new DisdkError('INVALID_SETTLEMENT', `${field}.decimals must be an integer 0-18`);
    }

    return {
      type: 'spl' as const,
      mint: record.mint,
      amount: assertBaseUnitAmount(record.amount, `${field}.amount`).toString(),
      decimals: typeof record.decimals === 'number' ? record.decimals : undefined,
    };
  });
}

/**
 * The bytes a manifest hash is taken over.
 *
 * Shared by the server that computes the hash and the client that re-computes
 * it, so the two cannot drift apart into a hash that always matches because
 * both sides derive it the same wrong way. Field order is fixed here and the
 * separator cannot appear in any field, so no two distinct manifests can
 * canonicalize to the same string.
 */
export function canonicalManifestPayload(
  manifest: Omit<SettlementManifest, 'manifestHash'>,
): string {
  const obligations = manifest.obligations
    .map((o) => (o.type === 'sol' ? `sol:${o.amount}` : `spl:${o.mint}:${o.amount}:${o.decimals}`))
    .join(',');

  return [
    `v${DISDK_PROTOCOL_VERSION}`,
    manifest.sessionId,
    manifest.owner,
    manifest.destination,
    manifest.expiresAt,
    obligations,
  ].join('|');
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
  // Any other field is dropped rather than read. An amount used to travel here
  // and no longer does; silently ignoring one a stale client still sends is
  // safer than either honouring it or failing a payment over it.
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
    // An absent charge object is a balance-share session, not a malformed one:
    // the amount is resolved from the payer's balance. Only a *present* but
    // invalid one is an error.
    charge: assertChargeSessionRequest(record.charge ?? {}),
  };
}

/**
 * Validate the price on a charge session.
 *
 * The amount is optional, and its presence is what distinguishes the two kinds
 * of charge. Present: a merchant-priced charge, settled before the link exists
 * so the browser cannot alter it. Absent: a balance-share charge, resolved
 * server-side from what the payer holds and bounded by `CHARGE_MAX_PER_CHARGE`
 * and the share's own cap. Neither kind takes a figure from the browser. What is
 * never allowed is an amount that is present but not a positive base-unit
 * integer.
 */
export function assertChargeSessionRequest(value: unknown): ChargeSessionRequest {
  const record = asRecord(value);
  // Absent amount is a balance-share charge, priced from the payer's balance at
  // connect time. A present amount is merchant-priced, settled here and now.
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
