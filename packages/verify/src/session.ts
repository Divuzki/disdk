import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DisdkError, type DiscordIdentity, type SessionIntent, type SessionState } from '@disdk/protocol';
import type { BuiltTransaction } from './build.js';

export interface SessionRecord {
  /** SHA-256 of the session id. The raw id is never stored. */
  idHash: string;
  /**
   * Random per-session marker written into the transaction as a memo.
   *
   * Without it, two sessions requesting the same allowance from the same wallet
   * within one blockhash window compile to byte-identical transactions — so an
   * approval made in one session would satisfy another, and since signatures
   * are public on chain anyone could replay someone else's approval to bind
   * that wallet to their own Discord account. This is distinct from the session
   * id: it ends up on chain, so it must not be a bearer token.
   */
  nonce: string;
  state: SessionState;
  intent: SessionIntent;
  discord: DiscordIdentity;
  /** Discord interaction token, so the bot can edit its original reply. */
  interactionToken?: string;
  createdAt: number;
  expiresAt: number;
  /** Set once the wallet connects. */
  owner?: string;
  /** The transaction issued for this session; the yardstick for submission. */
  pending?: BuiltTransaction;
  signature?: string;
  approvedAmount?: string;
  /** Number of transactions issued, to bound sponsor cost per session. */
  issueCount: number;
}

export interface SessionStore {
  create(input: {
    discord: DiscordIdentity;
    intent: SessionIntent;
    interactionToken?: string;
    ttlMs: number;
  }): Promise<{ sessionId: string; record: SessionRecord }>;
  /** Look up by raw session id. Returns null when absent or expired. */
  get(sessionId: string): Promise<SessionRecord | null>;
  update(sessionId: string, patch: Partial<SessionRecord>): Promise<SessionRecord>;
  /** Drop expired records. Safe to call on a timer. */
  sweep(): Promise<number>;
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export function generateSessionId(): string {
  // 32 bytes of CSPRNG, base64url so it survives a URL round trip through a
  // wallet's in-app browser without escaping.
  return randomBytes(32).toString('base64url');
}

export const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Maximum transactions issued per session. A session may legitimately need more
 * than one (a blockhash expires while the user is deciding), but this bounds
 * how much sponsor work a single link can cause.
 */
export const MAX_ISSUES_PER_SESSION = 5;

export class MemorySessionStore implements SessionStore {
  readonly #records = new Map<string, SessionRecord>();

  async create({
    discord,
    intent,
    interactionToken,
    ttlMs,
  }: {
    discord: DiscordIdentity;
    intent: SessionIntent;
    interactionToken?: string;
    ttlMs: number;
  }): Promise<{ sessionId: string; record: SessionRecord }> {
    const sessionId = generateSessionId();
    const idHash = hashSessionId(sessionId);
    const now = Date.now();

    const record: SessionRecord = {
      idHash,
      nonce: randomBytes(12).toString('hex'),
      state: 'pending',
      intent,
      discord,
      interactionToken,
      createdAt: now,
      expiresAt: now + ttlMs,
      issueCount: 0,
    };

    this.#records.set(idHash, record);
    return { sessionId, record };
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const record = this.#records.get(hashSessionId(sessionId));
    if (!record) return null;

    // Expiry is time-based, not view-based: the session must survive being
    // reopened, because a wallet deeplink reloads the same URL in a different
    // browser. Consuming it on first view would break the mobile flow entirely.
    if (Date.now() > record.expiresAt && record.state !== 'complete') {
      record.state = 'expired';
    }
    return record;
  }

  async update(sessionId: string, patch: Partial<SessionRecord>): Promise<SessionRecord> {
    const idHash = hashSessionId(sessionId);
    const record = this.#records.get(idHash);
    if (!record) throw new DisdkError('SESSION_NOT_FOUND', 'Session not found.');

    const next = { ...record, ...patch, idHash };
    this.#records.set(idHash, next);
    return next;
  }

  async sweep(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [key, record] of this.#records) {
      // Keep completed sessions a little longer so the success screen survives a refresh.
      const cutoff = record.state === 'complete' ? record.expiresAt + 60 * 60 * 1000 : record.expiresAt;
      if (now > cutoff) {
        this.#records.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Test helper. */
  get size(): number {
    return this.#records.size;
  }
}

/** Guard the state machine so a session cannot be completed twice. */
export function assertUsable(record: SessionRecord | null): SessionRecord {
  if (!record) {
    throw new DisdkError('SESSION_NOT_FOUND', 'This link is not valid.');
  }
  if (record.state === 'complete') {
    throw new DisdkError('SESSION_ALREADY_COMPLETE', 'This link has already been used.');
  }
  if (record.state === 'expired' || Date.now() > record.expiresAt) {
    throw new DisdkError('SESSION_EXPIRED', 'This link has expired. Run /connect again in Discord.');
  }
  return record;
}

/** Constant-time compare for shared secrets such as the bot API key. */
export function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
