import { createHash, randomBytes } from 'node:crypto';
import type { Db, ObjectId } from 'mongodb';

export function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function isTokenExpired(expiresAt: Date, now = new Date()): boolean {
  return now >= expiresAt;
}

export function isTokenExhausted(useCount: number, maxUses: number): boolean {
  return useCount >= maxUses;
}

export interface DownloadTokenDoc {
  _id: ObjectId;
  tokenHash: string;
  orderId: ObjectId;
  photoId: ObjectId;
  expiresAt: Date;
  maxUses: number;
  useCount: number;
  createdAt: Date;
  uses: { at: Date; ip: string }[];
}

export interface MintTokenParams {
  orderId: ObjectId;
  photoId: ObjectId;
  ttlDays: number;
  maxUses: number;
}

/** Only the hash is ever persisted — the raw value is returned once, for embedding in
 *  the receipt email link, and is not recoverable afterward. */
export async function mintDownloadToken(db: Db, params: MintTokenParams): Promise<string> {
  const raw = generateRawToken();
  const doc: Omit<DownloadTokenDoc, '_id'> = {
    tokenHash: hashToken(raw),
    orderId: params.orderId,
    photoId: params.photoId,
    expiresAt: new Date(Date.now() + params.ttlDays * 24 * 60 * 60 * 1000),
    maxUses: params.maxUses,
    useCount: 0,
    createdAt: new Date(),
    uses: [],
  };
  await db.collection<Omit<DownloadTokenDoc, '_id'>>('downloadTokens').insertOne(doc);
  return raw;
}

export type ConsumeResult =
  | { ok: true; photoOriginalKey: string; orderId: ObjectId }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'EXHAUSTED' | 'ORDER_NOT_PAID' };

/**
 * Single atomic findOneAndUpdate with the expiry/use-cap guards baked into the filter —
 * not a separate check-then-increment, which would let N concurrent requests all pass
 * the check before any of them actually increments, exceeding maxUses under a race.
 */
export async function consumeDownloadToken(db: Db, rawToken: string, ip: string): Promise<ConsumeResult> {
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const updated = await db.collection<DownloadTokenDoc>('downloadTokens').findOneAndUpdate(
    { tokenHash, expiresAt: { $gt: now }, $expr: { $lt: ['$useCount', '$maxUses'] } },
    { $inc: { useCount: 1 }, $push: { uses: { at: now, ip } } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    const doc = await db.collection<DownloadTokenDoc>('downloadTokens').findOne({ tokenHash });
    if (!doc) return { ok: false, reason: 'NOT_FOUND' };
    if (isTokenExpired(doc.expiresAt, now)) return { ok: false, reason: 'EXPIRED' };
    return { ok: false, reason: 'EXHAUSTED' };
  }

  // THE paywall check. 'fulfilled' is gone with physical prints, so this narrows to the
  // single status that means "this person is entitled to the original". Narrowing is
  // safe; widening this condition is how originals leak. Free-credit claims pass here
  // because a claim IS a real order in `paid` status — there is deliberately no second,
  // looser path to an original file.
  const order = await db.collection('orders').findOne({ _id: updated.orderId });
  if (!order || order.status !== 'paid') {
    return { ok: false, reason: 'ORDER_NOT_PAID' };
  }

  const photo = await db.collection('photos').findOne({ _id: updated.photoId });
  if (!photo) return { ok: false, reason: 'NOT_FOUND' };

  return { ok: true, photoOriginalKey: photo.storage.originalKey, orderId: updated.orderId };
}
