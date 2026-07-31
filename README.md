# José Valdiviezo — Photography Gallery & Print Shop

A white, minimalist, bilingual (es/en) Astro storefront for a Galápagos wildlife/landscape
photographer based in Cuenca, Ecuador. Sells physical prints in customer-chosen sizes and
digital downloads, with a full admin panel for uploads, catalog, orders, and settings.

## Stack

- **Astro 7** (SSR, `output: 'server'`) + **@astrojs/node** (standalone)
- **Tailwind CSS 4** (CSS-first `@theme`, via the Vite plugin)
- **MongoDB Atlas** (`mongodb` driver)
- **Cloudflare R2** (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- **Stripe** (hosted Checkout Sessions)
- **sharp** (image pipeline — CLI ingest and admin browser upload share the same code)
- **zod 4** (Actions input, `astro:env` schema)
- **vitest** (unit tests for the framework-independent `lib/` layer)

## The one thing that actually enforces the paywall

Two physically separate classes of image bytes live in two different R2 buckets:

| | Bucket | Access | What it is |
|---|---|---|---|
| **Original** | `originals` | Private — no public URL, ever | Untouched 24MP A7III file |
| **Derivative** | `public` | Public + CDN | ≤2000px long edge, watermark burned in, EXIF stripped |

The public site only ever renders `public/` derivatives. There is no code path from a
public page to an original. After Stripe confirms payment, a short-lived (5-minute)
presigned URL to the original is minted on demand and bound to a single-use-limited,
expiring download token — never a durable public link.

**Honest limitation:** anything rendered in a browser can be screenshotted. That is not
fixable from the server side, and this project doesn't pretend otherwise. The defenses
that actually work are the ≤2000px downscale (a screenshot of that won't print
acceptably at 40×60cm) and the burned-in bottom-left watermark. The `oncontextmenu`/drag
suppression in `BaseLayout.astro` is explicitly labelled in its own comment as a courtesy
speed bump against casual right-click-save, not a real control.

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in real values — see "Environment variables" below
pnpm dev
```

### Bootstrapping data

1. **Seed placeholder photos** (see "About the sample photos" below):
   ```bash
   pnpm run generate:placeholders
   ```
2. **Create MongoDB collections/indexes** (needs a real `MONGODB_URI`):
   ```bash
   pnpm run init-db
   ```
3. **Ingest photos** — real run uploads to R2 and upserts Mongo; `--dry-run` writes
   derivatives to `./tmp/ingest-preview/` and prints the planned document instead:
   ```bash
   pnpm ingest ./seed/photos --collection galapagos --dry-run
   pnpm ingest ./seed/photos --collection galapagos   # real run, needs R2 + Mongo
   ```
4. **Generate an admin password hash**, then paste it into `.env` as
   `ADMIN_PASSWORD_HASH`:
   ```bash
   pnpm hash-admin-password "your-real-password"
   ```

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Astro dev server |
| `pnpm build` | Production build (`dist/`) |
| `pnpm preview` | Preview the production build |
| `pnpm check` | `astro check` — type-checks `.astro`/`.ts` |
| `pnpm test` | Unit tests (vitest) |
| `pnpm ingest <dir> [--collection=x] [--dry-run]` | Run the image pipeline over a folder |
| `pnpm run init-db` | Create Mongo collections + indexes |
| `pnpm run generate:placeholders` | Generate synthetic test photos from `seed/metadata.json` |
| `pnpm hash-admin-password <password>` | Print a scrypt hash for `ADMIN_PASSWORD_HASH` |

## Environment variables

See `.env.example` for the full list with inline comments. Summary:

- `PUBLIC_SITE_URL` — absolute site URL, used for hreflang/sitemap/OG tags.
- `MONGODB_URI`, `MONGODB_DB_NAME` — Atlas connection.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_ORIGINALS`,
  `R2_BUCKET_PUBLIC`, `R2_PUBLIC_BASE_URL` — Cloudflare R2. The originals bucket must
  have **no public access policy and no CDN binding** — that's the enforcement boundary.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Stripe (test-mode keys while developing).
- `ADMIN_PASSWORD_HASH` — output of `pnpm hash-admin-password`.
- `DOWNLOAD_TOKEN_TTL_DAYS` (default 7), `DOWNLOAD_TOKEN_MAX_USES` (default 5).

`astro:env` validates all of this at startup — a missing required secret fails fast
rather than surfacing as a confusing runtime error later.

## About the sample photos

`seed/photos/` currently holds 16 real Galápagos frames (sea lions on the Puerto Ayora
docks, brown pelicans on lava rock and the town beach, a giant tortoise in the
highlands, a couple of seascapes) — shared over WhatsApp, so they're compressed re-encodes
(~1600×1069, 0.1–0.4MB) rather than the full 24MP Sony A7III originals, but genuinely
José's own photography rather than placeholders. `seed/metadata.json` — committed, plain
JSON — has the real slugs, bilingual titles/descriptions, and tags matched to each one by
slug. The photos themselves are **git-ignored** (like the real full-res originals would
be) since they're binary content.

Since a fresh clone of this repo won't have those WhatsApp photos, `pnpm run
generate:placeholders` remains available as a fallback: it reads the same
`seed/metadata.json` (which also carries `targetWidth`/`targetHeight`/
`placeholderOrientation` fields for exactly this purpose) and generates 16 **synthetic
gradient JPEGs** at realistic full-sensor dimensions, written to `seed/photos/`. One
fixture (`pelican-in-mangrove.jpg`) is deliberately tagged with EXIF orientation 6,
mimicking a real sideways-camera shot, so `pnpm ingest`'s auto-rotate logic has something
to correct even without real photos on hand.

Before shooting for production, point `pnpm ingest` at the actual full-res Sony A7III
originals — that's the whole reason `scripts/ingest.ts` takes an arbitrary input
directory rather than being hardcoded to `seed/photos/`.

### Previewing the gallery locally without R2

`scripts/seed-preview.ts` (`pnpm tsx scripts/seed-preview.ts`) is a dev-only convenience:
it runs the real photos through the real image pipeline, writes the watermarked
derivatives straight into `public/local-public/` (served by Astro itself, git-ignored),
and upserts them into Mongo as `status: 'published'` — so the actual gallery, detail, and
admin pages render against real content and a real database with zero R2 setup. Requires
a real `MONGODB_URI`; doesn't touch R2 or Stripe. Not part of the production ingest path
— `pnpm ingest` (uploads to R2, defaults new photos to `draft`) is what actually publishes
a shoot.

## Architecture notes

- **`lib/` is framework-independent.** `lib/pricing.ts`, `lib/images.ts`,
  `lib/downloads.ts`, `lib/storage.ts`, `lib/cart.ts` etc. take configuration as
  parameters and never import `astro:env` or Mongo/R2 clients directly — that's what
  makes them unit-testable and shared cleanly between the Astro app and the plain-Node
  CLI scripts (`scripts/ingest.ts`, `scripts/init-db.ts`).
- **One image pipeline, two entry points.** `lib/images.ts`'s `processOriginal()` is
  called identically by `scripts/ingest.ts` (CLI) and the admin upload flow
  (`src/actions/admin.ts`'s `completeUpload`/`retryUploadJob`) — there is no second,
  divergent implementation of the watermark/rotate/derivative logic.
- **Prices are computed server-side only, every time.** `lib/pricing.ts`'s
  `computePrintPrice()` is a pure function of `(input, ctx)` fed identically by the live
  quote UI action (`quotePrice`) and the checkout action's authoritative re-pricing. The
  client sends dimensions/paper/qty; it never sends a price, and nothing trusts one if
  it did.
- **Download tokens are single-use-capped and expiring, never durable links.** Only a
  SHA-256 hash of the token is stored; the raw value exists only in memory long enough
  to email it once. Consuming a token is one atomic `findOneAndUpdate` with the
  expiry/use-cap guards baked into the filter, to avoid a race where concurrent requests
  could exceed `maxUses`.
- **Every admin mutation writes an audit log entry** via the single `writeAuditLog()`
  helper (`lib/audit.ts`), and every admin Action (except `login`) is defined through
  `defineAdminAction()` (`src/actions/adminGuard.ts`), which enforces the session check
  structurally rather than relying on each handler remembering to call it.
- **Admin sign-in lives inline at `/admin`**, not on a separate route — one entry point
  into the panel, with no separate login route to guard.
- **`i18n.routing` is `'manual'`, applied selectively in `src/middleware.ts`.** Astro's
  built-in (non-manual) i18n enforcement 404s *every* "page"-type route without a locale
  prefix, project-wide — not just ones nested under `[lang]`. That silently 404'd the
  entire `/admin/*` panel (a real bug, confirmed by reading `astro/dist/i18n/router.js`:
  `matchPrefixAlways()` returns `{type:"notFound"}` unconditionally for any non-prefixed
  pathname). The fix: `routing: 'manual'` in `astro.config.mjs` hands control to
  `src/middleware.ts`, which calls `astro:i18n`'s `middleware()` helper itself — but only
  for non-`/admin` paths — reproducing the exact same locale-prefix behavior for the
  public site while leaving the (deliberately non-bilingual) admin panel alone.
- **No email provider was specified.** `lib/email.ts` is a small provider interface with
  a console-log fallback (`ConsoleEmailProvider`). Swap in a real provider (Resend,
  Postmark, SendGrid, ...) by implementing `EmailProvider` and calling
  `setEmailProvider()` once at startup.
- **Fulfilment is manual today, pluggable later.** `lib/fulfillment.ts`'s
  `FulfillmentProvider` interface has one implementation (`ManualFulfillmentProvider` —
  José enters carrier/tracking by hand in `/admin/orders/[id]`); a Prodigi/Gelato adapter
  can drop in later without touching order code.

## Verification performed in this build

A real MongoDB Atlas cluster was connected and used for live verification later in the
build (Cloudflare R2 and Stripe credentials remain throwaway placeholders — `.env` still
satisfies `astro:env`'s startup validation only for those). What was actually verified:

- **Live against real Atlas:** `pnpm run init-db` (collections/indexes created for real),
  `scripts/seed-preview.ts` (real photos through the real image pipeline, published to
  real Mongo), then the actual gallery, homepage, collection, and detail pages — plus the
  full admin panel (dashboard, photos catalog, sign-in/session/logout) — rendered against
  a real database, checked via both `astro dev` and the compiled production build
  (`node dist/server/entry.mjs`). This is what surfaced two real bugs, both fixed and
  verified: `SizePicker.astro` hardcoded the Spanish paper-stock label regardless of page
  locale (now takes `lang` and reads `stock.label[lang]`), and the `/admin/*` panel was
  silently 404ing under every route except its own entry point due to Astro's built-in
  i18n enforcement (see `i18n.routing` note above) — invisible in casual dev-server
  browsing because the browser still renders a 404-status body, only caught by explicitly
  checking `fetch()` response status codes.

- `pnpm build` and `pnpm check` — clean, including under Astro 7's stricter Rust
  compiler (unclosed tags are hard errors now).
- `pnpm test` — 85 unit tests covering `lib/pricing.ts` (aspect tolerance, `maxPrintCm`
  rejection, paper multipliers, per-photo overrides, custom-size clamping),
  `lib/downloads.ts` (token generation/hashing, expiry/exhaustion, the atomic
  consume-token race guard), `lib/orders.ts` (the `status:'pending'` guard filter that
  makes double-processing a payment structurally impossible, conditional customer/
  shipping-address merge), `lib/storage.ts` (local adapter real I/O, R2 adapter checksum
  config), `lib/images.ts` (run for real against the generated placeholders — including
  asserting the sideways fixture comes out correctly oriented and that watermark
  compositing visibly changes the expected pixel region), `lib/auth.ts` (password
  hash/verify, rate limiting), `lib/cart.ts`, `lib/slug.ts`, `lib/serialize.ts`, the
  download-delivery API route's status-code mapping, and the Stripe webhook route
  (missing/invalid signature, first-time processing, idempotent replay of an
  already-processed event, and that a mid-handler failure leaves the event unmarked so
  Stripe's own retry can reprocess it).
- `pnpm ingest ./seed/photos --dry-run` — full pipeline (EXIF read, auto-rotate,
  watermark, derivative encode, LQIP) against the synthetic placeholders, with the
  sideways fixture visually confirmed to come out upright and the watermark confirmed
  legible over both light and dark backgrounds.
- Live dev-server smoke test: theme toggle persists with no flash across reloads and
  `<ClientRouter />` navigations; unsupported-locale routes (e.g. `/fr/...`) 404 via
  middleware; the root `/` → `/es/` redirect works; `prefers-reduced-motion` styling
  loads correctly; the Stripe webhook route correctly rejects requests with a missing or
  invalid signature (no live Stripe account needed for signature verification itself);
  the full admin sign-in flow (unauthenticated → form → submit → session set → guarded
  pages recognize the session → logout) was exercised live end-to-end.

### Deferred — needs real R2/Stripe credentials, not part of this session

Once real R2 and Stripe values are in `.env` (real `MONGODB_URI` is already live):

- [ ] A real (non-dry-run) `pnpm ingest`, uploading to real R2.
- [ ] Confirm `curl`-ing an `originals/` key directly returns 403 (no public policy).
- [ ] Cart/checkout pages against real seeded data (gallery/detail/admin already verified
      live — see above).
- [ ] Stripe test-mode checkout end to end: `stripe listen --forward-to
      localhost:4321/api/stripe-webhook`, pay with `4242 4242 4242 4242`, confirm the
      order flips to `paid`, a download token is minted, the emailed link delivers the
      original as an attachment, and a **replayed webhook mints no second token**.
- [ ] Confirm an expired/over-used download token 403s, and that hitting the order
      success URL without ever paying leaves the order `pending`.
- [ ] Admin: upload a real ~25MB A7III frame through `/admin/upload`, confirm in the
      network panel that it goes **directly to R2** (never through the app server),
      lands as a draft, shows the watermarked preview, and only becomes publicly visible
      after clicking publish. Confirm a failed job stays retryable.
- [ ] Edit a price in `/admin/settings`, confirm the before/after diff appears in
      `/admin/activity`.
- [ ] Lighthouse pass on the gallery for CLS/LCP (needs real images served over HTTP).

## Deploying

`output: 'server'` + `@astrojs/node` standalone — deploy `dist/` plus `node_modules` to
Fly.io, Railway, Render, or a plain VPS, run `node dist/server/entry.mjs`, and set the
environment variables from `.env.example` on the host. Point the Stripe webhook endpoint
at `https://<your-domain>/api/stripe-webhook` in the Stripe dashboard once deployed.
