'use client';

import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BerryApiError } from '@/lib/api';
import {
   deleteSession,
   listThreads,
   renameSession,
   setSessionArchived,
   setSessionPinned,
   type ChatThread,
} from '@/lib/chat';

interface ChatSessionsProps {
   threads: ChatThread[];
   activeId: string | null;
   onSelect: (thread: ChatThread) => void;
   /** Re-read the list after a change made here. */
   onChanged: () => void;
}

const failed = (error: unknown, fallback: string) =>
   toast.error(error instanceof BerryApiError ? error.message : fallback);

function SessionRow({
   thread,
   active,
   onSelect,
   onChanged,
}: {
   thread: ChatThread;
   active: boolean;
   onSelect: () => void;
   onChanged: () => void;
}) {
   const [renaming, setRenaming] = useState(false);
   const [title, setTitle] = useState(thread.topic);

   const act = (work: Promise<unknown>, fallback: string) =>
      void work.then(onChanged, (error: unknown) => failed(error, fallback));

   if (renaming) {
      return (
         <li className="px-2.5 py-1">
            <input
               autoFocus
               value={title}
               aria-label="Session title"
               onChange={(event) => setTitle(event.target.value)}
               onBlur={() => setRenaming(false)}
               onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(false);
                  if (event.key === 'Enter' && title.trim()) {
                     setRenaming(false);
                     act(renameSession(thread.id, title.trim()), 'The session could not be renamed.');
                  }
               }}
               className="w-full rounded bg-[var(--shell-surface)] px-2 py-1 text-[var(--shell-text)] outline-none"
            />
         </li>
      );
   }

   return (
      <li className="group flex items-center">
         <button
            type="button"
            onClick={onSelect}
            aria-current={active ? 'true' : undefined}
            className={[
               'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left transition-colors',
               active
                  ? 'bg-[var(--shell-surface)] text-[var(--shell-text)]'
                  : 'text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
            ].join(' ')}
         >
            {thread.activeRunId ? (
               <span
                  className="size-1.5 flex-none rounded-full bg-[var(--shell-accent)] [animation:berrypulse_1.4s_ease-in-out_infinite] motion-reduce:animate-none"
                  aria-label="A task is running"
               />
            ) : null}
            <span className="min-w-0 truncate">{thread.topic}</span>
            {thread.unread > 0 ? (
               <span className="ml-auto rounded-sm bg-[var(--shell-line)] px-1.5 tabular-nums text-[var(--shell-text)]">
                  {thread.unread}
               </span>
            ) : null}
         </button>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <button
                  type="button"
                  aria-label={`Actions for ${thread.topic}`}
                  className="flex-none rounded p-1 text-[var(--shell-text-dim)] opacity-0 hover:text-[var(--shell-text)] focus:opacity-100 group-hover:opacity-100"
               >
                  <MoreHorizontal className="size-3.5" />
               </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
               <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
               <DropdownMenuItem
                  onSelect={() =>
                     act(setSessionPinned(thread.id, !thread.pinned), 'The session could not be pinned.')
                  }
               >
                  {thread.pinned ? 'Unpin' : 'Pin'}
               </DropdownMenuItem>
               <DropdownMenuItem
                  onSelect={() =>
                     act(setSessionArchived(thread.id, !thread.archived), 'The session could not be archived.')
                  }
               >
                  {thread.archived ? 'Unarchive' : 'Archive'}
               </DropdownMenuItem>
               <DropdownMenuItem
                  onSelect={() => {
                     if (!window.confirm(`Delete "${thread.topic}" and its messages?`)) return;
                     act(deleteSession(thread.id), 'The session could not be deleted.');
                  }}
               >
                  Delete
               </DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>
      </li>
   );
}

/** The caller's chat sessions, pinned first, with an archive underneath. */
export function ChatSessions({ threads, activeId, onSelect, onChanged }: ChatSessionsProps) {
   const [showArchived, setShowArchived] = useState(false);
   const [archived, setArchived] = useState<ChatThread[] | null>(null);

   const loadArchived = () =>
      listThreads({ archived: true }).then(setArchived, (error: unknown) =>
         failed(error, 'Archived sessions could not be loaded.')
      );
   const changed = () => {
      onChanged();
      if (showArchived) void loadArchived();
   };

   return (
      <div className="flex flex-col">
         <div className="px-[18px] pt-2 pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            Sessions
         </div>
         <ul className="flex flex-col gap-px px-2">
            {threads.map((thread) => (
               <SessionRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeId}
                  onSelect={() => onSelect(thread)}
                  onChanged={changed}
               />
            ))}
            {threads.length === 0 ? (
               <li className="px-2.5 py-2 text-[var(--shell-text-dim)]">No sessions yet.</li>
            ) : null}
         </ul>
         <button
            type="button"
            className="mx-2 mt-2 rounded px-2.5 py-1.5 text-left text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
            aria-expanded={showArchived}
            onClick={() => {
               const next = !showArchived;
               setShowArchived(next);
               if (next) void loadArchived();
            }}
         >
            {showArchived ? 'Hide archived' : 'Archived'}
         </button>
         {showArchived ? (
            <ul className="flex flex-col gap-px px-2 pb-4">
               {(archived ?? []).map((thread) => (
                  <SessionRow
                     key={thread.id}
                     thread={thread}
                     active={thread.id === activeId}
                     onSelect={() => onSelect(thread)}
                     onChanged={changed}
                  />
               ))}
               {archived && archived.length === 0 ? (
                  <li className="px-2.5 py-2 text-[var(--shell-text-dim)]">Nothing archived.</li>
               ) : null}
            </ul>
         ) : null}
      </div>
   );
}
