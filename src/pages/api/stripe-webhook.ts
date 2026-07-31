import type { APIRoute } from 'astro';
import { ObjectId } from 'mongodb';
import type Stripe from 'stripe';
import { getDbConfig, getDownloadConfig, getStripeConfig } from '../../lib/config';
import { getDb } from '../../lib/db';
import { mintDownloadToken } from '../../lib/downloads';
import { sendEmail } from '../../lib/email';
import { markOrderPaid } from '../../lib/orders';
import { createStripeClient } from '../../lib/stripe';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const stripeConfig = getStripeConfig();
  const stripe = createStripeClient(stripeConfig.secretKey);

  // Signature verification needs the untouched raw body — reading it as text (not
  // .json()) before any parsing is what makes this work.
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, stripeConfig.webhookSecret);
  } catch (err) {
    return new Response(`Invalid signature: ${err instanceof Error ? err.message : String(err)}`, { status: 400 });
  }

  const db = await getDb(getDbConfig());

  // Recorded before processing so a concurrent duplicate delivery short-circuits, but
  // only marked `processedAt` after processing succeeds — a transient failure mid-
  // processing must NOT permanently swallow the event, since Stripe will retry.
  const existing = await db.collection('stripeEvents').findOne({ eventId: event.id });
  if (existing?.processedAt) {
    return new Response('ok', { status: 200 });
  }
  await db
    .collection('stripeEvents')
    .updateOne({ eventId: event.id }, { $setOnInsert: { eventId: event.id, type: event.type, receivedAt: new Date() } }, { upsert: true });

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    }
    await db.collection('stripeEvents').updateOne({ eventId: event.id }, { $set: { processedAt: new Date() } });
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('stripe-webhook processing failed', err);
    return new Response('Processing error', { status: 500 });
  }
};

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const orderIdRaw = session.metadata?.orderId;
  if (!orderIdRaw) {
    console.error('checkout.session.completed with no metadata.orderId', session.id);
    return;
  }

  const db = await getDb(getDbConfig());
  const orderId = new ObjectId(orderIdRaw);

  const shippingAddress = session.collected_information?.shipping_details
    ? toShippingAddress(session.collected_information.shipping_details)
    : undefined;

  const order = await markOrderPaid(db, {
    orderId,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? ''),
    customer: session.customer_details?.email
      ? { email: session.customer_details.email, name: session.customer_details.name ?? undefined }
      : undefined,
    shippingAddress,
  });

  if (!order) {
    // Already paid (idempotent replay raced past the stripeEvents guard) or the order
    // doesn't exist — either way, nothing more to do.
    return;
  }

  const downloadConfig = getDownloadConfig();
  const downloadLinks: string[] = [];
  for (const item of order.items) {
    if (item.type !== 'digital') continue;
    const token = await mintDownloadToken(db, {
      orderId: order._id,
      photoId: item.photoId,
      ttlDays: downloadConfig.ttlDays,
      maxUses: downloadConfig.maxUses,
    });
    downloadLinks.push(`/api/download/${token}`);
  }

  const email = order.customer.email;
  if (email) {
    const lines = [
      `Thank you for your order — #${order._id.toString()}.`,
      '',
      ...order.items.map((item) => `- ${item.photoTitle} (${item.type}) x${item.qty} — $${(item.totalCents / 100).toFixed(2)}`),
      '',
      `Total: $${(order.totalCents / 100).toFixed(2)}`,
    ];
    if (downloadLinks.length > 0) {
      lines.push('', 'Your digital downloads:', ...downloadLinks);
    }
    await sendEmail({ to: email, subject: `Order confirmation — #${order._id.toString()}`, text: lines.join('\n') });
  }
}

function toShippingAddress(details: Stripe.Checkout.Session.CollectedInformation.ShippingDetails) {
  const addr = details.address;
  if (!addr) return undefined;
  return {
    name: details.name ?? '',
    line1: addr.line1 ?? '',
    line2: addr.line2 ?? undefined,
    city: addr.city ?? '',
    state: addr.state ?? undefined,
    postalCode: addr.postal_code ?? '',
    country: addr.country ?? '',
  };
}
