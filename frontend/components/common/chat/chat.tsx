'use client';

import { useCallback, useEffect, useState } from 'react';
import { SendHorizonal } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import {
   listMessages,
   listThreads,
   openAgentThread,
   sendMessage,
   type ChatMessage,
   type ChatThread,
} from '@/lib/chat';
import { ChatSidebar } from './chat-sidebar';
import { ChatThread as ThreadView } from './chat-thread';

/**
 * Chat, ported from `Berry Prototype.dc.html`.
 *
 * Sending blocks until the agent answers, because the server calls the
 * runtime's blocking endpoint — there is no partial output to stream, so the
 * composer disables and the thread shows a pending turn rather than pretending
 * to be live.
 */
export function Chat() {
   const [agents, setAgents] = useState<Agent[]>([]);
   const [threads, setThreads] = useState<ChatThread[]>([]);
   const [agent, setAgent] = useState<Agent | null>(null);
   const [conversationId, setConversationId] = useState<string | null>(null);
   const [messages, setMessages] = useState<ChatMessage[]>([]);
   const [draft, setDraft] = useState('');
   const [pending, setPending] = useState(false);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      let cancelled = false;
      void (async () => {
         try {
            const [loadedAgents, loadedThreads] = await Promise.all([
               loadWorkspaceAgents(),
               listThreads(),
            ]);
            if (cancelled) return;
            // Only agents the runtime reports as available can answer; listing
            // an offline one invites a message that will never get a reply.
            setAgents(loadedAgents.filter((item) => item.status === 'available'));
            setThreads(loadedThreads);
         } catch (cause) {
            if (!cancelled) {
               setError(cause instanceof Error ? cause.message : 'Could not load chat');
            }
         }
      })();
      return () => {
         cancelled = true;
      };
   }, []);

   const select = useCallback(async (next: Agent) => {
      setAgent(next);
      setError(null);
      setMessages([]);
      try {
         const id = await openAgentThread(next.id);
         setConversationId(id);
         setMessages(await listMessages(id));
      } catch (cause) {
         setError(cause instanceof Error ? cause.message : 'Could not open the conversation');
      }
   }, []);

   // A search result or a link can name the agent to open: `/chat?agent=…`.
   // Waits for the agent list, and only opens an agent that can answer.
   const searchParams = useSearchParams();
   const requestedAgentId = searchParams?.get('agent') ?? null;
   useEffect(() => {
      if (!requestedAgentId || agent?.id === requestedAgentId) return;
      const match = agents.find((item) => item.id === requestedAgentId);
      if (match) void select(match);
   }, [requestedAgentId, agents, agent?.id, select]);

   const send = useCallback(async () => {
      const text = draft.trim();
      if (!text || !conversationId || pending) return;
      setDraft('');
      setPending(true);
      setError(null);
      // Show the turn immediately. The server has already committed it by the
      // time it calls the agent, so this is optimistic only about ordering.
      const optimistic: ChatMessage = {
         id: `pending-${Date.now()}`,
         authorType: 'user',
         authorName: 'You',
         body: text,
         channel: 'in_app',
         createdAt: new Date().toISOString(),
      };
      setMessages((current) => [...current, optimistic]);
      try {
         await sendMessage(conversationId, text);
      } catch (cause) {
         setError(cause instanceof Error ? cause.message : 'The agent could not be reached');
      } finally {
         setPending(false);
         try {
            // Re-read rather than append: this replaces the optimistic turn
            // with the stored one and picks up the reply in a single pass.
            setMessages(await listMessages(conversationId));
            setThreads(await listThreads());
         } catch {
            // The turn is durable server-side; a failed refresh is cosmetic.
         }
      }
   }, [conversationId, draft, pending]);

   return (
      <div className="flex h-full min-h-0 bg-[var(--shell-canvas)] text-[var(--shell-text)]">
         <ChatSidebar
            agents={agents}
            threads={threads}
            activeAgentId={agent?.id ?? null}
            onSelect={(next) => void select(next)}
         />

         <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex flex-none items-baseline gap-3 border-b border-[var(--shell-line)] px-6 py-3">
               <h2 className="text-[var(--shell-text)]">
                  {agent ? agent.name : 'Chat'}
               </h2>
               <p className="min-w-0 truncate text-[var(--shell-text-dim)]">
                  {agent?.description ?? 'Direct conversation with a workspace agent'}
               </p>
            </header>

            <ThreadView messages={messages} pending={pending} agentName={agent?.name ?? null} />

            {error ? (
               <p role="alert" className="px-6 pb-2 text-[var(--shell-accent)]">
                  {error}
               </p>
            ) : null}

            <form
               className="flex flex-none items-center gap-2 border-t border-[var(--shell-line)] px-6 py-3"
               onSubmit={(event) => {
                  event.preventDefault();
                  void send();
               }}
            >
               <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={!conversationId || pending}
                  placeholder={agent ? `message ${agent.name}…` : 'pick an agent to start'}
                  aria-label="Message"
                  className="min-w-0 flex-1 bg-transparent text-[var(--shell-text)] outline-none [--input-color:var(--shell-text)] [--placeholder-color:var(--shell-text-dim)] placeholder:text-[var(--shell-text-dim)] disabled:cursor-not-allowed"
               />
               <button
                  type="submit"
                  disabled={!conversationId || pending || draft.trim() === ''}
                  className="flex flex-none cursor-pointer items-center gap-1.5 rounded-[5px] bg-[var(--shell-line)] px-2.5 py-1 text-[var(--shell-text-muted)] transition-colors hover:bg-[var(--shell-line-strong)] hover:text-[var(--shell-text)] disabled:cursor-not-allowed disabled:opacity-40"
               >
                  <SendHorizonal className="size-3.5" />
                  {pending ? 'waiting…' : 'send'}
               </button>
            </form>
         </section>
      </div>
   );
}
