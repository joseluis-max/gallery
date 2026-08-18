import { describe, expect, it } from 'vitest';
import { computeDigitalPrice } from '../../src/lib/pricing.ts';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.ts';

const settings = DEFAULT_SETTINGS;

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
