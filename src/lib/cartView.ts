import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { getPhotoImageUrls, type PhotoDoc } from './photos';
import { computeCartPricing } from './pricing';
import { getSettings } from './settings';
import type { StorageAdapter } from './storage';

export interface CartViewLine {
  lineId: string;
  title: string;
  detail: string;
  webpUrl: string;
  jpegUrl: string;
  priceCents: number;
}

export interface CartView {
  lines: CartViewLine[];
  /** Lines whose photograph is gone or unpublished; they're dropped, not priced. */
  unavailableCount: number;
  totalCents: number;
  unitPriceCents: number;
  savingsCents: number;
  nextTier?: { minQty: number; unitPriceCents: number; photosAway: number };
}

/**
 * The single source of truth for what a cart costs, shared by the cart page and the
 * remove-line action.
 *
 * It exists because volume tiers price the cart as a whole: dropping one line can push the
 * cart below a threshold and change the price of every *remaining* line. A client that
 * removed a row and subtracted that row's price would quietly display the wrong total, so
 * the server recomputes and returns the whole view instead.
 *
 * Returns only plain JSON — no ObjectIds — so an Action can hand it straight to the
 * browser.
 */
export async function buildCartView(
  db: Db,
  storage: StorageAdapter,
  cart: CartItem[],
  lang: 'es' | 'en',
  digitalFileLabel: string,
): Promise<CartView> {
  const resolved: { lineId: string; photo: PhotoDoc }[] = [];
  let unavailableCount = 0;

  for (const item of cart) {
    let photo: PhotoDoc | null = null;
    try {
      photo = await db.collection<PhotoDoc>('photos').findOne({ _id: new ObjectId(item.photoId), status: 'published' });
    } catch {
      photo = null;
    }
    if (!photo) {
      unavailableCount++;
      continue;
    }
    resolved.push({ lineId: item.lineId, photo });
  }

  const settings = await getSettings(db);
  const pricing = computeCartPricing(
    resolved.map(({ photo }) => ({ photoId: photo._id.toString(), overrideCents: photo.pricing?.digitalPriceCents })),
    settings,
  );

  const lines = resolved.map(({ lineId, photo }, i) => {
    const urls = getPhotoImageUrls(photo, storage);
    return {
      lineId,
      title: photo.title[lang],
      detail: digitalFileLabel,
      webpUrl: urls.webp,
      jpegUrl: urls.jpeg,
      priceCents: pricing.lines[i].unitPriceCents,
    };
  });

  return {
    lines,
    unavailableCount,
    totalCents: pricing.totalCents,
    unitPriceCents: pricing.unitPriceCents,
    savingsCents: pricing.savingsCents,
    ...(pricing.nextTier ? { nextTier: pricing.nextTier } : {}),
  };
}
