import { createHash } from 'node:crypto';
import {
   DeleteObjectCommand,
   GetObjectCommand,
   HeadObjectCommand,
   PutObjectCommand,
   S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage.
 *
 * Berry keeps agent output in S3 (MinIO in development) and its identity in
 * PostgreSQL. This is the half that holds bytes; `run_artifacts` holds what
 * they are and who produced them.
 *
 * The rules here are mostly about refusing things. A key is validated before
 * it reaches the bucket, a body is measured before it is uploaded, and a
 * supplied checksum is verified rather than recorded — because a store that
 * accepts whatever it is handed cannot later be trusted about what it holds.
 */

export class InvalidKey extends Error {
   constructor(key: string) {
      super(`invalid storage key: ${key}`);
      this.name = 'InvalidKey';
   }
}

export class ObjectTooLarge extends Error {
   constructor(maxBytes: number) {
      super(`object exceeds the maximum of ${maxBytes} bytes`);
      this.name = 'ObjectTooLarge';
   }
}

export class ChecksumMismatch extends Error {
   constructor() {
      super('object checksum does not match the one supplied');
      this.name = 'ChecksumMismatch';
   }
}

export class ObjectNotFound extends Error {
   constructor(key: string) {
      super(`storage object not found: ${key}`);
      this.name = 'ObjectNotFound';
   }
}

export interface StoredObject {
   key: string;
   size: number;
   contentType: string;
   /** Lowercase hex SHA-256 of the bytes as stored. */
   checksumSha256: string;
   etag: string;
   metadata: Record<string, string>;
   updatedAt: Date;
}

export interface PutOptions {
   contentType?: string;
   /** When given, the upload is refused unless the bytes hash to this. */
   checksumSha256?: string;
   metadata?: Record<string, string>;
}

export interface StorageOptions {
   bucket: string;
   region?: string;
   endpoint?: string;
   forcePathStyle?: boolean;
   accessKeyId?: string;
   secretAccessKey?: string;
   sessionToken?: string;
   maxBytes?: number;
   client?: S3Client;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_KEY_LENGTH = 1024;

/**
 * A key that is safe to hand to a bucket.
 *
 * Rejected rather than sanitised: an escaping key silently rewritten is a key
 * that points somewhere the caller did not mean, and the caller will never
 * find out. `..` and absolute paths are the obvious cases; a backslash matters
 * because some object stores and every Windows client treat it as a separator.
 */
export function validateKey(key: string): string[] {
   if (
      key === '' ||
      key.length > MAX_KEY_LENGTH ||
      key.includes('\0') ||
      key.includes('\\') ||
      key.startsWith('/')
   ) {
      throw new InvalidKey(key);
   }
   const parts = key.split('/');
   for (const part of parts) {
      if (part === '' || part === '.' || part === '..') throw new InvalidKey(key);
   }
   return parts;
}

export class Storage {
   private readonly client: S3Client;
   private readonly bucket: string;
   private readonly maxBytes: number;

   constructor(options: StorageOptions) {
      this.bucket = options.bucket;
      this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      this.client =
         options.client ??
         new S3Client({
            region: options.region ?? 'us-east-1',
            ...(options.endpoint ? { endpoint: options.endpoint } : {}),
            // MinIO addresses buckets by path, not by subdomain.
            forcePathStyle: options.forcePathStyle ?? true,
            ...(options.accessKeyId && options.secretAccessKey
               ? {
                    credentials: {
                       accessKeyId: options.accessKeyId,
                       secretAccessKey: options.secretAccessKey,
                       ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
                    },
                 }
               : {}),
         });
   }

   /**
    * Stores bytes under a key.
    *
    * The body is buffered rather than streamed. It is bounded by `maxBytes`
    * and has to be hashed before it is sent — a checksum computed after upload
    * cannot refuse a corrupted object, only describe one.
    */
   async put(key: string, body: Uint8Array, options: PutOptions = {}): Promise<StoredObject> {
      validateKey(key);
      if (body.byteLength > this.maxBytes) throw new ObjectTooLarge(this.maxBytes);

      const checksum = createHash('sha256').update(body).digest('hex');
      if (options.checksumSha256 && !equalsIgnoringCase(options.checksumSha256, checksum)) {
         throw new ChecksumMismatch();
      }
      const contentType = options.contentType ?? sniffContentType(body);

      const result = await this.client.send(
         new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            // Base64, which is how S3 expresses a SHA-256 — it verifies the
            // upload server-side and rejects a body that arrived damaged.
            ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
            ...(options.metadata ? { Metadata: options.metadata } : {}),
         })
      );

      return {
         key,
         size: body.byteLength,
         contentType,
         checksumSha256: checksum,
         etag: stripQuotes(result.ETag ?? ''),
         metadata: options.metadata ?? {},
         updatedAt: new Date(),
      };
   }

   async open(key: string): Promise<Uint8Array> {
      validateKey(key);
      try {
         const result = await this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: key })
         );
         const bytes = await result.Body?.transformToByteArray();
         if (!bytes) throw new ObjectNotFound(key);
         return bytes;
      } catch (error) {
         if (isMissing(error)) throw new ObjectNotFound(key);
         throw error;
      }
   }

   /**
    * A URL the browser can fetch the bytes from directly.
    *
    * Without one every download streams through Berry, which turns a file
    * transfer into API time and memory. The disposition is signed into the
    * URL rather than sent as a header, because the browser follows the link
    * itself and there is nowhere to put a header.
    */
   async presignGet(
      key: string,
      options: { expiresSeconds?: number; contentDisposition?: string } = {}
   ): Promise<{ url: string; expiresAt: Date }> {
      validateKey(key);
      const expiresIn = options.expiresSeconds ?? 15 * 60;
      const url = await getSignedUrl(
         this.client,
         new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ...(options.contentDisposition
               ? { ResponseContentDisposition: options.contentDisposition }
               : {}),
         }),
         { expiresIn }
      );
      return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
   }

   async stat(key: string): Promise<StoredObject> {
      validateKey(key);
      try {
         const result = await this.client.send(
            // Without ChecksumMode the response carries no checksum at all,
            // and stat silently reports an empty one — which reads as "this
            // object has no checksum" rather than "you did not ask for it".
            new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' })
         );
         return {
            key,
            size: result.ContentLength ?? 0,
            contentType: result.ContentType ?? 'application/octet-stream',
            checksumSha256: result.ChecksumSHA256
               ? Buffer.from(result.ChecksumSHA256, 'base64').toString('hex')
               : '',
            etag: stripQuotes(result.ETag ?? ''),
            metadata: result.Metadata ?? {},
            updatedAt: result.LastModified ?? new Date(),
         };
      } catch (error) {
         if (isMissing(error)) throw new ObjectNotFound(key);
         throw error;
      }
   }

   /** Deleting something absent is a success: the caller wanted it gone. */
   async delete(key: string): Promise<void> {
      validateKey(key);
      try {
         await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      } catch (error) {
         if (!isMissing(error)) throw error;
      }
   }

   destroy(): void {
      this.client.destroy();
   }
}

function isMissing(error: unknown): boolean {
   const name = (error as { name?: string })?.name;
   const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
   return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

function stripQuotes(value: string): string {
   return value.replace(/^"|"$/g, '');
}

function equalsIgnoringCase(left: string, right: string): boolean {
   return left.toLowerCase() === right.toLowerCase();
}

/**
 * A content type from the bytes themselves, when the caller supplied none.
 *
 * Deliberately small: enough to recognise the handful of formats agents
 * actually produce, and `application/octet-stream` for everything else. A
 * confident wrong guess is worse than an honest unknown, because the browser
 * acts on it.
 */
export function sniffContentType(body: Uint8Array): string {
   if (body.byteLength === 0) return 'application/octet-stream';

   const head = body.subarray(0, 16);
   const startsWith = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);

   if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
   if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
   if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
   if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
   if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'application/zip';

   // Valid UTF-8 with no control characters other than whitespace reads as
   // text. Anything else could be binary, and calling binary text invites a
   // browser to render it.
   const sample = body.subarray(0, Math.min(body.byteLength, 1024));
   const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample);
   if (decoded.includes('�')) return 'application/octet-stream';
   for (const character of decoded) {
      const code = character.codePointAt(0)!;
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
         return 'application/octet-stream';
      }
   }
   return 'text/plain; charset=utf-8';
}
