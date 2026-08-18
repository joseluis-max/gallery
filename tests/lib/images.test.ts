import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processOriginal, type WatermarkConfig } from '../../src/lib/images.ts';

const watermark: WatermarkConfig = {
  text: '© José Valdiviezo',
  widthPct: 0.2,
  insetPct: 0.03,
  opacity: 0.55,
  fillColor: '#ffffff',
  shadowColor: '#000000',
};

async function makeUprightJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 190, g: 150, b: 100 } },
  })
    .jpeg()
    .toBuffer();
}

/** Mimics real sideways-camera output: a camera sensor captures a fixed landscape pixel
 *  layout regardless of how the camera was held, and tags orientation=6 ("rotate 90 CW
 *  to display correctly") when it was actually held rotated. So the stored pixels stay
 *  untouched landscape — only the orientation tag encodes the correction needed. */
async function makeSidewaysJpeg(landscapeWidth: number, landscapeHeight: number): Promise<Buffer> {
  const raw = await makeUprightJpeg(landscapeWidth, landscapeHeight);
  return sharp(raw).withMetadata({ orientation: 6 }).jpeg().toBuffer();
}

describe('processOriginal', () => {
  it('produces a derivative no larger than the 2000px long-edge cap, preserving aspect ratio', async () => {
    const input = await makeUprightJpeg(4000, 3000);
    const result = await processOriginal(input, watermark);
    expect(Math.max(result.width, result.height)).toBe(2000);
    expect(result.width / result.height).toBeCloseTo(4000 / 3000, 2);
    expect(result.aspectRatio).toBeCloseTo(4000 / 3000, 2);
  });

  it('corrects the sideways-EXIF fixture to the upright orientation, with authoritative post-rotation dimensions', async () => {
    // Camera stores a landscape 1600x1200 frame sideways (orientation 6 = rotate 90 CW
    // on display). After auto-orient it should come out portrait, matching what the
    // photographer actually saw through the viewfinder.
    const input = await makeSidewaysJpeg(1600, 1200);
    const result = await processOriginal(input, watermark);
    expect(result.height).toBeGreaterThan(result.width);
    expect(result.width / result.height).toBeCloseTo(1200 / 1600, 1);
  });

  it('changes pixels in the watermark region (bottom-left) relative to an unwatermarked control', async () => {
    const input = await makeUprightJpeg(1600, 1000);
    const result = await processOriginal(input, watermark);

    const controlDerivative = await sharp(input)
      .rotate()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const region = { left: 10, top: result.height - 60, width: 100, height: 40 };
    const [watermarkedRegion, controlRegion] = await Promise.all([
      sharp(result.derivativeJpeg).extract(region).raw().toBuffer(),
      sharp(controlDerivative).extract(region).raw().toBuffer(),
    ]);

    expect(watermarkedRegion.length).toBe(controlRegion.length);
    let diffPixels = 0;
    for (let i = 0; i < watermarkedRegion.length; i++) {
      if (Math.abs(watermarkedRegion[i] - controlRegion[i]) > 10) diffPixels++;
    }
    expect(diffPixels).toBeGreaterThan(0);
  });

  it('strips EXIF/ICC metadata from both derivative encodings', async () => {
    const input = await makeUprightJpeg(1200, 900);
    const result = await processOriginal(input, watermark);
    const [webpMeta, jpegMeta] = await Promise.all([
      sharp(result.derivativeWebp).metadata(),
      sharp(result.derivativeJpeg).metadata(),
    ]);
    expect(webpMeta.exif).toBeUndefined();
    expect(jpegMeta.exif).toBeUndefined();
  });

  it('produces a small, decodable LQIP data URI', async () => {
    const input = await makeUprightJpeg(2400, 1600);
    const result = await processOriginal(input, watermark);
    expect(result.lqip.startsWith('data:image/webp;base64,')).toBe(true);
    const base64 = result.lqip.slice('data:image/webp;base64,'.length);
    const buffer = Buffer.from(base64, 'base64');
    expect(buffer.length).toBeLessThan(5000);
    const meta = await sharp(buffer).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(20);
  });


  it('extracts Make/Model EXIF when present, and tolerates their absence', async () => {
    const tagged = await sharp(await makeUprightJpeg(800, 600))
      .withMetadata({ exif: { IFD0: { Make: 'Sony', Model: 'ILCE-7M3' } } })
      .jpeg()
      .toBuffer();
    const result = await processOriginal(tagged, watermark);
    expect(result.exif.camera).toBe('Sony ILCE-7M3');

    const untagged = await makeUprightJpeg(800, 600);
    const result2 = await processOriginal(untagged, watermark);
    expect(result2.exif.camera).toBeUndefined();
  });
});
