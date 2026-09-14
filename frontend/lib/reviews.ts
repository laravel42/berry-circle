import { z } from 'zod';
import { apiFetch, apiText } from './api';
import { createIssueComment } from './comments';
import { patchBoardIssue } from './issues';
import type { FileDiff } from '@/data/reviews';

/**
 * The human review gate, as the API serves it.
 *
 * A review is a task in review together with the run that delivered it: the
 * pull request, the author's account, the checks, and any peer verdict. A
 * decision is the task changing status — approve is done, send back is todo —
 * through the same route the board uses, plus a comment when there is a note.
 */

export const reviewVerdictSchema = z.object({
   id: z.string(),
   reviewer: z.string(),
   approved: z.boolean().nullable(),
   reason: z.string(),
   attempt: z.number(),
   decidedAt: z.string().nullable(),
});

export const reviewItemSchema = z.object({
   id: z.string(),
   issue: z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      status: z.string(),
      autoGate: z.boolean(),
   }),
   author: z.object({ id: z.string(), name: z.string() }).nullable(),
   run: z.object({
      id: z.string(),
      summary: z.string().nullable(),
      completedAt: z.string().nullable(),
   }),
   repository: z.string().nullable(),
   pullRequest: z
      .object({
         number: z.number(),
         url: z.string().nullable(),
         branch: z.string().nullable(),
         headCommit: z.string().nullable(),
      })
      .nullable(),
   delivery: z.object({
      committed: z.boolean(),
      filesChanged: z.number(),
      insertions: z.number(),
      deletions: z.number(),
      files: z.array(z.string()).default([]),
   }),
   checks: z
      .object({
         passed: z.boolean(),
         complete: z.boolean(),
         results: z
            .array(
               z.object({
                  command: z.string(),
                  exitCode: z.number().nullable(),
                  passed: z.boolean(),
               })
            )
            .default([]),
      })
      .nullable(),
   verdicts: z.array(reviewVerdictSchema).default([]),
   updatedAt: z.string(),
});

export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ReviewQueueState = 'open' | 'completed';

export async function loadReviews(workspaceId: string, state: ReviewQueueState): Promise<ReviewItem[]> {
   const params = new URLSearchParams({ workspaceId, state });
   const json: unknown = await apiFetch(`/api/v1/reviews?${params.toString()}`);
   const parsed = z.object({ nodes: z.array(reviewItemSchema) }).safeParse(json);
   return parsed.success ? parsed.data.nodes : [];
}

/** The pull request's unified diff, as text. */
export async function loadReviewDiff(runId: string): Promise<string> {
   return apiText(`/api/v1/reviews/${encodeURIComponent(runId)}/diff`);
}

export type ReviewDecision = 'approve' | 'send-back';

/**
 * Approve moves the task to done; send back moves it to todo. A note becomes
 * a comment first, so the reason is on the task before its status changes —
 * the order a person reading the timeline expects.
 */
export async function decideReview(item: ReviewItem, decision: ReviewDecision, note: string): Promise<void> {
   const trimmed = note.trim();
   if (trimmed !== '') {
      await createIssueComment(
         item.issue.identifier,
         `${decision === 'approve' ? '**Review: approved.**' : '**Review: sent back.**'}\n\n${trimmed}`
      );
   }
   await patchBoardIssue(item.issue.identifier, { status: decision === 'approve' ? 'done' : 'todo' });
}

/** A relative time short enough for a list row. */
export function reviewTimeAgo(iso: string | null): string {
   if (!iso) return '';
   const ms = Date.now() - new Date(iso).getTime();
   const minutes = Math.round(ms / 60_000);
   if (minutes < 1) return 'now';
   if (minutes < 60) return `${minutes}m`;
   const hours = Math.round(minutes / 60);
   if (hours < 24) return `${hours}h`;
   return `${Math.round(hours / 24)}d`;
}

/**
 * A unified diff, split per file for the renderer.
 *
 * Only what the view needs: added and removed lines, context with new-file
 * numbers, and hunk boundaries collapsed into a "skipped" row. Binary files
 * and renames without content appear as an empty file entry.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
   const files: FileDiff[] = [];
   let current: FileDiff | null = null;
   let newLine = 0;
   let lastNewLine = 0;

   for (const raw of text.split('\n')) {
      if (raw.startsWith('diff --git ')) {
         const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
         const path = match?.[2] ?? raw.slice('diff --git '.length);
         const slash = path.lastIndexOf('/');
         current = {
            name: slash === -1 ? path : path.slice(slash + 1),
            path: slash === -1 ? '' : path.slice(0, slash),
            additions: 0,
            deletions: 0,
            lines: [],
         };
         files.push(current);
         newLine = 0;
         lastNewLine = 0;
         continue;
      }
      if (!current) continue;
      if (raw.startsWith('@@')) {
         const match = /\+(\d+)(?:,(\d+))?/.exec(raw);
         newLine = match ? Number(match[1]) : newLine;
         if (lastNewLine > 0 && newLine > lastNewLine + 1) {
            current.lines.push({ type: 'skip', count: newLine - lastNewLine - 1 });
         }
         continue;
      }
      if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ') || raw.startsWith('Binary files') || raw.startsWith('\\ No newline')) {
         continue;
      }
      if (raw.startsWith('+')) {
         current.additions += 1;
         current.lines.push({ type: 'add', number: newLine, text: raw.slice(1) });
         lastNewLine = newLine;
         newLine += 1;
      } else if (raw.startsWith('-')) {
         current.deletions += 1;
         current.lines.push({ type: 'del', text: raw.slice(1) });
      } else if (raw.startsWith(' ') || raw === '') {
         if (raw === '' && current.lines.length === 0) continue;
         current.lines.push({ type: 'context', number: newLine, text: raw.slice(1) });
         lastNewLine = newLine;
         newLine += 1;
      }
   }
   return files;
}
