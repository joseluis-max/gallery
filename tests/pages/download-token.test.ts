import { beforeEach, describe, expect, it, vi } from 'vitest';

const consumeDownloadTokenMock = vi.fn();
const getPresignedGetUrlMock = vi.fn();
const getObjectMock = vi.fn();
const getStorageDriverMock = vi.fn(() => 'gcs');

vi.mock('../../src/lib/db', () => ({ getDb: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/lib/config', () => ({
  getDbConfig: vi.fn(() => ({})),
  getStorageDriver: getStorageDriverMock,
  createStorage: vi.fn(() => ({ getPresignedGetUrl: getPresignedGetUrlMock, getObject: getObjectMock })),
}));
vi.mock('../../src/lib/downloads', () => ({ consumeDownloadToken: consumeDownloadTokenMock }));

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
    getObjectMock.mockReset();
    getStorageDriverMock.mockReturnValue('gcs');
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
    getPresignedGetUrlMock.mockResolvedValue('https://storage.googleapis.com/bucket/originals/x.jpg?X-Amz-Signature=abc');

    const response = await GET(makeContext('good-token'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://storage.googleapis.com/bucket/originals/x.jpg?X-Amz-Signature=abc');
    expect(getPresignedGetUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'originals',
        key: 'sea-lion.jpg',
        expiresInSeconds: 300,
        responseContentDisposition: 'attachment; filename="sea-lion.jpg"',
      }),
    );
  });

  it('streams the bytes itself under the local driver, which has no presigned URL to redirect to', async () => {
    getStorageDriverMock.mockReturnValue('local');
    consumeDownloadTokenMock.mockResolvedValue({ ok: true, photoOriginalKey: 'uploads/abc-sea-lion.jpg', orderId: 'order-1' });
    getObjectMock.mockResolvedValue(Buffer.from('original-bytes'));

    const response = await GET(makeContext('good-token'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="abc-sea-lion.jpg"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('original-bytes');
    // The paywall boundary still holds: no public URL is minted for an original.
    expect(getPresignedGetUrlMock).not.toHaveBeenCalled();
    expect(getObjectMock).toHaveBeenCalledWith({ bucket: 'originals', key: 'uploads/abc-sea-lion.jpg' });
  });

  it('still refuses an invalid token under the local driver, rather than streaming anything', async () => {
    getStorageDriverMock.mockReturnValue('local');
    consumeDownloadTokenMock.mockResolvedValue({ ok: false, reason: 'EXPIRED' });

    const response = await GET(makeContext('expired'));

    expect(response.status).toBe(403);
    expect(getObjectMock).not.toHaveBeenCalled();
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
