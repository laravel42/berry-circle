'use client';

import { useShortcut } from '@/components/layout/shortcut-provider';
import { BerryMark } from '@/components/brand/berry-mark';
import { RunTranscriptDialog } from '@/components/common/runs/transcript-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ActivityItem } from '@/data/issue-details';
import type { User } from '@/data/users';
import { describeActivity, loadIssueActivity } from '@/lib/activity';
import { BerryApiError } from '@/lib/api';
import { uploadIssueAttachment } from '@/lib/attachments';
import { toUiUser } from '@/lib/catalog';
import {
   createIssueComment,
   loadIssueComments,
   previewCommentTriggers,
   setCommentResolved,
   splitMentions,
   type ApiComment,
   type TriggerPlan,
} from '@/lib/comments';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   cancelRun,
   isTerminalRunEvent,
   streamRunEvents,
   textFromRunEvent,
   type RunRecord,
} from '@/lib/runs';
import { subscribeShellEvent } from '@/lib/shell-events';
import { listSkills, type Skill } from '@/lib/skills';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useCommentDraftStore } from '@/store/comment-draft-store';
import { useIssueRuns, useIssueRunsStore } from '@/store/issue-runs-store';
import { formatDistanceToNow, parseISO } from 'date-fns';
import {
   Ban,
   Bot,
   ChevronDown,
   ChevronRight,
   CircleDot,
   GitPullRequestArrow,
   Link2,
   Loader2,
   Paperclip,
   PenLine,
   RefreshCcw,
   Tag,
   Unlock,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CommentActions } from './comment-actions';
import { ReactionBar } from './issue-reactions';
import { useMentionPicker } from './mention-picker';

/**
 * What has happened to this task, and the place to add to it.
 *
 * The feed mixes two kinds of thing that deserve very different weight:
 * comments, which are people talking, and activity, which is bookkeeping. So
 * activity is coalesced — six status changes in a row become one line saying
 * so — and comments keep their full shape, including their replies and the
 * agent runs they set off.
 */

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

type EventItem = Extract<ActivityItem, { kind: 'event' }>;

/** A task key as typed: `BER-12`. Rendered as a link wherever it appears. */
const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,5}-\d+)\b/g;

function timeAgo(iso: string): string {
   try {
      return formatDistanceToNow(parseISO(iso), { addSuffix: true });
   } catch {
      return 'recently';
   }
}

/** Comment text with its mentions and task keys turned into links. */
function CommentText({ body }: { body: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   const org = orgId ?? WORKSPACE_SLUG;

   const linkKeys = (text: string, keyPrefix: string): ReactNode[] => {
      const parts: ReactNode[] = [];
      let last = 0;
      for (const match of text.matchAll(ISSUE_KEY)) {
         const index = match.index ?? 0;
         if (index > last) parts.push(text.slice(last, index));
         parts.push(
            <Link
               key={`${keyPrefix}-${index}`}
               href={`/${org}/issue/${match[1]}`}
               className="underline underline-offset-2"
            >
               {match[1]}
            </Link>
         );
         last = index + match[0].length;
      }
      if (last < text.length) parts.push(text.slice(last));
      return parts;
   };

   return (
      <p className="whitespace-pre-wrap break-words">
         {splitMentions(body).map((part, index) =>
            'text' in part ? (
               <span key={index}>{linkKeys(part.text, String(index))}</span>
            ) : (
               <Link
                  key={index}
                  href={`/${org}/${part.mention.kind === 'agent' ? 'agents' : 'squads'}/${part.mention.id}`}
                  className="rounded bg-accent px-1 text-foreground hover:underline"
               >
                  @{part.mention.name}
               </Link>
            )
         )}
      </p>
   );
}

function EventRow({ item }: { item: EventItem }) {
   return (
      <div className="flex items-center gap-2.5 py-1.5 text-muted-foreground">
         <span className="flex size-5 shrink-0 items-center justify-center bg-accent">
            {item.actor.role === 'Application' ? (
               <BerryMark size="sm" tone="working" label={`${item.actor.name}, agent`} />
            ) : (
               (EVENT_ICONS[item.event] ?? <CircleDot className="size-3.5" />)
            )}
         </span>
         <span className="min-w-0 truncate">
            <span className="font-medium text-foreground/90">{item.actor.name}</span> {item.text}
         </span>
         <span className="shrink-0">· {item.timeAgo}</span>
      </div>
   );
}

/** A run of bookkeeping, folded into one line until someone asks for it. */
function EventGroup({ items }: { items: EventItem[] }) {
   const t = useTranslations('issueDetail.activity');
   const [expanded, setExpanded] = useState(false);
   const first = items[0];
   if (!first) return null;
   if (items.length === 1 || expanded) {
      return (
         <div className="flex flex-col">
            {items.map((item) => (
               <EventRow key={item.id} item={item} />
            ))}
            {items.length > 1 ? (
               <Button
                  variant="ghost"
                  size="xs"
                  className="-ml-2 self-start text-muted-foreground"
                  onClick={() => setExpanded(false)}
               >
                  {t('showLess')}
               </Button>
            ) : null}
         </div>
      );
   }
   return (
      <div className="flex items-center gap-2">
         <EventRow item={first} />
         <span className="shrink-0 rounded bg-accent px-1.5 text-muted-foreground">
            {t('repeated', { count: items.length })}
         </span>
         <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground"
            onClick={() => setExpanded(true)}
         >
            {t('showMore', { count: items.length - 1 })}
         </Button>
      </div>
   );
}

/**
 * An agent's run, shown under the comment that set it off.
 *
 * A run started by a mention belongs to that message, not to the bottom of the
 * page: the reply and the work it caused are one exchange. A live one streams
 * its output here so the reader can see it is going without opening anything.
 */
function InlineRun({
   run,
   onRunChanged,
}: {
   run: RunRecord;
   onRunChanged: (run: RunRecord) => void;
}) {
   const t = useTranslations('issueDetail.activity');
   const getAgentById = useAgentsStore((state) => state.getAgentById);
   const [output, setOutput] = useState('');
   const [transcript, setTranscript] = useState(false);
   const [busy, setBusy] = useState(false);
   const live = run.status === 'running' || run.status === 'queued';

   useEffect(() => {
      if (!live) return;
      const controller = new AbortController();
      let text = '';
      void (async () => {
         try {
            for await (const event of streamRunEvents(run.id, controller.signal)) {
               const chunk = textFromRunEvent(event);
               if (chunk) {
                  text = `${text}${chunk}`.slice(-4000);
                  setOutput(text);
               }
               if (isTerminalRunEvent(event.type)) return;
            }
         } catch {
            // A dropped stream leaves what arrived; the transcript has the rest.
         }
      })();
      return () => controller.abort();
   }, [run.id, live]);

   const stop = () => {
      setBusy(true);
      void cancelRun(run.id)
         .then(onRunChanged)
         .catch(() => undefined)
         .finally(() => setBusy(false));
   };

   const name = getAgentById(run.agentId)?.name ?? 'Agent';

   return (
      <div className="mt-1.5 rounded-sm border border-azure/25 bg-deep p-2 text-chalk">
         <div className="flex min-w-0 items-center gap-2">
            <BerryMark
               size="sm"
               tone="working"
               pulse={live}
               bracketClassName="text-chalk"
               label={name}
            />
            <span className="min-w-0 truncate">
               {name} · {t('runStarted')}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
               <Button
                  variant="ghost"
                  size="xs"
                  className="text-chalk hover:bg-chalk/10 hover:text-chalk"
                  onClick={() => setTranscript(true)}
               >
                  {run.status}
               </Button>
               {live ? (
                  <Button
                     variant="ghost"
                     size="xs"
                     disabled={busy}
                     className="text-chalk hover:bg-chalk/10 hover:text-chalk"
                     onClick={stop}
                  >
                     {t('runStop')}
                  </Button>
               ) : null}
            </span>
         </div>
         {live ? (
            <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words leading-6 text-ash">
               {output || t('runWaiting')}
            </pre>
         ) : null}
         <RunTranscriptDialog
            runId={transcript ? run.id : null}
            open={transcript}
            agentName={name}
            onOpenChange={setTranscript}
         />
      </div>
   );
}

function CommentCard({
   comment,
   issueRef,
   replies,
   runs,
   highlighted,
   onChanged,
   onDeleted,
   onRunChanged,
   onPosted,
}: {
   comment: ApiComment;
   issueRef: string;
   replies: ApiComment[];
   runs: RunRecord[];
   highlighted: boolean;
   onChanged: (comment: ApiComment) => void;
   onDeleted: (commentId: string) => void;
   onRunChanged: (run: RunRecord) => void;
   onPosted: (comment: ApiComment) => void;
}) {
   const t = useTranslations('issueDetail.activity');
   const [collapsed, setCollapsed] = useState(false);
   // The palette can fold or unfold every thread at once. It says what it did
   // rather than reaching in here, so each card decides for itself — which is
   // also what makes a thread opened afterwards stay opened.
   useEffect(
      () => subscribeShellEvent('berry:comments-fold', ({ folded }) => setCollapsed(folded)),
      []
   );
   const [replying, setReplying] = useState(false);
   const [resolving, setResolving] = useState(false);
   const [closingNote, setClosingNote] = useState('');
   const actor: User = toUiUser(comment.author);
   const isAgent = comment.author.type === 'agent';

   const resolve = (resolved: boolean, note: string) => {
      const post = note.trim()
         ? createIssueComment(issueRef, note.trim(), comment.id).then(onPosted)
         : Promise.resolve();
      void post
         .then(() => setCommentResolved(comment.id, resolved))
         .then(onChanged)
         .then(() => {
            setResolving(false);
            setClosingNote('');
         })
         .catch(() => toast.error(t('resolveFailed')));
   };

   return (
      <div
         data-comment-id={comment.id}
         className={cn(
            'rounded-sm border border-border/60 bg-container p-3.5 transition-colors',
            isAgent && 'border-azure/25 bg-deep text-chalk',
            highlighted && 'border-status-warning bg-status-warning/5'
         )}
      >
         <div className="mb-1.5 flex items-center gap-2">
            {isAgent ? (
               <BerryMark
                  size="sm"
                  tone="working"
                  bracketClassName="text-chalk"
                  label={`${actor.name}, agent`}
               />
            ) : (
               <Avatar className="size-5">
                  <AvatarImage src={actor.avatarUrl} alt={actor.name} />
                  <AvatarFallback>{actor.name[0]}</AvatarFallback>
               </Avatar>
            )}
            <span className="font-medium">{actor.name}</span>
            <span className={cn('text-muted-foreground', isAgent && 'text-ash')}>
               {timeAgo(comment.createdAt)}
            </span>
            {comment.resolvedAt ? (
               <span className="rounded bg-accent px-1.5 text-muted-foreground">
                  {t('resolved')}
               </span>
            ) : null}
            <CommentActions
               comment={comment}
               issueRef={issueRef}
               replyCount={replies.length}
               onChanged={onChanged}
               onDeleted={onDeleted}
               onReply={() => setReplying(true)}
            />
         </div>

         <div className={cn('[&_p]:my-1.5', isAgent && '[&_.text-muted-foreground]:text-ash')}>
            <CommentText body={comment.body} />
         </div>

         <div className="mt-1 flex flex-wrap items-center gap-2">
            <ReactionBar target="comment" id={comment.id} />
            <Button
               variant="ghost"
               size="xs"
               className="text-muted-foreground"
               onClick={() => setReplying((value) => !value)}
            >
               {t('reply')}
            </Button>
            {!comment.parentId ? (
               <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => (comment.resolvedAt ? resolve(false, '') : setResolving(true))}
               >
                  {comment.resolvedAt ? t('unresolve') : t('resolve')}
               </Button>
            ) : null}
            {replies.length > 0 ? (
               <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsed((value) => !value)}
               >
                  {collapsed ? (
                     <ChevronRight className="mr-1 size-3.5" />
                  ) : (
                     <ChevronDown className="mr-1 size-3.5" />
                  )}
                  {t('replies', { count: replies.length })}
               </Button>
            ) : null}
         </div>

         {runs.map((run) => (
            <InlineRun key={run.id} run={run} onRunChanged={onRunChanged} />
         ))}

         {replies.length > 0 && !collapsed ? (
            <div className="mt-2 flex flex-col gap-2 border-l border-border/60 pl-3">
               {replies.map((reply) => (
                  <CommentCard
                     key={reply.id}
                     comment={reply}
                     issueRef={issueRef}
                     replies={[]}
                     runs={[]}
                     highlighted={false}
                     onChanged={onChanged}
                     onDeleted={onDeleted}
                     onRunChanged={onRunChanged}
                     onPosted={onPosted}
                  />
               ))}
            </div>
         ) : null}

         {replying ? (
            <div className="mt-2">
               <ActivityCommentComposer
                  issueRef={issueRef}
                  parentId={comment.parentId ?? comment.id}
                  onPosted={(posted) => {
                     onPosted(posted);
                     setReplying(false);
                  }}
                  className="rounded-sm border border-border/60 p-2"
               />
            </div>
         ) : null}

         <Dialog open={resolving} onOpenChange={setResolving}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>{t('resolveTitle')}</DialogTitle>
               </DialogHeader>
               <Textarea
                  rows={3}
                  placeholder={t('resolveComment')}
                  value={closingNote}
                  onChange={(event) => setClosingNote(event.target.value)}
               />
               <DialogFooter>
                  <Button variant="ghost" onClick={() => setResolving(false)}>
                     {t('cancel')}
                  </Button>
                  <Button onClick={() => resolve(true, closingNote)}>{t('resolveConfirm')}</Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </div>
   );
}

// --------------------------------------------------------------------- data

export function useIssueActivity(issueRef: string, issueId?: string) {
   const [comments, setComments] = useState<ApiComment[]>([]);
   const [events, setEvents] = useState<EventItem[]>([]);
   const [error, setError] = useState<string | null>(null);
   const agents = useAgentsStore((state) => state.agents);
   const hydrateAgents = useAgentsStore((state) => state.hydrateAgents);
   const { runs, upsert } = useIssueRuns(issueId);

   // The feed names agents, and a reader arriving from an inbox link has never
   // opened the agents page, so the store would be empty and every agent would
   // be called "Agent".
   useEffect(() => {
      if (agents.length > 0) return;
      let cancelled = false;
      void import('@/lib/agents')
         .then(({ loadWorkspaceAgents }) => loadWorkspaceAgents())
         .then((loaded) => {
            if (!cancelled) hydrateAgents(loaded, null);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [agents.length, hydrateAgents]);

   useEffect(() => {
      if (!issueRef) {
         setComments([]);
         setEvents([]);
         setError(null);
         return;
      }
      let cancelled = false;
      void Promise.all([
         loadIssueComments(issueRef).catch((cause: unknown) => {
            if (cancelled) return [];
            // A deleted task has no activity, which is a fact rather than a
            // failure; anything else is worth saying out loud.
            const gone = cause instanceof BerryApiError && cause.status === 404;
            setError(gone ? null : 'Activity could not be loaded.');
            return [];
         }),
         loadIssueActivity(issueRef).catch(() => []),
      ]).then(([loadedComments, activity]) => {
         if (cancelled) return;
         setComments(loadedComments);
         setEvents(
            activity.flatMap((entry) => {
               const described = describeActivity(entry);
               if (!described || !entry.actor) return [];
               return [
                  {
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
                     timeAgo: timeAgo(entry.occurredAt),
                     at: entry.occurredAt,
                  } as EventItem & { at: string },
               ];
            })
         );
      });
      setError(null);
      return () => {
         cancelled = true;
      };
   }, [issueRef, issueId]);

   const addComment = useCallback((comment: ApiComment) => {
      setComments((current) => [...current.filter((entry) => entry.id !== comment.id), comment]);
   }, []);
   const replaceComment = useCallback((comment: ApiComment) => {
      setComments((current) => current.map((entry) => (entry.id === comment.id ? comment : entry)));
   }, []);
   const removeComment = useCallback((commentId: string) => {
      setComments((current) =>
         current.filter((entry) => entry.id !== commentId && entry.parentId !== commentId)
      );
   }, []);

   return {
      comments,
      events,
      runs,
      error,
      addComment,
      replaceComment,
      removeComment,
      upsertRun: upsert,
   };
}

// ------------------------------------------------------------------ listing

export function ActivityFeedList({
   comments,
   events,
   runs,
   error,
   issueRef,
   highlightedCommentId,
   onCommentChanged,
   onCommentDeleted,
   onCommentPosted,
   onRunChanged,
}: {
   comments: ApiComment[];
   events: Array<EventItem & { at?: string }>;
   runs: RunRecord[];
   error?: string | null;
   issueRef: string;
   highlightedCommentId?: string | null;
   onCommentChanged: (comment: ApiComment) => void;
   onCommentDeleted: (commentId: string) => void;
   onCommentPosted: (comment: ApiComment) => void;
   onRunChanged: (run: RunRecord) => void;
}) {
   const t = useTranslations('issueDetail.activity');
   const [showResolved, setShowResolved] = useState(false);

   const repliesByParent = useMemo(() => {
      const map = new Map<string, ApiComment[]>();
      for (const comment of comments) {
         if (!comment.parentId) continue;
         map.set(comment.parentId, [...(map.get(comment.parentId) ?? []), comment]);
      }
      for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return map;
   }, [comments]);

   const roots = useMemo(
      () =>
         comments
            .filter((comment) => !comment.parentId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      [comments]
   );

   // A run started by a mention belongs to the last comment written before it.
   const runsByComment = useMemo(() => {
      const ordered = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const map = new Map<string, RunRecord[]>();
      for (const run of runs) {
         if (run.source !== 'mention') continue;
         const trigger = [...ordered]
            .reverse()
            .find((comment) => comment.createdAt <= run.createdAt);
         if (!trigger) continue;
         map.set(trigger.id, [...(map.get(trigger.id) ?? []), run]);
      }
      return map;
   }, [comments, runs]);

   const timeline = useMemo(() => {
      type Row =
         | { kind: 'comment'; at: string; comment: ApiComment }
         | { kind: 'events'; at: string; items: EventItem[] };
      const rows: Row[] = [
         ...roots.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment })),
         ...events.map((event) => ({
            kind: 'events' as const,
            at: event.at ?? '',
            items: [event],
         })),
      ].sort((left, right) => left.at.localeCompare(right.at));

      // Consecutive bookkeeping folds together; a comment between two runs of
      // it keeps them apart, which is what makes the fold readable.
      const folded: Row[] = [];
      for (const row of rows) {
         const last = folded[folded.length - 1];
         if (row.kind === 'events' && last && last.kind === 'events') {
            last.items = [...last.items, ...row.items];
            continue;
         }
         folded.push(row.kind === 'events' ? { ...row, items: [...row.items] } : row);
      }
      return folded;
   }, [roots, events]);

   const resolvedRoots = roots.filter((comment) => comment.resolvedAt);

   return (
      <div className="border-t border-border/60 pt-4">
         <div className="mb-1 pb-[7px] font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            {t('title')}
         </div>

         {error && (
            <p className="mb-2 text-muted-foreground" role="alert">
               {error}
            </p>
         )}

         {resolvedRoots.length > 0 ? (
            <div className="mb-2 flex items-center gap-2 rounded-sm bg-muted/30 px-2 py-1">
               <span className="text-muted-foreground">
                  {t('resolvedSummary', { count: resolvedRoots.length })}
               </span>
               <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  onClick={() => setShowResolved((value) => !value)}
               >
                  {showResolved ? t('hideResolved') : t('showResolved')}
               </Button>
            </div>
         ) : null}

         <div className="flex flex-col gap-1.5">
            {timeline.map((row, index) =>
               row.kind === 'events' ? (
                  <EventGroup key={`events-${row.items[0]?.id ?? index}`} items={row.items} />
               ) : row.comment.resolvedAt && !showResolved ? null : (
                  <CommentCard
                     key={row.comment.id}
                     comment={row.comment}
                     issueRef={issueRef}
                     replies={repliesByParent.get(row.comment.id) ?? []}
                     runs={runsByComment.get(row.comment.id) ?? []}
                     highlighted={highlightedCommentId === row.comment.id}
                     onChanged={onCommentChanged}
                     onDeleted={onCommentDeleted}
                     onRunChanged={onRunChanged}
                     onPosted={onCommentPosted}
                  />
               )
            )}
         </div>
      </div>
   );
}

// ----------------------------------------------------------------- composer

/** The body as it will be sent, with the named agents demoted to plain text. */
function withoutMentions(body: string, agentIds: Set<string>): string {
   return splitMentions(body)
      .map((part) =>
         'text' in part
            ? part.text
            : agentIds.has(part.mention.id)
              ? `@${part.mention.name}`
              : `@[${part.mention.name}](${part.mention.kind}:${part.mention.id})`
      )
      .join('');
}

export function ActivityCommentComposer({
   issueRef,
   parentId,
   onPosted,
   className,
}: {
   issueRef: string;
   /** Set on a reply; the root composer leaves it undefined. */
   parentId?: string;
   onPosted: (comment: ApiComment) => void;
   className?: string;
}) {
   const t = useTranslations('issueDetail.composer');
   const drafts = useCommentDraftStore((state) => state.drafts);
   const setStoredDraft = useCommentDraftStore((state) => state.setDraft);
   const clearStoredDraft = useCommentDraftStore((state) => state.clearDraft);

   const isReply = parentId !== undefined;
   const [replyDraft, setReplyDraft] = useState('');
   const draft = isReply ? replyDraft : (drafts[issueRef] ?? '');
   const setDraft = useCallback(
      (value: string) => {
         if (isReply) setReplyDraft(value);
         else setStoredDraft(issueRef, value);
      },
      [isReply, issueRef, setStoredDraft]
   );

   const textareaRef = useRef<HTMLTextAreaElement>(null);
   const picker = useMentionPicker(textareaRef, draft, setDraft);
   const [plan, setPlan] = useState<TriggerPlan | null>(null);
   const [skipped, setSkipped] = useState<string[]>([]);
   const [note, setNote] = useState(false);
   const [sending, setSending] = useState(false);
   const [uploading, setUploading] = useState(0);
   const [skills, setSkills] = useState<Skill[]>([]);
   const [slash, setSlash] = useState(false);
   const [focused, setFocused] = useState(false);
   const filePicker = useRef<HTMLInputElement>(null);

   // Slash commands open on a leading "/" and close as soon as the line stops
   // being one, so typing a path in a sentence does not summon a menu.
   useEffect(() => {
      setSlash(/^\/[\w-]*$/.test(draft));
   }, [draft]);

   useEffect(() => {
      if (!slash || skills.length > 0) return;
      void listSkills()
         .then(setSkills)
         .catch(() => setSkills([]));
   }, [slash, skills.length]);

   // Debounced: the preview is advice, and a request per keystroke is not.
   useEffect(() => {
      if (note || !issueRef || !draft.trim()) {
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
   }, [issueRef, draft, note]);

   const upload = async (files: FileList | null) => {
      const list = files ? Array.from(files) : [];
      if (list.length === 0) return;
      setUploading((count) => count + list.length);
      for (const file of list) {
         await uploadIssueAttachment(issueRef, file).catch(() => {
            toast.error(t('sendFailed'));
         });
         setUploading((count) => Math.max(0, count - 1));
      }
      if (filePicker.current) filePicker.current.value = '';
   };

   const send = () => {
      const text = draft.trim();
      if (!text || sending) return;
      if (uploading > 0) {
         toast.error(t('uploadsPending'));
         return;
      }
      // A note starts nothing, so every mention in it is demoted; otherwise
      // only the agents the writer clicked off are.
      const removed = note
         ? new Set((plan?.targets ?? []).map((target) => target.agentId))
         : new Set(skipped);
      const body = note
         ? withoutMentions(text, new Set(collectMentionIds(text)))
         : withoutMentions(text, removed);

      setSending(true);
      void createIssueComment(issueRef, body, parentId)
         .then((comment) => {
            onPosted(comment);
            if (isReply) setReplyDraft('');
            else clearStoredDraft(issueRef);
            setSkipped([]);
            setNote(false);
            const planned = plan?.targets.length ?? 0;
            const started = note ? 0 : planned - skipped.length;
            if (planned > 0 && started < planned) {
               toast.message(t('partial', { started, total: planned }));
            }
            // The mention started runs the execution log is already showing
            // the absence of. Nothing else tells it, so it would keep saying
            // "no runs yet" until the page was reloaded.
            if (started > 0) useIssueRunsStore.getState().load(comment.issueId);
            setPlan(null);
         })
         .catch(() => toast.error(t('sendFailed')))
         .finally(() => setSending(false));
   };

   // mod+Enter, through the shell's registry rather than a key handler on the
   // textarea, so one rebindable row in settings covers every composer. Only
   // while this box has focus: the action belongs to whichever composer the
   // writer is actually typing in, and the last claim wins.
   useShortcut('composer.send', send, { enabled: focused });

   return (
      <div className={cn('flex flex-col border-t border-border/60 bg-container p-3', className)}>
         <textarea
            ref={textareaRef}
            value={draft}
            aria-label={t('placeholder')}
            onChange={(event) => {
               setDraft(event.target.value);
               requestAnimationFrame(picker.sync);
            }}
            onKeyUp={(event) => {
               if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') picker.sync();
            }}
            onClick={picker.sync}
            onKeyDown={(event) => picker.handleKeyDown(event)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder={t('placeholder')}
            rows={2}
            className="w-full resize-none bg-transparent text-foreground outline-none placeholder:text-foreground/40"
         />

         {picker.list}

         {slash ? (
            <ul className="z-20 mt-1 max-h-48 w-72 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
               <li className="px-2 pt-1 pb-0.5 uppercase tracking-[0.12em] text-muted-foreground">
                  {t('slashTitle')}
               </li>
               <li>
                  <button
                     type="button"
                     className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent"
                     onMouseDown={(event) => {
                        event.preventDefault();
                        setNote(true);
                        setDraft('');
                        textareaRef.current?.focus();
                     }}
                  >
                     <span>{t('note')}</span>
                     <span className="text-muted-foreground">{t('noteHint')}</span>
                  </button>
               </li>
               <li className="px-2 pt-1 pb-0.5 uppercase tracking-[0.12em] text-muted-foreground">
                  {t('skills')}
               </li>
               {skills.map((skill) => (
                  <li key={skill.id}>
                     <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent"
                        onMouseDown={(event) => {
                           event.preventDefault();
                           setDraft(`/${skill.name} `);
                           textareaRef.current?.focus();
                        }}
                     >
                        <span className="min-w-0 truncate">{skill.name}</span>
                     </button>
                  </li>
               ))}
            </ul>
         ) : null}

         {note ? (
            <p className="mt-1 text-muted-foreground">
               {t('note')} · {t('noteHint')}
            </p>
         ) : plan && (plan.targets.length > 0 || plan.refused.length > 0) ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
               <span className="text-muted-foreground">{t('triggerTitle')}</span>
               {plan.targets.map((target) => {
                  const off = skipped.includes(target.agentId);
                  return (
                     <button
                        key={target.agentId}
                        type="button"
                        aria-pressed={!off}
                        title={off ? t('restore') : t('skip')}
                        onClick={() =>
                           setSkipped((current) =>
                              off
                                 ? current.filter((id) => id !== target.agentId)
                                 : [...current, target.agentId]
                           )
                        }
                        className={cn(
                           'rounded-full border px-2 py-0.5',
                           off
                              ? 'border-border/60 text-muted-foreground line-through'
                              : 'border-status-info text-status-info'
                        )}
                     >
                        {target.agentName}
                        {off ? ` · ${t('skipped')}` : ''}
                     </button>
                  );
               })}
               {plan.refused.map((entry) => (
                  <span
                     key={entry.agentId}
                     title={t('blockedReason')}
                     className="rounded-full border border-status-danger/50 px-2 py-0.5 text-status-danger"
                  >
                     {entry.agentName} · {t('blockedReason')}
                  </span>
               ))}
            </div>
         ) : null}

         <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('attach')}
                  onClick={() => filePicker.current?.click()}
               >
                  {uploading > 0 ? (
                     <Loader2 className="size-4 animate-spin" />
                  ) : (
                     <Paperclip className="size-4" />
                  )}
               </Button>
               <input
                  ref={filePicker}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => void upload(event.target.files)}
               />
               {!isReply && draft.trim() ? (
                  <span className="text-muted-foreground">{t('draft')}</span>
               ) : null}
            </div>
            <Button size="xs" onClick={send} disabled={!draft.trim() || sending || uploading > 0}>
               {sending ? t('sending') : t('send')}
            </Button>
         </div>
      </div>
   );
}

/** Every agent or squad id named in the text. */
function collectMentionIds(body: string): string[] {
   return splitMentions(body).flatMap((part) => ('text' in part ? [] : [part.mention.id]));
}
