import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getOrderByIdMock = vi.fn();
const mintDownloadTokenMock = vi.fn();
const findActiveUserByIdMock = vi.fn();

vi.mock('../../src/lib/db', () => ({ getDb: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/lib/config', () => ({
  getDbConfig: vi.fn(() => ({})),
  getDownloadConfig: vi.fn(() => ({ ttlDays: 7, maxUses: 5 })),
}));
vi.mock('../../src/lib/downloads', () => ({ mintDownloadToken: mintDownloadTokenMock }));
// `canViewOrder` is deliberately NOT mocked: it is the authorization rule this route
// exists to inherit, and a stubbed one would let the route drift away from the order page
// it is linked from without a single test noticing.
vi.mock('../../src/lib/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/orders')>()),
  getOrderById: getOrderByIdMock,
}));
vi.mock('../../src/lib/users', () => ({ findActiveUserById: findActiveUserByIdMock }));

const { GET } = await import('../../src/pages/api/order-download/[orderId]/[photoId].ts');

const orderId = new ObjectId();
const photoId = new ObjectId();
const ownerId = new ObjectId();

const guestOrder = {
  _id: orderId,
  status: 'paid',
  items: [{ photoId, photoTitle: 'Sea Lion', totalCents: 175 }],
  customer: { email: 'buyer@example.com' },
};

const accountOrder = { ...guestOrder, userId: ownerId };

/**
 * `user` is what the session COOKIE claims; `dbUser` is what the database still says.
 * Keeping them separate is the point — the cookie's copy of `role` is a snapshot from
 * sign-in, and the route must not trust it. Omit `dbUser` for the ordinary case where the
 * two agree; pass `null` for a disabled/deleted account, or a different role for a demotion.
 */
function call(
  params: { orderId?: string; photoId?: string },
  user?: { id: string; role: string },
  dbUser?: { role: string } | null,
) {
  findActiveUserByIdMock.mockResolvedValue(dbUser === undefined ? (user ? { role: user.role } : null) : dbUser);
  const redirect = vi.fn((location: string, status: number) => new Response(null, { status, headers: { location } }));
  const session = { get: vi.fn().mockResolvedValue(user) };
  return { redirect, promise: GET({ params, redirect, session } as never) };
}

const okParams = { orderId: orderId.toString(), photoId: photoId.toString() };

describe('GET /api/order-download/[orderId]/[photoId]', () => {
  beforeEach(() => {
    getOrderByIdMock.mockReset().mockResolvedValue(guestOrder);
    mintDownloadTokenMock.mockReset().mockResolvedValue('fresh-token');
    findActiveUserByIdMock.mockReset();
  });

  it('mints a token on the click and hands off to the one route that serves originals', async () => {
    const { redirect, promise } = call(okParams);
    await promise;

    expect(mintDownloadTokenMock).toHaveBeenCalledWith({}, { orderId, photoId, ttlDays: 7, maxUses: 5 });
    expect(redirect).toHaveBeenCalledWith('/api/download/fresh-token', 302);
  });

  it.each([
    ['a malformed order id', { orderId: 'not-an-objectid', photoId: photoId.toString() }],
    ['a malformed photo id', { orderId: orderId.toString(), photoId: 'nope' }],
    ['no parameters at all', {}],
  ])('404s and mints nothing for %s', async (_label, params) => {
    const response = await call(params).promise;

    expect(response.status).toBe(404);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  it('404s when the order does not exist', async () => {
    getOrderByIdMock.mockResolvedValue(null);

    const response = await call(okParams).promise;

    expect(response.status).toBe(404);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  // Without this, any valid order id would mint a token for any photograph in the
  // catalogue — an order entitles its buyer to the photographs actually in it.
  it('404s for a photograph that is not in the order', async () => {
    const response = await call({ orderId: orderId.toString(), photoId: new ObjectId().toString() }).promise;

    expect(response.status).toBe(404);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  it('403s while the order is still awaiting payment', async () => {
    getOrderByIdMock.mockResolvedValue({ ...guestOrder, status: 'pending' });

    const response = await call(okParams).promise;

    expect(response.status).toBe(403);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'refunded'] as const)('403s on a %s order', async (status) => {
    getOrderByIdMock.mockResolvedValue({ ...guestOrder, status });

    const response = await call(okParams).promise;

    expect(response.status).toBe(403);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  // An order bound to an account is that account's, and a signed-out visitor holding the
  // id gets the same answer as one holding a made-up id.
  it('404s for an account order when nobody is signed in', async () => {
    getOrderByIdMock.mockResolvedValue(accountOrder);

    const response = await call(okParams).promise;

    expect(response.status).toBe(404);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  it('404s for an account order belonging to somebody else', async () => {
    getOrderByIdMock.mockResolvedValue(accountOrder);

    const response = await call(okParams, { id: new ObjectId().toString(), role: 'customer' }).promise;

    expect(response.status).toBe(404);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  it('serves the owner of an account order', async () => {
    getOrderByIdMock.mockResolvedValue(accountOrder);

    const { redirect, promise } = call(okParams, { id: ownerId.toString(), role: 'customer' });
    await promise;

    expect(redirect).toHaveBeenCalledWith('/api/download/fresh-token', 302);
  });

  it('serves an admin looking at somebody else’s order', async () => {
    getOrderByIdMock.mockResolvedValue(accountOrder);

    const { redirect, promise } = call(okParams, { id: new ObjectId().toString(), role: 'admin' });
    await promise;

    expect(redirect).toHaveBeenCalledWith('/api/download/fresh-token', 302);
  });

  // The deliberate widening this route carries, pinned so it cannot change by accident:
  // a guest order has no account to authenticate against, so the unguessable order id is
  // the credential — for the files as well as for the receipt.
  it('serves a guest order to anyone holding the order id', async () => {
    const { redirect, promise } = call(okParams);
    await promise;

    expect(redirect).toHaveBeenCalledWith('/api/download/fresh-token', 302);
  });

  // The session is a snapshot taken at sign-in. Trusting its `role` would mean the demote
  // button does nothing until the offender's cookie happens to expire — on precisely the
  // day it matters. Issuing a download is at least as privileged as reading the admin
  // panel, which src/middleware.ts already re-reads for.
  it('refuses a demoted admin whose cookie still says admin', async () => {
    getOrderByIdMock.mockResolvedValue(accountOrder);

    const response = await call(okParams, { id: new ObjectId().toString(), role: 'admin' }, { role: 'customer' }).promise;

    expect(response.status).toBe(404);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  it('refuses a disabled account holding a live session, even on its own order', async () => {
    getOrderByIdMock.mockResolvedValue(accountOrder);

    const response = await call(okParams, { id: ownerId.toString(), role: 'customer' }, null).promise;

    expect(response.status).toBe(404);
    expect(mintDownloadTokenMock).not.toHaveBeenCalled();
  });

  // canViewOrder ignores the viewer entirely for a guest order, so re-reading the account
  // there would be a database round-trip that cannot change the answer.
  it('does not re-read the account for a guest order', async () => {
    const { promise } = call(okParams, { id: ownerId.toString(), role: 'customer' });
    await promise;

    expect(findActiveUserByIdMock).not.toHaveBeenCalled();
  });
});
