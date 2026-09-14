'use client';

import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BerryApiError } from '@/lib/api';
import {
   deleteSession,
   renameSession,
   setSessionArchived,
   setSessionPinned,
   type ChatThread,
} from '@/lib/chat';

const failed = (error: unknown, fallback: string) =>
   toast.error(error instanceof BerryApiError ? error.message : fallback);

interface ChatSessionsProps {
   threads: ChatThread[];
   /** Null until the archive has been opened. */
   archived: ChatThread[] | null;
   showArchived: boolean;
   onToggleArchived: () => void;
   activeId: string | null;
   onSelect: (thread: ChatThread) => void;
   /** Re-read the lists after a change made here. */
   onChanged: () => void;
   /** Stop whatever the agent is doing in this conversation. */
   onStop: (thread: ChatThread) => void;
}

/** Pinned first, then by recency: the order the list is actually read in. */
function order(threads: ChatThread[]): ChatThread[] {
   return threads
      .slice()
      .sort(
         (left, right) =>
            Number(right.pinned) - Number(left.pinned) ||
            right.updatedAt.localeCompare(left.updatedAt)
      );
}

function SessionRow({
   thread,
   active,
   onSelect,
   onChanged,
   onStop,
}: {
   thread: ChatThread;
   active: boolean;
   onSelect: () => void;
   onChanged: () => void;
   onStop: () => void;
}) {
   const t = useTranslations('agentsChat.chat');
   const [renaming, setRenaming] = useState(false);
   const [title, setTitle] = useState(thread.topic);

   const act = (work: Promise<unknown>) =>
      void work.then(onChanged, (error: unknown) => failed(error, t('rowFailed')));

   if (renaming) {
      return (
         <li className="px-2.5 py-1">
            <input
               autoFocus
               value={title}
               aria-label={t('rename')}
               onChange={(event) => setTitle(event.target.value)}
               onBlur={() => setRenaming(false)}
               onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(false);
                  if (event.key === 'Enter' && title.trim()) {
                     setRenaming(false);
                     act(renameSession(thread.id, title.trim()));
                  }
               }}
               className="w-full rounded bg-[var(--shell-surface)] px-2 py-1 text-[var(--shell-text)] outline-none"
            />
         </li>
      );
   }

   const preview = thread.lastMessage?.trim();

   return (
      <li className="group flex items-start">
         <button
            type="button"
            onClick={onSelect}
            aria-current={active ? 'true' : undefined}
            className={[
               'flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded px-2.5 py-1.5 text-left transition-colors',
               active
                  ? 'bg-[var(--shell-surface)] text-[var(--shell-text)]'
                  : 'text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
            ].join(' ')}
         >
            <span className="flex w-full min-w-0 items-center gap-2">
               {thread.activeRunId ? (
                  <span
                     className="size-1.5 flex-none rounded-full bg-[var(--shell-accent)] [animation:berrypulse_1.4s_ease-in-out_infinite] motion-reduce:animate-none"
                     aria-label={t('rowWorking')}
                  />
               ) : null}
               <span className="min-w-0 flex-1 truncate">{thread.topic}</span>
               {thread.unread > 0 ? (
                  <span className="flex-none rounded-sm bg-[var(--shell-line)] px-1.5 tabular-nums text-[var(--shell-text)]">
                     {thread.unread}
                  </span>
               ) : null}
            </span>
            <span className="min-w-0 truncate text-[var(--shell-text-dim)]">
               {thread.activeRunId ? t('rowWorking') : preview ? preview : t('rowNoPreview')}
            </span>
         </button>

         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <button
                  type="button"
                  aria-label={`${t('rename')} ${thread.topic}`}
                  className="mt-1 flex-none rounded p-1 text-[var(--shell-text-dim)] opacity-0 hover:text-[var(--shell-text)] focus-visible:opacity-100 group-hover:opacity-100"
               >
                  <MoreHorizontal className="size-3.5" />
               </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
               <DropdownMenuItem onSelect={() => setRenaming(true)}>{t('rename')}</DropdownMenuItem>
               <DropdownMenuItem onSelect={() => act(setSessionPinned(thread.id, !thread.pinned))}>
                  {thread.pinned ? t('unpin') : t('pin')}
               </DropdownMenuItem>
               <DropdownMenuItem
                  onSelect={() => act(setSessionArchived(thread.id, !thread.archived))}
               >
                  {thread.archived ? t('unarchive') : t('archive')}
               </DropdownMenuItem>
               {thread.activeRunId ? (
                  <DropdownMenuItem onSelect={onStop}>{t('stop')}</DropdownMenuItem>
               ) : null}
               <DropdownMenuSeparator />
               <DropdownMenuItem
                  onSelect={() => {
                     // Permanent, and said so: an archive is the reversible
                     // option and it is one item up this same menu.
                     if (!window.confirm(t('deleteConfirm', { name: thread.topic }))) return;
                     act(deleteSession(thread.id));
                  }}
               >
                  {t('delete')}
               </DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>
      </li>
   );
}

/** The caller's conversations, with the archive underneath. */
export function ChatSessions({
   threads,
   archived,
   showArchived,
   onToggleArchived,
   activeId,
   onSelect,
   onChanged,
   onStop,
}: ChatSessionsProps) {
   const t = useTranslations('agentsChat.chat');

   return (
      <div className="flex flex-col">
         <div className="px-[18px] pt-2 pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            {t('sessions')}
         </div>
         <ul className="flex flex-col gap-px px-2">
            {order(threads).map((thread) => (
               <SessionRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeId}
                  onSelect={() => onSelect(thread)}
                  onChanged={onChanged}
                  onStop={() => onStop(thread)}
               />
            ))}
            {threads.length === 0 ? (
               <li className="px-2.5 py-2 text-[var(--shell-text-dim)]">{t('noSessions')}</li>
            ) : null}
         </ul>

         <button
            type="button"
            className="mx-2 mt-2 rounded px-2.5 py-1.5 text-left text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
            aria-expanded={showArchived}
            onClick={onToggleArchived}
         >
            {showArchived ? t('hideArchived') : t('archived')}
         </button>

         {showArchived ? (
            <ul className="flex flex-col gap-px px-2 pb-4">
               {order(archived ?? []).map((thread) => (
                  <SessionRow
                     key={thread.id}
                     thread={thread}
                     active={thread.id === activeId}
                     onSelect={() => onSelect(thread)}
                     onChanged={onChanged}
                     onStop={() => onStop(thread)}
                  />
               ))}
               {archived && archived.length === 0 ? (
                  <li className="px-2.5 py-2 text-[var(--shell-text-dim)]">
                     {t('nothingArchived')}
                  </li>
               ) : null}
            </ul>
         ) : null}
      </div>
   );
}
