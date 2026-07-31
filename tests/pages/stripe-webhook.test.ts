import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructEventMock = vi.fn();
const markOrderPaidMock = vi.fn();
const mintDownloadTokenMock = vi.fn();
const sendEmailMock = vi.fn();

const stripeEventsCollection = {
  findOne: vi.fn(),
  updateOne: vi.fn().mockResolvedValue({}),
};
const dbMock = {
  collection: vi.fn((name: string) => {
    if (name === 'stripeEvents') return stripeEventsCollection;
    throw new Error(`unexpected collection: ${name}`);
  }),
};

vi.mock('../../src/lib/db', () => ({ getDb: vi.fn().mockResolvedValue(dbMock) }));
vi.mock('../../src/lib/config', () => ({
  getDbConfig: vi.fn(() => ({})),
  getStripeConfig: vi.fn(() => ({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' })),
  getDownloadConfig: vi.fn(() => ({ ttlDays: 7, maxUses: 5 })),
}));
vi.mock('../../src/lib/stripe', () => ({
  createStripeClient: vi.fn(() => ({ webhooks: { constructEvent: constructEventMock } })),
}));
vi.mock('../../src/lib/orders', () => ({ markOrderPaid: markOrderPaidMock }));
vi.mock('../../src/lib/downloads', () => ({ mintDownloadToken: mintDownloadTokenMock }));
vi.mock('../../src/lib/email', () => ({ sendEmail: sendEmailMock }));

const { POST } = await import('../../src/pages/api/stripe-webhook.ts');

function makeRequest(body: string, signature: string | null = 't=1,v1=sig') {
  const headers = new Headers();
  if (signature) headers.set('stripe-signature', signature);
  return new Request('http://localhost/api/stripe-webhook', { method: 'POST', body, headers });
}

const orderId = new ObjectId();
const photoId = new ObjectId();

function makeSessionEvent(id = 'evt_1') {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        metadata: { orderId: orderId.toString() },
        payment_intent: 'pi_123',
        customer_details: { email: 'buyer@example.com', name: 'Buyer' },
        collected_information: null,
      },
    },
  };
}

const paidOrder = {
  _id: orderId,
  items: [{ type: 'digital', photoId, photoTitle: 'Sea Lion', qty: 1, totalCents: 2000 }],
  totalCents: 2000,
  customer: { email: 'buyer@example.com' },
};

describe('POST /api/stripe-webhook', () => {
  beforeEach(() => {
    constructEventMock.mockReset();
    markOrderPaidMock.mockReset();
    mintDownloadTokenMock.mockReset().mockResolvedValue('raw-token-abc');
    sendEmailMock.mockReset();
    stripeEventsCollection.findOne.mockReset();
    stripeEventsCollection.updateOne.mockReset().mockResolvedValue({});
  });

  it('400s when the stripe-signature header is missing', async () => {
    const res = await POST({ request: makeRequest('{}', null) } as never);
    expect(res.status).toBe(400);
    expect(constructEventMock).not.toHaveBeenCalled();
  });

  it('400s when signature verification throws', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('bad signature');
    });
    const res = await POST({ request: makeRequest('{}') } as never);
    expect(res.status).toBe(400);
  });

  it('processes a new checkout.session.completed event and marks it processed', async () => {
    const event = makeSessionEvent();
    constructEventMock.mockReturnValue(event);
    stripeEventsCollection.findOne.mockResolvedValue(null); // never seen before
    markOrderPaidMock.mockResolvedValue(paidOrder);

    const res = await POST({ request: makeRequest('{}') } as never);

    expect(res.status).toBe(200);
    expect(markOrderPaidMock).toHaveBeenCalledWith(
      dbMock,
      expect.objectContaining({ orderId, paymentIntentId: 'pi_123' }),
    );
    // One digital line -> exactly one token minted, one email sent.
    expect(mintDownloadTokenMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // The event is marked processed only after successful handling.
    expect(stripeEventsCollection.updateOne).toHaveBeenLastCalledWith(
      { eventId: event.id },
      { $set: { processedAt: expect.any(Date) } },
    );
  });

  it('is idempotent: a replayed event that was already processed mints no second token', async () => {
    const event = makeSessionEvent('evt_replayed');
    constructEventMock.mockReturnValue(event);
    stripeEventsCollection.findOne.mockResolvedValue({ eventId: event.id, processedAt: new Date() });

    const res = await POST({ request: makeRequest('{}') } as never);

    expect(res.status).toBe(200);
    expect(markOrderPaidMock).not.toHaveBeenCalled();
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not mark the event processed if handling throws, so Stripe will retry', async () => {
    const event = makeSessionEvent('evt_fails');
    constructEventMock.mockReturnValue(event);
    stripeEventsCollection.findOne.mockResolvedValue(null);
    markOrderPaidMock.mockRejectedValue(new Error('mongo blip'));

    const res = await POST({ request: makeRequest('{}') } as never);

    expect(res.status).toBe(500);
    expect(stripeEventsCollection.updateOne).not.toHaveBeenCalledWith(
      { eventId: event.id },
      { $set: { processedAt: expect.any(Date) } },
    );
  });

  it('does nothing further when the order was already paid (findOneAndUpdate guard returns null)', async () => {
    const event = makeSessionEvent('evt_already_paid');
    constructEventMock.mockReturnValue(event);
    stripeEventsCollection.findOne.mockResolvedValue(null);
    markOrderPaidMock.mockResolvedValue(null); // status:'pending' filter guard didn't match

    const res = await POST({ request: makeRequest('{}') } as never);

    expect(res.status).toBe(200);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ignores event types other than checkout.session.completed without erroring', async () => {
    const event = { id: 'evt_other', type: 'payment_intent.created', data: { object: {} } };
    constructEventMock.mockReturnValue(event);
    stripeEventsCollection.findOne.mockResolvedValue(null);

    const res = await POST({ request: makeRequest('{}') } as never);

    expect(res.status).toBe(200);
    expect(markOrderPaidMock).not.toHaveBeenCalled();
  });
});
