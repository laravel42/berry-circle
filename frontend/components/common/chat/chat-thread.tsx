'use client';

import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/lib/chat';

interface ChatThreadProps {
   messages: ChatMessage[];
   agentName: string | null;
   /** Shown at the top when older messages can be loaded. */
   onLoadEarlier?: (() => void) | null;
   /** Opens the steps of the task a reply came from. */
   onViewSteps: (runId: string) => void;
}

function initial(name: string): string {
   return (name.trim()[0] ?? '?').toUpperCase();
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
   const sameDay = at.toDateString() === today.toDateString();
   return sameDay ? 'today' : at.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Message list, ported from `Berry Prototype.dc.html`.
 *
 * Day dividers are emitted on change rather than per message, which is what
 * makes them read as separators instead of decoration.
 */
export function ChatThread({ messages, agentName, onLoadEarlier, onViewSteps }: ChatThreadProps) {
   const endRef = useRef<HTMLDivElement>(null);
   const lastId = messages.at(-1)?.id;

   // A new turn should be visible without scrolling; a reply arrives when its
   // task ends, so the reader is rarely looking at the bottom when it lands.
   // Keyed on the newest message, so loading earlier history does not jump.
   useEffect(() => {
      endRef.current?.scrollIntoView({ block: 'end' });
   }, [lastId]);

   let lastDay = '';

   return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
         {onLoadEarlier ? (
            <button
               type="button"
               onClick={onLoadEarlier}
               className="self-center text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
            >
               Load earlier
            </button>
         ) : null}

         {messages.length === 0 ? (
            <p className="text-[var(--shell-text-dim)]">
               {agentName
                  ? `Say something to ${agentName}. Every task it runs uses the instructions on its profile.`
                  : 'Pick an agent to start a conversation.'}
            </p>
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

                  <article className="flex gap-3">
                     <span
                        className={[
                           'mt-0.5 flex size-6 flex-none items-center justify-center rounded',
                           isAgent
                              ? 'bg-[color-mix(in_srgb,var(--shell-accent)_28%,transparent)] text-[var(--shell-text)]'
                              : 'bg-[var(--shell-line)] text-[var(--shell-text-muted)]',
                        ].join(' ')}
                        aria-hidden="true"
                     >
                        {initial(message.authorName)}
                     </span>
                     <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex items-baseline gap-2">
                           <span className="text-[var(--shell-text)]">{message.authorName}</span>
                           {isAgent ? (
                              <span className="rounded-sm bg-[var(--shell-line)] px-1.5 text-[var(--shell-text-dim)]">
                                 agent
                              </span>
                           ) : null}
                           <span className="text-[var(--shell-text-dim)] tabular-nums">
                              {clockTime(message.createdAt)}
                           </span>
                           {isAgent && message.runId ? (
                              <button
                                 type="button"
                                 onClick={() => onViewSteps(message.runId as string)}
                                 className="text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
                              >
                                 View steps
                              </button>
                           ) : null}
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[var(--shell-text-muted)]">
                           {message.body}
                        </p>
                     </div>
                  </article>
               </div>
            );
         })}

         <div ref={endRef} />
      </div>
   );
}
