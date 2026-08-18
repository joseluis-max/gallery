// pnpm ingest ./photos/copa-2026 --competition=copa-2026 [--dry-run]
//
// Run locally by José, not on the server — keeps sharp off the deploy target and avoids
// request timeouts processing 24MP files. Idempotent on slug (upsert).
//
// --dry-run touches neither cloud storage nor Mongo: derivatives are written to
// ./tmp/ingest-preview/ via the same LocalFsStorageAdapter used by unit tests, and the
// planned Mongo document is printed instead of written.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { ObjectId } from 'mongodb';
import { defaultWatermarkConfig } from '../watermark.config.ts';
import { getDb } from '../src/lib/db.ts';
import { processOriginal } from '../src/lib/images.ts';
import { createStorageAdapter, type StorageAdapter } from '../src/lib/storage.ts';
import { getDbConfig, getStorageAdapter } from './config.ts';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif']);
const METADATA_PATH = resolve('seed/metadata.json');

interface SeedMetadataEntry {
  slug: string;
  title: { es: string; en: string };
  description: { es: string; en: string };
  tags?: string[];
}

/**
 * seed/metadata.json carries the real bilingual titles/descriptions/tags written for
 * the sample set — matched here by slug so a fresh `pnpm ingest` populates them instead
 * of leaving every new photo titled with its own filename. Best-effort: a directory of
 * photos with no corresponding metadata entry (or no metadata.json at all — e.g.
 * ingesting a completely different shoot) still ingests fine, just without captions,
 * exactly as before this existed.
 */
async function loadSeedMetadata(): Promise<Map<string, SeedMetadataEntry>> {
  const map = new Map<string, SeedMetadataEntry>();
  if (!existsSync(METADATA_PATH)) return map;
  const entries: SeedMetadataEntry[] = JSON.parse(await readFile(METADATA_PATH, 'utf-8'));
  for (const entry of entries) map.set(entry.slug, entry);
  return map;
}

interface CliArgs {
  inputDir: string;
  competitionSlug?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  const competitionArg = argv.find((a) => a.startsWith('--competition='));
  const competitionSlug = competitionArg?.split('=')[1];
  if (!positional[0]) {
    console.error('Usage: pnpm ingest <input-dir> [--competition=<slug>] [--dry-run]');
    console.error('');
    console.error('  --competition   Slug of an existing competition (create it in /admin/competitions');
    console.error('                  first). Omit for portfolio work. Only applies to photographs this');
    console.error('                  run creates — re-ingesting an existing slug will NOT reassign it,');
    console.error('                  because the competition is written with $setOnInsert so a re-run');
    console.error('                  never clobbers edits made in the admin panel. Move an existing');
    console.error('                  photograph from its edit page instead.');
    process.exit(1);
  }
  return { inputDir: resolve(positional[0]), competitionSlug, dryRun };
}

function slugFromFilename(filename: string): string {
  return filename.slice(0, filename.length - extname(filename).length);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // A dry run always writes to its own throwaway directory, whatever STORAGE_DRIVER
  // says — that's the whole point of it needing no credentials.
  const storage: StorageAdapter = args.dryRun
    ? createStorageAdapter('local', resolve('tmp/ingest-preview'))
    : getStorageAdapter();

  const files = (await readdir(args.inputDir)).filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()));
  if (files.length === 0) {
    console.error(`No images found in ${args.inputDir}`);
    process.exit(1);
  }

  console.log(`${args.dryRun ? '[dry-run] ' : ''}Processing ${files.length} file(s) from ${args.inputDir}`);

  const db = args.dryRun ? null : await getDb(getDbConfig());

  // Resolved once, up front: a typo'd slug should fail before any bytes are uploaded,
  // not leave half a shoot assigned to nothing.
  let competitionId: ObjectId | null = null;
  if (args.competitionSlug && db) {
    const competition = await db.collection('competitions').findOne({ slug: args.competitionSlug });
    if (!competition) {
      console.error(`No competition with slug "${args.competitionSlug}". Create it in /admin/competitions first.`);
      process.exit(1);
    }
    competitionId = competition._id;
    console.log(`Assigning to competition: ${args.competitionSlug}`);
  }
  const seedMetadata = await loadSeedMetadata();

  for (const file of files) {
    const slug = slugFromFilename(file);
    const inputPath = join(args.inputDir, file);
    const original = await readFile(inputPath);
    const meta = seedMetadata.get(slug);

    const processed = await processOriginal(original, defaultWatermarkConfig);

    const originalKey = `${slug}.jpg`;
    const publicWebpKey = `${slug}.webp`;
    const publicJpegKey = `${slug}.jpg`;

    if (args.dryRun) {
      // Untouched original bytes, exactly as they'll be uploaded in real mode — never
      // passed through sharp.
      await storage.putObject({ bucket: 'originals', key: originalKey, body: original, contentType: 'image/jpeg' });
      await storage.putObject({
        bucket: 'public',
        key: publicWebpKey,
        body: processed.derivativeWebp,
        contentType: 'image/webp',
      });
      await storage.putObject({
        bucket: 'public',
        key: publicJpegKey,
        body: processed.derivativeJpeg,
        contentType: 'image/jpeg',
      });

      const plannedDoc = {
        slug,
        title: meta?.title ?? { es: slug, en: slug },
        description: meta?.description ?? { es: '', en: '' },
        tags: meta?.tags ?? [],
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
        aspectRatio: Number(processed.aspectRatio.toFixed(4)),
        competitionId: args.competitionSlug ? `<resolved id for ${args.competitionSlug}>` : null,
        // Bare object keys, scoped to their bucket by the `bucket` field passed to
        // StorageAdapter calls elsewhere — NOT prefixed with "originals/"/"public/",
        // since that would double-encode the bucket into the key and break
        // storage.publicUrl()/getPresignedGetUrl() lookups against what was actually
        // uploaded above.
        storage: { originalKey, publicKey: publicWebpKey },
        status: 'draft',
      };
      console.log(`\n[dry-run] ${slug}${meta ? '' : ' (no seed/metadata.json entry — using slug as title)'}`);
      console.log(JSON.stringify(plannedDoc, null, 2));
      console.log(`  -> preview written to tmp/ingest-preview/public/${publicJpegKey} (and .webp)`);
      continue;
    }

    await storage.putObject({ bucket: 'originals', key: originalKey, body: original, contentType: 'image/jpeg' });
    await storage.putObject({
      bucket: 'public',
      key: publicWebpKey,
      body: processed.derivativeWebp,
      contentType: 'image/webp',
    });
    await storage.putObject({
      bucket: 'public',
      key: publicJpegKey,
      body: processed.derivativeJpeg,
      contentType: 'image/jpeg',
    });

    await db!.collection('photos').updateOne(
      { slug },
      {
        $set: {
          slug,
          capture: {
            camera: processed.exif.camera,
            lens: processed.exif.lens,
            iso: processed.exif.iso,
            aperture: processed.exif.aperture,
            shutter: processed.exif.shutter,
            takenAt: processed.exif.takenAt,
          },
          width: processed.width,
          height: processed.height,
          aspectRatio: processed.aspectRatio,
          lqip: processed.lqip,
          'storage.originalKey': originalKey,
          'storage.publicKey': publicWebpKey,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          title: meta?.title ?? { es: slug, en: slug },
          description: meta?.description ?? { es: '', en: '' },
          tags: meta?.tags ?? [],
          competitionId,
          featured: false,
          status: 'draft',
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    console.log(`ingested: ${slug}`);
  }

  console.log(`\nDone. ${files.length} file(s) ${args.dryRun ? 'previewed (no storage/Mongo writes)' : 'ingested'}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
