import { describe, expect, it, vi } from 'vitest';
import { GcsStorageAdapter } from '../../src/lib/storage.ts';

/**
 * The public/private split in a single bucket rests entirely on which objects get a
 * `public-read` ACL, so these assert the exact command the SDK is handed — the one
 * thing that, if it silently regressed, would either break every thumbnail or expose
 * every original.
 */
function captureSend(adapter: GcsStorageAdapter) {
  const send = vi.fn().mockResolvedValue({});
  (adapter as unknown as { client: { send: unknown } }).client = { send };
  return send;
}

function makeAdapter() {
  return new GcsStorageAdapter({
    accessKeyId: 'GOOG1EXAMPLE',
    secretAccessKey: 'hmac-secret',
    bucket: 'valdiviezo-gallery',
  });
}

describe('GcsStorageAdapter.putObject ACL handling', () => {
  it('marks a derivative public-read, under the public prefix', async () => {
    const adapter = makeAdapter();
    const send = captureSend(adapter);

    await adapter.putObject({ bucket: 'public', key: 'sea-lion.webp', body: Buffer.from('x'), contentType: 'image/webp' });

    const input = send.mock.calls[0][0].input;
    expect(input.Bucket).toBe('valdiviezo-gallery');
    expect(input.Key).toBe('public/sea-lion.webp');
    expect(input.ACL).toBe('public-read');
  });

  it('never marks an original public-read, and keeps it under the originals prefix', async () => {
    const adapter = makeAdapter();
    const send = captureSend(adapter);

    await adapter.putObject({
      bucket: 'originals',
      key: 'uploads/abc-IMG_1030.jpg',
      body: Buffer.from('x'),
      contentType: 'image/jpeg',
    });

    const input = send.mock.calls[0][0].input;
    expect(input.Key).toBe('originals/uploads/abc-IMG_1030.jpg');
    expect(input.ACL).toBeUndefined();
  });

  it('signs an upload URL for the originals prefix only', async () => {
    const adapter = makeAdapter();
    const url = await adapter.getPresignedPutUrl({ key: 'uploads/x.jpg', contentType: 'image/jpeg', expiresInSeconds: 60 });
    expect(url).toContain('/valdiviezo-gallery/originals/uploads/x.jpg');
    expect(url).not.toContain('/public/');
    // A presigned PUT must not carry the public ACL — the browser uploads originals.
    expect(url).not.toContain('x-amz-acl');
  });
});
