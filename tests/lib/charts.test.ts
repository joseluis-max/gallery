import { describe, expect, it } from 'vitest';
import {
  axisScale,
  barPath,
  columnPath,
  formatCents,
  formatCompactCents,
  layoutBars,
  layoutColumns,
  layoutLine,
  MAX_BAR_THICKNESS,
  niceStep,
  percentChange,
} from '../../src/lib/charts.ts';

const PADDING = { top: 10, right: 10, bottom: 20, left: 40 };
const OPTIONS = { width: 400, height: 200, padding: PADDING };

function data(values: number[]) {
  return values.map((value, index) => ({ key: `k${index}`, label: `L${index}`, value }));
}

describe('niceStep', () => {
  it('rounds up to the nearest 1/2/5 × 10ⁿ', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.4)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(1234)).toBe(2000);
  });

  it('never returns zero or NaN for degenerate input', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });
});

describe('axisScale', () => {
  it('ends on a round tick at or above the data maximum', () => {
    const scale = axisScale(1750, 3);
    expect(scale.max).toBeGreaterThanOrEqual(1750);
    expect(scale.ticks[0]).toBe(0);
    expect(scale.ticks.at(-1)).toBe(scale.max);
  });

  it('spaces ticks evenly without floating-point drift', () => {
    const { ticks } = axisScale(1, 3);
    const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 10);
  });

  it('falls back to a 0–1 axis for an all-zero series instead of dividing by zero', () => {
    expect(axisScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it('uses the caller’s empty axis when every value is zero, so a money chart never tops out at one cent', () => {
    const scale = axisScale(0, 3, 1000);
    expect(scale.max).toBe(1000);
    expect(scale.ticks).toEqual([0, 500, 1000]);
  });

  it('ignores the empty axis as soon as there is real data', () => {
    expect(axisScale(4, 3, 1000)).toEqual({ max: 4, ticks: [0, 2, 4] });
  });

  it('never ticks in fractions, since orders and cents are both whole numbers', () => {
    expect(axisScale(1, 3).ticks).toEqual([0, 1]);
    expect(axisScale(2, 3).ticks).toEqual([0, 1, 2]);
  });
});

describe('columnPath / barPath', () => {
  it('rounds the data end and squares the baseline end', () => {
    const path = columnPath(0, 50, 20, 50, 4);
    // Two quadratic curves at the top, none at the bottom.
    expect(path.match(/Q/g)).toHaveLength(2);
    expect(path.startsWith('M0 100')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
  });

  it('clamps the radius so a very short column never inverts its own cap', () => {
    expect(() => columnPath(0, 98, 20, 2, 4)).not.toThrow();
    expect(columnPath(0, 98, 20, 2, 4)).not.toContain('NaN');
    expect(barPath(0, 0, 1, 24, 4)).not.toContain('NaN');
  });
});

describe('layoutColumns', () => {
  it('scales the tallest column to the full plot height', () => {
    const layout = layoutColumns(data([10, 20, 40]), OPTIONS);
    const tallest = layout.columns.at(-1)!;
    // 40 against an axis that ends at 40 → the plot's full height.
    expect(layout.scale.max).toBe(40);
    expect(tallest.height).toBeCloseTo(layout.plot.height, 6);
    expect(tallest.y).toBeCloseTo(layout.plot.y, 6);
  });

  it('caps bar thickness instead of filling the whole slot', () => {
    const layout = layoutColumns(data([1, 2]), OPTIONS);
    expect(layout.columns[0].width).toBeLessThanOrEqual(MAX_BAR_THICKNESS);
  });

  it('leaves a surface gap between adjacent columns at narrow widths', () => {
    const layout = layoutColumns(data(Array.from({ length: 30 }, () => 1)), OPTIONS);
    const [first, second] = layout.columns;
    expect(second.x).toBeGreaterThan(first.x + first.width);
  });

  it('gives a zero value zero height, so an empty month renders as a gap not a stub', () => {
    const layout = layoutColumns(data([0, 5]), OPTIONS);
    expect(layout.columns[0].height).toBe(0);
  });

  it('keeps every column inside the plot area', () => {
    const layout = layoutColumns(data([3, 9, 1]), OPTIONS);
    for (const column of layout.columns) {
      expect(column.x).toBeGreaterThanOrEqual(layout.plot.x);
      expect(column.x + column.width).toBeLessThanOrEqual(layout.plot.x + layout.plot.width + 1e-9);
      expect(column.y).toBeGreaterThanOrEqual(layout.plot.y - 1e-9);
    }
  });

  it('survives an empty series', () => {
    const layout = layoutColumns([], OPTIONS);
    expect(layout.columns).toEqual([]);
    expect(layout.ticks.length).toBeGreaterThan(0);
  });
});

describe('layoutBars', () => {
  it('grows the SVG height with the number of rows rather than squeezing them', () => {
    const three = layoutBars(data([1, 2, 3]), { width: 400, padding: PADDING, rowHeight: 30 });
    const six = layoutBars(data([1, 2, 3, 4, 5, 6]), { width: 400, padding: PADDING, rowHeight: 30 });
    expect(six.height - three.height).toBe(90);
  });

  it('starts every bar at the same baseline and scales lengths against the axis maximum', () => {
    const layout = layoutBars(data([2, 8]), { width: 400, padding: PADDING });
    expect(layout.bars[0].x).toBe(layout.bars[1].x);
    // The axis rounds up past the data (8 → a 10 tick), so the longest bar stops short
    // of the full width by exactly that ratio rather than filling it.
    expect(layout.bars[1].width).toBeCloseTo(layout.plot.width * (8 / layout.scale.max), 6);
    expect(layout.bars[0].width).toBeCloseTo(layout.bars[1].width / 4, 6);
  });
});

describe('layoutLine', () => {
  it('builds a line path with one point per datum and an area path closed on the baseline', () => {
    const layout = layoutLine(data([1, 3, 2]), OPTIONS);
    expect(layout.points).toHaveLength(3);
    expect(layout.path.startsWith('M')).toBe(true);
    expect(layout.path.match(/L/g)).toHaveLength(2);
    expect(layout.areaPath.endsWith('Z')).toBe(true);
  });

  it('centres a single point instead of pinning it to the left edge', () => {
    const layout = layoutLine(data([5]), OPTIONS);
    expect(layout.points[0].x).toBeCloseTo(layout.plot.x + layout.plot.width / 2, 6);
  });

  it('produces no area path for an empty series', () => {
    expect(layoutLine([], OPTIONS).areaPath).toBe('');
  });
});

describe('formatting', () => {
  it('formats cents as dollars with two decimals and thousands separators', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(123456)).toBe('$1,234.56');
  });

  it('compacts axis values past a thousand dollars', () => {
    expect(formatCompactCents(50000)).toBe('$500');
    expect(formatCompactCents(150000)).toBe('$1.5K');
    expect(formatCompactCents(200000)).toBe('$2K');
  });
});

describe('percentChange', () => {
  it('computes a signed percentage against the previous period', () => {
    expect(percentChange(150, 100)).toBeCloseTo(50);
    expect(percentChange(50, 100)).toBeCloseTo(-50);
  });

  it('returns null when there is no baseline, rather than an infinite delta', () => {
    expect(percentChange(500, 0)).toBeNull();
  });
});
