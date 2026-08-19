# José Valdiviezo — Photography Gallery & Print Shop

A white, minimalist, bilingual (es/en) Astro storefront for a wildlife and nature
photographer based in Cuenca, Ecuador. Sells physical prints in customer-chosen sizes and
digital downloads, with customer accounts, and a full admin panel for uploads, catalog,
orders, customers, analytics, and settings.

## Stack

- **Astro 7** (SSR, `output: 'server'`) + **@astrojs/node** (standalone)
- **Tailwind CSS 4** (CSS-first `@theme`, via the Vite plugin)
- **MongoDB Atlas** (`mongodb` driver)
- **Google Cloud Storage** (one bucket, via its S3-compatible API — `@aws-sdk/client-s3`
  + `@aws-sdk/s3-request-presigner`), or local disk in development, selected with
  `STORAGE_DRIVER`
- **Payphone** (Cajita de Pagos widget — Ecuador's gateway; cards and the Payphone wallet)
- **sharp** (image pipeline — CLI ingest and admin browser upload share the same code)
- **zod 4** (Actions input, `astro:env` schema)
- **vitest** (unit tests for the framework-independent `lib/` layer)

## The one thing that actually enforces the paywall

Two separate classes of image bytes, under two prefixes of one bucket:

| | Prefix | Access | What it is |
|---|---|---|---|
| **Original** | `originals/` | Private — no public URL, ever | Untouched 24MP A7III file |
| **Derivative** | `public/` | Public + CDN | ≤2000px long edge, watermark burned in, EXIF stripped |

The public site only ever renders `public/` derivatives. There is no code path from a
public page to an original: `StorageAdapter.publicUrl()` takes no bucket parameter and
hardcodes the public prefix, so it is not *possible* to construct a public URL for an
original.

After Payphone's confirmation succeeds, a short-lived (5-minute) presigned URL to the original is
minted on demand and bound to a single-use-limited, expiring download token — never a
durable public link.

## Why this integration has no webhook

Payphone does not provide one. That is a property of the gateway, not an omission here,
and it makes the payment path structurally weaker than the Stripe integration it replaced.
The difference is worth stating plainly so it is not rediscovered later as a defect:

| | Stripe (before) | Payphone (now) |
|---|---|---|
| How we learn a payment happened | Signed webhook, pushed, retried for days | The buyer's browser returns to `/api/payphone-confirm`, and we **pull** the truth back |
| What proves it | HMAC signature over the payload | Nothing in the request. Only the confirm response we fetch ourselves |
| Idempotency | Provider event id | An atomic claim on our own attempt ledger (`claimConfirm`) |
| Buyer closes the tab | Webhook still arrives; the order fulfils | No confirm runs, and Payphone **auto-reverses the charge after 5 minutes** |

Three consequences shape the code:

1. **The `id` and `clientTransactionId` on the return URL are attacker-typeable.** The
   confirm route therefore verifies that the gateway's own reported amount equals the
   stored order total before anything is fulfilled. That check is the security boundary.
2. **Confirm is terminal** — a second call errors rather than returning the same answer —
   so `claimConfirm` grants exactly one request the right to make it, and a refresh or a
   second tab redirects without touching Payphone.
3. **Fulfilment has no retry safety net.** The confirm response is persisted *before* the
   order is touched, so a crash mid-fulfilment leaves durable evidence rather than a silent
   loss. The compensating control is the "payments needing attention" section on
   `/admin/orders`, which lists approved payments whose order never went `paid`, and
   confirms that started and never finished. It should always be empty.

The failure mode where a buyer closes the tab is the common one, and it is *safe*: the
reversal returns their money. The expensive one is a confirm that succeeded followed by a
process death — the charge stands and is not reversed — which is exactly what the admin
section exists to surface.

The separation between the two prefixes is a **per-object `public-read` ACL** on
derivatives — the bucket itself grants the public nothing. (GCS forbids IAM conditions
on `allUsers` bindings, so a prefix-scoped public policy isn't available; see "Storage
drivers" below.) A derivative that somehow missed its ACL is a broken thumbnail; there
is no path in this scheme where an original becomes public. Run `pnpm verify-storage`
to prove it holds.

**Honest limitation:** anything rendered in a browser can be screenshotted. That is not
fixable from the server side, and this project doesn't pretend otherwise. The defenses
that actually work are the ≤2000px downscale (a screenshot of that won't print
acceptably at 40×60cm) and the burned-in bottom-left watermark. The `oncontextmenu`/drag
suppression in `BaseLayout.astro` is explicitly labelled in its own comment as a courtesy
speed bump against casual right-click-save, not a real control.

What a screenshot *does* pick up is the second watermark: `PhotoWatermark.astro` paints a
repeating diagonal mark over the mosaic tiles, the detail image and the enlarged view, so
a captured frame carries the attribution across the whole photograph rather than in one
croppable corner. It's a CSS background — a determined visitor deletes the element in
devtools and it's gone, which is why it supplements the burned-in mark instead of
replacing it. The mark's text comes from the same `watermark.config.ts` the ingest
pipeline uses, so the two can't drift; density and opacity live in
`src/lib/watermarkOverlay.ts` (`DEFAULT_OVERLAY_OPACITY`, currently `0.28`) and in the
component's `TILE_PX`.

## The second payment method: direct bank transfer

Not every buyer in Ecuador wants to hand a card to a widget, and Payphone's per-transaction
cost is real on a $2 photograph. So the checkout page offers a second route: transfer the
money in your own banking app, upload the comprobante, and the photographer releases the
downloads once he has seen the money arrive.

**The account buyers are shown** lives in `BANK_ACCOUNT` in `src/lib/bankTransfer.ts` —
Banco Pichincha, cuenta de ahorro transaccional `2208996600`, José Luis Valdiviezo Peña,
cédula `0150454320`. It is a constant, not an environment variable and not an admin
setting: it is rendered on a public page, it changes roughly never, and a typo in it sends
money to a stranger with nothing downstream noticing. Changing it should be a diff someone
reviews.

The flow, and what is authoritative at each step:

| Step | Where | What it proves |
|---|---|---|
| Buyer picks "transferencia bancaria" | `/[lang]/checkout/[orderId]` → `/transfer` | Nothing. It's a link |
| Buyer transfers in their bank app | Outside this system entirely | — |
| Buyer uploads a receipt | `actions.transfer.submitReceipt` | Nothing. A screenshot is not evidence |
| **Admin approves** | `/admin/orders/[id]` | **This is the entire authorization** |
| Order is paid, tokens minted, links emailed | `fulfilOrder` | Same code the card path runs |

Five things about that are deliberate:

1. **The transfer page is its own route, not a tab.** `checkout/[orderId].astro` documents
   three obligations it carries for Payphone — the token in the HTML, a permissive
   `Referrer-Policy`, and a payment attempt written before the widget may render. A buyer
   paying by transfer should trip none of them, and in particular should not leave an
   unconfirmed Payphone attempt behind for every visit.
2. **Receipts go through the app, not a presigned PUT.** The admin upload path hands the
   browser a presigned URL because a 25MB original has no business transiting the app
   server; a receipt is a few hundred KB, and presigning would mean minting a bucket-write
   credential for an unauthenticated visitor. The 10MB cap and the content-type allowlist
   (`RECEIPT_TYPES`) are what make carrying the bytes safe.
3. **Receipts are private.** They land under `originals/` — a bank screenshot has an
   account number and a balance on it — and are readable only through
   `/api/admin/transfer-receipt/[id]`, which re-reads the admin from the database rather
   than trusting the session's `role`. That route is under `/api/`, so the middleware's
   blanket `/admin/*` page guard does **not** cover it; its own check is the only guard.
4. **Fulfilment is shared, not reimplemented.** `src/lib/fulfilment.ts` holds
   markOrderPaid → mint tokens → email, and both the Payphone return leg and the admin
   approval call it. An approved transfer delivers exactly what a card payment delivers,
   by construction rather than by two code paths agreeing.
5. **Approve is idempotent; reject is atomic.** Approval fulfils first and closes the
   review second, because `markOrderPaid` is the atomic gate — a double-click or a crash
   between the two steps cannot mint a second set of tokens, and a re-click simply tidies
   the queue. Rejection has no such downstream gate, so the atomic `closeTransferReview`
   claim *is* its guard: the loser of a race gets `ALREADY_REVIEWED` rather than sending a
   contradicting email.

The buyer is emailed twice on this path — once when the receipt lands ("we have it, we're
checking"), once when it is approved (the ordinary receipt with download links) or rejected
(with the reason the admin typed, which is required for exactly that purpose). A guest's
order URL is their only durable way back, which is why the first email exists at all even
though it delivers nothing.

**Where to watch it:** `/admin/transfers` is the queue, defaulting to `in-review`;
`/admin/orders` shows a banner when anything is waiting; the decision itself is on the
order page, where the receipt sits beside the total and the customer. Every approval and
rejection writes an `auditLog` entry naming the admin.

**What this method does not have:** any automated verification. Nothing in the codebase
reads a bank statement. If the photographer approves a receipt for a payment that never
arrived, the files go out — the control is a human comparing an amount against Banco
Pichincha, and the panel's job is only to put both numbers in front of him.

**Verified when this shipped:** `pnpm test` (279 unit tests, including 22 new ones over
`lib/bankTransfer.ts` and `lib/fulfilment.ts` — the receipt allowlist, the size cap, the
"buyer's filename never reaches the storage key" property, the supersede-then-insert order,
the `in-review` review claim, and that an already-paid order mints no second set of tokens
and sends no second receipt), `pnpm check` (0 errors) and `pnpm build`. Routing and the
guards were probed against a running dev server: a malformed order id 404s on both checkout
routes, `/admin/transfers` renders the login page rather than any queue content when signed
out, and `/api/admin/transfer-receipt/[id]` answers 401. **Not** exercised end to end
against real data — no test order was pushed through upload → approve → download, because
the only database configured here holds live orders.

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
3. **Ingest photos** — real run uploads to the configured bucket and upserts Mongo; `--dry-run` writes
   derivatives to `./tmp/ingest-preview/` and prints the planned document instead:
   ```bash
   pnpm ingest ./seed/photos --collection galapagos --dry-run
   pnpm ingest ./seed/photos --collection galapagos   # real run, needs GCS + Mongo
   ```
4. **Create the first admin account** (accounts live in Mongo, not in `.env`):
   ```bash
   pnpm create-admin jose@example.com "your-real-password" "José Valdiviezo"
   ```
   Re-running it against an existing address promotes that account to admin, re-enables
   it, and resets its password — which is also the way back in if every admin gets
   locked out.

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
| `pnpm verify-storage` | Prove the configured bucket works *and* that originals aren't public |
| `pnpm verify-email <address>` | Send a real test message through the configured provider |
| `pnpm run generate:placeholders` | Generate synthetic test photos from `seed/metadata.json` |
| `pnpm create-admin <email> <password> [name]` | Create (or promote) an admin account |

## Environment variables

See `.env.example` for the full list with inline comments. Summary:

- `PUBLIC_SITE_URL` — absolute site URL, used for hreflang/sitemap/OG tags.
- `MONGODB_URI`, `MONGODB_DB_NAME` — Atlas connection.
- `STORAGE_DRIVER` — `gcs` | `local` (default `gcs`). The `local` driver needs no
  credentials at all; a missing GCS variable fails at startup naming the variable *and*
  the driver that wanted it, rather than surfacing later as an opaque SDK error
  mid-upload.
- `GCS_ACCESS_KEY_ID`, `GCS_SECRET_ACCESS_KEY`, `GCS_BUCKET`, `GCS_ORIGINALS_PREFIX`,
  `GCS_PUBLIC_PREFIX`, `GCS_PUBLIC_BASE_URL` (optional) — Google Cloud Storage.
- `LOCAL_STORAGE_DIR` — where the `local` driver keeps its two prefixes.

  The bucket must grant the public nothing: derivatives are readable because of their
  own object ACL, which is what keeps `originals/` private in the same bucket.
- `PAYPHONE_TOKEN`, `PAYPHONE_STORE_ID` — Payphone, from their Developer console. The
  response URL (`/api/payphone-confirm`) and the authorized domain must be registered
  there too; see `.env.example`.
- `DOWNLOAD_TOKEN_TTL_DAYS` (default 7), `DOWNLOAD_TOKEN_MAX_USES` (default 5).
- `EMAIL_DRIVER` — `mailgun` | `console` (default **`mailgun`**). `console` prints
  messages instead of sending them and is a development mode you opt into; it is not the
  fallback, because a store whose product is a download link must not be able to fail
  silently. Verify with `pnpm verify-email <address>`.
- `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM` (optional, defaults to
  `no-reply@<domain>`), `MAILGUN_BASE_URL` (defaults to the US host). Set
  `MAILGUN_BASE_URL=https://api.eu.mailgun.net` for an EU-provisioned domain — an EU
  domain called on the US host returns 401, which reads exactly like a bad key.

  These are declared `access: 'secret'` in `astro.config.mjs` **including
  `EMAIL_DRIVER`**, which is not a credential. `secret` is astro:env's only
  runtime-resolved level; anything `public` is inlined at `docker build`, where `.env`
  does not exist, so `--set-env-vars` at deploy time could never move it. That is the
  exact failure `PAYPHONE_STORE_ID` already went through.

There is deliberately **no admin credential in the environment**. `ADMIN_PASSWORD_HASH`
used to live here; admin access is now a `users` document with `role: 'admin'`, created
with `pnpm create-admin`. An existing deployment can drop the variable from its `.env` —
nothing reads it — and run `pnpm create-admin` once to get back into the panel.

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

### Previewing the gallery locally without a bucket

`scripts/seed-preview.ts` (`pnpm tsx scripts/seed-preview.ts`) is a dev-only convenience:
it runs the real photos through the real image pipeline, writes the watermarked
derivatives straight into `public/local-public/` (served by Astro itself, git-ignored),
and upserts them into Mongo as `status: 'published'` — so the actual gallery, detail, and
admin pages render against real content and a real database with zero cloud setup.
Requires a real `MONGODB_URI`; touches neither GCS nor Payphone. Not part of the production
ingest path — `pnpm ingest` (uploads to the bucket, defaults new photos to `draft`) is what actually publishes
a shoot.

## Storage drivers

Where the image bytes live is one environment variable. Both drivers implement the same
`StorageAdapter` interface (`src/lib/storage.ts`), so nothing above that seam — the
pages, the admin panel, `pnpm ingest` — knows which one is in use.

| `STORAGE_DRIVER` | Backend | Browser upload goes to | Use it for |
|---|---|---|---|
| `gcs` | Google Cloud Storage, one bucket | GCS directly (presigned) | production |
| `local` | disk under `LOCAL_STORAGE_DIR` | the app's own admin route | development |

The default is `gcs`: a deployment that forgets to set `STORAGE_DRIVER` should fail
loudly on a missing credential, not silently write customer uploads to a container's
disk.

### Google Cloud Storage — one bucket, two prefixes

The live bucket is `gs://valdiviezo-gallery` (project `boxwood-theory-473017-t1`,
US-EAST1). Originals live under `originals/`, derivatives under `public/`.

**How the split is enforced, and why it isn't bucket policy.** The obvious design — one
bucket, a public-read IAM binding conditioned on the `public/` prefix — is *impossible*
in Cloud Storage. GCS rejects it outright:

```
ERROR: LintValidationUnits/PublicResourceAllowConditionCheck
       Conditions are not allowed on public resources.
```

IAM Conditions cannot be attached to an `allUsers` binding, so the only bucket-wide
public binding available would expose `originals/` too. One bucket therefore requires
**fine-grained ACLs**: the bucket carries no public binding at all, and each derivative
is made readable individually with a `public-read` object ACL, applied by
`putObject` only when writing to the public class.

That has one genuine advantage over the prefix-condition design and one cost:

- **Fails safe.** A derivative written without the ACL is simply unreadable — a broken
  thumbnail, immediately visible, harmless. There is no mistake in this scheme whose
  failure mode is "an original became world-readable".
- **Uniform bucket-level access must stay OFF**, since UBLA disables object ACLs. That
  means object ACLs are part of the security model, which most GCS hardening advice
  tells you to avoid. Two buckets would avoid it; one bucket cannot.

The code holds up its end: `GcsStorageAdapter` routes every read, write, signature, and
URL through one `objectName()` helper, and the ACL is applied on `bucket === 'public'`
rather than on trust in the call site — so nothing can write, sign, or link an original
outside the originals prefix, and `publicUrl()` can only ever name the public prefix.

Setup (already applied to `valdiviezo-gallery`):

1. **One bucket, fine-grained access, public access prevention off** — PAP is enforced
   by default on new buckets and blocks the per-object ACL outright:
   ```bash
   gcloud storage buckets create gs://valdiviezo-gallery --no-uniform-bucket-level-access
   gcloud storage buckets update gs://valdiviezo-gallery --no-public-access-prevention
   ```
2. **A service account with `objectAdmin` on the bucket**, and **HMAC keys** for it
   (Cloud Storage → Settings → Interoperability, or the CLI below). The S3-compatible
   XML API is what makes presigned browser uploads possible; a service-account JSON key
   can't be used by the AWS SDK this project depends on:
   ```bash
   gcloud iam service-accounts create valdiviezo-storage
   gcloud storage buckets add-iam-policy-binding gs://valdiviezo-gallery \
     --member=serviceAccount:valdiviezo-storage@<project>.iam.gserviceaccount.com \
     --role=roles/storage.objectAdmin
   gcloud storage hmac create valdiviezo-storage@<project>.iam.gserviceaccount.com
   ```
3. **CORS**, so the browser's direct `PUT` is allowed. The rule currently lists both Cloud
   Run URLs plus `localhost`/`127.0.0.1` on ports 4321–4323 (Astro walks up the ports when
   4321 is taken, and `localhost` and `127.0.0.1` are *different* origins to CORS, so both
   spellings have to be there). Add a custom domain here when one is attached:
   ```bash
   cat > cors.json <<'JSON'
   [{ "origin": ["http://localhost:4321", "https://your-domain.example"],
      "method": ["PUT", "GET", "HEAD"],
      "responseHeader": ["Content-Type", "Content-Length"], "maxAgeSeconds": 3600 }]
   JSON
   gcloud storage buckets update gs://valdiviezo-gallery --cors-file=cors.json
   ```
   Read the live rule with `gcloud storage buckets describe gs://valdiviezo-gallery
   --format="json(cors_config)"` before believing an upload error that blames CORS — the
   upload page cannot actually distinguish a blocked preflight from a dropped connection
   (both are `status 0` to `XMLHttpRequest`), and a saturated uplink is the more common
   cause. A real CORS problem fails *every* file immediately; a network one fails a
   scattered subset of a large batch. Confirm either way with one request:
   ```bash
   curl -i -X OPTIONS "https://storage.googleapis.com/valdiviezo-gallery/originals/x" \
     -H "Origin: http://localhost:4321" -H "Access-Control-Request-Method: PUT"
   ```
4. Set `STORAGE_DRIVER=gcs` plus the `GCS_*` variables (see `.env.example`), then
   **verify the boundary before uploading anything**:
   ```bash
   pnpm verify-storage
   ```
   It writes a probe object under each prefix and checks the four properties that
   matter: writes succeed, an original reads back intact, the derivative is publicly
   readable (200), and the *same original* fetched without a signature is **not**
   (403/404) while a presigned URL for it is (200). Then it deletes the probes. Re-run
   it after any change to the bucket's permissions.

`GCS_PUBLIC_BASE_URL` is optional and defaults to
`https://storage.googleapis.com/<bucket>`; point it at Cloud CDN or a custom domain in
production. `GCS_ORIGINALS_PREFIX`/`GCS_PUBLIC_PREFIX` default to `originals`/`public`
and must match whatever the IAM condition above names.

### Local driver

`STORAGE_DRIVER=local` writes to `LOCAL_STORAGE_DIR` (default `tmp/local-storage`,
git-ignored) and needs no cloud account at all. Two routes exist solely for it, and both
404 under any other driver so a misconfiguration can't turn the app server into an
upload proxy for a cloud bucket:

- `src/pages/api/admin/upload/[...key].ts` — the browser's `PUT` target, standing in for
  a presigned URL. It carries no signature, so the **admin session is** the
  authorization.
- `src/pages/local-public/[...key].ts` — serves the public bucket's derivatives. It can
  only ever read the public directory, the same structural guarantee `publicUrl()` has.

Keys reaching those routes become filesystem paths, so both run through
`isSafeObjectKey` (`src/lib/storageKeys.ts`) — cloud drivers don't need that check,
which is precisely why it's easy to forget when adding a disk-backed one.

The honest limitations: no CDN, the bytes live wherever the process runs, and digital
downloads stream *through* the app server because there's no presigned URL to redirect
to. All fine for development, none of it fine for production.

## Accounts & access

One `users` collection, one sign-in code path, two roles.

| | Customer | Admin |
|---|---|---|
| Signs in at | `/{es,en}/account/login` | `/admin` |
| Created by | public sign-up form | `pnpm create-admin`, or another admin in `/admin/customers` |
| Can see | own profile + own orders | the whole panel |

- **An admin is a `users` document with `role: 'admin'`, not a separate credential.**
  `actions.auth.login` is the only sign-in handler for both roles; the admin panel just
  refuses a session whose role isn't `admin`. The public sign-up form always creates a
  `customer` regardless of what it posts — privileged accounts come only from an existing
  admin or the CLI.
- **The session cookie is a snapshot, so privileged surfaces re-read the account.**
  `requireAdmin` (Actions), `src/middleware.ts` (admin pages), and the account mutations
  all call `findActiveUserById` rather than trusting the cookie's `role`. Disabling or
  demoting someone therefore takes effect on their *next request* instead of whenever
  their cookie happens to expire — verified live by disabling an admin mid-session and
  watching their open panel bounce to the sign-in form.
- **Checkout stays open to guests.** An account is a convenience (order history, a
  prefilled email), never a gate in front of a purchase.
- **Orders bind to a user only at checkout time, never by matching email afterwards.**
  Sign-up emails are unverified, so back-filling `userId` from `customer.email` would let
  anyone read a stranger's order history by registering with their address. The
  consequence is deliberate and worth knowing: orders placed as a guest do **not** appear
  in an account created later with the same address. Adding email verification is the
  prerequisite for changing that.
- **Order pages follow from the same rule.** A guest order stays reachable by its
  unguessable id (that link is what the buyer gets after checkout, and there's no account
  to authenticate them against); an order owned by an account is visible only to that
  account and to admins, and 404s — not 403s — for anyone else, so the response can't
  confirm that an order id exists.
- **Two guards keep the panel from being locked shut:** you can't demote or disable your
  own admin account, and you can't remove the last enabled admin. Both are check-then-act
  against a concurrent second admin, which is why `pnpm create-admin` remains the
  documented recovery path.
- **Sign-in and sign-up are rate limited per IP per surface** (`lib/auth.ts`'s
  `rateLimitKey`), so a customer fumbling their password can't consume the admin panel's
  attempt budget from the same office IP. Wrong password, unknown address, and disabled
  account are all reported identically, so the form can't be used to enumerate accounts.

## Admin analytics

`/admin` and `/admin/analytics` render **server-side SVG charts** — no charting library,
no client-side plotting code, nothing to hydrate:

- `lib/analytics.ts` holds the reporting queries. "Revenue" always means orders in `paid`
  or `fulfilled`, and time bucketing happens in JS (pure, unit-tested) rather than in a
  `$dateToString` stage, because month/day boundaries follow the server's local timezone —
  a Mongo aggregation would silently reinterpret them as UTC and move an evening order in
  Ecuador into the wrong day.
- `lib/charts.ts` holds the geometry (scales, ticks, bar paths, line paths) as pure
  functions, so the arithmetic is testable instead of buried in a template. The `.astro`
  components in `src/components/admin/` are markup over its output.
- Every chart plots **one series in one hue** (`--color-data`, its own token: the light
  step is the brand accent, the dark step was chosen and validated against the dark
  surface rather than inherited), carries a **collapsed table twin** with exact values so
  nothing is reachable by hover alone, and grows bars from a single baseline with rounded
  data-ends. Axis ticks never go fractional — cents and unit counts are both whole
  numbers.

## Architecture notes

- **`lib/` is framework-independent.** `lib/pricing.ts`, `lib/images.ts`,
  `lib/downloads.ts`, `lib/storage.ts`, `lib/cart.ts` etc. take configuration as
  parameters and never import `astro:env` or Mongo/storage clients directly — that's what
  makes them unit-testable and shared cleanly between the Astro app and the plain-Node
  CLI scripts (`scripts/ingest.ts`, `scripts/init-db.ts`).
- **One image pipeline, two entry points.** `lib/images.ts`'s `processOriginal()` is
  called identically by `scripts/ingest.ts` (CLI) and the admin upload flow
  (`src/actions/admin.ts`'s `completeUpload`/`retryUploadJob`) — there is no second,
  divergent implementation of the watermark/rotate/derivative logic.
- **Batch uploads are sequential, and retry themselves.** `/admin/upload` sends one file
  at a time, in the order they were added, and each is finished completely — `PUT` *and*
  server-side processing — before the next starts. It previously opened one
  `XMLHttpRequest` per dropped file the instant the drop landed, which is fine for a
  handful and fails badly for a shoot: 80 originals (~1.1GB) all on the wire at once
  saturated the uplink until transfers stalled and their connections reset.
  `XMLHttpRequest` surfaces a reset socket as `error` with **status 0 — byte-for-byte
  identical to a blocked CORS preflight**, so the page confidently blamed the bucket for a
  problem the bucket had nothing to do with. Running one at a time also keeps the server
  from ever having two sharp pipelines in flight, which is what stranded jobs on
  `processing` when a large batch exhausted memory. A retry loop (three attempts,
  exponential backoff, plus a 90-second no-progress stall detector) absorbs the rest, and
  retries re-sign the *existing* job via `refreshUploadUrl` rather than minting a new one
  — so a file that takes three tries leaves one `uploadJobs` row instead of three, and a
  signature that expired while queued is replaced rather than re-used. The trade is real:
  the uplink idles while the server processes each original, making a batch slower in the
  best case in exchange for landing completely. The lesson generalizes: **status 0 tells
  you nothing about why**, so never let an error message pick one cause out of several
  indistinguishable ones.
- **The queue runner lives in `lib/`, not in the page.** `lib/uploadQueue.ts`'s
  `createSequentialQueue()` holds the one-at-a-time guarantee, so ordering, non-overlap,
  re-entrancy (a second drop mid-batch joins the running batch rather than starting a
  parallel one) and "a rejected task doesn't halt the rest" are covered by
  `tests/lib/uploadQueue.test.ts` — the original bug was invisible in a small manual test
  and only appeared at 80 files, which is exactly the shape of thing a unit test should
  be holding rather than a person.
- **One storage seam, three backends.** Nothing outside `src/lib/config.ts`'s
  `createStorage()` (and its CLI twin in `scripts/config.ts`) names a storage driver;
  every page, action, and route asks for a `StorageAdapter` and gets whichever one
  `STORAGE_DRIVER` selects. Swapping in another S3-compatible provider is a constructor,
  not a reimplementation.
- **Prices are computed server-side only, every time.** `lib/pricing.ts`'s
  `computePrintPrice()` is a pure function of `(input, ctx)` fed identically by the live
  quote UI action (`quotePrice`) and the checkout action's authoritative re-pricing. The
  client sends dimensions/paper/qty; it never sends a price, and nothing trusts one if
  it did.
- **Download tokens are single-use-capped and expiring, never durable links.** Only a
  SHA-256 hash of the token is stored; the raw value exists only in memory long enough to
  be handed out once. Consuming a token is one atomic `findOneAndUpdate` with the
  expiry/use-cap guards baked into the filter, to avoid a race where concurrent requests
  could exceed `maxUses`.
- **The order page's Download buttons mint on click, not on render.** Because only the
  hash is stored, the tokens the receipt email carries cannot be re-displayed later — so
  `/api/order-download/[orderId]/[photoId]` re-checks `canViewOrder`, the paid status and
  item membership, mints one token, and redirects to `/api/download/[token]`. That keeps
  `/api/download/[token]` the only thing in the codebase that ever touches an original,
  and spends a token row on a real download request rather than on every page view. Note
  the trade-off it accepts: for a *guest* order the unguessable order id becomes the
  credential for the files, not just for the receipt.
- **Every admin mutation writes an audit log entry** via the single `writeAuditLog()`
  helper (`lib/audit.ts`), and every admin Action is defined through
  `defineAdminAction()` (`src/actions/adminGuard.ts`), which enforces the auth check
  structurally rather than relying on each handler remembering to call it. Entries record
  *which* admin acted (their email), now that there can be more than one — including
  sign-ins and every account change.
- **Admin sign-in lives inline at `/admin`**, not on a separate route — one entry point
  into the panel, with no separate login route to guard. Sign-in itself is
  `actions.auth.login`, shared with the public account area.
- **`i18n.routing` is `'manual'`, applied selectively in `src/middleware.ts`.** Astro's
  built-in (non-manual) i18n enforcement 404s *every* "page"-type route without a locale
  prefix, project-wide — not just ones nested under `[lang]`. That silently 404'd the
  entire `/admin/*` panel (a real bug, confirmed by reading `astro/dist/i18n/router.js`:
  `matchPrefixAlways()` returns `{type:"notFound"}` unconditionally for any non-prefixed
  pathname). The fix: `routing: 'manual'` in `astro.config.mjs` hands control to
  `src/middleware.ts`, which calls `astro:i18n`'s `middleware()` helper itself — but only
  for non-`/admin` paths — reproducing the exact same locale-prefix behavior for the
  public site while leaving the (deliberately non-bilingual) admin panel alone.
- **Email is a driver behind `createEmailer()`**, exactly as storage is behind
  `createStorage()`: `lib/email.ts` holds the `EmailProvider` interface and its two
  implementations (`MailgunEmailProvider`, `ConsoleEmailProvider`) and reads no
  environment of its own, while `lib/config.ts` assembles the config from `EMAIL_DRIVER`
  and the `MAILGUN_*` vars. `EMAIL_DRIVER` defaults to `mailgun`, **not** `console`, and
  that is deliberate: the previous console-only stub was never swapped out, so every
  receipt the store ever produced — and with it every download link — went to stdout while
  the order page told the buyer to check their inbox. A misconfigured deployment now
  throws on the first send instead of failing invisibly. `pnpm verify-email <address>`
  proves the configuration end to end without making a purchase.
- **Fulfilment is manual today, pluggable later.** `lib/fulfillment.ts`'s
  `FulfillmentProvider` interface has one implementation (`ManualFulfillmentProvider` —
  José enters carrier/tracking by hand in `/admin/orders/[id]`); a Prodigi/Gelato adapter
  can drop in later without touching order code.

## Verification performed in this build

A real MongoDB Atlas cluster was connected and used for live verification later in the
build (Google Cloud Storage and Payphone credentials remain unset — `.env` still
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

- **Accounts, verified end to end against the compiled production build** (`node
  dist/server/entry.mjs`) pointed at a throwaway `gallery_authcheck` database, dropped
  afterwards: `pnpm create-admin` (create, idempotent re-run, short-password rejection);
  admin sign-in, and every `/admin/*` route serving the sign-in form instead of its
  content without a session; customer sign-up (with duplicate-email and weak-password
  rejection), account page in both locales, profile edit, password change, sign-out;
  a signed-in *customer* being refused the panel and every admin Action (401
  `ADMIN_AUTH_REQUIRED`); creating/promoting/disabling accounts from the panel, an admin
  password reset, the self-lockout and last-admin guards firing, a disabled account being
  refused sign-in; **an admin disabled mid-session losing their already-open panel on the
  next request**; order visibility (an account-owned order 404s for anonymous visitors,
  200s for its owner and for admins, while a guest order stays link-accessible); the
  `?next=` open-redirect guard rewriting an off-site target back to `/es/account`; and
  the dashboard/analytics charts rendering real SVG marks against seeded orders.
- **The upload path, verified end to end on the `local` driver** against the compiled
  build: `requestUploadUrl` → browser `PUT` to `/api/admin/upload/...` → `completeUpload`
  running the real sharp pipeline. A 6000×4000 original came out as 2000×1333 watermarked
  `.webp` + `.jpg` derivatives, served with the right content types from
  `/local-public/...`, landing as a **draft** invisible in the public gallery until
  published. Also checked: the original is *not* reachable through the public route
  (404), path traversal is rejected on both local routes, an unauthenticated `PUT`
  to the upload route is 401, and deleting the photo removed every byte from disk.
- **A real pre-existing bug this surfaced:** `orders.stripeSessionId` had a unique but
  *non-sparse* index, so only one order could exist without a session id at a time. Since
  the order was inserted before the session id was attached, a second checkout starting in
  that window failed to insert — and any order that never got a session id would have
  blocked all later ones permanently. It was fixed with `sparse: true`; the Payphone
  migration then removed the field entirely and moved uniqueness to
  `payphoneTransactions.clientTransactionId`, which is written by the same `insertOne` that
  creates the document and therefore does not need to be sparse at all. The bug class is
  designed out rather than patched. `init-db` still drops/recreates an index whose options
  changed rather than erroring on the conflict.
- `pnpm build` and `pnpm check` — clean, including under Astro 7's stricter Rust
  compiler (unclosed tags are hard errors now).
- `pnpm test` — 168 unit tests covering `lib/pricing.ts` (aspect tolerance, `maxPrintCm`
  rejection, paper multipliers, per-photo overrides, custom-size clamping),
  `lib/downloads.ts` (token generation/hashing, expiry/exhaustion, the atomic
  consume-token race guard), `lib/orders.ts` (the `status:'pending'` guard filter that
  makes double-processing a payment structurally impossible, conditional customer/
  shipping-address merge), `lib/storage.ts` (local adapter real I/O and its two URL
  modes, the GCS endpoint/path-style/checksum config, single-bucket prefixing, and that
  `publicUrl` can only ever name the public prefix), `lib/storageKeys.ts` (traversal, absolute
  paths, and backslash separators rejected before a key becomes a filesystem path),
  `lib/images.ts` (run for real against the generated placeholders — including
  asserting the sideways fixture comes out correctly oriented and that watermark
  compositing visibly changes the expected pixel region), `lib/auth.ts` (password
  hash/verify, rate limiting), `lib/cart.ts`, `lib/slug.ts`, `lib/serialize.ts`, the
  download-delivery API route's status-code mapping, `lib/payphone.ts` (the amount-split
  identity swept across every total from $0.01 to $50, attempt-id uniqueness and length,
  and that the confirm call reports every failure as a value rather than throwing),
  `lib/payments.ts` (the exact atomic filter that serves as the confirm claim), the
  Payphone confirm route (malformed params, unknown transaction, **an approved payment
  whose amount does not match the order total**, decline, refresh and two-tab races making
  no second gateway call, and that the confirm response is persisted even when fulfilment
  throws), `lib/users.ts` (email normalization, password
  policy, duplicate-key → `EMAIL_TAKEN`, that a disabled account fails authentication
  even with the right password, and that the session snapshot never carries the password
  hash), `lib/charts.ts` (tick rounding, the all-zero and single-point axes, mark
  geometry staying inside the plot), `lib/analytics.ts` (month/day bucketing across year
  boundaries, half-open bucket edges, empty periods reported as zero), and
  `lib/redirects.ts` (the `?next=` open-redirect guard), and `lib/db.ts` (that a failed
  connection is not cached, so an instance recovers instead of replaying one error).
- `pnpm ingest ./seed/photos --dry-run` — full pipeline (EXIF read, auto-rotate,
  watermark, derivative encode, LQIP) against the synthetic placeholders, with the
  sideways fixture visually confirmed to come out upright and the watermark confirmed
  legible over both light and dark backgrounds.
- Live dev-server smoke test: theme toggle persists with no flash across reloads and
  `<ClientRouter />` navigations; unsupported-locale routes (e.g. `/fr/...`) 404 via
  middleware; the root `/` → `/es/` redirect works; `prefers-reduced-motion` styling
  loads correctly; the Payphone confirm route correctly rejects requests with missing or
  malformed parameters, and an unknown transaction id, without ever calling the gateway
  (no live Payphone account needed for either); the full admin sign-in flow (unauthenticated → form → submit → session set → guarded
  pages recognize the session → logout) was exercised live end-to-end.

### Verified live against `gs://valdiviezo-gallery`

The storage half is no longer deferred. Against the real bucket, through the compiled
build: a 6000×4000 original presigned and `PUT` **directly to GCS** (never through the
app server), pulled back for the sharp pipeline, and written out as 2000×1333
watermarked `.webp` + `.jpg` derivatives. Then, on those real objects:

| URL | Expected | Got |
|---|---|---|
| `public/img-gcs.webp` | 200 | **200** |
| `public/img-gcs.jpg` | 200 | **200** |
| `originals/uploads/…jpg` | 403 | **403** |
| bucket listing (enumeration) | 403 | **403** |

The fetched derivative was confirmed to decode as a real 2000×1333 JPEG rather than an
error page, the admin catalog and public gallery both rendered
`storage.googleapis.com/valdiviezo-gallery/public/...` URLs, and deleting the photo
removed all three objects from the bucket. `pnpm verify-storage` passes end to end.

### Deferred — needs real Payphone credentials, not part of this session

Once real Payphone values are in `.env`, **and** the response URL and authorized domain are
registered in the Payphone Developer console:

- [ ] A real (non-dry-run) `pnpm ingest`, uploading to the real bucket.
- [ ] Cart/checkout pages against real seeded data (gallery/detail/admin already verified
      live — see above).
- [ ] Payphone checkout end to end: the Cajita renders with amounts that sum to the
      total, paying as a guest flips the order to `paid`, a download token is minted per
      item, and the receipt carries the links.
- [ ] **Refreshing the confirm URL mints no second token, sends no second email, and makes
      no second call to Payphone** — confirm is terminal, so this is the one that matters.
- [ ] The receipt email actually arrives, in the locale the buyer paid in, with **absolute**
      download links that work from the inbox — and the order page's own Download buttons
      deliver the same files. Run `pnpm verify-email` first: it isolates a Mailgun
      misconfiguration from a fulfilment bug.
- [ ] A hand-crafted `/api/payphone-confirm?id=999&clientTransactionId=<valid>` leaves the
      order `pending` and returns `?payment=unconfirmed`.
- [ ] A checkout page left open past 10 minutes shows the expired state, and "start again"
      mints a fresh attempt.
- [ ] Abandoning at the Payphone step leaves the order `pending`, surfaces the attempt in
      the admin reconciliation section, and the charge reverses at T+5min.
- [ ] Confirm an expired/over-used download token 403s, and that hitting the order
      success URL without ever paying leaves the order `pending`.
- [ ] Admin: upload a full shoot (80+ full-resolution A7III frames, ~1GB) through
      `/admin/upload` from an actual browser, and confirm the queue paces itself, that a
      dropped connection retries on its own, and that a job that still fails stays
      retryable.
- [ ] Edit a price in `/admin/settings`, confirm the before/after diff appears in
      `/admin/activity`.
- [ ] Place a real test order while signed in, and confirm it appears under
      `/{lang}/account` and on that customer's `/admin/customers/[id]` page.
- [ ] Lighthouse pass on the gallery for CLS/LCP (needs real images served over HTTP).

### Not built, and why

- **Email verification and "forgot password" are absent.** There is a real provider now,
  so the blocker is gone — both are the same small piece of work, a hashed, expiring,
  single-use token exactly like `lib/downloads.ts` — but neither is built. Until they are,
  a forgotten password is reset by an admin in `/admin/customers/[id]`, and unverified
  addresses remain why guest orders are never claimed into an account by email match.
- **No third-party sign-in (Google/Apple).** It would add an OAuth dependency and a
  second identity path to keep correct, for a shop whose accounts exist mainly to show
  someone their own order history.

## Deploying to Cloud Run

The service is `valdiviezo-gallery` in `us-east1` (project `boxwood-theory-473017-t1`),
running as the `valdiviezo-storage` service account — the same one that owns the bucket
HMAC keys, so its entire authority is "read five secrets, read/write one bucket".

```bash
gcloud builds submit --config cloudbuild.yaml --region=us-east1
```

That one command builds the image, pushes it to Artifact Registry, and rolls out a new
Cloud Run revision. The Mailgun sending domain lives in `cloudbuild.yaml` as
`_MAILGUN_DOMAIN`; override it for a one-off deploy with
`--substitutions=_MAILGUN_DOMAIN=<domain>`.

**A push to `main` also deploys.** The Cloud Build trigger
`rmgpgab-valdiviezo-gallery-us-east1-joseluis-max-gallery--mamuc` (region `global`,
created from the Cloud Run console's "Set up continuous deployment") watches
`joseluis-max/gallery` and runs the same `cloudbuild.yaml` on every push to `main`, so
the command above and a `git push` are two entrances to one pipeline.

It did not start that way, and the reason is worth keeping. The console wizard generates
its **own inline** build config rather than using the repo's, and that generated config
builds with a plain `docker build -t ... . -f Dockerfile` — no `--build-arg`. There is no
way to add one through the wizard. So its first and only run died in `astro build` with

```
[EnvInvalidVariables] - PUBLIC_SITE_URL is missing
```

`PUBLIC_SITE_URL` is a `client` astro:env variable and therefore has to exist at image
build time (see the bullet below); with no build arg, `ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL`
resolves to the empty string, and astro:env counts empty as absent — `validatePublicVariables`
is literally `loadedEnv[key] === "" ? void 0 : loadedEnv[key]`. Hence *missing* rather than
*invalid*, for a variable the Dockerfile does set.

The fix was to point the trigger at this repo's config instead of its generated one:

```bash
gcloud beta builds triggers export rmgpgab-valdiviezo-gallery-us-east1-joseluis-max-gallery--mamuc   --region=global --destination=trigger.yaml
# replace the whole inline `build:` block with `filename: cloudbuild.yaml`,
# and DELETE the trigger-level `substitutions:` block, then:
gcloud beta builds triggers import --source=trigger.yaml --region=global
```

Two traps in that edit. `gcloud builds triggers update github --build-config=...` returns a
bare `INVALID_ARGUMENT` while an inline `build` is still attached — export/import is the
path that works. And the wizard's trigger-level substitutions (`_AR_HOSTNAME`,
`_SERVICE_NAME`, `_DEPLOY_REGION`, ...) must be removed: `cloudbuild.yaml` never references
them, and Cloud Build rejects unmatched substitutions unless the config opts into
`substitutionOption: ALLOW_LOOSE`, which this one deliberately does not.

Because the trigger now runs `cloudbuild.yaml`, its `--set-env-vars` and `--set-secrets` are
the **complete** runtime configuration — both flags replace rather than merge. Anything set
on a revision by hand or from the console is erased by the next push. Change runtime
configuration in `cloudbuild.yaml`, or it will not survive.

**One-time, before the first deploy that includes email** — the rollout fails without it:

```bash
# 1. Store the Mailgun private API key.
printf '%s' "<mailgun private api key>"   | gcloud secrets create mailgun-api-key --data-file=- --replication-policy=automatic

# 2. Let the service account read it, as it already reads the other four.
gcloud secrets add-iam-policy-binding mailgun-api-key   --member=serviceAccount:valdiviezo-storage@boxwood-theory-473017-t1.iam.gserviceaccount.com   --role=roles/secretmanager.secretAccessor
```

Rotating the key later is `gcloud secrets versions add mailgun-api-key --data-file=-`
followed by a new revision — `:latest` is resolved at container start, not at build. Three things about this setup are non-obvious enough to be worth
stating:

- **Sessions must not live on the filesystem.** `@astrojs/node` defaults to a local-disk
  session store, which is silently wrong on Cloud Run: containers are ephemeral and
  requests spread across instances, so a signed-in visitor would be randomly signed out
  and their cart randomly empty. `src/lib/sessionDriver.ts` stores sessions in Mongo
  instead, with a TTL index so abandoned ones expire. It's wired as a driver *entrypoint*
  rather than inline options because Astro inlines inline driver config **at build time**,
  which would bake the database URI into the image.
- **`PUBLIC_SITE_URL` is baked into the image, not injected at runtime.** It's a `client`
  astro:env variable, so it's inlined into canonical URLs, hreflang, the sitemap, and OG
  tags during the build — hence the `--build-arg` and the `_SITE_URL` substitution in
  `cloudbuild.yaml`. Changing the domain means a **rebuild**, not just a new revision.
  Don't try to predict the Cloud Run URL either: this service got the hashed
  `SERVICE-HASH-ue.a.run.app` form rather than the deterministic
  `SERVICE-PROJECTNUMBER.REGION.run.app` one.
- **Secrets come from Secret Manager**, mounted as environment variables by the revision
  (`mongodb-uri`, `gcs-access-key-id`, `gcs-secret-access-key`, `payphone-token`,
  `mailgun-api-key`). Nothing secret is in the image, in `cloudbuild.yaml`, or in
  the revision's plain config. `.dockerignore` excludes `.env` from the build context.

  `--set-secrets` is all-or-nothing: `gcloud run deploy` **fails the whole rollout** if any
  named secret is missing, so `mailgun-api-key` has to exist before the next deploy — see
  the one-time setup below.

`--memory=1Gi` is deliberate: sharp decoding a 24MP original does not fit comfortably in
Cloud Run's 512MiB default.

### A bug this deploy exposed: never cache a rejected connection promise

`lib/db.ts` caches its `MongoClient.connect()` promise on `globalThis`, which is right —
one connection pool per process. But it cached the promise *whatever it resolved to*, so
a process that started while the database was unreachable cached the **rejection** and
replayed that identical error for the rest of its life. It never retried, so it could not
recover even after the database came back.

That is precisely what happened here: the first Cloud Run container booted while Atlas
was still refusing its IP, and then served the same `MongoServerSelectionError` forever —
including after the Atlas access list was fixed. The tell was that every log line carried
an identical TLS session id (`C0ACDA7E037F0000`): one cached error object, not repeated
connection attempts.

Both `lib/db.ts` and `lib/sessionDriver.ts` now clear the cache on failure so the next
request opens a fresh connection, and `tests/lib/db.test.ts` pins the behaviour. Worth
remembering as a class of bug: **a cached promise caches failure too**, and on a
long-lived server that turns a transient outage into a permanent one.

### MongoDB Atlas must allow the connection

Cloud Run egresses from a large, changing pool of Google IPs. If the Atlas cluster's
Network Access list doesn't include them, **every request 500s** with a confusing
symptom — not a timeout or an auth error, but a TLS handshake failure:

```
MongoServerSelectionError: ... tlsv1 alert internal error ... SSL alert number 80
```

That is Atlas rejecting an unlisted source IP at the TLS layer. Two ways to fix it:

- **Allow `0.0.0.0/0`** in Atlas → Network Access. Simplest; the cluster is then
  protected by its credentials alone, which for a SRV-less URI with a strong password is
  the usual serverless tradeoff.
- **Give Cloud Run a static egress IP** — a VPC connector plus Cloud NAT with a reserved
  address, then allowlist just that address. Stricter, and costs roughly $45/month in
  connector and NAT charges for a shop this size.

### Still to do before this is a public storefront

- [ ] A real `payphone-token` secret and `PAYPHONE_STORE_ID` env var (both currently hold
      placeholders, so checkout will fail), with the response URL registered in Payphone
      Developer as `https://<service-url>/api/payphone-confirm` and the service's domain
      added as the store's authorized domain.
- [ ] Confirm Payphone's **minimum transaction amount** with the account rep and encode it
      as `PAYPHONE_MIN_AMOUNT_CENTS` — a single-photo order is legitimately $1.20–$2.00, so
      a $1 or $2 floor would reject real orders.
- [ ] A verified Mailgun sending domain, a `mailgun-api-key` secret in Secret Manager
      (with `secretAccessor` granted to the service account), and `_MAILGUN_DOMAIN` filled
      in at the top of `cloudbuild.yaml`. A Mailgun **sandbox** domain only delivers to
      addresses added as Authorized Recipients, so it will silently drop real customers —
      verify a real domain, then confirm with `pnpm verify-email`.
- [ ] A custom domain mapped to the service, then a rebuild with `_SITE_URL` set to it
      and that origin added to the bucket's CORS rule.
- [ ] Cloud CDN in front of the public prefix, with `GCS_PUBLIC_BASE_URL` pointed at it.

## Deploying elsewhere

`output: 'server'` + `@astrojs/node` standalone, so the `Dockerfile` here works anywhere
that runs a container (Fly.io, Railway, Render, a plain VPS). Set the environment
variables from `.env.example` on the host, remembering that `PUBLIC_SITE_URL` is a build
argument rather than a runtime variable, and register `https://<your-domain>/api/payphone-confirm`
as the response URL (plus the domain itself as authorized) in Payphone Developer once deployed. The Mongo-backed session store
is what makes more than one instance safe; keep it whatever the host.
