import { MongoClient, type Collection } from 'mongodb';

/**
 * Session storage backed by MongoDB.
 *
 * `@astrojs/node` defaults to a **filesystem** session store, which is wrong the moment
 * this runs anywhere stateless: on Cloud Run the container's disk is ephemeral and
 * requests are spread across instances, so a filesystem session means a visitor is
 * randomly signed out and their cart randomly empty depending on which instance answers.
 * Mongo is already a dependency and is shared by every instance, so it's the natural
 * store — no Redis to run for a shop this size.
 *
 * This is a driver *entrypoint* rather than an inline `sessionDrivers.mongodb({...})`
 * call in astro.config.mjs, because inline driver options are **inlined at build time**
 * — which would bake the database URI into the built bundle and force the build to know
 * a production secret. Everything here reads `process.env` when the factory runs, at
 * runtime, so the same image works against any database.
 */

interface SessionDoc {
  _id: string;
  value: unknown;
  /** Indexed with `expireAfterSeconds: 0`, so Mongo deletes abandoned sessions itself
   *  rather than letting the collection grow forever. */
  expiresAt: Date;
}

declare global {
  // eslint-disable-next-line no-var
  var __sessionClientPromise: Promise<MongoClient> | undefined;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getClient(uri: string): Promise<MongoClient> {
  // Same globalThis-cached pattern as lib/db.ts, and for the same reason: Vite
  // re-executes modules on edit in dev, and a per-module client would leak connections.
  if (!globalThis.__sessionClientPromise) {
    // Failure clears the cache — see the long note in lib/db.ts. A cached *rejected*
    // promise here would mean every visitor's session is permanently broken on an
    // instance that happened to boot during a database blip.
    globalThis.__sessionClientPromise = new MongoClient(uri, { maxPoolSize: 5 })
      .connect()
      .catch((err) => {
        globalThis.__sessionClientPromise = undefined;
        throw err;
      });
  }
  return globalThis.__sessionClientPromise;
}

export interface SessionDriverOptions {
  collectionName?: string;
  ttlSeconds?: number;
}

export default function createSessionDriver(options: SessionDriverOptions | undefined) {
  const collectionName = options?.collectionName ?? 'sessions';
  const ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  let indexEnsured: Promise<unknown> | undefined;

  async function sessions(): Promise<Collection<SessionDoc>> {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is required for session storage.');

    const client = await getClient(uri);
    const collection = client.db(process.env.MONGODB_DB_NAME || 'valdiviezo').collection<SessionDoc>(collectionName);

    // Created once per process, not per request, and never awaited on the hot path more
    // than the first time — `createIndex` is idempotent, but issuing it on every read
    // would be a pointless round trip.
    indexEnsured ??= collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch((err) => {
      console.error('session TTL index could not be ensured', err);
    });
    await indexEnsured;

    return collection;
  }

  return {
    async getItem(key: string): Promise<unknown> {
      const collection = await sessions();
      const doc = await collection.findOne({ _id: key });
      if (!doc) return undefined;
      // Mongo's TTL monitor only sweeps every ~60s, so an expired-but-not-yet-deleted
      // document must not be handed back as a live session.
      if (doc.expiresAt.getTime() <= Date.now()) return undefined;
      return doc.value;
    },

    async setItem(key: string, value: unknown): Promise<void> {
      const collection = await sessions();
      await collection.updateOne(
        { _id: key },
        { $set: { value, expiresAt: new Date(Date.now() + ttlSeconds * 1000) } },
        { upsert: true },
      );
    },

    async removeItem(key: string): Promise<void> {
      const collection = await sessions();
      await collection.deleteOne({ _id: key });
    },
  };
}
