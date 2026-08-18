import type { Db } from 'mongodb';

/**
 * One store-wide setting survives the move to digital-only: the price of a download.
 * Per-photo overrides still exist on `PhotoDoc.pricing.digitalPriceCents` for anything
 * that should differ from the default.
 */
export interface SettingsDoc {
  _id: string;
  digitalPriceCents: number;
  updatedAt: Date;
}

const SETTINGS_ID = 'singleton';

export const DEFAULT_SETTINGS: SettingsDoc = {
  _id: SETTINGS_ID,
  digitalPriceCents: 2000,
  updatedAt: new Date(0),
};

export async function getSettings(db: Db): Promise<SettingsDoc> {
  const doc = await db.collection<SettingsDoc>('settings').findOne({ _id: SETTINGS_ID });
  return doc ?? DEFAULT_SETTINGS;
}

/** `replaceOne`, not `$set` — so the first save after the print removal also clears the
 *  now-unused paper stocks, size presets and shipping zones out of any stored document,
 *  rather than leaving dead keys behind forever. */
export async function saveSettings(db: Db, next: Omit<SettingsDoc, '_id' | 'updatedAt'>): Promise<SettingsDoc> {
  const updated: SettingsDoc = { ...next, _id: SETTINGS_ID, updatedAt: new Date() };
  await db.collection<SettingsDoc>('settings').replaceOne({ _id: SETTINGS_ID }, updated, { upsert: true });
  return updated;
}
