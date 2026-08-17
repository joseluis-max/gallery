import { describe, expect, it } from 'vitest';
import { safeRedirectTarget } from '../../src/lib/redirects.ts';

describe('safeRedirectTarget', () => {
  const fallback = '/es/account';

  it('keeps a same-site path', () => {
    expect(safeRedirectTarget('/en/cart', fallback)).toBe('/en/cart');
    expect(safeRedirectTarget('/es/order/abc?x=1', fallback)).toBe('/es/order/abc?x=1');
  });

  it('falls back when nothing was supplied', () => {
    expect(safeRedirectTarget(null, fallback)).toBe(fallback);
    expect(safeRedirectTarget(undefined, fallback)).toBe(fallback);
    expect(safeRedirectTarget('', fallback)).toBe(fallback);
  });

  it('rejects absolute URLs to another origin', () => {
    expect(safeRedirectTarget('https://evil.example/phish', fallback)).toBe(fallback);
    expect(safeRedirectTarget('http://evil.example', fallback)).toBe(fallback);
  });

  it('rejects protocol-relative and backslash targets, which browsers resolve off-site', () => {
    expect(safeRedirectTarget('//evil.example', fallback)).toBe(fallback);
    expect(safeRedirectTarget('/\\evil.example', fallback)).toBe(fallback);
  });

  it('rejects a javascript: payload', () => {
    expect(safeRedirectTarget('javascript:alert(1)', fallback)).toBe(fallback);
  });
});
