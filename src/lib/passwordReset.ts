import type { Db, ObjectId } from 'mongodb';
import { generateRawToken, hashToken, isTokenExpired } from './tokens';

/**
 * Password-reset links.
 *
 * The shape is deliberately the same as lib/downloads.ts — mint a random secret, store
 * only its digest, and enforce every rule inside the filter of one atomic update — but
 * the rules themselves are stricter, because what this hands over is an account rather
 * than a file:
 *
 *   - **Single use, atomically.** `usedAt` is set by the same findOneAndUpdate that reads
 *     the token, so two requests racing on one link cannot both come back `ok`.
 *   - **Short-lived.** An hour, not the download link's days: the window in which a
 *     forwarded or intercepted email is dangerous should be about as long as it takes to
 *     read the email.
 *   - **Superseded on use.** Resetting a password invalidates every other outstanding link
 *     for that account, so an older email sitting in an inbox stops working the moment a
 *     newer one is used. `auth.changePassword` calls the same function for the same
 *     reason from the other direction.
 */
export interface PasswordResetTokenDoc {
  _id: ObjectId;
  tokenHash: string;
  userId: ObjectId;
  /** The address the link was mailed to, kept so a support question about "who asked for
   *  this" is answerable even after the account's own email has since changed. */
  email: string;
  expiresAt: Date;
  createdAt: Date;
  usedAt?: Date;
  requestedIp?: string;
}

/** An hour. Long enough to walk to a laptop, short enough that a stale link in an inbox
 *  is not a standing key to the account. */
export const RESET_TOKEN_TTL_MINUTES = 60;

const COLLECTION = 'passwordResetTokens';

export interface MintResetTokenParams {
  userId: ObjectId;
  email: string;
  ttlMinutes?: number;
  ip?: string;
}

/** Returns the raw token exactly once, for the link in the email. It is not recoverable
 *  from the database afterward — a lost link has to be re-requested, never looked up. */
export async function mintPasswordResetToken(db: Db, params: MintResetTokenParams): Promise<string> {
  const raw = generateRawToken();
  const ttlMinutes = params.ttlMinutes ?? RESET_TOKEN_TTL_MINUTES;

  const doc: Omit<PasswordResetTokenDoc, '_id'> = {
    tokenHash: hashToken(raw),
    userId: params.userId,
    email: params.email,
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
    createdAt: new Date(),
    ...(params.ip ? { requestedIp: params.ip } : {}),
  };

  await db.collection<Omit<PasswordResetTokenDoc, '_id'>>(COLLECTION).insertOne(doc);
  return raw;
}

export type ConsumeResetResult =
  | { ok: true; userId: ObjectId }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'USED' };

/**
 * Burns the token and reports who it belonged to.
 *
 * The guards live in the filter, not in a preceding read: a check-then-update would let
 * two concurrent submissions of the same link both pass the check before either marked it
 * used. The follow-up read exists only to tell the three failure reasons apart for the
 * log — the caller shows one message for all of them, since "expired" and "already used"
 * are the same instruction to the reader ("ask for a new link").
 */
export async function consumePasswordResetToken(db: Db, rawToken: string): Promise<ConsumeResetResult> {
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const updated = await db.collection<PasswordResetTokenDoc>(COLLECTION).findOneAndUpdate(
    { tokenHash, usedAt: { $exists: false }, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    const doc = await db.collection<PasswordResetTokenDoc>(COLLECTION).findOne({ tokenHash });
    // A token past its TTL index may already have been swept, so "not found" legitimately
    // covers "expired long enough ago" as well as "never existed".
    if (!doc) return { ok: false, reason: 'NOT_FOUND' };
    if (doc.usedAt) return { ok: false, reason: 'USED' };
    if (isTokenExpired(doc.expiresAt, now)) return { ok: false, reason: 'EXPIRED' };
    return { ok: false, reason: 'NOT_FOUND' };
  }

  return { ok: true, userId: updated.userId };
}

/**
 * Retires every link still outstanding for an account.
 *
 * Marked used rather than deleted, so the trail of what happened to a token survives until
 * the TTL index sweeps it — which is the difference between "this link was consumed" and
 * "this link vanished" when someone asks later.
 */
export async function invalidatePasswordResetTokens(db: Db, userId: ObjectId): Promise<void> {
  await db
    .collection<PasswordResetTokenDoc>(COLLECTION)
    .updateMany({ userId, usedAt: { $exists: false } }, { $set: { usedAt: new Date() } });
}
