import { describe, expect, it } from 'vitest';
import { computeDigitalPrice, computePrintPrice, PricingError, priceQuoteInputSchema } from '../../src/lib/pricing.ts';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.ts';

const settings = DEFAULT_SETTINGS;

// A 3:2 landscape photo (e.g. 6000x4000), long edge capped at ~63cm.
const photo = { aspectRatio: 1.5, maxPrintCm: 63.5 };

function input(overrides: Partial<Parameters<typeof computePrintPrice>[0]> = {}) {
  return priceQuoteInputSchema.parse({
    photoId: 'p1',
    widthCm: 30,
    heightCm: 20,
    paper: 'matte',
    qty: 1,
    ...overrides,
  });
}

describe('priceQuoteInputSchema', () => {
  it('coerces string form-encoded numbers', () => {
    const parsed = priceQuoteInputSchema.parse({
      photoId: 'p1',
      widthCm: '30',
      heightCm: '20',
      paper: 'matte',
      qty: '2',
    });
    expect(parsed.widthCm).toBe(30);
    expect(parsed.heightCm).toBe(20);
    expect(parsed.qty).toBe(2);
    expect(parsed.crop).toBe('fit'); // default applies
  });
});

describe('computePrintPrice', () => {
  it('computes base + area * rate * paperMultiplier', () => {
    const result = computePrintPrice(input({ widthCm: 30, heightCm: 20, paper: 'matte' }), { settings, photo });
    const expectedUnit = Math.round(settings.baseCents + 30 * 20 * settings.ratePerCm2Cents * 1);
    expect(result.unitPriceCents).toBe(expectedUnit);
    expect(result.totalCents).toBe(expectedUnit * 1);
  });

  it('multiplies total by qty', () => {
    const result = computePrintPrice(input({ qty: 3 }), { settings, photo });
    expect(result.totalCents).toBe(result.unitPriceCents * 3);
  });

  it('applies paper multipliers correctly', () => {
    const matte = computePrintPrice(input({ paper: 'matte' }), { settings, photo });
    const metallic = computePrintPrice(input({ paper: 'metallic' }), { settings, photo });
    expect(metallic.unitPriceCents).toBeGreaterThan(matte.unitPriceCents);
    const expectedMetallic = Math.round(settings.baseCents + 30 * 20 * settings.ratePerCm2Cents * 1.4);
    expect(metallic.unitPriceCents).toBe(expectedMetallic);
  });

  it('rejects an unknown paper stock', () => {
    expect(() => computePrintPrice(input({ paper: 'canvas' }), { settings, photo })).toThrow(PricingError);
    try {
      computePrintPrice(input({ paper: 'canvas' }), { settings, photo });
    } catch (err) {
      expect((err as PricingError).code).toBe('UNKNOWN_PAPER_STOCK');
    }
  });

  it('rejects sizes below the configured minimum', () => {
    expect(() => computePrintPrice(input({ widthCm: 5, heightCm: 3.3 }), { settings, photo })).toThrow(PricingError);
    try {
      computePrintPrice(input({ widthCm: 5, heightCm: 3.3 }), { settings, photo });
    } catch (err) {
      expect((err as PricingError).code).toBe('SIZE_TOO_SMALL');
    }
  });

  it('rejects sizes above the absolute maximum', () => {
    try {
      computePrintPrice(input({ widthCm: 300, heightCm: 200 }), { settings, photo });
      expect.unreachable();
    } catch (err) {
      expect((err as PricingError).code).toBe('SIZE_TOO_LARGE');
    }
  });

  it("rejects sizes exceeding the photo's maxPrintCm even if within the absolute max", () => {
    // 90x60 (long edge 90) exceeds this photo's 63.5cm cap but is under the store-wide 150cm max.
    try {
      computePrintPrice(input({ widthCm: 90, heightCm: 60 }), { settings, photo });
      expect.unreachable();
    } catch (err) {
      expect((err as PricingError).code).toBe('EXCEEDS_MAX_PRINT_CM');
    }
  });

  it('accepts a size just inside the aspect-ratio tolerance', () => {
    // photo aspect 1.5; requested 30x20.1 -> ratio ~1.4925, deviation ~0.5% < 2% tolerance.
    const result = computePrintPrice(input({ widthCm: 30, heightCm: 20.1 }), { settings, photo });
    expect(result.warnings).toEqual([]);
  });

  it('rejects a size just outside the aspect-ratio tolerance when crop is "fit"', () => {
    // ratio 30/22 ≈ 1.364, deviation from 1.5 is ~9% >> 2% tolerance.
    try {
      computePrintPrice(input({ widthCm: 30, heightCm: 22, crop: 'fit' }), { settings, photo });
      expect.unreachable();
    } catch (err) {
      expect((err as PricingError).code).toBe('ASPECT_MISMATCH');
    }
  });

  it('allows an aspect-mismatched size when the buyer explicitly chooses crop or border', () => {
    const cropped = computePrintPrice(input({ widthCm: 30, heightCm: 22, crop: 'crop' }), { settings, photo });
    expect(cropped.warnings).toContain('aspect-mismatch-cropped');
    const bordered = computePrintPrice(input({ widthCm: 30, heightCm: 22, crop: 'border' }), { settings, photo });
    expect(bordered.warnings).toContain('aspect-mismatch-bordered');
  });

  it('per-photo pricing override takes precedence over store-wide settings', () => {
    const overriddenPhoto = { ...photo, pricingOverride: { baseCents: 5000, ratePerCm2Cents: 5 } };
    const result = computePrintPrice(input({ widthCm: 30, heightCm: 20, paper: 'matte' }), {
      settings,
      photo: overriddenPhoto,
    });
    expect(result.unitPriceCents).toBe(Math.round(5000 + 30 * 20 * 5 * 1));
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
});
