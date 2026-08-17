// Creates collections and indexes per the data model. Safe to re-run — createIndex is
// naturally idempotent, and createCollection failures for "already exists" are ignored.
import { getDb } from '../src/lib/db.ts';
import { getDbConfig } from './config.ts';

async function ensureCollection(db: Awaited<ReturnType<typeof getDb>>, name: string) {
  try {
    await db.createCollection(name);
    console.log(`created collection: ${name}`);
  } catch (err) {
    if (err instanceof Error && /already exists/i.test(err.message)) {
      console.log(`collection already exists: ${name}`);
    } else {
      throw err;
    }
  }
}

/**
 * `createIndex` is idempotent for an identical spec, but errors with
 * IndexOptionsConflict/IndexKeySpecsConflict when an index of the same shape already
 * exists with *different* options — which is exactly what happens re-running this after
 * an index definition is corrected. Dropping and recreating is safe here: these are
 * plain secondary indexes, and the drop only lands when the options genuinely differ.
 */
async function ensureIndex(
  db: Awaited<ReturnType<typeof getDb>>,
  collection: string,
  keys: Record<string, 1 | -1>,
  options: Record<string, unknown> = {},
) {
  try {
    await db.collection(collection).createIndex(keys, options);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 85 && code !== 86) throw err;
    const name = Object.entries(keys)
      .map(([field, direction]) => `${field}_${direction}`)
      .join('_');
    console.log(`recreating ${collection} index ${name} with updated options`);
    await db.collection(collection).dropIndex(name);
    await db.collection(collection).createIndex(keys, options);
  }
}

async function main() {
  const db = await getDb(getDbConfig());

  await ensureCollection(db, 'photos');
  await ensureCollection(db, 'orders');
  await ensureCollection(db, 'downloadTokens');
  await ensureCollection(db, 'stripeEvents');
  await ensureCollection(db, 'settings');
  await ensureCollection(db, 'auditLog');
  await ensureCollection(db, 'uploadJobs');
  await ensureCollection(db, 'users');
  await ensureCollection(db, 'sessions');

  await db.collection('photos').createIndex({ slug: 1 }, { unique: true });
  await db.collection('photos').createIndex({ status: 1 });
  await db.collection('photos').createIndex({ collections: 1 });
  await db.collection('photos').createIndex({ tags: 1 });

  // Sparse, not just unique: an order is inserted *before* its Stripe Checkout Session
  // exists (createPendingOrder → attachStripeSession), and a non-sparse unique index
  // counts every one of those as the same null key — so a second checkout starting
  // before the first order's session id was attached would fail to insert, and any
  // order that never got one would block all later ones permanently.
  await ensureIndex(db, 'orders', { stripeSessionId: 1 }, { unique: true, sparse: true });
  await db.collection('orders').createIndex({ status: 1 });
  await db.collection('orders').createIndex({ 'customer.email': 1 });
  // Sparse: guest orders have no userId, and there are expected to be many of them.
  await db.collection('orders').createIndex({ userId: 1, createdAt: -1 }, { sparse: true });

  await db.collection('downloadTokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('downloadTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('downloadTokens').createIndex({ orderId: 1 });

  await db.collection('stripeEvents').createIndex({ eventId: 1 }, { unique: true });

  await db.collection('auditLog').createIndex({ at: -1 });
  await db.collection('auditLog').createIndex({ targetType: 1, targetId: 1 });

  await db.collection('uploadJobs').createIndex({ status: 1 });
  await db.collection('uploadJobs').createIndex({ createdAt: -1 });

  // The unique index is the actual guard against two accounts sharing an address —
  // lib/users.ts normalizes email on write and treats a duplicate-key error as
  // EMAIL_TAKEN rather than checking-then-inserting.
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ role: 1, createdAt: -1 });

  // Sessions live in Mongo so they survive a stateless, multi-instance deployment
  // (src/lib/sessionDriver.ts). The TTL index is what stops abandoned sessions from
  // accumulating forever; the driver creates it too, this just makes it explicit here
  // alongside every other index.
  await ensureIndex(db, 'sessions', { expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Migration: photos used to carry their object keys under an `r2` field, from when
  // Cloudflare R2 was the only backend. The field is storage-agnostic now, so it's
  // named `storage`. Idempotent — the filter matches nothing once every document has
  // been renamed, so this is safe on every subsequent run.
  const renamed = await db
    .collection('photos')
    .updateMany({ r2: { $exists: true } }, { $rename: { r2: 'storage' } });
  if (renamed.modifiedCount > 0) {
    console.log(`migrated ${renamed.modifiedCount} photo(s): r2 → storage`);
  }

  console.log('Indexes ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
