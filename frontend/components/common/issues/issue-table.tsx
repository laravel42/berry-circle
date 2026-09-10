'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Issue } from '@/data/issues';
import { describePatchFailure, patchBoardIssue } from '@/lib/issues';
import { useVirtualRows } from '@/lib/use-virtual-rows';
import { useIssueSelectionStore } from '@/store/issue-selection-store';
import { useIssuesStore } from '@/store/issues-store';
import { Columns3 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AssigneeUser } from './assignee-user';
import { PrioritySelector } from './priority-selector';
import { StatusSelector } from './status-selector';

const COLUMNS = ['identifier', 'status', 'priority', 'assignee', 'dueDate', 'created', 'progress'] as const;
type Column = (typeof COLUMNS)[number];
const LABELS: Record<Column, string> = {
   identifier: 'ID',
   status: 'Status',
   priority: 'Priority',
   assignee: 'Assignee',
   dueDate: 'Due',
   created: 'Created',
   progress: 'Sub-tasks',
};
const STORAGE_KEY = 'berry.issue-table.columns';
const ROW_HEIGHT = 36;

function TitleCell({ issue }: { issue: Issue }) {
   const { orgId } = useParams<{ orgId: string }>();
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [editing, setEditing] = useState(false);
   const [title, setTitle] = useState(issue.title);

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

   return editing ? (
      <Input
         autoFocus
         className="h-7"
         value={title}
         onChange={(event) => setTitle(event.target.value)}
         onBlur={commit}
         onKeyDown={(event) => event.key === 'Enter' && commit()}
      />
   ) : (
      <span className="flex min-w-0 items-center gap-2" onDoubleClick={() => setEditing(true)}>
         <Link className="truncate hover:underline" href={`/${orgId}/issue/${issue.identifier}`}>
            {issue.title}
         </Link>
      </span>
   );
}

/** A virtualised issue table. Double-click a title to rename it; status, priority and assignee edit in place. */
export function IssueTable({ issues }: { issues: Issue[] }) {
   const [visible, setVisible] = useState<Column[]>(['identifier', 'status', 'priority', 'assignee', 'dueDate']);
   const { selected, toggle } = useIssueSelectionStore();
   const rows = useVirtualRows(issues.length, ROW_HEIGHT);

   useEffect(() => {
      try {
         const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
         if (Array.isArray(stored)) setVisible(stored.filter((entry): entry is Column => COLUMNS.includes(entry as Column)));
      } catch {
         // A corrupt preference falls back to the defaults.
      }
   }, []);

   const flip = (column: Column) => {
      const next = visible.includes(column) ? visible.filter((entry) => entry !== column) : [...visible, column];
      setVisible(next);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
   };

   const template = `32px minmax(240px, 1fr) ${visible.map(() => '120px').join(' ')}`;

   return (
      <div className="flex h-full flex-col">
         <div className="flex justify-end border-b px-4 py-1.5">
            <Popover>
               <PopoverTrigger asChild>
                  <Button size="xs" variant="ghost">
                     <Columns3 className="mr-1 size-3.5" />
                     Columns
                  </Button>
               </PopoverTrigger>
               <PopoverContent align="end" className="flex w-48 flex-col gap-1.5 p-2">
                  {COLUMNS.map((column) => (
                     <label key={column} className="flex items-center gap-2">
                        <Checkbox checked={visible.includes(column)} onCheckedChange={() => flip(column)} />
                        {LABELS[column]}
                     </label>
                  ))}
               </PopoverContent>
            </Popover>
         </div>
         <div className="grid border-b px-4 py-1.5 text-muted-foreground" style={{ gridTemplateColumns: template }}>
            <span />
            <span>Title</span>
            {visible.map((column) => (
               <span key={column}>{LABELS[column]}</span>
            ))}
         </div>
         <div ref={rows.ref} className="min-h-0 flex-1 overflow-auto">
            <div style={{ height: rows.totalHeight, position: 'relative' }}>
               <div style={{ transform: `translateY(${rows.offset}px)` }}>
                  {issues.slice(rows.start, rows.end).map((issue) => (
                     <div
                        key={issue.id}
                        className="grid items-center border-b px-4"
                        style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
                     >
                        <Checkbox checked={selected.includes(issue.id)} onCheckedChange={() => toggle(issue.id)} aria-label="Select task" />
                        <TitleCell issue={issue} />
                        {visible.map((column) => (
                           <span key={column} className="truncate">
                              {column === 'identifier' ? issue.identifier : null}
                              {column === 'status' ? <StatusSelector status={issue.status} issueId={issue.id} /> : null}
                              {column === 'priority' ? <PrioritySelector priority={issue.priority} issueId={issue.id} /> : null}
                              {column === 'assignee' ? <AssigneeUser user={issue.assignee} issueId={issue.id} /> : null}
                              {column === 'dueDate' ? (issue.dueDate?.slice(0, 10) ?? '') : null}
                              {column === 'created' ? issue.createdAt.slice(0, 10) : null}
                              {column === 'progress' && issue.childProgress && issue.childProgress.total > 0
                                 ? `${issue.childProgress.done}/${issue.childProgress.total}`
                                 : null}
                           </span>
                        ))}
                     </div>
                  ))}
               </div>
            </div>
         </div>
      </div>
   );
}
