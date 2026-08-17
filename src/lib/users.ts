import { ObjectId as ObjectIdCtor } from 'mongodb';
import type { Db, ObjectId } from 'mongodb';
import { hashPassword, verifyPassword } from './auth';

export type UserRole = 'admin' | 'customer';

export interface UserDoc {
  _id: ObjectId;
  /** Always stored normalized (trimmed + lowercased) — the unique index is on this
   *  field, so normalizing on write is what makes "Jose@X.com" and "jose@x.com" the
   *  same account rather than two. */
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  /** Disabled accounts keep their orders and audit trail but can't sign in — the
   *  reversible alternative to deleting a customer who has order history. */
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

/** What a signed-in user looks like inside the session cookie — deliberately no
 *  password hash, and small enough that it costs nothing to carry on every request. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export const MIN_PASSWORD_LENGTH = 8;

export type UserErrorCode =
  | 'INVALID_EMAIL'
  | 'PASSWORD_TOO_SHORT'
  | 'NAME_REQUIRED'
  | 'EMAIL_TAKEN'
  | 'USER_NOT_FOUND';

export class UserError extends Error {
  constructor(readonly code: UserErrorCode) {
    super(code);
    this.name = 'UserError';
  }
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Deliberately permissive: the only thing worth rejecting here is input that clearly
 *  isn't an address at all. Anything stricter reliably rejects real, valid addresses,
 *  and delivery is the real proof anyway. */
export function isValidEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export interface CredentialsInput {
  email: string;
  name: string;
  password: string;
}

/** Pure validation, shared by signup, admin-side user creation, and profile edits, so
 *  the rules can't drift between the three entry points. Throws `UserError` with a
 *  machine-readable code the Actions layer maps to a translated message. */
export function assertValidCredentials(input: CredentialsInput): void {
  if (!isValidEmail(input.email)) throw new UserError('INVALID_EMAIL');
  if (input.name.trim().length === 0) throw new UserError('NAME_REQUIRED');
  assertValidPassword(input.password);
}

export function assertValidPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new UserError('PASSWORD_TOO_SHORT');
}

export function toSessionUser(user: UserDoc): SessionUser {
  return { id: user._id.toString(), email: user.email, name: user.name, role: user.role };
}

export function isAdmin(user: SessionUser | undefined | null): boolean {
  return user?.role === 'admin';
}

function users(db: Db) {
  return db.collection<UserDoc>('users');
}

export interface CreateUserInput extends CredentialsInput {
  role?: UserRole;
}

export async function createUser(db: Db, input: CreateUserInput): Promise<UserDoc> {
  assertValidCredentials(input);

  const now = new Date();
  const doc: Omit<UserDoc, '_id'> = {
    email: normalizeEmail(input.email),
    name: input.name.trim(),
    passwordHash: hashPassword(input.password),
    role: input.role ?? 'customer',
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await db.collection<Omit<UserDoc, '_id'>>('users').insertOne(doc);
    return { ...doc, _id: result.insertedId };
  } catch (err) {
    // The unique index on `email` — not a pre-read — is what actually prevents two
    // concurrent signups from both creating the same account, so the duplicate case is
    // handled here rather than by checking first.
    if (isDuplicateKeyError(err)) throw new UserError('EMAIL_TAKEN');
    throw err;
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserDoc | null> {
  return users(db).findOne({ email: normalizeEmail(email) });
}

export async function findUserById(db: Db, id: ObjectId): Promise<UserDoc | null> {
  return users(db).findOne({ _id: id });
}

/**
 * Re-reads the account behind a session cookie, returning it only if it still exists
 * and is still enabled.
 *
 * The session carries a *snapshot* (`SessionUser`) taken at sign-in. Without this
 * re-read, disabling an account or demoting an admin would have no effect until that
 * person's cookie happened to expire — which defeats the point of the disable button
 * on exactly the day it matters. Privileged surfaces (the admin guard, the account
 * mutations) therefore revalidate against the database instead of trusting the cookie's
 * copy of `role`.
 */
export async function findActiveUserById(db: Db, id: string): Promise<UserDoc | null> {
  let objectId: ObjectId;
  try {
    objectId = new ObjectIdCtor(id);
  } catch {
    return null;
  }
  const user = await users(db).findOne({ _id: objectId });
  return user && !user.disabled ? user : null;
}

/**
 * Returns the user only when the password matches AND the account is enabled. A
 * disabled account and a wrong password are deliberately indistinguishable to the
 * caller, so the sign-in form can't be used to enumerate which addresses exist.
 */
export async function authenticateUser(db: Db, email: string, password: string): Promise<UserDoc | null> {
  const user = await findUserByEmail(db, email);
  if (!user || user.disabled) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

export async function recordLogin(db: Db, id: ObjectId): Promise<void> {
  await users(db).updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } });
}

export async function setUserPassword(db: Db, id: ObjectId, password: string): Promise<void> {
  assertValidPassword(password);
  const result = await users(db).updateOne(
    { _id: id },
    { $set: { passwordHash: hashPassword(password), updatedAt: new Date() } },
  );
  if (result.matchedCount === 0) throw new UserError('USER_NOT_FOUND');
}

export async function updateProfile(db: Db, id: ObjectId, input: { name: string; email: string }): Promise<UserDoc> {
  if (!isValidEmail(input.email)) throw new UserError('INVALID_EMAIL');
  if (input.name.trim().length === 0) throw new UserError('NAME_REQUIRED');

  try {
    const updated = await users(db).findOneAndUpdate(
      { _id: id },
      { $set: { name: input.name.trim(), email: normalizeEmail(input.email), updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new UserError('USER_NOT_FOUND');
    return updated;
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new UserError('EMAIL_TAKEN');
    throw err;
  }
}

export async function setUserRole(db: Db, id: ObjectId, role: UserRole): Promise<void> {
  const result = await users(db).updateOne({ _id: id }, { $set: { role, updatedAt: new Date() } });
  if (result.matchedCount === 0) throw new UserError('USER_NOT_FOUND');
}

export async function setUserDisabled(db: Db, id: ObjectId, disabled: boolean): Promise<void> {
  const result = await users(db).updateOne({ _id: id }, { $set: { disabled, updatedAt: new Date() } });
  if (result.matchedCount === 0) throw new UserError('USER_NOT_FOUND');
}

export interface ListUsersFilter {
  search?: string;
  role?: UserRole;
  limit?: number;
}

export async function listUsers(db: Db, filter: ListUsersFilter = {}): Promise<UserDoc[]> {
  const query: Record<string, unknown> = {};
  if (filter.role) query.role = filter.role;
  if (filter.search) {
    // Escaped before being used as a regex — an unescaped '(' from a search box is a
    // MongoServerError, not a no-match.
    const escaped = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [{ email: { $regex: escaped, $options: 'i' } }, { name: { $regex: escaped, $options: 'i' } }];
  }
  return users(db).find(query).sort({ createdAt: -1 }).limit(filter.limit ?? 200).toArray();
}

/** Counts admins who can actually sign in — a disabled admin is not a way back into the
 *  panel, so it must not count toward the "don't remove the last admin" guard. */
export async function countActiveAdmins(db: Db): Promise<number> {
  return users(db).countDocuments({ role: 'admin', disabled: false });
}
