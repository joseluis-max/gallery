import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'astro/zod';
import { ActionError, defineAction } from 'astro:actions';
import { defineAdminAction } from './adminGuard';
import { clearAttempts, isRateLimited, recordFailedAttempt, verifyPassword } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { getAdminConfig, getDbConfig, getR2Config } from '../lib/config';
import { getDb } from '../lib/db';
import { ManualFulfillmentProvider } from '../lib/fulfillment';
import { processOriginal } from '../lib/images';
import type { PhotoDoc } from '../lib/photos';
import { serializeForAction } from '../lib/serialize';
import { uniqueSlug } from '../lib/slug';
import { createStorageAdapter, type StorageAdapter } from '../lib/storage';
import { getUploadJob, listUploadJobs as listUploadJobsQuery, updateUploadJob, type UploadJobDoc } from '../lib/uploadJobs';
import { defaultWatermarkConfig } from '../../watermark.config';
import type { Db } from 'mongodb';

const ALLOWED_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/tiff']);
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 24MP A7III originals run ~25MB; leaves headroom

const fulfillmentProvider = new ManualFulfillmentProvider();

/** Shared by completeUpload and retryUploadJob so there is exactly one place that pulls
 *  an original back from R2 and runs it through the sharp pipeline — the same
 *  lib/images.ts used by the CLI ingest script, per the no-duplicate-pipeline rule. */
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
      r2: { originalKey: job.originalKey, publicKey: publicWebpKey },
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

export const admin = {
  login: defineAction({
    accept: 'json',
    input: z.object({ password: z.string().min(1) }),
    handler: async (input, context) => {
      const ip = context.clientAddress ?? 'unknown';
      if (isRateLimited(ip)) {
        throw new ActionError({ code: 'TOO_MANY_REQUESTS', message: 'TOO_MANY_ATTEMPTS' });
      }

      const { passwordHash } = getAdminConfig();
      if (!verifyPassword(input.password, passwordHash)) {
        recordFailedAttempt(ip);
        throw new ActionError({ code: 'UNAUTHORIZED', message: 'INVALID_PASSWORD' });
      }

      clearAttempts(ip);
      await context.session?.regenerate();
      context.session?.set('adminAuthed', true);
      return { ok: true };
    },
  }),

  logout: defineAction({
    accept: 'json',
    input: z.object({}),
    handler: async (_input, context) => {
      context.session?.delete('adminAuthed');
      return { ok: true };
    },
  }),

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
      const storage = createStorageAdapter('r2', getR2Config());

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
    handler: async (input) => {
      const db = await getDb(getDbConfig());
      const storage = createStorageAdapter('r2', getR2Config());

      const job = await getUploadJob(db, new ObjectId(input.jobId));
      if (!job) throw new ActionError({ code: 'NOT_FOUND', message: 'UPLOAD_JOB_NOT_FOUND' });
      if (job.status !== 'awaiting-upload') {
        throw new ActionError({ code: 'CONFLICT', message: 'UPLOAD_JOB_ALREADY_PROCESSED' });
      }

      try {
        const { photoId, slug } = await processUploadJob(db, storage, job);
        await writeAuditLog(db, { actor: 'admin', action: 'photo.upload', targetType: 'photo', targetId: photoId.toString(), after: { slug } });
        return { photoId: photoId.toString(), slug };
      } catch (err) {
        throw new ActionError({ code: 'INTERNAL_SERVER_ERROR', message: err instanceof Error ? err.message : 'PROCESSING_FAILED' });
      }
    },
  }),

  retryUploadJob: defineAdminAction({
    accept: 'json',
    input: z.object({ jobId: z.string().min(1) }),
    handler: async (input) => {
      const db = await getDb(getDbConfig());
      const storage = createStorageAdapter('r2', getR2Config());

      const job = await getUploadJob(db, new ObjectId(input.jobId));
      if (!job) throw new ActionError({ code: 'NOT_FOUND', message: 'UPLOAD_JOB_NOT_FOUND' });
      if (job.status !== 'failed') {
        throw new ActionError({ code: 'CONFLICT', message: 'UPLOAD_JOB_NOT_FAILED' });
      }

      try {
        const { photoId, slug } = await processUploadJob(db, storage, job);
        await writeAuditLog(db, { actor: 'admin', action: 'photo.upload.retry', targetType: 'photo', targetId: photoId.toString(), after: { slug } });
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
    handler: async (input) => {
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
        actor: 'admin',
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
    handler: async (input) => {
      const db = await getDb(getDbConfig());
      const photoId = new ObjectId(input.photoId);
      const before = await db.collection<PhotoDoc>('photos').findOne({ _id: photoId });
      if (!before) throw new ActionError({ code: 'NOT_FOUND', message: 'PHOTO_NOT_FOUND' });

      const status = input.published ? 'published' : 'draft';
      await db.collection('photos').updateOne({ _id: photoId }, { $set: { status, updatedAt: new Date() } });
      await writeAuditLog(db, {
        actor: 'admin',
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
    handler: async (input) => {
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

      const storage = createStorageAdapter('r2', getR2Config());
      await Promise.allSettled([
        storage.deleteObject({ bucket: 'originals', key: photo.r2.originalKey }),
        storage.deleteObject({ bucket: 'public', key: photo.r2.publicKey }),
        storage.deleteObject({ bucket: 'public', key: photo.r2.publicKey.replace(/\.webp$/i, '.jpg') }),
      ]);

      await db.collection('photos').deleteOne({ _id: photoId });
      await writeAuditLog(db, { actor: 'admin', action: 'photo.delete', targetType: 'photo', targetId: input.photoId, before: { slug: photo.slug } });

      return { ok: true };
    },
  }),

  reorderPhotos: defineAdminAction({
    accept: 'json',
    input: z.object({ orderedIds: z.array(z.string().min(1)) }),
    handler: async (input) => {
      const db = await getDb(getDbConfig());
      await Promise.all(
        input.orderedIds.map((id, index) => db.collection('photos').updateOne({ _id: new ObjectId(id) }, { $set: { order: index } })),
      );
      await writeAuditLog(db, { actor: 'admin', action: 'photo.reorder', targetType: 'photo', targetId: 'bulk', after: { count: input.orderedIds.length } });
      return { ok: true };
    },
  }),

  markOrderShipped: defineAdminAction({
    accept: 'json',
    input: z.object({ orderId: z.string().min(1), carrier: z.string().min(1), tracking: z.string().min(1), notes: z.string().optional() }),
    handler: async (input) => {
      const db = await getDb(getDbConfig());
      const orderId = new ObjectId(input.orderId);
      const order = await fulfillmentProvider.markShipped(db, orderId, {
        carrier: input.carrier,
        tracking: input.tracking,
        notes: input.notes,
      });
      if (!order) throw new ActionError({ code: 'NOT_FOUND', message: 'ORDER_NOT_FOUND' });

      await writeAuditLog(db, {
        actor: 'admin',
        action: 'order.fulfill',
        targetType: 'order',
        targetId: input.orderId,
        after: { carrier: input.carrier, tracking: input.tracking },
      });

      return { ok: true };
    },
  }),

  saveSettings: defineAdminAction({
    accept: 'json',
    input: z.object({
      baseCents: z.coerce.number(),
      ratePerCm2Cents: z.coerce.number(),
      sizeTolerancePct: z.coerce.number(),
      minCm: z.coerce.number(),
      maxCmAbsolute: z.coerce.number(),
      digitalPriceCents: z.coerce.number(),
      paperStocks: z.record(z.string(), z.object({ label: z.object({ es: z.string(), en: z.string() }), multiplier: z.coerce.number() })),
      sizePresets: z.array(z.object({ label: z.string(), widthCm: z.coerce.number(), heightCm: z.coerce.number() })),
      shippingZones: z.array(z.object({ key: z.string(), label: z.string(), flatRateCents: z.coerce.number() })),
    }),
    handler: async (input) => {
      const db = await getDb(getDbConfig());
      const { getSettings, saveSettings: persistSettings } = await import('../lib/settings');
      const before = await getSettings(db);
      const after = await persistSettings(db, input);

      await writeAuditLog(db, { actor: 'admin', action: 'pricing.update', targetType: 'settings', targetId: 'singleton', before, after });

      return { ok: true };
    },
  }),
};
