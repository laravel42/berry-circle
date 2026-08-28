import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { Mount } from '../http/registry.ts';
import { ObjectNotFound, type Storage } from '../storage/storage.ts';
import type { Attachment, AttachmentRepository } from '../core/attachments.ts';

/**
 * `/api/v1/attachments`.
 *
 * The four routes that reach an attachment by its own id. The nested
 * `/issues/:ref/attachments` pair is not here: it carries the multipart
 * upload, which has not been ported — see server-ts/SCOPE.md.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AttachmentOptions {
   sessions: SessionService;
   attachments: AttachmentRepository;
   /** Null when this server has no object store; downloads then 503. */
   storage: Storage | null;
}

export function attachmentMounts(options: AttachmentOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const { attachments } = options;

   route.get('/:attachmentId', async (context) => {
      const id = pathId(context.req.param('attachmentId'));
      const attachment = await attachments
         .get(context.get('user').id, id, 'product.read')
         .catch(rethrow);
      return json(serialize(attachment));
   });

   /**
    * The bytes, streamed through Berry.
    *
    * `no-store` because the response is one workspace's file behind a session:
    * a shared cache holding it would serve it to the next person through the
    * same proxy.
    */
   route.get('/:attachmentId/download', async (context) => {
      const id = pathId(context.req.param('attachmentId'));
      const attachment = await attachments
         .get(context.get('user').id, id, 'product.read')
         .catch(rethrow);
      if (!options.storage) throw storageUnavailable();

      const bytes = await options.storage.open(attachment.storageKey).catch((error: unknown) => {
         // A ready row whose object is gone is a broken promise, not an empty
         // file; both read as the store being unavailable to this caller.
         if (error instanceof ObjectNotFound) throw storageUnavailable();
         throw error;
      });

      return new Response(bytes, {
         status: 200,
         headers: {
            'Content-Type': attachment.contentType,
            'Content-Length': String(attachment.sizeBytes),
            'Content-Disposition': contentDisposition(attachment.fileName),
            'Cache-Control': 'private, no-store',
         },
      });
   });

   /**
    * Where to fetch the bytes from.
    *
    * Berry's own path, always. Go returns a presigned URL when its storage can
    * mint one, and falls back to this; without a presigner configured here the
    * fallback *is* the answer, which is the same shape and one more hop.
    */
   route.get('/:attachmentId/download-url', async (context) => {
      const id = pathId(context.req.param('attachmentId'));
      noQuery(new URL(context.req.url));
      const attachment = await attachments
         .get(context.get('user').id, id, 'product.read')
         .catch(rethrow);

      // Berry's own path is the fallback, and it is the whole answer when
      // there is no object store to sign against: the same shape, one more
      // hop, and the caller does not have to know which it got.
      const fallback = {
         url: `/api/v1/attachments/${attachment.id}/download`,
         method: 'GET',
         headers: {},
         expiresAt: null,
         requiresAuthentication: true,
      };
      if (!options.storage) return json(fallback);

      const signed = await options.storage
         .presignGet(attachment.storageKey, {
            contentDisposition: contentDisposition(attachment.fileName),
         })
         .catch(() => null);
      if (!signed) return json(fallback);

      return json({
         url: signed.url,
         method: 'GET',
         headers: {},
         expiresAt: signed.expiresAt.toISOString(),
         requiresAuthentication: false,
      });
   });

   route.delete('/:attachmentId', async (context) => {
      const id = pathId(context.req.param('attachmentId'));
      noQuery(new URL(context.req.url));
      const attachment = await attachments.delete(context.get('user').id, id).catch(rethrow);
      // Best effort, and after the row: an object left behind is unreferenced
      // storage, while a row left behind points at nothing.
      if (options.storage) await options.storage.delete(attachment.storageKey).catch(() => undefined);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/attachments', handler: route }];
}

function serialize(attachment: Attachment): Record<string, unknown> {
   return {
      id: attachment.id,
      issueId: attachment.issueId,
      commentId: attachment.commentId,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      uploader: attachment.uploader,
      downloadUrl: `/api/v1/attachments/${attachment.id}/download`,
      createdAt: attachment.createdAt,
   };
}

/**
 * `attachment; filename="…"`, with anything unquotable encoded.
 *
 * A filename carrying a quote or a newline would otherwise end the header
 * early, and what follows it becomes a header the browser reads.
 */
export function contentDisposition(fileName: string): string {
   // eslint-disable-next-line no-control-regex
   const plain = /^[\x20-\x7e]*$/.test(fileName) && !/["\\]/.test(fileName);
   if (plain) return `attachment; filename="${fileName}"`;
   return `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
}

function pathId(raw: string | undefined): string {
   if (!raw || !UUID.test(raw)) throw ApiError.notFound('Attachment');
   return raw.toLowerCase();
}

/** These routes take no query, and one supplied is a caller expecting something. */
function noQuery(url: URL): void {
   if ([...url.searchParams.keys()].length > 0) {
      throw new ApiError(400, 'INVALID_REQUEST', 'The request query is invalid.');
   }
}

function storageUnavailable(): ApiError {
   return new ApiError(503, 'STORAGE_UNAVAILABLE', 'Attachment storage is unavailable.');
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Attachment');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}
