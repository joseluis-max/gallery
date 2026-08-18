import type { Db, ObjectId } from 'mongodb';

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'refunded';

/** Purchases and free-credit claims are both real, `paid` orders — that's deliberate:
 *  `consumeDownloadToken` gates on order status, so modelling a free claim this way means
 *  a free download flows through the exact same paywall check as a purchase, with no
 *  second code path to an original file. This field is what keeps $0 claims out of the
 *  revenue aggregations. */
export type OrderKind = 'purchase' | 'free-claim';

export interface OrderItem {
  photoId: ObjectId;
  /** Denormalized at order time so the order/admin views never depend on the photo
   *  still existing or being published later. */
  photoSlug: string;
  photoTitle: string;
  unitPriceCents: number;
  totalCents: number;
}

export interface OrderHistoryEntry {
  status: OrderStatus;
  at: Date;
  actor: string;
  note?: string;
}

export interface OrderDoc {
  _id: ObjectId;
  /** Set only when the order was placed by a signed-in account, and never inferred
   *  afterwards from a matching email — signup emails are unverified, so back-filling
   *  by address would let anyone claim a stranger's order history by registering with
   *  their address. Guest orders simply stay guest orders. */
  userId?: ObjectId;
  kind: OrderKind;
  items: OrderItem[];
  subtotalCents: number;
  totalCents: number;
  currency: 'usd';
  status: OrderStatus;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  customer: { email: string; name?: string };
  history: OrderHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOrderInput {
  items: OrderItem[];
  subtotalCents: number;
  totalCents: number;
  /** Present when a signed-in account placed the order — this is the only way an order
   *  is ever bound to a user. */
  user?: { id: ObjectId; email: string; name?: string };
}

/**
 * The order is created before the Stripe Checkout Session exists, so for a guest there's
 * no customer email yet — Stripe collects it during hosted checkout, and the webhook
 * back-fills `customer` onto this same document when payment completes (see
 * markOrderPaid). A signed-in buyer's account email is seeded here, and Stripe's own
 * (possibly different) billing email overwrites it at that same point.
 */
export async function createPendingOrder(db: Db, input: NewOrderInput): Promise<OrderDoc> {
  const now = new Date();
  const doc: Omit<OrderDoc, '_id'> = {
    ...(input.user ? { userId: input.user.id } : {}),
    kind: 'purchase',
    items: input.items,
    subtotalCents: input.subtotalCents,
    totalCents: input.totalCents,
    currency: 'usd',
    status: 'pending',
    customer: input.user ? { email: input.user.email, name: input.user.name } : { email: '' },
    history: [{ status: 'pending', at: now, actor: 'system', note: 'Order created, awaiting payment' }],
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.collection<Omit<OrderDoc, '_id'>>('orders').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export interface FreeClaimInput {
  user: { id: ObjectId; email: string; name?: string };
  item: OrderItem;
}

/**
 * Records a free-credit claim as a real order, `paid`, for $0.
 *
 * Two things about this are deliberate:
 *
 * 1. **It's an order at all.** `consumeDownloadToken` gates on order status, so modelling
 *    a claim this way means a free download travels the exact same paywall path as a
 *    purchase. There is no second, looser route to an original file — which is the whole
 *    reason `mintDownloadToken` still requires an orderId.
 * 2. **It is inserted already `paid`,** in one write, rather than inserted `pending` and
 *    patched. Any window where the order is pending is a window where the customer's own
 *    freshly-minted token is rejected by that same status check.
 *
 * No `stripeSessionId`: that unique index is sparse, so any number of free orders coexist.
 */
export async function createFreeClaimOrder(db: Db, input: FreeClaimInput): Promise<OrderDoc> {
  const now = new Date();
  const doc: Omit<OrderDoc, '_id'> = {
    userId: input.user.id,
    kind: 'free-claim',
    items: [input.item],
    subtotalCents: 0,
    totalCents: 0,
    currency: 'usd',
    status: 'paid',
    customer: { email: input.user.email, name: input.user.name },
    history: [{ status: 'paid', at: now, actor: 'free-claim', note: 'Free download claimed' }],
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.collection<Omit<OrderDoc, '_id'>>('orders').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** The existing free claim for this photograph, if the account already has one. */
export async function findFreeClaim(db: Db, userId: ObjectId, photoId: ObjectId): Promise<OrderDoc | null> {
  return db.collection<OrderDoc>('orders').findOne({ userId, kind: 'free-claim', 'items.photoId': photoId });
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

/** Orders a signed-in customer may see in their account area. Keyed on `userId` only —
 *  see the field's comment on why matching by email would be a hole, not a feature. */
export async function listOrdersForUser(db: Db, userId: ObjectId, limit = 100): Promise<OrderDoc[]> {
  return db.collection<OrderDoc>('orders').find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray();
}

/**
 * Whether a given viewer may see an order.
 *
 * Guest orders stay reachable by anyone holding the (unguessable, 96-bit) order id, as
 * they were before accounts existed — that link is what a guest gets after checkout and
 * in their confirmation email, and there's no account to authenticate them against.
 * Orders owned by an account are restricted to that account and to admins.
 */
export function canViewOrder(order: Pick<OrderDoc, 'userId'>, viewer: { id: string; role: string } | undefined): boolean {
  if (!order.userId) return true;
  if (!viewer) return false;
  return viewer.role === 'admin' || order.userId.toString() === viewer.id;
}
