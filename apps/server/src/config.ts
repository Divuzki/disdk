import {
  DisdkError,
  USDC_DECIMALS,
  USDC_MINTS,
  USDT_DECIMALS,
  USDT_MINTS,
  isCluster,
  type ChargeToken,
  type Cluster,
} from '@disdk/protocol';
import { address, type Address, type KeyPairSigner } from '@solana/kit';
import {
  describeTerms,
  loadSponsorSigner,
  parseAltAddresses,
  parseBalanceShare,
  parseChargeTerms,
  type BalanceShare,
  type ChargeTerms,
} from '@disdk/verify';

export interface AcceptedToken {
  mint: Address;
  symbol: string;
  decimals: number;
}

export interface ServerConfig {
  port: number;
  /** Where the connect page is served from. Session links point here. */
  appOrigin: string;
  appName: string;
  appIconUrl?: string;

  cluster: Cluster;
  rpcUrl: string;

  /** The default charge token — USDC's mint, symbol and decimals. */
  mint: Address;
  mintSymbol: string;
  decimals: number;
  /**
   * Stablecoins this deployment will charge in, keyed by the symbol a session
   * names in `charge.token`. USDC is always present. USDT is present only when
   * `USDT_MINT` resolves to something — the mainnet default, or an explicit
   * env override — so a session naming USDT fails at creation, not at connect
   * time, when this deployment has no mint configured for it.
   */
  acceptedTokens: Partial<Record<ChargeToken, AcceptedToken>> & { USDC: AcceptedToken };
  sponsor: KeyPairSigner;

  /**
   * Let the connecting wallet pay its own network fee when the sponsor cannot.
   *
   * Off by default, and deliberately so: "the user needs no SOL" is the premise
   * of this SDK, and a deployment that quietly starts charging users for fees
   * has changed its bargain with them. On, a dry sponsor degrades to a working
   * transaction the user pays for instead of a failure — which the SDK states
   * on the review screen before anything is signed.
   */
  feePayerFallback: boolean;
  /** Balance below which the sponsor is considered unable to pay, in lamports. */
  sponsorMinLamports?: bigint;

  /**
   * Priority fee bid, in micro-lamports per compute unit.
   *
   * Unset means no bid, which is fine on a quiet cluster and a liability on
   * mainnet: under congestion a transaction with no priority fee can sit until
   * its blockhash expires and the user sees it simply fail.
   */
  priorityFeeMicroLamports?: bigint;
  /** Compute unit limit, so the priority bid is not spread over unused units. */
  computeUnitLimit?: number;

  sessionTtlMs: number;
  botApiSecret: string;
  corsOrigins: string[];

  /**
   * Let the connect page mint its own session, with no Discord identity behind
   * it. Convenient for a demo or a non-Discord integration; off by default,
   * because a real deployment wants the link to prove who is asking.
   *
   * A session minted this way never carries a merchant price. Nobody
   * authenticated the caller, so no price it named could be trusted; it is
   * priced as a share of the payer's balance like any other unpriced session.
   */
  allowAnonymousSessions: boolean;

  /**
   * User-signed checkout. Not optional: it is the only thing this server does.
   *
   * A charge with nowhere to settle is not a half-working feature — it is a
   * request to invent a destination, which is the one thing this codebase never
   * does with money. So `TREASURY_ADDRESS` is required to boot.
   */
  charge: ChargeSettings;

  /**
   * Batch settlement, alongside the single charge rather than instead of it.
   *
   * Optional in a way the charge is not: a deployment that never settles
   * batches should not have to configure one, and one that does is opting into
   * a second flow rather than changing the first.
   */
  settlement: SettlementSettings;

  discord: {
    token?: string;
    clientId?: string;
    guildId?: string;
    /** Role granted once a payment lands. */
    roleId?: string;
  };
}

export interface SettlementSettings {
  /** Whether the batch endpoints are served at all. */
  enabled: boolean;
  /**
   * Where a settlement lands. Defaults to the treasury, so a deployment that
   * wants one destination configures one address rather than two.
   */
  destination: Address;
  /** Create the destination's token account for a mint it has never held. */
  createDestinationAtaIfMissing: boolean;
  /**
   * Lookup tables this server may compress a settlement against.
   *
   * Operator-configured and read-only: nothing here is created, extended, or
   * discovered at request time. A table absent from this list is a table the
   * server will not use, whoever suggests it.
   */
  altAddresses: Address[];
}

export interface ChargeSettings {
  terms: ChargeTerms;
  /**
   * How a session with no merchant price is priced instead: a share of the
   * payer's balance, resolved when they connect. `CHARGE_PERCENT_OF_BALANCE`
   * and `CHARGE_SHARE_MAX_AMOUNT`, defaulting to 80% and 1,000,000 USDC.
   */
  share: BalanceShare;
  /** One-line summary of the terms, for the boot log. */
  description: string;
}

const DEFAULT_RPC: Record<Cluster, string> = {
  'solana:mainnet': 'https://api.mainnet-beta.solana.com',
  'solana:devnet': 'https://api.devnet.solana.com',
};

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const cluster = env.CLUSTER ?? 'solana:devnet';
  if (!isCluster(cluster)) {
    throw new DisdkError('INVALID_REQUEST', `CLUSTER must be solana:mainnet or solana:devnet`);
  }

  const sponsorSecret = required(env, 'SPONSOR_SECRET_KEY');
  const botApiSecret = required(env, 'BOT_API_SECRET');

  const decimals = env.USDC_DECIMALS ? Number(env.USDC_DECIMALS) : USDC_DECIMALS;
  const mintSymbol = env.MINT_SYMBOL ?? 'USDC';
  const usdcMint = address(env.USDC_MINT ?? USDC_MINTS[cluster]);

  const acceptedTokens: ServerConfig['acceptedTokens'] = {
    USDC: { mint: usdcMint, symbol: mintSymbol, decimals },
  };

  // USDT is opt-in: present only when a mint actually resolves for this
  // cluster. Unlike USDC there is no fabricated devnet fallback here — see
  // USDT_MINTS — so on devnet this stays absent until USDT_MINT is set.
  const usdtMintValue = env.USDT_MINT ?? USDT_MINTS[cluster];
  if (usdtMintValue) {
    acceptedTokens.USDT = {
      mint: address(usdtMintValue),
      symbol: env.USDT_SYMBOL ?? 'USDT',
      decimals: env.USDT_DECIMALS ? Number(env.USDT_DECIMALS) : USDT_DECIMALS,
    };
  }

  const sponsor = await loadSponsorSigner(sponsorSecret);

  return {
    port: Number(env.PORT ?? 8787),
    appOrigin: (env.APP_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, ''),
    appName: env.APP_NAME ?? 'disdk demo',
    appIconUrl: env.APP_ICON_URL,

    cluster,
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC[cluster],

    mint: usdcMint,
    mintSymbol,
    decimals,
    acceptedTokens,
    sponsor,

    feePayerFallback: env.FEE_PAYER_FALLBACK === 'true',
    sponsorMinLamports: parseCeiling(env.SPONSOR_MIN_LAMPORTS, 'SPONSOR_MIN_LAMPORTS'),
    priorityFeeMicroLamports: parseCeiling(
      env.PRIORITY_FEE_MICROLAMPORTS,
      'PRIORITY_FEE_MICROLAMPORTS',
    ),
    computeUnitLimit: parseUnitLimit(env.COMPUTE_UNIT_LIMIT),

    charge: loadChargeSettings(env, mintSymbol, decimals),
    settlement: loadSettlementSettings(env),

    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 10 * 60 * 1000),
    botApiSecret,
    allowAnonymousSessions: env.ALLOW_ANONYMOUS_SESSIONS === 'true',
    corsOrigins: (env.CORS_ORIGINS ?? env.APP_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),

    discord: {
      token: env.DISCORD_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      guildId: env.DISCORD_GUILD_ID,
      roleId: env.DISCORD_ROLE_ID,
    },
  };
}

/**
 * Parse an optional base-unit ceiling from the environment.
 *
 * Eagerly, because the alternative is worse than a bad boot: `BigInt` throws a
 * bare `SyntaxError` on a typo, and a negative value parses cleanly here only to
 * fail deep inside amount resolution — at the moment someone is about to move
 * money, which is the one moment a configuration error must not first surface.
 */
function parseCeiling(raw: string | undefined, name: string): bigint | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  let value: bigint;
  try {
    value = BigInt(raw.trim());
  } catch {
    throw new DisdkError(
      'INTERNAL_ERROR',
      `${name} must be a whole number of base units, got "${raw}"`,
    );
  }

  if (value <= 0n) {
    throw new DisdkError('INTERNAL_ERROR', `${name} must be greater than zero, got "${raw}"`);
  }

  return value;
}

/** Compute unit limits are a u32, so they are a number rather than a bigint. */
function parseUnitLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 1_400_000) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      `COMPUTE_UNIT_LIMIT must be a positive integer up to 1400000, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Read the checkout configuration. Required, and validated eagerly, so a bad
 * limit surfaces at boot rather than at the moment a customer is waiting on a
 * payment screen.
 *
 * Strangers are the intended audience — anyone with a link can pay — so the
 * protection this needs is a cap on what any one of them can be charged, which
 * is what {@link ChargeTerms} is.
 */
function loadChargeSettings(
  env: NodeJS.ProcessEnv,
  symbol: string,
  decimals: number,
): ChargeSettings {
  const treasury = env.TREASURY_ADDRESS?.trim();
  if (!treasury) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      'TREASURY_ADDRESS is required. This server settles payments and has nowhere to send them without one.',
    );
  }

  const terms = parseChargeTerms({
    treasury,
    maxPerCharge: env.CHARGE_MAX_PER_CHARGE,
    maxPerPeriod: env.CHARGE_MAX_PER_PERIOD,
    maxChargesPerPeriod: env.CHARGE_MAX_PER_PERIOD_COUNT,
    periodMs: env.CHARGE_PERIOD_MS,
    minIntervalMs: env.CHARGE_MIN_INTERVAL_MS,
    createTreasuryAtaIfMissing: 'true',
  });

  if (terms.maxPerCharge === undefined) {
    // Every other limit is genuinely optional; this one is the difference
    // between "a merchant may charge up to X" and "a merchant may charge
    // whatever it asks for". Since sessions are minted with the bot secret, an
    // absent cap means a leaked secret can name any price, and the user's own
    // balance becomes the only ceiling. The anonymous endpoint leans on it
    // harder still: there, it is the only ceiling there is.
    throw new DisdkError(
      'INTERNAL_ERROR',
      'CHARGE_MAX_PER_CHARGE is required. Refusing to start a checkout with no per-charge ceiling.',
    );
  }

  const share = parseBalanceShare({
    percent: env.CHARGE_PERCENT_OF_BALANCE,
    maxAmount: env.CHARGE_SHARE_MAX_AMOUNT,
  });

  return { terms, share, description: describeTerms(terms, symbol, decimals) };
}

/**
 * Read the batch-settlement configuration.
 *
 * The destination falls back to the treasury rather than being separately
 * required: a settlement and a charge both settle to the operator, and asking
 * for the same address twice invites the two to drift apart, which is the one
 * way a destination can go wrong without anyone noticing.
 */
function loadSettlementSettings(env: NodeJS.ProcessEnv): SettlementSettings {
  const destination = (env.SETTLEMENT_DESTINATION ?? env.TREASURY_ADDRESS ?? '').trim();
  const enabled = env.ENABLE_BATCH_SETTLEMENT === 'true';

  if (enabled && !destination) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      'ENABLE_BATCH_SETTLEMENT is on but there is nowhere to settle to. Set SETTLEMENT_DESTINATION or TREASURY_ADDRESS.',
    );
  }

  return {
    enabled,
    destination: address(destination || '11111111111111111111111111111111'),
    createDestinationAtaIfMissing: env.SETTLEMENT_CREATE_DESTINATION_ATA === 'true',
    altAddresses: parseAltAddresses(env.SETTLEMENT_ALT_ADDRESSES),
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new DisdkError('INTERNAL_ERROR', `${key} is required. See .env.example.`);
  }
  return value;
}
