import type { APIRoute } from 'astro';
import { createStorage, getStorageDriver } from '../../lib/config';
import { contentTypeForKey, isSafeObjectKey } from '../../lib/storageKeys';

export const prerender = false;

/**
 * Serves the local driver's *public* bucket — the watermarked ≤2000px derivatives, the
 * same bytes a CDN would serve in front of GCS. It reads only from the public
 * bucket directory; there is no parameter here that could address an original, which is
 * the same structural guarantee `StorageAdapter.publicUrl()` has.
 *
 * Static files under `public/local-public/` (written by `scripts/seed-preview.ts`) are
 * matched by the static handler before this route, so the two coexist: seeded previews
 * stay static, browser uploads come from here.
 */
export const GET: APIRoute = async ({ params }) => {
  if (getStorageDriver() !== 'local') {
    return new Response('Not found', { status: 404 });
  }

  const key = params.key;
  if (!key || !isSafeObjectKey(key)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const bytes = await createStorage().getObject({ bucket: 'public', key });
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentTypeForKey(key),
        // Derivative keys are slug-derived and rewritten in place when a photo is
        // reprocessed, so this stays short rather than immutable.
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};
