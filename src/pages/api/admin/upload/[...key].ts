import type { APIRoute } from 'astro';
import { createStorage, getStorageDriver } from '../../../../lib/config';
import { isSafeObjectKey } from '../../../../lib/storageKeys';
import { isAdmin } from '../../../../lib/users';

export const prerender = false;

/**
 * The local storage driver's stand-in for a cloud presigned PUT URL.
 *
 * With GCS the browser uploads straight to the bucket and the app server never
 * sees the bytes. Local disk has no such endpoint, so this route *is* the upload target
 * — `LocalFsStorageAdapter.getPresignedPutUrl()` returns a URL pointing here. It exists
 * only for the `local` driver and refuses to run under any other, so a misconfiguration
 * can't quietly turn the app server into an upload proxy for a cloud bucket.
 *
 * Unlike a presigned URL, this carries no signature — the admin session is the
 * authorization, checked below.
 */
export const PUT: APIRoute = async ({ params, request, session }) => {
  if (getStorageDriver() !== 'local') {
    return new Response('Not found', { status: 404 });
  }

  const user = await session?.get('user');
  if (!isAdmin(user)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const key = params.key;
  if (!key || !isSafeObjectKey(key)) {
    return new Response('Invalid key', { status: 400 });
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength === 0) {
    return new Response('Empty body', { status: 400 });
  }

  await createStorage().putObject({
    bucket: 'originals',
    key,
    body,
    contentType: request.headers.get('content-type') ?? 'application/octet-stream',
  });

  return new Response(null, { status: 200 });
};
