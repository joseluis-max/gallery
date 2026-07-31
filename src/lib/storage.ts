import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type Bucket = 'originals' | 'public';

export interface PutObjectParams {
  bucket: Bucket;
  key: string;
  body: Buffer;
  contentType: string;
}

export interface PresignedGetParams {
  bucket: Bucket;
  key: string;
  expiresInSeconds: number;
  responseContentDisposition?: string;
}

export interface PresignedPutParams {
  key: string;
  contentType: string;
  expiresInSeconds: number;
}

export interface DeleteObjectParams {
  bucket: Bucket;
  key: string;
}

export interface GetObjectParams {
  bucket: Bucket;
  key: string;
}

export interface StorageAdapter {
  putObject(p: PutObjectParams): Promise<void>;
  /** Reads an object's bytes directly — used by the admin upload flow to pull an
   *  original back from R2 after the browser's direct PUT, so the server can run it
   *  through the same sharp pipeline the CLI ingest script uses. */
  getObject(p: GetObjectParams): Promise<Buffer>;
  getPresignedGetUrl(p: PresignedGetParams): Promise<string>;
  /** Presigned PUT is always against the originals bucket — that's the only bucket the
   *  admin browser-upload flow ever writes to directly. */
  getPresignedPutUrl(p: PresignedPutParams): Promise<string>;
  deleteObject(p: DeleteObjectParams): Promise<void>;
  /** No bucket parameter by design — this can structurally only ever address the public
   *  bucket, so it's impossible to accidentally construct a public URL for an original. */
  publicUrl(key: string): string;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketOriginals: string;
  bucketPublic: string;
  publicBaseUrl: string;
}

export class R2StorageAdapter implements StorageAdapter {
  private client: S3Client;

  constructor(private cfg: R2Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      // R2 doesn't implement the x-amz-checksum-* headers recent SDK versions send by
      // default on PutObject/UploadPart — without this, uploads fail with
      // "NotImplemented: Header 'x-amz-checksum-*' not implemented".
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private bucketName(bucket: Bucket): string {
    return bucket === 'originals' ? this.cfg.bucketOriginals : this.cfg.bucketPublic;
  }

  async putObject({ bucket, key, body, contentType }: PutObjectParams): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName(bucket),
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObject({ bucket, key }: GetObjectParams): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: key }));
    const bytes = await response.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async getPresignedGetUrl({
    bucket,
    key,
    expiresInSeconds,
    responseContentDisposition,
  }: PresignedGetParams): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName(bucket),
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async getPresignedPutUrl({ key, contentType, expiresInSeconds }: PresignedPutParams): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName('originals'),
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async deleteObject({ bucket, key }: DeleteObjectParams): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
}

/**
 * Filesystem-backed adapter for `scripts/ingest.ts --dry-run` and for unit tests —
 * exercises the full call graph (key naming, the "never publicUrl an original"
 * invariant, content-type plumbing) with zero network access and no R2 credentials.
 */
export class LocalFsStorageAdapter implements StorageAdapter {
  constructor(private rootDir: string) {}

  private path(bucket: Bucket, key: string): string {
    return join(this.rootDir, bucket, key);
  }

  async putObject({ bucket, key, body }: PutObjectParams): Promise<void> {
    const filePath = this.path(bucket, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
  }

  async getObject({ bucket, key }: GetObjectParams): Promise<Buffer> {
    return readFile(this.path(bucket, key));
  }

  async getPresignedGetUrl({ bucket, key }: PresignedGetParams): Promise<string> {
    // Never actually reachable over HTTP — fine for exercising logic/tests, not for
    // real delivery.
    return `file://${this.path(bucket, key)}`;
  }

  async getPresignedPutUrl({ key }: PresignedPutParams): Promise<string> {
    return `file://${this.path('originals', key)}`;
  }

  async deleteObject({ bucket, key }: DeleteObjectParams): Promise<void> {
    await rm(this.path(bucket, key), { force: true });
  }

  publicUrl(key: string): string {
    return `/local-public/${key}`;
  }
}

export function createStorageAdapter(mode: 'r2', config: R2Config): StorageAdapter;
export function createStorageAdapter(mode: 'local', rootDir: string): StorageAdapter;
export function createStorageAdapter(mode: 'r2' | 'local', arg: R2Config | string): StorageAdapter {
  if (mode === 'r2') return new R2StorageAdapter(arg as R2Config);
  return new LocalFsStorageAdapter(arg as string);
}
