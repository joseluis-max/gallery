import type { APIRoute } from 'astro';
import type { Filter } from 'mongodb';
import { getDbConfig } from '../../../lib/config';
import { getDb } from '../../../lib/db';
import type { OrderDoc, OrderStatus } from '../../../lib/orders';

export const prerender = false;

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// This route lives under /admin/, so it's covered by the same middleware session guard
// as every other admin page — no separate auth check needed here.
export const GET: APIRoute = async ({ url }) => {
  const db = await getDb(getDbConfig());
  const status = url.searchParams.get('status');
  const query: Filter<OrderDoc> = status ? { status: status as OrderStatus } : {};
  const orders = await db.collection<OrderDoc>('orders').find(query).sort({ createdAt: -1 }).toArray();

  const header = ['Order ID', 'Date', 'Customer Email', 'Status', 'Items', 'Subtotal', 'Total'];
  const rows = orders.map((order) =>
    [
      order._id.toString(),
      new Date(order.createdAt).toISOString(),
      order.customer.email,
      order.status,
      String(order.items.length),
      (order.subtotalCents / 100).toFixed(2),
      (order.totalCents / 100).toFixed(2),
    ].map(csvEscape),
  );

  const csv = [header, ...rows].map((row) => row.join(',')).join('\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
