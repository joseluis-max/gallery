import type { Db } from 'mongodb';

/**
 * A quantity threshold at which every photo in the cart gets a lower unit price.
 *
 * The discount is **retroactive across the whole cart**, not marginal: at `minQty: 5`,
 * all five photos cost `unitPriceCents`, not just the fifth. That's the version a
 * customer can predict without doing arithmetic, and it's what "buy 5, they're $1.50
 * each" means to everyone who reads it.
 */
export interface VolumeTier {
  minQty: number;
  unitPriceCents: number;
}

export interface SettingsDoc {
  _id: string;
  /** The price of a single photo, before any volume tier applies. */
  digitalPriceCents: number;
  /** Sorted ascending by `minQty` on write; readers should not assume order. */
  volumeTiers: VolumeTier[];
  updatedAt: Date;
}

const SETTINGS_ID = 'singleton';

export const DEFAULT_SETTINGS: SettingsDoc = {
  _id: SETTINGS_ID,
  digitalPriceCents: 200,
  volumeTiers: [
    { minQty: 3, unitPriceCents: 175 },
    { minQty: 5, unitPriceCents: 150 },
    { minQty: 10, unitPriceCents: 120 },
  ],
  updatedAt: new Date(0),
};

export async function getSettings(db: Db): Promise<SettingsDoc> {
  const doc = await db.collection<SettingsDoc>('settings').findOne({ _id: SETTINGS_ID });
  if (!doc) return DEFAULT_SETTINGS;
  // A document written before volume tiers existed has no `volumeTiers` array. Falling
  // back keeps pricing working instead of throwing on `.filter` of undefined.
  return { ...doc, volumeTiers: doc.volumeTiers ?? [] };
}

/** `replaceOne`, not `$set` — so the first save after the print removal also clears the
 *  now-unused paper stocks, size presets and shipping zones out of any stored document,
 *  rather than leaving dead keys behind forever. */
export async function saveSettings(db: Db, next: Omit<SettingsDoc, '_id' | 'updatedAt'>): Promise<SettingsDoc> {
  const updated: SettingsDoc = {
    ...next,
    volumeTiers: [...next.volumeTiers].sort((a, b) => a.minQty - b.minQty),
    _id: SETTINGS_ID,
    updatedAt: new Date(),
  };
  await db.collection<SettingsDoc>('settings').replaceOne({ _id: SETTINGS_ID }, updated, { upsert: true });
  return updated;
}
