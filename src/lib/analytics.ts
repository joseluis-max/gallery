import type { Db, ObjectId } from 'mongodb';

/**
 * Read-only reporting queries behind the admin dashboard and analytics page.
 *
 * Two conventions, both deliberate:
 *
 * 1. **"Revenue" means `paid` orders that are actual purchases.** A `pending` order is a
 *    Stripe Checkout Session someone may never complete; counting it would inflate
 *    every number on the dashboard. `cancelled`/`refunded` are excluded for the
 *    obvious reason. Free-credit claims are also real `paid` orders (see OrderKind), so
 *    every revenue query additionally excludes `kind: 'free-claim'` — otherwise a $0
 *    claim would drag average order value toward zero and inflate the order count.
 *    Written as `$ne` rather than `$eq: 'purchase'` so documents written before `kind`
 *    existed still count.
 * 2. **Time bucketing happens in JS, not in a `$dateToString` stage.** Month and day
 *    boundaries follow the server's local timezone (the same convention the rest of
 *    the panel's date rendering uses), which a Mongo aggregation would silently
 *    reinterpret as UTC — a 5-hour shift in Ecuador, enough to move an evening order
 *    into the wrong day. The bucketing functions are pure and unit-tested, and the
 *    query side stays a lean projection over one window of orders.
 */

export const REVENUE_STATUSES = ['paid'] as const;

/** Spread into every revenue aggregation's `$match`. Keeps the two conditions that define
 *  "a sale" in one place so a new report can't accidentally count free claims. */
export const REVENUE_MATCH = {
  status: { $in: [...REVENUE_STATUSES] },
  kind: { $ne: 'free-claim' },
} as const;

export interface Bucket {
  key: string;
  label: string;
  start: Date;
  end: Date;
}

export interface SeriesPoint {
  key: string;
  label: string;
  value: number;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dayKey(date: Date): string {
  return `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The last `count` calendar months, oldest first, ending with the one containing
 *  `now`. Gaps are part of the point: a month with no sales must still appear on the
 *  axis, or the chart quietly redraws history as if it never happened. */
export function monthBuckets(now: Date, count: number): Bucket[] {
  const buckets: Bucket[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1);
    buckets.push({ key: monthKey(start), label: MONTH_LABELS[start.getMonth()], start, end });
  }
  return buckets;
}

/** The last `count` days, oldest first, ending with the day containing `now`. */
export function dayBuckets(now: Date, count: number): Bucket[] {
  const buckets: Bucket[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset + 1);
    buckets.push({ key: dayKey(start), label: `${start.getDate()}`, start, end });
  }
  return buckets;
}

export interface Timestamped {
  createdAt: Date;
}

/** Sums `valueOf` over the items falling in each bucket. O(items × buckets) — fine for
 *  the ≤ 366 buckets and single-window queries this file issues, and far easier to
 *  verify than an index-arithmetic version. */
export function bucketSum<T extends Timestamped>(items: T[], buckets: Bucket[], valueOf: (item: T) => number): SeriesPoint[] {
  return buckets.map((bucket) => {
    let total = 0;
    for (const item of items) {
      const at = new Date(item.createdAt).getTime();
      if (at >= bucket.start.getTime() && at < bucket.end.getTime()) total += valueOf(item);
    }
    return { key: bucket.key, label: bucket.label, value: total };
  });
}

/** Just the fields these reports read — narrower than `OrderDoc` on purpose, so the
 *  projection and the type say the same thing. */
interface OrderWindowRow {
  createdAt: Date;
  totalCents: number;
  status: string;
}

async function ordersSince(db: Db, since: Date): Promise<OrderWindowRow[]> {
  return db
    .collection<OrderWindowRow>('orders')
    .find({ ...REVENUE_MATCH, createdAt: { $gte: since } }, { projection: { createdAt: 1, totalCents: 1 } })
    .toArray();
}

export interface RevenueSeries {
  revenue: SeriesPoint[];
  orders: SeriesPoint[];
}

export async function getMonthlyRevenue(db: Db, months: number, now = new Date()): Promise<RevenueSeries> {
  const buckets = monthBuckets(now, months);
  const rows = await ordersSince(db, buckets[0].start);
  return {
    revenue: bucketSum(rows, buckets, (row) => row.totalCents),
    orders: bucketSum(rows, buckets, () => 1),
  };
}

export async function getDailyRevenue(db: Db, days: number, now = new Date()): Promise<RevenueSeries> {
  const buckets = dayBuckets(now, days);
  const rows = await ordersSince(db, buckets[0].start);
  return {
    revenue: bucketSum(rows, buckets, (row) => row.totalCents),
    orders: bucketSum(rows, buckets, () => 1),
  };
}

export async function getNewCustomersByMonth(db: Db, months: number, now = new Date()): Promise<SeriesPoint[]> {
  const buckets = monthBuckets(now, months);
  const rows = await db
    .collection<Timestamped & { role: string }>('users')
    .find({ role: 'customer', createdAt: { $gte: buckets[0].start } }, { projection: { createdAt: 1 } })
    .toArray();
  return bucketSum(rows, buckets, () => 1);
}

export async function getStatusCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db.collection('orders').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
  return Object.fromEntries(rows.map((row) => [row._id as string, row.count as number]));
}

/** Total downloads sold. One line item is one download — there is no quantity to sum. */
export async function getDownloadsSold(db: Db): Promise<number> {
  const rows = await db
    .collection('orders')
    .aggregate([{ $match: REVENUE_MATCH }, { $unwind: '$items' }, { $count: 'units' }])
    .toArray();
  return (rows[0]?.units as number | undefined) ?? 0;
}

export interface TopPhotoRow {
  slug: string;
  title: string;
  units: number;
  revenueCents: number;
}

export async function getTopPhotos(db: Db, limit = 8): Promise<TopPhotoRow[]> {
  const rows = await db
    .collection('orders')
    .aggregate([
      { $match: REVENUE_MATCH },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.photoSlug',
          title: { $first: '$items.photoTitle' },
          units: { $sum: 1 },
          revenueCents: { $sum: '$items.totalCents' },
        },
      },
      { $sort: { units: -1 } },
      { $limit: limit },
    ])
    .toArray();

  return rows.map((row) => ({
    slug: row._id as string,
    title: (row.title as string) ?? (row._id as string),
    units: row.units as number,
    revenueCents: row.revenueCents as number,
  }));
}


export interface DashboardKpis {
  revenueThisMonthCents: number;
  revenueLastMonthCents: number;
  ordersThisMonth: number;
  averageOrderCents: number;
  paidOrders: number;
  failedUploads: number;
  customerCount: number;
  registeredBuyers: number;
  publishedPhotos: number;
  draftPhotos: number;
}

export async function getDashboardKpis(db: Db, now = new Date()): Promise<DashboardKpis> {
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [thisMonthRows, lastMonthRows, lifetime, failedUploads, customerCount, registeredBuyers, publishedPhotos, draftPhotos] =
    await Promise.all([
      ordersSince(db, startOfThisMonth),
      db
        .collection<OrderWindowRow>('orders')
        .find({ ...REVENUE_MATCH, createdAt: { $gte: startOfLastMonth, $lt: startOfThisMonth } }, { projection: { totalCents: 1 } })
        .toArray(),
      db
        .collection('orders')
        .aggregate([{ $match: REVENUE_MATCH }, { $group: { _id: null, total: { $sum: '$totalCents' }, count: { $sum: 1 } } }])
        .toArray(),
      db.collection('uploadJobs').countDocuments({ status: 'failed' }),
      db.collection('users').countDocuments({ role: 'customer' }),
      db.collection('orders').distinct('userId', REVENUE_MATCH),
      db.collection('photos').countDocuments({ status: 'published' }),
      db.collection('photos').countDocuments({ status: 'draft' }),
    ]);

  const lifetimeTotal = (lifetime[0]?.total as number) ?? 0;
  const lifetimeCount = (lifetime[0]?.count as number) ?? 0;

  return {
    revenueThisMonthCents: thisMonthRows.reduce((sum, row) => sum + row.totalCents, 0),
    revenueLastMonthCents: lastMonthRows.reduce((sum, row) => sum + row.totalCents, 0),
    ordersThisMonth: thisMonthRows.length,
    averageOrderCents: lifetimeCount > 0 ? Math.round(lifetimeTotal / lifetimeCount) : 0,
    paidOrders: lifetimeCount,
    failedUploads,
    customerCount,
    // `distinct` skips documents with no `userId`, so guest orders correctly don't
    // count toward "buyers with an account".
    registeredBuyers: registeredBuyers.filter(Boolean).length,
    publishedPhotos,
    draftPhotos,
  };
}

export interface CustomerStats {
  userId: string;
  orders: number;
  revenueCents: number;
  lastOrderAt: Date | null;
}

/** Order totals per account, for the customers table. Returned as a Map so the caller
 *  can join it against a page of users without an N+1 query per row. */
export async function getCustomerStats(db: Db, userIds?: ObjectId[]): Promise<Map<string, CustomerStats>> {
  const match: Record<string, unknown> = { ...REVENUE_MATCH, userId: { $exists: true } };
  if (userIds) match.userId = { $in: userIds };

  const rows = await db
    .collection('orders')
    .aggregate([
      { $match: match },
      { $group: { _id: '$userId', orders: { $sum: 1 }, revenueCents: { $sum: '$totalCents' }, lastOrderAt: { $max: '$createdAt' } } },
    ])
    .toArray();

  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        userId: String(row._id),
        orders: row.orders as number,
        revenueCents: row.revenueCents as number,
        lastOrderAt: (row.lastOrderAt as Date) ?? null,
      },
    ]),
  );
}
