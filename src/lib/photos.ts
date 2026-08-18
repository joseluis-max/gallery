import type { Db, ObjectId } from 'mongodb';
import type { StorageAdapter } from './storage';

export interface PhotoCapture {
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: string;
  shutter?: string;
  location?: string;
  takenAt?: Date;
}

export interface PhotoPricingOverride {
  digitalPriceCents?: number;
}

export interface PhotoDoc {
  _id: ObjectId;
  slug: string;
  title: { es: string; en: string };
  description: { es: string; en: string };
  capture: PhotoCapture;
  width: number;
  height: number;
  aspectRatio: number;
  storage: { originalKey: string; publicKey: string };
  lqip: string;
  tags: string[];
  /** The competition this was shot at, or `null` for portfolio work (landscape,
   *  wildlife). A single reference rather than an array: a photograph was taken at one
   *  event, and moving it between competitions is then one `$set`. */
  competitionId: ObjectId | null;
  featured: boolean;
  status: 'draft' | 'published';
  pricing?: PhotoPricingOverride;
  order?: number;
  watermarkOverride?: { widthPct?: number; insetPct?: number; opacity?: number };
  createdAt: Date;
  updatedAt: Date;
}

export interface PhotoImageUrls {
  webp: string;
  jpeg: string;
}

/** The public derivative's JPEG fallback shares the WebP key's basename — ingest.ts
 *  always writes both to the same slug. */
export function getPhotoImageUrls(photo: Pick<PhotoDoc, 'storage'>, storage: StorageAdapter): PhotoImageUrls {
  const webpKey = photo.storage.publicKey;
  const jpegKey = webpKey.replace(/\.webp$/i, '.jpg');
  return { webp: storage.publicUrl(webpKey), jpeg: storage.publicUrl(jpegKey) };
}

export async function getFeaturedPhotos(db: Db, limit = 6): Promise<PhotoDoc[]> {
  return db
    .collection<PhotoDoc>('photos')
    .find({ status: 'published', featured: true })
    .sort({ order: 1, createdAt: -1 })
    .limit(limit)
    .toArray();
}

export interface PublishedPhotosFilter {
  /** `null` selects portfolio work (photographs not tied to any competition), which is a
   *  meaningful query — hence the `in` check below rather than a truthiness test. */
  competitionId?: ObjectId | null;
  tag?: string;
}

export async function getPublishedPhotos(db: Db, filter: PublishedPhotosFilter = {}): Promise<PhotoDoc[]> {
  const query: Record<string, unknown> = { status: 'published' };
  // `'competitionId' in filter`, NOT `if (filter.competitionId)` — null is a real value
  // here and truthiness would silently drop the portfolio query, returning every photo.
  if ('competitionId' in filter) query.competitionId = filter.competitionId;
  if (filter.tag) query.tags = filter.tag;
  return db.collection<PhotoDoc>('photos').find(query).sort({ order: 1, createdAt: -1 }).toArray();
}

/** Published photographs not tied to any competition — José's landscape and wildlife work. */
export async function getPortfolioPhotos(db: Db, filter: { tag?: string } = {}): Promise<PhotoDoc[]> {
  return getPublishedPhotos(db, { competitionId: null, ...filter });
}

export async function getPhotoBySlug(db: Db, slug: string): Promise<PhotoDoc | null> {
  return db.collection<PhotoDoc>('photos').findOne({ slug, status: 'published' });
}

export async function getAllTags(db: Db): Promise<string[]> {
  const tags = await db.collection<PhotoDoc>('photos').distinct('tags', { status: 'published' });
  return tags.sort();
}

/** Tags on portfolio photographs only — the portfolio page's filter chips. Competition
 *  photographs are browsed by event, not by tag, so their tags would only add noise. */
export async function getPortfolioTags(db: Db): Promise<string[]> {
  const tags = await db.collection<PhotoDoc>('photos').distinct('tags', { status: 'published', competitionId: null });
  return tags.filter(Boolean).sort();
}
