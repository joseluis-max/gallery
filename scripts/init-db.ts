// Creates collections and indexes per the data model. Safe to re-run — createIndex is
// naturally idempotent, and createCollection failures for "already exists" are ignored.
import { getDb } from '../src/lib/db.ts';
import { FREE_DOWNLOAD_GRANT } from '../src/lib/users.ts';
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
  await ensureCollection(db, 'competitions');
  await ensureCollection(db, 'orders');
  await ensureCollection(db, 'downloadTokens');
  // `stripeEvents` is deliberately NOT created any more, and deliberately NOT dropped
  // either: this script is documented as safe to re-run and is additive apart from index
  // drops, so removing a collection that may hold data is a different class of action.
  // Drop it by hand once the Payphone switch is verified in production.
  await ensureCollection(db, 'payphoneTransactions');
  await ensureCollection(db, 'bankTransfers');
  await ensureCollection(db, 'settings');
  await ensureCollection(db, 'auditLog');
  await ensureCollection(db, 'uploadJobs');
  await ensureCollection(db, 'users');
  await ensureCollection(db, 'sessions');

  await db.collection('photos').createIndex({ slug: 1 }, { unique: true });
  await db.collection('photos').createIndex({ status: 1 });
  await db.collection('photos').createIndex({ tags: 1 });
  // Serves both the per-competition listing and the `{competitionId: null}` portfolio
  // listing from one index, and covers the `order` sort both of them use.
  await ensureIndex(db, 'photos', { status: 1, competitionId: 1, order: 1 });

  // Left behind by the collections → competitionId migration below. Dropped rather than
  // left in place: it indexes a field no document has any more, so it costs write time
  // and misleads anyone reading the index list. `.catch` because it's already gone on
  // every run after the first, and on a database that never had it.
  await db
    .collection('photos')
    .dropIndex('collections_1')
    .then(() => console.log('dropped obsolete index: photos.collections_1'))
    .catch(() => {});

  await db.collection('competitions').createIndex({ slug: 1 }, { unique: true });
  await db.collection('competitions').createIndex({ status: 1, date: -1 });

  // The old sparse-unique `orders.stripeSessionId` index is gone rather than renamed. Its
  // uniqueness constraint moved to payphoneTransactions.clientTransactionId below, where
  // it does not need to be sparse — see the comment there. `.catch` because it is already
  // gone on every run after the first, and on a database that never had it.
  await db
    .collection('orders')
    .dropIndex('stripeSessionId_1')
    .then(() => console.log('dropped obsolete index: orders.stripeSessionId_1'))
    .catch(() => {});

  await db.collection('orders').createIndex({ status: 1 });
  await db.collection('orders').createIndex({ 'customer.email': 1 });
  // Sparse: guest orders have no userId, and there are expected to be many of them.
  await db.collection('orders').createIndex({ userId: 1, createdAt: -1 }, { sparse: true });

  // THIS INDEX, not application code, is what makes claiming the same photograph twice
  // impossible. The action checks first for a friendly answer, but two simultaneous
  // requests can both pass that check — only a unique constraint can actually stop the
  // second insert, and the action catches its duplicate-key error and refunds the credit.
  //
  // partialFilterExpression scopes it to free claims, so a customer can still legitimately
  // buy the same photograph twice. Legal as a compound multikey index because only
  // `items.photoId` is an array, and a free-claim order always holds exactly one item.
  await ensureIndex(
    db,
    'orders',
    { userId: 1, 'items.photoId': 1 },
    { unique: true, partialFilterExpression: { kind: 'free-claim' } },
  );

  await db.collection('downloadTokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('downloadTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('downloadTokens').createIndex({ orderId: 1 });

  // Unique but NOT sparse, unlike the orders.stripeSessionId index this replaces. The
  // clientTransactionId is written by the same insertOne that creates the document, so the
  // "inserted before the id exists" window that forced `sparse: true` — and that made a
  // never-attached order block every later one — cannot occur here at all. The bug class is
  // designed out rather than carried forward.
  await ensureIndex(db, 'payphoneTransactions', { clientTransactionId: 1 }, { unique: true });
  await db.collection('payphoneTransactions').createIndex({ orderId: 1 });
  // The admin reconciliation view scans by age. No TTL anywhere on this collection: an
  // attempt with no recorded confirm is exactly what that view needs to see, and these
  // documents are payment evidence.
  await db.collection('payphoneTransactions').createIndex({ createdAt: -1 });

  // Bank transfers. `{status, submittedAt}` serves the admin queue, which is almost always
  // "in-review, newest first"; `{orderId, submittedAt}` serves the buyer's order page and
  // the per-order history on the admin order page.
  //
  // No TTL here either, and for the same reason as payphoneTransactions: these documents
  // are the evidence behind a payment somebody approved by hand, and the receipt they
  // point at outlives any question anyone is likely to ask about it.
  await ensureIndex(db, 'bankTransfers', { status: 1, submittedAt: -1 });
  await ensureIndex(db, 'bankTransfers', { orderId: 1, submittedAt: -1 });

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

  // Migration: `collections: string[]` (free text, no documents of its own) became
  // `competitionId: ObjectId | null` pointing at a real competitions document. Existing
  // photographs become portfolio work — they're José's landscape and wildlife shots, not
  // competition coverage — and an admin assigns any that belong to an event. Also drops
  // maxPrintCm, which only meant anything while physical prints were sold.
  //
  // Idempotent: the filter matches nothing once every document has been converted. Note
  // Mongo matches `{competitionId: null}` against a missing field too, so the queries
  // work correctly whether or not this has run yet.
  const converted = await db
    .collection('photos')
    .updateMany({ competitionId: { $exists: false } }, { $set: { competitionId: null }, $unset: { collections: '', maxPrintCm: '' } });
  if (converted.modifiedCount > 0) {
    console.log(`migrated ${converted.modifiedCount} photo(s): collections → competitionId (portfolio)`);
  }

  // Migration: accounts created before free downloads existed have no credit balance.
  // Idempotent — matches nothing once every account carries the field.
  const granted = await db
    .collection('users')
    .updateMany({ freeDownloadsRemaining: { $exists: false } }, { $set: { freeDownloadsRemaining: FREE_DOWNLOAD_GRANT } });
  if (granted.modifiedCount > 0) {
    console.log(`granted ${FREE_DOWNLOAD_GRANT} free download(s) to ${granted.modifiedCount} existing account(s)`);
  }

  // Migration: Stripe is gone. `stripePaymentIntentId` was the only Stripe field an order
  // still carried after payment, so it moves to the provider-neutral `payment.transactionId`;
  // `stripeSessionId` was per-attempt bookkeeping that payphoneTransactions now owns, so it
  // is dropped outright. $rename silently no-ops on a missing source field, which is what
  // lets both operations share one pass. Idempotent — matches nothing after the first run.
  //
  // Expected to touch zero documents: no real Stripe payment ever completed against this
  // database. Written anyway, because the alternative is finding out otherwise in
  // production, and six lines is cheaper than that.
  const depaid = await db
    .collection('orders')
    .updateMany(
      { $or: [{ stripePaymentIntentId: { $exists: true } }, { stripeSessionId: { $exists: true } }] },
      { $rename: { stripePaymentIntentId: 'payment.transactionId' }, $unset: { stripeSessionId: '' } },
    );
  if (depaid.modifiedCount > 0) {
    console.log(`migrated ${depaid.modifiedCount} order(s): stripe fields → payment`);
  }

  console.log('Indexes ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
