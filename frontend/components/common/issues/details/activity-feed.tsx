'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ActivityItem } from '@/data/issue-details';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import {
   commentToActivityItem,
   createIssueComment,
   loadIssueComments,
   type ApiComment,
   previewCommentTriggers,
   splitMentions,
   type TriggerPlan,
} from '@/lib/comments';
import { describeActivity, loadIssueActivity } from '@/lib/activity';
import { listIssueRuns, runToActivityItems, runTimestamp } from '@/lib/runs';
import { loadWorkspaceAgents } from '@/lib/agents';
import { useAgentsStore } from '@/store/agents-store';
import { useSessionStore } from '@/store/session-store';
import { toUiUser } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import {
   Ban,
   Bot,
   CircleDot,
   GitPullRequestArrow,
   Link2,
   PenLine,
   Plus,
   RefreshCcw,
   Tag,
   Unlock,
} from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { CommentActions } from './comment-actions';
import { ContentBlocks } from './content-blocks';
import { ReactionBar } from './issue-reactions';
import { useMentionPicker } from './mention-picker';

const EVENT_ICONS: Record<string, ReactNode> = {
   created: <PenLine className="size-3.5" />,
   status: <CircleDot className="size-3.5" />,
   label: <Tag className="size-3.5" />,
   priority: <CircleDot className="size-3.5" />,
   cycle: <RefreshCcw className="size-3.5" />,
   blocked: <Ban className="size-3.5" />,
   unblocked: <Unlock className="size-3.5" />,
   related: <Link2 className="size-3.5" />,
   pr: <GitPullRequestArrow className="size-3.5" />,
   run: <Bot className="size-3.5" />,
};

function EventRow({ item }: { item: Extract<ActivityItem, { kind: 'event' }> }) {
   return (
      <div className="flex items-center gap-2.5 text-muted-foreground py-1.5">
         <span className="flex size-5 shrink-0 items-center justify-center bg-accent">
            {item.actor.role === 'Application' ? (
               <BerryMark size="sm" tone="working" label={`${item.actor.name}, agent`} />
            ) : (
               (EVENT_ICONS[item.event] ?? <CircleDot className="size-3.5" />)
            )}
         </span>
         <span className="min-w-0 truncate">
            <span className="text-foreground/90 font-medium">{item.actor.name}</span> {item.text}
         </span>
         <span className="shrink-0">· {item.timeAgo}</span>
      </div>
   );
}

/** A comment paragraph with its mention tokens shown as links to the agent or squad. */
function MentionText({ text }: { text: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   return (
      <p className="whitespace-pre-wrap break-words">
         {splitMentions(text).map((part, index) =>
            'text' in part ? (
               <span key={index}>{part.text}</span>
            ) : (
               <Link
                  key={index}
                  href={`/${orgId}/${part.mention.kind === 'agent' ? 'agents' : 'squads'}/${part.mention.id}`}
                  className="rounded bg-accent px-1 text-foreground hover:underline"
               >
                  @{part.mention.name}
               </Link>
            )
         )}
      </p>
   );
}

/** The comment's single paragraph, when it carries mentions; otherwise null. */
function mentionParagraph(item: Extract<ActivityItem, { kind: 'comment' }>): string | null {
   const [first] = item.body;
   if (item.body.length !== 1 || !first || first.type !== 'paragraph') return null;
   const text = (first as { text?: string }).text ?? '';
   return splitMentions(text).some((part) => 'mention' in part) ? text : null;
}

function CommentCard({
   item,
   issueRef,
   onChanged,
   onDeleted,
}: {
   item: Extract<ActivityItem, { kind: 'comment' }>;
   issueRef?: string;
   onChanged?: (comment: ApiComment) => void;
   onDeleted?: (commentId: string) => void;
}) {
   const isAgent = item.actor.role === 'Application';
   const mentioned = mentionParagraph(item);

   return (
      <div
         className={cn(
            'mb-0 rounded-sm border border-border/60 bg-container p-3.5',
            isAgent && 'border-azure/25 bg-deep text-chalk'
         )}
      >
         <div className="flex items-center gap-2 mb-1.5">
            {isAgent ? (
               <BerryMark
                  size="sm"
                  tone="working"
                  bracketClassName="text-chalk"
                  label={`${item.actor.name}, agent`}
               />
            ) : (
               <Avatar className="size-5">
                  <AvatarImage src={item.actor.avatarUrl} alt={item.actor.name} />
                  <AvatarFallback>{item.actor.name[0]}</AvatarFallback>
               </Avatar>
            )}
            <span className="font-medium">{item.actor.name}</span>
            <span className={cn('text-muted-foreground', isAgent && 'text-ash')}>
               {item.timeAgo}
            </span>
            {item.comment?.resolvedAt ? (
               <span className="rounded bg-accent px-1.5 text-muted-foreground">resolved</span>
            ) : null}
            {item.comment && issueRef && onChanged && onDeleted ? (
               <CommentActions
                  comment={item.comment}
                  issueRef={issueRef}
                  onChanged={onChanged}
                  onDeleted={onDeleted}
               />
            ) : null}
         </div>
         <div className={cn('[&_p]:my-1.5', isAgent && '[&_.text-muted-foreground]:text-ash')}>
            {mentioned !== null ? <MentionText text={mentioned} /> : <ContentBlocks blocks={item.body} />}
         </div>
         {item.comment ? (
            <div className="mt-1">
               <ReactionBar target="comment" id={item.comment.id} />
            </div>
         ) : null}
      </div>
   );
}

export function useIssueActivity(issueRef: string, issueId?: string) {
   const [items, setItems] = useState<ActivityItem[]>([]);
   const [error, setError] = useState<string | null>(null);
   const [draft, setDraft] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const sessionUser = useSessionStore((state) => state.user);
   const agents = useAgentsStore((state) => state.agents);
   const hydrateAgents = useAgentsStore((state) => state.hydrateAgents);

   // The agents store is filled by the agents page, which a person reading an
   // issue has usually never opened. Without this the feed would name every
   // agent "Agent" — the same blank the assignee bug produced.
   useEffect(() => {
      if (agents.length > 0) return;
      let cancelled = false;
      void loadWorkspaceAgents()
         .then((loaded) => {
            if (!cancelled) hydrateAgents(loaded, null);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [agents.length, hydrateAgents]);

   // Runs carry an agent id and nothing else, so the name comes from the store.
   // An agent the store has not loaded still gets a row — an unnamed actor is
   // better than a missing entry in an audit trail.
   const agentActor = useCallback(
      (agentId: string): User => {
         const agent = agents.find((candidate) => candidate.id === agentId);
         return toUiUser({
            id: agentId,
            name: agent?.name ?? 'Agent',
            avatarUrl: agent?.avatarUrl ?? '',
            type: 'agent',
         });
      },
      [agents]
   );

   useEffect(() => {
      if (!issueRef) {
         setItems([]);
         setError(null);
         return;
      }
      let cancelled = false;
      // Comments and runs are two halves of the same story: what people said
      // and what agents did. Fetched together and merged by time, so an agent's
      // work appears in the thread rather than nowhere.
      void Promise.all([
         // Caught, like its sibling below. Deleting an issue while its detail is
         // open re-reads this thread against an issue the server no longer
         // resolves, and an uncaught rejection there is a console error rather
         // than anything a reader can act on.
         //
         // Not swallowed to an empty list, though: a thread that failed to load
         // and a thread with no comments look identical, and the two want
         // opposite things from the reader. A gone issue is the one exception —
         // it has no activity, which is a fact rather than a failure.
         loadIssueComments(issueRef).catch((cause: unknown) => {
            if (cancelled) return [];
            const gone = cause instanceof BerryApiError && cause.status === 404;
            setError(gone ? null : 'Activity could not be loaded.');
            return [];
         }),
         listIssueRuns(issueId ?? issueRef).catch(() => []),
         loadIssueActivity(issueRef).catch(() => []),
      ]).then(([comments, runs, activity]) => {
         if (cancelled) return;
         const commentItems = comments.map((comment) => ({
            item: commentToActivityItem(comment),
            at: comment.createdAt,
         }));
         const runItems = runs.flatMap((run) =>
            runToActivityItems(run, agentActor(run.agentId)).map((item) => ({
               item,
               at: runTimestamp(run),
            }))
         );
         const eventItems = activity.flatMap((entry) => {
            const described = describeActivity(entry);
            if (!described || !entry.actor) return [];
            return [
               {
                  item: {
                     kind: 'event' as const,
                     id: entry.id,
                     actor: toUiUser({
                        id: entry.actor.id,
                        name: entry.actor.name ?? 'Someone',
                        avatarUrl: entry.actor.avatarUrl ?? '',
                        type: entry.actor.type === 'agent' ? 'agent' : 'user',
                     }),
                     event: described.event,
                     text: described.text,
                     timeAgo: formatDistanceToNow(parseISO(entry.occurredAt), { addSuffix: true }),
                  },
                  at: entry.occurredAt,
               },
            ];
         });
         const merged = [...commentItems, ...runItems, ...eventItems].sort((left, right) =>
            left.at.localeCompare(right.at)
         );
         setItems(merged.map((entry) => entry.item));
      });
      setError(null);
      return () => {
         cancelled = true;
      };
   }, [issueRef, issueId, agentActor]);

   const submitComment = useCallback(() => {
      const text = draft.trim();
      if (!text || !issueRef || submitting) return;
      setSubmitting(true);
      void createIssueComment(issueRef, text)
         .then((comment) => {
            setItems((previous) => [...previous, commentToActivityItem(comment)]);
            setDraft('');
         })
         .catch(() => {
            const actor = sessionUser
               ? toUiUser({ ...sessionUser, type: 'user' })
               : {
                    id: 'me',
                    name: 'You',
                    avatarUrl: '',
                    email: '',
                    status: 'online' as const,
                    role: 'Member' as const,
                    joinedDate: '',
                    teamIds: [],
                    timezone: 'UTC',
                 };
            setItems((previous) => [
               ...previous,
               {
                  kind: 'comment',
                  id: `local-${Date.now()}`,
                  actor,
                  timeAgo: 'just now',
                  body: [{ type: 'paragraph', text }],
               },
            ]);
            setDraft('');
         })
         .finally(() => setSubmitting(false));
   }, [draft, issueRef, sessionUser, submitting]);

   const replaceComment = useCallback((comment: ApiComment) => {
      setItems((previous) =>
         previous.map((item) =>
            item.kind === 'comment' && item.id === comment.id ? commentToActivityItem(comment) : item
         )
      );
   }, []);
   const removeComment = useCallback((commentId: string) => {
      setItems((previous) => previous.filter((item) => item.id !== commentId));
   }, []);

   return {
      items,
      error,
      draft,
      setDraft,
      submitComment,
      submitting,
      replaceComment,
      removeComment,
   };
}

/** @deprecated Prefer `useIssueActivity` with an issue identifier. */
export function useActivityFeed(activity: ActivityItem[]) {
   const [items, setItems] = useState<ActivityItem[]>(activity);
   const [draft, setDraft] = useState('');

   useEffect(() => {
      setItems(activity);
   }, [activity]);

   const submitComment = () => {
      const text = draft.trim();
      if (!text) return;
      setItems((previous) => [
         ...previous,
         {
            kind: 'comment',
            id: `local-${previous.length}`,
            actor: {
               id: 'me',
               name: 'You',
               avatarUrl: '',
               email: '',
               status: 'online',
               role: 'Member',
               joinedDate: '',
               teamIds: [],
               timezone: 'UTC',
            },
            timeAgo: 'just now',
            body: [{ type: 'paragraph', text }],
         },
      ]);
      setDraft('');
   };

   return { items, draft, setDraft, submitComment };
}

export function ActivityFeedList({
   items,
   error,
   issueRef,
   onCommentChanged,
   onCommentDeleted,
}: {
   items: ActivityItem[];
   error?: string | null;
   issueRef?: string;
   onCommentChanged?: (comment: ApiComment) => void;
   onCommentDeleted?: (commentId: string) => void;
}) {
   return (
      <div className="border-t border-border/60 pt-4">
         <div className="mb-1 pb-[7px] font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            activity
         </div>

         {error && (
            <p className="mb-2 text-muted-foreground" role="alert">
               {error}
            </p>
         )}

         <div className="flex flex-col gap-1.5">
            {items.map((item) =>
               item.kind === 'event' ? (
                  <EventRow key={item.id} item={item} />
               ) : (
                  <CommentCard
                     key={item.id}
                     item={item}
                     issueRef={issueRef}
                     onChanged={onCommentChanged}
                     onDeleted={onCommentDeleted}
                  />
               )
            )}
         </div>
      </div>
   );
}

/** What the preview line says about the agents a comment would start. */
function describePlan(plan: TriggerPlan): { starts: string | null; refused: string | null } {
   const reply = plan.targets.find((target) => target.reason === 'reply_to_assignee');
   const others = plan.targets.filter((target) => target.reason !== 'reply_to_assignee');
   const starts = reply
      ? `${reply.agentName} will pick up this reply`
      : others.length > 0
        ? `Will start: ${others
             .map((target) => `${target.agentName} (${target.reason === 'squad_leader' ? 'squad lead' : 'mention'})`)
             .join(', ')}`
        : null;
   const refused =
      plan.refused.length > 0
         ? `Not allowed to mention: ${plan.refused.map((entry) => entry.agentName).join(', ')}`
         : null;
   return { starts, refused };
}

export function ActivityCommentComposer({
   draft,
   setDraft,
   submitComment,
   className,
   issueRef,
}: {
   draft: string;
   setDraft: (value: string) => void;
   submitComment: () => void;
   className?: string;
   /** With an issue, the composer offers mentions and previews which agents a comment starts. */
   issueRef?: string;
}) {
   const textareaRef = useRef<HTMLTextAreaElement>(null);
   const picker = useMentionPicker(textareaRef, draft, setDraft);
   const [plan, setPlan] = useState<TriggerPlan | null>(null);

   // Debounced: the preview is advice, and a request per keystroke is not.
   useEffect(() => {
      if (!issueRef || !draft.trim()) {
         setPlan(null);
         return;
      }
      let cancelled = false;
      const timer = setTimeout(() => {
         previewCommentTriggers(issueRef, draft).then(
            (next) => {
               if (!cancelled) setPlan(next);
            },
            () => {
               if (!cancelled) setPlan(null);
            }
         );
      }, 400);
      return () => {
         cancelled = true;
         clearTimeout(timer);
      };
   }, [issueRef, draft]);

   const preview = plan ? describePlan(plan) : null;

   return (
      <div className={cn('flex flex-col border-t border-border/60 bg-container p-3', className)}>
         <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
               setDraft(event.target.value);
               if (issueRef) requestAnimationFrame(picker.sync);
            }}
            onKeyUp={(event) => {
               if (issueRef && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) picker.sync();
            }}
            onClick={() => {
               if (issueRef) picker.sync();
            }}
            onKeyDown={(event) => {
               if (issueRef && picker.handleKeyDown(event)) return;
               if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  submitComment();
               }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder="leave a comment…"
            rows={2}
            className="w-full resize-none bg-transparent text-foreground outline-none placeholder:text-foreground/40"
         />
         {issueRef ? picker.list : null}
         {preview?.starts ? <p className="mt-1 text-muted-foreground">{preview.starts}</p> : null}
         {preview?.refused ? <p className="mt-1 text-destructive/80">{preview.refused}</p> : null}
         <div className="flex items-center justify-between" style={{ marginTop: 28 }}>
            <Plus className="size-4 text-muted-foreground" />
            <Button size="xs" onClick={submitComment} disabled={!draft.trim()}>
               comment
            </Button>
         </div>
      </div>
   );
}

/** Issue activity list + composer (inline layout for full-page views). */
export function ActivityFeed({ activity }: { activity: ActivityItem[] }) {
   const { items, draft, setDraft, submitComment } = useActivityFeed(activity);

   return (
      <>
         <ActivityFeedList items={items} />
         <ActivityCommentComposer
            draft={draft}
            setDraft={setDraft}
            submitComment={submitComment}
            className="mt-3 rounded-sm border border-border/60 mx-0"
         />
      </>
   );
}
