// Pure function of (qty, ctx) — no Mongo, no Astro — so it can be unit-tested with zero
// live services and is guaranteed to compute the exact same number for the page's
// displayed price and the Stripe line item, since both call sites go through this file.
// The client never sends (or is trusted for) a price.
import type { SettingsDoc } from './settings';

export interface PriceQuoteResult {
  unitPriceCents: number;
  totalCents: number;
}

export interface DigitalPriceContext {
  digitalPriceOverrideCents?: number;
  settings: SettingsDoc;
}

export function computeDigitalPrice(qty: number, ctx: DigitalPriceContext): PriceQuoteResult {
  const unitPriceCents = ctx.digitalPriceOverrideCents ?? ctx.settings.digitalPriceCents;
  return { unitPriceCents, totalCents: unitPriceCents * qty };
}
