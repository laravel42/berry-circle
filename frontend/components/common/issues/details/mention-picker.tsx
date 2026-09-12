'use client';

import {
   useCallback,
   useEffect,
   useMemo,
   useState,
   type KeyboardEvent,
   type RefObject,
} from 'react';
import { useTranslations } from 'next-intl';

import { loadWorkspaceAgents } from '@/lib/agents';
import { mentionToken } from '@/lib/comments';
import { loadWorkspaceMembers } from '@/lib/members';
import { searchWorkspace } from '@/lib/search';
import { listSquads } from '@/lib/squads';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/store/session-store';

/**
 * Mentioning something from the composer.
 *
 * Six kinds of thing can be named in a comment and they are not
 * interchangeable: mentioning an agent starts work, mentioning a person
 * notifies them, naming a task or a project is a cross-reference. So the list
 * is grouped and each group is labelled — an ungrouped list of forty names
 * makes "who am I about to set off" a guess.
 *
 * Only agents and squads become mention *tokens*, because only they mean
 * anything to the server. People, tasks and projects are inserted as plain
 * text, which is what they are.
 */

type CandidateKind = 'member' | 'agent' | 'squad' | 'all' | 'issue' | 'project';

interface Candidate {
   kind: CandidateKind;
   id: string;
   name: string;
   /** Shown instead of the name when inserting, for tasks. */
   insert?: string;
   /** An agent that cannot run: offered, but not selectable. */
   disabled?: boolean;
   hint?: string;
}

function queryAt(value: string, caret: number): { start: number; query: string } | null {
   const before = value.slice(0, caret);
   const match = /(^|\s)@([\w-]{0,40})$/.exec(before);
   if (!match) return null;
   const query = match[2] ?? '';
   return { start: caret - query.length - 1, query };
}

interface UseMentionPicker {
   handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
   sync: () => void;
   list: React.ReactNode;
   /** True while the list is open, so the composer knows Enter is taken. */
   open: boolean;
}

export function useMentionPicker(
   textareaRef: RefObject<HTMLTextAreaElement | null>,
   value: string,
   onChange: (value: string) => void
): UseMentionPicker {
   const t = useTranslations('issueDetail.composer');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [candidates, setCandidates] = useState<Candidate[]>([]);
   const [found, setFound] = useState<Candidate[]>([]);
   const [loaded, setLoaded] = useState(false);
   const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
   const [highlight, setHighlight] = useState(0);

   // Loaded the first time a mention starts, not with every task page.
   useEffect(() => {
      if (!open || loaded) return;
      setLoaded(true);
      void Promise.all([
         loadWorkspaceAgents().catch(() => []),
         listSquads().catch(() => []),
         workspaceId ? loadWorkspaceMembers(workspaceId).catch(() => []) : Promise.resolve([]),
      ]).then(([agents, squads, members]) =>
         setCandidates([
            { kind: 'all', id: 'all', name: t('mentionAll'), hint: t('mentionAllHint') },
            ...members.map((member) => ({
               kind: 'member' as const,
               id: member.id,
               name: member.name,
            })),
            ...agents
               .filter((agent) => !agent.archivedAt)
               .map((agent) => ({ kind: 'agent' as const, id: agent.id, name: agent.name })),
            ...squads.map((squad) => ({
               kind: 'squad' as const,
               id: squad.id,
               name: squad.name,
            })),
         ])
      );
   }, [open, loaded, workspaceId, t]);

   // Tasks and projects are searched rather than listed: a workspace has
   // thousands of them, and the useful ones are the ones matching what has
   // been typed. People, agents and squads are few enough to hold in hand.
   useEffect(() => {
      const query = open?.query ?? '';
      if (!open || !workspaceId || query.length < 2) {
         setFound([]);
         return;
      }
      let cancelled = false;
      const timer = setTimeout(() => {
         void searchWorkspace(workspaceId, query, ['issue', 'project']).then((results) => {
            if (cancelled) return;
            setFound(
               results.slice(0, 8).map((result) => ({
                  kind: result.type === 'project' ? ('project' as const) : ('issue' as const),
                  id: result.id,
                  name:
                     result.type === 'project'
                        ? result.title
                        : `${result.identifier ?? ''} ${result.title}`.trim(),
                  insert: result.identifier ?? result.title,
               }))
            );
         });
      }, 250);
      return () => {
         cancelled = true;
         clearTimeout(timer);
      };
   }, [open, workspaceId]);

   const groups = useMemo(() => {
      if (!open) return [] as Array<{ kind: CandidateKind; label: string; items: Candidate[] }>;
      const query = open.query.toLowerCase();
      const pool = [...candidates, ...found].filter((candidate) =>
         candidate.name.toLowerCase().includes(query)
      );
      const order: Array<{ kind: CandidateKind; label: string }> = [
         { kind: 'all', label: t('groupMembers') },
         { kind: 'member', label: t('groupMembers') },
         { kind: 'agent', label: t('groupAgents') },
         { kind: 'squad', label: t('groupSquads') },
         { kind: 'issue', label: t('groupIssues') },
         { kind: 'project', label: t('groupProjects') },
      ];
      return order
         .map((group) => ({
            ...group,
            items: pool.filter((candidate) => candidate.kind === group.kind).slice(0, 6),
         }))
         .filter((group) => group.items.length > 0);
   }, [candidates, found, open, t]);

   const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

   const sync = useCallback(() => {
      const element = textareaRef.current;
      if (!element) return;
      const next = queryAt(element.value, element.selectionStart ?? element.value.length);
      setOpen(next);
      setHighlight(0);
   }, [textareaRef]);

   const choose = useCallback(
      (candidate: Candidate) => {
         if (!open || candidate.disabled) return;
         const element = textareaRef.current;
         const caret = element?.selectionStart ?? value.length;
         // Only agents and squads carry a token the server acts on. Everything
         // else is written as text, which is all it ever was.
         const inserted =
            candidate.kind === 'agent' || candidate.kind === 'squad'
               ? mentionToken(candidate.kind, candidate.id, candidate.name)
               : candidate.kind === 'issue'
                 ? (candidate.insert ?? candidate.name)
                 : `@${candidate.name}`;
         const token = `${inserted} `;
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
      if (!open || flat.length === 0) return false;
      if (event.key === 'ArrowDown') {
         event.preventDefault();
         setHighlight((current) => (current + 1) % flat.length);
         return true;
      }
      if (event.key === 'ArrowUp') {
         event.preventDefault();
         setHighlight((current) => (current - 1 + flat.length) % flat.length);
         return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
         event.preventDefault();
         const candidate = flat[highlight];
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

   let cursor = -1;
   const list =
      open && flat.length > 0 ? (
         <ul
            role="listbox"
            aria-label={t('mentionList')}
            className="z-20 mt-1 max-h-56 w-72 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
         >
            {groups.map((group, position) => (
               <li key={group.kind}>
                  {/* `all` and the members share a label; heading it twice in a
                      row reads as two separate People groups. */}
                  {position > 0 && groups[position - 1].label === group.label ? null : (
                     <div className="px-2 pt-1 pb-0.5 uppercase tracking-[0.12em] text-muted-foreground">
                        {group.label}
                     </div>
                  )}
                  <ul>
                     {group.items.map((candidate) => {
                        cursor += 1;
                        const index = cursor;
                        return (
                           <li
                              key={`${candidate.kind}:${candidate.id}`}
                              role="option"
                              aria-selected={index === highlight}
                              aria-disabled={candidate.disabled ? true : undefined}
                              className={cn(
                                 'flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1',
                                 index === highlight && 'bg-accent',
                                 candidate.disabled && 'cursor-not-allowed opacity-50'
                              )}
                              onMouseDown={(event) => {
                                 event.preventDefault();
                                 choose(candidate);
                              }}
                           >
                              <span className="min-w-0 truncate">{candidate.name}</span>
                              {candidate.hint ? (
                                 <span className="shrink-0 text-muted-foreground">
                                    {candidate.hint}
                                 </span>
                              ) : null}
                           </li>
                        );
                     })}
                  </ul>
               </li>
            ))}
         </ul>
      ) : null;

   return { handleKeyDown, sync, list, open: open !== null && flat.length > 0 };
}
