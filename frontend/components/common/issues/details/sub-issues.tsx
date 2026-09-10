'use client';

import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import type { Issue } from '@/data/issues';
import { createChild, loadChildren } from '@/lib/issue-tracking';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Children with their stage, a progress bar, and an inline add. */
export function SubIssues({ issue }: { issue: Issue }) {
   const { orgId } = useParams<{ orgId: string }>();
   const [children, setChildren] = useState<Issue[]>([]);
   const [progress, setProgress] = useState({ total: 0, done: 0 });
   const [title, setTitle] = useState('');
   const [stage, setStage] = useState('');

   const reload = useCallback(() => {
      void loadChildren(issue.identifier)
         .then((loaded) => {
            setChildren(loaded.nodes);
            setProgress(loaded.progress);
         })
         .catch(() => undefined);
   }, [issue.identifier]);
   useEffect(reload, [reload]);

   const add = () => {
      if (!title.trim()) return;
      void createChild(issue.identifier, { title: title.trim(), stage: stage === '' ? null : Number(stage) })
         .then(() => {
            setTitle('');
            reload();
         })
         .catch(() => toast.error('The sub-task could not be created.'));
   };

   return (
      <div className="mt-6 flex flex-col gap-2">
         <div className="flex items-center justify-between">
            <span className="font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">sub-tasks</span>
            {progress.total > 0 ? (
               <span className="text-muted-foreground">
                  {progress.done}/{progress.total}
               </span>
            ) : null}
         </div>
         {progress.total > 0 ? <Progress value={(progress.done / progress.total) * 100} /> : null}
         <ul className="flex flex-col">
            {children.map((child) => (
               <li key={child.id} className="flex items-center gap-2 py-1">
                  {child.stage !== null && child.stage !== undefined ? (
                     <span className="rounded bg-accent px-1.5 text-muted-foreground">stage {child.stage}</span>
                  ) : null}
                  <span className="text-muted-foreground">{child.identifier}</span>
                  <Link className="min-w-0 truncate hover:underline" href={`/${orgId}/issue/${child.identifier}`}>
                     {child.title}
                  </Link>
                  <span className="ml-auto text-muted-foreground">{child.status.name}</span>
               </li>
            ))}
         </ul>
         <div className="flex gap-2">
            <Input
               placeholder="Add a sub-task"
               value={title}
               onChange={(event) => setTitle(event.target.value)}
               onKeyDown={(event) => event.key === 'Enter' && add()}
            />
            <Input
               className="w-24"
               type="number"
               min={0}
               placeholder="Stage"
               value={stage}
               onChange={(event) => setStage(event.target.value)}
            />
         </div>
      </div>
   );
}
