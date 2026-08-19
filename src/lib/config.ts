// Astro-runtime-only. Reads `astro:env/server`, which only resolves inside Astro's
// build/dev runtime — plain `tsx` scripts (scripts/ingest.ts, scripts/init-db.ts) cannot
// import this file; they use scripts/config.ts instead, which reads process.env directly.
// This split is what keeps lib/db.ts and lib/storage.ts free of any env-reading of their
// own (they take config as parameters), so both the Astro app and the CLI scripts can
// assemble the same config shape for the same underlying, testable implementations.
import {
  DOWNLOAD_TOKEN_MAX_USES,
  DOWNLOAD_TOKEN_TTL_DAYS,
  EMAIL_DRIVER,
  GCS_ACCESS_KEY_ID,
  GCS_BUCKET,
  GCS_ORIGINALS_PREFIX,
  GCS_PUBLIC_BASE_URL,
  GCS_PUBLIC_PREFIX,
  GCS_SECRET_ACCESS_KEY,
  LOCAL_STORAGE_DIR,
  MAILGUN_API_KEY,
  MAILGUN_BASE_URL,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MONGODB_DB_NAME,
  MONGODB_URI,
  PAYPHONE_STORE_ID,
  PAYPHONE_TOKEN,
  STORAGE_DRIVER,
} from 'astro:env/server';
// `client`-context vars are also readable from server code (they're a subset exposed
// everywhere) — used here for absolute links (sitemap, OG tags, emailed download URLs).
import { PUBLIC_SITE_URL } from 'astro:env/client';
import type { DbConfig } from './db';
import { createEmailProvider, type EmailDriver, type EmailProvider } from './email';
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

/** Mail is sent inline on the Payphone return leg, where a hung request would leave the
 *  buyer staring at a spinner instead of their receipt. Ten seconds is far longer than
 *  Mailgun's API normally takes and still short enough that a buyer never waits on it. */
const MAILGUN_TIMEOUT_MS = 10_000;

export function getStorageDriver(): StorageDriver {
  return STORAGE_DRIVER as StorageDriver;
}

/**
 * Credential-shaped vars are `optional` in the `astro:env` schema because only one
 * driver ever wants any given set — the GCS keys are dead weight under `local`, the
 * Mailgun keys under `console`. Validation moves here instead, where it can name both the
 * missing variable and the setting that asked for it, rather than failing later as an
 * opaque SDK error mid-upload or a silently unsent receipt.
 */
function required(name: string, value: string | undefined, when: string): string {
  if (!value) {
    throw new Error(`${name} is required when ${when}. See .env.example.`);
  }
  return value;
}

export function getGcsConfig(): GcsConfig {
  return {
    accessKeyId: required('GCS_ACCESS_KEY_ID', GCS_ACCESS_KEY_ID, 'STORAGE_DRIVER=gcs'),
    secretAccessKey: required('GCS_SECRET_ACCESS_KEY', GCS_SECRET_ACCESS_KEY, 'STORAGE_DRIVER=gcs'),
    bucket: required('GCS_BUCKET', GCS_BUCKET, 'STORAGE_DRIVER=gcs'),
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

/**
 * The single place the app decides *how mail leaves the building* — the exact counterpart
 * of `createStorage()` above, and for the same reason: callers state what they want sent,
 * never which provider sends it.
 *
 * A note on why this exists at all. Order confirmations previously went to a console stub
 * that no code ever replaced, so the download links — the entire deliverable of a digital
 * purchase — were printed to stdout and never delivered. `console` is therefore an opt-in
 * development mode here, not a fallback: an unconfigured production deployment throws on
 * the first send and shows up in the logs, rather than quietly appearing to work.
 */
export function createEmailer(): EmailProvider {
  const driver = EMAIL_DRIVER as EmailDriver;
  if (driver === 'console') return createEmailProvider({ driver: 'console' });

  const domain = required('MAILGUN_DOMAIN', MAILGUN_DOMAIN, 'EMAIL_DRIVER=mailgun');
  return createEmailProvider({
    driver: 'mailgun',
    apiKey: required('MAILGUN_API_KEY', MAILGUN_API_KEY, 'EMAIL_DRIVER=mailgun'),
    domain,
    // Defaulted rather than required. Mailgun refuses any From outside the sending domain,
    // so an address on `domain` itself is the one value guaranteed to be accepted — which
    // makes it a better default than a third variable that has to be correct before
    // anything can send at all. Set MAILGUN_FROM to control the display name or use a
    // reply-able address.
    from: MAILGUN_FROM || `José Valdiviezo <no-reply@${domain}>`,
    baseUrl: MAILGUN_BASE_URL,
    timeoutMs: MAILGUN_TIMEOUT_MS,
  });
}

/**
 * Payphone's credentials. The token is a `secret` astro:env var, but note that it does
 * legitimately reach the browser: the Cajita widget takes it as configuration. Payphone's
 * mitigation is that a store's widget only runs on the domain registered in their console,
 * so a token lifted from the page HTML is not usable from anywhere else.
 *
 * What that domain lock does NOT cover is the confirm endpoint, which the same token
 * authorizes and which is terminal — see `newClientTransactionId` in lib/payphone.ts for
 * why the attempt ids carry 64 bits of entropy.
 */
export function getPayphoneConfig() {
  return { token: PAYPHONE_TOKEN, storeId: PAYPHONE_STORE_ID };
}

export function getDownloadConfig() {
  return { ttlDays: DOWNLOAD_TOKEN_TTL_DAYS, maxUses: DOWNLOAD_TOKEN_MAX_USES };
}

export function getPublicSiteUrl(): string {
  return PUBLIC_SITE_URL.replace(/\/$/, '');
}
