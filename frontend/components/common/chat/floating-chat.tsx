'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import { ChevronDown, Maximize2, Minus, MessageSquare, Minimize2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import {
   listMessages,
   listSessionTasks,
   listThreads,
   markSessionRead,
   openAgentThread,
   sendMessage,
   type ChatMessage,
   type ChatTask,
   type ChatThread,
} from '@/lib/chat';
import { useShortcut } from '@/components/layout/shortcut-provider';
import { subscribeWorkspaceEvents } from '@/lib/events';
import { useSessionStore } from '@/store/session-store';
import { useUiPrefsStore } from '@/store/ui-prefs-store';
import { ChatComposer } from './chat-composer';
import { ChatThread as ThreadView } from './chat-thread';

type WindowState = 'closed' | 'open' | 'minimised' | 'expanded';

const SIZE_KEY = 'berry.floating-chat.size';
const MIN_WIDTH = 320;
const MIN_HEIGHT = 320;

/**
 * Chat without leaving the page.
 *
 * The point of this window is that the conversation is *next to* the work
 * rather than instead of it, so it deliberately does not try to be the chat
 * page: no queue panel, no archive, no session management. Anything beyond
 * saying something to an agent sends the reader to `/chat`, which is one click
 * away in the header.
 *
 * mod+J toggles it. The binding is registered here rather than through a
 * shared shortcut registry because this branch has none; when one lands, this
 * handler is what moves into it.
 */
export function FloatingChat() {
   const t = useTranslations('agentsChat.floating');
   const chat = useTranslations('agentsChat.chat');
   const pathname = usePathname() ?? '';
   const { orgId } = useParams<{ orgId?: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id);

   const [state, setState] = useState<WindowState>('closed');
   const [size, setSize] = useState({ width: 380, height: 520 });
   const [agents, setAgents] = useState<Agent[]>([]);
   const [threads, setThreads] = useState<ChatThread[]>([]);
   const [active, setActive] = useState<ChatThread | null>(null);
   const [messages, setMessages] = useState<ChatMessage[]>([]);
   const [tasks, setTasks] = useState<ChatTask[]>([]);
   const [composer, setComposer] = useState('');
   const [sending, setSending] = useState(false);
   const resizing = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

   // The chat page is the full version of this; two of them on one screen
   // would be two places to type the same message.
   // Preferences → General turns the window off entirely; the chat page is
   // this window's full-size counterpart, so it never floats over itself.
   const floatingEnabled = useUiPrefsStore((state) => state.floatingChat);
   const hidden = pathname.includes('/chat') || !floatingEnabled;

   useEffect(() => {
      try {
         const stored = localStorage.getItem(SIZE_KEY);
         if (stored) {
            const parsed = JSON.parse(stored) as { width?: number; height?: number };
            setSize({
               width: Math.max(MIN_WIDTH, Number(parsed.width) || 380),
               height: Math.max(MIN_HEIGHT, Number(parsed.height) || 520),
            });
         }
      } catch {
         /* A size that cannot be read is simply the default size. */
      }
   }, []);

   // The shell's registry owns the combination, so it is rebindable in
   // settings and appears there with everything else. This claims the action.
   useShortcut('chat.toggleFloating', () =>
      setState((current) => (current === 'closed' ? 'open' : 'closed'))
   );

   const opened = state !== 'closed' && !hidden;

   useEffect(() => {
      if (!opened || agents.length > 0) return;
      void loadWorkspaceAgents()
         .then((found) => setAgents(found.filter((agent) => !agent.archivedAt)))
         .catch(() => undefined);
      void listThreads()
         .then(setThreads)
         .catch(() => undefined);
   }, [opened, agents.length]);

   const openThread = useCallback(async (thread: ChatThread) => {
      setActive(thread);
      setComposer(thread.draft ?? '');
      setMessages(await listMessages(thread.id).catch(() => []));
      setTasks(await listSessionTasks(thread.id).catch(() => []));
      await markSessionRead(thread.id).catch(() => undefined);
   }, []);

   const withAgent = async (agent: Agent) => {
      try {
         const id = await openAgentThread(agent.id);
         const found = await listThreads();
         setThreads(found);
         const thread = found.find((entry) => entry.id === id);
         if (thread) await openThread(thread);
      } catch {
         /* Reported by the page's own chat; a floating window stays quiet. */
      }
   };

   const activeId = active?.id ?? null;
   useEffect(() => {
      if (!opened || !activeId) return;
      return subscribeWorkspaceEvents((event) => {
         if (!event.type.startsWith('run.') && !event.type.startsWith('conversation.')) return;
         void listMessages(activeId)
            .then(setMessages)
            .catch(() => undefined);
         void listSessionTasks(activeId)
            .then(setTasks)
            .catch(() => undefined);
      });
   }, [opened, activeId]);

   const send = async () => {
      const text = composer.trim();
      if (!text || !activeId || sending) return;
      setSending(true);
      setComposer('');
      try {
         await sendMessage(activeId, text);
      } catch {
         /* The reply that never comes is the report. */
      } finally {
         setSending(false);
         setMessages(await listMessages(activeId).catch(() => messages));
         setTasks(await listSessionTasks(activeId).catch(() => []));
      }
   };

   const onResize = (event: React.PointerEvent<HTMLButtonElement>) => {
      resizing.current = { x: event.clientX, y: event.clientY, ...size };
      const move = (moveEvent: PointerEvent) => {
         const from = resizing.current;
         if (!from) return;
         // The window grows up and to the left, because it is anchored to the
         // bottom-right corner of the viewport.
         setSize({
            width: Math.max(MIN_WIDTH, from.width + (from.x - moveEvent.clientX)),
            height: Math.max(MIN_HEIGHT, from.height + (from.y - moveEvent.clientY)),
         });
      };
      const done = () => {
         resizing.current = null;
         window.removeEventListener('pointermove', move);
         window.removeEventListener('pointerup', done);
         try {
            localStorage.setItem(SIZE_KEY, JSON.stringify(size));
         } catch {
            /* Not being able to remember the size is not a failure worth reporting. */
         }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', done);
   };

   if (hidden) return null;

   if (state === 'closed') {
      return (
         <button
            type="button"
            onClick={() => setState('open')}
            aria-label={t('open')}
            title={t('shortcutHint', { keys: '⌘J' })}
            className="fixed bottom-4 right-4 z-40 flex size-10 items-center justify-center rounded-full border border-[var(--shell-line)] bg-[var(--shell-surface)] text-[var(--shell-text-muted)] shadow-lg transition-colors hover:text-[var(--shell-text)]"
         >
            <MessageSquare className="size-4" />
         </button>
      );
   }

   const expanded = state === 'expanded';
   const minimised = state === 'minimised';

   return (
      <div
         // Full-screen below `sm`: a 380px panel on a phone is the whole
         // screen anyway, and pretending otherwise only adds a border.
         className={[
            'fixed z-40 flex flex-col overflow-hidden border border-[var(--shell-line)] bg-[var(--shell-canvas)] text-[var(--shell-text)] shadow-lg',
            'inset-0 sm:inset-auto sm:bottom-4 sm:right-4 sm:rounded-lg',
            expanded ? 'sm:inset-4 sm:h-auto sm:w-auto' : '',
         ].join(' ')}
         style={
            expanded || minimised
               ? undefined
               : {
                    width: `min(${size.width}px, calc(100vw - 2rem))`,
                    height: `min(${size.height}px, calc(100vh - 2rem))`,
                 }
         }
      >
         <header className="flex flex-none items-center gap-2 border-b border-[var(--shell-line)] px-3 py-2">
            {!expanded && !minimised ? (
               <button
                  type="button"
                  onPointerDown={onResize}
                  aria-label={t('expand')}
                  className="hidden size-4 flex-none cursor-nwse-resize text-[var(--shell-text-dim)] sm:block"
               >
                  <Minimize2 className="size-3.5 rotate-90" aria-hidden />
               </button>
            ) : null}

            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <button
                     type="button"
                     className="flex min-w-0 flex-1 items-center gap-1 truncate text-left text-[var(--shell-text)]"
                  >
                     <span className="truncate">{active ? active.topic : t('title')}</span>
                     <ChevronDown className="size-3.5 flex-none text-[var(--shell-text-dim)]" />
                  </button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
                  <DropdownMenuLabel>{t('history')}</DropdownMenuLabel>
                  {threads.length === 0 ? (
                     <DropdownMenuItem disabled>{chat('noSessions')}</DropdownMenuItem>
                  ) : (
                     threads.slice(0, 8).map((thread) => (
                        <DropdownMenuItem key={thread.id} onSelect={() => void openThread(thread)}>
                           <span className="truncate">{thread.topic}</span>
                        </DropdownMenuItem>
                     ))
                  )}
                  <DropdownMenuLabel>{t('pickAgent')}</DropdownMenuLabel>
                  {agents.length === 0 ? (
                     <DropdownMenuItem disabled>{chat('pickerEmpty')}</DropdownMenuItem>
                  ) : (
                     agents.slice(0, 12).map((agent) => (
                        <DropdownMenuItem key={agent.id} onSelect={() => void withAgent(agent)}>
                           <span className="truncate">{agent.name}</span>
                        </DropdownMenuItem>
                     ))
                  )}
               </DropdownMenuContent>
            </DropdownMenu>

            {orgId ? (
               <Link
                  href={`/${orgId}/chat${active ? `?session=${active.id}` : ''}`}
                  className="flex-none text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
               >
                  {t('openFull')}
               </Link>
            ) : null}

            <button
               type="button"
               aria-label={minimised ? t('restore') : t('minimise')}
               onClick={() => setState(minimised ? 'open' : 'minimised')}
               className="flex-none rounded p-1 text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
            >
               <Minus className="size-3.5" />
            </button>
            <button
               type="button"
               aria-label={expanded ? t('restore') : t('expand')}
               onClick={() => setState(expanded ? 'open' : 'expanded')}
               className="hidden flex-none rounded p-1 text-[var(--shell-text-dim)] hover:text-[var(--shell-text)] sm:block"
            >
               <Maximize2 className="size-3.5" />
            </button>
            <button
               type="button"
               aria-label={t('close')}
               onClick={() => setState('closed')}
               className="flex-none rounded p-1 text-[var(--shell-text-dim)] hover:text-[var(--shell-text)]"
            >
               <X className="size-3.5" />
            </button>
         </header>

         {minimised ? null : (
            <>
               <ThreadView
                  messages={messages}
                  agentName={active?.agentName ?? null}
                  starters={[]}
                  suggestions={[]}
                  onUseSuggestion={setComposer}
                  onRegenerate={() => undefined}
                  regenerating={false}
                  hasEarlier={false}
                  loadingEarlier={false}
                  onLoadEarlier={() => undefined}
                  stepsFor={() => undefined}
                  onRequestSteps={() => undefined}
                  stage={
                     tasks.some((task) => task.status === 'running') ? chat('rowWorking') : null
                  }
               />
               <ChatComposer
                  value={composer}
                  onChange={setComposer}
                  onSend={() => void send()}
                  onStop={null}
                  queueing={tasks.length > 0}
                  disabled={!activeId || sending}
                  placeholder={
                     active?.agentName
                        ? chat('composerPlaceholder', { name: active.agentName })
                        : chat('composerNoSession')
                  }
                  workspaceId={workspaceId}
               />
            </>
         )}
      </div>
   );
}
