import { ObjectId } from 'mongodb';
import { z } from 'astro/zod';
import { ActionError, defineAction } from 'astro:actions';
import { requireSessionUser } from './sessionGuard';
import { getDbConfig, getDownloadConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { mintDownloadToken } from '../lib/downloads';
import { canViewOrder, createFreeClaimOrder, findFreeClaim, getOrderById, type OrderDoc } from '../lib/orders';
import type { PhotoDoc } from '../lib/photos';
import { refundFreeDownload, spendFreeDownload } from '../lib/users';

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Every path out of here returns a token URL, never a storage key and never a presigned
 *  URL — `/api/download/[token]` is the only thing that ever touches an original. */
async function tokenUrlFor(db: Awaited<ReturnType<typeof getDb>>, order: OrderDoc, photoId: ObjectId): Promise<string> {
  const { ttlDays, maxUses } = getDownloadConfig();
  const token = await mintDownloadToken(db, { orderId: order._id, photoId, ttlDays, maxUses });
  return `/api/download/${token}`;
}

export const downloads = {
  /**
   * Claims one of the account's free downloads.
   *
   * The interesting part is the ordering. The credit is spent *before* the order is
   * created, with the guard inside an atomic filter rather than a preceding read — so two
   * simultaneous claims can't both see "1 remaining" and both succeed. If the insert then
   * fails, the credit is handed back.
   *
   * Two independent mechanisms cover claiming the same photograph twice, and neither is
   * sufficient alone: the fast path below handles the ordinary double-click cheaply and
   * without spending anything, while the unique partial index on
   * `{userId, items.photoId}` is what actually holds under genuine concurrency.
   */
  claimFree: defineAction({
    accept: 'json',
    input: z.object({ photoId: z.string().min(1) }),
    handler: async (input, context) => {
      const user = await requireSessionUser(context);
      const db = await getDb(getDbConfig());

      let photoObjectId: ObjectId;
      try {
        photoObjectId = new ObjectId(input.photoId);
      } catch {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_PHOTO_ID' });
      }

      const photo = await db.collection<PhotoDoc>('photos').findOne({ _id: photoObjectId, status: 'published' });
      if (!photo) throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });

      // Already claimed: re-issue a fresh token against the existing order and spend
      // nothing. Someone who lost their link shouldn't pay a credit to get it back.
      const existing = await findFreeClaim(db, user._id, photoObjectId);
      if (existing) {
        return {
          url: await tokenUrlFor(db, existing, photoObjectId),
          remaining: user.freeDownloadsRemaining,
          alreadyClaimed: true,
        };
      }

      const spent = await spendFreeDownload(db, user._id);
      if (!spent) throw new ActionError({ code: 'BAD_REQUEST', message: 'NO_FREE_DOWNLOADS_LEFT' });

      let order: OrderDoc;
      try {
        order = await createFreeClaimOrder(db, {
          user: { id: user._id, email: user.email, name: user.name },
          item: {
            photoId: photo._id,
            photoSlug: photo.slug,
            photoTitle: photo.title.en || photo.slug,
            unitPriceCents: 0,
            totalCents: 0,
          },
        });
      } catch (err) {
        // Compensating write rather than a transaction: nothing else in this codebase
        // uses Mongo sessions, and one action doesn't justify introducing them. The
        // residual failure (process dies between these two lines) costs one credit and is
        // recoverable from the customer's admin page.
        await refundFreeDownload(db, user._id);

        if (isDuplicateKeyError(err)) {
          // Lost a race with a concurrent claim for this same photograph — the other
          // request won, so hand back a token for the order it created.
          const winner = await findFreeClaim(db, user._id, photoObjectId);
          if (winner) {
            return {
              url: await tokenUrlFor(db, winner, photoObjectId),
              remaining: user.freeDownloadsRemaining,
              alreadyClaimed: true,
            };
          }
        }
        throw err;
      }

      return {
        url: await tokenUrlFor(db, order, photoObjectId),
        remaining: spent.freeDownloadsRemaining,
        alreadyClaimed: false,
      };
    },
  }),

  /**
   * Mints a fresh token for an order the caller already owns.
   *
   * Tokens expire after a few days and a handful of uses, which was fine when the product
   * was a print and the download was a bonus. For a store that sells downloads it would
   * mean a customer who reinstalls their laptop next month has simply lost what they
   * bought. Ownership is re-checked here through the same `canViewOrder` rule the order
   * page uses — this issues tokens, so it must not be looser than the page that displays
   * them.
   */
  reissue: defineAction({
    accept: 'json',
    input: z.object({ orderId: z.string().min(1), photoId: z.string().min(1) }),
    handler: async (input, context) => {
      const user = await requireSessionUser(context);
      const db = await getDb(getDbConfig());

      let orderObjectId: ObjectId;
      let photoObjectId: ObjectId;
      try {
        orderObjectId = new ObjectId(input.orderId);
        photoObjectId = new ObjectId(input.photoId);
      } catch {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_ID' });
      }

      const order = await getOrderById(db, orderObjectId);
      if (!order) throw new ActionError({ code: 'NOT_FOUND', message: 'ORDER_NOT_FOUND' });

      if (!canViewOrder(order, { id: user._id.toString(), role: user.role })) {
        throw new ActionError({ code: 'FORBIDDEN', message: 'NOT_YOUR_ORDER' });
      }
      // Guest orders are viewable by anyone holding the id, but re-issuing a download is
      // a stronger act than reading a receipt — restrict it to the owning account.
      if (!order.userId || order.userId.toString() !== user._id.toString()) {
        throw new ActionError({ code: 'FORBIDDEN', message: 'NOT_YOUR_ORDER' });
      }
      if (order.status !== 'paid') {
        throw new ActionError({ code: 'FORBIDDEN', message: 'ORDER_NOT_PAID' });
      }
      if (!order.items.some((item) => item.photoId.toString() === input.photoId)) {
        throw new ActionError({ code: 'NOT_FOUND', message: 'NOT_IN_ORDER' });
      }

      return { url: await tokenUrlFor(db, order, photoObjectId) };
    },
  }),
};
