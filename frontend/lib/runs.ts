import { z } from 'zod';
import { BerryApiError, apiFetch, apiStream } from './api';
import { connectionSchema, newIdempotencyKey } from './api-schemas';
import type { ActivityItem } from '@/data/issue-details';
import type { User } from '@/data/users';

const runStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

const runSchema = z.object({
   id: z.string(),
   issueId: z.string(),
   agentId: z.string(),
   status: runStatusSchema,
   sequence: z.number(),
   summary: z.string().nullable(),
   usage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
      costMicros: z.number().nullable(),
      currency: z.string().nullable(),
   }),
   failure: z
      .object({
         code: z.string(),
         message: z.string(),
         retryable: z.boolean(),
      })
      .nullable(),
   createdAt: z.string(),
   startedAt: z.string().nullable(),
   completedAt: z.string().nullable(),
});

const runConnectionSchema = connectionSchema(runSchema);

/**
 * One frame from either event stream.
 *
 * The per-run stream always carries a run and a sequence. The board stream
 * also carries issue and comment mutations, which no run produced, so there
 * `runId` and `sequence` are null and `workspaceId` sits beside `boardId`.
 * Rejecting those frames would stall the board refresh on exactly the events
 * a person's own edit produces.
 */
const runEventSchema = z.object({
   id: z.string(),
   type: z.string(),
   occurredAt: z.string(),
   workspaceId: z.string().optional(),
   boardId: z.string().nullable().optional(),
   issueId: z.string().nullable().optional(),
   runId: z.string().nullable().optional(),
   sequence: z.number().nullable().optional(),
   payload: z.unknown(),
});

export type RunRecord = z.infer<typeof runSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;

export function isTerminalRunStatus(status: string): boolean {
   return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function isTerminalRunEvent(type: string): boolean {
   return type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled';
}

export function runDurationMs(run: RunRecord): number | null {
   if (!run.startedAt) return null;
   const end = run.completedAt ?? new Date().toISOString();
   return Math.max(0, new Date(end).getTime() - new Date(run.startedAt).getTime());
}

export function formatRunDuration(ms: number): string {
   const totalSeconds = Math.floor(ms / 1000);
   const minutes = Math.floor(totalSeconds / 60);
   const seconds = totalSeconds % 60;
   if (minutes === 0) return `${seconds}s`;
   return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export async function listIssueRuns(issueId: string): Promise<RunRecord[]> {
   const json: unknown = await apiFetch(`/api/v1/issues/${issueId}/runs?first=100`);
   const parsed = runConnectionSchema.safeParse(json);
   if (!parsed.success) return [];
   return parsed.data.nodes;
}

export interface BoardRunsQuery {
   agentId?: string;
   status?: RunStatus;
   first?: number;
}

export async function listBoardRuns(
   boardId: string,
   query: BoardRunsQuery = {}
): Promise<RunRecord[]> {
   const collected: RunRecord[] = [];
   let after: string | undefined;
   const pageSize = query.first ?? 100;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ first: String(Math.min(pageSize, 100)) });
      if (query.agentId) params.set('agentId', query.agentId);
      if (query.status) params.set('status', query.status);
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(`/api/v1/boards/${boardId}/runs?${params.toString()}`);
      const parsed = runConnectionSchema.safeParse(json);
      if (!parsed.success) {
         throw new Error('Run list was not recognized');
      }
      collected.push(...parsed.data.nodes);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) {
         break;
      }
      after = endCursor;
      if (collected.length >= pageSize) {
         break;
      }
   }
   return collected.slice(0, pageSize);
}

export async function cancelRun(runId: string): Promise<RunRecord> {
   const json: unknown = await apiFetch(`/api/v1/runs/${runId}/cancel`, {
      method: 'POST',
   });
   const parsed = runSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Run response was not recognized');
   }
   return parsed.data;
}

export async function loadBoardRuns(
   boardId: string,
   query: BoardRunsQuery = {}
): Promise<RunRecord[]> {
   try {
      return await listBoardRuns(boardId, query);
   } catch {
      return [];
   }
}

export async function getRun(runId: string): Promise<RunRecord> {
   const json: unknown = await apiFetch(`/api/v1/runs/${runId}`);
   const parsed = runSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Run response was not recognized');
   }
   return parsed.data;
}

export async function createIssueRun(
   issueId: string,
   input: { agentId?: string; instructions?: string } = {}
): Promise<RunRecord> {
   const body: Record<string, string | null> = {};
   if (input.agentId) body.agentId = input.agentId;
   if (input.instructions) body.instructions = input.instructions;

   try {
      const json: unknown = await apiFetch(`/api/v1/issues/${issueId}/runs`, {
         method: 'POST',
         headers: { 'Idempotency-Key': newIdempotencyKey() },
         body: JSON.stringify(body),
      });
      const parsed = runSchema.safeParse(json);
      if (!parsed.success) {
         throw new Error('Run response was not recognized');
      }
      return parsed.data;
   } catch (error) {
      if (error instanceof BerryApiError && error.code === 'ACTIVE_RUN_EXISTS') {
         const runId = activeRunIdFromDetails(error.details);
         if (runId) return getRun(runId);
      }
      throw error;
   }
}

export async function loadRunsForIssues(issueIds: string[]): Promise<RunRecord[]> {
   const pages = await Promise.all(
      issueIds.map(async (issueId) => {
         try {
            return await listIssueRuns(issueId);
         } catch {
            return [] as RunRecord[];
         }
      })
   );
   return pages.flat().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function* streamRunEvents(
   runId: string,
   signal?: AbortSignal
): AsyncGenerator<RunEvent> {
   const response = await apiStream(`/api/v1/runs/${runId}/events`, undefined, { signal });
   if (!response.body) {
      throw new Error('Run event stream had no body');
   }
   const reader = response.body.getReader();
   const decoder = new TextDecoder();
   let buffer = '';
   try {
      while (true) {
         const { done, value } = await reader.read();
         if (done) break;
         buffer += decoder.decode(value, { stream: true });
         const blocks = buffer.split('\n\n');
         buffer = blocks.pop() ?? '';
         for (const block of blocks) {
            const event = parseSseBlock(block);
            if (event) yield event;
         }
      }
      const tail = parseSseBlock(buffer);
      if (tail) yield tail;
   } finally {
      reader.releaseLock();
   }
}

/**
 * Every run event on a board, as it happens.
 *
 * The board stream carries the same envelope as the per-run one, so it reuses
 * the same parser. Agents change issues without anyone clicking anything, and
 * until something consumed this the only way to see their work was to reload
 * the page.
 */
export async function* streamBoardEvents(
   boardId: string,
   signal?: AbortSignal
): AsyncGenerator<RunEvent> {
   const response = await apiStream(
      `/api/v1/events?boardId=${encodeURIComponent(boardId)}`,
      undefined,
      { signal }
   );
   if (!response.body) {
      throw new Error('Board event stream had no body');
   }
   const reader = response.body.getReader();
   const decoder = new TextDecoder();
   let buffer = '';
   try {
      while (true) {
         const { done, value } = await reader.read();
         if (done) break;
         buffer += decoder.decode(value, { stream: true });
         const blocks = buffer.split('\n\n');
         buffer = blocks.pop() ?? '';
         for (const block of blocks) {
            const event = parseSseBlock(block);
            if (event) yield event;
         }
      }
   } finally {
      reader.releaseLock();
   }
}

function parseSseBlock(block: string): RunEvent | undefined {
   let eventName = '';
   const dataLines: string[] = [];
   for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
         eventName = line.slice(6).trim();
         continue;
      }
      if (line.startsWith('data:')) {
         dataLines.push(line.slice(5).trimStart());
      }
   }
   if (!eventName || dataLines.length === 0) return undefined;
   try {
      const parsed = runEventSchema.safeParse(JSON.parse(dataLines.join('\n')));
      return parsed.success ? parsed.data : undefined;
   } catch {
      return undefined;
   }
}

function activeRunIdFromDetails(details: unknown): string | undefined {
   if (typeof details !== 'object' || details === null || Array.isArray(details)) {
      return undefined;
   }
   const runId = (details as { runId?: unknown }).runId;
   return typeof runId === 'string' && runId ? runId : undefined;
}

export function textFromRunEvent(event: RunEvent): string {
   const payload = payloadOf(event);
   if (!payload) return '';
   if (event.type === 'run.output.delta' && typeof payload.text === 'string') {
      return payload.text;
   }
   if (event.type === 'run.tool.started' && typeof payload.name === 'string') {
      return `\n[${payload.name}]\n`;
   }
   // The command log. The server records what an agent ran verbatim, its
   // output as it happened, and how it ended — the evidence a person reads to
   // decide whether the work is right. Dropping it here would leave a run
   // showing "the agent used a tool" and nothing about what the tool did.
   if (event.type === 'run.command.started' && typeof payload.command === 'string') {
      const cwd = typeof payload.cwd === 'string' && payload.cwd ? ` (in ${payload.cwd})` : '';
      return `\n$ ${payload.command}${cwd}\n`;
   }
   if (event.type === 'run.command.output' && typeof payload.text === 'string') {
      return payload.text;
   }
   if (event.type === 'run.command.completed') {
      const code = typeof payload.exitCode === 'number' ? payload.exitCode : null;
      const truncated = payload.truncated === true ? ' · output truncated' : '';
      // A command that never reported an exit is not a command that
      // succeeded, and the log says which happened.
      return code === null
         ? `\n[the command did not finish${truncated}]\n`
         : `\n[exit ${code}${truncated}]\n`;
   }
   if (event.type === 'run.failed' && typeof payload.message === 'string') {
      return payload.message;
   }
   return '';
}

/** What a run left behind: a branch, and the pull request on it. */
export interface RunDelivery {
   committed: boolean;
   commit: string | null;
   branch: string;
   filesChanged: number;
   insertions: number;
   deletions: number;
   files: string[];
   pullRequest: { number: number; url: string; created: boolean } | null;
   mergeRequiresApproval: boolean;
}

/**
 * The delivery a `run.delivered` frame carries, or null.
 *
 * `committed: false` is a real outcome, not a missing one — an agent that
 * answered a question changed no files — so it is returned rather than
 * treated as nothing to show.
 */
export function deliveryFromRunEvent(event: RunEvent): RunDelivery | null {
   if (event.type !== 'run.delivered') return null;
   const payload = payloadOf(event);
   if (!payload || typeof payload.branch !== 'string') return null;
   const pull = payload.pullRequest;
   return {
      committed: payload.committed === true,
      commit: typeof payload.commit === 'string' ? payload.commit : null,
      branch: payload.branch,
      filesChanged: numberOr(payload.filesChanged, 0),
      insertions: numberOr(payload.insertions, 0),
      deletions: numberOr(payload.deletions, 0),
      files: Array.isArray(payload.files)
         ? payload.files.filter((file): file is string => typeof file === 'string')
         : [],
      pullRequest:
         typeof pull === 'object' && pull !== null && typeof (pull as Record<string, unknown>).url === 'string'
            ? {
                 number: numberOr((pull as Record<string, unknown>).number, 0),
                 url: (pull as Record<string, unknown>).url as string,
                 created: (pull as Record<string, unknown>).created === true,
              }
            : null,
      mergeRequiresApproval: payload.mergeRequiresApproval === true,
   };
}

function payloadOf(event: RunEvent): Record<string, unknown> | null {
   return typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
}

function numberOr(value: unknown, fallback: number): number {
   return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Turn a run into feed entries.
 *
 * A run produces at most two: one line recording that it happened and how it
 * ended, and — when the agent actually said something — a card carrying the
 * result. The result is a card rather than another grey line because it is the
 * work itself, and burying an agent's output in a lifecycle log is how it ends
 * up looking like nothing was produced.
 */
export function runToActivityItems(run: RunRecord, actor: User): ActivityItem[] {
   const at = run.completedAt ?? run.startedAt ?? run.createdAt;
   const items: ActivityItem[] = [
      {
         kind: 'event',
         id: `run:${run.id}:status`,
         actor,
         event: 'run',
         text: runOutcomeText(run),
         timeAgo: relativeTime(at),
      },
   ];

   // The summary is deliberately not a second card. The server already posts
   // the agent's final message to the issue as the agent's own comment, which
   // is the record a person replies to; rendering run.summary beside it showed
   // every finished task's result twice, from two sources holding the same
   // text. What the run contributes to the thread is that it happened and what
   // it cost — the event above.
   return items;
}

function runOutcomeText(run: RunRecord): string {
   const duration = runDurationMs(run);
   const parts: string[] = [];
   if (duration !== null) parts.push(formatRunDuration(duration));
   if (run.usage.totalTokens > 0) {
      parts.push(`${run.usage.totalTokens.toLocaleString()} tokens`);
   }
   const detail = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';

   switch (run.status) {
      case 'succeeded':
         return `finished a run${detail}`;
      case 'failed':
         // The failure code is the part an operator can act on, so it is shown
         // rather than a generic "run failed".
         return `run failed${run.failure ? `: ${run.failure.message}` : ''}${detail}`;
      case 'cancelled':
         return `run cancelled${detail}`;
      case 'running':
         return 'is working on this';
      default:
         return 'queued a run';
   }
}

/** Sort key for merging runs and comments into one chronological feed. */
export function runTimestamp(run: RunRecord): string {
   return run.completedAt ?? run.startedAt ?? run.createdAt;
}

function relativeTime(iso: string): string {
   const then = new Date(iso).getTime();
   if (Number.isNaN(then)) return 'recently';
   const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
   if (seconds < 60) return 'just now';
   const minutes = Math.round(seconds / 60);
   if (minutes < 60) return `${minutes}m ago`;
   const hours = Math.round(minutes / 60);
   if (hours < 24) return `${hours}h ago`;
   return `${Math.round(hours / 24)}d ago`;
}

const autoReviewSchema = z.object({
   id: z.string(),
   runId: z.string(),
   reviewer: z.string(),
   author: z.string(),
   /** Null while the reviewer is still reading. */
   approved: z.boolean().nullable(),
   inProgress: z.boolean(),
   reason: z.string(),
   attempt: z.number(),
   startedAt: z.string(),
   decidedAt: z.string().nullish(),
});

export type AutoReview = z.infer<typeof autoReviewSchema>;

/**
 * Peer verdicts on a task, newest first.
 *
 * Only AutoGate plans have these. A rejection is the case that matters: the
 * task stays in review and, without this, nothing on the page says why.
 */
export async function loadAutoReviews(issueRef: string): Promise<AutoReview[]> {
   if (!issueRef) return [];
   const json: unknown = await apiFetch(
      `/api/v1/issues/${encodeURIComponent(issueRef)}/reviews`
   );
   const parsed = z.object({ reviews: z.array(autoReviewSchema) }).safeParse(json);
   return parsed.success ? parsed.data.reviews : [];
}
