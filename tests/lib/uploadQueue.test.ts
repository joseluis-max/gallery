import { describe, expect, it } from 'vitest';
import { createSequentialQueue } from '../../src/lib/uploadQueue.ts';

/** Resolves after `ms`, so tasks genuinely interleave if the queue lets them. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createSequentialQueue', () => {
  it('runs tasks one at a time, never overlapping', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const done: number[] = [];

    const queue = createSequentialQueue<number>(async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Deliberately uneven, so a concurrent implementation would finish out of order.
      await sleep(n % 2 === 0 ? 1 : 5);
      done.push(n);
      inFlight -= 1;
    });

    for (let n = 0; n < 10; n += 1) queue.push(n);
    while (queue.isRunning) await sleep(1);

    expect(maxInFlight).toBe(1);
    expect(done).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('preserves push order regardless of how long each task takes', async () => {
    const done: string[] = [];
    const queue = createSequentialQueue<[string, number]>(async ([name, ms]) => {
      await sleep(ms);
      done.push(name);
    });

    // The slowest is pushed first: under any concurrency it would finish last.
    queue.push(['slow', 20]);
    queue.push(['medium', 10]);
    queue.push(['fast', 1]);
    while (queue.isRunning) await sleep(1);

    expect(done).toEqual(['slow', 'medium', 'fast']);
  });

  it('folds items pushed mid-run into the batch already running', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const done: string[] = [];

    const queue = createSequentialQueue<string>(async (name) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      done.push(name);
      inFlight -= 1;
      // A second drop while the first batch is still going — the regression that would
      // start a parallel worker.
      if (name === 'first') {
        queue.push('added-later');
        expect(queue.isRunning).toBe(true);
      }
    });

    queue.push('first');
    queue.push('second');
    while (queue.isRunning) await sleep(1);

    expect(maxInFlight).toBe(1);
    expect(done).toEqual(['first', 'second', 'added-later']);
  });

  it('carries on after a task rejects', async () => {
    const done: string[] = [];
    const queue = createSequentialQueue<string>(async (name) => {
      if (name === 'bad') throw new Error('boom');
      done.push(name);
    });

    queue.push('a');
    queue.push('bad');
    queue.push('b');
    while (queue.isRunning) await sleep(1);

    expect(done).toEqual(['a', 'b']);
  });

  it('reports what is still waiting, excluding the task in flight', async () => {
    const seen: number[] = [];
    const queue = createSequentialQueue<string>(async () => {
      seen.push(queue.pending.length);
      await sleep(1);
    });

    queue.push('a');
    queue.push('b');
    queue.push('c');
    expect(queue.isRunning).toBe(true);

    while (queue.isRunning) await sleep(1);

    // 0 first, not 2: `push` starts the worker synchronously, so 'a' is taken and
    // running before 'b' and 'c' have been pushed at all. That is the behaviour the
    // upload page wants — the first file starts moving on drop rather than waiting for
    // the whole batch to be enumerated — so it is asserted rather than worked around.
    // Then 'b' runs with only 'c' left, and 'c' with nothing.
    expect(seen).toEqual([0, 1, 0]);
    expect(queue.pending).toHaveLength(0);
  });

  it('restarts cleanly for a batch pushed after the queue went idle', async () => {
    const done: string[] = [];
    const queue = createSequentialQueue<string>(async (name) => {
      await sleep(1);
      done.push(name);
    });

    queue.push('first-batch');
    while (queue.isRunning) await sleep(1);
    expect(queue.isRunning).toBe(false);

    queue.push('second-batch');
    expect(queue.isRunning).toBe(true);
    while (queue.isRunning) await sleep(1);

    expect(done).toEqual(['first-batch', 'second-batch']);
  });
});
