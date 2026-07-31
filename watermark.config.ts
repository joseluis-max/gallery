import type { WatermarkConfig } from './src/lib/images.ts';

// Bottom-left, ≈20% of the image's width, inset 3% from the left/bottom edges, white at
// ~55% opacity with a soft dark shadow so it reads over both bright sky and dark lava
// rock. Passed as a function parameter (not read as a module-level constant) everywhere
// it's used, so the admin draft editor can override position/opacity per photo.
export const defaultWatermarkConfig: WatermarkConfig = {
  text: '© José Valdiviezo',
  widthPct: 0.2,
  insetPct: 0.03,
  opacity: 0.55,
  fillColor: '#ffffff',
  shadowColor: '#000000',
};
