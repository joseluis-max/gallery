import { ObjectId } from 'mongodb';
// `z` for Action input schemas must come from 'astro/zod', not the plain 'zod' package,
// so it's guaranteed to be the exact zod instance the Actions runtime uses internally.
import { z } from 'astro/zod';
import { ActionError, defineAction } from 'astro:actions';
import { admin } from './admin';
import { addCartItem, removeCartItem, updateCartItemQty } from '../lib/cart';
import { getDbConfig, getPublicSiteUrl, getStripeConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { attachStripeSession, createPendingOrder, type OrderItem } from '../lib/orders';
import {
  computeDigitalPrice,
  computePrintPrice,
  computeShippingCents,
  PricingError,
  priceQuoteInputSchema,
} from '../lib/pricing';
import { getSettings } from '../lib/settings';
import { createStripeClient } from '../lib/stripe';

function pricingErrorToActionError(err: unknown): never {
  if (err instanceof PricingError) {
    throw new ActionError({ code: 'BAD_REQUEST', message: err.code });
  }
  throw err;
}

function parsePhotoId(raw: string): InstanceType<typeof ObjectId> {
  try {
    return new ObjectId(raw);
  } catch {
    throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_PHOTO_ID' });
  }
}

export const server = {
  admin,

  quotePrice: defineAction({
    accept: 'json',
    input: z.object({
      photoId: z.string().min(1),
      widthCm: z.coerce.number(),
      heightCm: z.coerce.number(),
      paper: z.string().min(1),
      qty: z.coerce.number().default(1),
      crop: z.enum(['fit', 'crop', 'border']).default('fit'),
    }),
    handler: async (rawInput) => {
      const db = await getDb(getDbConfig());
      const photoObjectId = parsePhotoId(rawInput.photoId);

      const [photo, settings] = await Promise.all([
        db.collection('photos').findOne({ _id: photoObjectId, status: 'published' }),
        getSettings(db),
      ]);
      if (!photo) {
        throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });
      }

      const input = priceQuoteInputSchema.parse(rawInput);
      try {
        return computePrintPrice(input, {
          settings,
          photo: { aspectRatio: photo.aspectRatio, maxPrintCm: photo.maxPrintCm, pricingOverride: photo.pricing },
        });
      } catch (err) {
        pricingErrorToActionError(err);
      }
    },
  }),

  addToCart: defineAction({
    accept: 'json',
    input: z.object({
      photoId: z.string().min(1),
      type: z.enum(['print', 'digital']),
      widthCm: z.coerce.number().optional(),
      heightCm: z.coerce.number().optional(),
      paper: z.string().optional(),
      crop: z.enum(['fit', 'crop', 'border']).default('fit'),
      qty: z.coerce.number().int().positive().max(50).default(1),
    }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const photoObjectId = parsePhotoId(input.photoId);
      const [photo, settings] = await Promise.all([
        db.collection('photos').findOne({ _id: photoObjectId, status: 'published' }),
        getSettings(db),
      ]);
      if (!photo) throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });

      if (input.type === 'print') {
        if (input.widthCm === undefined || input.heightCm === undefined || !input.paper) {
          throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_PRINT_ITEM' });
        }
        // Re-validates the exact same way quotePrice does — a cart line that couldn't
        // have priced successfully is never allowed in.
        try {
          computePrintPrice(
            { photoId: input.photoId, widthCm: input.widthCm, heightCm: input.heightCm, paper: input.paper, qty: input.qty, crop: input.crop },
            { settings, photo: { aspectRatio: photo.aspectRatio, maxPrintCm: photo.maxPrintCm, pricingOverride: photo.pricing } },
          );
        } catch (err) {
          pricingErrorToActionError(err);
        }
      }

      const cart = (await context.session?.get('cart')) ?? [];
      const next = addCartItem(cart, {
        photoId: input.photoId,
        type: input.type,
        qty: input.qty,
        ...(input.type === 'print'
          ? { widthCm: input.widthCm, heightCm: input.heightCm, paper: input.paper, crop: input.crop }
          : {}),
      });
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

  updateCartItemQty: defineAction({
    accept: 'json',
    input: z.object({ lineId: z.string().min(1), qty: z.coerce.number().int().positive().max(50) }),
    handler: async (input, context) => {
      const cart = (await context.session?.get('cart')) ?? [];
      const next = updateCartItemQty(cart, input.lineId, input.qty);
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
      let hasPrintItem = false;

      // Every line is re-validated and re-priced here, from the server's own database
      // state — the session cart is only ever a set of (photoId, size, paper, qty)
      // references, never a price, so nothing the client sent can affect what gets
      // charged.
      for (const cartItem of cart) {
        const photo = await db.collection('photos').findOne({ _id: parsePhotoId(cartItem.photoId), status: 'published' });
        if (!photo) throw new ActionError({ code: 'BAD_REQUEST', message: 'PHOTO_UNAVAILABLE' });

        if (cartItem.type === 'print') {
          hasPrintItem = true;
          if (cartItem.widthCm === undefined || cartItem.heightCm === undefined || !cartItem.paper) {
            throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_PRINT_ITEM' });
          }
          let quote;
          try {
            quote = computePrintPrice(
              {
                photoId: cartItem.photoId,
                widthCm: cartItem.widthCm,
                heightCm: cartItem.heightCm,
                paper: cartItem.paper,
                qty: cartItem.qty,
                crop: cartItem.crop ?? 'fit',
              },
              { settings, photo: { aspectRatio: photo.aspectRatio, maxPrintCm: photo.maxPrintCm, pricingOverride: photo.pricing } },
            );
          } catch (err) {
            pricingErrorToActionError(err);
          }
          orderItems.push({
            type: 'print',
            photoId: photo._id,
            photoSlug: photo.slug,
            photoTitle: photo.title.en,
            size: { widthCm: cartItem.widthCm, heightCm: cartItem.heightCm },
            paper: cartItem.paper,
            crop: cartItem.crop ?? 'fit',
            qty: cartItem.qty,
            unitPriceCents: quote.unitPriceCents,
            totalCents: quote.totalCents,
          });
        } else {
          const quote = computeDigitalPrice(cartItem.qty, {
            settings,
            digitalPriceOverrideCents: photo.pricing?.digitalPriceCents,
          });
          orderItems.push({
            type: 'digital',
            photoId: photo._id,
            photoSlug: photo.slug,
            photoTitle: photo.title.en,
            qty: cartItem.qty,
            unitPriceCents: quote.unitPriceCents,
            totalCents: quote.totalCents,
          });
        }
      }

      const subtotalCents = orderItems.reduce((sum, item) => sum + item.totalCents, 0);
      const shippingCents = computeShippingCents(settings, hasPrintItem);
      const totalCents = subtotalCents + shippingCents;

      const order = await createPendingOrder(db, { items: orderItems, subtotalCents, shippingCents, totalCents });

      const stripe = createStripeClient(getStripeConfig().secretKey);
      const siteUrl = getPublicSiteUrl();

      const lineItems = orderItems.map((item) => ({
        price_data: {
          currency: 'usd',
          product_data: {
            name:
              item.type === 'print'
                ? `${item.photoTitle} — Print ${item.size!.widthCm}×${item.size!.heightCm}cm (${item.paper})`
                : `${item.photoTitle} — Digital download`,
          },
          unit_amount: item.unitPriceCents,
        },
        quantity: item.qty,
      }));

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: lineItems,
        metadata: { orderId: order._id.toString() },
        success_url: `${siteUrl}/${input.lang}/order/${order._id.toString()}`,
        cancel_url: `${siteUrl}/${input.lang}/cart`,
        ...(hasPrintItem
          ? {
              shipping_address_collection: { allowed_countries: ['EC', 'US', 'CA'] as const },
              shipping_options: [
                {
                  shipping_rate_data: {
                    type: 'fixed_amount' as const,
                    fixed_amount: { amount: shippingCents, currency: 'usd' },
                    display_name: settings.shippingZones[0]?.label ?? 'Shipping',
                  },
                },
              ],
            }
          : {}),
      });

      await attachStripeSession(db, order._id, session.id!);
      context.session?.set('cart', []);

      return { url: session.url, orderId: order._id.toString() };
    },
  }),
};
