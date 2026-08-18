import type { Db, ObjectId } from 'mongodb';
import type { PhotoDoc } from './photos';

/**
 * A sporting event José shot. Photographs link to one via `PhotoDoc.competitionId`;
 * anything with `competitionId: null` is portfolio work (landscape, wildlife) and is
 * browsable separately.
 *
 * This replaced a free-text `collections: string[]` on each photo, which had no
 * documents of its own — meaning no date, no location, no cover image, and renaming
 * required rewriting every photo that referenced the old string. It also routed on the
 * raw name, which broke on the spaces and accents that every real competition name has.
 */
export interface CompetitionDoc {
  _id: ObjectId;
  /** URL segment. Generated from the name via slugify(), so it's always ASCII-safe, and
   *  deliberately NOT regenerated on rename — a published URL must keep working. */
  slug: string;
  name: { es: string; en: string };
  description: { es: string; en: string };
  /** A place name is a proper noun ("Cuenca, Ecuador"), so it isn't translated. */
  location: string;
  date: Date;
  /** One of this competition's own photographs. Stored as a reference rather than an
   *  uploaded file so the cover reuses the whole watermark/derivative pipeline and can
   *  never drift from what visitors actually see. */
  coverPhotoId?: ObjectId;
  status: 'draft' | 'published';
  createdAt: Date;
  updatedAt: Date;
}

function competitions(db: Db) {
  return db.collection<CompetitionDoc>('competitions');
}

/**
 * `date` is a calendar date, not an instant: an event happened on the 6th, full stop.
 * `<input type="date">` yields "2026-08-06", which `new Date()` parses as UTC midnight —
 * so formatting it in Ecuador's local time (UTC-5) renders "August 5". Both helpers below
 * pin to UTC so what an admin types is what a visitor reads.
 *
 * (Deliberately different from lib/analytics.ts, which buckets in local time: order
 * timestamps are real instants, where the local day genuinely is the right boundary.)
 */
export function formatCompetitionDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(date));
}

/** yyyy-mm-dd for a native date input, read in UTC for the same reason. */
export function toDateInputValue(date: Date): string {
  return new Date(date).toISOString().slice(0, 10);
}

export async function listPublishedCompetitions(db: Db, limit = 100): Promise<CompetitionDoc[]> {
  return competitions(db).find({ status: 'published' }).sort({ date: -1 }).limit(limit).toArray();
}

/** Admin listing — includes drafts, newest event first. */
export async function listAllCompetitions(db: Db): Promise<CompetitionDoc[]> {
  return competitions(db).find({}).sort({ date: -1 }).toArray();
}

export async function getCompetitionBySlug(db: Db, slug: string): Promise<CompetitionDoc | null> {
  return competitions(db).findOne({ slug, status: 'published' });
}

export async function getCompetitionById(db: Db, id: ObjectId): Promise<CompetitionDoc | null> {
  return competitions(db).findOne({ _id: id });
}

/** Published photo counts keyed by competition id — one aggregation for a whole index
 *  page rather than a query per card. */
export async function getCompetitionPhotoCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .collection<PhotoDoc>('photos')
    .aggregate([
      { $match: { status: 'published', competitionId: { $ne: null } } },
      { $group: { _id: '$competitionId', n: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((row) => [String(row._id), row.n as number]));
}

/**
 * The photograph to show for a competition, resolved in one place so the index page and
 * the competition page can never disagree.
 *
 * Falls back to the competition's first published photo when no cover is set, or when the
 * chosen cover has since been deleted or unpublished — a competition with photographs
 * should never render as a blank card because of a stale reference.
 */
export async function resolveCoverPhoto(db: Db, competition: CompetitionDoc): Promise<PhotoDoc | null> {
  const photos = db.collection<PhotoDoc>('photos');

  if (competition.coverPhotoId) {
    const cover = await photos.findOne({ _id: competition.coverPhotoId, status: 'published' });
    if (cover) return cover;
  }

  return photos.findOne({ competitionId: competition._id, status: 'published' }, { sort: { order: 1, createdAt: -1 } });
}
