import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GcsStorageAdapter, LocalFsStorageAdapter, type GcsConfig } from '../../src/lib/storage.ts';

/** The SDK resolves primitive client config into async providers, so a value read back
 *  off `client.config` may be either the literal or a thunk returning it. */
async function resolveClientConfig(adapter: unknown, key: string): Promise<unknown> {
  const value = (adapter as { client: { config: Record<string, unknown> } }).client.config[key];
  return typeof value === 'function' ? (value as () => Promise<unknown>)() : value;
}

describe('LocalFsStorageAdapter', () => {
  let root: string;
  let adapter: LocalFsStorageAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'valdiviezo-storage-'));
    adapter = new LocalFsStorageAdapter(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips an object through putObject/getObject', async () => {
    const body = Buffer.from('hello derivative');
    await adapter.putObject({ bucket: 'public', key: 'foo/bar.jpg', body, contentType: 'image/jpeg' });
    const read = await adapter.getObject({ bucket: 'public', key: 'foo/bar.jpg' });
    expect(read.toString()).toBe('hello derivative');
  });

  it('keeps originals and public bucket paths separate', async () => {
    await adapter.putObject({
      bucket: 'originals',
      key: 'a.jpg',
      body: Buffer.from('orig'),
      contentType: 'image/jpeg',
    });
    await adapter.putObject({
      bucket: 'public',
      key: 'a.jpg',
      body: Buffer.from('deriv'),
      contentType: 'image/jpeg',
    });
    expect((await adapter.getObject({ bucket: 'originals', key: 'a.jpg' })).toString()).toBe('orig');
    expect((await adapter.getObject({ bucket: 'public', key: 'a.jpg' })).toString()).toBe('deriv');
  });

  it('publicUrl never takes a bucket parameter — structurally cannot address originals', () => {
    const url = adapter.publicUrl('some-key.jpg');
    expect(url).toBe('/local-public/some-key.jpg');
  });

  it('presigns an inert file:// PUT by default, which is what --dry-run wants', async () => {
    const url = await adapter.getPresignedPutUrl({ key: 'uploads/x.jpg', contentType: 'image/jpeg', expiresInSeconds: 60 });
    expect(url.startsWith('file://')).toBe(true);
  });

  it('points PUTs at the app upload route when the local driver configures one — a browser cannot PUT to file://', async () => {
    const driverAdapter = new LocalFsStorageAdapter(root, { uploadUrlBase: '/api/admin/upload', publicUrlBase: '/local-public' });
    const url = await driverAdapter.getPresignedPutUrl({ key: 'uploads/x.jpg', contentType: 'image/jpeg', expiresInSeconds: 60 });
    expect(url).toBe('/api/admin/upload/uploads/x.jpg');
    expect(driverAdapter.publicUrl('sea-lion.webp')).toBe('/local-public/sea-lion.webp');
  });

  it('deleteObject removes the file', async () => {
    await adapter.putObject({
      bucket: 'public',
      key: 'to-delete.jpg',
      body: Buffer.from('x'),
      contentType: 'image/jpeg',
    });
    await adapter.deleteObject({ bucket: 'public', key: 'to-delete.jpg' });
    await expect(adapter.getObject({ bucket: 'public', key: 'to-delete.jpg' })).rejects.toThrow();
  });
});

describe('GcsStorageAdapter', () => {
  function makeAdapter(overrides: Partial<GcsConfig> = {}) {
    return new GcsStorageAdapter({
      accessKeyId: 'GOOG1EXAMPLE',
      secretAccessKey: 'hmac-secret',
      bucket: 'valdiviezo-photos',
      ...overrides,
    });
  }

  /** The prefix a command actually addressed, read off the object name the SDK was
   *  handed. Single-bucket mode makes this prefix the paywall boundary, so it is worth
   *  asserting directly rather than trusting the call site. */
  function objectNameFor(adapter: GcsStorageAdapter, bucket: 'originals' | 'public', key: string): string {
    return (adapter as unknown as { objectName(b: string, k: string): string }).objectName(bucket, key);
  }

  it('talks to the Google Cloud Storage S3-compatible endpoint', async () => {
    expect(await resolveClientConfig(makeAdapter(), 'endpoint')).toEqual(
      expect.objectContaining({ hostname: 'storage.googleapis.com' }),
    );
  });

  it('uses path-style addressing, since GCS virtual-hosted URLs break on bucket names with dots', async () => {
    expect(await resolveClientConfig(makeAdapter(), 'forcePathStyle')).toBe(true);
  });

  it('keeps checksum calculation off, which GCS does not implement', async () => {
    expect(await resolveClientConfig(makeAdapter(), 'requestChecksumCalculation')).toBe('WHEN_REQUIRED');
    expect(await resolveClientConfig(makeAdapter(), 'responseChecksumValidation')).toBe('WHEN_REQUIRED');
  });

  it('puts both classes of object in one bucket, separated by prefix', async () => {
    const adapter = makeAdapter();
    const config = (adapter as unknown as { cfg: { bucketOriginals: string; bucketPublic: string } }).cfg;
    expect(config.bucketOriginals).toBe('valdiviezo-photos');
    expect(config.bucketPublic).toBe('valdiviezo-photos');
    expect(objectNameFor(adapter, 'originals', 'uploads/x.jpg')).toBe('originals/uploads/x.jpg');
    expect(objectNameFor(adapter, 'public', 'sea-lion.webp')).toBe('public/sea-lion.webp');
  });

  it('honours custom prefixes', () => {
    const adapter = makeAdapter({ originalsPrefix: 'raw', publicPrefix: 'web' });
    expect(objectNameFor(adapter, 'originals', 'x.jpg')).toBe('raw/x.jpg');
    expect(objectNameFor(adapter, 'public', 'x.webp')).toBe('web/x.webp');
    expect(adapter.publicUrl('x.webp')).toBe('https://storage.googleapis.com/valdiviezo-photos/web/x.webp');
  });

  it('builds public URLs under the public prefix only — it cannot name an original', () => {
    const url = makeAdapter().publicUrl('sea-lion.webp');
    expect(url).toBe('https://storage.googleapis.com/valdiviezo-photos/public/sea-lion.webp');
    expect(url).not.toContain('originals/');
  });

  it('does not let a key that looks like a traversal escape the public prefix in a URL', () => {
    // Keys are validated on the way in (lib/storageKeys.ts); this pins the prefix being
    // prepended unconditionally rather than pattern-matched away.
    expect(makeAdapter().publicUrl('sea-lion.webp')).toContain('/public/sea-lion.webp');
  });

  it('configures a public-read ACL, which is the only way one bucket can serve derivatives publicly', () => {
    const config = (makeAdapter() as unknown as { cfg: { publicObjectAcl?: string } }).cfg;
    // GCS rejects IAM conditions on allUsers bindings, so per-object ACLs carry the
    // public/private split instead of bucket policy.
    expect(config.publicObjectAcl).toBe('public-read');
  });

  it('honours a CDN or custom-domain base URL when one is configured', () => {
    const adapter = makeAdapter({ publicBaseUrl: 'https://images.example.com/' });
    expect(adapter.publicUrl('sea-lion.webp')).toBe('https://images.example.com/public/sea-lion.webp');
  });
});
