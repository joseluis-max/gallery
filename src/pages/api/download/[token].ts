import type { APIRoute } from 'astro';
import { consumeDownloadToken } from '../../../lib/downloads';
import { createStorage, getDbConfig, getStorageDriver } from '../../../lib/config';
import { getDb } from '../../../lib/db';

export const prerender = false;

function clientIp(request: Request, fallback: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return fallback;
}

export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const token = params.token;
  if (!token) {
    return new Response('Not found', { status: 404 });
  }

  const db = await getDb(getDbConfig());
  const ip = clientIp(request, clientAddress ?? 'unknown');

  const result = await consumeDownloadToken(db, token, ip);

  if (!result.ok) {
    if (result.reason === 'NOT_FOUND') {
      return new Response('Not found', { status: 404 });
    }
    // EXPIRED / EXHAUSTED / ORDER_NOT_PAID all read the same to the requester: this
    // link no longer grants access. The distinction is preserved for the admin
    // downloads log, not surfaced here.
    return new Response('This download link is no longer valid.', { status: 403 });
  }

  const storage = createStorage();
  const filename = result.photoOriginalKey.split('/').pop() ?? 'photo.jpg';

  // Cloud drivers hand the buyer a short-lived presigned URL and step out of the way, so
  // 25MB originals never stream through the app server. The local driver has no such URL
  // to hand out (its objects are files on disk, and a browser can't follow `file://`),
  // so there the bytes do go through the server — acceptable, because local storage is
  // a development mode by definition.
  if (getStorageDriver() === 'local') {
    const bytes = await storage.getObject({ bucket: 'originals', key: result.photoOriginalKey });
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const url = await storage.getPresignedGetUrl({
    bucket: 'originals',
    key: result.photoOriginalKey,
    expiresInSeconds: 300,
    responseContentDisposition: `attachment; filename="${filename}"`,
  });

  return Response.redirect(url, 302);
};
