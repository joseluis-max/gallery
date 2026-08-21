import { describe, expect, it } from 'vitest';
import { allowedOrigins, isForbiddenCrossOriginRequest, type OriginCheckInput } from '../../src/lib/csrf.ts';

/** The production shape: Cloud Run terminated TLS, so the container saw plain HTTP. */
const behindProxy = (over: Partial<OriginCheckInput> = {}): OriginCheckInput => ({
  method: 'POST',
  origin: 'https://josevaldiviezo.com',
  contentType: 'multipart/form-data; boundary=----WebKitFormBoundaryAbc123',
  forwardedProto: 'https',
  requestOrigin: 'http://josevaldiviezo.com',
  siteOrigin: 'https://josevaldiviezo.com',
  ...over,
});

describe('allowedOrigins', () => {
  it('accepts the forwarded scheme, which is what the visitor actually used', () => {
    expect(allowedOrigins(behindProxy())).toContain('https://josevaldiviezo.com');
  });

  it('keeps the origin the server computed, so plain-HTTP local development still passes', () => {
    const origins = allowedOrigins({ forwardedProto: null, requestOrigin: 'http://localhost:4321', siteOrigin: '' });
    expect(origins).toEqual(['http://localhost:4321']);
  });

  it('preserves the port when it rewrites the scheme', () => {
    const origins = allowedOrigins({ forwardedProto: 'https', requestOrigin: 'http://localhost:4321', siteOrigin: '' });
    expect(origins).toContain('https://localhost:4321');
  });

  it('believes only the first hop of a proxy chain', () => {
    const origins = allowedOrigins({ forwardedProto: 'https, http', requestOrigin: 'http://josevaldiviezo.com', siteOrigin: '' });
    expect(origins).toContain('https://josevaldiviezo.com');
  });

  it('ignores a scheme a browser could never have arrived on', () => {
    const origins = allowedOrigins({ forwardedProto: 'javascript', requestOrigin: 'http://josevaldiviezo.com', siteOrigin: '' });
    expect(origins).toEqual(['http://josevaldiviezo.com']);
  });

  it('covers a proxy that rewrites Host, via the canonical origin', () => {
    const origins = allowedOrigins({
      forwardedProto: 'https',
      requestOrigin: 'http://valdiviezo-gallery-fvve3xyyxq-ue.a.run.app',
      siteOrigin: 'https://josevaldiviezo.com',
    });
    expect(origins).toContain('https://josevaldiviezo.com');
  });

  it('never emits an empty entry when there is no canonical origin', () => {
    expect(allowedOrigins({ forwardedProto: null, requestOrigin: 'http://localhost:4321', siteOrigin: '' })).not.toContain('');
  });
});

describe('isForbiddenCrossOriginRequest', () => {
  it('allows the comprobante upload that production was rejecting', () => {
    expect(isForbiddenCrossOriginRequest(behindProxy())).toBe(false);
  });

  it('still rejects a genuine cross-site form post', () => {
    expect(isForbiddenCrossOriginRequest(behindProxy({ origin: 'https://evil.example' }))).toBe(true);
  });

  it('rejects a same-host form post that arrived over the wrong scheme', () => {
    expect(isForbiddenCrossOriginRequest(behindProxy({ origin: 'http://josevaldiviezo.com', forwardedProto: 'https', siteOrigin: 'https://josevaldiviezo.com', requestOrigin: 'https://josevaldiviezo.com' }))).toBe(true);
  });

  it('rejects an opaque origin', () => {
    expect(isForbiddenCrossOriginRequest(behindProxy({ origin: 'null' }))).toBe(true);
  });

  it('rejects a form post with no Origin header at all', () => {
    expect(isForbiddenCrossOriginRequest(behindProxy({ origin: null }))).toBe(true);
  });

  it('leaves cross-origin JSON alone — a browser cannot send it cross-site unasked', () => {
    expect(isForbiddenCrossOriginRequest(behindProxy({ origin: 'https://evil.example', contentType: 'application/json' }))).toBe(false);
  });

  it('rejects a body with no content type from elsewhere', () => {
    expect(isForbiddenCrossOriginRequest(behindProxy({ origin: 'https://evil.example', contentType: null }))).toBe(true);
  });

  it('covers the other two form-like encodings', () => {
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain;charset=UTF-8']) {
      expect(isForbiddenCrossOriginRequest(behindProxy({ origin: 'https://evil.example', contentType }))).toBe(true);
    }
  });

  it('matches the content type case-insensitively', () => {
    expect(isForbiddenCrossOriginRequest(behindProxy({ origin: 'https://evil.example', contentType: 'Multipart/Form-Data; boundary=x' }))).toBe(true);
  });

  it('never blocks a safe method, whatever it claims to be', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isForbiddenCrossOriginRequest(behindProxy({ method, origin: 'https://evil.example', contentType: null }))).toBe(false);
    }
  });

  it('checks the other state-changing methods too', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(isForbiddenCrossOriginRequest(behindProxy({ method, origin: 'https://evil.example' }))).toBe(true);
      expect(isForbiddenCrossOriginRequest(behindProxy({ method }))).toBe(false);
    }
  });
});
