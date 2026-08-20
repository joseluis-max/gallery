import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import {
  consumePasswordResetToken,
  invalidatePasswordResetTokens,
  mintPasswordResetToken,
  RESET_TOKEN_TTL_MINUTES,
} from '../../src/lib/passwordReset.ts';
import { hashToken } from '../../src/lib/tokens.ts';

function makeMockDb(
  config: { findOneAndUpdateResult?: unknown; findOneResult?: unknown } = {},
) {
  const collection = {
    insertOne: vi.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    findOneAndUpdate: vi.fn().mockResolvedValue(config.findOneAndUpdateResult ?? null),
    findOne: vi.fn().mockResolvedValue(config.findOneResult ?? null),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }),
  };
  const db = { collection: vi.fn(() => collection) } as unknown as Db;
  return { db, collection };
}

describe('mintPasswordResetToken', () => {
  it('returns the raw token but persists only its digest — a database dump is not a set of working links', async () => {
    const { db, collection } = makeMockDb();
    const userId = new ObjectId();

    const raw = await mintPasswordResetToken(db, { userId, email: 'buyer@example.com' });

    const stored = collection.insertOne.mock.calls[0][0];
    expect(stored.tokenHash).toBe(hashToken(raw));
    expect(JSON.stringify(stored)).not.toContain(raw);
    expect(stored.userId).toBe(userId);
    expect(stored.email).toBe('buyer@example.com');
  });

  it('expires an hour out by default, and honours an explicit TTL', async () => {
    const { db, collection } = makeMockDb();
    const before = Date.now();

    await mintPasswordResetToken(db, { userId: new ObjectId(), email: 'buyer@example.com' });
    const defaultTtl = collection.insertOne.mock.calls[0][0].expiresAt.getTime() - before;
    expect(defaultTtl).toBeGreaterThan((RESET_TOKEN_TTL_MINUTES - 1) * 60 * 1000);
    expect(defaultTtl).toBeLessThanOrEqual(RESET_TOKEN_TTL_MINUTES * 60 * 1000 + 1000);

    await mintPasswordResetToken(db, { userId: new ObjectId(), email: 'buyer@example.com', ttlMinutes: 5 });
    const shortTtl = collection.insertOne.mock.calls[1][0].expiresAt.getTime() - before;
    expect(shortTtl).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });

  it('is never minted un-used: a fresh token carries no usedAt, which is what the consume filter matches on', async () => {
    const { db, collection } = makeMockDb();
    await mintPasswordResetToken(db, { userId: new ObjectId(), email: 'buyer@example.com' });
    expect(collection.insertOne.mock.calls[0][0]).not.toHaveProperty('usedAt');
  });
});

describe('consumePasswordResetToken', () => {
  it('returns the owning user when the link is live', async () => {
    const userId = new ObjectId();
    const { db } = makeMockDb({ findOneAndUpdateResult: { userId } });

    expect(await consumePasswordResetToken(db, 'raw-token')).toEqual({ ok: true, userId });
  });

  it('burns the token in the same write that reads it, so two concurrent submissions cannot both succeed', async () => {
    const { db, collection } = makeMockDb({ findOneAndUpdateResult: { userId: new ObjectId() } });
    await consumePasswordResetToken(db, 'raw-token');

    const [filter, update] = collection.findOneAndUpdate.mock.calls[0];
    // Every rule is in the filter — an unused, unexpired token — rather than in a
    // preceding read that a second request could pass before the first one wrote.
    expect(filter.tokenHash).toBe(hashToken('raw-token'));
    expect(filter.usedAt).toEqual({ $exists: false });
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
    expect(update.$set.usedAt).toBeInstanceOf(Date);
  });

  it('reports USED for a link that was already spent', async () => {
    const { db } = makeMockDb({
      findOneAndUpdateResult: null,
      findOneResult: { usedAt: new Date(), expiresAt: new Date(Date.now() + 10_000) },
    });
    expect(await consumePasswordResetToken(db, 'raw-token')).toEqual({ ok: false, reason: 'USED' });
  });

  it('reports EXPIRED for a link past its TTL', async () => {
    const { db } = makeMockDb({
      findOneAndUpdateResult: null,
      findOneResult: { expiresAt: new Date(Date.now() - 10_000) },
    });
    expect(await consumePasswordResetToken(db, 'raw-token')).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('reports NOT_FOUND for a guessed token, and for one the TTL index already swept', async () => {
    const { db } = makeMockDb({ findOneAndUpdateResult: null, findOneResult: null });
    expect(await consumePasswordResetToken(db, 'made-up')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('never looks a token up by its raw value', async () => {
    const { db, collection } = makeMockDb({ findOneAndUpdateResult: null, findOneResult: null });
    await consumePasswordResetToken(db, 'raw-token');
    expect(collection.findOne.mock.calls[0][0]).toEqual({ tokenHash: hashToken('raw-token') });
  });
});

describe('invalidatePasswordResetTokens', () => {
  it('retires every outstanding link for the account, and leaves already-used ones alone', async () => {
    const { db, collection } = makeMockDb();
    const userId = new ObjectId();

    await invalidatePasswordResetTokens(db, userId);

    const [filter, update] = collection.updateMany.mock.calls[0];
    expect(filter).toEqual({ userId, usedAt: { $exists: false } });
    expect(update.$set.usedAt).toBeInstanceOf(Date);
  });
});

/**
 * The round trip, against a collection that actually evaluates the filters rather than
 * recording that they were passed.
 *
 * The mocked tests above assert the *shape* of each query, which is what catches a filter
 * being dropped. It cannot catch a filter that is present and wrong — `usedAt: null`
 * instead of `{ $exists: false }`, `$gte` where `$gt` belongs — because a mock returns
 * whatever it was told to regardless. Single use is the entire security property of a
 * reset link, so it is worth proving against something that can genuinely say no.
 */
function makeInMemoryDb() {
  const docs: Record<string, unknown>[] = [];

  const matches = (doc: Record<string, any>, filter: Record<string, any>): boolean =>
    Object.entries(filter).every(([field, condition]) => {
      if (condition && typeof condition === 'object' && !(condition instanceof Date) && !(condition instanceof ObjectId)) {
        if ('$exists' in condition) return (doc[field] !== undefined) === condition.$exists;
        if ('$gt' in condition) return doc[field] > condition.$gt;
      }
      return String(doc[field]) === String(condition);
    });

  const collection = {
    insertOne: async (doc: Record<string, unknown>) => {
      docs.push({ ...doc });
      return { insertedId: new ObjectId() };
    },
    findOne: async (filter: Record<string, unknown>) => docs.find((doc) => matches(doc, filter)) ?? null,
    findOneAndUpdate: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const found = docs.find((doc) => matches(doc, filter));
      if (!found) return null;
      Object.assign(found, update.$set);
      return found;
    },
    updateMany: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const found = docs.filter((doc) => matches(doc, filter));
      for (const doc of found) Object.assign(doc, update.$set);
      return { modifiedCount: found.length };
    },
  };

  return { db: { collection: () => collection } as unknown as Db, docs };
}

describe('the reset link, end to end', () => {
  it('works exactly once — the second use of the same link is refused', async () => {
    const { db } = makeInMemoryDb();
    const userId = new ObjectId();

    const raw = await mintPasswordResetToken(db, { userId, email: 'buyer@example.com' });

    const first = await consumePasswordResetToken(db, raw);
    expect(first).toEqual({ ok: true, userId });

    const second = await consumePasswordResetToken(db, raw);
    expect(second).toEqual({ ok: false, reason: 'USED' });
  });

  it('refuses a link whose hour is up, even though it was never used', async () => {
    const { db } = makeInMemoryDb();

    const raw = await mintPasswordResetToken(db, {
      userId: new ObjectId(),
      email: 'buyer@example.com',
      ttlMinutes: -1,
    });

    expect(await consumePasswordResetToken(db, raw)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('kills an older link when a newer one is used, so a spare email in the inbox is not a second key', async () => {
    const { db } = makeInMemoryDb();
    const userId = new ObjectId();

    const older = await mintPasswordResetToken(db, { userId, email: 'buyer@example.com' });
    const newer = await mintPasswordResetToken(db, { userId, email: 'buyer@example.com' });

    expect(await consumePasswordResetToken(db, newer)).toEqual({ ok: true, userId });
    // What the action does immediately after a successful reset.
    await invalidatePasswordResetTokens(db, userId);

    expect(await consumePasswordResetToken(db, older)).toEqual({ ok: false, reason: 'USED' });
  });

  it("does not touch another account's links", async () => {
    const { db } = makeInMemoryDb();
    const mine = new ObjectId();
    const theirs = new ObjectId();

    const theirLink = await mintPasswordResetToken(db, { userId: theirs, email: 'other@example.com' });
    await mintPasswordResetToken(db, { userId: mine, email: 'buyer@example.com' });

    await invalidatePasswordResetTokens(db, mine);

    expect(await consumePasswordResetToken(db, theirLink)).toEqual({ ok: true, userId: theirs });
  });
});
