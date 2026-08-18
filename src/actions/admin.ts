import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'astro/zod';
import { ActionError } from 'astro:actions';
import { defineAdminAction, requireAdmin } from './adminGuard';
import { writeAuditLog } from '../lib/audit';
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
      maxPrintCm: processed.maxPrintCm,
      tags: [],
      collections: [],
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

      const originalKey = `uploads/${randomUUID()}-${input.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const now = new Date();
      const { insertedId } = await db.collection('uploadJobs').insertOne({
        status: 'awaiting-upload',
        originalKey,
        filename: input.filename,
        bytes: input.bytes,
        createdAt: now,
        updatedAt: now,
      });

      const uploadUrl = await storage.getPresignedPutUrl({ key: originalKey, contentType: input.contentType, expiresInSeconds: 900 });

      return { jobId: insertedId.toString(), uploadUrl, key: originalKey };
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
      if (job.status !== 'failed') {
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
      collections: z.array(z.string()),
      featured: z.boolean(),
      pricingOverride: z
        .object({
          baseCents: z.coerce.number().optional(),
          ratePerCm2Cents: z.coerce.number().optional(),
          digitalPriceCents: z.coerce.number().optional(),
        })
        .optional(),
    }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
      const photoId = new ObjectId(input.photoId);
      const before = await db.collection<PhotoDoc>('photos').findOne({ _id: photoId });
      if (!before) throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });

      const patch = {
        title: input.title,
        description: input.description,
        tags: input.tags,
        collections: input.collections,
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
        before: { title: before.title, description: before.description, tags: before.tags, collections: before.collections, featured: before.featured, pricing: before.pricing },
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

  reorderPhotos: defineAdminAction({
    accept: 'json',
    input: z.object({ orderedIds: z.array(z.string().min(1)) }),
    handler: async (input, context) => {
      const db = await getDb(getDbConfig());
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
