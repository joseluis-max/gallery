// The buyer's half of the bank-transfer flow: one action, which takes a comprobante and
// puts the order in front of a human.
//
// It is `accept: 'form'` rather than JSON because it carries a file, and it takes the
// bytes through the server rather than handing the browser a presigned PUT. That is the
// opposite of the admin upload path, deliberately: presigning would mean minting a
// bucket-write credential for an unauthenticated visitor, whereas a receipt is a few
// hundred kilobytes and the app can simply carry it. The size cap is what keeps that safe.
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'astro/zod';
import { ActionError, defineAction } from 'astro:actions';
import {
  countReceiptsForOrder,
  MAX_RECEIPTS_PER_ORDER,
  receiptStorageKey,
  submitTransfer,
  validateReceiptFile,
} from '../lib/bankTransfer';
import { createEmailer, createStorage, getDbConfig, getPublicSiteUrl } from '../lib/config';
import { getDb } from '../lib/db';
import { buildTransferReceivedEmail } from '../lib/orderEmail';
import { canViewOrder, getOrderById } from '../lib/orders';

/** The same shape `setOrderEmail` accepts. Kept as a plain regex rather than `z.email()`
 *  so a failure carries the error *code* the pages look up in the dictionary. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const transfer = {
  /**
   * Records a transfer receipt against a pending order.
   *
   * Nothing here decides that a payment happened — that is the admin's job, and it is the
   * reason this whole path can be open to guests without being a way to take photographs
   * for free. The worst an abusive caller achieves is putting a junk row in a queue a
   * person reads, bounded by `MAX_RECEIPTS_PER_ORDER` and by needing an unguessable
   * pending order id in the first place.
   */
  submitReceipt: defineAction({
    accept: 'form',
    input: z.object({
      orderId: z.string().min(1),
      lang: z.enum(['es', 'en']),
      /** Optional because a signed-in buyer already has one on the order. */
      email: z.string().optional(),
      reference: z.string().max(120).optional(),
      receipt: z.instanceof(File),
    }),
    handler: async (input, context) => {
      let orderId: InstanceType<typeof ObjectId>;
      try {
        orderId = new ObjectId(input.orderId);
      } catch {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'ORDER_NOT_FOUND' });
      }

      const db = await getDb(getDbConfig());
      const order = await getOrderById(db, orderId);
      if (!order) throw new ActionError({ code: 'NOT_FOUND', message: 'ORDER_NOT_FOUND' });

      // Same visibility rule as every other order surface. A guest order stays reachable
      // by anyone holding its id, exactly as the checkout page is — and paying for someone
      // else's order is not an attack.
      const viewer = await context.session?.get('user');
      if (!canViewOrder(order, viewer)) {
        throw new ActionError({ code: 'NOT_FOUND', message: 'ORDER_NOT_FOUND' });
      }
      // A paid order must never accept a receipt: the write below would otherwise be a way
      // to rewrite the customer email on a completed purchase.
      if (order.status !== 'pending') {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'ORDER_NOT_PENDING' });
      }

      const submittedEmail = input.email?.trim() ?? '';
      if (submittedEmail && !EMAIL_RE.test(submittedEmail)) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'INVALID_EMAIL' });
      }
      const email = submittedEmail || order.customer.email;
      if (!email) {
        // The approval happens hours later, out of band, so there is no version of this
        // flow where the buyer finds out by staying on the page. An address is mandatory.
        throw new ActionError({ code: 'BAD_REQUEST', message: 'EMAIL_REQUIRED' });
      }

      const rejection = validateReceiptFile(input.receipt);
      if (rejection) throw new ActionError({ code: 'BAD_REQUEST', message: rejection });

      if ((await countReceiptsForOrder(db, orderId)) >= MAX_RECEIPTS_PER_ORDER) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'TOO_MANY_RECEIPTS' });
      }

      const key = receiptStorageKey(orderId.toString(), randomUUID(), input.receipt.type);
      try {
        await createStorage().putObject({
          bucket: 'originals',
          key,
          body: Buffer.from(await input.receipt.arrayBuffer()),
          // The type the allowlist matched, not the one the browser claimed — those are
          // the same value here, but only because it was checked above.
          contentType: input.receipt.type,
        });
      } catch (err) {
        console.error('transfer.submitReceipt: could not store the receipt', orderId.toString(), err);
        throw new ActionError({ code: 'INTERNAL_SERVER_ERROR', message: 'UNKNOWN' });
      }

      // Written before the ledger row, so a failure here can never leave the queue holding
      // a review whose approval would email nobody.
      if (submittedEmail && submittedEmail !== order.customer.email) {
        await db
          .collection('orders')
          .updateOne({ _id: orderId, status: 'pending' }, { $set: { 'customer.email': submittedEmail, updatedAt: new Date() } });
      }

      await submitTransfer(db, {
        orderId,
        amountCents: order.totalCents,
        lang: input.lang,
        ...(input.reference?.trim() ? { reference: input.reference.trim() } : {}),
        receipt: {
          key,
          // Truncated because it is displayed in the admin panel and is buyer-controlled.
          // It is never used to build a path — see `receiptStorageKey`.
          filename: input.receipt.name.slice(0, 200),
          contentType: input.receipt.type,
          bytes: input.receipt.size,
        },
      });

      // Best effort, and last. The receipt is safely recorded and the page will confirm it;
      // a mail outage must not read to the buyer as a failed upload they should repeat.
      try {
        const siteUrl = getPublicSiteUrl();
        const message = buildTransferReceivedEmail({
          order,
          lang: input.lang,
          orderUrl: `${siteUrl}/${input.lang}/order/${orderId.toString()}`,
        });
        await createEmailer().send({ to: email, ...message });
      } catch (err) {
        console.error('transfer.submitReceipt: receipt recorded but the acknowledgement email did not send', orderId.toString(), err);
      }

      return { ok: true, orderUrl: `/${input.lang}/order/${orderId.toString()}` };
    },
  }),
};
