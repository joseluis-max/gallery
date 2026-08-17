import { describe, expect, it } from 'vitest';
import { bucketSum, dayBuckets, monthBuckets } from '../../src/lib/analytics.ts';

describe('monthBuckets', () => {
  it('returns the last N calendar months, oldest first, ending with the current one', () => {
    const buckets = monthBuckets(new Date(2026, 7, 12), 3);
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Jun', 'Jul', 'Aug']);
  });

  it('crosses a year boundary correctly', () => {
    const buckets = monthBuckets(new Date(2026, 0, 5), 3);
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('spans each month exactly from its first instant to the next month’s', () => {
    const [june] = monthBuckets(new Date(2026, 7, 12), 3);
    expect(june.start).toEqual(new Date(2026, 5, 1));
    expect(june.end).toEqual(new Date(2026, 6, 1));
  });
});

describe('dayBuckets', () => {
  it('returns the last N days ending today, oldest first', () => {
    const buckets = dayBuckets(new Date(2026, 7, 3, 23, 30), 3);
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('walks back across a month boundary', () => {
    const buckets = dayBuckets(new Date(2026, 7, 1), 2);
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-07-31', '2026-08-01']);
  });
});

describe('bucketSum', () => {
  const buckets = monthBuckets(new Date(2026, 7, 15), 3);

  it('sums values into their month and reports empty months as zero', () => {
    const rows = [
      { createdAt: new Date(2026, 5, 10), totalCents: 1000 },
      { createdAt: new Date(2026, 5, 20), totalCents: 500 },
      { createdAt: new Date(2026, 7, 1), totalCents: 250 },
    ];
    expect(bucketSum(rows, buckets, (row) => row.totalCents).map((point) => point.value)).toEqual([1500, 0, 250]);
  });

  it('counts rows when the value function returns 1', () => {
    const rows = [{ createdAt: new Date(2026, 6, 2) }, { createdAt: new Date(2026, 6, 3) }];
    expect(bucketSum(rows, buckets, () => 1).map((point) => point.value)).toEqual([0, 2, 0]);
  });

  it('treats bucket boundaries as half-open, so a midnight order lands in exactly one bucket', () => {
    const boundary = { createdAt: new Date(2026, 7, 1, 0, 0, 0), totalCents: 100 };
    const totals = bucketSum([boundary], buckets, (row) => row.totalCents).map((point) => point.value);
    expect(totals).toEqual([0, 0, 100]);
    expect(totals.filter((value) => value > 0)).toHaveLength(1);
  });

  it('ignores rows outside the window entirely', () => {
    const rows = [{ createdAt: new Date(2025, 0, 1), totalCents: 9999 }];
    expect(bucketSum(rows, buckets, (row) => row.totalCents).map((point) => point.value)).toEqual([0, 0, 0]);
  });

  it('accepts a serialized date string, since Mongo documents round-trip as strings in some paths', () => {
    const rows = [{ createdAt: new Date(2026, 6, 4).toISOString() as unknown as Date, totalCents: 700 }];
    expect(bucketSum(rows, buckets, (row) => row.totalCents).map((point) => point.value)).toEqual([0, 700, 0]);
  });
});
