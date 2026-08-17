import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

/** `node:crypto`'s built-in scrypt, not the `argon2` npm package — argon2 needs a
 *  native binding compiled at install time, which is unnecessary friction (especially
 *  on Windows) for a single admin account. scrypt is explicitly an acceptable choice
 *  per the spec ("scrypt/argon2 hash"). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// In-memory rate limiter — sufficient for a single-process Node standalone deployment
// (this whole project's target). Would need a shared store (Mongo/Redis) if ever run
// behind a load balancer with multiple instances.
//
// The key is caller-supplied rather than always an IP so each sign-in surface gets its
// own bucket (see `rateLimitKey`): a customer fumbling their password on /es/account/
// login must not consume the admin panel's attempt budget from the same office IP.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

interface AttemptWindow {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, AttemptWindow>();

export function rateLimitKey(scope: string, ip: string): string {
  return `${scope}:${ip}`;
}

export function isRateLimited(key: string, now = Date.now()): boolean {
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(key: string, now = Date.now()): void {
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}
