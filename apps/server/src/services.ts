import {
  MemorySessionStore,
  createRpc,
  type SessionStore,
  type SolanaRpc,
} from '@disdk/verify';
import type { PermitConfig, SweepConfig } from '@disdk/verify';
import { RateLimiter } from './ratelimit.ts';
import type { ServerConfig } from './config.ts';

export interface Notifier {
  /** Tell Discord the link succeeded. Best-effort; failures must not break the flow. */
  onComplete(input: {
    discordUserId: string;
    interactionToken?: string;
    wallet: string;
    amountUi: string;
    symbol: string;
    explorerUrl: string;
  }): Promise<void>;
}

export interface Services {
  config: ServerConfig;
  rpc: SolanaRpc;
  store: SessionStore;
  permitConfig: PermitConfig;
  /** Null whenever the sweep feature is off, which is the default. */
  sweepConfig: SweepConfig | null;
  limiters: {
    issue: RateLimiter;
    session: RateLimiter;
  };
  notifier: Notifier;
}

export const noopNotifier: Notifier = {
  async onComplete() {},
};

export function createServices(
  config: ServerConfig,
  overrides: Partial<Pick<Services, 'rpc' | 'store' | 'notifier'>> = {},
): Services {
  const store = overrides.store ?? new MemorySessionStore();
  const rpc = overrides.rpc ?? createRpc(config.rpcUrl);

  const services: Services = {
    config,
    rpc,
    store,
    permitConfig: {
      mint: config.mint,
      decimals: config.decimals,
      symbol: config.mintSymbol,
      delegate: config.delegate,
      strategy: config.strategy,
      maxAmount: config.maxAmount,
    },
    sweepConfig: config.sweep
      ? {
          mint: config.mint,
          decimals: config.decimals,
          symbol: config.mintSymbol,
          destination: config.sweep.coldWallet,
          strategy: config.sweep.strategy,
          maxAmount: config.sweep.maxAmount,
          rentDestination: config.sweep.rentDestination,
          closeMaxAccounts: config.sweep.closeMaxAccounts,
        }
      : null,
    limiters: {
      // Issuing costs the sponsor money, so it is the tighter of the two.
      issue: new RateLimiter(10, 60_000),
      session: new RateLimiter(30, 60_000),
    },
    notifier: overrides.notifier ?? noopNotifier,
  };

  const sweep = setInterval(() => {
    void services.store.sweep();
    services.limiters.issue.sweep();
    services.limiters.session.sweep();
  }, 60_000);
  sweep.unref?.();

  return services;
}
