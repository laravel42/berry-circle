import { z } from 'zod';
import { apiFetch, apiStream } from './api';
import { actorRefSchema, connectionSchema } from './api-schemas';

const attachmentSchema = z.object({
   id: z.string(),
   issueId: z.string(),
   commentId: z.string().nullish(),
   fileName: z.string(),
   contentType: z.string(),
   sizeBytes: z.number(),
   uploader: actorRefSchema.nullable(),
   downloadUrl: z.string(),
   createdAt: z.string(),
});

const attachmentConnectionSchema = connectionSchema(attachmentSchema);

export type ApiAttachment = z.infer<typeof attachmentSchema>;

/** Files on an issue: human uploads and agent-produced artifacts alike. */
export async function loadIssueAttachments(issueRef: string): Promise<ApiAttachment[]> {
   if (!issueRef) return [];
   const json: unknown = await apiFetch(
      `/api/v1/issues/${encodeURIComponent(issueRef)}/attachments?first=100`
   );
   const parsed = attachmentConnectionSchema.safeParse(json);
   return parsed.success ? parsed.data.nodes : [];
}

/**
 * Download an attachment to the viewer's machine.
 *
 * Fetched rather than linked because the download route needs the session
 * header, which a plain anchor cannot carry — an <a href> to it would render
 * an authentication error instead of the file. The response is turned into a
 * blob so the browser saves it under its real name.
 */
export async function downloadAttachment(attachment: ApiAttachment): Promise<void> {
   const response = await apiStream(attachment.downloadUrl, undefined, {});
   if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
   }
   const blob = await response.blob();
   const url = URL.createObjectURL(blob);
   try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
   } finally {
      // Revoked on the next tick: revoking synchronously can cancel the
      // download the click just started.
      setTimeout(() => URL.revokeObjectURL(url), 0);
   }
}

/** Human-readable size for a file listing. */
export function formatFileSize(bytes: number): string {
   if (bytes < 1024) return `${bytes} B`;
   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
