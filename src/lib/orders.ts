import type { Db, ObjectId } from 'mongodb';

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled' | 'refunded';

export interface OrderItem {
  type: 'print' | 'digital';
  photoId: ObjectId;
  /** Denormalized at order time so the order/admin views never depend on the photo
   *  still existing or being published later. */
  photoSlug: string;
  photoTitle: string;
  size?: { widthCm: number; heightCm: number };
  paper?: string;
  crop?: 'fit' | 'crop' | 'border';
  qty: number;
  unitPriceCents: number;
  totalCents: number;
}

export interface OrderHistoryEntry {
  status: OrderStatus;
  at: Date;
  actor: string;
  note?: string;
}

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface Fulfillment {
  status: 'unfulfilled' | 'shipped';
  carrier?: string;
  tracking?: string;
  notes?: string;
  shippedAt?: Date;
}

export interface OrderDoc {
  _id: ObjectId;
  items: OrderItem[];
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'usd';
  status: OrderStatus;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  customer: { email: string; name?: string };
  shippingAddress?: ShippingAddress;
  fulfillment?: Fulfillment;
  history: OrderHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOrderInput {
  items: OrderItem[];
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
}

/**
 * The order is created before the Stripe Checkout Session exists, so there's no
 * customer email yet — Stripe collects it during hosted checkout, and the webhook
 * back-fills `customer`/`shippingAddress` onto this same document when payment
 * completes (see markOrderPaid).
 */
export async function createPendingOrder(db: Db, input: NewOrderInput): Promise<OrderDoc> {
  const now = new Date();
  const doc: Omit<OrderDoc, '_id'> = {
    items: input.items,
    subtotalCents: input.subtotalCents,
    shippingCents: input.shippingCents,
    totalCents: input.totalCents,
    currency: 'usd',
    status: 'pending',
    customer: { email: '' },
    history: [{ status: 'pending', at: now, actor: 'system', note: 'Order created, awaiting payment' }],
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.collection<Omit<OrderDoc, '_id'>>('orders').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function attachStripeSession(db: Db, orderId: ObjectId, stripeSessionId: string): Promise<void> {
  await db.collection<OrderDoc>('orders').updateOne({ _id: orderId }, { $set: { stripeSessionId, updatedAt: new Date() } });
}

/**
 * Atomically flips a pending order to paid — the `status: 'pending'` filter guard means
 * a duplicate webhook delivery (already handled via the stripeEvents idempotency guard,
 * but defense in depth) can never double-process the same order.
 */
export interface MarkOrderPaidParams {
  orderId: ObjectId;
  paymentIntentId: string;
  customer?: { email: string; name?: string };
  shippingAddress?: ShippingAddress;
}

export async function markOrderPaid(db: Db, params: MarkOrderPaidParams): Promise<OrderDoc | null> {
  const now = new Date();
  const result = await db.collection<OrderDoc>('orders').findOneAndUpdate(
    { _id: params.orderId, status: 'pending' },
    {
      $set: {
        status: 'paid',
        stripePaymentIntentId: params.paymentIntentId,
        updatedAt: now,
        ...(params.customer ? { customer: params.customer } : {}),
        ...(params.shippingAddress ? { shippingAddress: params.shippingAddress } : {}),
      },
      $push: { history: { status: 'paid', at: now, actor: 'stripe-webhook', note: 'Payment confirmed' } },
    },
    { returnDocument: 'after' },
  );
  return result;
}

export async function getOrderById(db: Db, id: ObjectId): Promise<OrderDoc | null> {
  return db.collection<OrderDoc>('orders').findOne({ _id: id });
}

export async function getOrderByStripeSessionId(db: Db, stripeSessionId: string): Promise<OrderDoc | null> {
  return db.collection<OrderDoc>('orders').findOne({ stripeSessionId });
}
