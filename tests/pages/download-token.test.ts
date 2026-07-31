import { beforeEach, describe, expect, it, vi } from 'vitest';

const consumeDownloadTokenMock = vi.fn();
const getPresignedGetUrlMock = vi.fn();

vi.mock('../../src/lib/db', () => ({ getDb: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/lib/config', () => ({
  getDbConfig: vi.fn(() => ({})),
  getR2Config: vi.fn(() => ({})),
}));
vi.mock('../../src/lib/downloads', () => ({ consumeDownloadToken: consumeDownloadTokenMock }));
vi.mock('../../src/lib/storage', () => ({
  createStorageAdapter: vi.fn(() => ({ getPresignedGetUrl: getPresignedGetUrlMock })),
}));

const { GET } = await import('../../src/pages/api/download/[token].ts');

function makeContext(token: string | undefined, headers: Record<string, string> = {}) {
  return {
    params: { token },
    request: new Request('http://localhost/api/download/x', { headers }),
    clientAddress: '10.0.0.1',
  } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/download/[token]', () => {
  beforeEach(() => {
    consumeDownloadTokenMock.mockReset();
    getPresignedGetUrlMock.mockReset();
  });

  it('404s when no token param is present', async () => {
    const response = await GET(makeContext(undefined));
    expect(response.status).toBe(404);
  });

  it('404s when the token is not found', async () => {
    consumeDownloadTokenMock.mockResolvedValue({ ok: false, reason: 'NOT_FOUND' });
    const response = await GET(makeContext('bogus'));
    expect(response.status).toBe(404);
  });

  it.each(['EXPIRED', 'EXHAUSTED', 'ORDER_NOT_PAID'] as const)('403s when the token is %s', async (reason) => {
    consumeDownloadTokenMock.mockResolvedValue({ ok: false, reason });
    const response = await GET(makeContext('bad-token'));
    expect(response.status).toBe(403);
  });

  it('302-redirects to a presigned URL with an attachment disposition on success', async () => {
    consumeDownloadTokenMock.mockResolvedValue({ ok: true, photoOriginalKey: 'sea-lion.jpg', orderId: 'order-1' });
    getPresignedGetUrlMock.mockResolvedValue('https://r2.example.com/signed?sig=abc');

    const response = await GET(makeContext('good-token'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://r2.example.com/signed?sig=abc');
    expect(getPresignedGetUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'originals',
        key: 'sea-lion.jpg',
        expiresInSeconds: 300,
        responseContentDisposition: 'attachment; filename="sea-lion.jpg"',
      }),
    );
  });

  it('passes the x-forwarded-for IP through to consumeDownloadToken when present', async () => {
    consumeDownloadTokenMock.mockResolvedValue({ ok: false, reason: 'NOT_FOUND' });
    await GET(makeContext('t', { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }));
    expect(consumeDownloadTokenMock).toHaveBeenCalledWith(expect.anything(), 't', '203.0.113.5');
  });

  it('falls back to clientAddress when x-forwarded-for is absent', async () => {
    consumeDownloadTokenMock.mockResolvedValue({ ok: false, reason: 'NOT_FOUND' });
    await GET(makeContext('t'));
    expect(consumeDownloadTokenMock).toHaveBeenCalledWith(expect.anything(), 't', '10.0.0.1');
  });
});
