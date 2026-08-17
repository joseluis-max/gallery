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
   *  original back from storage after the browser's direct PUT, so the server can run
   *  it through the same sharp pipeline the CLI ingest script uses. */
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

export interface S3CompatibleConfig {
  /** Full origin of the S3-compatible API, e.g. `https://storage.googleapis.com`. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketOriginals: string;
  bucketPublic: string;
  /**
   * Key prefixes per class of object. With two buckets these stay empty and the bucket
   * *is* the boundary. With a single bucket (`bucketOriginals === bucketPublic`) they
   * become the boundary instead, and the bucket's IAM policy has to grant public read
   * to `publicPrefix` alone — see the single-bucket note in the README.
   */
  originalsPrefix?: string;
  publicPrefix?: string;
  /**
   * Predefined ACL applied to objects written to the **public** class only (never to
   * originals). Google Cloud Storage refuses IAM conditions on `allUsers` bindings
   * ("Conditions are not allowed on public resources"), so a single bucket cannot be
   * made public for one prefix and private for another at the policy level — the only
   * unconditional binding would expose originals too. Per-object ACLs are what make
   * one bucket workable, and they fail in the safe direction: forget one and a
   * derivative 403s (a broken thumbnail), which is visible and harmless, rather than an
   * original becoming world-readable.
   */
  publicObjectAcl?: 'public-read';
  publicBaseUrl: string;
  /** `https://endpoint/<bucket>/<key>` instead of `https://<bucket>.endpoint/<key>`.
   *  Required for Google Cloud Storage, whose virtual-hosted form doesn't cover bucket
   *  names containing dots under the wildcard certificate. */
  forcePathStyle?: boolean;
  region?: string;
}

/**
 * The S3 XML API, which Google Cloud Storage speaks alongside its native one. Kept as a
 * generic adapter rather than folded into `GcsStorageAdapter` so a second S3-compatible
 * provider is a constructor, not a reimplementation of the upload/presign/delete logic.
 */
export class S3CompatibleStorageAdapter implements StorageAdapter {
  private client: S3Client;

  constructor(private cfg: S3CompatibleConfig) {
    this.client = new S3Client({
      region: cfg.region ?? 'auto',
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      // GCS doesn't implement the x-amz-checksum-* headers recent SDK versions send by
      // default on PutObject/UploadPart — without this, uploads fail with
      // "NotImplemented: Header 'x-amz-checksum-*' not implemented".
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private bucketName(bucket: Bucket): string {
    return bucket === 'originals' ? this.cfg.bucketOriginals : this.cfg.bucketPublic;
  }

  /** The stored object name: the caller's key under its class's prefix. Every command
   *  below goes through this, so no code path can write an original outside the
   *  originals prefix — which in single-bucket mode is the only thing separating it
   *  from the world-readable half. */
  private objectName(bucket: Bucket, key: string): string {
    const prefix = bucket === 'originals' ? this.cfg.originalsPrefix : this.cfg.publicPrefix;
    return prefix ? `${prefix.replace(/\/$/, '')}/${key}` : key;
  }

  async putObject({ bucket, key, body, contentType }: PutObjectParams): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName(bucket),
        Key: this.objectName(bucket, key),
        Body: body,
        ContentType: contentType,
        // Guarded on `bucket === 'public'`, not on the caller passing the right thing:
        // an original can never pick up the public ACL, whatever the call site does.
        ...(bucket === 'public' && this.cfg.publicObjectAcl ? { ACL: this.cfg.publicObjectAcl } : {}),
      }),
    );
  }

  async getObject({ bucket, key }: GetObjectParams): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: this.objectName(bucket, key) }),
    );
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
      Key: this.objectName(bucket, key),
      ResponseContentDisposition: responseContentDisposition,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async getPresignedPutUrl({ key, contentType, expiresInSeconds }: PresignedPutParams): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName('originals'),
      Key: this.objectName('originals', key),
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async deleteObject({ bucket, key }: DeleteObjectParams): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: this.objectName(bucket, key) }),
    );
  }

  publicUrl(key: string): string {
    // Hardcoded to the *public* class — same guarantee as before, now expressed as a
    // prefix instead of a bucket: this method cannot name an original.
    return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${this.objectName('public', key)}`;
  }
}

export interface GcsConfig {
  /** HMAC key pair from GCS *interoperability* settings — not a service-account JSON
   *  key. This is what lets the S3 API (and therefore presigned browser uploads) work
   *  against a GCS bucket. */
  accessKeyId: string;
  secretAccessKey: string;
  /** One bucket holds both classes of object, separated by prefix. */
  bucket: string;
  originalsPrefix?: string;
  publicPrefix?: string;
  /** Defaults to the bucket's own storage.googleapis.com origin. Override it when the
   *  public prefix sits behind Cloud CDN or a custom domain. */
  publicBaseUrl?: string;
}

export const GCS_ENDPOINT = 'https://storage.googleapis.com';
export const DEFAULT_ORIGINALS_PREFIX = 'originals';
export const DEFAULT_PUBLIC_PREFIX = 'public';

/**
 * Google Cloud Storage, single bucket.
 *
 * Originals and derivatives live under two prefixes of one bucket rather than in two
 * buckets. The bucket itself stays private — GCS won't accept an IAM condition on an
 * `allUsers` binding, so there is no policy that opens one prefix and not the other —
 * and derivatives are instead made readable **one object at a time** via a `public-read`
 * ACL, applied by `putObject` only for the public class.
 *
 * Two consequences worth knowing:
 *   - The bucket needs fine-grained access (uniform bucket-level access OFF), since
 *     UBLA disables object ACLs entirely.
 *   - The failure mode is safe: a derivative written without the ACL is unreadable
 *     (a broken image), never an original that became readable.
 *
 * Every method also routes through `objectName()`, so nothing can write, sign, or link
 * an original outside the originals prefix.
 */
export class GcsStorageAdapter extends S3CompatibleStorageAdapter {
  constructor(cfg: GcsConfig) {
    super({
      endpoint: GCS_ENDPOINT,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      bucketOriginals: cfg.bucket,
      bucketPublic: cfg.bucket,
      originalsPrefix: cfg.originalsPrefix ?? DEFAULT_ORIGINALS_PREFIX,
      publicPrefix: cfg.publicPrefix ?? DEFAULT_PUBLIC_PREFIX,
      publicObjectAcl: 'public-read',
      publicBaseUrl: cfg.publicBaseUrl || `${GCS_ENDPOINT}/${cfg.bucket}`,
      // GCS's wildcard cert doesn't cover bucket names with dots in the virtual-hosted
      // form, and path style works for every bucket name — so it's simply always on.
      forcePathStyle: true,
      // GCS ignores the region for signing purposes but the SDK requires one.
      region: 'auto',
    });
  }
}

/**
 * Filesystem-backed adapter for `scripts/ingest.ts --dry-run` and for unit tests —
 * exercises the full call graph (key naming, the "never publicUrl an original"
 * invariant, content-type plumbing) with zero network access and no cloud credentials.
 */
export interface LocalUrlOptions {
  /** Where `publicUrl()` points. Defaults to the `/local-public/` prefix that
   *  `src/pages/local-public/[...key].ts` serves. */
  publicUrlBase?: string;
  /**
   * When set, `getPresignedPutUrl()` returns `<uploadUrlBase>/<key>` instead of a
   * `file://` path — a browser can't PUT to `file://`, so the local *driver* points
   * this at the app's own admin upload route while `--dry-run` and the unit tests keep
   * the inert `file://` form.
   */
  uploadUrlBase?: string;
}

export class LocalFsStorageAdapter implements StorageAdapter {
  constructor(
    private rootDir: string,
    private urls: LocalUrlOptions = {},
  ) {}

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
    if (this.urls.uploadUrlBase) {
      return `${this.urls.uploadUrlBase.replace(/\/$/, '')}/${key}`;
    }
    return `file://${this.path('originals', key)}`;
  }

  async deleteObject({ bucket, key }: DeleteObjectParams): Promise<void> {
    await rm(this.path(bucket, key), { force: true });
  }

  publicUrl(key: string): string {
    return `${(this.urls.publicUrlBase ?? '/local-public').replace(/\/$/, '')}/${key}`;
  }
}

export function createStorageAdapter(mode: 'gcs', config: GcsConfig): StorageAdapter;
export function createStorageAdapter(mode: 'local', rootDir: string, urls?: LocalUrlOptions): StorageAdapter;
export function createStorageAdapter(
  mode: 'gcs' | 'local',
  arg: GcsConfig | string,
  urls?: LocalUrlOptions,
): StorageAdapter {
  if (mode === 'gcs') return new GcsStorageAdapter(arg as GcsConfig);
  return new LocalFsStorageAdapter(arg as string, urls);
}
