// Astro-runtime-only. Reads `astro:env/server`, which only resolves inside Astro's
// build/dev runtime — plain `tsx` scripts (scripts/ingest.ts, scripts/init-db.ts) cannot
// import this file; they use scripts/config.ts instead, which reads process.env directly.
// This split is what keeps lib/db.ts and lib/storage.ts free of any env-reading of their
// own (they take config as parameters), so both the Astro app and the CLI scripts can
// assemble the same config shape for the same underlying, testable implementations.
import {
  DOWNLOAD_TOKEN_MAX_USES,
  DOWNLOAD_TOKEN_TTL_DAYS,
  GCS_ACCESS_KEY_ID,
  GCS_BUCKET,
  GCS_ORIGINALS_PREFIX,
  GCS_PUBLIC_BASE_URL,
  GCS_PUBLIC_PREFIX,
  GCS_SECRET_ACCESS_KEY,
  LOCAL_STORAGE_DIR,
  MONGODB_DB_NAME,
  MONGODB_URI,
  STORAGE_DRIVER,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
} from 'astro:env/server';
// `client`-context vars are also readable from server code (they're a subset exposed
// everywhere) — used here to build absolute Stripe success/cancel URLs.
import { PUBLIC_SITE_URL } from 'astro:env/client';
import type { DbConfig } from './db';
import { createStorageAdapter, type GcsConfig, type StorageAdapter } from './storage';

export function getDbConfig(): DbConfig {
  return { uri: MONGODB_URI, dbName: MONGODB_DB_NAME };
}

export type StorageDriver = 'gcs' | 'local';

/** Where the local driver's admin upload route lives. The browser PUTs here instead of
 *  to a cloud presigned URL; the route is admin-guarded like any other panel surface. */
export const LOCAL_UPLOAD_ROUTE = '/api/admin/upload';
/** Prefix `src/pages/local-public/[...key].ts` serves derivatives from. */
export const LOCAL_PUBLIC_ROUTE = '/local-public';

export function getStorageDriver(): StorageDriver {
  return STORAGE_DRIVER as StorageDriver;
}

/**
 * The GCS vars are `optional` in the `astro:env` schema because the `local` driver
 * doesn't want them — validation moves here instead, where it can name the missing
 * variable and the driver that wanted it, rather than failing later as an opaque SDK
 * error mid-upload.
 */
function required(name: string, value: string | undefined, driver: StorageDriver): string {
  if (!value) {
    throw new Error(`${name} is required when STORAGE_DRIVER=${driver}. See .env.example.`);
  }
  return value;
}

export function getGcsConfig(): GcsConfig {
  return {
    accessKeyId: required('GCS_ACCESS_KEY_ID', GCS_ACCESS_KEY_ID, 'gcs'),
    secretAccessKey: required('GCS_SECRET_ACCESS_KEY', GCS_SECRET_ACCESS_KEY, 'gcs'),
    bucket: required('GCS_BUCKET', GCS_BUCKET, 'gcs'),
    originalsPrefix: GCS_ORIGINALS_PREFIX,
    publicPrefix: GCS_PUBLIC_PREFIX,
    publicBaseUrl: GCS_PUBLIC_BASE_URL || undefined,
  };
}

export function getLocalStorageDir(): string {
  return LOCAL_STORAGE_DIR;
}

/**
 * The single place the app decides *where bytes live*. Every page, action, and API route
 * calls this rather than naming a driver, so switching storage is one environment
 * variable and no code change.
 */
export function createStorage(): StorageAdapter {
  if (getStorageDriver() === 'local') {
    return createStorageAdapter('local', getLocalStorageDir(), {
      publicUrlBase: LOCAL_PUBLIC_ROUTE,
      uploadUrlBase: LOCAL_UPLOAD_ROUTE,
    });
  }
  return createStorageAdapter('gcs', getGcsConfig());
}

export function getStripeConfig() {
  return { secretKey: STRIPE_SECRET_KEY, webhookSecret: STRIPE_WEBHOOK_SECRET };
}

export function getDownloadConfig() {
  return { ttlDays: DOWNLOAD_TOKEN_TTL_DAYS, maxUses: DOWNLOAD_TOKEN_MAX_USES };
}

export function getPublicSiteUrl(): string {
  return PUBLIC_SITE_URL.replace(/\/$/, '');
}
