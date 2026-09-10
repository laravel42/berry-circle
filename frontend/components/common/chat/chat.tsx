'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SendHorizonal } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

import { BerryApiError } from '@/lib/api';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import {
   createSession,
   getPinnedAgents,
   listMessages,
   listSessionTasks,
   listSuggestions,
   listThreads,
   markSessionRead,
   openAgentThread,
   saveDraft,
   sendMessage,
   setPinnedAgents,
   type ChatMessage,
   type ChatSuggestion,
   type ChatTask,
   type ChatThread,
} from '@/lib/chat';
import { subscribeWorkspaceEvents } from '@/lib/events';
import { ChatSidebar } from './chat-sidebar';
import { ChatTasksPanel, TaskStepsSheet } from './chat-tasks-panel';
import { ChatThread as ThreadView } from './chat-thread';

const PAGE = 50;

/**
 * Chat sessions whose messages run as agent tasks.
 *
 * Sending never blocks: a message is queued as a task on the session's agent,
 * and the reply is appended when that task ends. The view re-reads the open
 * session on `run.*` events, and polls while tasks are waiting, because the
 * event relay may be absent.
 */
export function Chat() {
   const [agents, setAgents] = useState<Agent[]>([]);
   const [pinnedAgentIds, setPinnedAgentIds] = useState<string[]>([]);
   const [threads, setThreads] = useState<ChatThread[]>([]);
   const [active, setActive] = useState<ChatThread | null>(null);
   const [messages, setMessages] = useState<ChatMessage[]>([]);
   const [hasEarlier, setHasEarlier] = useState(false);
   const [tasks, setTasks] = useState<ChatTask[]>([]);
   const [suggestions, setSuggestions] = useState<ChatSuggestion[]>([]);
   const [composer, setComposer] = useState('');
   const [sending, setSending] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [stepsRunId, setStepsRunId] = useState<string | null>(null);
   const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
   const activeId = active?.id ?? null;

   const refreshThreads = useCallback(async () => {
      const found = await listThreads();
      setThreads(found);
      return found;
   }, []);

   /** Re-reads the open session's newest page and its task queue. */
   const refreshSession = useCallback(async (id: string) => {
      const [page, queue] = await Promise.all([listMessages(id), listSessionTasks(id).catch(() => [])]);
      setMessages((current) => {
         // Keep earlier pages already loaded; replace the newest page.
         const oldestNew = page[0]?.createdAt;
         const kept = oldestNew ? current.filter((message) => message.createdAt < oldestNew) : [];
         return [...kept, ...page];
      });
      setTasks(queue);
   }, []);

   const select = useCallback(
      async (thread: ChatThread) => {
         setActive(thread);
         setError(null);
         setMessages([]);
         setTasks([]);
         setSuggestions([]);
         // Draft restore: what the person had typed in this session comes back.
         setComposer(thread.draft ?? '');
         try {
            const page = await listMessages(thread.id);
            setMessages(page);
            setHasEarlier(page.length === PAGE);
            setTasks(await listSessionTasks(thread.id).catch(() => []));
            if (thread.agentId) setSuggestions(await listSuggestions(thread.agentId).catch(() => []));
            await markSessionRead(thread.id).catch(() => undefined);
            void refreshThreads().catch(() => undefined);
         } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not open the session');
         }
      },
      [refreshThreads]
   );

   const selectById = useCallback(
      async (id: string) => {
         const found = await refreshThreads();
         const thread = found.find((entry) => entry.id === id);
         if (thread) await select(thread);
      },
      [refreshThreads, select]
   );

   useEffect(() => {
      let cancelled = false;
      void (async () => {
         try {
            const [loadedAgents, loadedThreads, pinned] = await Promise.all([
               loadWorkspaceAgents(),
               listThreads(),
               getPinnedAgents().catch(() => []),
            ]);
            if (cancelled) return;
            // Only agents the runtime reports as available can answer.
            setAgents(loadedAgents.filter((item) => item.status === 'available'));
            setThreads(loadedThreads);
            setPinnedAgentIds(pinned);
         } catch (cause) {
            if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load chat');
         }
      })();
      return () => {
         cancelled = true;
      };
   }, []);

   // A search result or a link can name the agent to open: `/chat?agent=…`
   // opens that agent's latest session, or a new one. Keyed on the URL, so it
   // also works when the link is followed from within chat.
   const requestedAgentId = useSearchParams()?.get('agent') ?? null;
   const activeAgentId = active?.agentId ?? null;
   useEffect(() => {
      if (!requestedAgentId || activeAgentId === requestedAgentId) return;
      let cancelled = false;
      void openAgentThread(requestedAgentId)
         .then((id) => (cancelled ? undefined : selectById(id)))
         .catch((cause: unknown) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not open the conversation');
         });
      return () => {
         cancelled = true;
      };
   }, [requestedAgentId, activeAgentId, selectById]);

   // Replies land when a task ends: re-read on run events, and poll while
   // tasks are waiting in case the relay is not delivering events.
   useEffect(() => {
      if (!activeId) return;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (event.type.startsWith('run.') || event.type.startsWith('conversation.')) {
            void refreshSession(activeId).catch(() => undefined);
            void refreshThreads().catch(() => undefined);
         }
      });
      return unsubscribe;
   }, [activeId, refreshSession, refreshThreads]);

   useEffect(() => {
      if (!activeId || tasks.length === 0) return;
      const timer = setInterval(() => {
         void refreshSession(activeId).catch(() => undefined);
      }, 5000);
      return () => clearInterval(timer);
   }, [activeId, tasks.length, refreshSession]);

   const changeComposer = (value: string) => {
      setComposer(value);
      if (!activeId) return;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      const id = activeId;
      draftTimer.current = setTimeout(() => {
         void saveDraft(id, value).catch(() => undefined);
      }, 600);
   };

   const newChat = async (agent: Agent) => {
      try {
         const id = await createSession(agent.id);
         await selectById(id);
      } catch (cause) {
         setError(cause instanceof BerryApiError ? cause.message : 'Could not start a session');
      }
   };

   const togglePinned = async (agent: Agent) => {
      const next = pinnedAgentIds.includes(agent.id)
         ? pinnedAgentIds.filter((id) => id !== agent.id)
         : [...pinnedAgentIds, agent.id];
      setPinnedAgentIds(next);
      try {
         setPinnedAgentIds(await setPinnedAgents(next));
      } catch {
         setPinnedAgentIds(await getPinnedAgents().catch(() => pinnedAgentIds));
      }
   };

   const loadEarlier = async () => {
      if (!activeId || messages.length === 0) return;
      const older = await listMessages(activeId, messages[0]?.id);
      setHasEarlier(older.length === PAGE);
      setMessages((current) => [...older, ...current]);
   };

   const send = async () => {
      const text = composer.trim();
      if (!text || !activeId || sending) return;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      setSending(true);
      setError(null);
      setComposer('');
      try {
         await sendMessage(activeId, text);
      } catch (cause) {
         setError(
            cause instanceof BerryApiError && cause.code === 'AGENT_TASKS_UNAVAILABLE'
               ? 'Your message was kept, but this server cannot run agent tasks yet.'
               : cause instanceof Error
                 ? cause.message
                 : 'The message could not be sent'
         );
      } finally {
         setSending(false);
         await refreshSession(activeId).catch(() => undefined);
         void refreshThreads().catch(() => undefined);
      }
   };

   const agentName = active?.agentName ?? null;

   return (
      <div className="flex h-full min-h-0 bg-[var(--shell-canvas)] text-[var(--shell-text)]">
         <ChatSidebar
            agents={agents}
            pinnedAgentIds={pinnedAgentIds}
            threads={threads}
            activeId={activeId}
            onNewChat={(agent) => void newChat(agent)}
            onTogglePinned={(agent) => void togglePinned(agent)}
            onSelect={(thread) => void select(thread)}
            onChanged={() => void refreshThreads().catch(() => undefined)}
         />

         <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex flex-none items-baseline gap-3 border-b border-[var(--shell-line)] px-6 py-3">
               <h2 className="text-[var(--shell-text)]">{active ? active.topic : 'Chat'}</h2>
               <p className="min-w-0 truncate text-[var(--shell-text-dim)]">
                  {agentName ? `with ${agentName}` : 'Start a session with a workspace agent'}
               </p>
            </header>

            <ThreadView
               messages={messages}
               agentName={agentName}
               onLoadEarlier={hasEarlier ? () => void loadEarlier() : null}
               onViewSteps={setStepsRunId}
            />

            {active && messages.length === 0 && suggestions.length > 0 ? (
               <div className="flex flex-none flex-wrap gap-2 px-6 pb-3">
                  {suggestions.map((suggestion) => (
                     <button
                        key={suggestion.label}
                        type="button"
                        onClick={() => changeComposer(suggestion.prompt)}
                        className="rounded-[5px] bg-[var(--shell-line)] px-2.5 py-1 text-[var(--shell-text-muted)] hover:text-[var(--shell-text)]"
                     >
                        {suggestion.label}
                     </button>
                  ))}
               </div>
            ) : null}

            {error ? (
               <p role="alert" className="px-6 pb-2 text-[var(--shell-accent)]">
                  {error}
               </p>
            ) : null}

            {activeId ? (
               <ChatTasksPanel
                  conversationId={activeId}
                  tasks={tasks}
                  onChanged={() => void refreshSession(activeId).catch(() => undefined)}
                  onViewSteps={setStepsRunId}
               />
            ) : null}

            <form
               className="flex flex-none items-center gap-2 border-t border-[var(--shell-line)] px-6 py-3"
               onSubmit={(event) => {
                  event.preventDefault();
                  void send();
               }}
            >
               <input
                  value={composer}
                  onChange={(event) => changeComposer(event.target.value)}
                  disabled={!activeId}
                  placeholder={agentName ? `message ${agentName}…` : 'start a session to chat'}
                  aria-label="Message"
                  className="min-w-0 flex-1 bg-transparent text-[var(--shell-text)] outline-none [--input-color:var(--shell-text)] [--placeholder-color:var(--shell-text-dim)] placeholder:text-[var(--shell-text-dim)] disabled:cursor-not-allowed"
               />
               <button
                  type="submit"
                  disabled={!activeId || sending || composer.trim() === ''}
                  className="flex flex-none cursor-pointer items-center gap-1.5 rounded-[5px] bg-[var(--shell-line)] px-2.5 py-1 text-[var(--shell-text-muted)] transition-colors hover:bg-[var(--shell-line-strong)] hover:text-[var(--shell-text)] disabled:cursor-not-allowed disabled:opacity-40"
               >
                  <SendHorizonal className="size-3.5" />
                  {tasks.length > 0 ? 'queue' : 'send'}
               </button>
            </form>
         </section>

         {activeId ? (
            <TaskStepsSheet conversationId={activeId} runId={stepsRunId} onClose={() => setStepsRunId(null)} />
         ) : null}
      </div>
   );
}
