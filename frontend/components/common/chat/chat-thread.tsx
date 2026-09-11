'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { ChatMessage, ChatSuggestion, ChatTaskEvent } from '@/lib/chat';
import { formatRunDuration } from '@/lib/runs';
import { ChatMarkdown } from './chat-markdown';

interface ChatThreadProps {
   messages: ChatMessage[];
   agentName: string | null;
   /** The agent's own openers, offered only while the thread is empty. */
   starters: string[];
   suggestions: ChatSuggestion[];
   onUseSuggestion: (prompt: string) => void;
   onRegenerate: () => void;
   regenerating: boolean;
   hasEarlier: boolean;
   loadingEarlier: boolean;
   onLoadEarlier: () => void;
   /** Steps of a run, once they have been asked for. */
   stepsFor: (runId: string) => ChatTaskEvent[] | undefined;
   onRequestSteps: (runId: string) => void;
   /** What the running reply is doing right now; null when nothing is running. */
   stage: string | null;
}

function clockTime(iso: string): string {
   const at = new Date(iso);
   return Number.isNaN(at.getTime())
      ? ''
      : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso: string): string {
   const at = new Date(iso);
   if (Number.isNaN(at.getTime())) return '';
   const today = new Date();
   return at.toDateString() === today.toDateString()
      ? 'today'
      : at.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** A short, readable line for one step. */
function describe(event: ChatTaskEvent): string {
   const payload = event.payload;
   if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      for (const key of ['summary', 'message', 'text', 'tool', 'name']) {
         const value = record[key];
         if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 400);
      }
   }
   return '';
}

/** How long the run took, and whether it ended badly, from its own events. */
function outcome(events: ChatTaskEvent[]): { durationMs: number | null; failure: string | null } {
   if (events.length === 0) return { durationMs: null, failure: null };
   const first = new Date(events[0]!.occurredAt).getTime();
   const last = new Date(events[events.length - 1]!.occurredAt).getTime();
   const failedEvent = events.find((event) => /fail|error|cancel/i.test(event.type));
   return {
      durationMs:
         Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : null,
      failure: failedEvent ? describe(failedEvent) || failedEvent.type : null,
   };
}

function StepGroup({
   runId,
   events,
   onRequest,
}: {
   runId: string;
   events: ChatTaskEvent[] | undefined;
   onRequest: (runId: string) => void;
}) {
   const t = useTranslations('agentsChat.chat');
   const detail = useTranslations('agentsChat.detail');
   const [open, setOpen] = useState(false);
   const [showFailure, setShowFailure] = useState(false);

   const result = events ? outcome(events) : null;

   return (
      <div className="flex flex-col gap-1">
         <div className="flex flex-wrap items-center gap-3 text-[var(--shell-text-dim)]">
            <button
               type="button"
               aria-expanded={open}
               onClick={() => {
                  const next = !open;
                  setOpen(next);
                  // Asked for only when opened: a thread of thirty replies
                  // would otherwise fetch thirty event lists to draw a count.
                  if (next && !events) onRequest(runId);
               }}
               className="inline-flex items-center gap-1 hover:text-[var(--shell-text)]"
            >
               <ChevronRight
                  className={
                     open
                        ? 'size-3.5 rotate-90 transition-transform'
                        : 'size-3.5 transition-transform'
                  }
                  aria-hidden
               />
               {events ? t('msgSteps', { count: events.length }) : detail('activityTranscript')}
            </button>
            {result?.durationMs !== null && result?.durationMs !== undefined ? (
               <span>{t('msgDuration', { duration: formatRunDuration(result.durationMs) })}</span>
            ) : null}
            {result?.failure ? (
               <>
                  <span className="text-[var(--shell-accent)]">{t('msgFailed')}</span>
                  <button
                     type="button"
                     onClick={() => setShowFailure(!showFailure)}
                     className="hover:text-[var(--shell-text)]"
                  >
                     {t('msgDetails')}
                  </button>
               </>
            ) : null}
         </div>

         {showFailure && result?.failure ? (
            <p className="whitespace-pre-wrap break-words rounded-md bg-[var(--shell-line)] px-3 py-2 font-mono text-[var(--shell-text-dim)]">
               {result.failure}
            </p>
         ) : null}

         {open ? (
            <ol className="flex flex-col gap-1 border-l border-[var(--shell-line)] pl-3">
               {(events ?? []).map((event) => (
                  <li key={event.id} className="text-[var(--shell-text-dim)]">
                     <span className="font-mono">{event.type}</span>
                     {describe(event) ? <span> · {describe(event)}</span> : null}
                  </li>
               ))}
               {events && events.length === 0 ? (
                  <li className="text-[var(--shell-text-dim)]">{t('rowNoPreview')}</li>
               ) : null}
            </ol>
         ) : null}
      </div>
   );
}

/**
 * The messages of one conversation.
 *
 * Two scroll behaviours, which are easy to confuse: a new turn pins the view
 * to the bottom, and loading older messages must not move the view at all.
 * Both are handled here rather than by the parent, because only this component
 * knows where the scroll container actually is.
 */
export function ChatThread({
   messages,
   agentName,
   starters,
   suggestions,
   onUseSuggestion,
   onRegenerate,
   regenerating,
   hasEarlier,
   loadingEarlier,
   onLoadEarlier,
   stepsFor,
   onRequestSteps,
   stage,
}: ChatThreadProps) {
   const t = useTranslations('agentsChat.chat');
   const scroller = useRef<HTMLDivElement>(null);
   const endRef = useRef<HTMLDivElement>(null);
   const [copied, setCopied] = useState<string | null>(null);
   const lastId = messages.at(-1)?.id;

   // Kept across a prepend so the view can be restored to the same message.
   const anchor = useRef<{ height: number; top: number } | null>(null);
   const oldestId = messages[0]?.id;

   useEffect(() => {
      endRef.current?.scrollIntoView({ block: 'end' });
   }, [lastId]);

   useLayoutEffect(() => {
      const element = scroller.current;
      if (!element || !anchor.current) return;
      // Older messages were added above: put the reader back where they were,
      // which is the whole point of loading them without moving the page.
      element.scrollTop = element.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
   }, [oldestId]);

   const onScroll = () => {
      const element = scroller.current;
      if (!element || !hasEarlier || loadingEarlier) return;
      if (element.scrollTop > 48) return;
      anchor.current = { height: element.scrollHeight, top: element.scrollTop };
      onLoadEarlier();
   };

   const copy = async (message: ChatMessage) => {
      try {
         await navigator.clipboard.writeText(message.body);
         setCopied(message.id);
         setTimeout(() => setCopied(null), 1500);
      } catch {
         /* A clipboard the browser refuses is not worth an error toast. */
      }
   };

   let lastDay = '';

   return (
      <div
         ref={scroller}
         onScroll={onScroll}
         className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5"
      >
         {hasEarlier ? (
            <button
               type="button"
               onClick={onLoadEarlier}
               className="self-center text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
            >
               {t('loadEarlier')}
            </button>
         ) : null}

         {messages.length === 0 ? (
            <div className="flex flex-col gap-3">
               <p className="text-[var(--shell-text)]">
                  {agentName ? t('emptyTitle', { name: agentName }) : t('composerNoSession')}
               </p>
               <p className="text-[var(--shell-text-dim)]">{t('emptyBody')}</p>
               {starters.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                     {starters.map((starter) => (
                        <button
                           key={starter}
                           type="button"
                           onClick={() => onUseSuggestion(starter)}
                           className="rounded-[5px] bg-[var(--shell-line)] px-2.5 py-1 text-[var(--shell-text-muted)] hover:text-[var(--shell-text)]"
                        >
                           {starter}
                        </button>
                     ))}
                  </div>
               ) : null}
            </div>
         ) : null}

         {messages.map((message) => {
            const day = dayLabel(message.createdAt);
            const divider = day && day !== lastDay ? day : null;
            lastDay = day || lastDay;
            const isAgent = message.authorType === 'agent';

            return (
               <div key={message.id} className="flex flex-col gap-4">
                  {divider ? (
                     <div className="flex items-center gap-3 text-[var(--shell-text-dim)]">
                        <span className="h-px flex-1 bg-[var(--shell-line)]" />
                        {divider}
                        <span className="h-px flex-1 bg-[var(--shell-line)]" />
                     </div>
                  ) : null}

                  <article className="group flex gap-3">
                     <span
                        className={[
                           'mt-0.5 flex size-6 flex-none items-center justify-center rounded',
                           isAgent
                              ? 'bg-[color-mix(in_srgb,var(--shell-accent)_28%,transparent)] text-[var(--shell-text)]'
                              : 'bg-[var(--shell-line)] text-[var(--shell-text-muted)]',
                        ].join(' ')}
                        aria-hidden="true"
                     >
                        {(message.authorName.trim()[0] ?? '?').toUpperCase()}
                     </span>
                     <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex items-baseline gap-2">
                           <span className="text-[var(--shell-text)]">{message.authorName}</span>
                           <span className="tabular-nums text-[var(--shell-text-dim)]">
                              {clockTime(message.createdAt)}
                           </span>
                           <button
                              type="button"
                              onClick={() => void copy(message)}
                              aria-label={t('msgCopy')}
                              className="ml-auto text-[var(--shell-text-dim)] opacity-0 hover:text-[var(--shell-text)] focus-visible:opacity-100 group-hover:opacity-100"
                           >
                              {copied === message.id ? (
                                 <Check className="size-3.5" />
                              ) : (
                                 <Copy className="size-3.5" />
                              )}
                           </button>
                        </div>

                        <div className="text-[var(--shell-text-muted)]">
                           <ChatMarkdown body={message.body} />
                        </div>

                        {isAgent && message.runId ? (
                           <StepGroup
                              runId={message.runId}
                              events={stepsFor(message.runId)}
                              onRequest={onRequestSteps}
                           />
                        ) : null}
                     </div>
                  </article>
               </div>
            );
         })}

         {stage ? (
            <p className="flex items-center gap-2 text-[var(--shell-text-dim)]" role="status">
               <span className="size-1.5 rounded-full bg-[var(--shell-accent)] [animation:berrypulse_1.4s_ease-in-out_infinite] motion-reduce:animate-none" />
               {stage}
            </p>
         ) : null}

         {messages.length > 0 && suggestions.length > 0 && !stage ? (
            <div className="flex flex-wrap items-center gap-2">
               <span className="text-[var(--shell-text-dim)]">{t('followUps')}</span>
               {suggestions.map((suggestion) => (
                  <button
                     key={suggestion.label}
                     type="button"
                     onClick={() => onUseSuggestion(suggestion.prompt)}
                     className="rounded-[5px] bg-[var(--shell-line)] px-2.5 py-1 text-[var(--shell-text-muted)] hover:text-[var(--shell-text)]"
                  >
                     {suggestion.label}
                  </button>
               ))}
               <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={regenerating}
                  className="inline-flex items-center gap-1 text-[var(--shell-text-dim)] hover:text-[var(--shell-text)] disabled:opacity-50"
               >
                  <RefreshCw className={regenerating ? 'size-3.5 animate-spin' : 'size-3.5'} />
                  {t('regenerate')}
               </button>
            </div>
         ) : null}

         <div ref={endRef} />
      </div>
   );
}
