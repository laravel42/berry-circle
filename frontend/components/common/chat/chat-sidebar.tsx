'use client';

import { Pin, PinOff, Plus } from 'lucide-react';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BerryMark } from '@/components/layout/shell/shell-icon';
import type { Agent } from '@/lib/agents';
import type { ChatThread } from '@/lib/chat';
import { ChatSessions } from './chat-sessions';

interface ChatSidebarProps {
   agents: Agent[];
   pinnedAgentIds: string[];
   threads: ChatThread[];
   activeId: string | null;
   /** Start a new session with an agent. */
   onNewChat: (agent: Agent) => void;
   onTogglePinned: (agent: Agent) => void;
   onSelect: (thread: ChatThread) => void;
   onChanged: () => void;
}

/**
 * Pinned agents, a "New chat" menu, and the caller's sessions.
 *
 * Every click on an agent starts a new session with it: a session is one
 * conversation, and continuing an old one is done from the sessions list.
 */
export function ChatSidebar({
   agents,
   pinnedAgentIds,
   threads,
   activeId,
   onNewChat,
   onTogglePinned,
   onSelect,
   onChanged,
}: ChatSidebarProps) {
   const pinned = pinnedAgentIds
      .map((id) => agents.find((agent) => agent.id === id))
      .filter((agent): agent is Agent => agent !== undefined);

   return (
      <aside className="flex w-[218px] flex-none flex-col overflow-y-auto border-r border-[var(--shell-line)] bg-[var(--shell-rail)]">
         <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--shell-line)] px-4 py-1.5">
            <span className="font-medium">Chat</span>
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <button
                     type="button"
                     aria-label="New chat"
                     className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]"
                  >
                     <Plus className="size-3.5" />
                     new
                  </button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="min-w-56">
                  {agents.length === 0 ? (
                     <DropdownMenuItem disabled>No agents are available.</DropdownMenuItem>
                  ) : null}
                  {agents.map((agent) => {
                     const isPinned = pinnedAgentIds.includes(agent.id);
                     return (
                        <DropdownMenuItem
                           key={agent.id}
                           className="group flex items-center justify-between gap-2"
                           onSelect={() => onNewChat(agent)}
                        >
                           <span className="truncate">{agent.name}</span>
                           <button
                              type="button"
                              aria-label={isPinned ? `Unpin ${agent.name}` : `Pin ${agent.name}`}
                              className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                              onClick={(event) => {
                                 event.preventDefault();
                                 event.stopPropagation();
                                 onTogglePinned(agent);
                              }}
                           >
                              {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                           </button>
                        </DropdownMenuItem>
                     );
                  })}
               </DropdownMenuContent>
            </DropdownMenu>
         </div>

         {pinned.length > 0 ? (
            <>
               <div className="px-[18px] pt-2 pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                  Pinned agents
               </div>
               <ul className="flex flex-col gap-px px-2">
                  {pinned.map((agent) => (
                     <li key={agent.id}>
                        <button
                           type="button"
                           onClick={() => onNewChat(agent)}
                           title={`New chat with ${agent.name}`}
                           className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-[var(--shell-text-muted)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]"
                        >
                           <BerryMark size={13} muted />
                           <span className="truncate">{agent.name}</span>
                        </button>
                     </li>
                  ))}
               </ul>
            </>
         ) : null}

         <ChatSessions threads={threads} activeId={activeId} onSelect={onSelect} onChanged={onChanged} />
      </aside>
   );
}
