import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmPayphonePaymentMock = vi.fn();
const claimConfirmMock = vi.fn();
const findPaymentAttemptMock = vi.fn();
const recordConfirmResponseMock = vi.fn();
const getOrderByIdMock = vi.fn();
const markOrderPaidMock = vi.fn();
const mintDownloadTokenMock = vi.fn();
const sendMock = vi.fn();

// The route reaches for no collection directly — everything goes through lib/payments and
// lib/orders — so the db handle only has to exist.
const dbMock = {};

vi.mock('../../src/lib/db', () => ({ getDb: vi.fn().mockResolvedValue(dbMock) }));
vi.mock('../../src/lib/config', () => ({
  getDbConfig: vi.fn(() => ({})),
  getPayphoneConfig: vi.fn(() => ({ token: 'tok_x', storeId: 'store_x' })),
  getDownloadConfig: vi.fn(() => ({ ttlDays: 7, maxUses: 5 })),
  getPublicSiteUrl: vi.fn(() => 'https://josevaldiviezo.test'),
  createEmailer: vi.fn(() => ({ send: sendMock })),
}));
vi.mock('../../src/lib/payphone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/payphone')>()),
  confirmPayphonePayment: confirmPayphonePaymentMock,
}));
vi.mock('../../src/lib/payments', () => ({
  claimConfirm: claimConfirmMock,
  findPaymentAttempt: findPaymentAttemptMock,
  recordConfirmResponse: recordConfirmResponseMock,
}));
vi.mock('../../src/lib/orders', () => ({ getOrderById: getOrderByIdMock, markOrderPaid: markOrderPaidMock }));
vi.mock('../../src/lib/downloads', () => ({ mintDownloadToken: mintDownloadTokenMock }));

const { GET } = await import('../../src/pages/api/payphone-confirm.ts');

const orderId = new ObjectId();
const attemptId = new ObjectId();
const photoId = new ObjectId();
const CLIENT_TX = `${orderId.toString()}-a1b2c3d4e5f60718`;
const PAYPHONE_TX = 23178284;

const attempt = { _id: attemptId, clientTransactionId: CLIENT_TX, orderId, amountCents: 2000, lang: 'es' as const, createdAt: new Date() };

const pendingOrder = {
  _id: orderId,
  status: 'pending',
  totalCents: 2000,
  items: [
    { photoId, photoTitle: 'Sea Lion', totalCents: 1000 },
    { photoId: new ObjectId(), photoTitle: 'Dock at Dawn', totalCents: 1000 },
  ],
  customer: { email: 'buyer@example.com' },
};

const paidOrder = { ...pendingOrder, status: 'paid' };

function approved(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    httpStatus: 200,
    body: {
      transactionId: PAYPHONE_TX,
      clientTransactionId: CLIENT_TX,
      statusCode: 3,
      transactionStatus: 'Approved',
      amount: 2000,
      authorizationCode: 'W23178284',
      cardBrand: 'Visa',
      lastDigits: '4242',
      document: '1234567890',
      email: 'buyer@example.com',
      ...overrides,
    },
  };
}

/** The Astro context the route actually touches: the request URL and `redirect`. */
function call(query: string) {
  const redirect = vi.fn((location: string, status: number) => new Response(null, { status, headers: { location } }));
  return {
    redirect,
    promise: GET({ url: new URL(`http://localhost/api/payphone-confirm${query}`), redirect } as never),
  };
}

const okQuery = `?id=${PAYPHONE_TX}&clientTransactionId=${CLIENT_TX}`;

describe('GET /api/payphone-confirm', () => {
  beforeEach(() => {
    confirmPayphonePaymentMock.mockReset().mockResolvedValue(approved());
    claimConfirmMock.mockReset().mockResolvedValue(attempt);
    findPaymentAttemptMock.mockReset().mockResolvedValue(null);
    recordConfirmResponseMock.mockReset().mockResolvedValue(undefined);
    getOrderByIdMock.mockReset().mockResolvedValue(pendingOrder);
    markOrderPaidMock.mockReset().mockResolvedValue(paidOrder);
    mintDownloadTokenMock.mockReset().mockResolvedValue('raw-token-abc');
    sendMock.mockReset().mockResolvedValue(undefined);
  });

  it('400s when clientTransactionId is missing', async () => {
    const res = await call(`?id=${PAYPHONE_TX}`).promise;
    expect(res.status).toBe(400);
    expect(claimConfirmMock).not.toHaveBeenCalled();
  });

  it('400s when id is not an integer', async () => {
    const res = await call(`?id=not-a-number&clientTransactionId=${CLIENT_TX}`).promise;
    expect(res.status).toBe(400);
    expect(confirmPayphonePaymentMock).not.toHaveBeenCalled();
  });

  it('404s when no attempt matches the supplied clientTransactionId', async () => {
    claimConfirmMock.mockResolvedValue(null);
    findPaymentAttemptMock.mockResolvedValue(null);

    const res = await call(okQuery).promise;

    expect(res.status).toBe(404);
    expect(confirmPayphonePaymentMock).not.toHaveBeenCalled();
  });

  it('marks the order paid, mints one token per item and emails the links', async () => {
    const { redirect, promise } = call(okQuery);
    await promise;

    expect(markOrderPaidMock).toHaveBeenCalledWith(dbMock, {
      orderId,
      actor: 'payphone-confirm',
      payment: {
        transactionId: String(PAYPHONE_TX),
        authorizationCode: 'W23178284',
        cardBrand: 'Visa',
        lastDigits: '4242',
        document: '1234567890',
      },
      customer: { email: 'buyer@example.com', name: undefined },
    });
    expect(mintDownloadTokenMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const message = sendMock.mock.calls[0][0];
    expect(message.to).toBe('buyer@example.com');
    // Absolute, in BOTH parts. A relative path is not a link once it is inside an inbox,
    // which is the defect this replaced — and a client that strips HTML must still be
    // left with something the buyer can paste into a browser.
    expect(message.text).toContain('https://josevaldiviezo.test/api/download/raw-token-abc');
    expect(message.html).toContain('https://josevaldiviezo.test/api/download/raw-token-abc');
    // The locale comes from the stored attempt, not from the query string.
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}`, 302);
  });

  // THE security boundary. `id` and `clientTransactionId` are attacker-typeable, so an
  // approval is only an approval for *this* order if the gateway's own figure matches what
  // the order says it costs.
  it('refuses to fulfil an approved payment whose amount does not match the order total', async () => {
    confirmPayphonePaymentMock.mockResolvedValue(approved({ amount: 1 }));

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(markOrderPaidMock).not.toHaveBeenCalled();
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    // Reported as the generic failure, not a distinct probe-able string.
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}?payment=unconfirmed`, 302);
    // ...but the evidence is still on record.
    expect(recordConfirmResponseMock).toHaveBeenCalled();
  });

  it('refuses a confirm response that identifies a different transaction', async () => {
    confirmPayphonePaymentMock.mockResolvedValue(approved({ clientTransactionId: 'someone-elses-tx' }));

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(markOrderPaidMock).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}?payment=unconfirmed`, 302);
  });

  it('leaves the order pending and reports a decline on statusCode 2', async () => {
    confirmPayphonePaymentMock.mockResolvedValue(approved({ statusCode: 2, transactionStatus: 'Canceled' }));

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(markOrderPaidMock).not.toHaveBeenCalled();
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}?payment=declined`, 302);
  });

  it('records the response and leaves the order pending when the confirm call fails', async () => {
    confirmPayphonePaymentMock.mockResolvedValue({ ok: false, httpStatus: 0, body: { message: 'ETIMEDOUT' } });

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(recordConfirmResponseMock).toHaveBeenCalledWith(dbMock, attemptId, expect.objectContaining({ ok: false, httpStatus: 0 }));
    expect(markOrderPaidMock).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}?payment=unconfirmed`, 302);
  });

  // Confirm is terminal: calling it a second time errors, and that error is
  // indistinguishable from a genuine failure. The claim is what prevents it.
  it('does not call Payphone again when the buyer refreshes a return URL that already worked', async () => {
    claimConfirmMock.mockResolvedValue(null);
    findPaymentAttemptMock.mockResolvedValue({ ...attempt, confirm: { ok: true, httpStatus: 200, at: new Date(), body: approved().body } });

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(confirmPayphonePaymentMock).not.toHaveBeenCalled();
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}`, 302);
  });

  it('does not call Payphone again when a second tab loses the claim race', async () => {
    claimConfirmMock.mockResolvedValue(null);
    // Claimed but no outcome recorded yet — no message, rather than a guessed one.
    findPaymentAttemptMock.mockResolvedValue({ ...attempt, confirmStartedAt: new Date() });

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(confirmPayphonePaymentMock).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}`, 302);
  });

  // Otherwise a buyer who refreshes after a failure sees an unexplained pending order,
  // having been told what went wrong the first time.
  it('repeats the recorded failure message on a refresh rather than dropping it', async () => {
    claimConfirmMock.mockResolvedValue(null);
    findPaymentAttemptMock.mockResolvedValue({
      ...attempt,
      confirm: { ok: true, httpStatus: 200, at: new Date(), body: { ...approved().body, statusCode: 2 } },
    });

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(confirmPayphonePaymentMock).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}?payment=declined`, 302);
  });

  it('mints no second token when the order was already paid', async () => {
    markOrderPaidMock.mockResolvedValue(null);

    await call(okQuery).promise;

    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  // The crash-safety ordering is otherwise an invisible invariant: this is the only thing
  // that would notice if the persist were moved below the fulfilment.
  it('records the confirm response even when fulfilment throws', async () => {
    markOrderPaidMock.mockRejectedValue(new Error('mongo is down'));

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(recordConfirmResponseMock).toHaveBeenCalledWith(dbMock, attemptId, expect.objectContaining({ ok: true, httpStatus: 200 }));
    // The buyer is still sent to their order rather than left on an error page.
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}`, 302);
  });

  it('sends the buyer to the locale their attempt started in', async () => {
    claimConfirmMock.mockResolvedValue({ ...attempt, lang: 'en' });

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(redirect).toHaveBeenCalledWith(`/en/order/${orderId.toString()}`, 302);
  });

  it('writes the receipt in the locale the buyer paid in', async () => {
    claimConfirmMock.mockResolvedValue({ ...attempt, lang: 'en' });

    await call(okQuery).promise;

    expect(sendMock.mock.calls[0][0].subject).toContain('Your order');
    expect(sendMock.mock.calls[0][0].text).toContain('Thank you for your purchase');
  });

  // The buyer has paid, the order says paid, and the tokens exist — the order page can
  // hand over every file on its own. An email outage must not be dressed up as a failed
  // fulfilment, and above all must not cost the buyer their redirect.
  it('still completes the order when the email provider is down', async () => {
    sendMock.mockRejectedValue(new Error('Mailgun rejected the message (HTTP 401): Forbidden'));

    const { redirect, promise } = call(okQuery);
    await promise;

    expect(markOrderPaidMock).toHaveBeenCalled();
    expect(mintDownloadTokenMock).toHaveBeenCalledTimes(2);
    expect(redirect).toHaveBeenCalledWith(`/es/order/${orderId.toString()}`, 302);
  });

  it('does not attempt a send for an order with no address on it', async () => {
    markOrderPaidMock.mockResolvedValue({ ...paidOrder, customer: { email: '' } });

    await call(okQuery).promise;

    expect(mintDownloadTokenMock).toHaveBeenCalledTimes(2);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
