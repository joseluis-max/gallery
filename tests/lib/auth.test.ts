import { beforeEach, describe, expect, it } from 'vitest';
import { clearAttempts, hashPassword, isRateLimited, recordFailedAttempt, verifyPassword } from '../../src/lib/auth.ts';

describe('hashPassword / verifyPassword', () => {
  it('verifies the correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects an incorrect password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('produces a different salt (and thus different stored value) each time', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password', a)).toBe(true);
    expect(verifyPassword('same-password', b)).toBe(true);
  });

  it('rejects a malformed stored hash gracefully instead of throwing', () => {
    expect(verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
  });
});

describe('rate limiting', () => {
  const ip = '198.51.100.7';

  beforeEach(() => {
    clearAttempts(ip);
  });

  it('is not rate limited before any failed attempts', () => {
    expect(isRateLimited(ip)).toBe(false);
  });

  it('becomes rate limited after 10 failed attempts within the window', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) recordFailedAttempt(ip, now);
    expect(isRateLimited(ip, now)).toBe(true);
  });

  it('is not rate limited after only 9 failed attempts', () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) recordFailedAttempt(ip, now);
    expect(isRateLimited(ip, now)).toBe(false);
  });

  it('resets after the window elapses', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) recordFailedAttempt(ip, now);
    expect(isRateLimited(ip, now)).toBe(true);
    const later = now + 16 * 60 * 1000;
    expect(isRateLimited(ip, later)).toBe(false);
  });

  it('clearAttempts resets the counter immediately', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) recordFailedAttempt(ip, now);
    expect(isRateLimited(ip, now)).toBe(true);
    clearAttempts(ip);
    expect(isRateLimited(ip, now)).toBe(false);
  });
});
