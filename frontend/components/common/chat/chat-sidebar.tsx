'use client';

import { BerryMark } from '@/components/layout/shell/shell-icon';
import type { ChatThread } from '@/lib/chat';
import type { Agent } from '@/lib/agents';

interface ChatSidebarProps {
   agents: Agent[];
   threads: ChatThread[];
   activeAgentId: string | null;
   onSelect: (agent: Agent) => void;
}

/**
 * Thread list, ported from `Berry Prototype.dc.html`.
 *
 * Agents are listed rather than threads: a conversation with an agent is
 * reached by choosing who to talk to, and the thread is opened on demand. That
 * keeps every available agent reachable instead of only the ones already
 * spoken to.
 */
export function ChatSidebar({ agents, threads, activeAgentId, onSelect }: ChatSidebarProps) {
   const counts = new Map(
      threads.filter((t) => t.agentId).map((t) => [t.agentId as string, t.messageCount])
   );

   return (
      <aside className="flex w-[218px] flex-none flex-col overflow-y-auto border-r border-[var(--shell-line)] bg-[var(--shell-rail)]">
         <div className="flex items-center gap-2.5 px-3.5 pt-4 pb-3.5">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="flex-none text-[var(--shell-text-dim)]" aria-hidden="true">
               <rect x="3" y="4" width="18" height="16" rx="2" />
               <path d="M9.5 4v16" />
            </svg>
            <span className="text-[var(--shell-text)]">Chat</span>
            <span className="ml-auto text-[var(--shell-text-dim)]">{agents.length}</span>
         </div>

         <div className="px-[18px] pt-2 pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            Direct
         </div>
         <ul className="flex flex-col gap-px px-2 pb-4">
            {agents.map((agent) => {
               const on = agent.id === activeAgentId;
               const count = counts.get(agent.id) ?? 0;
               return (
                  <li key={agent.id}>
                     <button
                        type="button"
                        onClick={() => onSelect(agent)}
                        aria-current={on ? 'true' : undefined}
                        className={[
                           'flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-left transition-colors',
                           on
                              ? 'bg-[var(--shell-surface)] text-[var(--shell-text)]'
                              : 'text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
                        ].join(' ')}
                     >
                        <BerryMark size={13} muted />
                        <span className="truncate">{agent.name}</span>
                        {count > 0 ? (
                           <span className="ml-auto text-[var(--shell-text-dim)] tabular-nums">
                              {count}
                           </span>
                        ) : null}
                     </button>
                  </li>
               );
            })}
            {agents.length === 0 ? (
               <li className="px-2.5 py-2 text-[var(--shell-text-dim)]">
                  No agents are available in this workspace.
               </li>
            ) : null}
         </ul>
      </aside>
   );
}
