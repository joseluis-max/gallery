import { describe, expect, it } from 'vitest';
import { computeCartPricing, computeDigitalPrice, unitPriceForQuantity } from '../../src/lib/pricing.ts';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.ts';

const settings = DEFAULT_SETTINGS; // base 200; tiers at 3 -> 175, 5 -> 150, 10 -> 120
const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ photoId: `p${i}` }));

describe('unitPriceForQuantity', () => {
  it('charges the base price below the first tier', () => {
    expect(unitPriceForQuantity(1, settings)).toBe(200);
    expect(unitPriceForQuantity(2, settings)).toBe(200);
  });

  it('applies a tier from its threshold onward', () => {
    expect(unitPriceForQuantity(3, settings)).toBe(175);
    expect(unitPriceForQuantity(4, settings)).toBe(175);
    expect(unitPriceForQuantity(5, settings)).toBe(150);
    expect(unitPriceForQuantity(50, settings)).toBe(120);
  });

  it('takes the cheapest applicable tier regardless of array order', () => {
    const unsorted = { ...settings, volumeTiers: [{ minQty: 10, unitPriceCents: 120 }, { minQty: 3, unitPriceCents: 175 }] };
    expect(unitPriceForQuantity(10, unsorted)).toBe(120);
  });

  it('falls back to the base price when no tiers are configured', () => {
    expect(unitPriceForQuantity(99, { ...settings, volumeTiers: [] })).toBe(200);
  });
});

describe('computeCartPricing', () => {
  it('discounts every photo in the cart, not just the ones past the threshold', () => {
    const result = computeCartPricing(lines(5), settings);
    expect(result.unitPriceCents).toBe(150);
    expect(result.totalCents).toBe(750);
    expect(result.lines.every((line) => line.unitPriceCents === 150)).toBe(true);
  });

  it('reports savings against the undiscounted price', () => {
    const result = computeCartPricing(lines(5), settings);
    expect(result.undiscountedTotalCents).toBe(1000);
    expect(result.savingsCents).toBe(250);
  });

  it('has no savings and no discount below the first tier', () => {
    const result = computeCartPricing(lines(2), settings);
    expect(result.totalCents).toBe(400);
    expect(result.savingsCents).toBe(0);
  });

  it('points at the next tier and how far away it is', () => {
    expect(computeCartPricing(lines(2), settings).nextTier).toMatchObject({ minQty: 3, unitPriceCents: 175, photosAway: 1 });
    expect(computeCartPricing(lines(5), settings).nextTier).toMatchObject({ minQty: 10, photosAway: 5 });
  });

  it('has no next tier once the deepest one is reached', () => {
    expect(computeCartPricing(lines(10), settings).nextTier).toBeUndefined();
  });

  // An override means "this photograph is different". A volume discount silently undoing
  // that would make the override unreliable, so it wins — but it still counts toward the
  // quantity that unlocks the tier for everything else in the cart.
  it('keeps a per-photo override at its own price while still counting toward the tier', () => {
    const result = computeCartPricing([...lines(4), { photoId: 'special', overrideCents: 5000 }], settings);
    expect(result.unitPriceCents).toBe(150);
    expect(result.lines.filter((l) => !l.isOverride).every((l) => l.unitPriceCents === 150)).toBe(true);
    expect(result.lines.find((l) => l.isOverride)!.unitPriceCents).toBe(5000);
    expect(result.totalCents).toBe(4 * 150 + 5000);
  });

  it('prices an empty cart at zero without throwing', () => {
    expect(computeCartPricing([], settings)).toMatchObject({ totalCents: 0, savingsCents: 0 });
  });
});

describe('computeDigitalPrice', () => {
  it('uses the store-wide digital price by default', () => {
    const result = computeDigitalPrice(2, { settings });
    expect(result.unitPriceCents).toBe(settings.digitalPriceCents);
    expect(result.totalCents).toBe(settings.digitalPriceCents * 2);
  });

  it('uses a per-photo digital price override when present', () => {
    const result = computeDigitalPrice(1, { settings, digitalPriceOverrideCents: 9999 });
    expect(result.unitPriceCents).toBe(9999);
  });

  it('treats a zero override as a real price, not a missing one', () => {
    // `?? ` rather than `||` — a photo priced at 0 must not silently fall back to the
    // store default. Checkout separately refuses a zero *total*, which is where that
    // case is caught.
    const result = computeDigitalPrice(1, { settings, digitalPriceOverrideCents: 0 });
    expect(result.unitPriceCents).toBe(0);
  });
});
