// @ts-check
import { existsSync } from 'node:fs';
import { defineConfig, envField } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

// Astro loads .env into `astro:env` and `import.meta.env`, but NOT into `process.env`.
// src/lib/sessionDriver.ts reads `process.env` at runtime on purpose — that's what keeps
// the database URI out of the built bundle — so under `astro dev` sessions would throw
// "MONGODB_URI is required for session storage" and every cart and sign-in would fail.
// This bridges the two for local development only: the production container supplies real
// environment variables, .env is excluded from the image by .dockerignore, and this config
// file is never executed by `node dist/server/entry.mjs`.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

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
  // NOT "CSRF protection off" — moved. Astro's built-in check compares the browser's
  // `Origin` against the URL the server assembled for the request, and on the standalone
  // Node adapter that URL's scheme comes from `req.socket.encrypted` with
  // `x-forwarded-proto` never consulted. Cloud Run terminates TLS at its edge and speaks
  // plain HTTP to the container, so the comparison was always `http://josevaldiviezo.com`
  // against `https://josevaldiviezo.com` and every form-encoded POST 403'd in production —
  // which meant precisely one thing, the bank-transfer comprobante upload, the app's only
  // `accept: 'form'` action. src/middleware.ts runs the identical rules with a
  // proxy-aware notion of "same origin"; see src/lib/csrf.ts.
  security: { checkOrigin: false },
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

      // Payphone's bearer token, from the Payphone Developer console. It authorizes both
      // the Cajita widget and the server-side confirm call.
      //
      // `server`/`secret` even though the widget needs it in the browser. The checkout
      // page is server-rendered and hands it to the widget per request; making it a
      // `client` var instead would inline it into the built output at build time, which
      // means it lands in the container image (contradicting the deploy model where
      // secrets arrive from Secret Manager at revision start), rotation becomes a rebuild,
      // and it inherits the whole Dockerfile ARG / --build-arg apparatus PUBLIC_SITE_URL
      // already needs. Server context also means astro:env refuses to resolve it from
      // client code at all, so the exposure can only ever be one deliberate line in one
      // .astro file rather than an accident of an import.
      PAYPHONE_TOKEN: envField.string({ context: 'server', access: 'secret' }),
      // Identifies the store, not a credential, and it reaches the browser in the widget
      // config regardless — but it is `secret` rather than `public` because astro:env
      // INLINES every public value into the built output. As a public var its value was
      // frozen at `docker build`, where the real store id does not exist (.dockerignore
      // excludes .env), so the image shipped the Dockerfile's placeholder and
      // cloudbuild.yaml's --set-env-vars could not override it — Payphone answered every
      // prepare call with 404 "La tienda asociada no existe". `secret` is astro:env's only
      // runtime-resolved access level, so it is how "read this at container start" has to
      // be spelled; MONGODB_DB_NAME and GCS_BUCKET above are the same shape, and neither
      // of those is a credential either.
      PAYPHONE_STORE_ID: envField.string({ context: 'server', access: 'secret' }),

      // No ADMIN_PASSWORD_HASH: admin access is a `users` document with role 'admin'
      // (see src/lib/users.ts and `pnpm create-admin`), so there is no admin credential
      // in the environment at all.

      DOWNLOAD_TOKEN_TTL_DAYS: envField.number({ context: 'server', access: 'public', default: 7 }),
      DOWNLOAD_TOKEN_MAX_USES: envField.number({ context: 'server', access: 'public', default: 5 }),

      // --- Email ---
      // How order confirmations actually leave the building: console | mailgun.
      //
      // Defaults to `mailgun`, not `console`, and unlike STORAGE_DRIVER that default is
      // about a *silent* failure rather than a loud one. What shipped before this was a
      // console-log stub that no code ever replaced, so every receipt since the store
      // opened — and with it every download link, which is the entire deliverable of a
      // digital purchase — was printed to stdout and never sent, while the order page
      // cheerfully told the buyer to check their inbox. An unconfigured deployment now
      // throws on the first send instead.
      //
      // `secret` for the runtime-resolution reason spelled out on PAYPHONE_STORE_ID below,
      // not because a driver name is confidential: astro:env inlines every `public` value
      // at build time, and .dockerignore keeps .env out of the image, so a public var here
      // would freeze to whatever `docker build` saw and cloudbuild.yaml's --set-env-vars
      // could never move it.
      EMAIL_DRIVER: envField.enum({ context: 'server', access: 'secret', values: ['console', 'mailgun'], default: 'mailgun' }),

      // Mailgun's private API key (Dashboard → Sending → Domain settings → Sending API
      // keys) and the verified sending domain, e.g. mg.josevaldiviezo.com. Both are
      // `optional` in the schema and validated in src/lib/config.ts instead, so the
      // `console` driver doesn't demand credentials it will never use.
      MAILGUN_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      MAILGUN_DOMAIN: envField.string({ context: 'server', access: 'secret', optional: true }),
      // The From header. Must be an address ON the sending domain — Mailgun refuses
      // anything else — so config.ts defaults it to no-reply@<domain> rather than making a
      // third variable a prerequisite for any mail at all.
      MAILGUN_FROM: envField.string({ context: 'server', access: 'secret', optional: true }),
      // Mailgun runs two independent regions and an EU-provisioned domain answers ONLY on
      // api.eu.mailgun.net — a valid EU key against the US host returns 401, which reads
      // exactly like a bad key. If mail is rejected with a correct-looking key, this is the
      // first thing to check.
      MAILGUN_BASE_URL: envField.string({ context: 'server', access: 'secret', default: 'https://api.mailgun.net' }),
    },
  },
});
