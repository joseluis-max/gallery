// Pure function of (input, ctx) — no Mongo, no Astro — so it can be unit-tested with
// zero live services and is guaranteed to compute the exact same number for the live
// quote UI and the Stripe line item, since both call sites go through this file. The
// client sends dimensions; it never sends (or is trusted for) a price.
import { z } from 'zod';
import type { SettingsDoc } from './settings';

export const priceQuoteInputSchema = z.object({
  photoId: z.string().min(1),
  widthCm: z.coerce.number().positive().max(1000),
  heightCm: z.coerce.number().positive().max(1000),
  // Paper stocks are admin-editable at runtime (settings collection) — validated as a
  // known key against ctx.settings.paperStocks below, not via a static z.enum.
  paper: z.string().min(1),
  qty: z.coerce.number().int().positive().max(50),
  crop: z.enum(['fit', 'crop', 'border']).default('fit'),
});

export type PriceQuoteInput = z.infer<typeof priceQuoteInputSchema>;

export type PricingErrorCode =
  | 'SIZE_TOO_SMALL'
  | 'SIZE_TOO_LARGE'
  | 'EXCEEDS_MAX_PRINT_CM'
  | 'ASPECT_MISMATCH'
  | 'UNKNOWN_PAPER_STOCK';

export class PricingError extends Error {
  constructor(
    public code: PricingErrorCode,
    public details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'PricingError';
  }
}

export interface PricingPhotoContext {
  aspectRatio: number;
  maxPrintCm: number;
  pricingOverride?: { baseCents?: number; ratePerCm2Cents?: number };
}

export interface PricingContext {
  settings: SettingsDoc;
  photo: PricingPhotoContext;
}

export interface PriceQuoteResult {
  unitPriceCents: number;
  totalCents: number;
  /** Non-fatal notices worth surfacing in the UI, e.g. a crop/border choice was applied. */
  warnings: string[];
}

export function computePrintPrice(input: PriceQuoteInput, ctx: PricingContext): PriceQuoteResult {
  const { settings, photo } = ctx;

  if (input.widthCm < settings.minCm || input.heightCm < settings.minCm) {
    throw new PricingError('SIZE_TOO_SMALL', { minCm: settings.minCm });
  }
  if (input.widthCm > settings.maxCmAbsolute || input.heightCm > settings.maxCmAbsolute) {
    throw new PricingError('SIZE_TOO_LARGE', { maxCmAbsolute: settings.maxCmAbsolute });
  }

  const longEdge = Math.max(input.widthCm, input.heightCm);
  if (longEdge > photo.maxPrintCm) {
    throw new PricingError('EXCEEDS_MAX_PRINT_CM', { maxPrintCm: photo.maxPrintCm });
  }

  const warnings: string[] = [];
  const requestedRatio = input.widthCm / input.heightCm;
  const deviation = Math.abs(requestedRatio - photo.aspectRatio) / photo.aspectRatio;
  if (deviation > settings.sizeTolerancePct) {
    if (input.crop === 'fit') {
      throw new PricingError('ASPECT_MISMATCH', { deviation, tolerance: settings.sizeTolerancePct });
    }
    warnings.push(input.crop === 'crop' ? 'aspect-mismatch-cropped' : 'aspect-mismatch-bordered');
  }

  const paperStock = settings.paperStocks[input.paper];
  if (!paperStock) {
    throw new PricingError('UNKNOWN_PAPER_STOCK', { paper: input.paper });
  }

  const areaCm2 = input.widthCm * input.heightCm;
  const baseCents = photo.pricingOverride?.baseCents ?? settings.baseCents;
  const ratePerCm2Cents = photo.pricingOverride?.ratePerCm2Cents ?? settings.ratePerCm2Cents;
  const unitPriceCents = Math.round(baseCents + areaCm2 * ratePerCm2Cents * paperStock.multiplier);

  return { unitPriceCents, totalCents: unitPriceCents * input.qty, warnings };
}

export interface DigitalPriceContext {
  digitalPriceOverrideCents?: number;
  settings: SettingsDoc;
}

export function computeDigitalPrice(qty: number, ctx: DigitalPriceContext): PriceQuoteResult {
  const unitPriceCents = ctx.digitalPriceOverrideCents ?? ctx.settings.digitalPriceCents;
  return { unitPriceCents, totalCents: unitPriceCents * qty, warnings: [] };
}

/** Flat rate from the first configured shipping zone, only when the cart contains a
 *  physical print — digital-only carts never carry a shipping charge. */
export function computeShippingCents(settings: SettingsDoc, hasPrintItem: boolean): number {
  if (!hasPrintItem) return 0;
  return settings.shippingZones[0]?.flatRateCents ?? 0;
}
