import {
  MemoryChargeLedger,
  MemorySessionStore,
  createRpc,
  type ChargeLedger,
  type SessionStore,
  type SolanaRpc,
} from '@disdk/verify';
import type { ChargeSessionConfig, PermitConfig, SweepConfig } from '@disdk/verify';
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
  /** Null whenever no treasury is configured, which is the default. */
  chargeConfig: ChargeSessionConfig | null;
  /**
   * Where charges are remembered, so the period limits in `ChargeTerms` mean
   * something. Unused until a treasury is configured.
   */
  ledger: ChargeLedger;
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
  overrides: Partial<Pick<Services, 'rpc' | 'store' | 'notifier' | 'ledger'>> = {},
): Services {
  const store = overrides.store ?? new MemorySessionStore();
  const rpc = overrides.rpc ?? createRpc(config.rpcUrl);
  const ledger = overrides.ledger ?? new MemoryChargeLedger();

  if (config.charge && !overrides.ledger) {
    console.warn(
      '[disdk] using the in-memory charge ledger: period limits reset on restart. Use a database in production.',
    );
  }

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
    chargeConfig: config.charge
      ? {
          mint: config.mint,
          decimals: config.decimals,
          symbol: config.mintSymbol,
          treasury: config.charge.terms.treasury,
          createTreasuryAtaIfMissing: config.charge.terms.createTreasuryAtaIfMissing,
        }
      : null,
    ledger,
    limiters: {
      // Issuing costs the sponsor money, so it is the tighter of the two.
      issue: new RateLimiter(10, 60_000),
      session: new RateLimiter(30, 60_000),
    },
    notifier: overrides.notifier ?? noopNotifier,
  };

  // Keep twice the charge window, so a charge is never forgotten while it can
  // still count against a limit.
  const retainMs = (config.charge?.terms.periodMs ?? 0) * 2;

  const sweep = setInterval(() => {
    void services.store.sweep();
    services.limiters.issue.sweep();
    services.limiters.session.sweep();
    if (retainMs > 0 && ledger instanceof MemoryChargeLedger) ledger.sweep(retainMs);
  }, 60_000);
  sweep.unref?.();

  return services;
}
