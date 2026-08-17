/**
 * Object keys arrive from the URL on the local driver's routes, and a key is used
 * verbatim as a path segment under LOCAL_STORAGE_DIR — so `..%2f..%2f.env` would
 * otherwise read or write anywhere the process can reach. Cloud drivers don't need this
 * (S3 keys aren't paths), which is exactly why it's easy to forget when adding a
 * filesystem-backed one.
 *
 * Kept deliberately strict rather than clever: keys this project generates are
 * `uploads/<uuid>-<sanitized-filename>` and `<slug>.webp|.jpg`, all of which pass.
 */
export function isSafeObjectKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  // Reject anything that isn't a plain relative path of safe characters.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) return false;
  // No traversal, no doubled or trailing separators, no hidden segments.
  if (key.includes('..') || key.includes('//') || key.endsWith('/')) return false;
  return true;
}

const CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function contentTypeForKey(key: string): string {
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}
