'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAgentCoverage } from '@/hooks/use-agent-coverage';
import { agentHasRuntime } from '@/lib/runtimes';
import { toast } from 'sonner';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BerryApiError } from '@/lib/api';
import { loadAgentRoster, loadWorkspaceAgents, type Agent, type AgentRoster } from '@/lib/agents';
import {
   cancelSessionTask,
   createSession,
   deleteSession,
   getPinnedAgents,
   listMessages,
   listSessionTasks,
   listSuggestions,
   listTaskEvents,
   listThreads,
   markSessionRead,
   openAgentThread,
   renameSession,
   saveDraft,
   sendMessage,
   setPinnedAgents,
   setSessionArchived,
   type ChatMessage,
   type ChatSuggestion,
   type ChatTask,
   type ChatTaskEvent,
   type ChatThread,
} from '@/lib/chat';
import { subscribeWorkspaceEvents } from '@/lib/events';
import { useSessionStore } from '@/store/session-store';
import { ChatComposer } from './chat-composer';
import { ChatSidebar, MAX_PINNED_AGENTS } from './chat-sidebar';
import { ChatQueue } from './chat-tasks-panel';
import { ChatThread as ThreadView } from './chat-thread';

const PAGE = 50;

/**
 * Conversations with an agent, and the tasks they become.
 *
 * Sending never blocks: a message is queued as a task on the conversation's
 * agent, and the reply is appended when that task ends. The open conversation
 * lives in the URL, so a conversation can be linked to and comes back on a
 * reload — including from the agent pages, which link here with `?agent=`.
 */
export function Chat() {
   const t = useTranslations('agentsChat.chat');
   const coverage = useAgentCoverage();
   const router = useRouter();
   const pathname = usePathname();
   const searchParams = useSearchParams();
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const sessionUserId = useSessionStore((state) => state.user?.id);

   const [agents, setAgents] = useState<Agent[]>([]);
   const [roster, setRoster] = useState<Map<string, AgentRoster>>(new Map());
   const [pinnedAgentIds, setPinnedAgentIds] = useState<string[]>([]);
   const [threads, setThreads] = useState<ChatThread[]>([]);
   const [archived, setArchived] = useState<ChatThread[] | null>(null);
   const [showArchived, setShowArchived] = useState(false);
   const [active, setActive] = useState<ChatThread | null>(null);
   const [messages, setMessages] = useState<ChatMessage[]>([]);
   const [hasEarlier, setHasEarlier] = useState(false);
   const [loadingEarlier, setLoadingEarlier] = useState(false);
   const [tasks, setTasks] = useState<ChatTask[]>([]);
   const [suggestions, setSuggestions] = useState<ChatSuggestion[]>([]);
   const [regenerating, setRegenerating] = useState(false);
   const [steps, setSteps] = useState<Map<string, ChatTaskEvent[]>>(new Map());
   const [composer, setComposer] = useState('');
   const [sending, setSending] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [forbidden, setForbidden] = useState(false);
   const [offline, setOffline] = useState(false);
   const [renaming, setRenaming] = useState(false);
   const [title, setTitle] = useState('');

   const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
   const activeId = active?.id ?? null;
   const activeAgent = active?.agentId ? agents.find((a) => a.id === active.agentId) : undefined;

   const refreshThreads = useCallback(async () => {
      const found = await listThreads();
      setThreads(found);
      return found;
   }, []);

   const refreshArchived = useCallback(async () => {
      setArchived(await listThreads({ archived: true }).catch(() => []));
   }, []);

   /** Re-reads the open conversation's newest page and its queue. */
   const refreshSession = useCallback(async (id: string) => {
      const [page, queue] = await Promise.all([
         listMessages(id),
         listSessionTasks(id).catch(() => [] as ChatTask[]),
      ]);
      setMessages((current) => {
         const oldestNew = page[0]?.createdAt;
         const kept = oldestNew ? current.filter((message) => message.createdAt < oldestNew) : [];
         return [...kept, ...page];
      });
      setTasks(queue);
   }, []);

   const select = useCallback(
      async (thread: ChatThread) => {
         setActive(thread);
         setTitle(thread.topic);
         setError(null);
         setForbidden(false);
         setMessages([]);
         setTasks([]);
         setSuggestions([]);
         setSteps(new Map());
         setComposer(thread.draft ?? '');
         try {
            const page = await listMessages(thread.id);
            setMessages(page);
            setHasEarlier(page.length === PAGE);
            setTasks(await listSessionTasks(thread.id).catch(() => []));
            if (thread.agentId) {
               setSuggestions(await listSuggestions(thread.agentId).catch(() => []));
            }
            await markSessionRead(thread.id).catch(() => undefined);
            void refreshThreads().catch(() => undefined);
         } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('rowFailed'));
         }
      },
      [refreshThreads, t]
   );

   /** Puts the open conversation (and its agent) in the URL. */
   const show = useCallback(
      (thread: ChatThread | null) => {
         const params = new URLSearchParams(searchParams?.toString() ?? '');
         if (thread) {
            params.set('session', thread.id);
            if (thread.agentId) params.set('agent', thread.agentId);
            else params.delete('agent');
         } else {
            params.delete('session');
            params.delete('agent');
         }
         const next = params.toString();
         if (next !== (searchParams?.toString() ?? '')) {
            router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
         }
      },
      [pathname, router, searchParams]
   );

   useEffect(() => {
      let cancelled = false;
      void (async () => {
         try {
            const [loadedAgents, loadedThreads, pinned, entries] = await Promise.all([
               loadWorkspaceAgents(),
               listThreads(),
               getPinnedAgents().catch(() => [] as string[]),
               loadAgentRoster(7).catch(() => new Map<string, AgentRoster>()),
            ]);
            if (cancelled) return;
            setAgents(loadedAgents.filter((agent) => !agent.archivedAt));
            setThreads(loadedThreads);
            setPinnedAgentIds(pinned);
            setRoster(entries);
         } catch (cause) {
            if (!cancelled) setError(cause instanceof Error ? cause.message : t('rowFailed'));
         }
      })();
      return () => {
         cancelled = true;
      };
   }, [t]);

   // The URL is the source of truth for which conversation is open: a link
   // with `?session=`, and `?agent=` from anywhere that knows an agent but not
   // a conversation, both land here.
   const requestedSession = searchParams?.get('session') ?? null;
   const requestedAgent = searchParams?.get('agent') ?? null;
   useEffect(() => {
      if (requestedSession && requestedSession !== activeId) {
         let cancelled = false;
         void refreshThreads()
            .then(async (found) => {
               if (cancelled) return;
               const thread =
                  found.find((entry) => entry.id === requestedSession) ??
                  (await listThreads({ archived: true }).catch(() => []))?.find(
                     (entry) => entry.id === requestedSession
                  );
               if (thread) await select(thread);
            })
            .catch(() => undefined);
         return () => {
            cancelled = true;
         };
      }
      if (!requestedSession && requestedAgent && active?.agentId !== requestedAgent) {
         let cancelled = false;
         void openAgentThread(requestedAgent)
            .then(async (id) => {
               if (cancelled) return;
               const found = await refreshThreads();
               const thread = found.find((entry) => entry.id === id);
               if (thread) {
                  await select(thread);
                  show(thread);
               }
            })
            .catch((cause: unknown) => {
               if (!cancelled) {
                  setError(cause instanceof Error ? cause.message : t('rowFailed'));
               }
            });
         return () => {
            cancelled = true;
         };
      }
   }, [
      requestedSession,
      requestedAgent,
      activeId,
      active?.agentId,
      refreshThreads,
      select,
      show,
      t,
   ]);

   // Replies land when a task ends: re-read on run events, and poll while work
   // is waiting in case the event relay is not delivering.
   useEffect(() => {
      if (!activeId) return;
      return subscribeWorkspaceEvents((event) => {
         if (event.type.startsWith('run.') || event.type.startsWith('conversation.')) {
            void refreshSession(activeId).catch(() => undefined);
            void refreshThreads().catch(() => undefined);
         }
      });
   }, [activeId, refreshSession, refreshThreads]);

   useEffect(() => {
      if (!activeId || tasks.length === 0) return;
      const timer = setInterval(() => {
         void refreshSession(activeId).catch(() => undefined);
      }, 5000);
      return () => clearInterval(timer);
   }, [activeId, tasks.length, refreshSession]);

   useEffect(() => {
      const sync = () => setOffline(!navigator.onLine);
      sync();
      window.addEventListener('online', sync);
      window.addEventListener('offline', sync);
      return () => {
         window.removeEventListener('online', sync);
         window.removeEventListener('offline', sync);
      };
   }, []);

   // What the running reply is doing, from the newest event of its task.
   const running = tasks.find((task) => task.status === 'running');
   const [stage, setStage] = useState<string | null>(null);
   useEffect(() => {
      if (!activeId || !running) {
         setStage(null);
         return;
      }
      let cancelled = false;
      const read = () =>
         void listTaskEvents(activeId, running.id)
            .then((events) => {
               if (cancelled) return;
               const newest = events.at(-1);
               const type = newest?.type ?? '';
               setStage(
                  /tool|command|exec/i.test(type)
                     ? t('msgStageRunning')
                     : /message|output|write/i.test(type)
                       ? t('msgStageWriting')
                       : t('msgStageThinking')
               );
            })
            .catch(() => undefined);
      read();
      const timer = setInterval(read, 4000);
      return () => {
         cancelled = true;
         clearInterval(timer);
      };
   }, [activeId, running, t]);

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
         const found = await refreshThreads();
         const thread = found.find((entry) => entry.id === id);
         if (thread) {
            await select(thread);
            show(thread);
         }
      } catch (cause) {
         setError(cause instanceof BerryApiError ? cause.message : t('rowFailed'));
      }
   };

   const togglePinned = async (agent: Agent) => {
      const has = pinnedAgentIds.includes(agent.id);
      if (!has && pinnedAgentIds.length >= MAX_PINNED_AGENTS) {
         toast.info(t('pinnedFull'));
         return;
      }
      const next = has
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
      if (!activeId || messages.length === 0 || loadingEarlier) return;
      setLoadingEarlier(true);
      try {
         const older = await listMessages(activeId, messages[0]?.id);
         setHasEarlier(older.length === PAGE);
         setMessages((current) => [...older, ...current]);
      } finally {
         setLoadingEarlier(false);
      }
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
         if (cause instanceof BerryApiError && cause.status === 403) setForbidden(true);
         setError(
            cause instanceof BerryApiError && cause.code === 'AGENT_TASKS_UNAVAILABLE'
               ? t('bannerNoRuntime')
               : cause instanceof Error
                 ? cause.message
                 : t('rowFailed')
         );
      } finally {
         setSending(false);
         await refreshSession(activeId).catch(() => undefined);
         void refreshThreads().catch(() => undefined);
      }
   };

   const stop = async (thread: ChatThread) => {
      if (!thread.activeRunId) return;
      if (!window.confirm(t('stopConfirm'))) return;
      try {
         await cancelSessionTask(thread.id, thread.activeRunId);
         await refreshThreads();
         if (thread.id === activeId) await refreshSession(thread.id);
      } catch (cause) {
         toast.error(cause instanceof BerryApiError ? cause.message : t('rowFailed'));
      }
   };

   const requestSteps = (runId: string) => {
      if (!activeId || steps.has(runId)) return;
      void listTaskEvents(activeId, runId)
         .then((events) => setSteps((current) => new Map(current).set(runId, events)))
         .catch(() => setSteps((current) => new Map(current).set(runId, [])));
   };

   const regenerate = async () => {
      if (!active?.agentId) return;
      setRegenerating(true);
      try {
         setSuggestions(await listSuggestions(active.agentId));
      } catch {
         /* Suggestions are a nicety; a failure is not worth a banner. */
      } finally {
         setRegenerating(false);
      }
   };

   const agentName = active?.agentName ?? null;
   const noRuntime =
      active?.agentId !== undefined &&
      active?.agentId !== null &&
      roster.get(active.agentId) !== undefined &&
      !agentHasRuntime(coverage, active.agentId);

   const banner = offline
      ? t('bannerOffline')
      : agents.length === 0
        ? t('bannerNoAgents')
        : forbidden
          ? t('bannerNoPermission')
          : active?.archived
            ? t('bannerArchived')
            : noRuntime
              ? t('bannerNoRuntime')
              : null;

   return (
      <div className="flex h-full min-h-0 bg-[var(--shell-canvas)] text-[var(--shell-text)]">
         <ChatSidebar
            agents={agents}
            roster={roster}
            sessionUserId={sessionUserId}
            pinnedAgentIds={pinnedAgentIds}
            threads={threads}
            archived={archived}
            showArchived={showArchived}
            onToggleArchived={() => {
               const next = !showArchived;
               setShowArchived(next);
               if (next) void refreshArchived();
            }}
            activeId={activeId}
            onNewChat={(agent) => void newChat(agent)}
            onTogglePinned={(agent) => void togglePinned(agent)}
            onSelect={(thread) => {
               void select(thread);
               show(thread);
            }}
            onChanged={() => {
               void refreshThreads().catch(() => undefined);
               if (showArchived) void refreshArchived();
            }}
            onStop={(thread) => void stop(thread)}
         />

         <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex flex-none items-center gap-3 border-b border-[var(--shell-line)] px-6 py-3">
               {renaming && active ? (
                  <input
                     autoFocus
                     value={title}
                     aria-label={t('rename')}
                     onChange={(event) => setTitle(event.target.value)}
                     onBlur={() => setRenaming(false)}
                     onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                           setRenaming(false);
                           setTitle(active.topic);
                        }
                        if (event.key === 'Enter' && title.trim()) {
                           setRenaming(false);
                           void renameSession(active.id, title.trim())
                              .then(() => refreshThreads())
                              .catch((cause: unknown) =>
                                 toast.error(
                                    cause instanceof BerryApiError ? cause.message : t('rowFailed')
                                 )
                              );
                        }
                     }}
                     className="min-w-0 flex-1 rounded bg-[var(--shell-surface)] px-2 py-1 text-[var(--shell-text)] outline-none"
                  />
               ) : (
                  <button
                     type="button"
                     disabled={!active}
                     onClick={() => {
                        if (!active) return;
                        setTitle(active.topic);
                        setRenaming(true);
                     }}
                     className="min-w-0 truncate text-left text-[var(--shell-text)] disabled:cursor-default"
                  >
                     {active ? active.topic : t('title')}
                  </button>
               )}

               <p className="min-w-0 flex-1 truncate text-[var(--shell-text-dim)]">
                  {agentName ?? t('composerNoSession')}
               </p>

               {active ? (
                  <DropdownMenu>
                     <DropdownMenuTrigger asChild>
                        <button
                           type="button"
                           aria-label={t('title')}
                           className="flex-none rounded p-1 text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
                        >
                           <MoreHorizontal className="size-4" />
                        </button>
                     </DropdownMenuTrigger>
                     <DropdownMenuContent align="end">
                        {active.agentId ? (
                           <DropdownMenuItem asChild>
                              <Link href={`../agents/${active.agentId}`}>
                                 {t('headerOpenAgent')}
                              </Link>
                           </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onSelect={() => setRenaming(true)}>
                           {t('rename')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                           onSelect={() =>
                              void setSessionArchived(active.id, !active.archived)
                                 .then(() => {
                                    setActive(null);
                                    show(null);
                                    return refreshThreads();
                                 })
                                 .catch(() => undefined)
                           }
                        >
                           {active.archived ? t('unarchive') : t('archive')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                           onSelect={() => {
                              if (!window.confirm(t('deleteConfirm', { name: active.topic }))) {
                                 return;
                              }
                              void deleteSession(active.id)
                                 .then(() => {
                                    setActive(null);
                                    show(null);
                                    return refreshThreads();
                                 })
                                 .catch(() => undefined);
                           }}
                        >
                           {t('delete')}
                        </DropdownMenuItem>
                     </DropdownMenuContent>
                  </DropdownMenu>
               ) : null}
            </header>

            {banner ? (
               <p className="flex-none border-b border-[var(--shell-line)] bg-[var(--shell-surface)] px-6 py-2 text-[var(--shell-text-muted)]">
                  {banner}
               </p>
            ) : null}

            <ThreadView
               messages={messages}
               agentName={agentName}
               starters={activeAgent?.conversationStarters ?? []}
               suggestions={suggestions}
               onUseSuggestion={changeComposer}
               onRegenerate={() => void regenerate()}
               regenerating={regenerating}
               hasEarlier={hasEarlier}
               loadingEarlier={loadingEarlier}
               onLoadEarlier={() => void loadEarlier()}
               stepsFor={(runId) => steps.get(runId)}
               onRequestSteps={requestSteps}
               stage={stage}
            />

            {error ? (
               <p role="alert" className="flex-none px-6 pb-2 text-[var(--shell-accent)]">
                  {error}
               </p>
            ) : null}

            {activeId ? (
               <ChatQueue
                  conversationId={activeId}
                  tasks={tasks}
                  onChanged={() => void refreshSession(activeId).catch(() => undefined)}
               />
            ) : null}

            <ChatComposer
               value={composer}
               onChange={changeComposer}
               onSend={() => void send()}
               onStop={active?.activeRunId ? () => void stop(active) : null}
               queueing={tasks.length > 0}
               disabled={!activeId || sending}
               placeholder={
                  agentName ? t('composerPlaceholder', { name: agentName }) : t('composerNoSession')
               }
               workspaceId={workspaceId}
            />
         </section>
      </div>
   );
}
