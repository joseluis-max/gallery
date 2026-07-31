// Astro-runtime-only. Reads `astro:env/server`, which only resolves inside Astro's
// build/dev runtime — plain `tsx` scripts (scripts/ingest.ts, scripts/init-db.ts) cannot
// import this file; they use scripts/config.ts instead, which reads process.env directly.
// This split is what keeps lib/db.ts and lib/storage.ts free of any env-reading of their
// own (they take config as parameters), so both the Astro app and the CLI scripts can
// assemble the same config shape for the same underlying, testable implementations.
import {
  ADMIN_PASSWORD_HASH,
  DOWNLOAD_TOKEN_MAX_USES,
  DOWNLOAD_TOKEN_TTL_DAYS,
  MONGODB_DB_NAME,
  MONGODB_URI,
  R2_ACCESS_KEY_ID,
  R2_ACCOUNT_ID,
  R2_BUCKET_ORIGINALS,
  R2_BUCKET_PUBLIC,
  R2_PUBLIC_BASE_URL,
  R2_SECRET_ACCESS_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
} from 'astro:env/server';
// `client`-context vars are also readable from server code (they're a subset exposed
// everywhere) — used here to build absolute Stripe success/cancel URLs.
import { PUBLIC_SITE_URL } from 'astro:env/client';
import type { DbConfig } from './db';
import type { R2Config } from './storage';

export function getDbConfig(): DbConfig {
  return { uri: MONGODB_URI, dbName: MONGODB_DB_NAME };
}

export function getR2Config(): R2Config {
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucketOriginals: R2_BUCKET_ORIGINALS,
    bucketPublic: R2_BUCKET_PUBLIC,
    publicBaseUrl: R2_PUBLIC_BASE_URL,
  };
}

export function getStripeConfig() {
  return { secretKey: STRIPE_SECRET_KEY, webhookSecret: STRIPE_WEBHOOK_SECRET };
}

export function getAdminConfig() {
  return { passwordHash: ADMIN_PASSWORD_HASH };
}

export function getDownloadConfig() {
  return { ttlDays: DOWNLOAD_TOKEN_TTL_DAYS, maxUses: DOWNLOAD_TOKEN_MAX_USES };
}

export function getPublicSiteUrl(): string {
  return PUBLIC_SITE_URL.replace(/\/$/, '');
}
