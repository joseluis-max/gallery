import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeDownloadToken,
  generateRawToken,
  hashToken,
  isTokenExhausted,
  isTokenExpired,
} from '../../src/lib/downloads.ts';

describe('generateRawToken / hashToken', () => {
  it('generates distinct, sufficiently long base64url tokens', () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).not.toBe(b);
    // 32 random bytes -> 43 base64url chars (no padding).
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashToken is deterministic and produces a 64-char hex SHA-256 digest', () => {
    const raw = generateRawToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
    expect(hashToken(raw)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('isTokenExpired / isTokenExhausted', () => {
  it('flags a past expiresAt as expired', () => {
    expect(isTokenExpired(new Date(Date.now() - 1000))).toBe(true);
    expect(isTokenExpired(new Date(Date.now() + 1000))).toBe(false);
  });

  it('flags useCount >= maxUses as exhausted', () => {
    expect(isTokenExhausted(5, 5)).toBe(true);
    expect(isTokenExhausted(4, 5)).toBe(false);
  });
});

function makeMockDb(config: {
  findOneAndUpdateResult: unknown;
  tokenFindOneResult?: unknown;
  orderFindOneResult?: unknown;
  photoFindOneResult?: unknown;
}): Db {
  const collections: Record<string, { findOneAndUpdate: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> }> = {
    downloadTokens: {
      findOneAndUpdate: vi.fn().mockResolvedValue(config.findOneAndUpdateResult),
      findOne: vi.fn().mockResolvedValue(config.tokenFindOneResult ?? null),
    },
    orders: {
      findOneAndUpdate: vi.fn(),
      findOne: vi.fn().mockResolvedValue(config.orderFindOneResult ?? null),
    },
    photos: {
      findOneAndUpdate: vi.fn(),
      findOne: vi.fn().mockResolvedValue(config.photoFindOneResult ?? null),
    },
  };
  return { collection: (name: string) => collections[name] } as unknown as Db;
}

const orderId = 'order-1' as unknown as import('mongodb').ObjectId;
const photoId = 'photo-1' as unknown as import('mongodb').ObjectId;

describe('consumeDownloadToken', () => {
  it('returns ok with the original key when the token, order, and photo are all valid', async () => {
    const db = makeMockDb({
      findOneAndUpdateResult: { orderId, photoId, useCount: 1, maxUses: 5, expiresAt: new Date(Date.now() + 10000) },
      orderFindOneResult: { status: 'paid' },
      photoFindOneResult: { storage: { originalKey: 'sea-lion.jpg' } },
    });
    const result = await consumeDownloadToken(db, 'raw-token', '1.2.3.4');
    expect(result).toEqual({ ok: true, photoOriginalKey: 'sea-lion.jpg', orderId });
  });

  // Inverted deliberately when physical prints were removed: 'fulfilled' used to mean
  // "shipped" and was accepted alongside 'paid'. It is no longer a status this app
  // writes, so anything still carrying it is stale data and must NOT open the gate to an
  // original. This assertion is the regression test for accidentally widening the check.
  it('rejects an order in any status other than paid, including the retired "fulfilled"', async () => {
    const db = makeMockDb({
      findOneAndUpdateResult: { orderId, photoId },
      orderFindOneResult: { status: 'fulfilled' },
      photoFindOneResult: { storage: { originalKey: 'sea-lion.jpg' } },
    });
    const result = await consumeDownloadToken(db, 'raw-token', '1.2.3.4');
    expect(result).toEqual({ ok: false, reason: 'ORDER_NOT_PAID' });
  });

  it('returns NOT_FOUND when the token hash matches nothing', async () => {
    const db = makeMockDb({ findOneAndUpdateResult: null, tokenFindOneResult: null });
    const result = await consumeDownloadToken(db, 'nonexistent', '1.2.3.4');
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('returns EXPIRED when the token exists but the atomic filter rejected it for expiry', async () => {
    const db = makeMockDb({
      findOneAndUpdateResult: null,
      tokenFindOneResult: { expiresAt: new Date(Date.now() - 10000), useCount: 1, maxUses: 5 },
    });
    const result = await consumeDownloadToken(db, 'expired-token', '1.2.3.4');
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('returns EXHAUSTED when not expired but useCount already hit maxUses', async () => {
    const db = makeMockDb({
      findOneAndUpdateResult: null,
      tokenFindOneResult: { expiresAt: new Date(Date.now() + 10000), useCount: 5, maxUses: 5 },
    });
    const result = await consumeDownloadToken(db, 'exhausted-token', '1.2.3.4');
    expect(result).toEqual({ ok: false, reason: 'EXHAUSTED' });
  });

  it('returns ORDER_NOT_PAID when the bound order is still pending', async () => {
    const db = makeMockDb({
      findOneAndUpdateResult: { orderId, photoId },
      orderFindOneResult: { status: 'pending' },
    });
    const result = await consumeDownloadToken(db, 'raw-token', '1.2.3.4');
    expect(result).toEqual({ ok: false, reason: 'ORDER_NOT_PAID' });
  });

  it('returns ORDER_NOT_PAID when the bound order no longer exists', async () => {
    const db = makeMockDb({
      findOneAndUpdateResult: { orderId, photoId },
      orderFindOneResult: null,
    });
    const result = await consumeDownloadToken(db, 'raw-token', '1.2.3.4');
    expect(result).toEqual({ ok: false, reason: 'ORDER_NOT_PAID' });
  });
});
