// pnpm tsx scripts/seed-preview.ts
//
// Dev-only convenience: pushes the real seed photos into the real Mongo Atlas cluster as
// `published` (not `draft`), writing the watermarked derivatives straight into
// public/local-public/ so Astro serves them itself — no R2 credentials needed. Lets José
// (or anyone) preview the actual gallery/detail pages in a browser before R2 is wired up.
// R2_PUBLIC_BASE_URL in .env already points at /local-public for exactly this reason.
// Not part of the production ingest path — real photos go through `pnpm ingest`, which
// uploads to R2 and defaults new photos to `draft` until reviewed in admin.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { defaultWatermarkConfig } from '../watermark.config.ts';
import { getDb } from '../src/lib/db.ts';
import { processOriginal } from '../src/lib/images.ts';
import { getDbConfig } from './config.ts';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif']);
const PHOTOS_DIR = resolve('seed/photos');
const METADATA_PATH = resolve('seed/metadata.json');
const LOCAL_PUBLIC_DIR = resolve('public/local-public');

interface SeedMetadataEntry {
  slug: string;
  title: { es: string; en: string };
  description: { es: string; en: string };
  tags?: string[];
  collections?: string[];
}

function slugFromFilename(filename: string): string {
  return filename.slice(0, filename.length - extname(filename).length);
}

async function main() {
  const entries: SeedMetadataEntry[] = JSON.parse(await readFile(METADATA_PATH, 'utf-8'));
  const metaBySlug = new Map(entries.map((e) => [e.slug, e]));

  const files = (await readdir(PHOTOS_DIR)).filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()));
  if (files.length === 0) {
    console.error(`No images found in ${PHOTOS_DIR}`);
    process.exit(1);
  }

  await mkdir(LOCAL_PUBLIC_DIR, { recursive: true });
  const db = await getDb(getDbConfig());

  let i = 0;
  for (const file of files) {
    const slug = slugFromFilename(file);
    const meta = metaBySlug.get(slug);
    const original = await readFile(join(PHOTOS_DIR, file));
    const processed = await processOriginal(original, defaultWatermarkConfig);

    const originalKey = `${slug}.jpg`;
    const publicWebpKey = `${slug}.webp`;
    const publicJpegKey = `${slug}.jpg`;

    await writeFile(join(LOCAL_PUBLIC_DIR, publicWebpKey), processed.derivativeWebp);
    await writeFile(join(LOCAL_PUBLIC_DIR, publicJpegKey), processed.derivativeJpeg);
    // Deliberately NOT copying the original into public/local-public/ — that directory
    // is served statically by Astro, and putting a full-res original there (even for
    // local-only preview) would violate the one invariant this whole app exists to
    // enforce. `r2.originalKey` is still recorded for schema completeness; it just
    // won't resolve to anything until real R2 credentials + a real ingest are in place.

    await db.collection('photos').updateOne(
      { slug },
      {
        $set: {
          slug,
          capture: {
            camera: processed.exif.camera ?? null,
            lens: processed.exif.lens ?? null,
            iso: processed.exif.iso ?? null,
            aperture: processed.exif.aperture ?? null,
            shutter: processed.exif.shutter ?? null,
            takenAt: processed.exif.takenAt ?? null,
          },
          width: processed.width,
          height: processed.height,
          aspectRatio: processed.aspectRatio,
          maxPrintCm: processed.maxPrintCm,
          lqip: processed.lqip,
          'r2.originalKey': originalKey,
          'r2.publicKey': publicWebpKey,
          title: meta?.title ?? { es: slug, en: slug },
          description: meta?.description ?? { es: '', en: '' },
          tags: meta?.tags ?? [],
          collections: meta?.collections ?? [],
          status: 'published',
          featured: i < 6,
          order: i,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    console.log(`seeded (published): ${slug}`);
    i++;
  }

  console.log(`\nDone. ${files.length} photo(s) published to the real DB, derivatives in public/local-public/.`);
  console.log('Run `pnpm dev` and visit /es/gallery or /en/gallery to preview.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
