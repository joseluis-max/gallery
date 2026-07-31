import type { Db } from 'mongodb';

export interface PaperStock {
  label: { es: string; en: string };
  multiplier: number;
}

export interface SizePreset {
  label: string;
  widthCm: number;
  heightCm: number;
}

export interface ShippingZone {
  key: string;
  label: string;
  flatRateCents: number;
}

export interface SettingsDoc {
  _id: string;
  baseCents: number;
  ratePerCm2Cents: number;
  /** Aspect-ratio deviation allowed before a print is rejected unless crop/border is chosen. */
  sizeTolerancePct: number;
  minCm: number;
  maxCmAbsolute: number;
  digitalPriceCents: number;
  paperStocks: Record<string, PaperStock>;
  sizePresets: SizePreset[];
  shippingZones: ShippingZone[];
  updatedAt: Date;
}

const SETTINGS_ID = 'singleton';

export const DEFAULT_SETTINGS: SettingsDoc = {
  _id: SETTINGS_ID,
  baseCents: 1500,
  ratePerCm2Cents: 0.9,
  sizeTolerancePct: 0.02,
  minCm: 10,
  maxCmAbsolute: 150,
  digitalPriceCents: 2000,
  paperStocks: {
    matte: { label: { es: 'Mate', en: 'Matte' }, multiplier: 1 },
    lustre: { label: { es: 'Luster', en: 'Lustre' }, multiplier: 1.15 },
    metallic: { label: { es: 'Metálico', en: 'Metallic' }, multiplier: 1.4 },
  },
  sizePresets: [
    { label: '20x30', widthCm: 20, heightCm: 30 },
    { label: '30x45', widthCm: 30, heightCm: 45 },
    { label: '40x60', widthCm: 40, heightCm: 60 },
    { label: '50x75', widthCm: 50, heightCm: 75 },
  ],
  shippingZones: [{ key: 'ecuador', label: 'Ecuador', flatRateCents: 500 }],
  updatedAt: new Date(0),
};

export async function getSettings(db: Db): Promise<SettingsDoc> {
  const doc = await db.collection<SettingsDoc>('settings').findOne({ _id: SETTINGS_ID });
  return doc ?? DEFAULT_SETTINGS;
}

export async function saveSettings(db: Db, next: Omit<SettingsDoc, '_id' | 'updatedAt'>): Promise<SettingsDoc> {
  const updated: SettingsDoc = { ...next, _id: SETTINGS_ID, updatedAt: new Date() };
  await db.collection<SettingsDoc>('settings').replaceOne({ _id: SETTINGS_ID }, updated, { upsert: true });
  return updated;
}
