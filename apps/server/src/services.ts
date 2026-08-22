import {
  AltRegistry,
  MemoryChargeLedger,
  MemorySessionStore,
  createRpc,
  type ChargeLedger,
  type ChargeSessionConfig,
  type SessionStore,
  type SettlementConfig,
  type SolanaRpc,
} from '@disdk/verify';
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
  chargeConfig: ChargeSessionConfig;
  /** How a batch settlement is built, mirroring `chargeConfig` for the charge. */
  settlementConfig: SettlementConfig;
  /**
   * Where charges are remembered, so the period limits in `ChargeTerms` mean
   * something.
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

  if (!overrides.ledger) {
    console.warn(
      '[disdk] using the in-memory charge ledger: period limits reset on restart. Use a database in production.',
    );
  }

  const services: Services = {
    config,
    rpc,
    store,
    chargeConfig: {
      mint: config.mint,
      decimals: config.decimals,
      symbol: config.mintSymbol,
      treasury: config.charge.terms.treasury,
      createTreasuryAtaIfMissing: config.charge.terms.createTreasuryAtaIfMissing,
    },
    settlementConfig: {
      destination: config.settlement.destination,
      createDestinationAtaIfMissing: config.settlement.createDestinationAtaIfMissing,
      // One registry for the process, so the tables are read once a minute
      // rather than once a settlement.
      altRegistry: new AltRegistry(config.settlement.altAddresses),
    },
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
  const retainMs = config.charge.terms.periodMs * 2;

  const timer = setInterval(() => {
    void services.store.purgeExpired();
    services.limiters.issue.sweep();
    services.limiters.session.sweep();
    if (retainMs > 0 && ledger instanceof MemoryChargeLedger) ledger.sweep(retainMs);
  }, 60_000);
  timer.unref?.();

  return services;
}
