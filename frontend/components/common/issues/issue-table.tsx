'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import type { Issue } from '@/data/issues';
import type { Status } from '@/data/status';
import { quickCreateIssue } from '@/lib/issue-tracking';
import { describePatchFailure, patchBoardIssue, setIssueProject } from '@/lib/issues';
import { setIssueProperty } from '@/lib/properties';
import { useVirtualRows } from '@/lib/use-virtual-rows';
import { cn } from '@/lib/utils';
import { useIssueSelectionStore } from '@/store/issue-selection-store';
import { useIssuesStore } from '@/store/issues-store';
import { useLabelsStore } from '@/store/labels-store';
import { useProjectsStore } from '@/store/projects-store';
import { useSessionStore } from '@/store/session-store';
import { ChevronDown, ChevronRight, Columns3, Download, GripVertical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AssigneeUser } from './assignee-user';
import {
   useIssueGroups,
   usePropertyGrouping,
   usePropertyValues,
   useWorkspaceProperties,
} from './issue-grouping';
import { PrioritySelector } from './priority-selector';
import { SelectionCheckbox } from './selection-checkbox';
import { StatusSelector } from './status-selector';
import { sortIssues, useIssueListView } from './use-issue-list-view';

const BUILT_IN_COLUMNS = [
   'identifier',
   'status',
   'priority',
   'assignee',
   'project',
   'labels',
   'dueDate',
   'created',
   'updated',
   'progress',
] as const;
type BuiltInColumn = (typeof BUILT_IN_COLUMNS)[number];
type Column = BuiltInColumn | `property:${string}`;

const STORAGE_KEY = 'berry.issue-table.columns-v2';
const ROW_HEIGHT = 36;
const NONE = '__none__';

type Calculation = 'count' | 'sum' | 'average';

/** Columns whose cells hold a number the footer can add up. */
const NUMERIC: Partial<Record<BuiltInColumn, (issue: Issue) => number>> = {
   progress: (issue) => issue.childProgress?.total ?? 0,
};

interface StoredLayout {
   order: Column[];
   hidden: Column[];
   calculation: Calculation;
}

function readLayout(): StoredLayout | null {
   try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredLayout>;
      if (!Array.isArray(parsed.order)) return null;
      return {
         order: parsed.order as Column[],
         hidden: Array.isArray(parsed.hidden) ? (parsed.hidden as Column[]) : [],
         calculation:
            parsed.calculation === 'sum' || parsed.calculation === 'average'
               ? parsed.calculation
               : 'count',
      };
   } catch {
      return null;
   }
}

function csvCell(value: string): string {
   return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/* -------------------------------------------------------------------------- */
/*                                   Cells                                    */
/* -------------------------------------------------------------------------- */

function TitleCell({
   issue,
   depth,
   expandable,
   expanded,
   onToggle,
}: {
   issue: Issue;
   depth: number;
   expandable: boolean;
   expanded: boolean;
   onToggle: () => void;
}) {
   const { orgId } = useParams<{ orgId: string }>();
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [editing, setEditing] = useState(false);
   const [title, setTitle] = useState(issue.title);

   useEffect(() => {
      setTitle(issue.title);
   }, [issue.title]);

   const commit = () => {
      setEditing(false);
      const next = title.trim();
      if (!next || next === issue.title) return;
      const previous = issue.title;
      updateIssue(issue.id, { title: next });
      void patchBoardIssue(issue.id, { title: next }).catch((cause: unknown) => {
         updateIssue(issue.id, { title: previous });
         toast.error(describePatchFailure(cause));
      });
   };

   return (
      <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 16 }}>
         {expandable ? (
            <button
               type="button"
               onClick={onToggle}
               aria-label={expanded ? 'Collapse sub-tasks' : 'Expand sub-tasks'}
               className="text-muted-foreground transition-colors hover:text-foreground"
            >
               {expanded ? (
                  <ChevronDown className="size-3.5" />
               ) : (
                  <ChevronRight className="size-3.5" />
               )}
            </button>
         ) : (
            <span className="w-3.5 shrink-0" />
         )}
         {editing ? (
            <Input
               autoFocus
               className="h-7"
               value={title}
               onChange={(event) => setTitle(event.target.value)}
               onBlur={commit}
               onKeyDown={(event) => {
                  if (event.key === 'Enter') commit();
                  // Escape puts the original back rather than saving it: a
                  // rename someone backed out of is not a rename.
                  if (event.key === 'Escape') {
                     setTitle(issue.title);
                     setEditing(false);
                  }
               }}
            />
         ) : (
            <Link
               className="truncate hover:underline"
               href={`/${orgId}/issue/${issue.identifier}`}
               onDoubleClick={(event) => {
                  event.preventDefault();
                  setEditing(true);
               }}
            >
               {issue.title}
            </Link>
         )}
      </span>
   );
}

function DueDateCell({ issue }: { issue: Issue }) {
   const updateIssue = useIssuesStore((state) => state.updateIssue);

   return (
      <input
         type="date"
         className="w-full bg-transparent outline-none"
         value={issue.dueDate?.slice(0, 10) ?? ''}
         onChange={(event) => {
            const next = event.target.value
               ? new Date(event.target.value).toISOString()
               : undefined;
            const previous = issue.dueDate;
            updateIssue(issue.id, { dueDate: next });
            void patchBoardIssue(issue.id, { dueDate: next ?? null }).catch((cause: unknown) => {
               updateIssue(issue.id, { dueDate: previous });
               toast.error(describePatchFailure(cause));
            });
         }}
      />
   );
}

function ProjectCell({ issue }: { issue: Issue }) {
   const projects = useProjectsStore((state) => state.projects);
   const updateIssueProject = useIssuesStore((state) => state.updateIssueProject);

   return (
      <Select
         value={issue.project?.id ?? NONE}
         onValueChange={(value) => {
            const next = value === NONE ? undefined : projects.find((entry) => entry.id === value);
            const previous = issue.project;
            updateIssueProject(issue.id, next);
            void setIssueProject(issue.identifier, next?.id ?? null).catch(() => {
               updateIssueProject(issue.id, previous);
               toast.error('That project could not be saved.');
            });
         }}
      >
         <SelectTrigger className="h-6 w-full border-0 px-1 shadow-none">
            <SelectValue placeholder="—" />
         </SelectTrigger>
         <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {projects.map((project) => (
               <SelectItem key={project.id} value={project.id}>
                  {project.name}
               </SelectItem>
            ))}
         </SelectContent>
      </Select>
   );
}

function LabelsCell({ issue }: { issue: Issue }) {
   const labels = useLabelsStore((state) => state.labels);
   const { addIssueLabel, removeIssueLabel } = useIssuesStore();

   return (
      <Popover>
         <PopoverTrigger asChild>
            <button type="button" className="flex w-full items-center gap-1 truncate text-left">
               {issue.labels.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
               ) : (
                  issue.labels.map((label) => (
                     <span
                        key={label.id}
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: label.color }}
                        title={label.name}
                     />
                  ))
               )}
            </button>
         </PopoverTrigger>
         <PopoverContent align="start" className="w-56 p-0">
            <Command>
               <CommandInput placeholder="Search labels" />
               <CommandList>
                  <CommandEmpty>No label found.</CommandEmpty>
                  <CommandGroup>
                     {labels.map((label) => {
                        const on = issue.labels.some((entry) => entry.id === label.id);
                        return (
                           <CommandItem
                              key={label.id}
                              value={label.name}
                              onSelect={() =>
                                 on
                                    ? removeIssueLabel(issue.id, label.id)
                                    : addIssueLabel(issue.id, label)
                              }
                           >
                              <span
                                 className="size-2.5 rounded-full"
                                 style={{ backgroundColor: label.color }}
                              />
                              {label.name}
                              {on ? <span className="ml-auto">✓</span> : null}
                           </CommandItem>
                        );
                     })}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}

function PropertyCell({
   issue,
   propertyId,
   value,
   options,
}: {
   issue: Issue;
   propertyId: string;
   value: string;
   options: { id: string; name: string }[];
}) {
   const [current, setCurrent] = useState(value);

   useEffect(() => {
      setCurrent(value);
   }, [value]);

   if (options.length === 0) {
      return <span className="truncate text-muted-foreground">{current || '—'}</span>;
   }

   return (
      <Select
         value={current || NONE}
         onValueChange={(next) => {
            const previous = current;
            setCurrent(next === NONE ? '' : next);
            void setIssueProperty(issue.identifier, propertyId, next === NONE ? null : next).catch(
               () => {
                  setCurrent(previous);
                  toast.error('That field could not be saved.');
               }
            );
         }}
      >
         <SelectTrigger className="h-6 w-full border-0 px-1 shadow-none">
            <SelectValue placeholder="—" />
         </SelectTrigger>
         <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {options.map((option) => (
               <SelectItem key={option.id} value={option.id}>
                  {option.name}
               </SelectItem>
            ))}
         </SelectContent>
      </Select>
   );
}

/** The last row: type a title, press Enter, the task lands on the board. */
function QuickAddRow() {
   const t = useTranslations('issueLists');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const addIssue = useIssuesStore((state) => state.addIssue);
   const [title, setTitle] = useState('');
   const [busy, setBusy] = useState(false);

   const submit = () => {
      if (!title.trim() || !workspaceId || busy) return;
      setBusy(true);
      void quickCreateIssue({ workspaceId, title: title.trim() })
         .then((issue) => {
            addIssue(issue);
            setTitle('');
         })
         .catch(() => toast.error('The task could not be created.'))
         .finally(() => setBusy(false));
   };

   return (
      <div className="border-t px-4 py-1.5">
         <Input
            className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
            placeholder={t('table.quickAdd')}
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
         />
      </div>
   );
}

/* -------------------------------------------------------------------------- */
/*                                   Table                                    */
/* -------------------------------------------------------------------------- */

interface TableRow {
   issue: Issue;
   depth: number;
   expandable: boolean;
   expanded: boolean;
}

/**
 * The table layout: a column per property, grouped the way the display
 * settings say, with sub-tasks nested under their parent.
 *
 * Everything about the columns — which are shown, in what order, and what the
 * footer adds up — is the reader's, so it is kept in their browser rather than
 * recomputed from the data each time.
 */
export function IssueTable({
   issues,
   statuses,
   totalIssues,
   loading = false,
}: {
   issues: Issue[];
   statuses: Status[];
   totalIssues?: Issue[];
   loading?: boolean;
}) {
   const t = useTranslations('issueLists');
   const view = useIssueListView();
   const properties = useWorkspaceProperties();
   const propertyGrouping = usePropertyGrouping(view.grouping);
   const { selected, setAll } = useIssueSelectionStore();
   const [layout, setLayout] = useState<StoredLayout>({
      order: [...BUILT_IN_COLUMNS],
      hidden: ['created', 'updated', 'progress', 'labels'],
      calculation: 'count',
   });
   const [search, setSearch] = useState('');
   const [dragging, setDragging] = useState<Column | null>(null);
   const [collapsed, setCollapsed] = useState<string[]>([]);

   useEffect(() => {
      const stored = readLayout();
      if (stored) setLayout(stored);
   }, []);

   const persist = (next: StoredLayout) => {
      setLayout(next);
      try {
         window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
         // A browser refusing storage is not a reason to refuse the change.
      }
   };

   const allColumns = useMemo<Column[]>(() => {
      const dynamic = properties
         .filter((definition) => definition.kind === 'select')
         .map((definition) => `property:${definition.id}` as Column);
      const known = [...BUILT_IN_COLUMNS, ...dynamic];
      const ordered = layout.order.filter((column) => known.includes(column));
      return [...ordered, ...known.filter((column) => !ordered.includes(column))];
   }, [properties, layout.order]);

   const visible = allColumns.filter((column) => !layout.hidden.includes(column));

   const labelOf = (column: Column): string => {
      if (column.startsWith('property:')) {
         const id = column.slice('property:'.length);
         return properties.find((definition) => definition.id === id)?.name ?? id;
      }
      const map: Record<BuiltInColumn, string> = {
         identifier: 'ID',
         status: t('display.status'),
         priority: t('display.priority'),
         assignee: t('display.assignee'),
         project: t('display.project'),
         labels: 'Labels',
         dueDate: t('display.dueDate'),
         created: t('display.created'),
         updated: t('display.updated'),
         progress: 'Sub-tasks',
      };
      return map[column as BuiltInColumn];
   };

   const searched = useMemo(() => {
      const query = search.trim().toLowerCase();
      if (!query) return issues;
      return issues.filter(
         (issue) =>
            issue.title.toLowerCase().includes(query) ||
            issue.identifier.toLowerCase().includes(query)
      );
   }, [issues, search]);

   const groups = useIssueGroups({
      issues: searched,
      totalIssues: totalIssues ?? searched,
      statuses,
      grouping: view.grouping,
      property: propertyGrouping,
   });

   /* Sub-tasks sit under their parent rather than beside it, so a table of
      forty rows reads as the ten pieces of work it actually is. */
   const rowsOf = (list: Issue[]): TableRow[] => {
      const ordered = sortIssues(list, view.ordering, view.direction);
      const byParent = new Map<string, Issue[]>();
      for (const issue of ordered) {
         if (!issue.parentId) continue;
         byParent.set(issue.parentId, [...(byParent.get(issue.parentId) ?? []), issue]);
      }
      const present = new Set(ordered.map((issue) => issue.id));
      const rows: TableRow[] = [];
      const walk = (issue: Issue, depth: number) => {
         const children = byParent.get(issue.id) ?? [];
         const expanded = !collapsed.includes(issue.id);
         rows.push({ issue, depth, expandable: children.length > 0, expanded });
         if (!expanded) return;
         for (const child of children) walk(child, depth + 1);
      };
      for (const issue of ordered) {
         if (issue.parentId && present.has(issue.parentId)) continue;
         walk(issue, 0);
      }
      return rows;
   };

   const flat = useMemo(
      () => groups.map((entry) => ({ group: entry.group, rows: rowsOf(entry.issues) })),
      // `rowsOf` closes over the ordering and the collapsed set.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [groups, view.ordering, view.direction, collapsed]
   );

   /* Group headers ride in the same virtual list as the rows, so a section
      title cannot drift away from the rows it belongs to while scrolling. */
   type Entry =
      | { kind: 'header'; id: string; name: string; icon: React.ReactNode; count: number }
      | { kind: 'row'; row: TableRow };

   const entries = useMemo<Entry[]>(
      () =>
         flat.flatMap((entry) => {
            const rows: Entry[] = entry.rows.map((row) => ({ kind: 'row', row }) as Entry);
            if (view.grouping === 'none') return rows;
            return [
               {
                  kind: 'header',
                  id: entry.group.id,
                  name: entry.group.name,
                  icon: entry.group.icon,
                  count: entry.rows.length,
               } as Entry,
               ...rows,
            ];
         }),
      [flat, view.grouping]
   );

   const flatRows = useMemo(
      () =>
         entries
            .filter((entry): entry is Extract<Entry, { kind: 'row' }> => entry.kind === 'row')
            .map((entry) => entry.row),
      [entries]
   );
   const virtual = useVirtualRows(entries.length, ROW_HEIGHT);

   const exportCsv = (rows: Issue[]) => {
      const header = ['Identifier', 'Title', ...visible.map(labelOf)];
      const cellOf = (issue: Issue, column: Column): string => {
         if (column.startsWith('property:')) {
            return propertyValues.get(`${column}|${issue.id}`) ?? '';
         }
         switch (column as BuiltInColumn) {
            case 'identifier':
               return issue.identifier;
            case 'status':
               return issue.status.name;
            case 'priority':
               return issue.priority.name;
            case 'assignee':
               return issue.assignee?.name ?? '';
            case 'project':
               return issue.project?.name ?? '';
            case 'labels':
               return issue.labels.map((label) => label.name).join(' ');
            case 'dueDate':
               return issue.dueDate?.slice(0, 10) ?? '';
            case 'created':
               return issue.createdAt.slice(0, 10);
            case 'updated':
               return (issue.updatedAt ?? issue.createdAt).slice(0, 10);
            case 'progress':
               return issue.childProgress
                  ? `${issue.childProgress.done}/${issue.childProgress.total}`
                  : '';
            default:
               return '';
         }
      };
      const body = rows.map((issue) =>
         [issue.identifier, issue.title, ...visible.map((column) => cellOf(issue, column))]
            .map(csvCell)
            .join(',')
      );
      const csv = [header.map(csvCell).join(','), ...body].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'tasks.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(t('table.exported', { count: rows.length }));
   };

   // One grouped query per field column gives every row its value without a
   // request per task; the same query already backs grouping by a field.
   const fieldIds = useMemo(
      () =>
         visible
            .filter((column) => column.startsWith('property:'))
            .map((column) => column.slice('property:'.length)),
      [visible]
   );
   const propertyValues = usePropertyValues(fieldIds);

   const footerValue = (column: Column): string => {
      const numeric = NUMERIC[column as BuiltInColumn];
      if (layout.calculation === 'count' || !numeric) {
         return column === visible[0] ? String(flatRows.length) : '';
      }
      const values = flatRows.map((row) => numeric(row.issue));
      if (values.length === 0) return '0';
      const sum = values.reduce((total, value) => total + value, 0);
      return layout.calculation === 'sum' ? String(sum) : (sum / values.length).toFixed(1);
   };

   const orderIds = useMemo(() => flatRows.map((row) => row.issue.id), [flatRows]);

   const template = `32px minmax(240px, 1fr) ${visible.map(() => '140px').join(' ')}`;

   const cell = (issue: Issue, column: Column) => {
      if (column.startsWith('property:')) {
         const id = column.slice('property:'.length);
         const definition = properties.find((entry) => entry.id === id);
         return (
            <PropertyCell
               issue={issue}
               propertyId={id}
               value={propertyValues.get(`${column}|${issue.id}`) ?? ''}
               options={definition?.options ?? []}
            />
         );
      }
      switch (column as BuiltInColumn) {
         case 'identifier':
            return <span className="truncate text-muted-foreground">{issue.identifier}</span>;
         case 'status':
            return <StatusSelector status={issue.status} issueId={issue.id} />;
         case 'priority':
            return <PrioritySelector priority={issue.priority} issueId={issue.id} />;
         case 'assignee':
            return <AssigneeUser user={issue.assignee} issueId={issue.id} />;
         case 'project':
            return <ProjectCell issue={issue} />;
         case 'labels':
            return <LabelsCell issue={issue} />;
         case 'dueDate':
            return <DueDateCell issue={issue} />;
         case 'created':
            return <span className="truncate">{issue.createdAt.slice(0, 10)}</span>;
         case 'updated':
            return (
               <span className="truncate">{(issue.updatedAt ?? issue.createdAt).slice(0, 10)}</span>
            );
         case 'progress':
            return (
               <span className="truncate">
                  {issue.childProgress && issue.childProgress.total > 0
                     ? `${issue.childProgress.done}/${issue.childProgress.total}`
                     : ''}
               </span>
            );
         default:
            return null;
      }
   };

   return (
      <div className="flex h-full flex-col">
         {/* Toolbar */}
         <div className="flex items-center gap-2 border-b px-4 py-1.5">
            <Input
               className="h-7 max-w-64"
               placeholder={t('table.search')}
               value={search}
               onChange={(event) => setSearch(event.target.value)}
            />
            <div className="ml-auto flex items-center gap-1">
               <Select
                  value={layout.calculation}
                  onValueChange={(value) =>
                     persist({ ...layout, calculation: value as Calculation })
                  }
               >
                  <SelectTrigger className="h-7 w-28">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value="count">{t('table.count')}</SelectItem>
                     <SelectItem value="sum">{t('table.sum')}</SelectItem>
                     <SelectItem value="average">{t('table.average')}</SelectItem>
                  </SelectContent>
               </Select>
               <Popover>
                  <PopoverTrigger asChild>
                     <Button size="xs" variant="ghost">
                        <Columns3 className="mr-1 size-3.5" />
                        {t('table.columns')}
                     </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-60 p-0">
                     <Command>
                        <CommandInput placeholder={t('table.searchColumns')} />
                        <CommandList>
                           <CommandEmpty>{t('table.none')}</CommandEmpty>
                           <CommandGroup>
                              {allColumns.map((column) => (
                                 <CommandItem
                                    key={column}
                                    value={labelOf(column)}
                                    onSelect={() =>
                                       persist({
                                          ...layout,
                                          hidden: layout.hidden.includes(column)
                                             ? layout.hidden.filter((entry) => entry !== column)
                                             : [...layout.hidden, column],
                                       })
                                    }
                                 >
                                    <Checkbox
                                       checked={!layout.hidden.includes(column)}
                                       className="pointer-events-none"
                                    />
                                    {labelOf(column)}
                                 </CommandItem>
                              ))}
                           </CommandGroup>
                        </CommandList>
                     </Command>
                  </PopoverContent>
               </Popover>
               <Popover>
                  <PopoverTrigger asChild>
                     <Button size="xs" variant="ghost">
                        <Download className="mr-1 size-3.5" />
                        {t('table.export')}
                     </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="flex w-52 flex-col gap-1 p-1">
                     <Button
                        size="xs"
                        variant="ghost"
                        className="justify-start"
                        onClick={() => exportCsv(flatRows.map((row) => row.issue))}
                     >
                        {t('table.exportAll')}
                     </Button>
                     <Button
                        size="xs"
                        variant="ghost"
                        className="justify-start"
                        disabled={selected.length === 0}
                        onClick={() =>
                           exportCsv(
                              flatRows
                                 .map((row) => row.issue)
                                 .filter((issue) => selected.includes(issue.id))
                           )
                        }
                     >
                        {t('table.exportSelected')}
                     </Button>
                  </PopoverContent>
               </Popover>
            </div>
         </div>

         {/* Header */}
         <div
            className="grid border-b px-4 py-1.5 text-muted-foreground"
            style={{ gridTemplateColumns: template }}
         >
            <Checkbox
               aria-label={t('selection.selectAll')}
               checked={
                  flatRows.length > 0 && flatRows.every((row) => selected.includes(row.issue.id))
               }
               onCheckedChange={(checked) =>
                  setAll(checked === true ? flatRows.map((row) => row.issue.id) : [])
               }
            />
            <span>Title</span>
            {visible.map((column) => (
               <span
                  key={column}
                  draggable
                  onDragStart={() => setDragging(column)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                     if (!dragging || dragging === column) return;
                     const next = allColumns.filter((entry) => entry !== dragging);
                     next.splice(next.indexOf(column), 0, dragging);
                     persist({ ...layout, order: next });
                     setDragging(null);
                  }}
                  className={cn(
                     'flex cursor-grab items-center gap-1 truncate',
                     dragging === column && 'opacity-50'
                  )}
               >
                  <GripVertical className="size-3 opacity-40" />
                  {labelOf(column)}
               </span>
            ))}
         </div>

         {/* Rows */}
         <div ref={virtual.ref} className="min-h-0 flex-1 overflow-auto">
            {loading ? (
               <div className="px-4 py-3 text-muted-foreground">{t('table.loadingGroup')}</div>
            ) : null}
            <div style={{ height: virtual.totalHeight, position: 'relative' }}>
               <div style={{ transform: `translateY(${virtual.offset}px)` }}>
                  {entries.slice(virtual.start, virtual.end).map((entry) =>
                     entry.kind === 'header' ? (
                        <div
                           key={`header-${entry.id}`}
                           className="flex items-center gap-2 border-b bg-accent/30 px-4 font-medium"
                           style={{ height: ROW_HEIGHT }}
                        >
                           {entry.icon}
                           <span className="truncate">{entry.name}</span>
                           <span className="text-muted-foreground">{entry.count}</span>
                           {loading ? (
                              <span className="text-muted-foreground">
                                 {t('table.loadingGroup')}
                              </span>
                           ) : null}
                        </div>
                     ) : (
                        <div
                           key={entry.row.issue.id}
                           className="group grid items-center border-b px-4"
                           style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
                        >
                           <SelectionCheckbox issueId={entry.row.issue.id} order={orderIds} />
                           <TitleCell
                              issue={entry.row.issue}
                              depth={entry.row.depth}
                              expandable={entry.row.expandable}
                              expanded={entry.row.expanded}
                              onToggle={() =>
                                 setCollapsed((previous) =>
                                    previous.includes(entry.row.issue.id)
                                       ? previous.filter((id) => id !== entry.row.issue.id)
                                       : [...previous, entry.row.issue.id]
                                 )
                              }
                           />
                           {visible.map((column) => (
                              <span key={column} className="min-w-0 truncate">
                                 {cell(entry.row.issue, column)}
                              </span>
                           ))}
                        </div>
                     )
                  )}
               </div>
            </div>
            <QuickAddRow />
         </div>

         {/* Footer calculations */}
         <div
            className="grid border-t bg-container px-4 py-1.5 text-muted-foreground"
            style={{ gridTemplateColumns: template }}
         >
            <span />
            <span>
               {t('table.count')} {flatRows.length}
            </span>
            {visible.map((column) => (
               <span key={column} className="truncate">
                  {footerValue(column)}
               </span>
            ))}
         </div>
      </div>
   );
}
