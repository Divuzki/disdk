import type {
  CompleteResponse,
  DisdkError,
  SessionPublic,
  SettlementCompleteResponse,
} from '@disdk/protocol';
import type { DiscoveredWallet } from './wallets.js';

export type DisdkState =
  | 'idle'
  | 'loading'
  | 'selecting'
  | 'connecting'
  | 'connected'
  | 'reviewing'
  /** The wallet has been handed the transfer and is waiting on the user. */
  | 'paying'
  | 'done'
  | 'error';

export interface DisdkEventMap {
  state: DisdkState;
  session: SessionPublic;
  wallets: DiscoveredWallet[];
  connect: { publicKey: string; walletName: string };
  done: CompleteResponse;
  /**
   * A batch settlement landed. Separate from `done` because the results differ
   * in kind: a charge has an amount, a settlement has a list, and collapsing
   * the list into one figure is exactly what this feature must never do.
   */
  settled: SettlementCompleteResponse;
  error: DisdkError;
  disconnect: void;
}

type Listener<K extends keyof DisdkEventMap> = (payload: DisdkEventMap[K]) => void;

export class Emitter {
  readonly #listeners = new Map<string, Set<Listener<never>>>();

  on<K extends keyof DisdkEventMap>(event: K, listener: Listener<K>): () => void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener as Listener<never>);
    this.#listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off<K extends keyof DisdkEventMap>(event: K, listener: Listener<K>): void {
    this.#listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof DisdkEventMap>(event: K, payload: DisdkEventMap[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        (listener as Listener<K>)(payload);
      } catch (error) {
        // One bad handler must not derail the flow the user is in the middle of.
        console.error('[disdk] listener threw', error);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
