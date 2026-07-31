import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsStorageAdapter, R2StorageAdapter } from '../../src/lib/storage.ts';

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

describe('R2StorageAdapter', () => {
  function makeAdapter() {
    return new R2StorageAdapter({
      accountId: 'acct',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucketOriginals: 'originals',
      bucketPublic: 'public',
      publicBaseUrl: 'https://cdn.example.com/',
    });
  }

  // The AWS SDK resolves primitive config values into async providers internally, so
  // `client.config.requestChecksumCalculation` is a `() => Promise<string>`, not the
  // literal string — resolve it to check the value actually reaching the client, since
  // this is exactly the setting that silently breaks R2 uploads if it's ever dropped.
  it('constructs an S3Client with checksum calculation set to WHEN_REQUIRED', async () => {
    const adapter = makeAdapter();
    const client = (adapter as unknown as { client: { config: Record<string, unknown> } }).client;
    const requestChecksum = client.config.requestChecksumCalculation;
    const responseChecksum = client.config.responseChecksumValidation;
    const resolvedRequest = typeof requestChecksum === 'function' ? await (requestChecksum as () => Promise<string>)() : requestChecksum;
    const resolvedResponse = typeof responseChecksum === 'function' ? await (responseChecksum as () => Promise<string>)() : responseChecksum;
    expect(resolvedRequest).toBe('WHEN_REQUIRED');
    expect(resolvedResponse).toBe('WHEN_REQUIRED');
  });

  it('publicUrl joins the base URL and key without a bucket parameter', () => {
    const adapter = makeAdapter();
    expect(adapter.publicUrl('galapagos/sea-lion.webp')).toBe('https://cdn.example.com/galapagos/sea-lion.webp');
  });
});
