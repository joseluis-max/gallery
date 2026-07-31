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
    globalThis.__mongoClientPromise = client.connect();
  }
  return globalThis.__mongoClientPromise.then((client) => client.db(config.dbName));
}
