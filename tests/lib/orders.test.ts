import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { createPendingOrder, getOrderById, markOrderPaid, type OrderItem, type OrderPayment } from '../../src/lib/orders.ts';

function makeMockDb(config: {
  insertOneResult?: unknown;
  findOneAndUpdateResult?: unknown;
  findOneResult?: unknown;
  updateOneResult?: unknown;
}) {
  const ordersCollection = {
    insertOne: vi.fn().mockResolvedValue(config.insertOneResult),
    findOneAndUpdate: vi.fn().mockResolvedValue(config.findOneAndUpdateResult),
    findOne: vi.fn().mockResolvedValue(config.findOneResult ?? null),
    updateOne: vi.fn().mockResolvedValue(config.updateOneResult ?? {}),
  };
  const db = { collection: vi.fn(() => ordersCollection) } as unknown as Db;
  return { db, ordersCollection };
}

const sampleItems: OrderItem[] = [
  {
    photoId: new ObjectId(),
    photoSlug: 'sea-lions-dock',
    photoTitle: 'Sea Lions',
    unitPriceCents: 2000,
    totalCents: 2000,
  },
];

describe('createPendingOrder', () => {
  it('inserts a pending order with an empty customer email and a history entry, and returns it with the inserted id', async () => {
    const insertedId = new ObjectId();
    const { db, ordersCollection } = makeMockDb({ insertOneResult: { insertedId } });

    const order = await createPendingOrder(db, {
      items: sampleItems,
      subtotalCents: 2000,
      totalCents: 2000,
    });

    expect(order._id).toBe(insertedId);
    expect(order.status).toBe('pending');
    expect(order.customer).toEqual({ email: '' });
    expect(order.history).toHaveLength(1);
    expect(order.history[0].status).toBe('pending');
    expect(order.totalCents).toBe(2000);

    const insertedDoc = ordersCollection.insertOne.mock.calls[0][0];
    expect(insertedDoc.currency).toBe('usd');
    expect(insertedDoc.items).toBe(sampleItems);
  });

  // Free-credit claims are also real `paid` orders, so every revenue aggregation filters
  // on `kind`. A purchase that forgot to set it would be counted correctly by luck today
  // and incorrectly the moment the filter flips to an equality check.
  it('marks the order as a purchase, not a free claim', async () => {
    const { db, ordersCollection } = makeMockDb({ insertOneResult: { insertedId: new ObjectId() } });

    const order = await createPendingOrder(db, { items: sampleItems, subtotalCents: 2000, totalCents: 2000 });

    expect(order.kind).toBe('purchase');
    expect(ordersCollection.insertOne.mock.calls[0][0].kind).toBe('purchase');
  });
});

describe('markOrderPaid', () => {
  const orderId = new ObjectId();
  const payment: OrderPayment = { transactionId: '23178284', authorizationCode: 'W23178284', cardBrand: 'Visa', lastDigits: '4242' };

  it('filters on status: "pending" so an already-paid order can never be double-processed', async () => {
    const { db, ordersCollection } = makeMockDb({ findOneAndUpdateResult: { _id: orderId, status: 'paid' } });

    await markOrderPaid(db, { orderId, payment, actor: 'payphone-confirm' });

    const [filter] = ordersCollection.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: orderId, status: 'pending' });
  });

  it('returns null when the guard filter matches nothing (already paid, or nonexistent)', async () => {
    const { db } = makeMockDb({ findOneAndUpdateResult: null });
    const result = await markOrderPaid(db, { orderId, payment, actor: 'payphone-confirm' });
    expect(result).toBeNull();
  });

  it('omits customer from the update when not provided', async () => {
    const { db, ordersCollection } = makeMockDb({ findOneAndUpdateResult: { _id: orderId } });

    await markOrderPaid(db, { orderId, payment, actor: 'payphone-confirm' });

    const [, update] = ordersCollection.findOneAndUpdate.mock.calls[0];
    expect(update.$set).not.toHaveProperty('customer');
    expect(update.$set.status).toBe('paid');
    expect(update.$set.payment).toEqual(payment);
  });

  it('includes customer in the update when provided', async () => {
    const { db, ordersCollection } = makeMockDb({ findOneAndUpdateResult: { _id: orderId } });
    const customer = { email: 'buyer@example.com', name: 'Buyer' };

    await markOrderPaid(db, { orderId, payment, actor: 'payphone-confirm', customer });

    const [, update] = ordersCollection.findOneAndUpdate.mock.calls[0];
    expect(update.$set.customer).toEqual(customer);
  });

  // The actor is whatever the caller says it is. Asserted with two different values
  // because the behavioural claim is "it is not hard-coded" — pinning one string here is
  // how the previous version passed while being wrong for every non-webhook caller.
  it('attributes the "paid" history entry to the caller', async () => {
    for (const actor of ['payphone-confirm', 'reconcile-script']) {
      const { db, ordersCollection } = makeMockDb({ findOneAndUpdateResult: { _id: orderId } });
      await markOrderPaid(db, { orderId, payment, actor });
      const [, update] = ordersCollection.findOneAndUpdate.mock.calls[0];
      expect(update.$push.history).toMatchObject({ status: 'paid', actor });
    }
  });
});

describe('getOrderById', () => {
  it('looks up by _id', async () => {
    const orderId = new ObjectId();
    const { db, ordersCollection } = makeMockDb({ findOneResult: { _id: orderId } });
    const order = await getOrderById(db, orderId);
    expect(ordersCollection.findOne).toHaveBeenCalledWith({ _id: orderId });
    expect(order?._id).toBe(orderId);
  });
});
