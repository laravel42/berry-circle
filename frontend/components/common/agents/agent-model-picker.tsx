'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckIcon, ChevronsUpDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
   listAgentModels,
   modelKey,
   modelPrice,
   updateAgentConfig,
   type AgentModel,
} from '@/lib/agents';

interface AgentModelPickerProps {
   agentId: string;
   provider: string | null;
   model: string | null;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** `200K` — context windows are read as magnitude, not exact token counts. */
function compact(tokens: number): string {
   if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
   if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
   return String(tokens);
}

/**
 * ` · 200K ctx`, or nothing.
 *
 * Bedrock does not publish a context window, so the catalogue reports 0 for
 * every model it serves. "0 ctx" reads as a fact about the model rather than
 * as the absence of one, so the clause is left out instead.
 */
function contextNote(tokens: number, unit: string): string {
   return tokens > 0 ? ` · ${compact(tokens)} ${unit}` : '';
}

/**
 * Every whitespace-separated term must appear in the entry.
 *
 * cmdk's default scorer is fuzzy enough to rank an unrelated model above
 * nothing — typing gibberish returned "Amazon: Nova Premier" rather than an
 * empty list. A model is picked by recalling part of its vendor or name, so
 * substring-per-term is both predictable and enough: "claude sonnet" and
 * "openrouter deepseek" both narrow the way a reader expects.
 */
function matches(value: string, search: string): number {
   const haystack = value.toLowerCase();
   const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
   if (terms.length === 0) return 1;
   return terms.every((term) => haystack.includes(term)) ? 1 : 0;
}

/**
 * Chooses the LLM an agent runs on.
 *
 * Every agent has one already — inherited from the runtime's default when its
 * manifest does not name one — so this is a change, never an initial setup.
 * The current pairing is shown even when it is not in the list, because a
 * runtime can serve a model it no longer offers for selection and hiding that
 * would make the agent look unconfigured.
 *
 * Searchable rather than a plain select: the catalog is the live provider list,
 * several hundred models deep, and scrolling that to find one by name is not a
 * choice anybody can make.
 */
export function AgentModelPicker({ agentId, provider, model }: AgentModelPickerProps) {
   const [models, setModels] = useState<AgentModel[]>([]);
   const [state, setState] = useState<SaveState>('idle');
   const [message, setMessage] = useState<string | null>(null);
   const [open, setOpen] = useState(false);
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

   const selected = models.find((item) => modelKey(item) === current);

   const change = async (value: string) => {
      const divider = value.indexOf('/');
      if (divider < 1) return;
      setOpen(false);
      if (value === current) return;
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
            <h3 className="font-medium text-foreground">Model</h3>
            <p className="text-muted-foreground">The LLM this agent runs every task on.</p>
            <span className="ml-auto text-muted-foreground" role="status" aria-live="polite">
               {state === 'saving' ? 'Switching…' : null}
               {state === 'saved' ? 'Saved' : null}
            </span>
         </div>

         <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
               <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={open}
                  aria-label="Model"
                  disabled={state === 'saving' || models.length === 0}
                  className="w-full justify-between border-border/70 bg-transparent px-3 py-2 font-normal"
               >
                  <span className="truncate">
                     {selected
                        ? `${selected.displayName} — ${modelPrice(selected.inputCostPerM)}/${modelPrice(selected.outputCostPerM)} per M${contextNote(selected.contextWindow, 'ctx')}`
                        : current || 'Select a model…'}
                  </span>
                  <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
               </Button>
            </PopoverTrigger>
            <PopoverContent
               className="w-[--radix-popover-trigger-width] border-input p-0"
               align="start"
            >
               {/* cmdk filters on each item's `value`, so provider and id both
                   have to be in it: "sonnet" and "anthropic" should each find
                   the same model. */}
               <Command filter={matches}>
                  <CommandInput placeholder="Search models…" />
                  <CommandList className="max-h-72">
                     <CommandEmpty>No model matches.</CommandEmpty>
                     {groups.map(([groupProvider, items]) => (
                        <CommandGroup key={groupProvider} heading={groupProvider}>
                           {items.map((item) => {
                              const key = modelKey(item);
                              return (
                                 <CommandItem
                                    key={key}
                                    value={`${key} ${item.displayName}`}
                                    onSelect={() => void change(key)}
                                    className="flex items-start gap-2"
                                 >
                                    <CheckIcon
                                       className={cn(
                                          'mt-0.5 size-3.5 shrink-0',
                                          key === current ? 'opacity-100' : 'opacity-0'
                                       )}
                                    />
                                    <span className="flex min-w-0 flex-col">
                                       <span className="truncate">{item.displayName}</span>
                                       <span className="text-muted-foreground">
                                          {modelPrice(item.inputCostPerM)}/
                                          {modelPrice(item.outputCostPerM)} per M
                                          {contextNote(item.contextWindow, 'ctx')}
                                          {item.supportsTools ? ' · tools' : ''}
                                       </span>
                                    </span>
                                 </CommandItem>
                              );
                           })}
                        </CommandGroup>
                     ))}
                  </CommandList>
               </Command>
            </PopoverContent>
         </Popover>

         {selected ? (
            <p className="text-muted-foreground">
               {selected.tier ? `${selected.tier} · ` : ''}
               {modelPrice(selected.inputCostPerM)} in / {modelPrice(selected.outputCostPerM)} out
               per million
               {contextNote(selected.contextWindow, 'context')}
               {selected.supportsTools ? ' · tools' : ''}
               {selected.supportsVision ? ' · vision' : ''}
            </p>
         ) : null}

         {state === 'error' && message ? (
            <p className="text-destructive" role="alert">
               {message}. The agent still runs on its previous model.
            </p>
         ) : null}
      </section>
   );
}
