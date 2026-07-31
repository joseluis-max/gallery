import type { Db } from 'mongodb';

export interface AuditLogEntry {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/**
 * The single write path for `auditLog` — every admin mutation routes through this so an
 * edit can't ship without leaving a trace. Append-only: nothing here ever updates or
 * deletes an existing entry.
 */
export async function writeAuditLog(db: Db, entry: AuditLogEntry): Promise<void> {
  await db.collection('auditLog').insertOne({ ...entry, at: new Date() });
}
