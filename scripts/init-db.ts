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

async function main() {
  const db = await getDb(getDbConfig());

  await ensureCollection(db, 'photos');
  await ensureCollection(db, 'orders');
  await ensureCollection(db, 'downloadTokens');
  await ensureCollection(db, 'stripeEvents');
  await ensureCollection(db, 'settings');
  await ensureCollection(db, 'auditLog');
  await ensureCollection(db, 'uploadJobs');

  await db.collection('photos').createIndex({ slug: 1 }, { unique: true });
  await db.collection('photos').createIndex({ status: 1 });
  await db.collection('photos').createIndex({ collections: 1 });
  await db.collection('photos').createIndex({ tags: 1 });

  await db.collection('orders').createIndex({ stripeSessionId: 1 }, { unique: true });
  await db.collection('orders').createIndex({ status: 1 });
  await db.collection('orders').createIndex({ 'customer.email': 1 });

  await db.collection('downloadTokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('downloadTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('downloadTokens').createIndex({ orderId: 1 });

  await db.collection('stripeEvents').createIndex({ eventId: 1 }, { unique: true });

  await db.collection('auditLog').createIndex({ at: -1 });
  await db.collection('auditLog').createIndex({ targetType: 1, targetId: 1 });

  await db.collection('uploadJobs').createIndex({ status: 1 });
  await db.collection('uploadJobs').createIndex({ createdAt: -1 });

  console.log('Indexes ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
