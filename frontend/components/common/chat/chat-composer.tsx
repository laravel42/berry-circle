'use client';

import { useEffect, useRef, useState } from 'react';
import { SendHorizonal, Square } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { searchWorkspace, type SearchResult } from '@/lib/search';

interface ChatComposerProps {
   value: string;
   onChange: (value: string) => void;
   onSend: () => void;
   /** Stop the reply that is running; absent when nothing is. */
   onStop: (() => void) | null;
   /** True while a reply is running: a send then queues behind it. */
   queueing: boolean;
   disabled: boolean;
   placeholder: string;
   workspaceId: string | undefined;
}

/** `@` immediately before the caret, with whatever has been typed since. */
const MENTION = /(?:^|\s)@([\w-]{0,40})$/;

/**
 * The message box.
 *
 * Enter sends and Shift+Enter breaks the line, which is the convention every
 * chat shares and the one thing people do without looking. Typing `@` searches
 * the workspace's issues and projects and inserts the identifier, so a message
 * can name a piece of work in the terms the rest of Berry uses.
 */
export function ChatComposer({
   value,
   onChange,
   onSend,
   onStop,
   queueing,
   disabled,
   placeholder,
   workspaceId,
}: ChatComposerProps) {
   const t = useTranslations('agentsChat.chat');
   const input = useRef<HTMLTextAreaElement>(null);
   const [query, setQuery] = useState<string | null>(null);
   const [results, setResults] = useState<SearchResult[]>([]);
   const [highlighted, setHighlighted] = useState(0);

   // Debounced: every keystroke inside a mention would otherwise be a search.
   useEffect(() => {
      if (query === null || !workspaceId) {
         setResults([]);
         return;
      }
      let cancelled = false;
      const timer = setTimeout(() => {
         void searchWorkspace(workspaceId, query, ['issue', 'project']).then((found) => {
            if (!cancelled) {
               setResults(found.slice(0, 6));
               setHighlighted(0);
            }
         });
      }, 150);
      return () => {
         cancelled = true;
         clearTimeout(timer);
      };
   }, [query, workspaceId]);

   const syncMention = (text: string, caret: number) => {
      const match = MENTION.exec(text.slice(0, caret));
      setQuery(match ? (match[1] ?? '') : null);
   };

   const insert = (result: SearchResult) => {
      const element = input.current;
      const caret = element?.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const match = MENTION.exec(before);
      if (!match) return;
      // Issues are referred to by identifier everywhere else in Berry; a
      // project has no identifier, so its name is what names it.
      const token = result.identifier ?? result.title;
      const start = before.length - (match[1]?.length ?? 0) - 1;
      const next = `${value.slice(0, start)}${token} ${value.slice(caret)}`;
      onChange(next);
      setQuery(null);
      setResults([]);
      requestAnimationFrame(() => {
         element?.focus();
         const at = start + token.length + 1;
         element?.setSelectionRange(at, at);
      });
   };

   const open = query !== null && results.length > 0;

   return (
      <div className="relative flex-none border-t border-[var(--shell-line)]">
         {open ? (
            <ul className="absolute bottom-full left-6 z-10 mb-2 w-80 overflow-hidden rounded-md border border-[var(--shell-line)] bg-[var(--shell-surface)] shadow-lg">
               {results.map((result, index) => (
                  <li key={`${result.type}-${result.id}`}>
                     <button
                        type="button"
                        onMouseDown={(event) => {
                           // Mouse-down, not click: the textarea must not lose
                           // focus before the insertion happens.
                           event.preventDefault();
                           insert(result);
                        }}
                        className={[
                           'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                           index === highlighted
                              ? 'bg-[var(--shell-hover)] text-[var(--shell-text)]'
                              : 'text-[var(--shell-text-muted)]',
                        ].join(' ')}
                     >
                        <span className="flex-none text-[var(--shell-text-dim)]">
                           {result.type === 'issue' ? t('mentionIssues') : t('mentionProjects')}
                        </span>
                        <span className="min-w-0 truncate">
                           {result.identifier ? `${result.identifier} ` : ''}
                           {result.title}
                        </span>
                     </button>
                  </li>
               ))}
            </ul>
         ) : null}

         <form
            className="flex items-end gap-2 px-6 py-3"
            onSubmit={(event) => {
               event.preventDefault();
               onSend();
            }}
         >
            <textarea
               ref={input}
               rows={1}
               value={value}
               disabled={disabled}
               placeholder={placeholder}
               aria-label={placeholder}
               onChange={(event) => {
                  onChange(event.target.value);
                  syncMention(event.target.value, event.target.selectionStart ?? 0);
               }}
               onKeyDown={(event) => {
                  if (open) {
                     if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setHighlighted((current) => (current + 1) % results.length);
                        return;
                     }
                     if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setHighlighted(
                           (current) => (current - 1 + results.length) % results.length
                        );
                        return;
                     }
                     if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault();
                        const picked = results[highlighted];
                        if (picked) insert(picked);
                        return;
                     }
                     if (event.key === 'Escape') {
                        setQuery(null);
                        return;
                     }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                     event.preventDefault();
                     onSend();
                  }
               }}
               className="max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-[var(--shell-text)] outline-none [--input-color:var(--shell-text)] [--placeholder-color:var(--shell-text-dim)] placeholder:text-[var(--shell-text-dim)] disabled:cursor-not-allowed"
            />

            {onStop ? (
               <button
                  type="button"
                  onClick={onStop}
                  className="flex flex-none cursor-pointer items-center gap-1.5 rounded-[5px] bg-[var(--shell-line)] px-2.5 py-1 text-[var(--shell-text-muted)] transition-colors hover:bg-[var(--shell-line-strong)] hover:text-[var(--shell-text)]"
               >
                  <Square className="size-3.5" />
                  {t('stopReply')}
               </button>
            ) : null}

            <button
               type="submit"
               disabled={disabled || value.trim() === ''}
               className="flex flex-none cursor-pointer items-center gap-1.5 rounded-[5px] bg-[var(--shell-line)] px-2.5 py-1 text-[var(--shell-text-muted)] transition-colors hover:bg-[var(--shell-line-strong)] hover:text-[var(--shell-text)] disabled:cursor-not-allowed disabled:opacity-40"
            >
               <SendHorizonal className="size-3.5" />
               {queueing ? t('queue') : t('send')}
            </button>
         </form>
      </div>
   );
}
