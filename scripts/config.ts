// Plain-Node counterpart to src/lib/config.ts, for scripts run via `tsx` outside the
// Astro runtime (scripts/ingest.ts, scripts/init-db.ts, scripts/hash-admin-password.ts).
// `astro:env` is not resolvable here, so we read process.env directly.
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { DbConfig } from '../src/lib/db.ts';
import type { R2Config } from '../src/lib/storage.ts';

if (existsSync('.env')) {
  // Node's built-in .env loader (stable since Node 20.6/22) — no `dotenv` dependency.
  process.loadEnvFile('.env');
}

const scriptEnvSchema = z.object({
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required — copy .env.example to .env and fill it in.'),
  MONGODB_DB_NAME: z.string().default('valdiviezo'),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_ORIGINALS: z.string().default('originals'),
  R2_BUCKET_PUBLIC: z.string().default('public'),
  R2_PUBLIC_BASE_URL: z.string().min(1),
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

export function getR2Config(): R2Config {
  const env = readEnv();
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucketOriginals: env.R2_BUCKET_ORIGINALS,
    bucketPublic: env.R2_BUCKET_PUBLIC,
    publicBaseUrl: env.R2_PUBLIC_BASE_URL,
  };
}
