import { describe, expect, it } from 'vitest';
import { chunk, setPhotosPublishedInChunks, type ChunkResult } from '../../src/lib/bulkPublish.ts';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

/** Stands in for the action: succeeds, reporting every id as changed. */
const ok = async (batch: string[]): Promise<ChunkResult> => ({
  data: { selected: batch.length, changed: batch.length },
});

describe('chunk', () => {
  it('splits into batches of at most `size`, keeping order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single batch when everything fits', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('rejects a size that would loop forever', () => {
    expect(() => chunk([1, 2], 0)).toThrow(RangeError);
  });
});

describe('setPhotosPublishedInChunks', () => {
  it('sends one call when the selection fits in a chunk', async () => {
    const calls: string[][] = [];
    const result = await setPhotosPublishedInChunks(ids(3), async (batch) => {
      calls.push(batch);
      return ok(batch);
    }, 500);

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ selected: 3, changed: 3 });
  });

  it('splits a selection larger than the action accepts and sums the results', async () => {
    const calls: string[][] = [];
    const result = await setPhotosPublishedInChunks(ids(1200), async (batch) => {
      calls.push(batch);
      return ok(batch);
    }, 500);

    expect(calls.map((c) => c.length)).toEqual([500, 500, 200]);
    expect(result).toEqual({ selected: 1200, changed: 1200 });
  });

  it('sends chunks one after another, never concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await setPhotosPublishedInChunks(ids(30), async (batch) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return ok(batch);
    }, 10);

    expect(maxInFlight).toBe(1);
  });

  it('reports fewer changed than selected when some were already in the target state', async () => {
    const result = await setPhotosPublishedInChunks(ids(10), async (batch) => ({
      // Half of them were already published.
      data: { selected: batch.length, changed: batch.length / 2 },
    }), 10);

    expect(result).toEqual({ selected: 10, changed: 5 });
  });

  it('stops at the first failing chunk and reports what had already been applied', async () => {
    const calls: string[][] = [];
    const result = await setPhotosPublishedInChunks(ids(30), async (batch) => {
      calls.push(batch);
      if (calls.length === 2) return { error: { message: 'BOOM' } };
      return ok(batch);
    }, 10);

    // Third chunk never sent.
    expect(calls).toHaveLength(2);
    // The first chunk is committed server-side, so the outcome says so rather than
    // reporting zero and implying a rollback that never happened.
    expect(result).toEqual({ selected: 10, changed: 10, error: 'BOOM' });
  });

  it('does nothing for an empty selection', async () => {
    let called = false;
    const result = await setPhotosPublishedInChunks([], async (batch) => {
      called = true;
      return ok(batch);
    });

    expect(called).toBe(false);
    expect(result).toEqual({ selected: 0, changed: 0 });
  });
});
