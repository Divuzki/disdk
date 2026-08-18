import {
  DisdkError,
  USDC_DECIMALS,
  USDC_MINTS,
  isCluster,
  type Cluster,
} from '@disdk/protocol';
import { address, type Address, type KeyPairSigner } from '@solana/kit';
import { loadSponsorSigner, parseChargeTerms, type ChargeTerms } from '@disdk/verify';

const DEFAULT_RPC: Record<Cluster, string> = {
  'solana:mainnet': 'https://api.mainnet-beta.solana.com',
  'solana:devnet': 'https://api.devnet.solana.com',
};

export interface ChargeServiceConfig {
  port: number;
  cluster: Cluster;
  rpcUrl: string;

  mint: Address;
  mintSymbol: string;
  decimals: number;

  /**
   * The delegate. Unlike the session server, this service holds the secret —
   * that is the whole reason it is a separate process.
   */
  delegate: KeyPairSigner;
  terms: ChargeTerms;

  /** Shared secret your application uses to request a charge. */
  merchantSecret: string;
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChargeServiceConfig> {
  const cluster = env.CLUSTER ?? 'solana:devnet';
  if (!isCluster(cluster)) {
    throw new DisdkError('INVALID_REQUEST', 'CLUSTER must be solana:mainnet or solana:devnet');
  }

  const delegate = await loadSponsorSigner(required(env, 'DELEGATE_SECRET_KEY'));
  const merchantSecret = required(env, 'MERCHANT_API_SECRET');

  const terms = parseChargeTerms({
    treasury: env.TREASURY_ADDRESS,
    maxPerCharge: env.CHARGE_MAX_PER_CHARGE,
    maxPerPeriod: env.CHARGE_MAX_PER_PERIOD,
    maxChargesPerPeriod: env.CHARGE_MAX_PER_PERIOD_COUNT,
    periodMs: env.CHARGE_PERIOD_MS,
    minIntervalMs: env.CHARGE_MIN_INTERVAL_MS,
    createTreasuryAtaIfMissing: env.CHARGE_CREATE_TREASURY_ATA,
  });

  if (terms.treasury === delegate.address) {
    // Funds would land in the hot key that is authorised to pull them, so a
    // single leak loses both the ability to charge and everything charged.
    console.warn(
      '[disdk] TREASURY_ADDRESS is the delegate itself. Settle to an account this service cannot spend from.',
    );
  }

  return {
    port: Number(env.CHARGE_PORT ?? 8788),
    cluster,
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC[cluster],

    mint: address(env.USDC_MINT ?? USDC_MINTS[cluster]),
    mintSymbol: env.MINT_SYMBOL ?? 'USDC',
    decimals: env.USDC_DECIMALS ? Number(env.USDC_DECIMALS) : USDC_DECIMALS,

    delegate,
    terms,
    merchantSecret,
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new DisdkError('INTERNAL_ERROR', `${key} is required. See .env.example.`);
  }
  return value;
}
