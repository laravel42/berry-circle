'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import { cancelAgentTasks, listAgentTasks, type AgentTask } from '@/lib/agents';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<string, string> = {
   queued: 'bg-muted-foreground/40',
   running: 'bg-amber-500',
   succeeded: 'bg-[#00cc66]',
   failed: 'bg-red-500',
   cancelled: 'bg-muted-foreground/40',
};

/** Every task this agent has run or has queued, newest first. */
export default function AgentTasksTab({ agentId }: { agentId: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   const [tasks, setTasks] = useState<AgentTask[] | null>(null);
   const [cursor, setCursor] = useState<string | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);

   const load = useCallback(
      async (after?: string) => {
         const page = await listAgentTasks(agentId, after);
         setTasks((current) => (after ? [...(current ?? []), ...page.nodes] : page.nodes));
         setCursor(page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null);
      },
      [agentId]
   );

   useEffect(() => {
      load().catch((failure: unknown) =>
         setError(failure instanceof BerryApiError ? failure.message : 'Tasks could not be loaded.')
      );
   }, [load]);

   const cancelAll = async () => {
      setBusy(true);
      try {
         const cancelled = await cancelAgentTasks(agentId);
         toast.success(cancelled === 1 ? 'Cancelled 1 task' : `Cancelled ${cancelled} tasks`);
         await load();
      } catch (failure) {
         toast.error(failure instanceof BerryApiError ? failure.message : 'The tasks could not be cancelled.');
      } finally {
         setBusy(false);
      }
   };

   if (error) return <p className="text-muted-foreground">{error}</p>;
   if (!tasks) return <p className="text-muted-foreground">Loading tasks…</p>;

   const active = tasks.some((task) => task.status === 'queued' || task.status === 'running');

   return (
      <div className="flex max-w-3xl flex-col gap-3">
         <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground">Tasks this agent ran or has waiting.</p>
            <Button size="xs" variant="secondary" disabled={busy || !active} onClick={() => void cancelAll()}>
               Cancel all queued and running tasks
            </Button>
         </div>
         {tasks.length === 0 ? (
            <p className="text-muted-foreground">This agent has not run any tasks yet.</p>
         ) : (
            <ul className="flex flex-col rounded-md border border-border">
               {tasks.map((task) => (
                  <li
                     key={task.id}
                     className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5 last:border-b-0"
                  >
                     <span className="inline-flex items-center gap-2 capitalize">
                        <span className={cn('size-1.5 rounded-full', STATUS_TONE[task.status] ?? 'bg-muted')} />
                        {task.status}
                     </span>
                     <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {task.issueId ? (
                           <Link href={`/${orgId}/issue/${task.issueId}`} className="hover:underline">
                              Open the task’s issue
                           </Link>
                        ) : (
                           'Chat task'
                        )}
                     </span>
                     <time className="shrink-0 text-muted-foreground" dateTime={task.createdAt}>
                        {new Date(task.createdAt).toLocaleString()}
                     </time>
                  </li>
               ))}
            </ul>
         )}
         {cursor ? (
            <Button size="xs" variant="secondary" className="w-fit" onClick={() => void load(cursor)}>
               Load more
            </Button>
         ) : null}
      </div>
   );
}
