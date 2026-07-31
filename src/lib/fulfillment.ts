import type { Db, ObjectId } from 'mongodb';
import { sendEmail } from './email';
import type { OrderDoc } from './orders';

export interface ShipParams {
  carrier: string;
  tracking: string;
  notes?: string;
}

/**
 * Small provider interface so a Prodigi/Gelato print-on-demand adapter can drop in
 * later without touching order code — same dependency-injection shape as
 * `StorageAdapter`. For now there's exactly one implementation: José prints and ships
 * from Cuenca himself, and this just records that fact.
 */
export interface FulfillmentProvider {
  markShipped(db: Db, orderId: ObjectId, params: ShipParams): Promise<OrderDoc | null>;
}

export class ManualFulfillmentProvider implements FulfillmentProvider {
  async markShipped(db: Db, orderId: ObjectId, params: ShipParams): Promise<OrderDoc | null> {
    const now = new Date();
    const order = await db.collection<OrderDoc>('orders').findOneAndUpdate(
      { _id: orderId },
      {
        $set: {
          status: 'fulfilled',
          fulfillment: { status: 'shipped', carrier: params.carrier, tracking: params.tracking, notes: params.notes, shippedAt: now },
          updatedAt: now,
        },
        $push: { history: { status: 'fulfilled', at: now, actor: 'admin', note: `Shipped via ${params.carrier} (${params.tracking})` } },
      },
      { returnDocument: 'after' },
    );

    if (order?.customer.email) {
      await sendEmail({
        to: order.customer.email,
        subject: `Your order has shipped — #${order._id.toString()}`,
        text: `Carrier: ${params.carrier}\nTracking number: ${params.tracking}${params.notes ? `\n\n${params.notes}` : ''}`,
      });
    }

    return order;
  }
}
