'use client';

import { Pin, PinOff, Plus } from 'lucide-react';
import { useAgentCoverage } from '@/hooks/use-agent-coverage';
import { agentHasRuntime } from '@/lib/runtimes';
import { useTranslations } from 'next-intl';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BerryMark } from '@/components/layout/shell/shell-icon';
import type { Agent, AgentRoster } from '@/lib/agents';
import type { ChatThread } from '@/lib/chat';
import { ChatSessions } from './chat-sessions';

/** Five is what the strip holds without becoming a second sessions list. */
export const MAX_PINNED_AGENTS = 5;

interface ChatSidebarProps {
   agents: Agent[];
   /** Owner and runtime per agent, for grouping and the no-runtime flag. */
   roster: Map<string, AgentRoster>;
   sessionUserId: string | undefined;
   pinnedAgentIds: string[];
   threads: ChatThread[];
   archived: ChatThread[] | null;
   showArchived: boolean;
   onToggleArchived: () => void;
   activeId: string | null;
   onNewChat: (agent: Agent) => void;
   onTogglePinned: (agent: Agent) => void;
   onSelect: (thread: ChatThread) => void;
   onChanged: () => void;
   onStop: (thread: ChatThread) => void;
}

/**
 * Pinned agents, a picker for starting a conversation, and the conversations
 * themselves.
 *
 * The picker is grouped into the agents this person made and everyone else's,
 * because in a workspace with thirty agents "which of these is mine" is the
 * question the list is being scanned for.
 */
export function ChatSidebar({
   agents,
   roster,
   sessionUserId,
   pinnedAgentIds,
   threads,
   archived,
   showArchived,
   onToggleArchived,
   activeId,
   onNewChat,
   onTogglePinned,
   onSelect,
   onChanged,
   onStop,
}: ChatSidebarProps) {
   const t = useTranslations('agentsChat.chat');
   const coverage = useAgentCoverage();

   const pinned = pinnedAgentIds
      .map((id) => agents.find((agent) => agent.id === id))
      .filter((agent): agent is Agent => agent !== undefined)
      .slice(0, MAX_PINNED_AGENTS);

   const mine = agents.filter((agent) => roster.get(agent.id)?.ownerId === sessionUserId);
   const others = agents.filter((agent) => roster.get(agent.id)?.ownerId !== sessionUserId);

   const agentItem = (agent: Agent) => {
      const isPinned = pinnedAgentIds.includes(agent.id);
      const entry = roster.get(agent.id);
      // A roster that has not loaded says nothing, and neither does a null
      // binding on its own: an unbound agent runs on the workspace default.
      const noRuntime = entry !== undefined && !agentHasRuntime(coverage, agent.id);
      return (
         <DropdownMenuItem
            key={agent.id}
            className="group flex items-center justify-between gap-2"
            onSelect={() => onNewChat(agent)}
         >
            <span className="min-w-0 truncate">{agent.name}</span>
            <span className="flex flex-none items-center gap-2">
               {noRuntime ? (
                  <span className="text-[var(--shell-text-dim)]">{t('pickerNoRuntime')}</span>
               ) : null}
               <button
                  type="button"
                  aria-label={isPinned ? t('unpin') : t('pin')}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => {
                     event.preventDefault();
                     event.stopPropagation();
                     onTogglePinned(agent);
                  }}
               >
                  {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
               </button>
            </span>
         </DropdownMenuItem>
      );
   };

   return (
      <aside className="flex w-[218px] flex-none flex-col overflow-y-auto border-r border-[var(--shell-line)] bg-[var(--shell-rail)]">
         <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--shell-line)] px-4 py-1.5">
            <span className="font-medium">{t('title')}</span>
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <button
                     type="button"
                     aria-label={t('newChat')}
                     className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]"
                  >
                     <Plus className="size-3.5" />
                     new
                  </button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="max-h-96 min-w-60 overflow-y-auto">
                  {agents.length === 0 ? (
                     <DropdownMenuItem disabled>{t('pickerEmpty')}</DropdownMenuItem>
                  ) : null}
                  {mine.length > 0 ? (
                     <>
                        <DropdownMenuLabel>{t('pickerMine')}</DropdownMenuLabel>
                        {mine.map(agentItem)}
                     </>
                  ) : null}
                  {others.length > 0 ? (
                     <>
                        {mine.length > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel>{t('pickerOthers')}</DropdownMenuLabel>
                        {others.map(agentItem)}
                     </>
                  ) : null}
               </DropdownMenuContent>
            </DropdownMenu>
         </div>

         {pinned.length > 0 ? (
            <>
               <div className="px-[18px] pt-2 pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                  {t('pinned')}
               </div>
               <ul className="flex flex-col gap-px px-2">
                  {pinned.map((agent) => (
                     <li key={agent.id}>
                        <button
                           type="button"
                           onClick={() => onNewChat(agent)}
                           title={agent.name}
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

         <ChatSessions
            threads={threads}
            archived={archived}
            showArchived={showArchived}
            onToggleArchived={onToggleArchived}
            activeId={activeId}
            onSelect={onSelect}
            onChanged={onChanged}
            onStop={onStop}
         />
      </aside>
   );
}
