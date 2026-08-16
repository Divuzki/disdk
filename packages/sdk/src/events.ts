import type { CompleteResponse, DisdkError, SessionPublic } from '@disdk/protocol';
import type { DiscoveredWallet } from './wallets.js';

export type DisdkState =
  | 'idle'
  | 'loading'
  | 'selecting'
  | 'connecting'
  | 'connected'
  | 'reviewing'
  | 'permitting'
  | 'done'
  | 'error';

export interface DisdkEventMap {
  state: DisdkState;
  session: SessionPublic;
  wallets: DiscoveredWallet[];
  connect: { publicKey: string; walletName: string };
  permit: CompleteResponse;
  done: CompleteResponse;
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
