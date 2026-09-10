import type { Issue } from '@/data/issues';
import { z } from 'zod';
import { apiFetch } from './api';
import { parseApiIssue } from './issues';
import { parseResponse } from './parse-response';

const path = (issueRef: string, suffix = '') => `/api/v1/issues/${encodeURIComponent(issueRef)}${suffix}`;

function issueOrThrow(json: unknown, what: string): Issue {
   const issue = parseApiIssue(json);
   if (!issue) throw new Error(`${what} response was not recognized`);
   return issue;
}

export async function loadChildren(issueRef: string): Promise<{ nodes: Issue[]; progress: { total: number; done: number } }> {
   const parsed = parseResponse(
      z.object({ nodes: z.array(z.unknown()), progress: z.object({ total: z.number(), done: z.number() }) }),
      await apiFetch(path(issueRef, '/children')),
      'Sub-tasks'
   );
   return {
      nodes: parsed.nodes.map(parseApiIssue).filter((issue): issue is Issue => issue !== undefined),
      progress: parsed.progress,
   };
}

export async function createChild(
   issueRef: string,
   input: { title?: string; fromCommentId?: string; stage?: number | null }
): Promise<Issue> {
   return issueOrThrow(await apiFetch(path(issueRef, '/children'), { method: 'POST', body: JSON.stringify(input) }), 'Sub-task');
}

export async function setParent(issueRef: string, parentId: string | null, stage: number | null): Promise<Issue> {
   return issueOrThrow(await apiFetch(path(issueRef, '/parent'), { method: 'PUT', body: JSON.stringify({ parentId, stage }) }), 'Task');
}

export async function setCustomStatus(issueRef: string, statusId: string): Promise<Issue> {
   return issueOrThrow(await apiFetch(path(issueRef, '/status'), { method: 'PUT', body: JSON.stringify({ statusId }) }), 'Task');
}

export async function moveIssue(issueRef: string, beforeId: string | null, afterId: string | null): Promise<Issue> {
   return issueOrThrow(await apiFetch(path(issueRef, '/move'), { method: 'POST', body: JSON.stringify({ beforeId, afterId }) }), 'Task');
}

export async function quickCreateIssue(input: { workspaceId: string; title: string; parentId?: string }): Promise<Issue> {
   return issueOrThrow(await apiFetch('/api/v1/issues/quick', { method: 'POST', body: JSON.stringify(input) }), 'Task');
}

const failedSchema = z.array(z.object({ id: z.string(), code: z.string() }));

export async function batchUpdateIssues(
   issueIds: string[],
   patch: { status?: string; statusId?: string; priority?: string; assignee?: { type: 'user' | 'agent'; id: string } | null }
): Promise<{ updated: string[]; failed: Array<{ id: string; code: string }> }> {
   return parseResponse(
      z.object({ updated: z.array(z.string()), failed: failedSchema }),
      await apiFetch('/api/v1/issues/batch', { method: 'POST', body: JSON.stringify({ issueIds, patch }) }),
      'Batch update'
   );
}

export async function batchDeleteIssues(
   issueIds: string[]
): Promise<{ deleted: string[]; failed: Array<{ id: string; code: string }> }> {
   return parseResponse(
      z.object({ deleted: z.array(z.string()), failed: failedSchema }),
      await apiFetch('/api/v1/issues/batch-delete', { method: 'POST', body: JSON.stringify({ issueIds }) }),
      'Batch delete'
   );
}

export async function loadAssigneeFrequency(
   workspaceId: string
): Promise<Array<{ type: string; id: string; count: number }>> {
   return parseResponse(
      z.object({ nodes: z.array(z.object({ type: z.string(), id: z.string(), count: z.number() })) }),
      await apiFetch(`/api/v1/issues/assignee-frequency?workspaceId=${encodeURIComponent(workspaceId)}`),
      'Assignee frequency'
   ).nodes;
}

export async function runQuickAction(issueRef: string, actionId: string): Promise<string> {
   return parseResponse(
      z.object({ runId: z.string() }),
      await apiFetch(path(issueRef, `/quick-actions/${encodeURIComponent(actionId)}/run`), { method: 'POST' }),
      'Quick action'
   ).runId;
}
