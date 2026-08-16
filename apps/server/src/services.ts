import {
  MemorySessionStore,
  createRpc,
  type SessionStore,
  type SolanaRpc,
} from '@disdk/verify';
import type { PermitConfig } from '@disdk/verify';
import { RateLimiter } from './ratelimit.js';
import type { ServerConfig } from './config.js';

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
