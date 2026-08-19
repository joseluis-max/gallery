import { ObjectId } from 'mongodb';
// `z` for Action input schemas must come from 'astro/zod', not the plain 'zod' package,
// so it's guaranteed to be the exact zod instance the Actions runtime uses internally.
import { z } from 'astro/zod';
import { ActionError, defineAction } from 'astro:actions';
import { admin } from './admin';
import { auth } from './auth';
import { downloads } from './downloads';
import { transfer } from './transfer';
import { addCartItem, hasCartItem, removeCartItem } from '../lib/cart';
import { buildCartView } from '../lib/cartView';
import { createStorage, getDbConfig } from '../lib/config';
import { getDictionary } from '../lib/i18n';
import { getDb } from '../lib/db';
import { canViewOrder, createPendingOrder, getOrderById, type OrderItem } from '../lib/orders';
import { computeCartPricing } from '../lib/pricing';
import { getSettings } from '../lib/settings';

function parsePhotoId(raw: string): InstanceType<typeof ObjectId> {
  try {
    return new ObjectId(raw);
  } catch {
    throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_PHOTO_ID' });
  }
}

export const server = {
  admin,
  auth,
  downloads,
  transfer,

  addToCart: defineAction({
    accept: 'json',
    input: z.object({ photoId: z.string().min(1) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const photo = await db.collection('photos').findOne({ _id: parsePhotoId(input.photoId), status: 'published' });
      if (!photo) throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });

      const cart = (await context.session?.get('cart')) ?? [];
      // Adding the same photo twice is a no-op rather than a second line: one purchase
      // mints one download token for that photo, so a second line would charge again for
      // a file the buyer already has.
      const next = hasCartItem(cart, input.photoId) ? cart : addCartItem(cart, { photoId: input.photoId });
      context.session?.set('cart', next);

      // The line's id goes back to the caller so a toggle button (gallery grid, buy panel)
      // can flip straight to "remove" without a round trip to re-read the session.
      const lineId = next.find((item) => item.photoId === input.photoId)!.lineId;
      return { count: next.length, lineId };
    },
  }),

  removeFromCart: defineAction({
    accept: 'json',
    input: z.object({ lineId: z.string().min(1), lang: z.enum(['es', 'en']) }),
    handler: async (input, context) => {
      const cart = (await context.session?.get('cart')) ?? [];
      const next = removeCartItem(cart, input.lineId);
      context.session?.set('cart', next);

      // Returns the whole recomputed view, not just a count: volume tiers price the cart
      // as a whole, so removing one line can change what every remaining line costs. The
      // page re-renders from this instead of guessing.
      const db = await getDb(getDbConfig());
      const view = await buildCartView(db, createStorage(), next, input.lang, getDictionary(input.lang).cart.digitalFile);
      return { count: next.length, view };
    },
  }),

  checkout: defineAction({
    accept: 'json',
    input: z.object({ lang: z.enum(['es', 'en']) }),
    handler: async (input, context) => {
      const cart = (await context.session?.get('cart')) ?? [];
      if (cart.length === 0) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'CART_EMPTY' });
      }

      const db = await getDb(getDbConfig());
      const settings = await getSettings(db);

      // Every line is re-priced here from the server's own database state — the session
      // cart is only ever a set of photo references, never a price, so nothing the client
      // sent can affect what gets charged. Volume tiers depend on the whole cart, so the
      // photos are resolved first and priced together.
      const photos = [];
      for (const cartItem of cart) {
        const photo = await db.collection('photos').findOne({ _id: parsePhotoId(cartItem.photoId), status: 'published' });
        if (!photo) throw new ActionError({ code: 'BAD_REQUEST', message: 'PHOTO_UNAVAILABLE' });
        photos.push(photo);
      }

      const pricing = computeCartPricing(
        photos.map((photo) => ({ photoId: photo._id.toString(), overrideCents: photo.pricing?.digitalPriceCents })),
        settings,
      );

      const orderItems: OrderItem[] = photos.map((photo, i) => ({
        photoId: photo._id,
        photoSlug: photo.slug,
        photoTitle: photo.title.en,
        unitPriceCents: pricing.lines[i].unitPriceCents,
        totalCents: pricing.lines[i].unitPriceCents,
      }));

      const subtotalCents = pricing.totalCents;
      const totalCents = pricing.totalCents;

      // Payphone rejects a zero amount, and enforces a per-merchant minimum above it (see
      // the note in lib/payphone.ts — the figure still needs confirming with the account
      // rep). Free photos are claimed through the free-credit flow, which never touches
      // the cart, so a $0 total here means a misconfigured price rather than a legitimate
      // free order — fail loudly with a message from this store instead of letting the
      // buyer meet a raw gateway error.
      if (totalCents <= 0) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_TOTAL' });
      }

      // Checkout stays open to guests — an account is a convenience (order history,
      // saved details), never a gate in front of a purchase.
      const sessionUser = await context.session?.get('user');
      const order = await createPendingOrder(db, {
        items: orderItems,
        subtotalCents,
        totalCents,
        ...(sessionUser ? { user: { id: new ObjectId(sessionUser.id), email: sessionUser.email, name: sessionUser.name } } : {}),
      });

      context.session?.set('cart', []);

      // A relative path, and the cart page redirects to it exactly as it did to Stripe's
      // hosted URL. Nothing here is resolved on someone else's server any more, so there
      // is no reason for it to be absolute.
      return { url: `/${input.lang}/checkout/${order._id.toString()}`, orderId: order._id.toString() };
    },
  }),

  /**
   * Records the buyer's email on a pending order, from the checkout page's guest gate.
   *
   * This exists because Payphone's widget replaced Stripe's hosted form, and with it the
   * guarantee that every purchase came with an email attached. Payphone *may* return one
   * on the confirm response, but it is optional — and that address is where the download
   * links go, so a guest order without one is a purchase that silently delivers nothing.
   */
  setOrderEmail: defineAction({
    accept: 'json',
    input: z.object({
      orderId: z.string(),
      // A `refine` rather than `.email()` so the failure carries the same error *code* the
      // rest of the app uses, which is what the checkout page looks up in the dictionary.
      email: z.string().refine((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), { message: 'INVALID_EMAIL' }),
    }),
    handler: async (input, context) => {
      let orderId: InstanceType<typeof ObjectId>;
      try {
        orderId = new ObjectId(input.orderId);
      } catch {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_ORDER_ID' });
      }

      const db = await getDb(getDbConfig());
      const order = await getOrderById(db, orderId);
      if (!order) {
        throw new ActionError({ code: 'NOT_FOUND', message: 'ORDER_NOT_FOUND' });
      }

      // Same visibility rule as every other order surface, and the `status: 'pending'`
      // filter below is the other half: a paid order's customer must never be rewritten by
      // an unauthenticated call, or the receipt could be redirected after the fact.
      const viewer = await context.session?.get('user');
      if (!canViewOrder(order, viewer)) {
        throw new ActionError({ code: 'NOT_FOUND', message: 'ORDER_NOT_FOUND' });
      }

      await db
        .collection('orders')
        .updateOne(
          { _id: orderId, status: 'pending' },
          { $set: { 'customer.email': input.email, updatedAt: new Date() } },
        );

      return { ok: true };
    },
  }),
};
