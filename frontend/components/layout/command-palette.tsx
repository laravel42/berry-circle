'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { cycles, formatCycleDateRange } from '@/data/cycles';
import { Issue } from '@/data/issues';
import { useLabelsStore } from '@/store/labels-store';
import { useMembersStore } from '@/store/members-store';
import { priorities } from '@/data/priorities';
import { status as allStatus } from '@/data/status';
import { currentUser } from '@/data/users';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useCreateIssueStore } from '@/store/create-issue-store';
import { useNotificationsDrawerStore } from '@/store/notifications-drawer-store';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import {
   PALETTE_SEARCH_TYPES,
   searchResultHref,
   searchWorkspace,
   type SearchResult,
} from '@/lib/search';
import { useSessionStore } from '@/store/session-store';
import {
   Bot,
   Box,
   CalendarPlus,
   Check,
   CircleDot,
   Clipboard,
   ClipboardList,
   ClipboardType,
   Compass,
   FileText,
   GitBranch,
   Bell,
   Layers,
   Link2,
   MessageSquare,
   PackagePlus,
   ShieldCheck,
   Sparkles,
   SquarePen,
   Tags,
   Target,
   Type,
   UserRoundMinus,
   UserRoundPlus,
   Wrench,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

type PaletteRoute =
   'root' | 'assign' | 'status' | 'priority' | 'labels' | 'project' | 'cycle' | 'due-date';

/** Small keyboard hint chips on the right of a command row. */
function Keys({ keys }: { keys: string[] }) {
   return (
      <span className="ml-auto flex items-center gap-1">
         {keys.map((key, index) => (
            <kbd
               key={index}
               className="min-w-5 h-5 px-1 inline-flex items-center justify-center rounded border bg-muted/50 text-muted-foreground font-sans"
            >
               {key}
            </kbd>
         ))}
      </span>
   );
}

/** ⌘K command palette — Linear-style, aware of the issue in context. */
export function CommandPalette() {
   const [open, setOpen] = useState(false);
   const openNotifications = useNotificationsDrawerStore((state) => state.open);
   const [route, setRoute] = useState<PaletteRoute>('root');
   const [query, setQuery] = useState('');
   /** When true, the issue context chip was dismissed with ⌫. */
   const [contextCleared, setContextCleared] = useState(false);

   const pathname = usePathname();
   const router = useRouter();
   const {
      issues,
      updateIssueStatus,
      updateIssuePriority,
      updateIssueAssignee,
      addIssueLabel,
      removeIssueLabel,
      updateIssueProject,
      updateIssue,
   } = useIssuesStore();
   const { openModal } = useCreateIssueStore();
   const openPlanModal = useCreatePlanStore((state) => state.openModal);
   const allProjects = useProjectsStore((state) => state.projects);
   const members = useMembersStore((state) => state.members);
   const allLabels = useLabelsStore((state) => state.labels);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [results, setResults] = useState<SearchResult[]>([]);

   // Server search only from the root, and only once the query is worth a
   // round trip. Debounced so typing a word is one request, not five; the
   // `cancelled` flag drops an answer that arrives after a newer keystroke.
   useEffect(() => {
      const trimmed = query.trim();
      if (!open || route !== 'root' || !workspaceId || trimmed.length < 2) {
         setResults([]);
         return;
      }
      let cancelled = false;
      const timer = window.setTimeout(() => {
         void searchWorkspace(workspaceId, trimmed, PALETTE_SEARCH_TYPES).then((found) => {
            if (!cancelled) setResults(found);
         });
      }, 150);
      return () => {
         cancelled = true;
         window.clearTimeout(timer);
      };
   }, [open, route, query, workspaceId]);

   const resultIcon = (type: SearchResult['type']) => {
      switch (type) {
         case 'issue':
            return <CircleDot className="text-muted-foreground" />;
         case 'project':
            return <Box className="text-muted-foreground" />;
         case 'agent':
            return <Bot className="text-muted-foreground" />;
         case 'chat':
            return <MessageSquare className="text-muted-foreground" />;
         default:
            return <Wrench className="text-muted-foreground" />;
      }
   };

   const orgId = pathname.split('/')[1] || WORKSPACE_SLUG;

   const contextIssue = useMemo<Issue | undefined>(() => {
      const match = pathname.match(/^\/[^/]+\/issue\/([^/]+)/);
      if (!match) return undefined;
      return issues.find((issue) => issue.identifier === match[1]);
   }, [pathname, issues]);

   const issue = contextCleared ? undefined : contextIssue;

   const reset = useCallback(() => {
      setRoute('root');
      setQuery('');
      setContextCleared(false);
   }, []);

   const close = useCallback(() => {
      setOpen(false);
      reset();
   }, [reset]);

   // ⌘K / Ctrl+K
   useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
         if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            setOpen((value) => {
               if (value) reset();
               return !value;
            });
         }
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
   }, [reset]);

   const copy = useCallback(
      async (label: string, text: string) => {
         try {
            await navigator.clipboard.writeText(text);
            toast.success(`${label} copied to clipboard`);
         } catch {
            toast.error('Could not access the clipboard');
         }
         close();
      },
      [close]
   );

   const issueUrl = issue
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}/${orgId}/issue/${issue.identifier}`
      : '';
   const branchName = issue
      ? `${currentUser.id}/${issue.identifier.toLowerCase()}-${issue.title
           .toLowerCase()
           .replace(/[^a-z0-9]+/g, '-')
           .replace(/^-|-$/g, '')
           .slice(0, 40)}`
      : '';

   const go = (path: string) => {
      router.push(`/${orgId}${path}`);
      close();
   };

   const input = (
      <div className="relative">
         <CommandInput
            autoFocus
            placeholder="Type a command or search…"
            value={query}
            onValueChange={setQuery}
            onKeyDown={(event) => {
               if (event.key === 'Escape' && route !== 'root') {
                  event.preventDefault();
                  event.stopPropagation();
                  setRoute('root');
                  setQuery('');
               }
               if (event.key === 'Backspace' && query === '' && route !== 'root') {
                  setRoute('root');
               }
               if (event.key === 'Tab' && route === 'root') {
                  event.preventDefault();
                  go('/runs');
               }
            }}
         />
         {route === 'root' && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-muted-foreground pointer-events-none">
               open runtimes
               <kbd className="h-5 px-1.5 inline-flex items-center rounded border bg-muted/50 font-sans">
                  Tab
               </kbd>
            </span>
         )}
      </div>
   );

   return (
      <Dialog
         open={open}
         onOpenChange={(value) => {
            setOpen(value);
            if (!value) reset();
         }}
      >
         <DialogContent
            showCloseButton={false}
            className="overflow-hidden p-0 sm:max-w-2xl top-[22%] translate-y-0 gap-0"
         >
            <DialogTitle className="sr-only">Command menu</DialogTitle>
            <DialogDescription className="sr-only">Type a command or search</DialogDescription>
            <Command className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5">
               {issue && (
                  <div className="flex items-center gap-1.5 px-3 pt-3 pb-1">
                     <span className="inline-flex items-center gap-1.5 max-w-full rounded-md bg-muted/70 border border-border/60 px-2 py-1">
                        <span className="text-muted-foreground shrink-0">{issue.identifier} ⋅</span>
                        <span className="truncate">{issue.title}</span>
                        <button
                           tabIndex={-1}
                           onClick={() => setContextCleared(true)}
                           className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                           aria-label="Clear task context"
                        >
                           ⌫
                        </button>
                     </span>
                  </div>
               )}
               {input}
               <CommandList className="max-h-96">
                  <CommandEmpty>No results found.</CommandEmpty>

                  {route === 'root' && results.length > 0 && (
                     <CommandGroup heading="Search">
                        {results.map((result) => {
                           const href = searchResultHref(result);
                           if (!href) return null;
                           return (
                              <CommandItem
                                 key={`${result.type}-${result.id}`}
                                 value={`${result.type}-${result.id}`}
                                 // The server already matched; cmdk's own filter
                                 // would drop a hit whose title lacks the literal
                                 // query (an agent-name match on a chat thread).
                                 forceMount
                                 onSelect={() => go(href)}
                              >
                                 {resultIcon(result.type)}
                                 {result.identifier ? (
                                    <span className="text-muted-foreground shrink-0">
                                       {result.identifier}
                                    </span>
                                 ) : null}
                                 <span className="truncate">{result.title}</span>
                                 {result.subtitle ? (
                                    <span className="ml-auto truncate text-muted-foreground">
                                       {result.subtitle}
                                    </span>
                                 ) : null}
                              </CommandItem>
                           );
                        })}
                     </CommandGroup>
                  )}

                  {route === 'root' && issue && (
                     <>
                        <CommandGroup heading="Task">
                           <CommandItem
                              onSelect={() => {
                                 setRoute('assign');
                                 setQuery('');
                              }}
                           >
                              <UserRoundPlus className="text-muted-foreground" />
                              Assign to…
                              <Keys keys={['A']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 updateIssueAssignee(issue.id, null);
                                 toast.success('Un-assigned');
                                 close();
                              }}
                           >
                              <UserRoundMinus className="text-muted-foreground" />
                              Un-assign from me
                              <Keys keys={['I']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 setRoute('status');
                                 setQuery('');
                              }}
                           >
                              <CircleDot className="text-muted-foreground" />
                              Change status…
                              <Keys keys={['S']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 setRoute('priority');
                                 setQuery('');
                              }}
                           >
                              <Layers className="text-muted-foreground" />
                              Set priority…
                              <Keys keys={['P']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 setRoute('project');
                                 setQuery('');
                              }}
                           >
                              <Box className="text-muted-foreground" />
                              Move to project…
                              <Keys keys={['⇧', 'P']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 setRoute('labels');
                                 setQuery('');
                              }}
                           >
                              <Tags className="text-muted-foreground" />
                              Change or add labels…
                              <Keys keys={['L']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 setRoute('cycle');
                                 setQuery('');
                              }}
                           >
                              <CircleDot className="text-muted-foreground" />
                              Move to cycle…
                              <Keys keys={['⇧', 'C']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 toast.success('Added to the next release');
                                 close();
                              }}
                           >
                              <PackagePlus className="text-muted-foreground" />
                              Add to release…
                              <Keys keys={['⌥', 'R']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 setRoute('due-date');
                                 setQuery('');
                              }}
                           >
                              <CalendarPlus className="text-muted-foreground" />
                              Set due date…
                              <Keys keys={['⇧', 'D']} />
                           </CommandItem>
                        </CommandGroup>
                        <CommandGroup heading="Copy">
                           <CommandItem onSelect={() => copy('Task ID', issue.identifier)}>
                              <Clipboard className="text-muted-foreground" />
                              Copy task ID
                              <Keys keys={['⌘', '.']} />
                           </CommandItem>
                           <CommandItem onSelect={() => copy('Task URL', issueUrl)}>
                              <Link2 className="text-muted-foreground" />
                              Copy task URL
                              <Keys keys={['⌘', '⇧', ',']} />
                           </CommandItem>
                           <CommandItem onSelect={() => copy('Task title', issue.title)}>
                              <Type className="text-muted-foreground" />
                              Copy task title
                              <Keys keys={['⌘', '⇧', "'"]} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() =>
                                 copy(
                                    'Title link',
                                    `[${issue.identifier}: ${issue.title}](${issueUrl})`
                                 )
                              }
                           >
                              <Link2 className="text-muted-foreground" />
                              Copy title as link
                              <Keys keys={['⌘', 'C']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => copy('Description', issue.description || issue.title)}
                           >
                              <FileText className="text-muted-foreground" />
                              Copy task description as Markdown
                           </CommandItem>
                           <CommandItem
                              onSelect={() =>
                                 copy(
                                    'Task content',
                                    `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}\n\n- Status: ${issue.status.name}\n- Priority: ${issue.priority.name}\n- Assignee: ${issue.assignee?.name ?? 'Unassigned'}`
                                 )
                              }
                           >
                              <ClipboardType className="text-muted-foreground" />
                              Copy task content as Markdown
                              <Keys keys={['⌘', '⌥', 'C']} />
                           </CommandItem>
                           <CommandItem onSelect={() => copy('Branch name', branchName)}>
                              <GitBranch className="text-muted-foreground" />
                              Copy git branch name
                              <Keys keys={['⌘', '⇧', '.']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() =>
                                 copy(
                                    'Prompt',
                                    `Work on the following task.\n\nTask ${issue.identifier}: ${issue.title}\n${issue.description || ''}\nStatus: ${issue.status.name} — Priority: ${issue.priority.name}`
                                 )
                              }
                           >
                              <ClipboardList className="text-muted-foreground" />
                              Copy as prompt
                              <Keys keys={['⌘', '⌥', 'P']} />
                           </CommandItem>
                        </CommandGroup>
                     </>
                  )}

                  {route === 'root' && !issue && (
                     <>
                        <CommandGroup heading="Actions">
                           <CommandItem
                              onSelect={() => {
                                 openModal();
                                 close();
                              }}
                           >
                              <SquarePen className="text-muted-foreground" />
                              Create new task
                              <Keys keys={['C']} />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => {
                                 openPlanModal();
                                 close();
                              }}
                           >
                              <Sparkles className="text-muted-foreground" />
                              Plan something…
                              <Keys keys={['P']} />
                           </CommandItem>
                        </CommandGroup>
                        <CommandGroup heading="Go to">
                           <CommandItem
                              onSelect={() => {
                                 setOpen(false);
                                 openNotifications();
                              }}
                           >
                              <Bell className="text-muted-foreground" /> Notifications
                              <Keys keys={['G', 'I']} />
                           </CommandItem>
                           <CommandItem onSelect={() => go('/my-issues')}>
                              <ClipboardList className="text-muted-foreground" /> Tasks
                              <Keys keys={['G', 'M']} />
                           </CommandItem>
                           <CommandItem onSelect={() => go('/goals')}>
                              <Target className="text-muted-foreground" /> Goals
                              <Keys keys={['G', 'G']} />
                           </CommandItem>
                           <CommandItem onSelect={() => go('/approvals')}>
                              <ShieldCheck className="text-muted-foreground" /> Approvals
                              <Keys keys={['G', 'A']} />
                           </CommandItem>
                           <CommandItem onSelect={() => go('/reviews')}>
                              <GitBranch className="text-muted-foreground" /> Reviews
                           </CommandItem>
                           <CommandItem onSelect={() => go('/initiatives')}>
                              <Compass className="text-muted-foreground" /> Initiatives
                           </CommandItem>
                           <CommandItem onSelect={() => go('/projects')}>
                              <Box className="text-muted-foreground" /> Projects
                              <Keys keys={['G', 'P']} />
                           </CommandItem>
                           <CommandItem onSelect={() => go('/views')}>
                              <Layers className="text-muted-foreground" /> Views
                           </CommandItem>
                           <CommandItem onSelect={() => go('/agents')}>
                              <Sparkles className="text-muted-foreground" /> Agents
                           </CommandItem>
                           <CommandItem onSelect={() => go('/settings')}>
                              <FileText className="text-muted-foreground" /> Settings
                              <Keys keys={['G', 'S']} />
                           </CommandItem>
                        </CommandGroup>
                     </>
                  )}

                  {route === 'assign' && issue && (
                     <CommandGroup heading="Assign to…">
                        {members.slice(0, 12).map((user) => (
                           <CommandItem
                              key={user.id}
                              onSelect={() => {
                                 updateIssueAssignee(issue.id, user);
                                 toast.success(`Assigned to ${user.name}`);
                                 close();
                              }}
                           >
                              <Avatar className="size-5">
                                 <AvatarImage src={user.avatarUrl} alt={user.name} />
                                 <AvatarFallback>{user.name[0]}</AvatarFallback>
                              </Avatar>
                              {user.name}
                              {issue.assignee?.id === user.id && (
                                 <Check className="ml-auto size-4" />
                              )}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'status' && issue && (
                     <CommandGroup heading="Change status…">
                        {allStatus.map((candidate) => (
                           <CommandItem
                              key={candidate.id}
                              onSelect={() => {
                                 updateIssueStatus(issue.id, candidate);
                                 toast.success(`Status set to ${candidate.name}`);
                                 close();
                              }}
                           >
                              <candidate.icon />
                              {candidate.name}
                              {issue.status.id === candidate.id && (
                                 <Check className="ml-auto size-4" />
                              )}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'priority' && issue && (
                     <CommandGroup heading="Set priority…">
                        {priorities.map((candidate) => (
                           <CommandItem
                              key={candidate.id}
                              onSelect={() => {
                                 updateIssuePriority(issue.id, candidate);
                                 toast.success(`Priority set to ${candidate.name}`);
                                 close();
                              }}
                           >
                              <candidate.icon className="text-muted-foreground" />
                              {candidate.name}
                              {issue.priority.id === candidate.id && (
                                 <Check className="ml-auto size-4" />
                              )}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'labels' && issue && (
                     <CommandGroup heading="Change or add labels…">
                        {allLabels.map((label) => {
                           const active = issue.labels.some(
                              (candidate) => candidate.id === label.id
                           );
                           return (
                              <CommandItem
                                 key={label.id}
                                 onSelect={() => {
                                    if (active) removeIssueLabel(issue.id, label.id);
                                    else addIssueLabel(issue.id, label);
                                    toast.success(
                                       active
                                          ? `Label ${label.name} removed`
                                          : `Label ${label.name} added`
                                    );
                                 }}
                              >
                                 <span
                                    className="size-3 rounded-full"
                                    style={{ backgroundColor: label.color }}
                                 />
                                 {label.name}
                                 {active && <Check className="ml-auto size-4" />}
                              </CommandItem>
                           );
                        })}
                     </CommandGroup>
                  )}

                  {route === 'project' && issue && (
                     <CommandGroup heading="Move to project…">
                        <CommandItem
                           onSelect={() => {
                              updateIssueProject(issue.id, undefined);
                              toast.success('Removed from project');
                              close();
                           }}
                        >
                           <Box className="text-muted-foreground" />
                           No project
                        </CommandItem>
                        {allProjects.map((project) => (
                           <CommandItem
                              key={project.id}
                              onSelect={() => {
                                 updateIssueProject(issue.id, project);
                                 toast.success(`Moved to ${project.name}`);
                                 close();
                              }}
                           >
                              <project.icon className="text-muted-foreground" />
                              {project.name}
                              {issue.project?.id === project.id && (
                                 <Check className="ml-auto size-4" />
                              )}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'cycle' && issue && (
                     <CommandGroup heading="Move to cycle…">
                        <CommandItem
                           onSelect={() => {
                              updateIssue(issue.id, { cycleId: '' });
                              toast.success('Removed from cycle');
                              close();
                           }}
                        >
                           <CircleDot className="text-muted-foreground" />
                           No cycle
                        </CommandItem>
                        {cycles.slice(0, 6).map((cycle) => (
                           <CommandItem
                              key={cycle.id}
                              onSelect={() => {
                                 updateIssue(issue.id, { cycleId: cycle.id });
                                 toast.success(`Moved to ${cycle.name}`);
                                 close();
                              }}
                           >
                              <CircleDot className="text-muted-foreground" />
                              {cycle.name}
                              <span className="text-muted-foreground ml-2">
                                 {formatCycleDateRange(cycle)}
                              </span>
                              {issue.cycleId === cycle.id && <Check className="ml-auto size-4" />}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'due-date' && issue && (
                     <CommandGroup heading="Set due date…">
                        {(
                           [
                              ['Today', '2026-08-04'],
                              ['Tomorrow', '2026-08-05'],
                              ['End of this week', '2026-08-09'],
                              ['In one week', '2026-08-11'],
                           ] as const
                        ).map(([label, date]) => (
                           <CommandItem
                              key={label}
                              onSelect={() => {
                                 updateIssue(issue.id, { dueDate: date });
                                 toast.success(`Due date set to ${label.toLowerCase()}`);
                                 close();
                              }}
                           >
                              <CalendarPlus className="text-muted-foreground" />
                              {label}
                           </CommandItem>
                        ))}
                        <CommandItem
                           onSelect={() => {
                              updateIssue(issue.id, { dueDate: undefined });
                              toast.success('Due date cleared');
                              close();
                           }}
                        >
                           <CalendarPlus className="text-muted-foreground" />
                           Clear due date
                        </CommandItem>
                     </CommandGroup>
                  )}
               </CommandList>
            </Command>
         </DialogContent>
      </Dialog>
   );
}
