'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BerryApiError } from '@/lib/api';
import {
   cancelSessionTask,
   listTaskEvents,
   prioritizeSessionTask,
   type ChatTask,
   type ChatTaskEvent,
} from '@/lib/chat';

const failed = (error: unknown, fallback: string) =>
   toast.error(error instanceof BerryApiError ? error.message : fallback);

/** A short, readable line for one step of a task. */
function describe(event: ChatTaskEvent): string {
   const payload = event.payload;
   if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      for (const key of ['summary', 'message', 'text', 'tool', 'name']) {
         const value = record[key];
         if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 400);
      }
   }
   return '';
}

interface TaskStepsSheetProps {
   conversationId: string;
   runId: string | null;
   onClose: () => void;
}

/** The thread view of one task: every step it took, in order. */
export function TaskStepsSheet({ conversationId, runId, onClose }: TaskStepsSheetProps) {
   const [events, setEvents] = useState<ChatTaskEvent[] | null>(null);

   useEffect(() => {
      if (!runId) return;
      let cancelled = false;
      setEvents(null);
      listTaskEvents(conversationId, runId).then(
         (found) => {
            if (!cancelled) setEvents(found);
         },
         (error: unknown) => {
            if (!cancelled) {
               setEvents([]);
               failed(error, 'The steps could not be loaded.');
            }
         }
      );
      return () => {
         cancelled = true;
      };
   }, [conversationId, runId]);

   return (
      <Sheet open={runId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
         <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
            <SheetHeader>
               <SheetTitle>Task steps</SheetTitle>
            </SheetHeader>
            <ol className="flex flex-col gap-2 px-4 pb-6">
               {events === null ? <li className="text-muted-foreground">Loading steps…</li> : null}
               {events !== null && events.length === 0 ? (
                  <li className="text-muted-foreground">No steps recorded for this task.</li>
               ) : null}
               {(events ?? []).map((event) => (
                  <li key={event.id} className="rounded-md border border-border px-3 py-2">
                     <p className="font-mono">{event.type}</p>
                     {describe(event) ? (
                        <p className="whitespace-pre-wrap break-words text-muted-foreground">{describe(event)}</p>
                     ) : null}
                  </li>
               ))}
            </ol>
         </SheetContent>
      </Sheet>
   );
}

interface ChatTasksPanelProps {
   conversationId: string;
   tasks: ChatTask[];
   onChanged: () => void;
   onViewSteps: (runId: string) => void;
}

/** Queued and running tasks of this session, above the composer. */
export function ChatTasksPanel({ conversationId, tasks, onChanged, onViewSteps }: ChatTasksPanelProps) {
   const [open, setOpen] = useState(true);
   if (tasks.length === 0) return null;

   return (
      <div className="flex-none border-t border-[var(--shell-line)] px-6 py-2">
         <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
         >
            {tasks.length === 1 ? '1 task' : `${tasks.length} tasks`} in this session
         </button>
         {open ? (
            <ul className="mt-1 flex flex-col gap-1">
               {tasks.map((task, index) => (
                  <li key={task.id} className="flex items-center gap-3 text-[var(--shell-text-muted)]">
                     <span className="w-16 flex-none">{task.status === 'running' ? 'running' : `queued #${index + 1}`}</span>
                     <span className="min-w-0 flex-1 truncate text-[var(--shell-text-dim)]">
                        {new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                     </span>
                     <button
                        type="button"
                        className="hover:text-[var(--shell-text)]"
                        onClick={() => onViewSteps(task.id)}
                     >
                        View steps
                     </button>
                     {task.status === 'queued' ? (
                        <button
                           type="button"
                           className="hover:text-[var(--shell-text)]"
                           onClick={() =>
                              void prioritizeSessionTask(conversationId, task.id).then(onChanged, (error: unknown) =>
                                 failed(error, 'The task could not be moved up.')
                              )
                           }
                        >
                           Run next
                        </button>
                     ) : null}
                     <button
                        type="button"
                        className="hover:text-[var(--shell-text)]"
                        onClick={() =>
                           void cancelSessionTask(conversationId, task.id).then(onChanged, (error: unknown) =>
                              failed(error, 'The task could not be cancelled.')
                           )
                        }
                     >
                        Cancel
                     </button>
                  </li>
               ))}
            </ul>
         ) : null}
      </div>
   );
}
