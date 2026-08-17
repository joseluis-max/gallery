import { afterEach, describe, expect, it, vi } from 'vitest';

const connectMock = vi.fn();

vi.mock('mongodb', () => ({
  MongoClient: class {
    connect = connectMock;
  },
}));

const { getDb } = await import('../../src/lib/db.ts');

const config = { uri: 'mongodb://example.test:27017', dbName: 'gallery' };

afterEach(() => {
  connectMock.mockReset();
  (globalThis as { __mongoClientPromise?: unknown }).__mongoClientPromise = undefined;
});

describe('getDb connection caching', () => {
  it('connects once and reuses the client across calls', async () => {
    const db = { name: 'gallery' };
    connectMock.mockResolvedValue({ db: () => db });

    await getDb(config);
    await getDb(config);
    await getDb(config);

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed connection — the next call retries instead of replaying the error', async () => {
    // The production failure this guards against: a process that starts while the
    // database is unreachable (a firewall rule not yet applied, an outage) cached the
    // rejected promise and served that identical error for the rest of its life, never
    // recovering once the database came back.
    connectMock.mockRejectedValueOnce(new Error('MongoServerSelectionError: unreachable'));
    await expect(getDb(config)).rejects.toThrow('unreachable');

    const db = { name: 'gallery' };
    connectMock.mockResolvedValue({ db: () => db });
    await expect(getDb(config)).resolves.toBe(db);

    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('recovers even after several consecutive failures', async () => {
    connectMock
      .mockRejectedValueOnce(new Error('down 1'))
      .mockRejectedValueOnce(new Error('down 2'))
      .mockResolvedValue({ db: () => ({ name: 'gallery' }) });

    await expect(getDb(config)).rejects.toThrow('down 1');
    await expect(getDb(config)).rejects.toThrow('down 2');
    await expect(getDb(config)).resolves.toEqual({ name: 'gallery' });
  });
});
