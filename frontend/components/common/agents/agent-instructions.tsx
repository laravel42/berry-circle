'use client';

import { useEffect, useRef, useState } from 'react';

import { MarkdownPreviewTextarea } from '@/components/common/editor/markdown-preview-textarea';
import { updateAgentInstructions } from '@/lib/agents';

interface AgentInstructionsProps {
   agentId: string;
   instructions: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Editor for the system prompt applied to every task an agent runs.
 *
 * Saves on blur rather than on a debounce timer. A system prompt changes how
 * every future run behaves, so writing it mid-sentence would push half-finished
 * instructions to the runtime; the issue description editor debounces because a
 * partially saved description is harmless.
 */
export function AgentInstructions({ agentId, instructions }: AgentInstructionsProps) {
   const [draft, setDraft] = useState(instructions);
   const [state, setState] = useState<SaveState>('idle');
   const [message, setMessage] = useState<string | null>(null);
   // Tracks what the server holds, so blur can tell a real edit from a
   // focus-and-leave and avoid a pointless write.
   const savedRef = useRef(instructions);

   useEffect(() => {
      setDraft(instructions);
      savedRef.current = instructions;
   }, [instructions]);

   const persist = async () => {
      const next = draft.trim();
      if (next === savedRef.current.trim()) return;
      setState('saving');
      setMessage(null);
      try {
         await updateAgentInstructions(agentId, next);
         savedRef.current = next;
         setState('saved');
      } catch (error) {
         setState('error');
         setMessage(error instanceof Error ? error.message : 'Could not save instructions');
      }
   };

   return (
      <section className="flex flex-col gap-2">
         <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-medium text-foreground">Instructions</h3>
            <p className="text-[11px] text-muted-foreground">
               System prompt used for every task. Markdown supported.
            </p>
            <span
               className="ml-auto text-[11px] text-muted-foreground"
               role="status"
               aria-live="polite"
            >
               {state === 'saving' ? 'Saving…' : null}
               {state === 'saved' ? 'Saved' : null}
            </span>
         </div>

         <MarkdownPreviewTextarea
            value={draft}
            onChange={setDraft}
            onBlur={persist}
            placeholder="Describe how this agent should approach every task…"
            rows={10}
            aria-label="Agent instructions"
         />

         {state === 'error' && message ? (
            <p className="text-[11px] text-destructive" role="alert">
               {message}. The runtime was not updated, so the agent still uses its previous
               instructions.
            </p>
         ) : null}
      </section>
   );
}
