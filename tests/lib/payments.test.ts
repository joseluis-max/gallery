import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import {
  CONFIRM_RETRY_AFTER_MS,
  claimConfirm,
  createPaymentAttempt,
  findPaymentAttempt,
  recordConfirmResponse,
} from '../../src/lib/payments.ts';

function makeMockDb(config: { insertOneResult?: unknown; findOneAndUpdateResult?: unknown; findOneResult?: unknown } = {}) {
  const collection = {
    insertOne: vi.fn().mockResolvedValue(config.insertOneResult ?? { insertedId: new ObjectId() }),
    findOneAndUpdate: vi.fn().mockResolvedValue(config.findOneAndUpdateResult ?? null),
    findOne: vi.fn().mockResolvedValue(config.findOneResult ?? null),
    updateOne: vi.fn().mockResolvedValue({}),
  };
  const db = { collection: vi.fn(() => collection) } as unknown as Db;
  return { db, collection };
}

describe('createPaymentAttempt', () => {
  it('inserts the attempt with no confirm recorded yet', async () => {
    const insertedId = new ObjectId();
    const orderId = new ObjectId();
    const { db, collection } = makeMockDb({ insertOneResult: { insertedId } });

    const attempt = await createPaymentAttempt(db, {
      orderId,
      clientTransactionId: 'abc-123',
      amountCents: 400,
      lang: 'es',
    });

    expect(attempt._id).toBe(insertedId);
    const doc = collection.insertOne.mock.calls[0][0];
    expect(doc).toMatchObject({ clientTransactionId: 'abc-123', orderId, amountCents: 400, lang: 'es' });
    expect(doc).not.toHaveProperty('confirm');
    expect(doc).not.toHaveProperty('confirmStartedAt');
  });

  // Payphone's response URL is one static URL with no locale in it, so if this were not
  // stored the confirm route would have to take the buyer's language from a query param —
  // i.e. from the attacker.
  it('stores the locale the attempt started in', async () => {
    const { db, collection } = makeMockDb();
    await createPaymentAttempt(db, { orderId: new ObjectId(), clientTransactionId: 'x', amountCents: 1, lang: 'en' });
    expect(collection.insertOne.mock.calls[0][0].lang).toBe('en');
  });
});

describe('claimConfirm', () => {
  // The filter IS the concurrency guard — there is no other lock anywhere in this
  // integration — so it is asserted literally rather than by behaviour.
  it('claims only an attempt that is unclaimed or whose claim went stale', async () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const { db, collection } = makeMockDb({ findOneAndUpdateResult: { _id: new ObjectId() } });

    await claimConfirm(db, 'abc-123', 999, now);

    const [filter, update, options] = collection.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      clientTransactionId: 'abc-123',
      $or: [
        { confirmStartedAt: { $exists: false } },
        { confirm: { $exists: false }, confirmStartedAt: { $lt: new Date(now.getTime() - CONFIRM_RETRY_AFTER_MS) } },
      ],
    });
    expect(update).toEqual({ $set: { confirmStartedAt: now, payphoneTransactionId: 999 } });
    expect(options).toMatchObject({ returnDocument: 'after' });
  });

  // Recorded at claim time, not after confirming, so the transaction is still findable in
  // Payphone's own panel in exactly the case where confirm never completed.
  it('records the Payphone transaction id as part of the claim', async () => {
    const { db, collection } = makeMockDb({ findOneAndUpdateResult: { _id: new ObjectId() } });
    await claimConfirm(db, 'abc-123', 23178284, new Date());
    expect(collection.findOneAndUpdate.mock.calls[0][1].$set.payphoneTransactionId).toBe(23178284);
  });

  it('returns null when the filter matches nothing — someone else owns or already ran the confirm', async () => {
    const { db } = makeMockDb({ findOneAndUpdateResult: null });
    expect(await claimConfirm(db, 'abc-123', 1, new Date())).toBeNull();
  });
});

describe('recordConfirmResponse', () => {
  // Persisting a failure is the whole point: a decline, a timeout and a 500 each need to
  // survive so reconciliation can tell them apart later.
  it('persists a failed confirm, not just a successful one', async () => {
    const id = new ObjectId();
    const { db, collection } = makeMockDb();
    const record = { ok: false, httpStatus: 0, at: new Date(), body: { message: 'ETIMEDOUT' } };

    await recordConfirmResponse(db, id, record);

    expect(collection.updateOne).toHaveBeenCalledWith({ _id: id }, { $set: { confirm: record } });
  });
});

describe('findPaymentAttempt', () => {
  it('looks up by clientTransactionId', async () => {
    const { db, collection } = makeMockDb({ findOneResult: { clientTransactionId: 'abc-123' } });
    const found = await findPaymentAttempt(db, 'abc-123');
    expect(collection.findOne).toHaveBeenCalledWith({ clientTransactionId: 'abc-123' });
    expect(found?.clientTransactionId).toBe('abc-123');
  });
});
