import { describe, expect, it } from 'vitest';
import { getPhotoImageUrls } from '../../src/lib/photos.ts';
import { LocalFsStorageAdapter } from '../../src/lib/storage.ts';

describe('getPhotoImageUrls', () => {
  const storage = new LocalFsStorageAdapter('/tmp/unused');

  it('derives the JPEG fallback key from the WebP key stored on the photo', () => {
    const urls = getPhotoImageUrls({ storage: { originalKey: 'x.jpg', publicKey: 'sea-lions-dock.webp' } }, storage);
    expect(urls.webp).toBe('/local-public/sea-lions-dock.webp');
    expect(urls.jpeg).toBe('/local-public/sea-lions-dock.jpg');
  });

  it('is case-insensitive on the .webp extension', () => {
    const urls = getPhotoImageUrls({ storage: { originalKey: 'x.jpg', publicKey: 'photo.WEBP' } }, storage);
    expect(urls.jpeg).toBe('/local-public/photo.jpg');
  });

  it('only replaces a trailing .webp, not one appearing mid-slug', () => {
    const urls = getPhotoImageUrls({ storage: { originalKey: 'x.jpg', publicKey: 'webp-launch-day.webp' } }, storage);
    expect(urls.jpeg).toBe('/local-public/webp-launch-day.jpg');
  });
});
