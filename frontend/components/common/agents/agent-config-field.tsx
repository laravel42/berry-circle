'use client';

import { useEffect, useRef, useState } from 'react';

import { DescriptionTextarea } from '@/components/common/editor/description-textarea';
import { updateAgentConfig } from '@/lib/agents';

type ConfigField = 'instructions' | 'description';

interface AgentConfigFieldProps {
   agentId: string;
   field: ConfigField;
   value: string;
   title: string;
   hint: string;
   placeholder: string;
   /** Shown when a save fails, explaining what the agent is still running with. */
   failureNote: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * One editable agent configuration field, backed by the shared description
 * textarea.
 *
 * Instructions and description differ only in copy and which key they send, so
 * they share a component: two near-identical editors would drift in save
 * behaviour, and save behaviour is the part that matters when a write reaches
 * the runtime.
 *
 * The field owns its draft, so there is none here — it hands back its text when
 * editing settles and this only decides whether that text is worth persisting.
 */
export function AgentConfigField({
   agentId,
   field,
   value,
   title,
   hint,
   placeholder,
   failureNote,
}: AgentConfigFieldProps) {
   const [state, setState] = useState<SaveState>('idle');
   const [message, setMessage] = useState<string | null>(null);
   // What the server holds, so a commit that changed nothing is not written.
   const savedRef = useRef(value);

   useEffect(() => {
      savedRef.current = value;
   }, [value]);

   const persist = async (markdown: string) => {
      if (markdown.trim() === savedRef.current.trim()) return;
      setState('saving');
      setMessage(null);
      try {
         await updateAgentConfig(agentId, { [field]: markdown });
         savedRef.current = markdown;
         setState('saved');
      } catch (error) {
         setState('error');
         setMessage(error instanceof Error ? error.message : `Could not save ${field}`);
      }
   };

   return (
      <section className="flex flex-col gap-2">
         <div className="flex items-baseline gap-2">
            <h3 className="font-medium text-foreground">{title}</h3>
            <p className="text-muted-foreground">{hint}</p>
            <span className="ml-auto text-muted-foreground" role="status" aria-live="polite">
               {state === 'saving' ? 'Saving…' : null}
               {state === 'saved' ? 'Saved' : null}
            </span>
         </div>

         <div className="rounded-md border border-border/70 px-3 py-2">
            <DescriptionTextarea
               value={value}
               onCommit={persist}
               placeholder={placeholder}
               aria-label={title}
            />
         </div>

         {state === 'error' && message ? (
            <p className="text-destructive" role="alert">
               {message}. {failureNote}
            </p>
         ) : null}
      </section>
   );
}
