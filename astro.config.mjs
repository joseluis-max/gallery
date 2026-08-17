// @ts-check
import { defineConfig, envField } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  site: process.env.PUBLIC_SITE_URL || 'http://localhost:4321',
  adapter: node({ mode: 'standalone' }),
  i18n: {
    locales: ['es', 'en'],
    defaultLocale: 'es',
    // 'manual' hands routing control to src/middleware.ts (via astro:i18n's
    // `middleware()`), applied there only to non-/admin paths. With the object form
    // (`{ prefixDefaultLocale: true }`), Astro's built-in i18n finalize step 404s EVERY
    // "page"-type route without a locale prefix project-wide — not just ones under
    // [lang] — which silently 404'd the entire /admin/* panel (confirmed by reading
    // astro/dist/i18n/router.js's matchPrefixAlways(): any non-prefixed pathname is
    // unconditionally { type: "notFound" }). See src/middleware.ts for the equivalent
    // behavior reproduced for the public site only.
    routing: 'manual',
  },
  // @astrojs/node would otherwise store sessions on the local filesystem, which breaks
  // the moment this runs on more than one instance (Cloud Run): a visitor would be
  // signed in or out depending on which container answered. Sessions live in Mongo
  // instead — see src/lib/sessionDriver.ts for why this is an entrypoint rather than
  // inline driver options.
  session: {
    driver: {
      // A URL, not './src/...': Astro resolves a *string* entrypoint relative to its own
      // internals (core/session/vite-plugin.js), so a project-relative path silently
      // fails to resolve. `new URL(..., import.meta.url)` anchors it to this config file.
      entrypoint: new URL('./src/lib/sessionDriver.ts', import.meta.url),
      config: { collectionName: 'sessions', ttlSeconds: 60 * 60 * 24 * 30 },
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  env: {
    schema: {
      // Public — safe to ship to the client
      PUBLIC_SITE_URL: envField.string({ context: 'client', access: 'public' }),

      // Which storage backend holds the image bytes. Both drivers implement the same
      // StorageAdapter interface (src/lib/storage.ts), so this is the only thing that
      // changes between them.
      //   gcs   — Google Cloud Storage via its S3-compatible API (needs the GCS_* vars)
      //   local — disk under LOCAL_STORAGE_DIR, served by the app itself. Development
      //           only: no CDN, and the bytes live wherever the process is running.
      // Defaults to gcs so a deployment that forgets to set it fails loudly on a missing
      // credential rather than silently writing customer uploads to a container's disk.
      STORAGE_DRIVER: envField.enum({ context: 'server', access: 'public', values: ['gcs', 'local'], default: 'gcs' }),
      LOCAL_STORAGE_DIR: envField.string({ context: 'server', access: 'public', default: 'tmp/local-storage' }),

      // Server-only, but not secret — never needs to reach the client bundle
      GCS_PUBLIC_BASE_URL: envField.string({ context: 'server', access: 'public', optional: true }),
      // One bucket, two prefixes. The public prefix is the ONLY part of the bucket that
      // may carry a public IAM binding — see the single-bucket section of the README.
      GCS_ORIGINALS_PREFIX: envField.string({ context: 'server', access: 'public', default: 'originals' }),
      GCS_PUBLIC_PREFIX: envField.string({ context: 'server', access: 'public', default: 'public' }),

      // Server secrets — never resolvable from client code
      MONGODB_URI: envField.string({ context: 'server', access: 'secret' }),
      MONGODB_DB_NAME: envField.string({ context: 'server', access: 'secret', default: 'valdiviezo' }),

      // GCS credentials are `optional` here on purpose: the local driver doesn't want
      // them, so the check lives in src/lib/config.ts where it can say which variable
      // which driver wanted.
      //
      // These are HMAC keys (Cloud Storage → Settings → Interoperability), NOT a
      // service-account JSON key — the S3-compatible API is what makes presigned
      // browser uploads work without routing 25MB files through the app server.
      GCS_ACCESS_KEY_ID: envField.string({ context: 'server', access: 'secret', optional: true }),
      GCS_SECRET_ACCESS_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      GCS_BUCKET: envField.string({ context: 'server', access: 'secret', optional: true }),

      STRIPE_SECRET_KEY: envField.string({ context: 'server', access: 'secret' }),
      STRIPE_WEBHOOK_SECRET: envField.string({ context: 'server', access: 'secret' }),

      // No ADMIN_PASSWORD_HASH: admin access is a `users` document with role 'admin'
      // (see src/lib/users.ts and `pnpm create-admin`), so there is no admin credential
      // in the environment at all.

      DOWNLOAD_TOKEN_TTL_DAYS: envField.number({ context: 'server', access: 'public', default: 7 }),
      DOWNLOAD_TOKEN_MAX_USES: envField.number({ context: 'server', access: 'public', default: 5 }),
    },
  },
});
