import { ObjectId } from 'mongodb';
// `z` for Action input schemas must come from 'astro/zod', not the plain 'zod' package,
// so it's guaranteed to be the exact zod instance the Actions runtime uses internally.
import { z } from 'astro/zod';
import { ActionError, defineAction } from 'astro:actions';
import { admin } from './admin';
import { auth } from './auth';
import { addCartItem, hasCartItem, removeCartItem } from '../lib/cart';
import { getDbConfig, getPublicSiteUrl, getStripeConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { attachStripeSession, createPendingOrder, type OrderItem } from '../lib/orders';
import { computeDigitalPrice } from '../lib/pricing';
import { getSettings } from '../lib/settings';
import { createStripeClient } from '../lib/stripe';

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
      return { count: next.length };
    },
  }),

  removeFromCart: defineAction({
    accept: 'json',
    input: z.object({ lineId: z.string().min(1) }),
    handler: async (input, context) => {
      const cart = (await context.session?.get('cart')) ?? [];
      const next = removeCartItem(cart, input.lineId);
      context.session?.set('cart', next);
      return { count: next.length };
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

      const orderItems: OrderItem[] = [];

      // Every line is re-priced here from the server's own database state — the session
      // cart is only ever a set of photo references, never a price, so nothing the client
      // sent can affect what gets charged.
      for (const cartItem of cart) {
        const photo = await db.collection('photos').findOne({ _id: parsePhotoId(cartItem.photoId), status: 'published' });
        if (!photo) throw new ActionError({ code: 'BAD_REQUEST', message: 'PHOTO_UNAVAILABLE' });

        const quote = computeDigitalPrice(1, { settings, digitalPriceOverrideCents: photo.pricing?.digitalPriceCents });
        orderItems.push({
          photoId: photo._id,
          photoSlug: photo.slug,
          photoTitle: photo.title.en,
          unitPriceCents: quote.unitPriceCents,
          totalCents: quote.totalCents,
        });
      }

      const subtotalCents = orderItems.reduce((sum, item) => sum + item.totalCents, 0);
      const totalCents = subtotalCents;

      // Stripe rejects a zero-total Checkout Session outright. Free photos are claimed
      // through the free-credit flow, which never touches the cart, so a $0 total here
      // means a misconfigured price rather than a legitimate free order — fail loudly
      // instead of handing Stripe something it will refuse.
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

      const stripe = createStripeClient(getStripeConfig().secretKey);
      const siteUrl = getPublicSiteUrl();

      const lineItems = orderItems.map((item) => ({
        price_data: {
          currency: 'usd',
          product_data: { name: `${item.photoTitle} — Digital download` },
          unit_amount: item.unitPriceCents,
        },
        quantity: 1,
      }));

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: lineItems,
        metadata: { orderId: order._id.toString() },
        // Prefills (and locks) the email field for a signed-in buyer; Stripe still
        // collects it itself for guests.
        ...(sessionUser ? { customer_email: sessionUser.email } : {}),
        success_url: `${siteUrl}/${input.lang}/order/${order._id.toString()}`,
        cancel_url: `${siteUrl}/${input.lang}/cart`,
      });

      await attachStripeSession(db, order._id, session.id!);
      context.session?.set('cart', []);

      return { url: session.url, orderId: order._id.toString() };
    },
  }),
};
