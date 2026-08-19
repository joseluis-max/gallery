import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { getPhotoImageUrls, type PhotoDoc } from './photos';
import type { OrderDoc } from './orders';
import type { StorageAdapter } from './storage';

export interface OrderThumb {
  webpUrl: string;
  jpegUrl: string;
}

/**
 * Derivative URLs for the photographs on an order, keyed by photo id.
 *
 * Orders deliberately denormalize `photoTitle` so a receipt survives the photograph being
 * deleted or unpublished (see lib/orders.ts). That property is why this is a *separate*
 * lookup returning a partial map rather than something baked into the order: a thumbnail
 * is a nicety, and a missing one must degrade to no image, never to a broken order page.
 *
 * One `$in` query for the whole order — the checkout, transfer and order pages each render
 * every line at once, so a per-item lookup would be N round-trips for a decoration.
 * `status` is not filtered on: a buyer who paid for a photograph that has since been
 * unpublished should still see what they bought.
 */
export async function buildOrderThumbs(
  db: Db,
  storage: StorageAdapter,
  order: Pick<OrderDoc, 'items'>,
): Promise<Record<string, OrderThumb>> {
  const ids = order.items.map((item) => item.photoId);
  if (ids.length === 0) return {};

  const photos = await db
    .collection<PhotoDoc>('photos')
    .find({ _id: { $in: ids as InstanceType<typeof ObjectId>[] } })
    .toArray();

  const thumbs: Record<string, OrderThumb> = {};
  for (const photo of photos) {
    const urls = getPhotoImageUrls(photo, storage);
    thumbs[photo._id.toString()] = { webpUrl: urls.webp, jpegUrl: urls.jpeg };
  }
  return thumbs;
}
