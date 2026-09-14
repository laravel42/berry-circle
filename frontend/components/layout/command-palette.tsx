'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
   Command,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Issue } from '@/data/issues';
import { useLabelsStore } from '@/store/labels-store';
import { useMembersStore } from '@/store/members-store';
import { priorities } from '@/data/priorities';
import { status as allStatus } from '@/data/status';
import { currentUser } from '@/data/users';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { WORKSPACE_SLUG } from '@/lib/config';
import { publishShellEvent } from '@/lib/shell-events';
import { formatCombo } from '@/lib/shortcuts';
import { useCreateIssueStore } from '@/store/create-issue-store';
import { useCreateProjectStore } from '@/store/create-project-store';
import { useNotificationsDrawerStore } from '@/store/notifications-drawer-store';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import { useRecentIssuesStore } from '@/store/recent-issues-store';
import {
   PALETTE_SEARCH_TYPES,
   highlightParts,
   isCancelledResult,
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
   ChevronsDownUp,
   ChevronsUpDown,
   CircleDot,
   Clipboard,
   ClipboardList,
   ClipboardType,
   FileText,
   GitBranch,
   Bell,
   Laptop,
   Layers,
   Link2,
   MessageSquare,
   Moon,
   Server,
   ShieldCheck,
   Sparkles,
   SquarePen,
   Sun,
   Tags,
   Target,
   Type,
   UserRoundMinus,
   UserRoundPlus,
   Users,
   Wrench,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

type PaletteRoute = 'root' | 'assign' | 'status' | 'priority' | 'labels' | 'project' | 'due-date';

/** How many recent tasks an empty query offers. */
const RECENT_LIMIT = 20;

/** How many results the server is asked for, and how many are shown. */
const SEARCH_LIMIT = 20;

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

/** A title with the matched run of characters marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
   const [before, hit, after] = highlightParts(text, query);
   if (!hit) return <>{text}</>;
   return (
      <>
         {before}
         <mark className="rounded-[2px] bg-primary/20 text-foreground">{hit}</mark>
         {after}
      </>
   );
}

/**
 * A page the palette can take you to.
 *
 * `keywords` is what makes this more than a list of links: someone typing
 * "inbox" should find notifications, and someone typing "team" should find
 * members, even though neither word is on the row.
 */
interface PalettePage {
   id: string;
   label: string;
   keywords: string[];
   icon: React.ElementType;
   /** Route under `/{orgId}`; absent for a page that is not a route. */
   href?: string;
   /** For the one destination that is a drawer rather than a page. */
   action?: 'notifications';
   keys?: string[];
}

const PAGES: PalettePage[] = [
   {
      id: 'notifications',
      label: 'Notifications',
      keywords: ['inbox', 'alerts', 'unread', 'bell'],
      icon: Bell,
      action: 'notifications',
      keys: ['G', 'I'],
   },
   {
      id: 'my-issues',
      label: 'Tasks',
      keywords: ['issues', 'my work', 'assigned', 'todo'],
      icon: ClipboardList,
      href: '/tasks',
      keys: ['G', 'M'],
   },
   {
      id: 'goals',
      label: 'Goals',
      keywords: ['objectives', 'outcomes', 'plans'],
      icon: Target,
      href: '/goals',
      keys: ['G', 'G'],
   },
   {
      id: 'approvals',
      label: 'Approvals',
      keywords: ['review requests', 'permission', 'gates'],
      icon: ShieldCheck,
      href: '/approvals',
      keys: ['G', 'A'],
   },
   {
      id: 'reviews',
      label: 'Reviews',
      keywords: ['pull requests', 'code review', 'diffs'],
      icon: GitBranch,
      href: '/reviews',
   },
   {
      id: 'chat',
      label: 'Chat',
      keywords: ['conversations', 'threads', 'messages', 'ask'],
      icon: MessageSquare,
      href: '/chat',
   },
   {
      id: 'projects',
      label: 'Projects',
      keywords: ['initiatives', 'workstreams'],
      icon: Box,
      href: '/projects',
      keys: ['G', 'P'],
   },
   {
      id: 'views',
      label: 'Views',
      keywords: ['saved searches', 'filters'],
      icon: Layers,
      href: '/views',
   },
   {
      id: 'agents',
      label: 'Agents',
      keywords: ['bots', 'workers', 'ai'],
      icon: Sparkles,
      href: '/agents',
   },
   {
      id: 'runtimes',
      label: 'Runtimes',
      keywords: ['runs', 'execution', 'machines', 'agentcore'],
      icon: Server,
      href: '/runtimes',
   },
   {
      id: 'members',
      label: 'Members',
      keywords: ['people', 'team', 'who'],
      icon: Users,
      href: '/members',
   },
   {
      id: 'settings',
      label: 'Settings',
      keywords: ['preferences', 'configuration', 'shortcuts'],
      icon: FileText,
      href: '/settings',
      keys: ['G', 'S'],
   },
];

/** Does a haystack of words contain the typed query? */
function matches(query: string, ...fields: string[]): boolean {
   const needle = query.trim().toLowerCase();
   if (!needle) return true;
   return fields.some((field) => field.toLowerCase().includes(needle));
}

/**
 * ⌘K command palette: where you are going, what you are looking for, and what
 * you want done, in one list.
 *
 * Filtering is ours rather than cmdk's (`shouldFilter={false}`). Half of what
 * is on screen was matched by the server, which knows about tasks this browser
 * has never loaded, and cmdk's filter would quietly drop those rows for not
 * containing the literal query. Doing it here also lets a page match on a word
 * that is not written on it, and lets cancelled tasks be grouped apart instead
 * of sitting among live ones.
 */
export function CommandPalette() {
   const t = useTranslations('navigation.palette');
   const [open, setOpen] = useState(false);
   const openNotifications = useNotificationsDrawerStore((state) => state.open);
   const [route, setRoute] = useState<PaletteRoute>('root');
   const [query, setQuery] = useState('');
   /** When true, the issue context chip was dismissed with ⌫. */
   const [contextCleared, setContextCleared] = useState(false);

   const pathname = usePathname();
   const router = useRouter();
   const { theme, setTheme } = useTheme();
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
   const openProjectModal = useCreateProjectStore((state) => state.openModal);
   const openPlanModal = useCreatePlanStore((state) => state.openModal);
   const allProjects = useProjectsStore((state) => state.projects);
   const members = useMembersStore((state) => state.members);
   const allLabels = useLabelsStore((state) => state.labels);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const recents = useRecentIssuesStore((state) => state.issues);
   const visitIssue = useRecentIssuesStore((state) => state.visit);
   const [results, setResults] = useState<SearchResult[]>([]);

   /**
    * Whether the command key was down when a row was chosen.
    *
    * cmdk's `onSelect` hands over no event, so the modifier is captured on the
    * way in — from the keydown that will become the selection, or from the
    * click itself — and read back when the row acts.
    */
   const modifierDown = useRef(false);

   const orgId = pathname.split('/')[1] || WORKSPACE_SLUG;

   const contextIssue = useMemo<Issue | undefined>(() => {
      const match = pathname.match(/^\/[^/]+\/issue\/([^/]+)/);
      if (!match) return undefined;
      return issues.find((issue) => issue.identifier === match[1]);
   }, [pathname, issues]);

   const issue = contextCleared ? undefined : contextIssue;

   // Visiting a task is what makes it recent. Recorded here because the
   // palette is the only thing that reads the list, and it already knows which
   // task the current route is about.
   useEffect(() => {
      if (!contextIssue) return;
      visitIssue({
         id: contextIssue.id,
         identifier: contextIssue.identifier,
         title: contextIssue.title,
      });
   }, [contextIssue, visitIssue]);

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
         void searchWorkspace(workspaceId, trimmed, PALETTE_SEARCH_TYPES, SEARCH_LIMIT).then(
            (found) => {
               if (!cancelled) setResults(found);
            }
         );
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

   const reset = useCallback(() => {
      setRoute('root');
      setQuery('');
      setContextCleared(false);
   }, []);

   const close = useCallback(() => {
      setOpen(false);
      reset();
   }, [reset]);

   // ⌘K / Ctrl+K, from wherever the focus happens to be — including a text
   // field, which is where someone usually is when they want it.
   useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
         if (event.isComposing || event.repeat) return;
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
            toast.success(t('copied', { label }));
         } catch {
            toast.error(t('copyFailed'));
         }
         close();
      },
      [close, t]
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

   /**
    * Open a destination. With the command key held it opens in a new tab and
    * the palette stays where it is, which is what makes ⌘-click and ⌘↵ worth
    * having: you are collecting pages, not leaving.
    */
   const go = useCallback(
      (path: string) => {
         const href = `/${orgId}${path}`;
         if (modifierDown.current) {
            modifierDown.current = false;
            window.open(href, '_blank', 'noopener');
            return;
         }
         router.push(href);
         close();
      },
      [orgId, router, close]
   );

   const trimmed = query.trim();
   const searching = trimmed.length > 0;

   const pages = useMemo(
      () => PAGES.filter((page) => matches(trimmed, page.label, ...page.keywords)),
      [trimmed]
   );

   // Members are matched here rather than at the server: the workspace's
   // people are already loaded, and a round trip to find a name that is
   // sitting in memory is a round trip nobody needs.
   const people = useMemo(
      () =>
         searching
            ? members.filter((member) => matches(trimmed, member.name, member.email)).slice(0, 8)
            : [],
      [searching, members, trimmed]
   );

   const localProjects = useMemo(
      () =>
         searching
            ? allProjects.filter((project) => matches(trimmed, project.name)).slice(0, 8)
            : [],
      [searching, allProjects, trimmed]
   );

   const liveResults = results.filter((result) => !isCancelledResult(result));
   const cancelledResults = results.filter(isCancelledResult);

   const recentIssues = useMemo(
      () => (searching ? [] : recents.slice(0, RECENT_LIMIT)),
      [searching, recents]
   );

   const newTabHint = formatCombo('mod+enter');

   const renderResult = (result: SearchResult) => {
      const href = searchResultHref(result);
      if (!href) return null;
      return (
         <CommandItem
            key={`${result.type}-${result.id}`}
            value={`${result.type}-${result.id}`}
            onSelect={() => go(href)}
            onClick={(event) => {
               if (event.metaKey || event.ctrlKey) modifierDown.current = true;
            }}
         >
            {resultIcon(result.type)}
            {result.identifier ? (
               <span className="text-muted-foreground shrink-0">{result.identifier}</span>
            ) : null}
            <span className="truncate">
               <Highlighted text={result.title} query={trimmed} />
            </span>
            {result.subtitle ? (
               <span className="ml-auto truncate text-muted-foreground">{result.subtitle}</span>
            ) : null}
         </CommandItem>
      );
   };

   const input = (
      <div className="relative">
         <CommandInput
            autoFocus
            placeholder={t('placeholder')}
            value={query}
            onValueChange={setQuery}
            onKeyDown={(event) => {
               modifierDown.current = event.metaKey || event.ctrlKey;
               if (event.key === 'Escape' && route !== 'root') {
                  event.preventDefault();
                  event.stopPropagation();
                  setRoute('root');
                  setQuery('');
               }
               if (event.key === 'Backspace' && query === '' && route !== 'root') {
                  setRoute('root');
               }
            }}
         />
         {route === 'root' && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-muted-foreground pointer-events-none">
               {t('newTabHint', { combo: newTabHint })}
            </span>
         )}
      </div>
   );

   const nothingToShow =
      route === 'root' &&
      pages.length === 0 &&
      people.length === 0 &&
      localProjects.length === 0 &&
      liveResults.length === 0 &&
      cancelledResults.length === 0 &&
      recentIssues.length === 0;

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
            <Command
               shouldFilter={false}
               className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5"
            >
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
                  {nothingToShow ? (
                     <div className="py-6 text-center text-muted-foreground">{t('noResults')}</div>
                  ) : null}

                  {route === 'root' && recentIssues.length > 0 && (
                     <CommandGroup heading={t('recents')}>
                        {recentIssues.map((recent) => (
                           <CommandItem
                              key={`recent-${recent.id}`}
                              value={`recent-${recent.id}`}
                              onSelect={() => go(`/issue/${recent.identifier}`)}
                              onClick={(event) => {
                                 if (event.metaKey || event.ctrlKey) modifierDown.current = true;
                              }}
                           >
                              <CircleDot className="text-muted-foreground" />
                              <span className="text-muted-foreground shrink-0">
                                 {recent.identifier}
                              </span>
                              <span className="truncate">{recent.title}</span>
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'root' && liveResults.length > 0 && (
                     <CommandGroup heading={t('issues')}>
                        {liveResults.map(renderResult)}
                     </CommandGroup>
                  )}

                  {/* Cancelled tasks answer the search, but they are not what
                      anyone means by "find me the task", so they sit apart. */}
                  {route === 'root' && cancelledResults.length > 0 && (
                     <CommandGroup heading={t('cancelledIssues')}>
                        {cancelledResults.map(renderResult)}
                     </CommandGroup>
                  )}

                  {route === 'root' && localProjects.length > 0 && (
                     <CommandGroup heading={t('projects')}>
                        {localProjects.map((project) => (
                           <CommandItem
                              key={`project-${project.id}`}
                              value={`project-${project.id}`}
                              onSelect={() => go(`/project/${project.id}/overview`)}
                              onClick={(event) => {
                                 if (event.metaKey || event.ctrlKey) modifierDown.current = true;
                              }}
                           >
                              <project.icon className="text-muted-foreground" />
                              <span className="truncate">
                                 <Highlighted text={project.name} query={trimmed} />
                              </span>
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'root' && people.length > 0 && (
                     <CommandGroup heading={t('members')}>
                        {people.map((member) => (
                           <CommandItem
                              key={`member-${member.id}`}
                              value={`member-${member.id}`}
                              onSelect={() => go(`/profiles/${member.id}`)}
                              onClick={(event) => {
                                 if (event.metaKey || event.ctrlKey) modifierDown.current = true;
                              }}
                           >
                              <Avatar className="size-5">
                                 <AvatarImage src={member.avatarUrl} alt={member.name} />
                                 <AvatarFallback>{member.name[0]}</AvatarFallback>
                              </Avatar>
                              <span className="truncate">
                                 <Highlighted text={member.name} query={trimmed} />
                              </span>
                              <span className="ml-auto truncate text-muted-foreground">
                                 {member.email}
                              </span>
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'root' && pages.length > 0 && (
                     <CommandGroup heading={t('pages')}>
                        {pages.map((page) => (
                           <CommandItem
                              key={page.id}
                              value={`page-${page.id}`}
                              onSelect={() => {
                                 if (page.action === 'notifications') {
                                    setOpen(false);
                                    openNotifications();
                                    return;
                                 }
                                 if (page.href) go(page.href);
                              }}
                              onClick={(event) => {
                                 if (event.metaKey || event.ctrlKey) modifierDown.current = true;
                              }}
                           >
                              <page.icon className="text-muted-foreground" />
                              <Highlighted text={page.label} query={trimmed} />
                              {page.keys ? <Keys keys={page.keys} /> : null}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  )}

                  {route === 'root' && (
                     <CommandGroup heading={t('commands')}>
                        {matches(trimmed, t('newIssue'), 'task', 'create') ? (
                           <CommandItem
                              value="command-new-issue"
                              onSelect={() => {
                                 openModal();
                                 close();
                              }}
                           >
                              <SquarePen className="text-muted-foreground" />
                              {t('newIssue')}
                              <Keys keys={['C']} />
                           </CommandItem>
                        ) : null}
                        {matches(trimmed, t('newProject'), 'project', 'create') ? (
                           <CommandItem
                              value="command-new-project"
                              onSelect={() => {
                                 openProjectModal();
                                 close();
                              }}
                           >
                              <Box className="text-muted-foreground" />
                              {t('newProject')}
                           </CommandItem>
                        ) : null}
                        {matches(trimmed, 'plan', 'planning') ? (
                           <CommandItem
                              value="command-plan"
                              onSelect={() => {
                                 openPlanModal();
                                 close();
                              }}
                           >
                              <Sparkles className="text-muted-foreground" />
                              Plan something…
                           </CommandItem>
                        ) : null}

                        {/* Theme: the three the product has, with the one in
                            force marked, so the row also answers "which am I
                            on?" without changing anything. */}
                        {(
                           [
                              ['light', t('themeLight'), Sun],
                              ['dark', t('themeDark'), Moon],
                              ['system', t('themeSystem'), Laptop],
                           ] as const
                        )
                           .filter(([, label]) => matches(trimmed, t('theme'), label, 'theme'))
                           .map(([id, label, Icon]) => (
                              <CommandItem
                                 key={`theme-${id}`}
                                 value={`theme-${id}`}
                                 onSelect={() => {
                                    setTheme(id);
                                    close();
                                 }}
                              >
                                 <Icon className="text-muted-foreground" />
                                 {label}
                                 {theme === id ? <Check className="ml-auto size-4" /> : null}
                              </CommandItem>
                           ))}

                        {issue && matches(trimmed, t('copyLink'), 'link', 'url') ? (
                           <CommandItem
                              value="command-copy-link"
                              onSelect={() => void copy(t('copyLink'), issueUrl)}
                           >
                              <Link2 className="text-muted-foreground" />
                              {t('copyLink')}
                              <Keys keys={['⌘', '⇧', ',']} />
                           </CommandItem>
                        ) : null}
                        {issue && matches(trimmed, t('copyIdentifier'), 'id', 'identifier') ? (
                           <CommandItem
                              value="command-copy-id"
                              onSelect={() => void copy(t('copyIdentifier'), issue.identifier)}
                           >
                              <Clipboard className="text-muted-foreground" />
                              {t('copyIdentifier')}
                              <Keys keys={['⌘', '.']} />
                           </CommandItem>
                        ) : null}
                        {/* Folding is not the palette's to do: it says so, and
                            whoever is rendering the comments decides what that
                            means. */}
                        {issue && matches(trimmed, t('foldComments'), 'comments', 'collapse') ? (
                           <CommandItem
                              value="command-fold-comments"
                              onSelect={() => {
                                 publishShellEvent('berry:comments-fold', { folded: true });
                                 close();
                              }}
                           >
                              <ChevronsDownUp className="text-muted-foreground" />
                              {t('foldComments')}
                           </CommandItem>
                        ) : null}
                        {issue && matches(trimmed, t('unfoldComments'), 'comments', 'expand') ? (
                           <CommandItem
                              value="command-unfold-comments"
                              onSelect={() => {
                                 publishShellEvent('berry:comments-fold', { folded: false });
                                 close();
                              }}
                           >
                              <ChevronsUpDown className="text-muted-foreground" />
                              {t('unfoldComments')}
                           </CommandItem>
                        ) : null}
                     </CommandGroup>
                  )}

                  {route === 'root' && issue && (
                     <>
                        <CommandGroup heading="Task">
                           <CommandItem
                              value="task-assign"
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
                              value="task-unassign"
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
                              value="task-status"
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
                              value="task-priority"
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
                              value="task-project"
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
                              value="task-labels"
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
                              value="task-due-date"
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
                           <CommandItem
                              value="copy-title"
                              onSelect={() => void copy('Task title', issue.title)}
                           >
                              <Type className="text-muted-foreground" />
                              Copy task title
                              <Keys keys={['⌘', '⇧', "'"]} />
                           </CommandItem>
                           <CommandItem
                              value="copy-title-link"
                              onSelect={() =>
                                 void copy(
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
                              value="copy-description"
                              onSelect={() =>
                                 void copy('Description', issue.description || issue.title)
                              }
                           >
                              <FileText className="text-muted-foreground" />
                              Copy task description as Markdown
                           </CommandItem>
                           <CommandItem
                              value="copy-content"
                              onSelect={() =>
                                 void copy(
                                    'Task content',
                                    `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}\n\n- Status: ${issue.status.name}\n- Priority: ${issue.priority.name}\n- Assignee: ${issue.assignee?.name ?? 'Unassigned'}`
                                 )
                              }
                           >
                              <ClipboardType className="text-muted-foreground" />
                              Copy task content as Markdown
                              <Keys keys={['⌘', '⌥', 'C']} />
                           </CommandItem>
                           <CommandItem
                              value="copy-branch"
                              onSelect={() => void copy('Branch name', branchName)}
                           >
                              <GitBranch className="text-muted-foreground" />
                              Copy git branch name
                              <Keys keys={['⌘', '⇧', '.']} />
                           </CommandItem>
                           <CommandItem
                              value="copy-prompt"
                              onSelect={() =>
                                 void copy(
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

                  {route === 'assign' && issue && (
                     <CommandGroup heading="Assign to…">
                        {members
                           .filter((user) => matches(trimmed, user.name, user.email))
                           .slice(0, 12)
                           .map((user) => (
                              <CommandItem
                                 key={user.id}
                                 value={`assign-${user.id}`}
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
                        {allStatus
                           .filter((candidate) => matches(trimmed, candidate.name))
                           .map((candidate) => (
                              <CommandItem
                                 key={candidate.id}
                                 value={`status-${candidate.id}`}
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
                        {priorities
                           .filter((candidate) => matches(trimmed, candidate.name))
                           .map((candidate) => (
                              <CommandItem
                                 key={candidate.id}
                                 value={`priority-${candidate.id}`}
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
                        {allLabels
                           .filter((label) => matches(trimmed, label.name))
                           .map((label) => {
                              const active = issue.labels.some(
                                 (candidate) => candidate.id === label.id
                              );
                              return (
                                 <CommandItem
                                    key={label.id}
                                    value={`label-${label.id}`}
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
                           value="project-none"
                           onSelect={() => {
                              updateIssueProject(issue.id, undefined);
                              toast.success('Removed from project');
                              close();
                           }}
                        >
                           <Box className="text-muted-foreground" />
                           No project
                        </CommandItem>
                        {allProjects
                           .filter((project) => matches(trimmed, project.name))
                           .map((project) => (
                              <CommandItem
                                 key={project.id}
                                 value={`move-${project.id}`}
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

                  {route === 'due-date' && issue && (
                     <CommandGroup heading="Set due date…">
                        {(
                           [
                              ['Today', 0],
                              ['Tomorrow', 1],
                              ['In one week', 7],
                           ] as const
                        ).map(([label, days]) => (
                           <CommandItem
                              key={label}
                              value={`due-${label}`}
                              onSelect={() => {
                                 const date = new Date();
                                 date.setDate(date.getDate() + days);
                                 updateIssue(issue.id, {
                                    dueDate: date.toISOString().slice(0, 10),
                                 });
                                 toast.success(`Due date set to ${label.toLowerCase()}`);
                                 close();
                              }}
                           >
                              <CalendarPlus className="text-muted-foreground" />
                              {label}
                           </CommandItem>
                        ))}
                        <CommandItem
                           value="due-clear"
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
