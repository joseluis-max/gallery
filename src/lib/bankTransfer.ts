// Direct bank transfer — the second way to pay, and the only one where a human decides
// whether the money arrived.
//
// The shape mirrors lib/payments.ts deliberately: one document per submission, in its own
// collection, holding this method's own vocabulary. Orders stay provider-neutral (see the
// note at the top of lib/orders.ts), a buyer may submit more than once against a single
// order, and the ledger is the durable evidence of what was uploaded and who reviewed it.
//
// What makes it different from the Payphone path is who is authoritative. There, the
// gateway's confirm response is the only statement that can be trusted and the code
// decides. Here there is no gateway at all: the buyer moves money in their bank's app and
// uploads a screenshot, and nothing about that file proves anything. The admin's review IS
// the authorization, so everything below exists to give that person the evidence, and to
// make their decision exactly once.
import type { Db, ObjectId } from 'mongodb';
import type { Locale } from './i18n';

/**
 * Where the money goes. A constant rather than an environment variable or an admin
 * setting: it is rendered on a public page for buyers to copy, it changes roughly never,
 * and a typo in it means payments land nowhere — which makes "changing it is a code change
 * with a diff and a review" a feature rather than friction.
 */
export const BANK_ACCOUNT = {
  bank: 'Banco Pichincha',
  accountType: { es: 'Cuenta de ahorro transaccional', en: 'Transactional savings account' },
  accountNumber: '2208996600',
  holder: 'José Luis Valdiviezo Peña',
  /** Cédula. Ecuadorian banking apps ask for the recipient's id to confirm a transfer. */
  idNumber: '0150454320',
} as const;

/**
 * `in-review`   — submitted, waiting on the admin. The only state the queue shows.
 * `approved`    — the admin accepted it; the order is paid and the downloads are live.
 * `rejected`    — the admin refused it, with a reason the buyer is shown and emailed.
 * `superseded`  — the buyer uploaded a replacement before anyone reviewed this one. Kept
 *                 rather than deleted: "they uploaded the wrong file first" is exactly the
 *                 context a support conversation needs later.
 */
export type BankTransferStatus = 'in-review' | 'approved' | 'rejected' | 'superseded';

/** The uploaded comprobante. Only the storage key is kept — the bytes live in the private
 *  originals class and are readable through the admin-only route that streams them, never
 *  through a public URL. */
export interface TransferReceiptFile {
  key: string;
  filename: string;
  contentType: string;
  bytes: number;
}

export interface BankTransferDoc {
  _id: ObjectId;
  orderId: ObjectId;
  /** The order total at submission time. Snapshotted for the same reason the Payphone
   *  attempt snapshots its amount: the admin is comparing a bank statement against a
   *  number, and it has to be the number the buyer was actually shown. */
  amountCents: number;
  /** Which locale the buyer was using. The approval happens later, in an admin panel that
   *  has no locale of its own, so this is the only record of which language to write to
   *  them in — the same job `lang` does on a Payphone attempt. */
  lang: Locale;
  status: BankTransferStatus;
  /** Whatever the buyer typed to identify their transfer — the bank's document number,
   *  usually. Optional, unverified, and shown to the admin as a hint, never matched on. */
  reference?: string;
  receipt: TransferReceiptFile;
  submittedAt: Date;
  reviewedAt?: Date;
  /** The admin's email, so the trail names a person rather than a role. */
  reviewedBy?: string;
  rejectionReason?: string;
}

const COLLECTION = 'bankTransfers';

/** Receipts are phone screenshots and bank PDFs, not 25MB camera originals — a cap well
 *  below the admin upload page's is still far more than any of those need, and unlike that
 *  page this endpoint is reachable by anyone holding a pending order id. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Accepted upload types, mapped to the extension the stored key gets. An allowlist keyed
 * by content type rather than by filename: the extension is chosen here, from a type the
 * server checked, so nothing a buyer names their file can decide what lands in the bucket.
 *
 * HEIC is here because an iPhone photographing a bank app produces one. No browser renders
 * it, so the admin panel offers those as a download instead of a preview.
 */
export const RECEIPT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'application/pdf': 'pdf',
};

/** How many receipts one order may ever accumulate. The submit path is open to anyone
 *  holding a (96-bit, unguessable) pending order id, so it needs a ceiling; five is more
 *  retries than an honest buyer has ever needed. */
export const MAX_RECEIPTS_PER_ORDER = 5;

export type ReceiptRejection = 'RECEIPT_REQUIRED' | 'RECEIPT_TOO_LARGE' | 'RECEIPT_TYPE_NOT_ALLOWED';

/** Pure, so the rules are testable without a database, a bucket or an Astro runtime. */
export function validateReceiptFile(file: { size: number; type: string }): ReceiptRejection | null {
  if (!file.size) return 'RECEIPT_REQUIRED';
  if (file.size > RECEIPT_MAX_BYTES) return 'RECEIPT_TOO_LARGE';
  if (!RECEIPT_TYPES[file.type]) return 'RECEIPT_TYPE_NOT_ALLOWED';
  return null;
}

/**
 * Where a receipt is stored: under the *originals* class, which is the private one.
 *
 * The buyer's filename never appears in the key. It is attacker-controlled, it would put
 * the whole weight of `isSafeObjectKey` on one call site, and nothing needs it there — the
 * original name is kept on the document for the admin to read. The random id also means
 * two people uploading `IMG_0001.jpg` cannot collide.
 */
export function receiptStorageKey(orderId: string, uploadId: string, contentType: string): string {
  return `receipts/${orderId}/${uploadId}.${RECEIPT_TYPES[contentType] ?? 'bin'}`;
}

export interface NewTransferSubmission {
  orderId: ObjectId;
  amountCents: number;
  lang: Locale;
  reference?: string;
  receipt: TransferReceiptFile;
}

/**
 * Records a submission, and demotes any earlier one still waiting for review.
 *
 * The demotion is what keeps the queue honest: a buyer who realises they uploaded the
 * wrong screenshot uploads another, and the admin should see one row for that order rather
 * than two they have to reason about. It runs before the insert so there is never a moment
 * with two `in-review` documents for one order — the reverse order would leave that window
 * open to whoever reads the queue in between.
 */
export async function submitTransfer(db: Db, input: NewTransferSubmission): Promise<BankTransferDoc> {
  await db
    .collection<BankTransferDoc>(COLLECTION)
    .updateMany({ orderId: input.orderId, status: 'in-review' }, { $set: { status: 'superseded' } });

  const doc: Omit<BankTransferDoc, '_id'> = {
    orderId: input.orderId,
    amountCents: input.amountCents,
    lang: input.lang,
    status: 'in-review',
    ...(input.reference ? { reference: input.reference } : {}),
    receipt: input.receipt,
    submittedAt: new Date(),
  };
  const result = await db.collection<Omit<BankTransferDoc, '_id'>>(COLLECTION).insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function findTransferById(db: Db, id: ObjectId): Promise<BankTransferDoc | null> {
  return db.collection<BankTransferDoc>(COLLECTION).findOne({ _id: id });
}

/** What the order page shows the buyer: the state of their most recent submission. */
export async function findLatestTransferForOrder(db: Db, orderId: ObjectId): Promise<BankTransferDoc | null> {
  return db.collection<BankTransferDoc>(COLLECTION).findOne({ orderId }, { sort: { submittedAt: -1 } });
}

export async function countReceiptsForOrder(db: Db, orderId: ObjectId): Promise<number> {
  return db.collection<BankTransferDoc>(COLLECTION).countDocuments({ orderId });
}

/** Every submission against one order, newest first — the admin order page shows the whole
 *  sequence, because "they uploaded three of these" is itself information about the buyer. */
export async function listTransfersForOrder(db: Db, orderId: ObjectId): Promise<BankTransferDoc[]> {
  return db.collection<BankTransferDoc>(COLLECTION).find({ orderId }).sort({ submittedAt: -1 }).toArray();
}

export interface ReviewDecision {
  status: Extract<BankTransferStatus, 'approved' | 'rejected'>;
  reviewedBy: string;
  rejectionReason?: string;
}

/**
 * Closes a review, once.
 *
 * `status: 'in-review'` in the filter is the whole point — a double-clicked Approve, or
 * two admins working the queue at the same instant, resolves to one winner and one `null`.
 * The caller reads that null as "someone else already decided this" and stops.
 *
 * Note the ordering this is used in (see `admin.approveTransfer`): the ORDER is marked paid
 * first and the transfer is closed second, not the other way round. `markOrderPaid` is
 * itself atomic on `status: 'pending'`, so it — not this — is what actually prevents a
 * second set of download tokens; and a crash between the two leaves a paid order beside a
 * transfer still in the queue, which an admin can simply approve again. The reverse
 * ordering would leave an approved transfer beside an unpaid order, and nothing in the
 * panel would ever surface it.
 */
export async function closeTransferReview(db: Db, id: ObjectId, decision: ReviewDecision): Promise<BankTransferDoc | null> {
  return db.collection<BankTransferDoc>(COLLECTION).findOneAndUpdate(
    { _id: id, status: 'in-review' },
    {
      $set: {
        status: decision.status,
        reviewedAt: new Date(),
        reviewedBy: decision.reviewedBy,
        ...(decision.rejectionReason ? { rejectionReason: decision.rejectionReason } : {}),
      },
    },
    { returnDocument: 'after' },
  );
}

export async function countTransfersInReview(db: Db): Promise<number> {
  return db.collection<BankTransferDoc>(COLLECTION).countDocuments({ status: 'in-review' });
}

export interface TransferWithOrder extends BankTransferDoc {
  orderStatus?: string;
  customerEmail?: string;
}

/** The admin queue. Joined against orders so the list can show who paid and where the
 *  order stands without a round-trip per row from the template. */
export async function listTransfers(db: Db, status?: BankTransferStatus, limit = 200): Promise<TransferWithOrder[]> {
  const rows = await db
    .collection<BankTransferDoc>(COLLECTION)
    .aggregate([
      ...(status ? [{ $match: { status } }] : []),
      { $sort: { submittedAt: -1 } },
      { $limit: limit },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
      { $set: { orderStatus: { $first: '$order.status' }, customerEmail: { $first: '$order.customer.email' } } },
      { $unset: 'order' },
    ])
    .toArray();
  return rows as TransferWithOrder[];
}
