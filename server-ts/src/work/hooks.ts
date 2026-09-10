import type { Comment } from '../core/comments.ts';
import type { Issue, IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { autoDispatch } from '../runs/auto-dispatch.ts';
import type { RunRepository } from '../runs/repository.ts';
import { nextStageReady, stageGate } from './hierarchy.ts';
import { parseMentions } from './mentions.ts';
import { notifySubscribers, subscribe, type InboxCategory } from './subscribers.ts';

/**
 * What follows a committed issue or comment write: automatic subscriptions
 * (creator, assignee, commenter, mentioned), inbox rows for subscribers, and
 * releasing the next stage of sub-issues. Called after commit, best effort,
 * like the realtime publish: the write already happened.
 */
export interface IssueWrite {
   kind: 'created' | 'updated';
   issue: Issue;
   previousStatus: string | null;
   previousAssigneeId: string | null;
   actorId: string;
   workspaceId: string;
   eventIds: string[];
}

export interface CommentWrite {
   comment: Comment;
   workspaceId: string;
   eventId: string;
   actorId: string;
}

export interface WorkTrackingHooks {
   afterIssueWrite(write: IssueWrite): Promise<void>;
   afterCommentCreate(write: CommentWrite): Promise<void>;
}

const FINISHED = new Set(['done', 'cancelled']);

function preview(text: string): string {
   const flat = text.replace(/\s+/g, ' ').trim();
   return flat.length > 280 ? `${flat.slice(0, 277)}...` : flat;
}

export function workTrackingHooks(options: {
   sql: Sql;
   issues: IssueRepository;
   dispatch?: Pick<RunRepository, 'admit'> | undefined;
}): WorkTrackingHooks {
   const { sql, issues } = options;
   const gate = stageGate(sql);

   return {
      async afterIssueWrite(write) {
         const { issue, workspaceId } = write;
         if (write.kind === 'created') {
            await subscribe(sql, { workspaceId, issueIds: [issue.id], userIds: [write.actorId], reason: 'creator' });
         }
         if (issue.assignee?.type === 'user') {
            await subscribe(sql, { workspaceId, issueIds: [issue.id], userIds: [issue.assignee.id], reason: 'assignee' });
         }
         const mentioned = write.kind === 'created' ? parseMentions(issue.description ?? '').users : [];
         if (mentioned.length > 0) {
            await subscribe(sql, { workspaceId, issueIds: [issue.id], userIds: mentioned, reason: 'mentioned' });
         }

         const eventId = write.eventIds[0];
         if (eventId && (write.kind === 'updated' || mentioned.length > 0)) {
            const statusChanged = write.previousStatus !== null && write.previousStatus !== issue.status;
            const assigned =
               issue.assignee?.type === 'user' && issue.assignee.id !== write.previousAssigneeId;
            const category: InboxCategory = assigned ? 'assignments' : statusChanged ? 'statusChanges' : 'updates';
            const body = assigned
               ? `Assigned to ${issue.assignee?.name ?? 'someone'}`
               : statusChanged
                 ? `Status changed from ${write.previousStatus ?? ''} to ${issue.status}`
                 : write.kind === 'created'
                   ? 'You were mentioned in a new task'
                   : 'Details changed';
            await notifySubscribers(sql, {
               workspaceId,
               issueId: issue.id,
               sourceEventId: eventId,
               eventType: write.kind === 'created' ? 'issue.created' : 'issue.updated',
               category,
               actor: { type: 'user', id: write.actorId },
               title: `${issue.identifier} ${issue.title}`,
               body,
               mentionedUserIds: mentioned,
            });
         }

         const finishing =
            write.previousStatus !== null && !FINISHED.has(write.previousStatus) && FINISHED.has(issue.status);
         if (options.dispatch && finishing) {
            for (const siblingId of await nextStageReady(sql, issue.id)) {
               const sibling = await issues.get(siblingId);
               await autoDispatch(options.dispatch, sibling, { workspaceId, requestedBy: write.actorId }, gate);
            }
         }
      },

      async afterCommentCreate(write) {
         const { comment, workspaceId } = write;
         const mentions = parseMentions(comment.body);
         if (comment.author.type === 'user') {
            await subscribe(sql, { workspaceId, issueIds: [comment.issueId], userIds: [comment.author.id], reason: 'commenter' });
         }
         if (mentions.users.length > 0) {
            await subscribe(sql, { workspaceId, issueIds: [comment.issueId], userIds: mentions.users, reason: 'mentioned' });
         }
         const issue = await issues.get(comment.issueId);
         await notifySubscribers(sql, {
            workspaceId,
            issueId: comment.issueId,
            sourceEventId: write.eventId,
            eventType: 'comment.created',
            category: 'comments',
            actor: { type: comment.author.type === 'agent' ? 'agent' : 'user', id: comment.author.id },
            title: `${issue.identifier} ${issue.title}`,
            body: preview(comment.body),
            mentionedUserIds: mentions.users,
         });
      },
   };
}
