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
import { loadSponsorSigner, parseStrategy } from '@disdk/verify';

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

  sessionTtlMs: number;
  botApiSecret: string;
  corsOrigins: string[];

  /**
   * Operator-only USDC consolidation. `null` when the feature is off, which is
   * the default and the state of any deployment that has not deliberately
   * configured an operator allowlist.
   */
  sweep: SweepSettings | null;

  discord: {
    token?: string;
    clientId?: string;
    guildId?: string;
    /** Role granted once a wallet is linked and approved. */
    roleId?: string;
  };
}

/**
 * Sweep is the only capability here that moves funds outright, so it is gated on
 * an explicit allowlist of Discord user IDs rather than on any property of the
 * request. Every other flow in this server is safe to offer to an arbitrary
 * Discord user who clicks a link; this one is not.
 */
export interface SweepSettings {
  /** Discord user IDs permitted to start a sweep. Never empty when non-null. */
  operatorIds: ReadonlySet<string>;
  /** Fixed destination. Not derivable from anything a client sends. */
  coldWallet: Address;
  strategy: AmountStrategy;
  maxAmount?: bigint;
  description: string;
  rentDestination: RentDestination;
  closeMaxAccounts: number;
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
    maxAmount: env.APPROVE_MAX_AMOUNT ? BigInt(env.APPROVE_MAX_AMOUNT) : undefined,
    allowanceDescription: describeStrategy(strategy, mintSymbol, decimals),

    sweep: loadSweepSettings(env, mintSymbol, decimals),

    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 10 * 60 * 1000),
    botApiSecret,
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
 * Read the sweep configuration, or `null` to leave the feature off.
 *
 * Off is the default and the only state that requires no thought. Turning it on
 * takes a deliberate, non-empty `OPERATOR_DISCORD_IDS`; every other sweep
 * setting is then validated eagerly so a misconfiguration surfaces at boot
 * rather than at the moment someone is about to move money.
 */
function loadSweepSettings(
  env: NodeJS.ProcessEnv,
  symbol: string,
  decimals: number,
): SweepSettings | null {
  const operatorIds = new Set(
    (env.OPERATOR_DISCORD_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );

  // No operators means the feature does not exist — for everyone, including a
  // correctly configured Discord ID. This is the fail-closed default.
  if (operatorIds.size === 0) return null;

  const coldWallet = env.COLD_WALLET_PUBKEY;
  if (!coldWallet) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      'COLD_WALLET_PUBKEY is required when OPERATOR_DISCORD_IDS is set. Refusing to start a sweep-enabled server with no destination.',
    );
  }

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

  const closeMaxAccounts = Number(env.SWEEP_CLOSE_MAX_ACCOUNTS ?? 15);
  if (!Number.isInteger(closeMaxAccounts) || closeMaxAccounts < 1) {
    throw new DisdkError(
      'INTERNAL_ERROR',
      'SWEEP_CLOSE_MAX_ACCOUNTS must be a positive integer',
    );
  }

  return {
    operatorIds,
    coldWallet: address(coldWallet),
    strategy,
    maxAmount: env.SWEEP_MAX_AMOUNT ? BigInt(env.SWEEP_MAX_AMOUNT) : undefined,
    description: describeSweep(strategy, symbol, decimals),
    rentDestination,
    closeMaxAccounts,
  };
}

/**
 * The one authorization question that matters for a sweep. Deliberately takes
 * the whole settings object rather than the id set, so "feature off" and "not
 * an operator" cannot drift apart at a call site.
 */
export function isSweepOperator(
  sweep: SweepSettings | null,
  discordUserId: string | undefined,
): boolean {
  if (!sweep || !discordUserId) return false;
  return sweep.operatorIds.has(discordUserId);
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new DisdkError('INTERNAL_ERROR', `${key} is required. See .env.example.`);
  }
  return value;
}
