'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ActivityItem } from '@/data/issue-details';
import type { User } from '@/data/users';
import { commentToActivityItem, createIssueComment, loadIssueComments } from '@/lib/comments';
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
   SmilePlus,
   Tag,
   Unlock,
} from 'lucide-react';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ContentBlocks } from './content-blocks';

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

function CommentCard({ item }: { item: Extract<ActivityItem, { kind: 'comment' }> }) {
   const isAgent = item.actor.role === 'Application';

   return (
      <div
         className={cn(
            'my-2 rounded-sm border border-border/60 bg-container p-3.5',
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
         </div>
         <div
            className={cn('[&_p]:my-1.5', isAgent && '[&_.text-muted-foreground]:text-ash')}
         >
            <ContentBlocks blocks={item.body} />
         </div>
         <div className="flex items-center gap-1.5 mt-1">
            {item.reactions?.map((reaction) => (
               <span
                  key={reaction.emoji}
                  className={cn(
                     'inline-flex items-center gap-1 rounded-full border border-border/60 bg-accent/60 px-2 py-0.5',
                     isAgent && 'border-white/10 bg-white/5 text-ash'
                  )}
               >
                  {reaction.emoji} {reaction.count}
               </span>
            ))}
            <button className="text-muted-foreground hover:text-foreground">
               <SmilePlus className="size-3.5" />
            </button>
         </div>
      </div>
   );
}

export function useIssueActivity(issueRef: string, issueId?: string) {
   const [items, setItems] = useState<ActivityItem[]>([]);
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
      [agents],
   );

   useEffect(() => {
      if (!issueRef) {
         setItems([]);
         return;
      }
      let cancelled = false;
      // Comments and runs are two halves of the same story: what people said
      // and what agents did. Fetched together and merged by time, so an agent's
      // work appears in the thread rather than nowhere.
      void Promise.all([
         loadIssueComments(issueRef),
         listIssueRuns(issueId ?? issueRef).catch(() => []),
      ]).then(([comments, runs]) => {
         if (cancelled) return;
         const commentItems = comments.map((comment) => ({
            item: commentToActivityItem(comment),
            at: comment.createdAt,
         }));
         const runItems = runs.flatMap((run) =>
            runToActivityItems(run, agentActor(run.agentId)).map((item) => ({
               item,
               at: runTimestamp(run),
            })),
         );
         const merged = [...commentItems, ...runItems].sort((left, right) =>
            left.at.localeCompare(right.at),
         );
         setItems(merged.map((entry) => entry.item));
      });
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
            const actor = sessionUser ? toUiUser({ ...sessionUser, type: 'user' }) : {
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

   return { items, draft, setDraft, submitComment, submitting };
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

export function ActivityFeedList({ items }: { items: ActivityItem[] }) {
   return (
      <div className="mt-4 border-t border-border/60 pt-4">
         <div className="flex items-center justify-between mb-2">
            <h2 className="font-medium">activity</h2>
            <button className="text-muted-foreground hover:text-foreground">
               subscribe
            </button>
         </div>

         <div className="flex flex-col">
            {items.map((item) =>
               item.kind === 'event' ? (
                  <EventRow key={item.id} item={item} />
               ) : (
                  <CommentCard key={item.id} item={item} />
               )
            )}
         </div>
      </div>
   );
}

export function ActivityCommentComposer({
   draft,
   setDraft,
   submitComment,
   className,
}: {
   draft: string;
   setDraft: (value: string) => void;
   submitComment: () => void;
   className?: string;
}) {
   return (
      <div
         className={cn(
            'flex flex-col gap-2 border-t border-border/60 bg-container p-3 sm:px-8',
            className
         )}
      >
         <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
               if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  submitComment();
               }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder="leave a comment…"
            rows={2}
            className="w-full resize-none bg-transparent text-foreground outline-none placeholder:text-foreground/40"
         />
         <div className="flex items-center justify-between">
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
