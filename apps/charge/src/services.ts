import { MemoryChargeLedger, createRpc, type ChargeLedger, type SolanaRpc } from '@disdk/verify';
import type { ChargeServiceConfig } from './config.ts';

export interface ChargeServices {
  config: ChargeServiceConfig;
  rpc: SolanaRpc;
  ledger: ChargeLedger;
}

export function createServices(
  config: ChargeServiceConfig,
  overrides: Partial<Pick<ChargeServices, 'rpc' | 'ledger'>> = {},
): ChargeServices {
  const ledger = overrides.ledger ?? new MemoryChargeLedger();

  if (!overrides.ledger) {
    console.warn(
      '[disdk] using the in-memory ledger: period limits reset on restart. Use a database in production.',
    );
  }

  const services: ChargeServices = {
    config,
    rpc: overrides.rpc ?? createRpc(config.rpcUrl),
    ledger,
  };

  if (ledger instanceof MemoryChargeLedger) {
    // Keep twice the window, so a charge is never forgotten while it can still
    // count against a limit.
    const retainMs = config.terms.periodMs * 2;
    const sweep = setInterval(() => ledger.sweep(retainMs), 60_000);
    sweep.unref?.();
  }

  return services;
}
