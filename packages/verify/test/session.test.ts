import { describe, expect, it, vi } from 'vitest';
import {
  MemorySessionStore,
  assertUsable,
  generateSessionId,
  hashSessionId,
  secretEquals,
} from '../src/session.js';
import type { DiscordIdentity } from '@disdk/protocol';

const discord: DiscordIdentity = { id: '1234567890', username: 'someone' };

async function makeSession(ttlMs = 10 * 60 * 1000) {
  const store = new MemorySessionStore();
  const { sessionId, record } = await store.create({ discord, ttlMs });
  return { store, sessionId, record };
}

describe('session ids', () => {
  it('are unpredictable and URL-safe', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateSessionId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(id)).toBe(id);
    }
  });

  it('are stored hashed, never in the clear', async () => {
    const { store, sessionId, record } = await makeSession();
    expect(record.idHash).toBe(hashSessionId(sessionId));
    expect(record.idHash).not.toContain(sessionId);
    expect(JSON.stringify(await store.get(sessionId))).not.toContain(sessionId);
  });
});

describe('session lifecycle', () => {
  it('can be reopened repeatedly — a wallet deeplink reloads the same URL', async () => {
    const { store, sessionId } = await makeSession();

    // Three separate "page loads", as happens when the user bounces from the
    // Discord webview into a wallet's in-app browser.
    for (let i = 0; i < 3; i++) {
      const record = await store.get(sessionId);
      expect(record?.state).toBe('pending');
    }
  });

  it('expires on time', async () => {
    vi.useFakeTimers();
    try {
      const { store, sessionId } = await makeSession(1000);
      expect((await store.get(sessionId))?.state).toBe('pending');

      vi.advanceTimersByTime(1001);
      expect((await store.get(sessionId))?.state).toBe('expired');
      expect(() => assertUsable(null)).toThrowError(/not valid/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a second completion', async () => {
    const { store, sessionId } = await makeSession();
    await store.update(sessionId, { state: 'complete', signature: 'sig' });

    const record = await store.get(sessionId);
    expect(() => assertUsable(record)).toThrowError(/already been used/i);
  });

  it('returns null for an unknown id', async () => {
    const { store } = await makeSession();
    expect(await store.get(generateSessionId())).toBeNull();
  });

  it('keeps completed sessions past expiry so the success screen survives a refresh', async () => {
    vi.useFakeTimers();
    try {
      const { store, sessionId } = await makeSession(1000);
      await store.update(sessionId, { state: 'complete', signature: 'sig' });

      vi.advanceTimersByTime(5 * 60 * 1000);
      await store.purgeExpired();
      expect((await store.get(sessionId))?.state).toBe('complete');

      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      await store.purgeExpired();
      expect(await store.get(sessionId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps expired sessions', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemorySessionStore();
      await store.create({ discord, ttlMs: 1000 });
      await store.create({ discord, ttlMs: 1000 });
      expect(store.size).toBe(2);

      vi.advanceTimersByTime(1001);
      expect(await store.purgeExpired()).toBe(2);
      expect(store.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('secretEquals', () => {
  it('matches identical secrets and rejects everything else', () => {
    expect(secretEquals('correct-horse', 'correct-horse')).toBe(true);
    expect(secretEquals('correct-horse', 'correct-horsf')).toBe(false);
    expect(secretEquals('short', 'much-longer-secret')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});
