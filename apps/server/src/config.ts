import {
  DisdkError,
  USDC_DECIMALS,
  USDC_MINTS,
  describeStrategy,
  isCluster,
  type AmountStrategy,
  type Cluster,
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

  discord: {
    token?: string;
    clientId?: string;
    guildId?: string;
    /** Role granted once a wallet is linked and approved. */
    roleId?: string;
  };
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

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new DisdkError('INTERNAL_ERROR', `${key} is required. See .env.example.`);
  }
  return value;
}
