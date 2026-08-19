/**
 * Builds one tile of the repeating mark the browser paints *on top of* a photograph.
 *
 * This is a second, independent watermark from the one in lib/images.ts, and the two do
 * different jobs. That one is burned into the derivative's pixels: a single corner mark
 * that survives being saved, re-hosted or re-encoded, but that a cropper can cut off.
 * This one exists only in the page: a lattice across the whole frame, trivially removed
 * in devtools, but present in the one artefact the burned-in mark can't defend — a
 * screenshot of the photo as displayed, which no server-side measure can prevent.
 *
 * Deliberately standalone rather than reusing lib/images.ts's SVG/escape helpers: that
 * module imports sharp and exifr, and this one is pulled in by a component that renders
 * on every gallery page, where dragging the whole image pipeline along buys nothing.
 */

export interface WatermarkTileOptions {
  text: string;
  /** Edge of one repeat, in CSS px. Feed the same number to `background-size`. */
  size: number;
  /** Opacity of the light text, 0-1. The dark shadow behind it tracks at 75% of this. */
  opacity?: number;
}

/** Light enough to browse behind, dark enough to survive a screenshot re-crop. */
export const DEFAULT_OVERLAY_OPACITY = 0.28;

/**
 * Returns a `url()`-ready `data:image/svg+xml` URI for a square tile carrying the mark
 * once, on the diagonal. Repeating it (`background-repeat: repeat`) is what produces the
 * lattice — no per-photo work, and the tile is small enough to stay inline.
 */
export function buildWatermarkTile({ text, size, opacity = DEFAULT_OVERLAY_OPACITY }: WatermarkTileOptions): string {
  const edge = Math.max(1, Math.round(size));
  const center = edge / 2;
  const alpha = clamp01(opacity);

  // Same `textLength` + `lengthAdjust` trick as the burned-in mark in lib/images.ts, and
  // for the same reason: it pins the rendered text to a fixed fraction of the tile no
  // matter which font the visitor's device actually substitutes, so the lattice keeps its
  // spacing everywhere instead of going sparse on one platform and crowded on another.
  const span = Math.round(edge * 0.78);
  // Taller glyphs for the same `textLength` means thicker strokes, which is most of what
  // makes the mark survive being viewed small or re-compressed — raising opacity alone
  // just tints the photograph.
  const fontSize = Math.max(8, Math.round(edge * 0.1));
  const baselineShift = Math.round(fontSize * 0.35);
  // Scaled with the type rather than a flat 1px: on a bright frame the white fill has
  // almost nothing to contrast against, so the offset dark copy is what's actually
  // carrying the mark there, and a hairline offset behind 22px glyphs disappears.
  const shadowOffset = Math.max(1, Math.round(fontSize * 0.1));
  const escaped = escapeXml(text);

  const glyphs = `font-family="Georgia, 'Iowan Old Style', serif" font-size="${fontSize}" text-anchor="middle" textLength="${span}" lengthAdjust="spacingAndGlyphs"`;

  // Two copies, dark offset behind light — the mark has to stay legible over a blown-out
  // sky and over a shadowed stadium stand, and a single fill can only manage one of those.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${edge}">` +
    `<g transform="rotate(-30 ${center} ${center})">` +
    `<text x="${center + shadowOffset}" y="${center + baselineShift + shadowOffset}" ${glyphs} fill="#000000" fill-opacity="${round(alpha * 0.75)}">${escaped}</text>` +
    `<text x="${center}" y="${center + baselineShift}" ${glyphs} fill="#ffffff" fill-opacity="${round(alpha)}">${escaped}</text>` +
    `</g></svg>`;

  // encodeURIComponent, not a raw string: an unencoded `#` from the fill colours would
  // truncate the URI at a fragment, and `<`/`&` would break out of the CSS value.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_OVERLAY_OPACITY;
  return Math.min(1, Math.max(0, n));
}

function round(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
