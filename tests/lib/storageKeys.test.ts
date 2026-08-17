import { describe, expect, it } from 'vitest';
import { contentTypeForKey, isSafeObjectKey } from '../../src/lib/storageKeys.ts';

describe('isSafeObjectKey', () => {
  it('accepts the key shapes this project actually generates', () => {
    expect(isSafeObjectKey('uploads/3f1c8a2e-4b7d-11ef-9c2a-0242ac120002-IMG_1030.jpg')).toBe(true);
    expect(isSafeObjectKey('sea-lion-yawning.webp')).toBe(true);
    expect(isSafeObjectKey('sea-lion-yawning.jpg')).toBe(true);
  });

  it('rejects path traversal, which would otherwise escape the storage directory', () => {
    expect(isSafeObjectKey('../.env')).toBe(false);
    expect(isSafeObjectKey('uploads/../../.env')).toBe(false);
    expect(isSafeObjectKey('uploads/..%2f.env')).toBe(false);
    expect(isSafeObjectKey('..')).toBe(false);
  });

  it('rejects absolute paths, drive letters, and backslash separators', () => {
    expect(isSafeObjectKey('/etc/passwd')).toBe(false);
    expect(isSafeObjectKey('C:\\Windows\\win.ini')).toBe(false);
    expect(isSafeObjectKey('uploads\\x.jpg')).toBe(false);
  });

  it('rejects empty, oversized, and malformed keys', () => {
    expect(isSafeObjectKey('')).toBe(false);
    expect(isSafeObjectKey('a'.repeat(513))).toBe(false);
    expect(isSafeObjectKey('uploads//x.jpg')).toBe(false);
    expect(isSafeObjectKey('uploads/')).toBe(false);
    expect(isSafeObjectKey('.hidden')).toBe(false);
    expect(isSafeObjectKey('a file.jpg')).toBe(false);
    expect(isSafeObjectKey('x\u0000.jpg')).toBe(false);
  });
});

describe('contentTypeForKey', () => {
  it('maps the derivative formats the pipeline writes', () => {
    expect(contentTypeForKey('sea-lion.webp')).toBe('image/webp');
    expect(contentTypeForKey('sea-lion.jpg')).toBe('image/jpeg');
    expect(contentTypeForKey('sea-lion.JPEG')).toBe('image/jpeg');
  });

  it('falls back to a non-renderable type for anything unrecognized', () => {
    expect(contentTypeForKey('mystery')).toBe('application/octet-stream');
    expect(contentTypeForKey('notes.txt')).toBe('application/octet-stream');
  });
});
