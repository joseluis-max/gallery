// What happens the moment an order becomes paid: the order flips, one download token is
// minted per item, and the links are emailed.
//
// This lived inside api/payphone-confirm.ts until a second payment method needed it. A
// bank transfer approved in the admin panel has to deliver *exactly* what a card payment
// delivers — same tokens, same TTL, same receipt — and the way to guarantee that is for
// there to be one implementation, in the same spirit as lib/images.ts being the single
// pipeline behind both the CLI ingest and the admin upload.
//
// Nothing here reads the environment. Callers pass the emailer, the site URL and the token
// policy in, which keeps this testable without an Astro runtime and keeps src/lib/config.ts
// the one place that turns variables into configured objects.
import type { Db } from 'mongodb';
import { mintDownloadToken } from './downloads';
import type { EmailProvider } from './email';
import type { Locale } from './i18n';
import { buildOrderEmail, type OrderEmailLink } from './orderEmail';
import { markOrderPaid, type OrderDoc, type OrderPayment } from './orders';

export interface FulfilOrderParams {
  order: OrderDoc;
  /** Who is claiming the money arrived — `payphone-confirm`, or `admin:<email>` for a
   *  reviewed bank transfer. Recorded on the order's history entry, never defaulted. */
  actor: string;
  payment: OrderPayment;
  /** Overwrites the address on the order when the payment carried a better one. Only the
   *  Payphone path has this; a transfer's address is whatever the buyer already gave. */
  customer?: { email: string; name?: string };
  lang: Locale;
  siteUrl: string;
  ttlDays: number;
  maxUses: number;
  emailer: EmailProvider;
}

export interface FulfilOrderResult {
  /** The paid order, or null when it was already paid before this call — which is not an
   *  error and not a no-op worth retrying. `markOrderPaid` is atomic on `status:
   *  'pending'`, so a null here means someone else won the race and has already minted the
   *  tokens and sent the mail; minting a second set is the failure this prevents. */
  paid: OrderDoc | null;
  emailed: boolean;
}

export async function fulfilOrder(db: Db, params: FulfilOrderParams): Promise<FulfilOrderResult> {
  const paid = await markOrderPaid(db, {
    orderId: params.order._id,
    actor: params.actor,
    payment: params.payment,
    ...(params.customer ? { customer: params.customer } : {}),
  });

  if (!paid) return { paid: null, emailed: false };

  const links: OrderEmailLink[] = [];
  for (const item of paid.items) {
    const token = await mintDownloadToken(db, {
      orderId: paid._id,
      photoId: item.photoId,
      ttlDays: params.ttlDays,
      maxUses: params.maxUses,
    });
    // Absolute, because a bare `/api/download/<token>` is not something an inbox can follow.
    links.push({ title: item.photoTitle, url: `${params.siteUrl}/api/download/${token}` });
  }

  const email = paid.customer.email;
  if (!email) {
    // Both payment paths collect an address before they can complete, so this should be
    // unreachable — but the purchase is still complete and still collectable from the
    // order page, so it earns a log line rather than a thrown error.
    console.error('fulfilOrder: order paid with no email address to send the links to', paid._id.toString());
    return { paid, emailed: false };
  }

  const message = buildOrderEmail({
    order: paid,
    lang: params.lang,
    links,
    orderUrl: `${params.siteUrl}/${params.lang}/order/${paid._id.toString()}`,
    ttlDays: params.ttlDays,
    maxUses: params.maxUses,
  });

  // Deliberately last, and deliberately swallowing its own failure. By this point the money
  // is accounted for, the order says paid, and the tokens exist — so every file is already
  // collectable from the order page, which shows its own download links. Letting a mail
  // outage bubble up would file it under "fulfilment failed" beside a Mongo write error,
  // and those two want very different responses from whoever reads the log.
  try {
    await params.emailer.send({ to: email, ...message });
    return { paid, emailed: true };
  } catch (err) {
    console.error('fulfilOrder: order fulfilled but the confirmation email did not send', paid._id.toString(), err);
    return { paid, emailed: false };
  }
}
