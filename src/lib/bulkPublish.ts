/**
 * Client-side chunking for bulk publish.
 *
 * The `setPhotosPublished` action caps a single call at BULK_PUBLISH_CHUNK_SIZE ids so a
 * request body stays bounded. Rather than making that cap the admin's problem — "select
 * fewer photographs" is not a useful thing to tell someone who wants to publish a whole
 * shoot — the panel splits a large selection here and reports one combined result.
 *
 * The transport is injected so this file stays free of `astro:actions` and is testable
 * without a server: the caller passes whatever actually sends a chunk.
 */

/** Must not exceed the action's own `BULK_PUBLISH_LIMIT`. */
export const BULK_PUBLISH_CHUNK_SIZE = 500;

export interface BulkPublishOutcome {
  /** Ids sent across every chunk. */
  selected: number;
  /** How many photographs actually changed status — a re-publish over an already-published
   *  selection legitimately reports fewer changed than selected. */
  changed: number;
  /** Message from the first chunk that failed, if any. Chunks after a failure are not sent. */
  error?: string;
}

/** What one chunk's transport resolves to — the shape an Astro action returns. */
export interface ChunkResult {
  data?: { selected: number; changed: number };
  error?: { message: string };
}

export function chunk<T>(items: readonly T[], size = BULK_PUBLISH_CHUNK_SIZE): T[][] {
  if (size < 1) throw new RangeError('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Sends `ids` in chunks, sequentially, and sums the results.
 *
 * Sequential rather than `Promise.all`: these are writes against the same collection, and
 * a half-applied parallel batch whose failure order is arbitrary is much harder to reason
 * about afterwards than one that stopped at a known point. On failure it reports what had
 * already been applied instead of pretending nothing happened — the earlier chunks are
 * committed and saying otherwise would send someone looking for a rollback that does not
 * exist.
 */
export async function setPhotosPublishedInChunks(
  ids: readonly string[],
  send: (chunk: string[]) => Promise<ChunkResult>,
  size = BULK_PUBLISH_CHUNK_SIZE,
): Promise<BulkPublishOutcome> {
  const outcome: BulkPublishOutcome = { selected: 0, changed: 0 };

  for (const batch of chunk(ids, size)) {
    const result = await send(batch);
    if (result.error) {
      outcome.error = result.error.message;
      return outcome;
    }
    outcome.selected += result.data?.selected ?? batch.length;
    outcome.changed += result.data?.changed ?? 0;
  }

  return outcome;
}
