import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { buildOrderEmail } from '../../src/lib/orderEmail';

// Chosen so its last eight characters are the order number in the screenshot this fix
// came from — the short form the page, the admin panel and the email all display.
const orderId = new ObjectId('65f0a1b2c3d4e5f62b98db80');

const order = {
  _id: orderId,
  totalCents: 525,
  items: [
    { photoId: new ObjectId(), photoSlug: 'dsc02239', photoTitle: 'dsc02239', unitPriceCents: 175, totalCents: 175 },
    { photoId: new ObjectId(), photoSlug: 'dsc02242', photoTitle: 'dsc02242', unitPriceCents: 175, totalCents: 175 },
    { photoId: new ObjectId(), photoSlug: 'dsc02319', photoTitle: 'dsc02319', unitPriceCents: 175, totalCents: 175 },
  ],
};

const links = order.items.map((item, i) => ({
  title: item.photoTitle,
  url: `https://josevaldiviezo.com/api/download/tok-${i}`,
}));

function build(overrides: Partial<Parameters<typeof buildOrderEmail>[0]> = {}) {
  return buildOrderEmail({
    order,
    lang: 'es',
    links,
    orderUrl: `https://josevaldiviezo.com/es/order/${orderId.toString()}`,
    ttlDays: 7,
    maxUses: 5,
    ...overrides,
  });
}

describe('buildOrderEmail', () => {
  it('carries every download link in both the text and the html part', () => {
    const message = build();

    for (const link of links) {
      expect(message.text).toContain(link.url);
      expect(message.html).toContain(`href="${link.url}"`);
    }
  });

  it('names the order by the same short number the order page shows', () => {
    const message = build();

    expect(message.subject).toContain('2b98db80');
    expect(message.subject).not.toContain(orderId.toString());
  });

  it('states the total and every line item', () => {
    const message = build();

    expect(message.text).toContain('$5.25');
    expect(message.html).toContain('$5.25');
    expect(message.text).toContain('dsc02239 — $1.75');
  });

  it('spells out how long the links last, from the configured values', () => {
    const message = build({ ttlDays: 3, maxUses: 2 });

    expect(message.text).toContain('3 día(s)');
    expect(message.text).toContain('2 descargas');
  });

  it('writes in the buyer’s own locale', () => {
    const es = build({ lang: 'es' });
    const en = build({ lang: 'en' });

    expect(es.subject).toContain('Tu pedido');
    expect(es.text).toContain('Gracias por tu compra');
    expect(en.subject).toContain('Your order');
    expect(en.text).toContain('Thank you for your purchase');
  });

  // Photo titles come from the admin panel, so they are not trusted markup. An unescaped
  // one would at best break the layout and at worst inject into the buyer's mail client.
  it('escapes photo titles rather than emitting them as markup', () => {
    const message = build({
      order: { ...order, items: [{ ...order.items[0], photoTitle: '<script>alert(1)</script> & "quotes"' }] },
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('&amp;');
  });

  // The order page outlives the tokens — it re-issues them on demand — so it is the link
  // that still works next month.
  it('always points back at the order page, even with nothing to download', () => {
    const message = build({ links: [] });

    expect(message.text).toContain(`https://josevaldiviezo.com/es/order/${orderId.toString()}`);
    expect(message.html).toContain(`href="https://josevaldiviezo.com/es/order/${orderId.toString()}"`);
    expect(message.text).not.toContain('/api/download/');
  });
});
