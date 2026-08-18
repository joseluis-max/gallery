/**
 * Accepts a caller-supplied redirect target only if it's a same-site *path*, falling
 * back to `fallback` otherwise. `?next=https://evil.example` and the protocol-relative
 * `?next=//evil.example` are the two shapes that turn a sign-in form into an open
 * redirect, and both are rejected here rather than at each call site.
 */
export function safeRedirectTarget(candidate: string | null | undefined, fallback: string): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//')) return fallback;
  // A backslash is treated as a path separator by several browsers' URL parsers, so
  // `/\evil.example` can navigate off-site despite starting with a slash.
  if (candidate.includes('\\')) return fallback;
  return candidate;
}
