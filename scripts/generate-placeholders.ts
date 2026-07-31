// Generates synthetic gradient JPEGs into seed/photos/ standing in for the 16 real
// Galápagos originals (not available in this environment). Matches each entry's slug and
// target aspect ratio from seed/metadata.json so the real ingest pipeline (EXIF read,
// auto-rotate, watermark, derivative, LQIP) can be exercised end to end against
// something real, without depending on the real camera files. These are throwaway test
// fixtures — git-ignored, clearly not real photography, and documented as such.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

interface SeedPhoto {
  slug: string;
  targetWidth: number;
  targetHeight: number;
  placeholderOrientation?: 'sideways';
}

const OUT_DIR = join(process.cwd(), 'seed', 'photos');
const METADATA_PATH = join(process.cwd(), 'seed', 'metadata.json');

function hashHue(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

// Standard HSL -> RGB conversion, h in [0,360), s/l in [0,1].
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r1, g1, b1] = [0, 0, 0];
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

async function buildGradientJpeg(width: number, height: number, slug: string): Promise<Buffer> {
  const hue = hashHue(slug);
  const c1 = hslToRgb(hue, 0.4, 0.58);
  const c2 = hslToRgb((hue + 40) % 360, 0.3, 0.28);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgb(${c1.r},${c1.g},${c1.b})" />
        <stop offset="100%" stop-color="rgb(${c2.r},${c2.g},${c2.b})" />
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)" />
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

async function main() {
  const raw = await readFile(METADATA_PATH, 'utf-8');
  const entries: SeedPhoto[] = JSON.parse(raw);

  await mkdir(OUT_DIR, { recursive: true });

  for (const photo of entries) {
    const sideways = photo.placeholderOrientation === 'sideways';
    // A real sensor captures a fixed landscape layout regardless of how the camera was
    // held — so the "sideways" fixture's raw pixels are stored landscape (dimensions
    // swapped from the intended final display) and only the orientation tag encodes the
    // correction, exactly like the pelican-takeoff frame in the real set.
    const rawWidth = sideways ? photo.targetHeight : photo.targetWidth;
    const rawHeight = sideways ? photo.targetWidth : photo.targetHeight;

    const base = await buildGradientJpeg(rawWidth, rawHeight, photo.slug);

    // Sharp's EXIF writer only reliably round-trips a small set of IFD0 tags (Make,
    // Model, Software, DateTime) — ExifIFD subtags like ISO/FNumber/ExposureTime/
    // LensModel are NOT preserved by libvips' writer, so those fields stay unset on
    // these synthetic fixtures. Real A7III files carry all of them natively; this is a
    // documented limitation of the placeholder generator, not of the ingest pipeline.
    const withExif = sharp(base).withMetadata({
      ...(sideways ? { orientation: 6 } : {}),
      exif: {
        IFD0: {
          Make: 'Sony',
          Model: 'ILCE-7M3',
          Software: 'valdiviezo-photography placeholder generator (synthetic fixture)',
          DateTime: '2025:11:12 08:15:00',
        },
      },
    });

    const outBuffer = await withExif.jpeg({ quality: 92 }).toBuffer();
    await writeFile(join(OUT_DIR, `${photo.slug}.jpg`), outBuffer);
    console.log(
      `generated ${photo.slug}.jpg (${rawWidth}x${rawHeight}${sideways ? ', tagged sideways — orientation=6' : ''})`,
    );
  }

  console.log(`\n${entries.length} placeholder JPEGs written to seed/photos/ (git-ignored).`);
  console.log('These are synthetic gradient fixtures, NOT real photography.');
  console.log('Point `pnpm ingest` at the real Sony A7III originals for production use.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
