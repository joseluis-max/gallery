import type { EmailMessage } from './email';
import { getDictionary, type Locale } from './i18n';
import type { OrderDoc } from './orders';

/** One purchased item and the tokenised URL that hands over its original file. The URL is
 *  absolute: a relative path is not clickable from an inbox, which is why the links this
 *  replaces (`/api/download/<token>`) were unusable even before delivery was fixed. */
export interface OrderEmailLink {
  title: string;
  url: string;
}

export interface OrderEmailParams {
  order: Pick<OrderDoc, '_id' | 'items' | 'totalCents'>;
  lang: Locale;
  links: OrderEmailLink[];
  /** Absolute URL of the buyer's order page — the durable way back to the downloads once
   *  the emailed tokens have expired, since that page re-issues them on demand. */
  orderUrl: string;
  ttlDays: number;
  maxUses: number;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Titles are photographer-supplied and the URLs carry base64url tokens, so both are
 *  escaped rather than trusted — an unescaped `&` alone is enough to break a download link
 *  in an HTML mail client. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/**
 * Renders the order-confirmation email in the buyer's own locale.
 *
 * Both parts are built from the same data on purpose. The HTML part is what makes a
 * download link a thing you can click, and the text part is what survives a client that
 * strips HTML — for a store whose entire deliverable is a link, losing either one loses
 * the purchase.
 */
export function buildOrderEmail(params: OrderEmailParams): Omit<EmailMessage, 'to'> {
  const t = getDictionary(params.lang).email;
  /** The short form the order page and the admin panel both display, so a buyer comparing
   *  the email against the page sees the same number. The full id lives in `orderUrl`. */
  const orderNumber = params.order._id.toString().slice(-8);
  const validity = fill(t.validity, { days: params.ttlDays, uses: params.maxUses });

  const textLines = [
    fill(t.subject, { order: orderNumber }),
    '',
    t.intro,
    '',
    ...params.order.items.map((item) => `- ${item.photoTitle} — ${money(item.totalCents)}`),
    '',
    `${t.total}: ${money(params.order.totalCents)}`,
  ];

  if (params.links.length > 0) {
    textLines.push('', `${t.downloadsTitle}:`, '');
    for (const link of params.links) {
      textLines.push(`${link.title}: ${link.url}`);
    }
    textLines.push('', validity);
  }

  textLines.push('', `${t.viewOrder}: ${params.orderUrl}`, '', t.footer);

  const itemRows = params.order.items
    .map(
      (item) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e2dc;">${escapeHtml(item.photoTitle)}</td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #e5e2dc;text-align:right;">${money(item.totalCents)}</td></tr>`,
    )
    .join('');

  const linkRows = params.links
    .map(
      (link) =>
        `<tr><td style="padding:8px 0;">${escapeHtml(link.title)}</td>` +
        `<td style="padding:8px 0;text-align:right;">` +
        `<a href="${escapeHtml(link.url)}" style="color:#b4401f;">${escapeHtml(t.download)}</a></td></tr>`,
    )
    .join('');

  // Inline styles and a table layout, not a stylesheet: mail clients strip <style> blocks
  // and have no flexbox. Kept deliberately plain — no images, no web fonts, nothing that
  // needs to load — so the links render even in a client with remote content blocked.
  const html = `<div style="font-family:Georgia,serif;color:#2b2724;max-width:560px;margin:0 auto;padding:24px;">
<h1 style="font-size:20px;font-weight:normal;">${escapeHtml(fill(t.subject, { order: orderNumber }))}</h1>
<p style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">${escapeHtml(t.intro)}</p>
<table style="width:100%;border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px;">${itemRows}
<tr><td style="padding:12px 0;font-weight:bold;">${escapeHtml(t.total)}</td>
<td style="padding:12px 0;text-align:right;font-weight:bold;">${money(params.order.totalCents)}</td></tr></table>
${
  params.links.length > 0
    ? `<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.1em;font-weight:normal;color:#6f6862;margin-top:32px;">${escapeHtml(t.downloadsTitle)}</h2>
<table style="width:100%;border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px;">${linkRows}</table>
<p style="font-family:system-ui,sans-serif;font-size:12px;color:#6f6862;line-height:1.5;">${escapeHtml(validity)}</p>`
    : ''
}
<p style="font-family:system-ui,sans-serif;font-size:14px;margin-top:32px;">
<a href="${escapeHtml(params.orderUrl)}" style="color:#b4401f;">${escapeHtml(t.viewOrder)}</a></p>
<p style="font-family:system-ui,sans-serif;font-size:12px;color:#6f6862;">${escapeHtml(t.footer)}</p>
</div>`;

  return {
    subject: fill(t.subject, { order: orderNumber }),
    text: textLines.join('\n'),
    html,
  };
}

export interface TransferEmailParams {
  order: Pick<OrderDoc, '_id' | 'totalCents'>;
  lang: Locale;
  orderUrl: string;
}

/**
 * The plain sibling of `buildOrderEmail`: a subject, some paragraphs and the link back to
 * the order. Both transfer notices are this shape, and neither carries download links —
 * that is precisely what distinguishes them from the receipt.
 *
 * Same table-free inline styling and same both-parts rule as above, for the same reasons.
 */
function buildNoticeEmail(params: {
  lang: Locale;
  subject: string;
  paragraphs: string[];
  orderUrl: string;
}): Omit<EmailMessage, 'to'> {
  const t = getDictionary(params.lang).email;

  const text = [params.subject, '', ...params.paragraphs, '', `${t.viewOrder}: ${params.orderUrl}`, '', t.footer].join('\n');

  const html = `<div style="font-family:Georgia,serif;color:#2b2724;max-width:560px;margin:0 auto;padding:24px;">
<h1 style="font-size:20px;font-weight:normal;">${escapeHtml(params.subject)}</h1>
${params.paragraphs
  .map((paragraph) => `<p style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">${escapeHtml(paragraph)}</p>`)
  .join('\n')}
<p style="font-family:system-ui,sans-serif;font-size:14px;margin-top:32px;">
<a href="${escapeHtml(params.orderUrl)}" style="color:#b4401f;">${escapeHtml(t.viewOrder)}</a></p>
<p style="font-family:system-ui,sans-serif;font-size:12px;color:#6f6862;">${escapeHtml(t.footer)}</p>
</div>`;

  return { subject: params.subject, text, html };
}

/**
 * Sent the moment a comprobante is uploaded.
 *
 * A card payment resolves in seconds and the buyer never leaves the tab; a transfer waits
 * on a person, possibly overnight. For a *guest* — who has no account and whose only
 * durable route back is the order URL — this email is the difference between "waiting" and
 * "lost", which is why it exists even though it delivers nothing.
 */
export function buildTransferReceivedEmail(params: TransferEmailParams): Omit<EmailMessage, 'to'> {
  const t = getDictionary(params.lang).email;
  const orderNumber = params.order._id.toString().slice(-8);

  return buildNoticeEmail({
    lang: params.lang,
    subject: fill(t.transferReceived.subject, { order: orderNumber }),
    paragraphs: [t.transferReceived.intro, `${t.total}: ${money(params.order.totalCents)}`, t.transferReceived.body],
    orderUrl: params.orderUrl,
  });
}

/** Sent when the photographer refuses a receipt. The reason is the whole payload: without
 *  it the buyer is left guessing at what to re-upload. */
export function buildTransferRejectedEmail(params: TransferEmailParams & { reason?: string }): Omit<EmailMessage, 'to'> {
  const t = getDictionary(params.lang).email;
  const orderNumber = params.order._id.toString().slice(-8);

  return buildNoticeEmail({
    lang: params.lang,
    subject: fill(t.transferRejected.subject, { order: orderNumber }),
    paragraphs: [
      t.transferRejected.intro,
      ...(params.reason ? [`${t.transferRejected.reasonLabel}: ${params.reason}`] : []),
      t.transferRejected.retry,
    ],
    orderUrl: params.orderUrl,
  });
}
