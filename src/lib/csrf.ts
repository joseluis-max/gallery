// Astro's `security.checkOrigin` CSRF defence, re-implemented — because the built-in one
// cannot be right behind a TLS-terminating proxy, and this app runs behind one.
//
// The built-in check (astro/dist/core/app/origin-check.js) forbids a state-changing request
// whose `Origin` header differs from `context.url.origin`. On the standalone Node adapter
// that URL is assembled by `createRequestFromNodeRequest`, which derives the scheme from
// `req.socket.encrypted` and nothing else — `x-forwarded-proto` is never consulted. (The
// sibling `createRequest` in the same file DOES consult it, but only `mode: 'middleware'`
// calls that one.) Cloud Run terminates TLS at its front end and speaks plain HTTP to the
// container, so the server computes `http://josevaldiviezo.com` while the browser sends
// `Origin: https://josevaldiviezo.com`, and every form-encoded POST is answered with a 403
// that no amount of correct client code can avoid.
//
// In practice that was exactly one endpoint. The check only applies to form-like content
// types, so all the JSON actions — the cart, sign-in, every admin operation — were
// unaffected, and the single casualty was `transfer.submitReceipt`, the app's only
// `accept: 'form'` action (it is form-encoded because it carries a file). Paying by bank
// transfer was therefore impossible in production while everything around it worked.
//
// So `security.checkOrigin` is off in astro.config.mjs and this runs from src/middleware.ts
// instead. The rules below are Astro's, unchanged — the only difference is which origins
// count as ours, and that set is widened by exactly two entries, both of them origins this
// server genuinely answers on: the one the proxy says the visitor actually used, and the
// canonical PUBLIC_SITE_URL.

/** Methods a cross-site form cannot use to change state, so they are never checked. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The content types an HTML form can post cross-origin without a CORS preflight — which is
 * what makes them, and only them, a CSRF vector. `application/json` is not among them: the
 * browser refuses to send it cross-origin without permission the server never grants, which
 * is why an origin mismatch is harmless for the JSON actions and fatal for the form one.
 */
const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

export interface OriginCheckInput {
  method: string;
  /** The `Origin` header. Null when the caller sent none — treated as not-ours, as Astro does. */
  origin: string | null;
  /** The `Content-Type` header, verbatim (it carries the multipart boundary too). */
  contentType: string | null;
  /** `X-Forwarded-Proto`, verbatim. A chain of proxies may make it a comma-separated list. */
  forwardedProto: string | null;
  /** `context.url.origin` — the scheme this *container* saw, plus the Host header. */
  requestOrigin: string;
  /** The canonical public origin, from PUBLIC_SITE_URL. Empty string if there isn't one. */
  siteOrigin: string;
}

/**
 * Every origin that means "this site".
 *
 * `requestOrigin` alone is what Astro compares against, and on this deployment it is
 * `http://` where the visitor used `https://`. The forwarded scheme repairs that; the
 * canonical origin covers the reverse failure — a proxy that rewrites Host, which would
 * leave the server naming itself something the browser never typed.
 *
 * Neither addition is a hole: an attacker's page cannot choose the `Origin` its victim's
 * browser sends, and a caller who can forge `X-Forwarded-Proto` is not a browser and so has
 * no session cookie to ride on in the first place.
 */
export function allowedOrigins({ forwardedProto, requestOrigin, siteOrigin }: Pick<OriginCheckInput, 'forwardedProto' | 'requestOrigin' | 'siteOrigin'>): string[] {
  const origins = new Set<string>();
  if (requestOrigin) origins.add(requestOrigin);
  if (siteOrigin) origins.add(siteOrigin);

  // Only the first hop is ours to believe; anything further down the chain was written by
  // a proxy we don't run. And only the two schemes a browser can be here on at all.
  const proto = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  if ((proto === 'http' || proto === 'https') && requestOrigin) {
    try {
      const url = new URL(requestOrigin);
      url.protocol = `${proto}:`;
      origins.add(url.origin);
    } catch {
      /* An unparseable request origin leaves the set as it is. */
    }
  }

  return [...origins];
}

function isFormLike(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return FORM_CONTENT_TYPES.some((type) => lower.includes(type));
}

/**
 * Astro's predicate, verbatim in structure: a non-safe method is forbidden when it comes
 * from somewhere else AND it is shaped like a form post — or when it carries no content
 * type at all to be judged on.
 */
export function isForbiddenCrossOriginRequest(input: OriginCheckInput): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false;

  const sameOrigin = input.origin !== null && allowedOrigins(input).includes(input.origin);

  if (input.contentType !== null) {
    return isFormLike(input.contentType) && !sameOrigin;
  }
  return !sameOrigin;
}
