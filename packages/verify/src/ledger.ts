import type { Address } from '@solana/kit';
import type { ChargeRecord } from './terms.js';

/**
 * Where charges are remembered.
 *
 * The period limits in `ChargeTerms` are only as good as this: a ledger that
 * forgets is a ledger that lets the caps reset. The in-memory implementation
 * below is therefore fine for a demo and wrong for production, where a restart
 * must not hand every wallet a fresh daily allowance.
 */
export interface ChargeLedger {
  /** Every charge recorded for a wallet, newest last. */
  history(wallet: Address): Promise<ChargeRecord[]>;
  /** A previously accepted charge with this idempotency key, if any. */
  findByKey(key: string): Promise<ChargeRecord | undefined>;
  /**
   * Record an accepted charge. Called before submission, so a charge that is
   * broadcast but never confirmed still counts against the period limits —
   * failing closed, since the alternative lets a retry storm exceed them.
   */
  record(entry: ChargeRecord, key?: string): Promise<void>;
  /** Attach the signature once the transaction confirms. */
  settle(key: string | undefined, entry: ChargeRecord, signature: string): Promise<void>;
}

export class MemoryChargeLedger implements ChargeLedger {
  readonly #byWallet = new Map<string, ChargeRecord[]>();
  readonly #byKey = new Map<string, ChargeRecord>();

  async history(wallet: Address): Promise<ChargeRecord[]> {
    return [...(this.#byWallet.get(wallet) ?? [])];
  }

  async findByKey(key: string): Promise<ChargeRecord | undefined> {
    return this.#byKey.get(key);
  }

  async record(entry: ChargeRecord, key?: string): Promise<void> {
    const existing = this.#byWallet.get(entry.wallet) ?? [];
    existing.push(entry);
    this.#byWallet.set(entry.wallet, existing);
    if (key) this.#byKey.set(key, entry);
  }

  async settle(key: string | undefined, entry: ChargeRecord, signature: string): Promise<void> {
    entry.signature = signature;
    if (key) this.#byKey.set(key, entry);
  }

  /** Drop records older than `maxAgeMs`, which no window can still reach. */
  sweep(maxAgeMs: number, now: number = Date.now()): void {
    for (const [wallet, entries] of this.#byWallet) {
      const kept = entries.filter((entry) => now - entry.at < maxAgeMs);
      if (kept.length) this.#byWallet.set(wallet, kept);
      else this.#byWallet.delete(wallet);
    }
    for (const [key, entry] of this.#byKey) {
      if (now - entry.at >= maxAgeMs) this.#byKey.delete(key);
    }
  }
}
