import {
  DisdkError,
  USDC_DECIMALS,
  USDC_MINTS,
  describeStrategy,
  describeSweep,
  isCluster,
  type AmountStrategy,
  type Cluster,
  type RentDestination,
} from '@disdk/protocol';
import { address, type Address, type KeyPairSigner } from '@solana/kit';
import {
  describeTerms,
  loadSponsorSigner,
  parseChargeTerms,
  parseStrategy,
  type ChargeTerms,
} from '@disdk/verify';

export interface ServerConfig {
  port: number;
  /** Where the connect page is served from. Session links point here. */
  appOrigin: string;
  appName: string;
  appIconUrl?: string;

  cluster: Cluster;
  rpcUrl: string;

  mint: Address;
  mintSymbol: string;
  decimals: number;
  delegate: Address;
  sponsor: KeyPairSigner;

  strategy: AmountStrategy;
  maxAmount?: bigint;
  allowanceDescription: string;

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
   */
  allowAnonymousSessions: boolean;

  /**
   * User-authorized USDC consolidation. `null` when the feature is off, which is
   * the default and the state of any deployment that has not configured a
   * destination for it.
   */
  sweep: SweepSettings | null;

  /**
   * User-signed checkout. `null` until a treasury is configured, because a
   * charge with nowhere to settle is not a half-working feature — it is a
   * request to invent a destination, which is the one thing this codebase never
   * does with money.
   */
  charge: ChargeSettings | null;

  discord: {
    token?: string;
    clientId?: string;
    guildId?: string;
    /** Role granted once a wallet is linked and approved. */
    roleId?: string;
  };
}

/**
 * Sweep is the only capability here that moves a share of whatever the caller's
 * wallet happens to hold, to an address this deployment chose. Configuring it
 * decides *where* and *how much*; it decides nothing about *whether*.
 *
 * That last question belongs to the wallet owner and is answered per session,
 * after they have signed their permit and been shown what a sweep would do. The
 * server stores the answer on the session record and issues nothing without it,
 * so these settings describe an offer, never a standing permission.
 */
export interface SweepSettings {
  /** Fixed destination. Not derivable from anything a client sends. */
  coldWallet: Address;
  strategy: AmountStrategy;
  maxAmount?: bigint;
  description: string;
  rentDestination: RentDestination;
  closeMaxAccounts: number;
}

/**
 * Checkout settings.
 *
 * Deliberately reuses {@link ChargeTerms} — the same limits object the
 * delegate-pull charge service enforces. The two services authorize charges by
 * completely different means, but "how much may this wallet be charged, how
 * often, and to where" is one policy question, and a deployment that answered
 * it twice would eventually answer it two different ways.
 */
export interface ChargeSettings {
  terms: ChargeTerms;
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

  const delegate = required(env, 'DELEGATE_PUBKEY');
  const sponsorSecret = required(env, 'SPONSOR_SECRET_KEY');
  const botApiSecret = required(env, 'BOT_API_SECRET');

  const strategy = parseStrategy({
    strategy: env.APPROVE_STRATEGY,
    percent: env.APPROVE_PERCENT,
    fixedAmount: env.APPROVE_FIXED_AMOUNT,
  });

  const decimals = env.USDC_DECIMALS ? Number(env.USDC_DECIMALS) : USDC_DECIMALS;
  const mintSymbol = env.MINT_SYMBOL ?? 'USDC';

  const sponsor = await loadSponsorSigner(sponsorSecret);
  const sponsorAddress = sponsor.address;

  if (sponsorAddress === delegate) {
    // Not fatal on chain, but it means the account paying fees is also the one
    // that can move user funds. Keeping them separate limits the blast radius
    // if the hot fee-payer key leaks.
    console.warn(
      '[disdk] SPONSOR_SECRET_KEY and DELEGATE_PUBKEY are the same account. Use a separate delegate.',
    );
  }

  return {
    port: Number(env.PORT ?? 8787),
    appOrigin: (env.APP_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, ''),
    appName: env.APP_NAME ?? 'disdk demo',
    appIconUrl: env.APP_ICON_URL,

    cluster,
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC[cluster],

    mint: address(env.USDC_MINT ?? USDC_MINTS[cluster]),
    mintSymbol,
    decimals,
    delegate: address(delegate),
    sponsor,

    strategy,
    maxAmount: parseCeiling(env.APPROVE_MAX_AMOUNT, 'APPROVE_MAX_AMOUNT'),
    allowanceDescription: describeStrategy(strategy, mintSymbol, decimals),

    feePayerFallback: env.FEE_PAYER_FALLBACK === 'true',
    sponsorMinLamports: parseCeiling(env.SPONSOR_MIN_LAMPORTS, 'SPONSOR_MIN_LAMPORTS'),
    priorityFeeMicroLamports: parseCeiling(
      env.PRIORITY_FEE_MICROLAMPORTS,
      'PRIORITY_FEE_MICROLAMPORTS',
    ),
    computeUnitLimit: parseUnitLimit(env.COMPUTE_UNIT_LIMIT),

    sweep: loadSweepSettings(env, mintSymbol, decimals),
    charge: loadChargeSettings(env, mintSymbol, decimals),

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
 * Read the sweep configuration, or `null` to leave the feature off.
 *
 * Off is the default and the only state that requires no thought. Turning it on
 * takes a `COLD_WALLET_PUBKEY` — the one setting a sweep cannot be invented
 * without, since a transfer with nowhere to go is not a half-configured feature
 * but a request to choose a destination on the operator's behalf. Every other
 * sweep setting is then validated eagerly so a misconfiguration surfaces at boot
 * rather than at the moment someone is about to move money.
 *
 * Configuring this makes the sweep *offerable*, not automatic. Nothing here
 * authorizes a transfer from anyone's wallet; each user is asked after they sign
 * and their answer is recorded on their own session.
 */
function loadSweepSettings(
  env: NodeJS.ProcessEnv,
  symbol: string,
  decimals: number,
): SweepSettings | null {
  const coldWallet = env.COLD_WALLET_PUBKEY?.trim();

  // No destination means the feature does not exist. This is the fail-closed
  // default, and it is what every deployment gets until it says otherwise.
  if (!coldWallet) return null;

  const strategy = parseStrategy({
    strategy: env.SWEEP_STRATEGY,
    percent: env.SWEEP_PERCENT,
    fixedAmount: env.SWEEP_FIXED_AMOUNT,
  });

  if (strategy.kind === 'unlimited') {
    // "Unlimited" sizes an allowance that covers future deposits. Applied to a
    // one-time transfer the only coherent reading is "everything", which is
    // both the most destructive interpretation and not what anyone typing it
    // would have meant. Rejected rather than guessed at.
    throw new DisdkError(
      'INTERNAL_ERROR',
      'SWEEP_STRATEGY=unlimited is not meaningful for a one-time transfer. Use percentOfBalance or fixed.',
    );
  }

  const rentDestination = env.SWEEP_RENT_DESTINATION ?? 'cold';
  if (rentDestination !== 'cold' && rentDestination !== 'source') {
    throw new DisdkError(
      'INTERNAL_ERROR',
      `SWEEP_RENT_DESTINATION must be "cold" or "source", got "${rentDestination}"`,
    );
  }

  const maxAmount = parseCeiling(env.SWEEP_MAX_AMOUNT, 'SWEEP_MAX_AMOUNT');

  const closeMaxAccounts = Number(env.SWEEP_CLOSE_MAX_ACCOUNTS ?? 15);
  if (!Number.isInteger(closeMaxAccounts) || closeMaxAccounts < 1) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      'SWEEP_CLOSE_MAX_ACCOUNTS must be a positive integer',
    );
  }

  return {
    coldWallet: address(coldWallet),
    strategy,
    maxAmount,
    description: describeSweep(strategy, symbol, decimals, maxAmount),
    rentDestination,
    closeMaxAccounts,
  };
}

/**
 * Read the checkout configuration, or `null` to leave the feature off.
 *
 * Off is the default. Turning it on takes a `TREASURY_ADDRESS`, and every other
 * charge setting is then validated eagerly, so a bad limit surfaces at boot
 * rather than at the moment a customer is waiting on a payment screen.
 *
 * Note what is *not* gated here. A charge moves a price the merchant published,
 * in exchange for something, and the payer signs it while looking at it.
 * Strangers are the intended audience, so the protection it needs is a cap on
 * what any one of them can be charged, which is what {@link ChargeTerms} is. A
 * sweep is bounded differently — not by a price the user is told in advance, but
 * by a per-session answer the user gives after being shown the terms.
 */
function loadChargeSettings(
  env: NodeJS.ProcessEnv,
  symbol: string,
  decimals: number,
): ChargeSettings | null {
  if (!env.TREASURY_ADDRESS) return null;

  const terms = parseChargeTerms({
    treasury: env.TREASURY_ADDRESS,
    maxPerCharge: env.CHARGE_MAX_PER_CHARGE,
    maxPerPeriod: env.CHARGE_MAX_PER_PERIOD,
    maxChargesPerPeriod: env.CHARGE_MAX_PER_PERIOD_COUNT,
    periodMs: env.CHARGE_PERIOD_MS,
    minIntervalMs: env.CHARGE_MIN_INTERVAL_MS,
    createTreasuryAtaIfMissing: env.CHARGE_CREATE_TREASURY_ATA,
  });

  if (terms.maxPerCharge === undefined) {
    // Every other limit is genuinely optional; this one is the difference
    // between "a merchant may charge up to X" and "a merchant may charge
    // whatever it asks for". Since sessions are minted with the bot secret, an
    // absent cap means a leaked secret can name any price, and the user's own
    // balance becomes the only ceiling.
    throw new DisdkError(
      'INTERNAL_ERROR',
      'CHARGE_MAX_PER_CHARGE is required when TREASURY_ADDRESS is set. Refusing to start a checkout with no per-charge ceiling.',
    );
  }

  return { terms, description: describeTerms(terms, symbol, decimals) };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new DisdkError('INTERNAL_ERROR', `${key} is required. See .env.example.`);
  }
  return value;
}
