// Pure functions of (input, settings) — no Mongo, no Astro — so pricing can be
// unit-tested with zero live services, and so the cart page, the checkout action and the
// amount handed to the payment gateway are guaranteed to agree: all three call
// `computeCartPricing`. The client never sends (or is trusted for) a price — and the
// confirm route re-checks the gateway's own figure against the stored order total, so a
// tampered amount cannot buy anything either.
import type { SettingsDoc } from './settings';

export interface PriceQuoteResult {
  unitPriceCents: number;
  totalCents: number;
}

/**
 * The unit price every photo in a cart of `qty` photos is charged at: the deepest tier
 * whose threshold the cart has reached, or the base price if none has been.
 *
 * Tiers are filtered and max-ed rather than assumed sorted, because the admin editor
 * accepts them in any order and a stored document may predate the sort-on-save.
 */
export function unitPriceForQuantity(qty: number, settings: SettingsDoc): number {
  const applicable = (settings.volumeTiers ?? []).filter((tier) => qty >= tier.minQty);
  if (applicable.length === 0) return settings.digitalPriceCents;
  return Math.min(...applicable.map((tier) => tier.unitPriceCents));
}

export interface CartPricingLine {
  photoId: string;
  /** From `photo.pricing.digitalPriceCents`. A specially-priced photograph keeps its own
   *  price and is never pulled down by a volume tier — an override means "this one is
   *  different", which a discount silently undoing would defeat. It still counts toward
   *  the quantity that unlocks tiers for everything else. */
  overrideCents?: number;
}

export interface CartPricingResult {
  /** Per line, in the order given. */
  lines: { photoId: string; unitPriceCents: number; isOverride: boolean }[];
  /** The tier price the un-overridden lines were charged at. */
  unitPriceCents: number;
  /** What the same cart would have cost with no tier applied — for "you saved X". */
  undiscountedTotalCents: number;
  totalCents: number;
  savingsCents: number;
  /** The next tier the cart hasn't reached yet, for an "add N more" nudge. */
  nextTier?: { minQty: number; unitPriceCents: number; photosAway: number };
}

export function computeCartPricing(lines: CartPricingLine[], settings: SettingsDoc): CartPricingResult {
  const qty = lines.length;
  const unitPriceCents = unitPriceForQuantity(qty, settings);

  const priced = lines.map((line) => ({
    photoId: line.photoId,
    unitPriceCents: line.overrideCents ?? unitPriceCents,
    isOverride: line.overrideCents !== undefined,
  }));

  const totalCents = priced.reduce((sum, line) => sum + line.unitPriceCents, 0);
  const undiscountedTotalCents = lines.reduce((sum, line) => sum + (line.overrideCents ?? settings.digitalPriceCents), 0);

  const upcoming = (settings.volumeTiers ?? [])
    .filter((tier) => tier.minQty > qty && tier.unitPriceCents < unitPriceCents)
    .sort((a, b) => a.minQty - b.minQty)[0];

  return {
    lines: priced,
    unitPriceCents,
    undiscountedTotalCents,
    totalCents,
    savingsCents: Math.max(0, undiscountedTotalCents - totalCents),
    ...(upcoming ? { nextTier: { ...upcoming, photosAway: upcoming.minQty - qty } } : {}),
  };
}

export interface DigitalPriceContext {
  digitalPriceOverrideCents?: number;
  settings: SettingsDoc;
}

/** Single-photo price, for the detail page's headline figure. Volume tiers only exist in
 *  the context of a whole cart, so this deliberately ignores them. */
export function computeDigitalPrice(qty: number, ctx: DigitalPriceContext): PriceQuoteResult {
  const unitPriceCents = ctx.digitalPriceOverrideCents ?? ctx.settings.digitalPriceCents;
  return { unitPriceCents, totalCents: unitPriceCents * qty };
}
