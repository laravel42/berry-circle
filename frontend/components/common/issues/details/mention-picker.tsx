'use client';

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';

import { loadWorkspaceAgents } from '@/lib/agents';
import { mentionToken } from '@/lib/comments';
import { listSquads } from '@/lib/squads';
import { cn } from '@/lib/utils';

interface Candidate {
   kind: 'agent' | 'squad';
   id: string;
   name: string;
}

/** The `@query` right before the caret, if the caret is in one. */
function queryAt(value: string, caret: number): { start: number; query: string } | null {
   const before = value.slice(0, caret);
   const match = /(^|\s)@([\w-]{0,40})$/.exec(before);
   if (!match) return null;
   const query = match[2] ?? '';
   return { start: caret - query.length - 1, query };
}

interface UseMentionPicker {
   /** Call from the textarea's onKeyDown first; returns true when the picker used the key. */
   handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
   /** Call after every change and caret move, so the picker follows the caret. */
   sync: () => void;
   list: React.ReactNode;
}

/**
 * Mentioning an agent or a squad in a comment.
 *
 * Typing `@` and a few letters offers matching agents and squads; choosing one
 * replaces `@query` with an explicit mention token, which is what the server
 * reads to decide which agents a comment starts.
 */
export function useMentionPicker(
   textareaRef: RefObject<HTMLTextAreaElement | null>,
   value: string,
   onChange: (value: string) => void
): UseMentionPicker {
   const [candidates, setCandidates] = useState<Candidate[]>([]);
   const [loaded, setLoaded] = useState(false);
   const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
   const [highlight, setHighlight] = useState(0);

   // Loaded the first time a mention starts, not with every issue page.
   useEffect(() => {
      if (!open || loaded) return;
      setLoaded(true);
      void Promise.all([loadWorkspaceAgents().catch(() => []), listSquads().catch(() => [])]).then(
         ([agents, squads]) =>
            setCandidates([
               ...agents
                  .filter((agent) => !agent.archivedAt)
                  .map((agent) => ({ kind: 'agent' as const, id: agent.id, name: agent.name })),
               ...squads.map((squad) => ({ kind: 'squad' as const, id: squad.id, name: squad.name })),
            ])
      );
   }, [open, loaded]);

   const matches = useMemo(() => {
      if (!open) return [];
      const query = open.query.toLowerCase();
      return candidates.filter((candidate) => candidate.name.toLowerCase().includes(query)).slice(0, 8);
   }, [candidates, open]);

   const sync = useCallback(() => {
      const element = textareaRef.current;
      if (!element) return;
      const next = queryAt(element.value, element.selectionStart ?? element.value.length);
      setOpen(next);
      setHighlight(0);
   }, [textareaRef]);

   const choose = useCallback(
      (candidate: Candidate) => {
         if (!open) return;
         const element = textareaRef.current;
         const caret = element?.selectionStart ?? value.length;
         const token = `${mentionToken(candidate.kind, candidate.id, candidate.name)} `;
         const next = value.slice(0, open.start) + token + value.slice(caret);
         onChange(next);
         setOpen(null);
         const position = open.start + token.length;
         requestAnimationFrame(() => {
            element?.focus();
            element?.setSelectionRange(position, position);
         });
      },
      [open, onChange, textareaRef, value]
   );

   const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || matches.length === 0) return false;
      if (event.key === 'ArrowDown') {
         event.preventDefault();
         setHighlight((current) => (current + 1) % matches.length);
         return true;
      }
      if (event.key === 'ArrowUp') {
         event.preventDefault();
         setHighlight((current) => (current - 1 + matches.length) % matches.length);
         return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
         event.preventDefault();
         const candidate = matches[highlight];
         if (candidate) choose(candidate);
         return true;
      }
      if (event.key === 'Escape') {
         event.preventDefault();
         setOpen(null);
         return true;
      }
      return false;
   };

   const list =
      open && matches.length > 0 ? (
         <ul
            role="listbox"
            aria-label="Mention an agent or squad"
            className="z-20 mt-1 max-h-56 w-72 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
         >
            {matches.map((candidate, index) => (
               <li
                  key={`${candidate.kind}:${candidate.id}`}
                  role="option"
                  aria-selected={index === highlight}
                  className={cn(
                     'flex cursor-pointer items-center justify-between rounded px-2 py-1',
                     index === highlight && 'bg-accent'
                  )}
                  onMouseDown={(event) => {
                     // Before the textarea loses focus, so the caret is still known.
                     event.preventDefault();
                     choose(candidate);
                  }}
               >
                  <span className="truncate">{candidate.name}</span>
                  <span className="text-muted-foreground">{candidate.kind}</span>
               </li>
            ))}
         </ul>
      ) : null;

   return { handleKeyDown, sync, list };
}
