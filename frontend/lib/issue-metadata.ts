import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

/**
 * The free key/value pairs an integration or an agent leaves on a task.
 *
 * Values are scalars by the server's own rule, so anything here can be shown
 * without knowing what wrote it.
 */

const metadataSchema = z.object({ metadata: z.record(z.string(), z.unknown()) });

const path = (issueRef: string) => `/api/v1/issues/${encodeURIComponent(issueRef)}/metadata`;

export async function loadIssueMetadata(issueRef: string): Promise<Record<string, unknown>> {
   if (!issueRef) return {};
   return parseResponse(metadataSchema, await apiFetch(path(issueRef)), 'Metadata').metadata;
}

export async function patchIssueMetadata(
   issueRef: string,
   patch: { set?: Record<string, string | number | boolean | null>; remove?: string[] }
): Promise<Record<string, unknown>> {
   return parseResponse(
      metadataSchema,
      await apiFetch(path(issueRef), { method: 'PATCH', body: JSON.stringify(patch) }),
      'Metadata'
   ).metadata;
}
