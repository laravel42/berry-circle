'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { BerryApiError } from '@/lib/api';
import { cancelSessionTask, prioritizeSessionTask, type ChatTask } from '@/lib/chat';

const failed = (error: unknown, fallback: string) =>
   toast.error(error instanceof BerryApiError ? error.message : fallback);

interface ChatQueueProps {
   conversationId: string;
   tasks: ChatTask[];
   onChanged: () => void;
}

/**
 * What this conversation still has to do.
 *
 * Messages sent while a reply is running become tasks behind it, so the queue
 * is the honest answer to "did my message go anywhere". Each waiting task can
 * be moved to the front or dropped, and the whole queue can be cleared —
 * dropping a task is the only way to take back something already sent.
 */
export function ChatQueue({ conversationId, tasks, onChanged }: ChatQueueProps) {
   const t = useTranslations('agentsChat.chat');
   const [open, setOpen] = useState(true);
   const [busy, setBusy] = useState(false);

   if (tasks.length === 0) return null;

   const queued = tasks.filter((task) => task.status === 'queued');

   const act = (work: Promise<unknown>) =>
      void work.then(onChanged, (error: unknown) => failed(error, t('rowFailed')));

   const clearAll = async () => {
      setBusy(true);
      try {
         // One at a time, and failures are not fatal: a task that started
         // while the queue was being cleared is simply no longer queued.
         for (const task of queued) {
            await cancelSessionTask(conversationId, task.id).catch(() => undefined);
         }
         onChanged();
      } finally {
         setBusy(false);
      }
   };

   return (
      <div className="flex-none border-t border-[var(--shell-line)] px-6 py-2">
         <div className="flex flex-wrap items-center gap-3">
            <button
               type="button"
               aria-expanded={open}
               onClick={() => setOpen(!open)}
               className="text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
            >
               {t('queueTitle', { count: tasks.length })}
            </button>
            {queued.length > 0 ? (
               <button
                  type="button"
                  disabled={busy}
                  onClick={() => void clearAll()}
                  className="text-[var(--shell-text-dim)] hover:text-[var(--shell-text)] disabled:opacity-50"
               >
                  {t('queueClear')}
               </button>
            ) : null}
         </div>

         {open ? (
            <ul className="mt-1 flex flex-col gap-1">
               {tasks.map((task, index) => (
                  <li
                     key={task.id}
                     className="flex flex-wrap items-center gap-3 text-[var(--shell-text-muted)]"
                  >
                     <span className="w-20 flex-none">
                        {task.status === 'running' ? t('rowWorking') : `#${index + 1}`}
                     </span>
                     <span className="min-w-0 flex-1 truncate text-[var(--shell-text-dim)]">
                        {new Date(task.createdAt).toLocaleTimeString([], {
                           hour: '2-digit',
                           minute: '2-digit',
                        })}
                     </span>
                     {task.status === 'queued' ? (
                        <button
                           type="button"
                           className="hover:text-[var(--shell-text)]"
                           onClick={() => act(prioritizeSessionTask(conversationId, task.id))}
                        >
                           {t('queueRunNext')}
                        </button>
                     ) : null}
                     <button
                        type="button"
                        className="hover:text-[var(--shell-text)]"
                        onClick={() => act(cancelSessionTask(conversationId, task.id))}
                     >
                        {task.status === 'running' ? t('stop') : t('queueRemove')}
                     </button>
                  </li>
               ))}
            </ul>
         ) : null}
      </div>
   );
}
