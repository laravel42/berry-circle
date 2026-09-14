import type { LabelInterface } from '@/data/labels';
import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

/**
 * The labels on one task.
 *
 * The workspace catalogue lives in `lib/labels.ts`; this is the membership —
 * which of those labels are on this task. The write sends the whole set, which
 * is what the sidebar edits, so a stale client cannot half-apply a change.
 */

const labelSchema = z.object({
   id: z.string(),
   name: z.string(),
   color: z.string(),
   description: z.string().nullable(),
   archivedAt: z.string().nullable(),
});

export type IssueLabel = z.infer<typeof labelSchema>;

const listSchema = z.object({ nodes: z.array(labelSchema) });

const path = (issueRef: string) => `/api/v1/issues/${encodeURIComponent(issueRef)}/labels`;

export function toUiIssueLabel(label: IssueLabel): LabelInterface {
   return { id: label.id, name: label.name, color: label.color };
}

export async function loadIssueLabels(issueRef: string): Promise<IssueLabel[]> {
   if (!issueRef) return [];
   return parseResponse(listSchema, await apiFetch(path(issueRef)), 'Labels').nodes;
}

/** Replaces the task's labels with exactly these. */
export async function setIssueLabels(issueRef: string, labelIds: string[]): Promise<IssueLabel[]> {
   return parseResponse(
      listSchema,
      await apiFetch(path(issueRef), { method: 'PUT', body: JSON.stringify({ labelIds }) }),
      'Labels'
   ).nodes;
}
