'use client';

import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { status as STATUSES, type Status } from '@/data/status';
import type { Issue } from '@/data/issues';
import type { User } from '@/data/users';
import { agentToUser } from '@/lib/agents';
import { apiStatusFromUi } from '@/lib/catalog';
import { createChild, loadChildren, setParent } from '@/lib/issue-tracking';
import { assigneeToApi, patchBoardIssue } from '@/lib/issues';
import { searchWorkspace } from '@/lib/search';
import { renderStatusIcon } from '@/lib/status-utils';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useIssueViewStore } from '@/store/issue-view-store';
import { useMembersStore } from '@/store/members-store';
import { useSessionStore } from '@/store/session-store';
import { ChevronDown, ChevronRight, Link2, Plus, UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * The tasks under this one.
 *
 * Grouped by stage rather than listed flat, because a stage is a barrier:
 * everything in stage 1 has to finish before stage 2 starts, and a flat list
 * hides the one fact that explains why nothing is moving. The whole block
 * folds away and stays folded, per task — a parent with thirty children is a
 * wall of text between the description and the discussion.
 */

/** Children, plus every task under them: what a new sub-task may not be. */
async function descendantIdentifiers(rootRef: string): Promise<Set<string>> {
   const seen = new Set<string>();
   const queue = [rootRef];
   // Bounded: a cycle cannot exist server-side, but a deep tree should not
   // turn a picker into a crawl of the whole board either.
   for (let visited = 0; queue.length > 0 && visited < 50; visited += 1) {
      const next = queue.shift();
      if (!next) break;
      const loaded = await loadChildren(next).catch(() => null);
      if (!loaded) continue;
      for (const child of loaded.nodes) {
         if (seen.has(child.identifier)) continue;
         seen.add(child.identifier);
         seen.add(child.id);
         queue.push(child.identifier);
      }
   }
   return seen;
}

function StatusCell({ child, onChanged }: { child: Issue; onChanged: (next: Issue) => void }) {
   const t = useTranslations('issueDetail.properties');
   const [open, setOpen] = useState(false);

   const choose = (next: Status) => {
      setOpen(false);
      if (next.id === child.status.id) return;
      const previous = child.status;
      onChanged({ ...child, status: next });
      void patchBoardIssue(child.id, { status: apiStatusFromUi(next.id) }).catch(() => {
         onChanged({ ...child, status: previous });
         toast.error(t('saveFailed'));
      });
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               variant="ghost"
               size="icon"
               className="size-6 shrink-0"
               aria-label={`${t('status')}: ${child.status.name}`}
            >
               {renderStatusIcon(child.status.id)}
            </Button>
         </PopoverTrigger>
         <PopoverContent align="start" className="w-48 p-0">
            <Command>
               <CommandList>
                  <CommandGroup>
                     {STATUSES.map((entry) => (
                        <CommandItem key={entry.id} value={entry.id} onSelect={() => choose(entry)}>
                           <span className="mr-2">{renderStatusIcon(entry.id)}</span>
                           {entry.name}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}

function AssigneeCell({ child, onChanged }: { child: Issue; onChanged: (next: Issue) => void }) {
   const t = useTranslations('issueDetail.properties');
   const members = useMembersStore((state) => state.members);
   const agents = useAgentsStore((state) => state.agents);

   const pick = (person: User | null) => {
      const previous = child.assignee;
      onChanged({ ...child, assignee: person });
      void patchBoardIssue(child.id, { assignee: assigneeToApi(person) }).catch(() => {
         onChanged({ ...child, assignee: previous });
         toast.error(t('saveFailed'));
      });
   };

   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button
               variant="ghost"
               size="xs"
               className="h-6 max-w-[120px] shrink-0 justify-start px-1 text-muted-foreground"
               aria-label={t('assignee')}
            >
               {child.assignee ? (
                  <span className="truncate">{child.assignee.name}</span>
               ) : (
                  <UserRound className="size-3.5" />
               )}
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
            <DropdownMenuItem onClick={() => pick(null)}>{t('assign')}</DropdownMenuItem>
            {members.map((member) => (
               <DropdownMenuItem key={member.id} onClick={() => pick(member)}>
                  {member.name}
               </DropdownMenuItem>
            ))}
            {agents
               .filter((agent) => !agent.archivedAt)
               .map((agent) => (
                  <DropdownMenuItem key={agent.id} onClick={() => pick(agentToUser(agent))}>
                     {agent.name}
                  </DropdownMenuItem>
               ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

/** Attach a task that already exists, by search. */
function AttachExisting({ parentRef, onAttached }: { parentRef: string; onAttached: () => void }) {
   const t = useTranslations('issueDetail.subIssues');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState('');
   const [results, setResults] = useState<Array<{ id: string; identifier: string; title: string }>>(
      []
   );
   const [searching, setSearching] = useState(false);
   const excluded = useRef<Set<string>>(new Set());

   useEffect(() => {
      if (!open) return;
      let cancelled = false;
      void descendantIdentifiers(parentRef).then((found) => {
         if (cancelled) return;
         found.add(parentRef);
         excluded.current = found;
      });
      return () => {
         cancelled = true;
      };
   }, [open, parentRef]);

   // Debounced: one request per pause in typing, not one per keystroke.
   useEffect(() => {
      if (!open || !workspaceId || query.trim().length === 0) {
         setResults([]);
         return;
      }
      let cancelled = false;
      setSearching(true);
      const timer = setTimeout(() => {
         void searchWorkspace(workspaceId, query, ['issue'])
            .then((found) => {
               if (cancelled) return;
               setResults(
                  found
                     .filter((entry) => !excluded.current.has(entry.identifier ?? entry.id))
                     .filter((entry) => !excluded.current.has(entry.id))
                     .map((entry) => ({
                        id: entry.id,
                        identifier: entry.identifier ?? entry.id,
                        title: entry.title,
                     }))
               );
            })
            .finally(() => {
               if (!cancelled) setSearching(false);
            });
      }, 250);
      return () => {
         cancelled = true;
         clearTimeout(timer);
      };
   }, [open, query, workspaceId]);

   const attach = (entry: { identifier: string }) => {
      setOpen(false);
      setQuery('');
      void setParent(entry.identifier, parentRef, null).then(
         () => {
            toast.success(t('attached', { identifier: entry.identifier }));
            onAttached();
         },
         () => toast.error(t('attachFailed'))
      );
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button variant="ghost" size="xs">
               <Link2 className="mr-1 size-3.5" />
               {t('attachTitle')}
            </Button>
         </PopoverTrigger>
         <PopoverContent align="start" className="w-80 p-2">
            <Input
               autoFocus
               value={query}
               placeholder={t('attachPlaceholder')}
               className="h-8"
               onChange={(event) => setQuery(event.target.value)}
            />
            <div className="mt-2 max-h-56 overflow-y-auto">
               {searching ? (
                  <p className="px-1 py-2 text-muted-foreground">{t('searching')}</p>
               ) : results.length === 0 ? (
                  query.trim() ? (
                     <p className="px-1 py-2 text-muted-foreground">{t('noMatches')}</p>
                  ) : null
               ) : (
                  <ul className="flex flex-col">
                     {results.map((entry) => (
                        <li key={entry.id}>
                           <button
                              type="button"
                              onClick={() => attach(entry)}
                              className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-accent"
                           >
                              <span className="shrink-0 text-muted-foreground">
                                 {entry.identifier}
                              </span>
                              <span className="min-w-0 truncate">{entry.title}</span>
                           </button>
                        </li>
                     ))}
                  </ul>
               )}
            </div>
         </PopoverContent>
      </Popover>
   );
}

export function SubIssues({ issue }: { issue: Issue }) {
   const t = useTranslations('issueDetail.subIssues');
   const { orgId } = useParams<{ orgId: string }>();
   const collapsedByIssue = useIssueViewStore((state) => state.collapsedSubIssues);
   const setCollapsed = useIssueViewStore((state) => state.setSubIssuesCollapsed);
   const collapsed = collapsedByIssue[issue.identifier] ?? false;

   const [children, setChildren] = useState<Issue[]>([]);
   const [progress, setProgress] = useState({ total: 0, done: 0 });
   const [title, setTitle] = useState('');
   const [stage, setStage] = useState('');
   const [adding, setAdding] = useState(false);

   const reload = useCallback(() => {
      void loadChildren(issue.identifier)
         .then((loaded) => {
            setChildren(loaded.nodes);
            setProgress(loaded.progress);
         })
         .catch(() => undefined);
   }, [issue.identifier]);
   useEffect(reload, [reload]);

   const groups = useMemo(() => {
      const byStage = new Map<number | null, Issue[]>();
      for (const child of children) {
         const key = child.stage ?? null;
         byStage.set(key, [...(byStage.get(key) ?? []), child]);
      }
      return [...byStage.entries()].sort((left, right) => {
         if (left[0] === null) return 1;
         if (right[0] === null) return -1;
         return left[0] - right[0];
      });
   }, [children]);

   const add = () => {
      const text = title.trim();
      if (!text || adding) return;
      setAdding(true);
      void createChild(issue.identifier, {
         title: text,
         stage: stage === '' ? null : Number(stage),
      })
         .then(() => {
            setTitle('');
            reload();
         })
         .catch(() => toast.error(t('createFailed')))
         .finally(() => setAdding(false));
   };

   const replaceChild = (next: Issue) =>
      setChildren((current) => current.map((child) => (child.id === next.id ? next : child)));

   return (
      <section className="mt-6 flex flex-col gap-2">
         <div className="flex items-center gap-2">
            <Button
               variant="ghost"
               size="xs"
               className="-ml-2"
               aria-expanded={!collapsed}
               onClick={() => setCollapsed(issue.identifier, !collapsed)}
            >
               {collapsed ? (
                  <ChevronRight className="mr-1 size-3.5" />
               ) : (
                  <ChevronDown className="mr-1 size-3.5" />
               )}
               <span className="font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                  {t('title')}
               </span>
            </Button>
            {progress.total > 0 ? (
               <span className="text-muted-foreground">
                  {t('progress', { done: progress.done, total: progress.total })}
               </span>
            ) : null}
         </div>

         {progress.total > 0 ? <Progress value={(progress.done / progress.total) * 100} /> : null}

         {collapsed ? null : (
            <>
               {groups.length === 0 ? (
                  <p className="text-muted-foreground">{t('empty')}</p>
               ) : (
                  groups.map(([stageKey, entries]) => (
                     <div key={stageKey ?? 'none'} className="flex flex-col">
                        <div className="pb-0.5 text-muted-foreground">
                           {stageKey === null ? t('noStage') : t('stage', { stage: stageKey })}
                        </div>
                        <ul className="flex flex-col">
                           {entries.map((child) => (
                              <li
                                 key={child.id}
                                 className={cn(
                                    'flex min-w-0 items-center gap-2 border-b border-border/40 py-1 last:border-b-0'
                                 )}
                              >
                                 <StatusCell child={child} onChanged={replaceChild} />
                                 <span className="shrink-0 text-muted-foreground">
                                    {child.identifier}
                                 </span>
                                 <Link
                                    className="min-w-0 flex-1 truncate hover:underline"
                                    href={`/${orgId}/issue/${child.identifier}`}
                                 >
                                    {child.title}
                                 </Link>
                                 <AssigneeCell child={child} onChanged={replaceChild} />
                              </li>
                           ))}
                        </ul>
                     </div>
                  ))
               )}

               <div className="flex flex-wrap items-center gap-2">
                  <Input
                     className="h-8 min-w-[180px] flex-1"
                     placeholder={t('addPlaceholder')}
                     value={title}
                     onChange={(event) => setTitle(event.target.value)}
                     onKeyDown={(event) => event.key === 'Enter' && add()}
                  />
                  <Input
                     className="h-8 w-20"
                     type="number"
                     min={0}
                     placeholder={t('stagePlaceholder')}
                     value={stage}
                     onChange={(event) => setStage(event.target.value)}
                  />
                  <Button size="xs" disabled={!title.trim() || adding} onClick={add}>
                     <Plus className="mr-1 size-3.5" />
                     {t('add')}
                  </Button>
                  <AttachExisting parentRef={issue.identifier} onAttached={reload} />
               </div>
            </>
         )}
      </section>
   );
}
