import type { Db, ObjectId } from 'mongodb';

export type UploadJobStatus = 'awaiting-upload' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface UploadJobDoc {
  _id: ObjectId;
  status: UploadJobStatus;
  originalKey: string;
  filename: string;
  bytes: number;
  error?: string;
  photoId?: ObjectId;
  photoSlug?: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function listUploadJobs(db: Db, limit = 50): Promise<UploadJobDoc[]> {
  return db.collection<UploadJobDoc>('uploadJobs').find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function getUploadJob(db: Db, id: ObjectId): Promise<UploadJobDoc | null> {
  return db.collection<UploadJobDoc>('uploadJobs').findOne({ _id: id });
}

export async function updateUploadJob(db: Db, id: ObjectId, patch: Partial<Omit<UploadJobDoc, '_id'>>): Promise<void> {
  await db.collection<UploadJobDoc>('uploadJobs').updateOne({ _id: id }, { $set: { ...patch, updatedAt: new Date() } });
}
