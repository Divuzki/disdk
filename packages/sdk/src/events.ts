import type {
  CompleteResponse,
  DisdkError,
  SessionPublic,
  SweepOfferPublic,
} from '@disdk/protocol';
import type { DiscoveredWallet } from './wallets.js';

export type DisdkState =
  | 'idle'
  | 'loading'
  | 'selecting'
  | 'connecting'
  | 'connected'
  | 'reviewing'
  | 'permitting'
  /**
   * A sweep has been offered and the flow is waiting on the user to answer it.
   *
   * Its own state rather than a variant of `done`, because the difference
   * matters to anyone watching: the permit has landed and nothing further will
   * happen, but a question is on screen and the flow has not settled. Nothing
   * moves out of here except a choice.
   */
  | 'offering'
  | 'done'
  | 'error';

export interface DisdkEventMap {
  state: DisdkState;
  session: SessionPublic;
  wallets: DiscoveredWallet[];
  connect: { publicKey: string; walletName: string };
  /**
   * A sweep is now available on this session, because the permit has been
   * signed and has landed.
   *
   * An offer being announced, nothing more. A headless integration that ignores
   * this event gets no sweep — the only thing that starts one is a call to
   * {@link Disdk.authorizeSweep}, which exists to be wired to a deliberate
   * choice in the integrator's own UI.
   */
  sweepOffer: SweepOfferPublic;
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
