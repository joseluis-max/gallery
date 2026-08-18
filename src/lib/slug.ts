import type { Db } from 'mongodb';

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Appends -2, -3, ... until the slug doesn't collide within `collectionName`. Defaults
 *  to `photos`; competitions have their own unique-slug namespace. */
export async function uniqueSlug(db: Db, base: string, collectionName = 'photos'): Promise<string> {
  const root = slugify(base) || 'photo';
  let candidate = root;
  let n = 2;
  while (await db.collection(collectionName).findOne({ slug: candidate })) {
    candidate = `${root}-${n}`;
    n += 1;
  }
  return candidate;
}
