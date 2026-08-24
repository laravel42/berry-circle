'use client';

import { useEffect, useMemo, useState } from 'react';

import { listAgentModels, updateAgentConfig, type AgentModel } from '@/lib/agents';

interface AgentModelPickerProps {
   agentId: string;
   provider: string | null;
   model: string | null;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** `$3.00` — per million tokens, which is how providers quote it. */
function money(perMillion: number): string {
   return `$${perMillion < 1 ? perMillion.toFixed(2) : perMillion.toFixed(0)}`;
}

/** `200K` — context windows are read as magnitude, not exact token counts. */
function compact(tokens: number): string {
   if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
   if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
   return String(tokens);
}

/**
 * Chooses the LLM an agent runs on.
 *
 * Every agent has one already — inherited from the runtime's default when its
 * manifest does not name one — so this is a change, never an initial setup.
 * The current pairing is shown even when it is not in the list, because a
 * runtime can serve a model it no longer offers for selection and hiding that
 * would make the agent look unconfigured.
 */
export function AgentModelPicker({ agentId, provider, model }: AgentModelPickerProps) {
   const [models, setModels] = useState<AgentModel[]>([]);
   const [state, setState] = useState<SaveState>('idle');
   const [message, setMessage] = useState<string | null>(null);
   const [current, setCurrent] = useState(() => (provider && model ? `${provider}/${model}` : ''));

   useEffect(() => {
      setCurrent(provider && model ? `${provider}/${model}` : '');
   }, [provider, model]);

   useEffect(() => {
      let cancelled = false;
      void (async () => {
         try {
            const loaded = await listAgentModels();
            if (!cancelled) setModels(loaded);
         } catch (cause) {
            if (!cancelled) {
               setState('error');
               setMessage(cause instanceof Error ? cause.message : 'Could not load models');
            }
         }
      })();
      return () => {
         cancelled = true;
      };
   }, []);

   // Grouped by provider so the list reads as "who serves this", matching the
   // order the server already sorted into.
   const groups = useMemo(() => {
      const byProvider = new Map<string, AgentModel[]>();
      for (const item of models) {
         const bucket = byProvider.get(item.provider) ?? [];
         bucket.push(item);
         byProvider.set(item.provider, bucket);
      }
      return [...byProvider.entries()];
   }, [models]);

   const known = models.some((item) => `${item.provider}/${item.id}` === current);
   const selected = models.find((item) => `${item.provider}/${item.id}` === current);

   const change = async (value: string) => {
      const divider = value.indexOf('/');
      if (divider < 1) return;
      const previous = current;
      setCurrent(value);
      setState('saving');
      setMessage(null);
      try {
         await updateAgentConfig(agentId, {
            provider: value.slice(0, divider),
            model: value.slice(divider + 1),
         });
         setState('saved');
      } catch (cause) {
         // Revert: the agent is still on the old model, and leaving the new one
         // selected would misreport what it will actually run with.
         setCurrent(previous);
         setState('error');
         setMessage(cause instanceof Error ? cause.message : 'Could not change the model');
      }
   };

   return (
      <section className="flex flex-col gap-2">
         <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-medium text-foreground">Model</h3>
            <p className="text-[11px] text-muted-foreground">
               The LLM this agent runs every task on.
            </p>
            <span className="ml-auto text-[11px] text-muted-foreground" role="status" aria-live="polite">
               {state === 'saving' ? 'Switching…' : null}
               {state === 'saved' ? 'Saved' : null}
            </span>
         </div>

         <select
            value={current}
            onChange={(event) => void change(event.target.value)}
            disabled={state === 'saving' || models.length === 0}
            aria-label="Model"
            className="w-full rounded-md border border-border/70 bg-transparent px-3 py-2 text-sm text-foreground disabled:opacity-50"
         >
            {current && !known ? (
               <option value={current}>{current} (not offered by this runtime)</option>
            ) : null}
            {!current ? <option value="">Select a model…</option> : null}
            {groups.map(([groupProvider, items]) => (
               <optgroup key={groupProvider} label={groupProvider}>
                  {items.map((item) => (
                     <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>
                        {item.displayName} — {money(item.inputCostPerM)}/{money(item.outputCostPerM)} per M ·{' '}
                        {compact(item.contextWindow)} ctx
                     </option>
                  ))}
               </optgroup>
            ))}
         </select>

         {selected ? (
            <p className="text-[11px] text-muted-foreground">
               {selected.tier} · {compact(selected.contextWindow)} context ·{' '}
               {money(selected.inputCostPerM)} in / {money(selected.outputCostPerM)} out per million
               {selected.supportsTools ? ' · tools' : ''}
               {selected.supportsVision ? ' · vision' : ''}
            </p>
         ) : null}

         {state === 'error' && message ? (
            <p className="text-[11px] text-destructive" role="alert">
               {message}. The agent still runs on its previous model.
            </p>
         ) : null}
      </section>
   );
}
