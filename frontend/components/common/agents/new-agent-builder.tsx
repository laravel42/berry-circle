'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
   applyBuilderDraft,
   discardBuilderSession,
   sendBuilderTurn,
   startBuilderSession,
   type AgentDraft,
} from '@/lib/agent-builder';
import { BerryApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Turn {
   draftId: string;
   prompt: string;
   draft: AgentDraft;
   unknownSkills: string[];
}

interface NewAgentBuilderProps {
   /** Called when the builder cannot run here, so the page can switch to the manual form. */
   onUnavailable: () => void;
}

export default function NewAgentBuilder({ onUnavailable }: NewAgentBuilderProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const [sessionId, setSessionId] = useState<string | null>(null);
   const [turns, setTurns] = useState<Turn[]>([]);
   const [selected, setSelected] = useState<string | null>(null);
   const [prompt, setPrompt] = useState('');
   const [busy, setBusy] = useState(false);
   const [notice, setNotice] = useState<string | null>(null);

   const shown = turns.find((turn) => turn.draftId === selected) ?? turns.at(-1) ?? null;

   const draft = async () => {
      setBusy(true);
      setNotice(null);
      try {
         const id = sessionId ?? (await startBuilderSession()).id;
         setSessionId(id);
         const result = await sendBuilderTurn(id, prompt.trim());
         setTurns((current) => [...current, { ...result, prompt: prompt.trim() }]);
         setSelected(result.draftId);
         setPrompt('');
      } catch (error) {
         if (error instanceof BerryApiError && error.code === 'AGENT_BUILDER_UNAVAILABLE') {
            toast.error("The AI builder needs the agent runtime. Use 'Set it up yourself'.");
            onUnavailable();
         } else {
            toast.error(error instanceof BerryApiError ? error.message : 'The builder could not draft an agent.');
         }
      } finally {
         setBusy(false);
      }
   };

   const create = async () => {
      if (!sessionId || !shown) return;
      setBusy(true);
      try {
         const { agentId } = await applyBuilderDraft(sessionId, shown.draftId);
         toast.success(`Created ${shown.draft.name}`);
         router.push(`/${orgId}/agents/${agentId}`);
      } catch (error) {
         if (error instanceof BerryApiError && error.code === 'MCP_SETTINGS_REQUIRED') {
            // The session stays open, so another turn can drop the servers.
            setNotice(
               'This draft adds MCP servers, which only workspace admins can add. Ask the builder to drop them, or ask an admin.'
            );
         } else {
            toast.error(error instanceof BerryApiError ? error.message : 'The agent could not be created.');
         }
      } finally {
         setBusy(false);
      }
   };

   const startOver = async () => {
      if (sessionId) await discardBuilderSession(sessionId).catch(() => undefined);
      setSessionId(null);
      setTurns([]);
      setSelected(null);
      setNotice(null);
   };

   return (
      <div className="grid gap-6 lg:grid-cols-2">
         <div className="flex flex-col gap-3">
            <Textarea
               rows={5}
               value={prompt}
               onChange={(event) => setPrompt(event.target.value)}
               placeholder={
                  turns.length === 0
                     ? 'Describe the agent: what it works on, what it produces, what it should avoid.'
                     : 'What should change in the draft?'
               }
               aria-label="Describe the agent"
            />
            <div className="flex items-center gap-2">
               <Button size="sm" disabled={busy || prompt.trim() === ''} onClick={() => void draft()}>
                  {turns.length === 0 ? 'Draft' : 'Refine'}
               </Button>
               {sessionId ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void startOver()}>
                     Start over
                  </Button>
               ) : null}
            </div>
            {turns.length > 0 ? (
               <ol className="flex flex-col gap-1">
                  {turns.map((turn, index) => (
                     <li key={turn.draftId}>
                        <button
                           type="button"
                           onClick={() => setSelected(turn.draftId)}
                           className={cn(
                              'w-full truncate rounded-md px-2 py-1 text-left hover:bg-sidebar/50',
                              shown?.draftId === turn.draftId && 'bg-muted/50'
                           )}
                        >
                           {index + 1}. {turn.prompt}
                        </button>
                     </li>
                  ))}
               </ol>
            ) : null}
         </div>

         <div className="flex flex-col gap-3 rounded-md border border-border p-4">
            {shown ? (
               <>
                  <div>
                     <p className="font-medium">{shown.draft.name}</p>
                     {shown.draft.description ? (
                        <p className="text-muted-foreground">{shown.draft.description}</p>
                     ) : null}
                  </div>
                  <div className="flex flex-col gap-1">
                     <span className="text-muted-foreground">Instructions</span>
                     <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-2 font-sans">
                        {shown.draft.instructions || '(none)'}
                     </pre>
                  </div>
                  {shown.draft.skills.length > 0 ? (
                     <div className="flex flex-col gap-1">
                        <span className="text-muted-foreground">Skills</span>
                        <div className="flex flex-wrap gap-2">
                           {shown.draft.skills.map((skill) => {
                              const unknown = shown.unknownSkills.includes(skill);
                              return (
                                 <span
                                    key={skill}
                                    title={unknown ? 'Not in this workspace — will be skipped' : undefined}
                                    className={cn(
                                       'rounded-md border border-border/70 px-2 py-0.5',
                                       unknown && 'text-muted-foreground line-through'
                                    )}
                                 >
                                    {skill}
                                 </span>
                              );
                           })}
                        </div>
                        {shown.unknownSkills.length > 0 ? (
                           <p className="text-muted-foreground">
                              Struck-through skills are not in this workspace and will be skipped.
                           </p>
                        ) : null}
                     </div>
                  ) : null}
                  {shown.draft.mcp.length > 0 ? (
                     <div className="flex flex-col gap-1">
                        <span className="text-muted-foreground">MCP servers</span>
                        <ul>
                           {shown.draft.mcp.map((server) => (
                              <li key={server.name} className="truncate">
                                 {server.name} · {server.url}
                              </li>
                           ))}
                        </ul>
                     </div>
                  ) : null}
                  {shown.draft.model ? (
                     <p className="text-muted-foreground">
                        Suggested model: {shown.draft.model}. Set it on the Model tab after creating.
                     </p>
                  ) : null}
                  {notice ? <p className="rounded-md bg-muted/40 px-3 py-2">{notice}</p> : null}
                  <Button size="sm" className="w-fit" disabled={busy} onClick={() => void create()}>
                     Create agent
                  </Button>
               </>
            ) : (
               <p className="text-muted-foreground">The draft appears here.</p>
            )}
         </div>
      </div>
   );
}
