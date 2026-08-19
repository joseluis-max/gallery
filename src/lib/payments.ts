// The payment-attempt ledger. Stripe shipped one of these for free — an event id per
// webhook delivery, which made idempotency a unique index and nothing more. Payphone has
// no webhook and no event id, so the ledger is ours to build, and it carries a second job
// Stripe never needed: it is the only durable evidence that a payment was attempted at
// all, which is what makes the failure modes in the README's reconciliation section
// detectable rather than silent.
//
// Note the naming asymmetry with orders.ts, which went provider-neutral: order fields are
// read by generic UI (admin, account history) that should not know which gateway took the
// money, whereas everything here is Payphone's own wire vocabulary and is read only by the
// Payphone code path. `stripeEvents` was named the same way for the same reason.
import type { Db, ObjectId } from 'mongodb';
import type { PayphoneConfirmError, PayphoneConfirmResponse } from './payphone';

/** Confirm may only ever be executed once per transaction, so this records the outcome
 *  whatever it was — a decline and a timeout are as important to keep as an approval. */
export interface PayphoneConfirmRecord {
  ok: boolean;
  httpStatus: number;
  at: Date;
  body: PayphoneConfirmResponse | PayphoneConfirmError;
}

export interface PayphoneTransactionDoc {
  _id: ObjectId;
  clientTransactionId: string;
  orderId: ObjectId;
  /** What the widget was told to charge, snapshotted at render. Entitlement is decided by
   *  comparing the confirm response against the *order* total, not against this — but a
   *  divergence between the two is the signal that something re-priced mid-flight. */
  amountCents: number;
  /** Which locale started this attempt. Payphone's response URL is a single static URL
   *  configured once in their console, with no locale segment and no per-transaction
   *  override, so this is the only place the return redirect can learn where to send the
   *  buyer. A query parameter would do the job too, and would be attacker-controlled. */
  lang: 'es' | 'en';
  createdAt: Date;
  /** Set when a request claims the right to run the confirm. See `claimConfirm`. */
  confirmStartedAt?: Date;
  /** The Payphone-side id, from the return query string. Recorded at claim time rather
   *  than after confirming, so an operator can still find the transaction in Payphone's
   *  panel in exactly the case where confirm never completed. */
  payphoneTransactionId?: number;
  /** The confirm outcome. Its presence is terminal: confirm has been executed and must
   *  never be executed again. */
  confirm?: PayphoneConfirmRecord;
}

const COLLECTION = 'payphoneTransactions';

/**
 * How long a claim may sit without recording a response before another request may take
 * it over. A crashed or hung confirm must not lock the attempt out for the remainder of
 * Payphone's five-minute reversal window, but nor should a merely slow one be called
 * twice — 30 seconds is comfortably longer than the 15-second fetch timeout in
 * lib/payphone.ts, and still leaves ~4.5 minutes for a retry.
 */
export const CONFIRM_RETRY_AFTER_MS = 30_000;

export interface NewPaymentAttempt {
  orderId: ObjectId;
  clientTransactionId: string;
  amountCents: number;
  lang: 'es' | 'en';
}

export async function createPaymentAttempt(db: Db, input: NewPaymentAttempt): Promise<PayphoneTransactionDoc> {
  const doc: Omit<PayphoneTransactionDoc, '_id'> = {
    clientTransactionId: input.clientTransactionId,
    orderId: input.orderId,
    amountCents: input.amountCents,
    lang: input.lang,
    createdAt: new Date(),
  };
  const result = await db.collection<Omit<PayphoneTransactionDoc, '_id'>>(COLLECTION).insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/**
 * Claims the exclusive right to execute the confirm for one attempt — the lookup and the
 * claim in a single atomic findOneAndUpdate, because doing them as two steps is exactly
 * the race this exists to prevent.
 *
 * Returns the attempt when the caller now owns the confirm, and `null` when someone else
 * does or already did. That one return value covers all three ways a second request
 * arrives, which is why there is no event id anywhere in this integration:
 *
 *   - **Two tabs, simultaneously.** The loser gets null and redirects without calling
 *     Payphone. Confirm is terminal, so a second call is not a harmless duplicate — it is
 *     an error response that would read as a payment failure.
 *   - **The buyer refreshes the return URL after it worked.** `confirm` exists, so neither
 *     branch of the filter matches.
 *   - **A confirm that started and vanished.** The second branch lets it be retaken after
 *     CONFIRM_RETRY_AFTER_MS, so a crash mid-flight does not strand the payment.
 */
export async function claimConfirm(
  db: Db,
  clientTransactionId: string,
  payphoneTransactionId: number,
  now = new Date(),
): Promise<PayphoneTransactionDoc | null> {
  return db.collection<PayphoneTransactionDoc>(COLLECTION).findOneAndUpdate(
    {
      clientTransactionId,
      $or: [
        { confirmStartedAt: { $exists: false } },
        { confirm: { $exists: false }, confirmStartedAt: { $lt: new Date(now.getTime() - CONFIRM_RETRY_AFTER_MS) } },
      ],
    },
    { $set: { confirmStartedAt: now, payphoneTransactionId } },
    { returnDocument: 'after' },
  );
}

/** The read side of a lost claim: the request still needs `orderId` and `lang` to send the
 *  buyer somewhere sensible, it just must not touch Payphone. */
export async function findPaymentAttempt(db: Db, clientTransactionId: string): Promise<PayphoneTransactionDoc | null> {
  return db.collection<PayphoneTransactionDoc>(COLLECTION).findOne({ clientTransactionId });
}

export async function recordConfirmResponse(db: Db, id: ObjectId, record: PayphoneConfirmRecord): Promise<void> {
  await db.collection<PayphoneTransactionDoc>(COLLECTION).updateOne({ _id: id }, { $set: { confirm: record } });
}

export interface UnreconciledAttempts {
  /** Payphone approved the payment and the order is not paid. Money was taken and nothing
   *  was delivered. This list should always be empty; every row in it is an incident. */
  approvedButUnfulfilled: (PayphoneTransactionDoc & { orderStatus?: string })[];
  /** A confirm that was claimed and never recorded a response — the process died between
   *  the two. Whether the charge stands depends on whether Payphone received the call, so
   *  these need a human or the reconcile script to retry the confirm and find out. */
  stalledConfirms: PayphoneTransactionDoc[];
}

/**
 * The two queries behind the admin panel's "payments needing attention" section.
 *
 * This exists because Payphone has no webhook: the buyer's browser is a mandatory link in
 * the fulfilment chain, so a closed tab or a dead process can leave a payment stranded
 * with nothing to retry it. Stripe's webhook retries were the compensating control there;
 * here, visibility is.
 */
export async function listUnreconciledAttempts(db: Db, staleAfterMs: number, now = new Date()): Promise<UnreconciledAttempts> {
  const cutoff = new Date(now.getTime() - staleAfterMs);

  const approvedButUnfulfilled = await db
    .collection<PayphoneTransactionDoc>(COLLECTION)
    .aggregate([
      { $match: { 'confirm.ok': true, 'confirm.body.statusCode': 3 } },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
      { $set: { orderStatus: { $first: '$order.status' } } },
      { $match: { orderStatus: { $ne: 'paid' } } },
      { $unset: 'order' },
      { $sort: { createdAt: -1 } },
    ])
    .toArray();

  const stalledConfirms = await db
    .collection<PayphoneTransactionDoc>(COLLECTION)
    .find({ confirmStartedAt: { $exists: true, $lt: cutoff }, confirm: { $exists: false } })
    .sort({ createdAt: -1 })
    .toArray();

  return { approvedButUnfulfilled: approvedButUnfulfilled as UnreconciledAttempts['approvedButUnfulfilled'], stalledConfirms };
}
