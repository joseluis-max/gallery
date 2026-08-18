import exifr from 'exifr';
import sharp from 'sharp';

export interface WatermarkConfig {
  text: string;
  /** Watermark text box width as a fraction of the derivative's width, e.g. 0.20. */
  widthPct: number;
  /** Inset from the left/bottom edges as a fraction of width/height, e.g. 0.03. */
  insetPct: number;
  /** Opacity of the fill text, 0-1. */
  opacity: number;
  fillColor: string;
  shadowColor: string;
}

export interface ExifData {
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: string;
  shutter?: string;
  takenAt?: Date;
}

export interface ProcessedImage {
  derivativeWebp: Buffer;
  derivativeJpeg: Buffer;
  /** Post-rotation, authoritative — see the sharp .rotate()/.metadata() note below. */
  width: number;
  height: number;
  aspectRatio: number;
  /** ~20px long-edge WebP, inlined as a base64 data URI for zero-request blur-up. */
  lqip: string;
  exif: ExifData;
}

const DERIVATIVE_LONG_EDGE = 2000;
const LQIP_LONG_EDGE = 20;

/**
 * Shared by both the CLI ingest script and the admin browser-upload handler — this must
 * stay the single implementation of the sharp pipeline so watermark/rotate logic can
 * never diverge between the two call sites.
 */
export async function processOriginal(inputBuffer: Buffer, watermark: WatermarkConfig): Promise<ProcessedImage> {
  const exif = await extractExif(inputBuffer);

  // `.rotate()` auto-orients from the EXIF orientation tag, but a subsequent
  // `.metadata()` call still reports PRE-rotation width/height and the raw orientation
  // tag — not what's actually displayed. `.toBuffer({resolveWithObject:true})` on the
  // resized output below is the only reliable source for the derivative's real
  // dimensions, which is what gets stored as photos.width/height/aspectRatio.
  const oriented = sharp(inputBuffer).rotate();
  const resized = oriented.resize({
    width: DERIVATIVE_LONG_EDGE,
    height: DERIVATIVE_LONG_EDGE,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const { data: preWatermark, info } = await resized.toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const { svg, left, top } = buildWatermarkSvg(watermark, width, height);
  const watermarked = sharp(preWatermark).composite([{ input: svg, left, top }]);

  // Metadata (EXIF/ICC) is stripped by default on sharp output — no explicit strip step
  // needed, just don't call `.withMetadata()` on this branch.
  const [derivativeWebp, derivativeJpeg] = await Promise.all([
    watermarked.clone().webp({ quality: 82 }).toBuffer(),
    watermarked.clone().jpeg({ quality: 85, mozjpeg: true }).toBuffer(),
  ]);

  const lqipBuffer = await sharp(preWatermark).resize(LQIP_LONG_EDGE).webp({ quality: 40 }).toBuffer();
  const lqip = `data:image/webp;base64,${lqipBuffer.toString('base64')}`;

  return {
    derivativeWebp,
    derivativeJpeg,
    width,
    height,
    aspectRatio: width / height,
    lqip,
    exif,
  };
}

function buildWatermarkSvg(
  config: WatermarkConfig,
  imageWidth: number,
  imageHeight: number,
): { svg: Buffer; left: number; top: number } {
  const boxWidth = Math.max(1, Math.round(imageWidth * config.widthPct));
  const boxHeight = Math.max(1, Math.round(boxWidth * 0.16));
  const insetX = Math.round(imageWidth * config.insetPct);
  const insetY = Math.round(imageHeight * config.insetPct);

  const left = insetX;
  const top = Math.max(0, imageHeight - insetY - boxHeight);

  const fontSize = Math.round(boxHeight * 0.62);
  const baselineY = boxHeight - Math.round(boxHeight * 0.28);
  // `textLength` + `lengthAdjust` forces the rendered text to actually span ~90% of the
  // target box width regardless of font metrics/substitution, so "≈20% of image width"
  // holds even on a system without the exact font available.
  const textLength = Math.round(boxWidth * 0.92);
  const escaped = escapeXml(config.text);

  const svg = `
    <svg width="${boxWidth}" height="${boxHeight}" xmlns="http://www.w3.org/2000/svg">
      <text x="3" y="${baselineY + 2}" font-family="Georgia, 'Iowan Old Style', serif"
            font-size="${fontSize}" textLength="${textLength}" lengthAdjust="spacingAndGlyphs"
            fill="${config.shadowColor}" fill-opacity="${Math.min(1, config.opacity * 0.6)}">${escaped}</text>
      <text x="0" y="${baselineY}" font-family="Georgia, 'Iowan Old Style', serif"
            font-size="${fontSize}" textLength="${textLength}" lengthAdjust="spacingAndGlyphs"
            fill="${config.fillColor}" fill-opacity="${config.opacity}">${escaped}</text>
    </svg>
  `.trim();

  return { svg: Buffer.from(svg), left, top };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function extractExif(inputBuffer: Buffer): Promise<ExifData> {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await exifr.parse(inputBuffer)) ?? null;
  } catch {
    // Not all inputs carry parseable EXIF (e.g. a plain PNG) — that's fine, just no
    // capture metadata for this photo.
    return {};
  }
  if (!parsed) return {};

  const make = typeof parsed.Make === 'string' ? parsed.Make.trim() : undefined;
  const model = typeof parsed.Model === 'string' ? parsed.Model.trim() : undefined;
  const camera = [make, model].filter(Boolean).join(' ').trim() || undefined;

  const lens = typeof parsed.LensModel === 'string' ? parsed.LensModel : undefined;

  const iso = typeof parsed.ISO === 'number' ? parsed.ISO : undefined;

  const fNumber = typeof parsed.FNumber === 'number' ? parsed.FNumber : undefined;
  const aperture = fNumber !== undefined ? `f/${trimTrailingZero(fNumber)}` : undefined;

  const exposureTime = typeof parsed.ExposureTime === 'number' ? parsed.ExposureTime : undefined;
  const shutter =
    exposureTime !== undefined
      ? exposureTime < 1
        ? `1/${Math.round(1 / exposureTime)}`
        : `${trimTrailingZero(exposureTime)}s`
      : undefined;

  const takenAt =
    parsed.DateTimeOriginal instanceof Date
      ? parsed.DateTimeOriginal
      : parsed.CreateDate instanceof Date
        ? parsed.CreateDate
        : undefined;

  return { camera, lens, iso, aperture, shutter, takenAt };
}

function trimTrailingZero(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}
