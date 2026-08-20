import { createHash, randomBytes } from 'node:crypto';

/**
 * The "secret you send someone, that we never store" primitive.
 *
 * Shared by download links and password-reset links because both need exactly the same
 * three properties and getting any of them subtly different in a second copy is how one
 * of the two ends up weaker than the other:
 *
 *   1. The raw value is generated once, handed to the caller, and never persisted.
 *   2. Only its SHA-256 digest goes in the database, so a leaked database dump is not a
 *      set of working links.
 *   3. Expiry is a stored timestamp compared at use time, never "trust the token".
 *
 * Plain SHA-256 with no salt or work factor is correct *here* and would be wrong for a
 * password: these are 256 bits of `randomBytes`, so there is no dictionary to attack and
 * nothing for a slow hash to buy. See lib/auth.ts for the scrypt used on passwords.
 */
export function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function isTokenExpired(expiresAt: Date, now = new Date()): boolean {
  return now >= expiresAt;
}
