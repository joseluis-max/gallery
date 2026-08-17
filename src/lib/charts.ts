/**
 * Chart geometry, as pure functions.
 *
 * The admin charts are server-rendered SVG — no charting library, no client-side
 * plotting code, nothing to hydrate. That only works if the arithmetic (scales, ticks,
 * bar rectangles, line paths) lives somewhere unit-testable rather than inline in an
 * `.astro` template, which is what this file is. The components in
 * `src/components/admin/` are then pure markup over these results.
 *
 * Mark specs (bar ≤24px with a 4px rounded data-end squared off at the baseline, 2px
 * line, ≥8px end marker, ~10% area wash, 2px surface gaps) are encoded in the defaults
 * here so every chart in the panel is consistent by construction.
 */

export interface ChartDatum {
  /** Stable identity for the row — also what a table-view twin keys on. */
  key: string;
  label: string;
  value: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MAX_BAR_THICKNESS = 24;
export const BAR_RADIUS = 4;
/** The "surface gap" spacer: adjacent marks are separated by background, never by a
 *  stroke drawn around them. */
export const SURFACE_GAP = 2;

/** Rounds a rough step up to the nearest 1/2/5 × 10ⁿ so axis ticks land on numbers a
 *  human would have chosen (0 / 50 / 100, never 0 / 37 / 74). */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exponent = Math.floor(Math.log10(rough));
  const base = 10 ** exponent;
  const fraction = rough / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

export interface AxisScale {
  max: number;
  ticks: number[];
}

/**
 * Ticks for a zero-based value axis. The returned `max` is the last tick, not the raw
 * data maximum, so the tallest bar ends exactly on a labelled gridline.
 *
 * `emptyMax` is the axis to draw when every value is zero — a real case here (a month
 * with no sales at all). It's caller-supplied because the sensible empty axis depends
 * on the unit: 0–1 for a count, but 0–$10 for money, since a currency axis topping out
 * at one cent reads as a bug rather than as "nothing sold yet".
 */
export function axisScale(rawMax: number, tickCount = 3, emptyMax = 1): AxisScale {
  const effectiveMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Math.max(emptyMax, 1);

  // Every quantity charted here is integral — cents or unit counts — so the step never
  // goes below 1. Without this floor, a chart whose maximum is a single order would tick
  // 0 / 0.5 / 1, and half an order doesn't exist.
  const step = Math.max(1, niceStep(effectiveMax / Math.max(1, tickCount)));
  const max = step * Math.ceil(effectiveMax / step);
  const ticks: number[] = [];
  // Accumulating `v += step` would drift on fractional steps; multiplying keeps every
  // tick exact.
  for (let i = 0; i * step <= max + step / 1000; i++) ticks.push(i * step);
  return { max, ticks };
}

/** A column with a rounded cap and square feet: rounding all four corners (an SVG
 *  `rx`) detaches the mark from its baseline, which is the one edge that must read as
 *  exact. */
export function columnPath(x: number, y: number, width: number, height: number, radius = BAR_RADIUS): string {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const bottom = y + height;
  return [
    `M${x} ${bottom}`,
    `L${x} ${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `L${x + width - r} ${y}`,
    `Q${x + width} ${y} ${x + width} ${y + r}`,
    `L${x + width} ${bottom}`,
    'Z',
  ].join('');
}

/** The horizontal twin of `columnPath` — rounded at the value end, square where it
 *  meets the left baseline. */
export function barPath(x: number, y: number, width: number, height: number, radius = BAR_RADIUS): string {
  const r = Math.max(0, Math.min(radius, height / 2, width));
  const right = x + width;
  return [
    `M${x} ${y}`,
    `L${right - r} ${y}`,
    `Q${right} ${y} ${right} ${y + r}`,
    `L${right} ${y + height - r}`,
    `Q${right} ${y + height} ${right - r} ${y + height}`,
    `L${x} ${y + height}`,
    'Z',
  ].join('');
}

function plotArea(width: number, height: number, padding: Padding): Rect {
  return {
    x: padding.left,
    y: padding.top,
    width: Math.max(0, width - padding.left - padding.right),
    height: Math.max(0, height - padding.top - padding.bottom),
  };
}

export interface AxisTick {
  value: number;
  /** Position along the value axis, in viewBox units. */
  offset: number;
}

export interface ColumnMark extends ChartDatum {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
}

export interface ColumnLayout {
  plot: Rect;
  scale: AxisScale;
  ticks: AxisTick[];
  columns: ColumnMark[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  padding: Padding;
  tickCount?: number;
  maxThickness?: number;
  /** Axis maximum used when every value is zero — see `axisScale`. */
  emptyMax?: number;
}

/** The all-zero axis to draw for each unit: $10 for money, 1 for counts. */
export function emptyMaxFor(format: ValueFormat): number {
  return format === 'currency' ? 1000 : 1;
}

/** Vertical columns over a categorical/time axis (revenue per month, orders per month). */
export function layoutColumns(data: ChartDatum[], options: LayoutOptions): ColumnLayout {
  const plot = plotArea(options.width, options.height, options.padding);
  const scale = axisScale(Math.max(0, ...data.map((d) => d.value)), options.tickCount ?? 3, options.emptyMax);
  const maxThickness = options.maxThickness ?? MAX_BAR_THICKNESS;

  const slot = data.length > 0 ? plot.width / data.length : plot.width;
  // Cap the thickness rather than filling the slot — the leftover is deliberate air,
  // and the 2px surface gap keeps neighbours from touching at narrow widths.
  const thickness = Math.max(1, Math.min(maxThickness, slot - SURFACE_GAP));

  const columns = data.map((datum, index) => {
    const centerX = plot.x + slot * (index + 0.5);
    const height = scale.max > 0 ? (Math.max(0, datum.value) / scale.max) * plot.height : 0;
    return {
      ...datum,
      x: centerX - thickness / 2,
      y: plot.y + plot.height - height,
      width: thickness,
      height,
      centerX,
    };
  });

  return {
    plot,
    scale,
    ticks: scale.ticks.map((value) => ({ value, offset: plot.y + plot.height - (value / scale.max) * plot.height })),
    columns,
  };
}

export interface BarMark extends ChartDatum {
  x: number;
  y: number;
  width: number;
  height: number;
  centerY: number;
}

export interface BarLayout {
  plot: Rect;
  scale: AxisScale;
  bars: BarMark[];
  /** Total height the caller should give the SVG — horizontal bar charts grow with the
   *  number of rows instead of squeezing them into a fixed box. */
  height: number;
}

export interface HorizontalLayoutOptions {
  width: number;
  padding: Padding;
  rowHeight?: number;
  thickness?: number;
  tickCount?: number;
  emptyMax?: number;
}

/** Horizontal bars for nominal categories (best sellers, orders by status) — the form
 *  that survives long labels, which columns don't. */
export function layoutBars(data: ChartDatum[], options: HorizontalLayoutOptions): BarLayout {
  const rowHeight = options.rowHeight ?? 28;
  const thickness = Math.min(options.thickness ?? MAX_BAR_THICKNESS, rowHeight - SURFACE_GAP);
  const height = options.padding.top + options.padding.bottom + rowHeight * data.length;
  const plot = plotArea(options.width, height, options.padding);
  const scale = axisScale(Math.max(0, ...data.map((d) => d.value)), options.tickCount ?? 3, options.emptyMax);

  const bars = data.map((datum, index) => {
    const centerY = plot.y + rowHeight * (index + 0.5);
    const barWidth = scale.max > 0 ? (Math.max(0, datum.value) / scale.max) * plot.width : 0;
    return { ...datum, x: plot.x, y: centerY - thickness / 2, width: barWidth, height: thickness, centerY };
  });

  return { plot, scale, bars, height };
}

export interface LinePoint extends ChartDatum {
  x: number;
  y: number;
}

export interface LineLayout {
  plot: Rect;
  scale: AxisScale;
  ticks: AxisTick[];
  points: LinePoint[];
  /** `d` for the 2px stroked line. */
  path: string;
  /** `d` for the ~10% opacity wash beneath it, closed along the baseline. */
  areaPath: string;
}

/** A continuous series over time (orders per day). */
export function layoutLine(data: ChartDatum[], options: LayoutOptions): LineLayout {
  const plot = plotArea(options.width, options.height, options.padding);
  const scale = axisScale(Math.max(0, ...data.map((d) => d.value)), options.tickCount ?? 3, options.emptyMax);

  const step = data.length > 1 ? plot.width / (data.length - 1) : 0;
  const points = data.map((datum, index) => ({
    ...datum,
    // A single data point sits centred rather than pinned to the left edge, where it
    // would read as the start of a series that just hasn't been drawn.
    x: data.length > 1 ? plot.x + step * index : plot.x + plot.width / 2,
    y: plot.y + plot.height - (Math.max(0, datum.value) / scale.max) * plot.height,
  }));

  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`).join(' ');
  const baseline = plot.y + plot.height;
  const areaPath =
    points.length > 0
      ? `${path} L${round(points[points.length - 1].x)} ${round(baseline)} L${round(points[0].x)} ${round(baseline)} Z`
      : '';

  return {
    plot,
    scale,
    ticks: scale.ticks.map((value) => ({ value, offset: plot.y + plot.height - (value / scale.max) * plot.height })),
    points,
    path,
    areaPath,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Axis ticks and stat tiles get the compact form ($4.2K); tables keep full precision,
 *  because a column of numbers is read for its exact values. */
export function formatCompactCents(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) return `$${(dollars / 1000).toFixed(dollars % 1000 === 0 ? 0 : 1)}K`;
  return `$${dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export type ValueFormat = 'currency' | 'count';

export function formatValue(value: number, format: ValueFormat): string {
  return format === 'currency' ? formatCents(value) : formatCount(value);
}

export function formatAxisValue(value: number, format: ValueFormat): string {
  return format === 'currency' ? formatCompactCents(value) : formatCount(value);
}

/** Percentage change against a previous period, or `null` when there's no baseline to
 *  compare against — "+∞%" from a zero base is noise, not a delta. */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}
