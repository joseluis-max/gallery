import { MongoClient, type Db } from 'mongodb';

export interface DbConfig {
  uri: string;
  dbName: string;
}

// `globalThis`-guarded (not just a module-level `const`) so the cached client survives
// Vite's dev-server module re-execution on file edits — a plain module-level singleton
// would reconnect on every hot-reload and eventually exhaust the Atlas connection pool.
declare global {
  // eslint-disable-next-line no-var
  var __mongoClientPromise: Promise<MongoClient> | undefined;
}

export function getDb(config: DbConfig): Promise<Db> {
  if (!globalThis.__mongoClientPromise) {
    const client = new MongoClient(config.uri, { maxPoolSize: 10 });
    // Caching the promise is the point — but caching a *rejected* one is a trap. A
    // process that starts during a database outage (or before a firewall rule lands)
    // would otherwise replay that first failure for its entire life: every later request
    // gets the identical cached error and never retries, so the instance is permanently
    // broken even after the database comes back. Dropping the cache on failure means the
    // next request opens a fresh connection.
    //
    // This is not hypothetical: it is exactly what happened on the first Cloud Run
    // deploy, where the container booted while Atlas was still refusing its IP and then
    // served the same MongoServerSelectionError forever.
    globalThis.__mongoClientPromise = client.connect().catch((err) => {
      globalThis.__mongoClientPromise = undefined;
      throw err;
    });
  }
  return globalThis.__mongoClientPromise.then((client) => client.db(config.dbName));
}
