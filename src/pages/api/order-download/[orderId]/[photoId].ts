// The order page's download button.
//
// Why this exists rather than the page simply printing the links it already minted: only
// the *hash* of a download token is ever stored (see lib/downloads.ts), so a raw token is
// recoverable exactly once, at the moment it is created, and after fulfilment has emailed
// it there is nothing left on the server to render. The page therefore links here, and a
// token is minted when a buyer actually clicks — one row per real download request, rather
// than a fresh token on every page view, refresh, and crawl.
//
// It mints and redirects instead of reaching for the original itself, deliberately.
// `/api/download/[token]` stays the one and only thing in this codebase that touches an
// original file, so every expiry, use-cap and paid-status check keeps living in exactly one
// place — the property lib/downloads.ts and actions/downloads.ts both go out of their way
// to protect.
//
// AUTHORIZATION, and the one real trade-off here: this grants precisely what
// `canViewOrder` grants, which for a *guest* order means anyone holding the 96-bit order id
// can download the files, not merely read the receipt. That is a deliberate widening. The
// alternative — restricting on-page downloads to signed-in owners, as `downloads.reissue`
// does — leaves guest buyers with no way to get what they paid for other than an email,
// and email is exactly the leg that can fail. The order id is unguessable and is already
// the credential that reveals the buyer's name, items and total; this makes it the
// credential for the files as well.
import { ObjectId } from 'mongodb';
import type { APIRoute } from 'astro';
import { getDbConfig, getDownloadConfig } from '../../../../lib/config';
import { getDb } from '../../../../lib/db';
import { mintDownloadToken } from '../../../../lib/downloads';
import { canViewOrder, getOrderById } from '../../../../lib/orders';
import { findActiveUserById, type SessionUser } from '../../../../lib/users';

export const prerender = false;

/** 404 rather than 403 for anything that would otherwise confirm an order or item exists —
 *  the same reasoning as `[lang]/order/[id].astro`, and the same wording as the token
 *  route, so probing this endpoint tells an attacker nothing the order page doesn't. */
function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/**
 * Who the caller counts as, for `canViewOrder`'s purposes.
 *
 * The session holds a *snapshot* taken at sign-in, and `role` inside it is what lets an
 * admin read any order — so trusting it here would let an admin who has since been demoted
 * or disabled keep minting download tokens for every order in the shop. src/middleware.ts
 * already refuses to trust that snapshot for the admin panel, but it only guards `/admin/*`
 * and this route is not under it; `requireSessionUser` does the same for Actions, and this
 * is not an Action either. Issuing a download is at least as privileged as reading the
 * panel, so it re-reads too.
 *
 * Only for account-owned orders, though. `canViewOrder` ignores the viewer entirely when
 * an order has no `userId`, so a lookup on the guest path would be a database round-trip
 * that cannot change the answer.
 */
async function resolveViewer(
  db: Awaited<ReturnType<typeof getDb>>,
  order: { userId?: unknown },
  sessionUser: SessionUser | undefined,
): Promise<SessionUser | undefined> {
  if (!sessionUser || !order.userId) return sessionUser;
  const current = await findActiveUserById(db, sessionUser.id);
  return current ? { ...sessionUser, role: current.role } : undefined;
}

export const GET: APIRoute = async ({ params, redirect, session }) => {
  let orderId: InstanceType<typeof ObjectId>;
  let photoId: InstanceType<typeof ObjectId>;
  try {
    orderId = new ObjectId(params.orderId);
    photoId = new ObjectId(params.photoId);
  } catch {
    return notFound();
  }

  const db = await getDb(getDbConfig());
  const order = await getOrderById(db, orderId);
  if (!order) return notFound();

  const viewer = await resolveViewer(db, order, await session?.get('user'));
  if (!canViewOrder(order, viewer)) return notFound();

  // Not folded into the 404 above: a viewer who is allowed to see this order but whose
  // payment has not landed yet is a real customer looking at a real pending order, and the
  // honest answer is "not yet", not "no such thing". They can already see the status on the
  // page they clicked from.
  if (order.status !== 'paid') {
    return new Response('This order is not paid.', { status: 403 });
  }

  // An order only entitles its buyer to the photographs actually in it — without this, a
  // valid order id would mint a token for any photoId in the catalogue.
  if (!order.items.some((item) => item.photoId.toString() === photoId.toString())) {
    return notFound();
  }

  const { ttlDays, maxUses } = getDownloadConfig();
  const token = await mintDownloadToken(db, { orderId: order._id, photoId, ttlDays, maxUses });

  return redirect(`/api/download/${token}`, 302);
};
