/**
 * Address lookup tables, for the batch settlements that need them.
 *
 * A lookup table lets a message name an account by a one-byte index into an
 * on-chain list instead of spending 32 bytes on the address itself. That is the
 * only reason one is used here: a settlement with several obligations runs out
 * of room inside Solana's 1,232-byte packet long before it runs out of things
 * the user agreed to.
 *
 * It is also the one mechanism in this codebase that can make a transaction say
 * less than it does, which is why everything below is arranged around a single
 * rule: **a table is only ever used if it was configured by the operator**. The
 * server does not discover tables, does not accept one from a request, and
 * never creates or extends one while a user is waiting to sign. A table found
 * any other way could substitute an account the reviewer never saw.
 */

import {
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type AddressesByLookupTableAddress,
} from '@solana/kit';
import { DisdkError } from '@disdk/protocol';
import { withRpc, type SolanaRpc } from './rpc.js';

/** The Address Lookup Table program. A table not owned by it is not a table. */
export const ADDRESS_LOOKUP_TABLE_PROGRAM =
  'AddressLookupTab1e1111111111111111111111111' as Address;

/**
 * Size of a lookup table's metadata, before the addresses start: a
 * discriminator, the deactivation and last-extended slots, the start index, an
 * optional authority, and two bytes of padding.
 */
const ALT_META_SIZE = 56;

/** Largest number of addresses a lookup table can hold. */
const ALT_MAX_ADDRESSES = 256;

/**
 * Decode a lookup table account.
 *
 * Read from raw bytes rather than through an RPC's `jsonParsed` encoding on
 * purpose: parsing is a per-provider courtesy, not a guarantee, and a settlement
 * that only compiles against providers which happen to parse lookup tables is a
 * settlement that fails in production for reasons nobody can see from the code.
 * The layout is fixed and public, so decoding it here costs less than depending
 * on someone else's decision to decode it for us.
 *
 * Returns null for anything that is not a live table — missing, wrong owner,
 * truncated, or deactivated. The caller decides whether that is fatal.
 */
export function decodeLookupTable(
  account: { owner: Address; data: readonly [string, string] } | null,
): Address[] | null {
  if (!account) return null;
  if (account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) return null;

  const bytes = getBase64Encoder().encode(account.data[0]);
  if (bytes.length < ALT_META_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 1) return null;

  // A deactivated table stops resolving once its slot is passed, so treating it
  // as usable would build a transaction that cannot land.
  if (view.getBigUint64(4, true) !== 0xffffffffffffffffn) return null;

  const body = bytes.length - ALT_META_SIZE;
  if (body < 0 || body % 32 !== 0) return null;

  const count = body / 32;
  if (count > ALT_MAX_ADDRESSES) return null;

  const decoder = getBase58Decoder();
  const addresses: Address[] = [];
  for (let i = 0; i < count; i++) {
    const start = ALT_META_SIZE + i * 32;
    addresses.push(decoder.decode(bytes.slice(start, start + 32)) as Address);
  }
  return addresses;
}

/**
 * How long a fetched table's contents are reused before being re-read.
 *
 * Tables are extended by an operator, rarely, and never during a request. A
 * short cache turns one RPC round trip per settlement into one per minute; a
 * stale entry costs nothing worse than a slightly larger transaction, because
 * an address the cache has not yet seen simply stays in the static account list.
 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  addresses: Address[];
  readAt: number;
}

export interface AltRegistryOptions {
  /** Overrides the default cache lifetime. Zero disables caching. */
  cacheTtlMs?: number;
}

/**
 * The operator's trusted tables, and the only source of them.
 *
 * Constructed from configuration at boot, so by the time a request can reach
 * it the set of usable tables is already closed.
 */
export class AltRegistry {
  readonly #trusted: readonly Address[];
  readonly #cache = new Map<Address, CacheEntry>();
  readonly #ttlMs: number;

  constructor(trusted: readonly Address[] = [], options: AltRegistryOptions = {}) {
    this.#trusted = trusted;
    this.#ttlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  }

  get addresses(): readonly Address[] {
    return this.#trusted;
  }

  get isEmpty(): boolean {
    return this.#trusted.length === 0;
  }

  /** Whether this table is one the operator configured. */
  trusts(table: Address): boolean {
    return this.#trusted.includes(table);
  }

  /**
   * Read the contents of every configured table.
   *
   * A table that does not exist, or that has been closed, resolves to nothing
   * rather than to an error: the settlement then either fits without it or is
   * refused for being too large, and both are better outcomes than failing a
   * payment because one of several tables went away. A table that exists but
   * cannot be read at all is a different matter — see {@link resolveLookupTables}.
   */
  async load(rpc: SolanaRpc): Promise<AddressesByLookupTableAddress> {
    if (this.isEmpty) return {};

    const now = Date.now();
    const stale = this.#trusted.filter((table) => {
      const entry = this.#cache.get(table);
      return !entry || now - entry.readAt >= this.#ttlMs;
    });

    if (stale.length > 0) {
      const { value } = await withRpc('reading the address lookup tables', () =>
        rpc
          .getMultipleAccounts(stale as Address[], {
            commitment: 'confirmed',
            encoding: 'base64',
          })
          .send(),
      );

      stale.forEach((table, index) => {
        const account = value[index] as
          | { owner: Address; data: readonly [string, string] }
          | null;
        this.#cache.set(table, {
          addresses: decodeLookupTable(account ?? null) ?? [],
          readAt: now,
        });
      });
    }

    const result: AddressesByLookupTableAddress = {};
    for (const table of this.#trusted) {
      const entry = this.#cache.get(table);
      if (entry && entry.addresses.length > 0) result[table] = entry.addresses;
    }
    return result;
  }

  /** Drop cached contents, so the next load re-reads the chain. */
  clear(): void {
    this.#cache.clear();
  }
}

/**
 * Narrow the loaded tables to the ones that would actually earn their place.
 *
 * A table reference is not free: it costs 32 bytes for the table's own address
 * plus one byte per account drawn from it, so a table covering a single account
 * makes the transaction *larger*. Only tables that cover more accounts than
 * they cost are kept, which also keeps the client's job small — every table
 * left here is one the SDK has to fetch and check for itself.
 */
export function selectLookupTables(
  loaded: AddressesByLookupTableAddress,
  accounts: readonly Address[],
): AddressesByLookupTableAddress {
  const wanted = new Set(accounts);
  const selected: AddressesByLookupTableAddress = {};
  const claimed = new Set<Address>();

  // Most-covering first, so an account present in two tables is drawn from the
  // one already paying for itself rather than pulling in a second table.
  const ranked = Object.entries(loaded)
    .map(([table, addresses]) => ({
      table: table as Address,
      addresses,
      covers: addresses.filter((a) => wanted.has(a)),
    }))
    .sort((a, b) => b.covers.length - a.covers.length);

  for (const { table, addresses, covers } of ranked) {
    const fresh = covers.filter((a) => !claimed.has(a));
    // A table's address costs 32 bytes in the message; each account it saves
    // costs 1 instead of 32. Two accounts is the break-even point.
    if (fresh.length < 2) continue;
    selected[table] = addresses;
    for (const address of fresh) claimed.add(address);
  }

  return selected;
}

/**
 * Load and select in one step, failing loudly when a batch needs compression
 * and the operator has configured nothing to compress it with.
 *
 * `required` is the caller saying "this does not fit otherwise". Without it a
 * missing table is unremarkable — most settlements are small enough that no
 * table is wanted, and using one anyway would only add bytes and give the
 * client more to verify.
 */
export async function resolveLookupTables(
  rpc: SolanaRpc,
  registry: AltRegistry,
  accounts: readonly Address[],
  required: boolean,
): Promise<AddressesByLookupTableAddress> {
  if (registry.isEmpty) {
    if (required) {
      throw new DisdkError(
        'ALT_REQUIRED',
        'This settlement is too large to fit in one transaction, and no address lookup table is configured. Set SETTLEMENT_ALT_ADDRESSES, or settle fewer obligations at once.',
      );
    }
    return {};
  }

  const loaded = await registry.load(rpc);
  const selected = selectLookupTables(loaded, accounts);

  if (required && Object.keys(selected).length === 0) {
    throw new DisdkError(
      'ALT_REQUIRED',
      'This settlement is too large to fit in one transaction, and none of the configured address lookup tables contain its accounts.',
    );
  }

  return selected;
}

/**
 * Read trusted table addresses from configuration.
 *
 * Deliberately strict. These addresses decide which accounts a transaction is
 * allowed to name without spelling them out, so a typo that silently produced
 * an empty registry would turn every oversized settlement into an unexplained
 * refusal.
 */
export function parseAltAddresses(raw: string | undefined): Address[] {
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  for (const part of parts) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(part)) {
      throw new DisdkError(
        'INTERNAL_ERROR',
        `SETTLEMENT_ALT_ADDRESSES contains "${part}", which is not a base58 address.`,
      );
    }
  }

  return parts as Address[];
}
