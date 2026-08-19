// Serves one uploaded comprobante to the admin reviewing it.
//
// Receipts live under the *originals* class, which is private — the same place customer
// files live, and for the same reason: a bank screenshot carries an account number, a name
// and a balance. So this route streams the bytes through the app rather than handing out a
// presigned URL. A presigned link would work for GCS and be un-servable under the `local`
// driver (whose `getPresignedGetUrl` returns an inert `file://` path), and it would also
// survive being forwarded out of the panel, which a private document should not.
//
// It is under /api/, not /admin/, so src/middleware.ts's blanket page guard does NOT cover
// it — the authorization below is the only thing standing in front of these files.
import { ObjectId } from 'mongodb';
import type { APIRoute } from 'astro';
import { findTransferById } from '../../../../lib/bankTransfer';
import { createStorage, getDbConfig } from '../../../../lib/config';
import { getDb } from '../../../../lib/db';
import { findActiveUserById, isAdmin } from '../../../../lib/users';

export const prerender = false;

/**
 * The buyer named this file, so it is treated as hostile: it reaches a `Content-Disposition`
 * header, where a stray quote, newline or semicolon is header injection rather than an odd
 * filename. Anything outside a conservative set is dropped instead of escaped — the name is
 * a convenience for whoever saves the file, and nothing depends on it round-tripping.
 */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return cleaned || 'receipt';
}

export const GET: APIRoute = async ({ params, session }) => {
  // Re-read from the database rather than trusting the session's `role` snapshot: an admin
  // who has since been demoted or disabled must not keep pulling customer documents out of
  // the private bucket. Same reasoning as api/order-download.
  const sessionUser = await session?.get('user');
  if (!isAdmin(sessionUser)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const db = await getDb(getDbConfig());
  const current = await findActiveUserById(db, sessionUser!.id);
  if (!current || current.role !== 'admin') {
    return new Response('Unauthorized', { status: 401 });
  }

  let transferId: InstanceType<typeof ObjectId>;
  try {
    transferId = new ObjectId(params.id);
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const transfer = await findTransferById(db, transferId);
  if (!transfer) {
    return new Response('Not found', { status: 404 });
  }

  // The key comes from the document, never from the request — this route has no way to
  // address an arbitrary object, which is what keeps it from becoming a reader for the
  // whole originals bucket.
  let bytes: Buffer;
  try {
    bytes = await createStorage().getObject({ bucket: 'originals', key: transfer.receipt.key });
  } catch (err) {
    console.error('transfer-receipt: the stored receipt could not be read', transfer._id.toString(), err);
    return new Response('Receipt unavailable', { status: 502 });
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': transfer.receipt.contentType,
      'Content-Length': String(bytes.byteLength),
      // `inline` so the panel can show an image or a PDF in place; the reviewer's whole job
      // is looking at it, and forcing a download for that would be hostile.
      'Content-Disposition': `inline; filename="${safeFilename(transfer.receipt.filename)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
