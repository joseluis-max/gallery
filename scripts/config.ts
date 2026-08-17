// Plain-Node counterpart to src/lib/config.ts, for scripts run via `tsx` outside the
// Astro runtime (scripts/ingest.ts, scripts/init-db.ts, scripts/hash-admin-password.ts).
// `astro:env` is not resolvable here, so we read process.env directly.
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { DbConfig } from '../src/lib/db.ts';
import { createStorageAdapter, type GcsConfig, type StorageAdapter } from '../src/lib/storage.ts';

if (existsSync('.env')) {
  // Node's built-in .env loader (stable since Node 20.6/22) — no `dotenv` dependency.
  process.loadEnvFile('.env');
}

// Mirrors astro.config.mjs's env schema: storage credentials are optional here too,
// because the local driver doesn't want them. `getStorageAdapter()` below is what
// enforces the selected driver's own variables — otherwise `pnpm run init-db` (which
// touches no storage at all) would refuse to run without GCS credentials.
const scriptEnvSchema = z.object({
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required — copy .env.example to .env and fill it in.'),
  MONGODB_DB_NAME: z.string().default('valdiviezo'),
  STORAGE_DRIVER: z.enum(['gcs', 'local']).default('gcs'),
  LOCAL_STORAGE_DIR: z.string().default('tmp/local-storage'),
  GCS_ACCESS_KEY_ID: z.string().optional(),
  GCS_SECRET_ACCESS_KEY: z.string().optional(),
  GCS_BUCKET: z.string().optional(),
  GCS_ORIGINALS_PREFIX: z.string().default('originals'),
  GCS_PUBLIC_PREFIX: z.string().default('public'),
  GCS_PUBLIC_BASE_URL: z.string().optional(),
});

let cached: z.infer<typeof scriptEnvSchema> | undefined;

function readEnv() {
  if (!cached) {
    const parsed = scriptEnvSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error('Missing/invalid environment variables for this script:');
      for (const issue of parsed.error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    cached = parsed.data;
  }
  return cached;
}

export function getDbConfig(): DbConfig {
  const env = readEnv();
  return { uri: env.MONGODB_URI, dbName: env.MONGODB_DB_NAME };
}

function required(name: string, value: string | undefined, driver: string): string {
  if (!value) {
    console.error(`${name} is required when STORAGE_DRIVER=${driver}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

export function getGcsConfig(): GcsConfig {
  const env = readEnv();
  return {
    accessKeyId: required('GCS_ACCESS_KEY_ID', env.GCS_ACCESS_KEY_ID, 'gcs'),
    secretAccessKey: required('GCS_SECRET_ACCESS_KEY', env.GCS_SECRET_ACCESS_KEY, 'gcs'),
    bucket: required('GCS_BUCKET', env.GCS_BUCKET, 'gcs'),
    originalsPrefix: env.GCS_ORIGINALS_PREFIX,
    publicPrefix: env.GCS_PUBLIC_PREFIX,
    publicBaseUrl: env.GCS_PUBLIC_BASE_URL,
  };
}

export function getStorageDriver(): 'gcs' | 'local' {
  return readEnv().STORAGE_DRIVER;
}

export function getLocalStorageDir(): string {
  return readEnv().LOCAL_STORAGE_DIR;
}

/** The CLI counterpart to `createStorage()` in src/lib/config.ts — same driver switch,
 *  so `pnpm ingest` writes wherever the app reads from. */
export function getStorageAdapter(): StorageAdapter {
  const env = readEnv();
  if (env.STORAGE_DRIVER === 'local') {
    return createStorageAdapter('local', env.LOCAL_STORAGE_DIR);
  }
  return createStorageAdapter('gcs', getGcsConfig());
}
