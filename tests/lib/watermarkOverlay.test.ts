import { describe, expect, it } from 'vitest';
import { buildWatermarkTile, DEFAULT_OVERLAY_OPACITY } from '../../src/lib/watermarkOverlay.ts';

/** The tile is only ever consumed as a CSS `url()`, so every assertion here works from
 *  the decoded SVG rather than from the encoded string a caller never reads. */
function decode(dataUri: string): string {
  expect(dataUri.startsWith('data:image/svg+xml,')).toBe(true);
  return decodeURIComponent(dataUri.slice('data:image/svg+xml,'.length));
}

describe('buildWatermarkTile', () => {
  it('renders the mark twice — dark shadow behind light fill — on the diagonal', () => {
    const svg = decode(buildWatermarkTile({ text: '© José Valdiviezo', size: 140 }));

    expect(svg).toContain('width="140" height="140"');
    expect(svg).toContain('transform="rotate(-30 70 70)"');
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg.match(/© José Valdiviezo/g)).toHaveLength(2);
  });

  it('holds the mark to the same fraction of the tile at every scale', () => {
    // What keeps a 140px thumbnail tile and a 260px hero tile reading as the same mark
    // rather than two different densities.
    for (const size of [140, 260]) {
      const svg = decode(buildWatermarkTile({ text: '© José Valdiviezo', size }));
      expect(svg).toContain(`textLength="${Math.round(size * 0.78)}"`);
    }
  });

  it('escapes XML in the mark text before encoding it', () => {
    const svg = decode(buildWatermarkTile({ text: 'Ruiz & <Valdiviezo>', size: 140 }));

    expect(svg).toContain('Ruiz &amp; &lt;Valdiviezo&gt;');
    // The literal characters must not survive — either would break out of the <text>
    // element and produce an SVG the browser silently refuses to paint.
    expect(svg).not.toContain('& <');
  });

  it('percent-encodes the characters that would break a CSS data URI', () => {
    const dataUri = buildWatermarkTile({ text: '© José Valdiviezo', size: 140 });

    // A raw `#` truncates the URI at a fragment, taking the second half of the SVG with it.
    expect(dataUri).not.toContain('#');
    expect(dataUri).not.toContain('<');
    expect(dataUri).toContain('%23000000');
  });

  it('applies the requested opacity to the fill and a softer one to the shadow', () => {
    const svg = decode(buildWatermarkTile({ text: 'Mark', size: 140, opacity: 0.4 }));

    expect(svg).toContain('fill-opacity="0.4"');
    expect(svg).toContain('fill-opacity="0.22"');
  });

  it('clamps out-of-range opacity and falls back on a non-finite one', () => {
    expect(decode(buildWatermarkTile({ text: 'Mark', size: 140, opacity: 5 }))).toContain('fill-opacity="1"');
    expect(decode(buildWatermarkTile({ text: 'Mark', size: 140, opacity: -1 }))).toContain('fill-opacity="0"');
    expect(decode(buildWatermarkTile({ text: 'Mark', size: 140, opacity: Number.NaN })).includes(
      `fill-opacity="${DEFAULT_OVERLAY_OPACITY}"`,
    )).toBe(true);
  });
});
