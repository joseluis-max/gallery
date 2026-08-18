import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'astro/zod';
import { ActionError } from 'astro:actions';
import { defineAdminAction, requireAdmin } from './adminGuard';
import { writeAuditLog } from '../lib/audit';
import type { CompetitionDoc } from '../lib/competitions';
import { createStorage, getDbConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { processOriginal } from '../lib/images';
import type { PhotoDoc } from '../lib/photos';
import { serializeForAction } from '../lib/serialize';
import { uniqueSlug } from '../lib/slug';
import type { StorageAdapter } from '../lib/storage';
import { getUploadJob, listUploadJobs as listUploadJobsQuery, updateUploadJob, type UploadJobDoc } from '../lib/uploadJobs';
import {
  countActiveAdmins,
  createUser,
  findUserById,
  setFreeDownloads,
  setUserDisabled,
  setUserPassword,
  setUserRole,
  UserError,
  type UserDoc,
  type UserRole,
} from '../lib/users';
import { defaultWatermarkConfig } from '../../watermark.config';
import type { ActionAPIContext } from 'astro:actions';
import type { Db } from 'mongodb';

/** Audit entries record *which* admin acted, now that there can be more than one. The
 *  session read is the same one `defineAdminAction` already did, so this is a lookup,
 *  not a second authorization decision. */
async function actorEmail(context: ActionAPIContext): Promise<string> {
  return (await requireAdmin(context)).email;
}

function toUserActionError(err: unknown): ActionError {
  if (err instanceof UserError) {
    return new ActionError({ code: err.code === 'EMAIL_TAKEN' ? 'CONFLICT' : 'BAD_REQUEST', message: err.code });
  }
  throw err;
}

/**
 * Refuses any change that would leave the panel with no admin who can sign in — the
 * failure mode being prevented is a real one (demote or disable yourself as the only
 * admin and the only way back in is the `create-admin` CLI script against the database).
 * Self-demotion is blocked outright for the same reason; another admin can still do it.
 *
 * The count check is honestly a check-then-act, so two admins demoting each other at the
 * same instant could still both succeed. That race is narrow, and `pnpm create-admin`
 * remains the recovery path; the guard exists to stop the *common* one-click lockout,
 * not to make lockout impossible.
 */
async function assertNotLastAdmin(
  db: Db,
  actorId: string,
  target: UserDoc,
  nextRole: UserRole,
  nextDisabled: boolean,
): Promise<void> {
  const losesAdminAccess = target.role === 'admin' && !target.disabled && (nextRole !== 'admin' || nextDisabled);
  if (!losesAdminAccess) return;

  if (target._id.toString() === actorId) {
    throw new ActionError({ code: 'CONFLICT', message: 'CANNOT_LOCK_SELF_OUT' });
  }
  if ((await countActiveAdmins(db)) <= 1) {
    throw new ActionError({ code: 'CONFLICT', message: 'LAST_ADMIN' });
  }
}

const ALLOWED_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/tiff']);
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 24MP A7III originals run ~25MB; leaves headroom
/** Lifetime of a presigned PUT. Generous because it has to cover the *whole* transfer of
 *  a ~25MB original on a domestic uplink, not just the moment the URL is used; the
 *  upload page also re-signs (`refreshUploadUrl`) rather than letting a queued file
 *  outlive its signature. */
const UPLOAD_URL_TTL_SECONDS = 3600;
/** How long a job may sit on `processing` before it's assumed abandoned rather than
 *  in-flight. Comfortably longer than the sharp pipeline takes on the largest original
 *  the size cap allows, so this never steals a job from a worker that's still running. */
const STALE_PROCESSING_MS = 10 * 60 * 1000;
/** Ids accepted by one bulk publish call. The panel chunks a larger selection rather than
 *  sending it all at once, so this caps request size without capping what an admin can
 *  select. */
const BULK_PUBLISH_LIMIT = 500;


/** Shared by completeUpload and retryUploadJob so there is exactly one place that pulls
 *  an original back from storage and runs it through the sharp pipeline — the same
 *  lib/images.ts used by the CLI ingest script, per the no-duplicate-pipeline rule.
 *  Storage-driver-agnostic: it only ever sees a `StorageAdapter`. */
async function processUploadJob(db: Db, storage: StorageAdapter, job: UploadJobDoc): Promise<{ photoId: ObjectId; slug: string }> {
  await updateUploadJob(db, job._id, { status: 'processing', error: undefined });

  try {
    const original = await storage.getObject({ bucket: 'originals', key: job.originalKey });
    const processed = await processOriginal(original, defaultWatermarkConfig);

    const baseName = job.filename.replace(/\.[^.]+$/, '');
    const slug = await uniqueSlug(db, baseName);
    const publicWebpKey = `${slug}.webp`;
    const publicJpegKey = `${slug}.jpg`;

    await Promise.all([
      storage.putObject({ bucket: 'public', key: publicWebpKey, body: processed.derivativeWebp, contentType: 'image/webp' }),
      storage.putObject({ bucket: 'public', key: publicJpegKey, body: processed.derivativeJpeg, contentType: 'image/jpeg' }),
    ]);

    const now = new Date();
    const photoDoc: Omit<PhotoDoc, '_id'> = {
      slug,
      title: { es: slug, en: slug },
      description: { es: '', en: '' },
      capture: processed.exif,
      width: processed.width,
      height: processed.height,
      aspectRatio: processed.aspectRatio,
      storage: { originalKey: job.originalKey, publicKey: publicWebpKey },
      lqip: processed.lqip,
      tags: [],
      competitionId: job.competitionId ?? null,
      featured: false,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    const { insertedId } = await db.collection<Omit<PhotoDoc, '_id'>>('photos').insertOne(photoDoc);

    await updateUploadJob(db, job._id, { status: 'ready', photoId: insertedId, photoSlug: slug });

    return { photoId: insertedId, slug };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateUploadJob(db, job._id, { status: 'failed', error: message });
    throw err;
  }
}

/** Signing in is `actions.auth.login` for admins and customers alike (src/actions/
 *  auth.ts) — an admin is a `users` document with `role: 'admin'`, not a separate
 *  credential, so there is exactly one sign-in code path to keep correct. What lives
 *  here is everything that *requires* already being an admin. */
export const admin = {
  requestUploadUrl: defineAdminAction({
    accept: 'json',
    input: z.object({
      filename: z.string().min(1),
      contentType: z.string().min(1),
      bytes: z.coerce.number().positive(),
      /** Empty string means portfolio (no competition). */
      competitionId: z.string().optional(),
    }),
    handler: async (input) => {
      if (!ALLOWED_UPLOAD_TYPES.has(input.contentType)) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'UNSUPPORTED_FILE_TYPE' });
      }
      if (input.bytes > MAX_UPLOAD_BYTES) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'FILE_TOO_LARGE' });
      }

      const db = await getDb(getDbConfig());
      const storage = createStorage();

      // Resolved here rather than trusted: a job carrying an id that doesn't exist would
      // silently produce photographs pointing at nothing.
      let competitionId: ObjectId | undefined;
      if (input.competitionId) {
        competitionId = new ObjectId(input.competitionId);
        if (!(await db.collection('competitions').findOne({ _id: competitionId }))) {
          throw new ActionError({ code: 'BAD_REQUEST', message: 'COMPETITION_NOT_FOUND' });
        }
      }

      const originalKey = `uploads/${randomUUID()}-${input.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const now = new Date();
      const { insertedId } = await db.collection('uploadJobs').insertOne({
        status: 'awaiting-upload',
        originalKey,
        filename: input.filename,
        bytes: input.bytes,
        ...(competitionId ? { competitionId } : {}),
        createdAt: now,
        updatedAt: now,
      });

      const uploadUrl = await storage.getPresignedPutUrl({ key: originalKey, contentType: input.contentType, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });

      return { jobId: insertedId.toString(), uploadUrl, key: originalKey };
    },
  }),

  /**
   * A second presigned PUT for a job whose first one didn't land — the client's retry
   * path. It re-signs the job's *existing* `originalKey` rather than minting a new job,
   * so retrying a file leaves one row that eventually succeeds instead of a trail of
   * abandoned `awaiting-upload` records (a batch that failed and was re-dropped used to
   * leave one orphan per attempt).
   *
   * Signatures expire in UPLOAD_URL_TTL_SECONDS, so a queued file that waits out its
   * window behind other uploads gets a fresh one here rather than a 403.
   */
  refreshUploadUrl: defineAdminAction({
    accept: 'json',
    input: z.object({ jobId: z.string().min(1), contentType: z.string().min(1) }),
    handler: async (input) => {
      if (!ALLOWED_UPLOAD_TYPES.has(input.contentType)) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'UNSUPPORTED_FILE_TYPE' });
      }

      const db = await getDb(getDbConfig());
      const storage = createStorage();

      const job = await getUploadJob(db, new ObjectId(input.jobId));
      if (!job) throw new ActionError({ code: 'NOT_FOUND', message: 'UPLOAD_JOB_NOT_FOUND' });
      // Only a job still waiting for its bytes may be re-signed. A job that reached
      // `failed` did so during *processing*, which means its original uploaded fine and
      // is already in the bucket — that one retries through `retryUploadJob`, not by
      // sending the bytes again. Re-signing anything further along would hand out a URL
      // that overwrites the original of a live photograph.
      if (job.status !== 'awaiting-upload') {
        throw new ActionError({ code: 'CONFLICT', message: 'UPLOAD_JOB_ALREADY_PROCESSED' });
      }

      const uploadUrl = await storage.getPresignedPutUrl({ key: job.originalKey, contentType: input.contentType, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });

      return { jobId: job._id.toString(), uploadUrl, key: job.originalKey };
    },
  }),

  completeUpload: defineAdminAction({
    accept: 'json',
    input: z.object({ jobId: z.string().min(1) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const storage = createStorage();

      const job = await getUploadJob(db, new ObjectId(input.jobId));
      if (!job) throw new ActionError({ code: 'NOT_FOUND', message: 'UPLOAD_JOB_NOT_FOUND' });
      if (job.status !== 'awaiting-upload') {
        throw new ActionError({ code: 'CONFLICT', message: 'UPLOAD_JOB_ALREADY_PROCESSED' });
      }

      try {
        const { photoId, slug } = await processUploadJob(db, storage, job);
        await writeAuditLog(db, { actor: await actorEmail(context), action: 'photo.upload', targetType: 'photo', targetId: photoId.toString(), after: { slug } });
        return { photoId: photoId.toString(), slug };
      } catch (err) {
        throw new ActionError({ code: 'INTERNAL_SERVER_ERROR', message: err instanceof Error ? err.message : 'PROCESSING_FAILED' });
      }
    },
  }),

  retryUploadJob: defineAdminAction({
    accept: 'json',
    input: z.object({ jobId: z.string().min(1) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const storage = createStorage();

      const job = await getUploadJob(db, new ObjectId(input.jobId));
      if (!job) throw new ActionError({ code: 'NOT_FOUND', message: 'UPLOAD_JOB_NOT_FOUND' });
      // `processing` is set at the *start* of the sharp pipeline and replaced by
      // `ready`/`failed` at the end, so a process that dies mid-pipeline — a container
      // restart, a dev-server reload, an OOM under a big batch — leaves the job on
      // `processing` with nothing left to move it. Requiring `failed` here stranded
      // those permanently. A `processing` job that hasn't been touched in
      // STALE_PROCESSING_MS has no live worker behind it and is safe to pick up; one
      // still being worked on is left alone, so this can't run two pipelines over the
      // same original at once.
      const stale = job.status === 'processing' && Date.now() - job.updatedAt.getTime() > STALE_PROCESSING_MS;
      if (job.status !== 'failed' && !stale) {
        throw new ActionError({ code: 'CONFLICT', message: 'UPLOAD_JOB_NOT_FAILED' });
      }

      try {
        const { photoId, slug } = await processUploadJob(db, storage, job);
        await writeAuditLog(db, { actor: await actorEmail(context), action: 'photo.upload.retry', targetType: 'photo', targetId: photoId.toString(), after: { slug } });
        return { photoId: photoId.toString(), slug };
      } catch (err) {
        throw new ActionError({ code: 'INTERNAL_SERVER_ERROR', message: err instanceof Error ? err.message : 'PROCESSING_FAILED' });
      }
    },
  }),

  listUploadJobs: defineAdminAction({
    accept: 'json',
    input: z.object({}),
    handler: async () => {
      const db = await getDb(getDbConfig());
      const jobs = await listUploadJobsQuery(db);
      return serializeForAction(jobs);
    },
  }),

  updatePhoto: defineAdminAction({
    accept: 'json',
    input: z.object({
      photoId: z.string().min(1),
      title: z.object({ es: z.string(), en: z.string() }),
      description: z.object({ es: z.string(), en: z.string() }),
      tags: z.array(z.string()),
      /** Null moves the photograph to the portfolio. */
      competitionId: z.string().nullable(),
      featured: z.boolean(),
      pricingOverride: z.object({ digitalPriceCents: z.coerce.number().optional() }).optional(),
    }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const photoId = new ObjectId(input.photoId);
      const before = await db.collection<PhotoDoc>('photos').findOne({ _id: photoId });
      if (!before) throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });

      let competitionId: ObjectId | null = null;
      if (input.competitionId) {
        competitionId = new ObjectId(input.competitionId);
        if (!(await db.collection('competitions').findOne({ _id: competitionId }))) {
          throw new ActionError({ code: 'BAD_REQUEST', message: 'COMPETITION_NOT_FOUND' });
        }
      }

      const patch = {
        title: input.title,
        description: input.description,
        tags: input.tags,
        competitionId,
        featured: input.featured,
        pricing: input.pricingOverride,
        updatedAt: new Date(),
      };
      await db.collection('photos').updateOne({ _id: photoId }, { $set: patch });

      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: 'photo.update',
        targetType: 'photo',
        targetId: input.photoId,
        before: { title: before.title, description: before.description, tags: before.tags, competitionId: before.competitionId, featured: before.featured, pricing: before.pricing },
        after: patch,
      });

      return { ok: true };
    },
  }),

  setPhotoPublished: defineAdminAction({
    accept: 'json',
    input: z.object({ photoId: z.string().min(1), published: z.boolean() }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const photoId = new ObjectId(input.photoId);
      const before = await db.collection<PhotoDoc>('photos').findOne({ _id: photoId });
      if (!before) throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });

      const status = input.published ? 'published' : 'draft';
      await db.collection('photos').updateOne({ _id: photoId }, { $set: { status, updatedAt: new Date() } });
      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: input.published ? 'photo.publish' : 'photo.unpublish',
        targetType: 'photo',
        targetId: input.photoId,
        before: { status: before.status },
        after: { status },
      });

      return { ok: true };
    },
  }),

  /**
   * Publishes or unpublishes many photographs in one call — the panel's select-some /
   * publish-all controls.
   *
   * Deliberately one `updateMany` and **one** audit entry rather than a loop over
   * `setPhotoPublished`: publishing a 90-frame competition would otherwise bury every
   * other event in `/admin/activity` under 90 near-identical rows. The full id list still
   * goes into the entry's `after`, so the record stays complete; only the *summary* is
   * condensed.
   *
   * The `status: { $ne: status }` guard is what makes `changed` meaningful — re-running a
   * publish over a mostly-published selection reports the handful it actually moved
   * instead of claiming all of them.
   */
  setPhotosPublished: defineAdminAction({
    accept: 'json',
    input: z.object({
      photoIds: z.array(z.string().min(1)).min(1).max(BULK_PUBLISH_LIMIT),
      published: z.boolean(),
    }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const ids = input.photoIds.map((id) => new ObjectId(id));
      const status = input.published ? 'published' : 'draft';

      const result = await db
        .collection<PhotoDoc>('photos')
        .updateMany({ _id: { $in: ids }, status: { $ne: status } }, { $set: { status, updatedAt: new Date() } });

      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: input.published ? 'photo.publish.bulk' : 'photo.unpublish.bulk',
        targetType: 'photos',
        targetId: `${result.modifiedCount} of ${ids.length}`,
        after: { status, photoIds: input.photoIds },
      });

      return { selected: ids.length, changed: result.modifiedCount };
    },
  }),

  deletePhoto: defineAdminAction({
    accept: 'json',
    input: z.object({ photoId: z.string().min(1) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const photoId = new ObjectId(input.photoId);
      const photo = await db.collection<PhotoDoc>('photos').findOne({ _id: photoId });
      if (!photo) throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });

      // A sold photo's download tokens/order history point at this exact photoId —
      // deleting it would break a paying customer's record and download link, so this
      // is genuinely blocked, not just warned about.
      const referencingOrders = await db.collection('orders').countDocuments({ 'items.photoId': photoId });
      if (referencingOrders > 0) {
        throw new ActionError({ code: 'CONFLICT', message: `REFERENCED_BY_${referencingOrders}_ORDERS` });
      }

      const storage = createStorage();
      await Promise.allSettled([
        storage.deleteObject({ bucket: 'originals', key: photo.storage.originalKey }),
        storage.deleteObject({ bucket: 'public', key: photo.storage.publicKey }),
        storage.deleteObject({ bucket: 'public', key: photo.storage.publicKey.replace(/\.webp$/i, '.jpg') }),
      ]);

      await db.collection('photos').deleteOne({ _id: photoId });
      await writeAuditLog(db, { actor: await actorEmail(context), action: 'photo.delete', targetType: 'photo', targetId: input.photoId, before: { slug: photo.slug } });

      return { ok: true };
    },
  }),

  createCompetition: defineAdminAction({
    accept: 'json',
    input: z.object({
      name: z.object({ es: z.string().min(1), en: z.string().min(1) }),
      description: z.object({ es: z.string(), en: z.string() }),
      location: z.string(),
      /** ISO date string from a native <input type="date">. */
      date: z.string().min(1),
    }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      // Slug from the English name so URLs stay ASCII regardless of accents in Spanish.
      const slug = await uniqueSlug(db, input.name.en || input.name.es, 'competitions');
      const now = new Date();

      const doc: Omit<CompetitionDoc, '_id'> = {
        slug,
        name: input.name,
        description: input.description,
        location: input.location,
        date: new Date(input.date),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };
      const { insertedId } = await db.collection<Omit<CompetitionDoc, '_id'>>('competitions').insertOne(doc);

      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: 'competition.create',
        targetType: 'competition',
        targetId: insertedId.toString(),
        after: doc,
      });

      return { id: insertedId.toString(), slug };
    },
  }),

  updateCompetition: defineAdminAction({
    accept: 'json',
    input: z.object({
      competitionId: z.string().min(1),
      name: z.object({ es: z.string().min(1), en: z.string().min(1) }),
      description: z.object({ es: z.string(), en: z.string() }),
      location: z.string(),
      date: z.string().min(1),
      coverPhotoId: z.string().nullable().optional(),
    }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const competitionId = new ObjectId(input.competitionId);
      const before = await db.collection<CompetitionDoc>('competitions').findOne({ _id: competitionId });
      if (!before) throw new ActionError({ code: 'NOT_FOUND', message: 'COMPETITION_NOT_FOUND' });

      // The slug is deliberately NOT regenerated from the new name: it's the published
      // URL, and renaming an event ("Copa 2026" → "Copa Nacional 2026") must not break
      // every link that already points at it.
      const patch = {
        name: input.name,
        description: input.description,
        location: input.location,
        date: new Date(input.date),
        coverPhotoId: input.coverPhotoId ? new ObjectId(input.coverPhotoId) : undefined,
        updatedAt: new Date(),
      };
      await db.collection('competitions').updateOne({ _id: competitionId }, { $set: patch });

      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: 'competition.update',
        targetType: 'competition',
        targetId: input.competitionId,
        before: { name: before.name, description: before.description, location: before.location, date: before.date, coverPhotoId: before.coverPhotoId },
        after: patch,
      });

      return { ok: true };
    },
  }),

  setCompetitionPublished: defineAdminAction({
    accept: 'json',
    input: z.object({ competitionId: z.string().min(1), published: z.boolean() }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const competitionId = new ObjectId(input.competitionId);
      const status = input.published ? 'published' : 'draft';

      const result = await db.collection('competitions').updateOne({ _id: competitionId }, { $set: { status, updatedAt: new Date() } });
      if (result.matchedCount === 0) throw new ActionError({ code: 'NOT_FOUND', message: 'COMPETITION_NOT_FOUND' });

      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: input.published ? 'competition.publish' : 'competition.unpublish',
        targetType: 'competition',
        targetId: input.competitionId,
        after: { status },
      });

      return { ok: true };
    },
  }),

  deleteCompetition: defineAdminAction({
    accept: 'json',
    input: z.object({ competitionId: z.string().min(1) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const competitionId = new ObjectId(input.competitionId);

      // Refused rather than cascaded, mirroring deletePhoto: deleting an event should
      // never quietly move its photographs into the portfolio, where they'd appear
      // alongside the landscape work with no indication anything happened.
      const photoCount = await db.collection('photos').countDocuments({ competitionId });
      if (photoCount > 0) {
        throw new ActionError({ code: 'CONFLICT', message: `HAS_${photoCount}_PHOTOS` });
      }

      const result = await db.collection('competitions').deleteOne({ _id: competitionId });
      if (result.deletedCount === 0) throw new ActionError({ code: 'NOT_FOUND', message: 'COMPETITION_NOT_FOUND' });

      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: 'competition.delete',
        targetType: 'competition',
        targetId: input.competitionId,
      });

      return { ok: true };
    },
  }),

  reorderPhotos: defineAdminAction({
    accept: 'json',
    input: z.object({ orderedIds: z.array(z.string().min(1)) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      // Known limitation: `order` is a single global number shared by every competition
      // and the portfolio, so reordering within one competition also shifts these
      // photographs' position relative to everything else. Harmless while ordering is
      // only used as a tie-break inside an already-filtered list; making it truly
      // per-competition needs an order map keyed by competition id.
      await Promise.all(
        input.orderedIds.map((id, index) => db.collection('photos').updateOne({ _id: new ObjectId(id) }, { $set: { order: index } })),
      );
      await writeAuditLog(db, { actor: await actorEmail(context), action: 'photo.reorder', targetType: 'photo', targetId: 'bulk', after: { count: input.orderedIds.length } });
      return { ok: true };
    },
  }),

  saveSettings: defineAdminAction({
    accept: 'json',
    input: z.object({
      digitalPriceCents: z.coerce.number().int().nonnegative(),
      // minQty >= 2: a tier at 1 (or 0) would replace the base price for every cart,
      // which is a base-price edit wearing a disguise.
      volumeTiers: z
        .array(z.object({ minQty: z.coerce.number().int().min(2), unitPriceCents: z.coerce.number().int().nonnegative() }))
        .default([]),
    }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const { getSettings, saveSettings: persistSettings } = await import('../lib/settings');
      const before = await getSettings(db);
      const after = await persistSettings(db, input);

      await writeAuditLog(db, { actor: await actorEmail(context), action: 'pricing.update', targetType: 'settings', targetId: 'singleton', before, after });

      return { ok: true };
    },
  }),

  setFreeDownloads: defineAdminAction({
    accept: 'json',
    input: z.object({ userId: z.string().min(1), remaining: z.coerce.number().int().min(0).max(50) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const userId = new ObjectId(input.userId);
      const before = await findUserById(db, userId);
      if (!before) throw new ActionError({ code: 'NOT_FOUND', message: 'USER_NOT_FOUND' });

      try {
        await setFreeDownloads(db, userId, input.remaining);
      } catch (err) {
        throw toUserActionError(err);
      }

      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: 'user.free_downloads',
        targetType: 'user',
        targetId: input.userId,
        before: { freeDownloadsRemaining: before.freeDownloadsRemaining },
        after: { freeDownloadsRemaining: input.remaining },
      });

      return { ok: true };
    },
  }),

  createUser: defineAdminAction({
    accept: 'json',
    input: z.object({
      name: z.string().min(1),
      email: z.string().min(1),
      password: z.string().min(1),
      role: z.enum(['admin', 'customer']),
    }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      let created;
      try {
        created = await createUser(db, input);
      } catch (err) {
        throw toUserActionError(err);
      }

      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: 'user.create',
        targetType: 'user',
        targetId: created._id.toString(),
        after: { email: created.email, role: created.role },
      });

      return { userId: created._id.toString() };
    },
  }),

  setUserRole: defineAdminAction({
    accept: 'json',
    input: z.object({ userId: z.string().min(1), role: z.enum(['admin', 'customer']) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const actor = await requireAdmin(context);
      const target = await findUserById(db, new ObjectId(input.userId));
      if (!target) throw new ActionError({ code: 'NOT_FOUND', message: 'USER_NOT_FOUND' });

      await assertNotLastAdmin(db, actor.id, target, input.role === 'admin' ? 'admin' : 'customer', target.disabled);

      try {
        await setUserRole(db, target._id, input.role);
      } catch (err) {
        throw toUserActionError(err);
      }

      await writeAuditLog(db, {
        actor: actor.email,
        action: 'user.role',
        targetType: 'user',
        targetId: input.userId,
        before: { role: target.role },
        after: { role: input.role },
      });

      return { ok: true };
    },
  }),

  setUserDisabled: defineAdminAction({
    accept: 'json',
    input: z.object({ userId: z.string().min(1), disabled: z.boolean() }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const actor = await requireAdmin(context);
      const target = await findUserById(db, new ObjectId(input.userId));
      if (!target) throw new ActionError({ code: 'NOT_FOUND', message: 'USER_NOT_FOUND' });

      await assertNotLastAdmin(db, actor.id, target, target.role, input.disabled);

      await setUserDisabled(db, target._id, input.disabled);
      await writeAuditLog(db, {
        actor: actor.email,
        action: input.disabled ? 'user.disable' : 'user.enable',
        targetType: 'user',
        targetId: input.userId,
        before: { disabled: target.disabled },
        after: { disabled: input.disabled },
      });

      return { ok: true };
    },
  }),

  resetUserPassword: defineAdminAction({
    accept: 'json',
    input: z.object({ userId: z.string().min(1), password: z.string().min(1) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const userId = new ObjectId(input.userId);
      try {
        await setUserPassword(db, userId, input.password);
      } catch (err) {
        throw toUserActionError(err);
      }

      // The new password itself is never written to the audit log — only the fact that
      // a reset happened, and who did it.
      await writeAuditLog(db, {
        actor: await actorEmail(context),
        action: 'user.password.reset',
        targetType: 'user',
        targetId: input.userId,
      });

      return { ok: true };
    },
  }),
};
