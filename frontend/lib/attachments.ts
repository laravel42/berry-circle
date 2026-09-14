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

/**
 * One attachment by its own id, for the preview page, which is reached by
 * link and so knows nothing but the id. Null when it is not there or not
 * this person's to see — the server answers 404 to both, deliberately.
 */
export async function getAttachment(attachmentId: string): Promise<ApiAttachment | null> {
   if (!attachmentId) return null;
   try {
      const json: unknown = await apiFetch(
         `/api/v1/attachments/${encodeURIComponent(attachmentId)}`
      );
      const parsed = attachmentSchema.safeParse(json);
      return parsed.success ? parsed.data : null;
   } catch {
      return null;
   }
}

/**
 * Past this, a preview is worse than a download: the bytes travel through the
 * page, the browser decodes them into memory, and the person waits for a
 * picture they asked to see, not to load.
 */
export const PREVIEW_SIZE_LIMIT = 25 * 1024 * 1024;

export type PreviewKind = 'image' | 'pdf' | 'text' | 'html' | 'unsupported';

/** What kind of preview, if any, this file can have. */
export function previewKind(attachment: ApiAttachment): PreviewKind {
   const type = attachment.contentType.toLowerCase();
   if (type.startsWith('image/')) return type.includes('svg') ? 'unsupported' : 'image';
   if (type === 'application/pdf') return 'pdf';
   if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
   if (type.startsWith('text/') || type === 'application/json') return 'text';
   return 'unsupported';
}

/**
 * The bytes, as an object URL.
 *
 * Fetched rather than linked for the same reason a download is: the route
 * needs the session header, and an `<img src>` pointed at it would render a
 * broken image with an authentication error behind it. The caller revokes the
 * URL when it is done.
 */
export async function attachmentObjectUrl(attachment: ApiAttachment): Promise<string> {
   const response = await apiStream(attachment.downloadUrl, undefined, {});
   if (!response.ok) throw new Error(`Preview failed with status ${response.status}`);
   return URL.createObjectURL(await response.blob());
}

/** The bytes as text, for the kinds of file that are text. */
export async function attachmentText(attachment: ApiAttachment): Promise<string> {
   const response = await apiStream(attachment.downloadUrl, undefined, {});
   if (!response.ok) throw new Error(`Preview failed with status ${response.status}`);
   return response.text();
}

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
 * Put a file on an issue.
 *
 * `FormData` without a content-type header: the browser sets it, including the
 * multipart boundary, and a header set by hand would be missing that boundary
 * and unparseable on the other end.
 *
 * The server deduplicates by the file's own bytes, so dropping the same
 * screenshot twice answers 200 with the attachment that already exists rather
 * than making a second one. Both are the file being there, which is what the
 * caller wanted.
 */
export async function uploadIssueAttachment(
   issueRef: string,
   file: File,
   commentId?: string
): Promise<ApiAttachment> {
   const form = new FormData();
   form.append('file', file);
   if (commentId) form.append('commentId', commentId);

   const json: unknown = await apiFetch(
      `/api/v1/issues/${encodeURIComponent(issueRef)}/attachments`,
      { method: 'POST', body: form }
   );
   const parsed = attachmentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Upload response was not recognized');
   return parsed.data;
}

/** Is this something the image viewer can show? */
export function isImageAttachment(attachment: ApiAttachment): boolean {
   return attachment.contentType.startsWith('image/');
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

const artifactSchema = z.object({
   id: z.string(),
   path: z.string(),
   name: z.string(),
   directory: z.string(),
   contentType: z.string(),
   sizeBytes: z.number(),
   runId: z.string(),
   agentName: z.string(),
   downloadUrl: z.string(),
   createdAt: z.string(),
});

export type RunArtifact = z.infer<typeof artifactSchema>;

/**
 * What the agents on an issue produced.
 *
 * A separate call from the attachments because they are separate things: a
 * person's upload has a name, an agent's output has a path, and the shape of
 * that tree is part of the work (migration 027).
 */
export async function loadIssueArtifacts(issueRef: string): Promise<RunArtifact[]> {
   if (!issueRef) return [];
   const json: unknown = await apiFetch(`/api/v1/issues/${encodeURIComponent(issueRef)}/artifacts`);
   const parsed = z.object({ artifacts: z.array(artifactSchema) }).safeParse(json);
   return parsed.success ? parsed.data.artifacts : [];
}

/** Download one artifact, the same way an attachment is fetched. */
export async function downloadArtifact(artifact: RunArtifact): Promise<void> {
   const response = await apiStream(artifact.downloadUrl, undefined, {});
   if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
   }
   const blob = await response.blob();
   const url = URL.createObjectURL(blob);
   try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifact.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
   } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
   }
}

/**
 * A directory tree built from flat paths.
 *
 * The server sends paths, not a tree, because a path is the fact and a tree is
 * a rendering of it. Two agents may both write src/, so the merge happens here
 * where the whole issue's files are in hand.
 */
export interface ArtifactTreeNode {
   name: string;
   path: string;
   children: ArtifactTreeNode[];
   /** Set on a leaf; absent on a directory. */
   file?: RunArtifact;
}

export function buildArtifactTree(artifacts: RunArtifact[]): ArtifactTreeNode[] {
   const root: ArtifactTreeNode = { name: '', path: '', children: [] };

   for (const artifact of artifacts) {
      const segments = artifact.path.split('/').filter(Boolean);
      let cursor = root;
      segments.forEach((segment, index) => {
         const isLeaf = index === segments.length - 1;
         const path = segments.slice(0, index + 1).join('/');
         let next = cursor.children.find(
            (child) => child.name === segment && !child.file === !isLeaf
         );
         if (!next) {
            next = { name: segment, path, children: [] };
            cursor.children.push(next);
         }
         if (isLeaf) next.file = artifact;
         cursor = next;
      });
   }

   // Directories first, then alphabetical — how a file tree is read.
   const sort = (nodes: ArtifactTreeNode[]): ArtifactTreeNode[] => {
      nodes.sort((left, right) => {
         const leftIsDir = left.file === undefined;
         const rightIsDir = right.file === undefined;
         if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
         return left.name.localeCompare(right.name);
      });
      for (const node of nodes) sort(node.children);
      return nodes;
   };
   return sort(root.children);
}

/** Human-readable size for a file listing. */
export function formatFileSize(bytes: number): string {
   if (bytes < 1024) return `${bytes} B`;
   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
