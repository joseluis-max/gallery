import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const markOrderPaidMock = vi.fn();
const mintDownloadTokenMock = vi.fn();
const sendMock = vi.fn();

vi.mock('../../src/lib/orders', () => ({ markOrderPaid: markOrderPaidMock }));
vi.mock('../../src/lib/downloads', () => ({ mintDownloadToken: mintDownloadTokenMock }));

const { fulfilOrder } = await import('../../src/lib/fulfilment.ts');

// Nothing here reaches a collection directly — everything goes through lib/orders and
// lib/downloads — so the handle only has to exist.
const dbMock = {} as never;

const orderId = new ObjectId();
const photoA = new ObjectId();
const photoB = new ObjectId();

const order = {
  _id: orderId,
  status: 'pending',
  totalCents: 600,
  items: [
    { photoId: photoA, photoTitle: 'Sea Lion', totalCents: 300 },
    { photoId: photoB, photoTitle: 'Dock at Dawn', totalCents: 300 },
  ],
  customer: { email: 'buyer@example.com' },
} as never;

const paidOrder = { ...(order as object), status: 'paid' };

function params(overrides: Record<string, unknown> = {}) {
  return {
    order,
    actor: 'admin:jose@example.com',
    lang: 'es' as const,
    payment: { method: 'transfer' as const, transactionId: 'review-1' },
    siteUrl: 'https://josevaldiviezo.test',
    ttlDays: 7,
    maxUses: 5,
    emailer: { send: sendMock },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  markOrderPaidMock.mockResolvedValue(paidOrder);
  mintDownloadTokenMock.mockResolvedValue('raw-token-abc');
  sendMock.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('fulfilOrder', () => {
  it('marks the order paid with the caller’s actor and payment, then mints one token per item', async () => {
    const result = await fulfilOrder(dbMock, params());

    expect(markOrderPaidMock).toHaveBeenCalledWith(dbMock, {
      orderId,
      actor: 'admin:jose@example.com',
      payment: { method: 'transfer', transactionId: 'review-1' },
    });
    expect(mintDownloadTokenMock).toHaveBeenCalledTimes(2);
    expect(mintDownloadTokenMock).toHaveBeenCalledWith(dbMock, { orderId, photoId: photoA, ttlDays: 7, maxUses: 5 });
    expect(result.paid).toBe(paidOrder);
    expect(result.emailed).toBe(true);
  });

  it('emails absolute download links, in both parts of the message', async () => {
    await fulfilOrder(dbMock, params());

    const message = sendMock.mock.calls[0][0];
    expect(message.to).toBe('buyer@example.com');
    // A relative path is not a link once it is inside an inbox — and a client that strips
    // HTML must still leave the buyer something they can paste into a browser.
    expect(message.text).toContain('https://josevaldiviezo.test/api/download/raw-token-abc');
    expect(message.html).toContain('https://josevaldiviezo.test/api/download/raw-token-abc');
  });

  // THE guard. An order already paid — a double-clicked Approve, a retried confirm — must
  // never produce a second set of tokens or a second receipt.
  it('does nothing at all when the order was already paid', async () => {
    markOrderPaidMock.mockResolvedValue(null);

    const result = await fulfilOrder(dbMock, params());

    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toEqual({ paid: null, emailed: false });
  });

  // The money is accounted for and the tokens exist by this point; the order page shows
  // its own links. A mail outage must not read as a failed fulfilment.
  it('still reports the order as paid when the email fails to send', async () => {
    sendMock.mockRejectedValue(new Error('mailgun down'));

    const result = await fulfilOrder(dbMock, params());

    expect(result.paid).toBe(paidOrder);
    expect(result.emailed).toBe(false);
  });

  it('skips the email, but keeps the order paid, when there is no address on it', async () => {
    markOrderPaidMock.mockResolvedValue({ ...(paidOrder as object), customer: { email: '' } });

    const result = await fulfilOrder(dbMock, params());

    expect(mintDownloadTokenMock).toHaveBeenCalledTimes(2);
    expect(sendMock).not.toHaveBeenCalled();
    expect(result.emailed).toBe(false);
  });

  it('passes the customer override through only when one is given', async () => {
    await fulfilOrder(dbMock, params({ customer: { email: 'gateway@example.com' } }));
    expect(markOrderPaidMock.mock.calls[0][1].customer).toEqual({ email: 'gateway@example.com' });

    markOrderPaidMock.mockClear();
    await fulfilOrder(dbMock, params());
    expect('customer' in markOrderPaidMock.mock.calls[0][1]).toBe(false);
  });

  it('writes the order link in the buyer’s own locale', async () => {
    await fulfilOrder(dbMock, params({ lang: 'en' }));

    expect(sendMock.mock.calls[0][0].text).toContain(`https://josevaldiviezo.test/en/order/${orderId.toString()}`);
  });
});
