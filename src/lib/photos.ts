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
  baseCents?: number;
  ratePerCm2Cents?: number;
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
  r2: { originalKey: string; publicKey: string };
  lqip: string;
  maxPrintCm: number;
  tags: string[];
  collections: string[];
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
export function getPhotoImageUrls(photo: Pick<PhotoDoc, 'r2'>, storage: StorageAdapter): PhotoImageUrls {
  const webpKey = photo.r2.publicKey;
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
  collection?: string;
  tag?: string;
}

export async function getPublishedPhotos(db: Db, filter: PublishedPhotosFilter = {}): Promise<PhotoDoc[]> {
  const query: Record<string, unknown> = { status: 'published' };
  if (filter.collection) query.collections = filter.collection;
  if (filter.tag) query.tags = filter.tag;
  return db.collection<PhotoDoc>('photos').find(query).sort({ order: 1, createdAt: -1 }).toArray();
}

export async function getPhotoBySlug(db: Db, slug: string): Promise<PhotoDoc | null> {
  return db.collection<PhotoDoc>('photos').findOne({ slug, status: 'published' });
}

export async function getAllTags(db: Db): Promise<string[]> {
  const tags = await db.collection<PhotoDoc>('photos').distinct('tags', { status: 'published' });
  return tags.sort();
}

export async function getAllCollections(db: Db): Promise<string[]> {
  const collections = await db.collection<PhotoDoc>('photos').distinct('collections', { status: 'published' });
  return collections.sort();
}
