import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { RunArtifact, RunArtifactRepository } from '../core/run-artifacts.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { ObjectNotFound, type Storage } from '../storage/storage.ts';

/**
 * What an agent produced on a task, for the people looking at it.
 *
 * Two surfaces, the same split as attachments: the list lives under the
 * issue (`/issues/:ref/artifacts`), and the bytes are fetched by id
 * (`/artifacts/:id/download`) so a link survives the issue being renamed or
 * moved. Both authorise through the issue, because an artifact is scoped to
 * the task it was produced on and nothing else.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArtifactMountOptions {
   sessions: SessionService;
   artifacts: RunArtifactRepository;
   issues: IssueRepository;
   storage: Storage | null;
}

export function artifactMounts(options: ArtifactMountOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   route.get('/:artifactId/download', async (context) => {
      const id = context.req.param('artifactId');
      if (!UUID.test(id)) throw ApiError.notFound('Artifact');
      const artifact = await options.artifacts.get(id.toLowerCase());
      if (!artifact) throw ApiError.notFound('Artifact');
      await options.issues.authorize(context.get('user').id, artifact.issueId, 'product.read').catch(rethrow);
      if (!options.storage) throw storageUnavailable();

      const bytes = await options.storage.open(artifact.storageKey).catch((error: unknown) => {
         // A ready row whose object is gone is a broken promise, not an empty
         // file; both read as the store being unavailable to this caller.
         if (error instanceof ObjectNotFound) throw storageUnavailable();
         throw error;
      });
      return new Response(bytes, {
         status: 200,
         headers: {
            'Content-Type': artifact.contentType,
            'Content-Length': String(bytes.byteLength),
            'Content-Disposition': contentDisposition(artifact.name),
            'Cache-Control': 'private, no-store',
         },
      });
   });

   return [{ prefix: '/api/v1/artifacts', handler: route }];
}

/** `GET /issues/:issueRef/artifacts`, nested under the issues mount. */
export function issueArtifactRoutes(options: { artifacts: RunArtifactRepository; issues: IssueRepository }) {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.get('/:issueRef/artifacts', async (context) => {
      const issue = await options.issues.get(context.req.param('issueRef') ?? '').catch(() => {
         throw ApiError.notFound('Issue');
      });
      await options.issues.authorize(context.get('user').id, issue.id, 'product.read').catch(rethrow);
      const artifacts = await options.artifacts.listForIssue(issue.id);
      return json({ artifacts: artifacts.map(serializeArtifact) });
   });
   return route;
}

export function serializeArtifact(artifact: RunArtifact): Record<string, unknown> {
   return {
      id: artifact.id,
      path: artifact.path,
      name: artifact.name,
      directory: artifact.directory,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      runId: artifact.runId,
      agentName: artifact.agentName,
      downloadUrl: `/api/v1/artifacts/${artifact.id}/download`,
      createdAt: artifact.createdAt,
   };
}

function contentDisposition(fileName: string): string {
   // eslint-disable-next-line no-control-regex
   const plain = /^[\x20-\x7e]*$/.test(fileName) && !/["\\]/.test(fileName);
   if (plain) return `attachment; filename="${fileName}"`;
   return `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
}

function storageUnavailable(): ApiError {
   return new ApiError(503, 'STORAGE_UNAVAILABLE', 'Artifact storage is unavailable.');
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Issue');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}
