import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { attachStripeSession, createPendingOrder, getOrderById, markOrderPaid, type OrderItem } from '../../src/lib/orders.ts';

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
    type: 'print',
    photoId: new ObjectId(),
    photoSlug: 'sea-lions-dock',
    photoTitle: 'Sea Lions',
    size: { widthCm: 30, heightCm: 20 },
    paper: 'matte',
    crop: 'fit',
    qty: 1,
    unitPriceCents: 5000,
    totalCents: 5000,
  },
];

describe('createPendingOrder', () => {
  it('inserts a pending order with an empty customer email and a history entry, and returns it with the inserted id', async () => {
    const insertedId = new ObjectId();
    const { db, ordersCollection } = makeMockDb({ insertOneResult: { insertedId } });

    const order = await createPendingOrder(db, {
      items: sampleItems,
      subtotalCents: 5000,
      shippingCents: 500,
      totalCents: 5500,
    });

    expect(order._id).toBe(insertedId);
    expect(order.status).toBe('pending');
    expect(order.customer).toEqual({ email: '' });
    expect(order.history).toHaveLength(1);
    expect(order.history[0].status).toBe('pending');
    expect(order.totalCents).toBe(5500);

    const insertedDoc = ordersCollection.insertOne.mock.calls[0][0];
    expect(insertedDoc.currency).toBe('usd');
    expect(insertedDoc.items).toBe(sampleItems);
  });
});

describe('attachStripeSession', () => {
  it('sets stripeSessionId on the matching order', async () => {
    const orderId = new ObjectId();
    const { db, ordersCollection } = makeMockDb({});

    await attachStripeSession(db, orderId, 'cs_test_123');

    expect(ordersCollection.updateOne).toHaveBeenCalledWith(
      { _id: orderId },
      { $set: { stripeSessionId: 'cs_test_123', updatedAt: expect.any(Date) } },
    );
  });
});

describe('markOrderPaid', () => {
  const orderId = new ObjectId();

  it('filters on status: "pending" so an already-paid order can never be double-processed', async () => {
    const { db, ordersCollection } = makeMockDb({ findOneAndUpdateResult: { _id: orderId, status: 'paid' } });

    await markOrderPaid(db, { orderId, paymentIntentId: 'pi_1' });

    const [filter] = ordersCollection.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: orderId, status: 'pending' });
  });

  it('returns null when the guard filter matches nothing (already paid, or nonexistent)', async () => {
    const { db } = makeMockDb({ findOneAndUpdateResult: null });
    const result = await markOrderPaid(db, { orderId, paymentIntentId: 'pi_1' });
    expect(result).toBeNull();
  });

  it('omits customer/shippingAddress from the update when not provided', async () => {
    const { db, ordersCollection } = makeMockDb({ findOneAndUpdateResult: { _id: orderId } });

    await markOrderPaid(db, { orderId, paymentIntentId: 'pi_1' });

    const [, update] = ordersCollection.findOneAndUpdate.mock.calls[0];
    expect(update.$set).not.toHaveProperty('customer');
    expect(update.$set).not.toHaveProperty('shippingAddress');
    expect(update.$set.status).toBe('paid');
    expect(update.$set.stripePaymentIntentId).toBe('pi_1');
  });

  it('includes customer/shippingAddress in the update when provided', async () => {
    const { db, ordersCollection } = makeMockDb({ findOneAndUpdateResult: { _id: orderId } });
    const customer = { email: 'buyer@example.com', name: 'Buyer' };
    const shippingAddress = {
      name: 'Buyer',
      line1: '123 Main St',
      city: 'Cuenca',
      postalCode: '010101',
      country: 'EC',
    };

    await markOrderPaid(db, { orderId, paymentIntentId: 'pi_1', customer, shippingAddress });

    const [, update] = ordersCollection.findOneAndUpdate.mock.calls[0];
    expect(update.$set.customer).toEqual(customer);
    expect(update.$set.shippingAddress).toEqual(shippingAddress);
  });

  it('pushes a "paid" history entry', async () => {
    const { db, ordersCollection } = makeMockDb({ findOneAndUpdateResult: { _id: orderId } });
    await markOrderPaid(db, { orderId, paymentIntentId: 'pi_1' });
    const [, update] = ordersCollection.findOneAndUpdate.mock.calls[0];
    expect(update.$push.history).toMatchObject({ status: 'paid', actor: 'stripe-webhook' });
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
