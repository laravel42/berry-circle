'use client';

import { useEffect, useMemo, useState } from 'react';
import {
   Check,
   Cpu,
   Eye,
   Hash,
   Layers,
   Search,
   Tag,
   Wrench,
} from 'lucide-react';

import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
   bareModelName,
   listAgentModels,
   modelKey,
   modelPrice,
   modelVendor,
   updateAgentConfig,
   type AgentModel,
} from '@/lib/agents';

interface AgentModelTabProps {
   agentId: string;
   provider: string | null;
   model: string | null;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** How the sidebar list is bucketed. Vendor is the useful default; every row
 *  shares one `provider` (`bedrock`), so grouping on that would be one bucket. */
const GROUPINGS = ['vendor', 'capability', 'none'] as const;
type Grouping = (typeof GROUPINGS)[number];

const GROUPING_LABELS: Record<Grouping, string> = {
   vendor: 'Vendor',
   capability: 'Capability',
   none: 'None',
};

/** `200K` — context windows are read as magnitude, not exact token counts. */
function compactTokens(tokens: number): string {
   if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
   if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
   return String(tokens);
}

/** Title-case a lowercase vendor key for a heading: `anthropic` → `Anthropic`. */
function titleCase(value: string): string {
   return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * The capability bucket a model falls in, for the capability grouping.
 *
 * A model is placed in its most capable bucket so each appears once: vision
 * implies tools here, so a vision model is grouped under Vision rather than
 * counted twice.
 */
function capabilityBucket(model: AgentModel): string {
   if (model.supportsVision) return 'Vision + tools';
   if (model.supportsTools) return 'Tools';
   return 'Text';
}

/** Every whitespace term must be a substring of the id or display name. */
function matchesSearch(model: AgentModel, search: string): boolean {
   const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
   if (terms.length === 0) return true;
   const haystack = `${model.id} ${model.displayName}`.toLowerCase();
   return terms.every((term) => haystack.includes(term));
}

/** One labelled group of models for the sidebar. */
interface ModelGroup {
   heading: string;
   models: AgentModel[];
}

function groupModels(models: AgentModel[], grouping: Grouping): ModelGroup[] {
   if (grouping === 'none') {
      return [{ heading: 'All models', models }];
   }
   const buckets = new Map<string, AgentModel[]>();
   for (const model of models) {
      const key =
         grouping === 'vendor' ? titleCase(modelVendor(model)) : capabilityBucket(model);
      const bucket = buckets.get(key) ?? [];
      bucket.push(model);
      buckets.set(key, bucket);
   }
   return [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([heading, groupModels]) => ({ heading, models: groupModels }));
}

/** One row of the metadata panel. Renders a dash-equivalent for unknowns. */
function MetaRow({
   icon: Icon,
   label,
   children,
}: {
   icon: React.ComponentType<{ className?: string }>;
   label: string;
   children: React.ReactNode;
}) {
   return (
      <div className="flex items-start justify-between gap-4 py-2.5">
         <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Icon className="size-3.5 shrink-0" aria-hidden />
            {label}
         </span>
         <span className="min-w-0 text-right text-foreground">{children}</span>
      </div>
   );
}

/**
 * A dedicated tab for choosing and inspecting the LLM an agent runs on.
 *
 * Left: every model the runtime can serve, grouped by a vendor/capability
 * select and filterable by name. Right: the full Bedrock catalog metadata for
 * the highlighted model. Selecting a model persists it through the same
 * `updateAgentConfig` path the compact picker uses, so the agent's stored
 * pairing and this tab never disagree.
 *
 * The highlighted model is decoupled from the saved one: a person browses the
 * list to read metadata before committing, so highlighting a row shows its
 * details without changing what the agent runs on. Saving happens on an
 * explicit "Use this model" action.
 */
export function AgentModelTab({ agentId, provider, model }: AgentModelTabProps) {
   const [models, setModels] = useState<AgentModel[]>([]);
   const [loadError, setLoadError] = useState<string | null>(null);
   const [grouping, setGrouping] = useState<Grouping>('vendor');
   const [search, setSearch] = useState('');
   const [state, setState] = useState<SaveState>('idle');
   const [message, setMessage] = useState<string | null>(null);

   const savedKey = provider && model ? `${provider}/${model}` : '';
   const [highlighted, setHighlighted] = useState(savedKey);

   useEffect(() => {
      // Follow the agent's saved pairing when it changes underneath us, but
      // only to seed the highlight — a browsing selection is not overwritten.
      setHighlighted((current) => current || (provider && model ? `${provider}/${model}` : ''));
   }, [provider, model]);

   useEffect(() => {
      let cancelled = false;
      void (async () => {
         try {
            const loaded = await listAgentModels();
            if (!cancelled) setModels(loaded);
         } catch (cause) {
            if (!cancelled) {
               setLoadError(cause instanceof Error ? cause.message : 'Could not load models');
            }
         }
      })();
      return () => {
         cancelled = true;
      };
   }, []);

   const visible = useMemo(
      () => models.filter((entry) => matchesSearch(entry, search)),
      [models, search]
   );
   const groups = useMemo(() => groupModels(visible, grouping), [visible, grouping]);

   const highlightedModel = models.find((entry) => modelKey(entry) === highlighted) ?? null;
   const isSaved = highlightedModel !== null && modelKey(highlightedModel) === savedKey;

   const save = async (target: AgentModel) => {
      const key = modelKey(target);
      if (key === savedKey) return;
      setState('saving');
      setMessage(null);
      try {
         await updateAgentConfig(agentId, { provider: target.provider, model: target.id });
         setState('saved');
      } catch (cause) {
         setState('error');
         setMessage(cause instanceof Error ? cause.message : 'Could not change the model');
      }
   };

   if (loadError) {
      return (
         <div className="px-8 py-6">
            <p className="text-destructive" role="alert">
               {loadError}. The agent still runs on its previous model.
            </p>
         </div>
      );
   }

   return (
      <div className="flex h-full min-h-0">
         {/* Left: grouping select, search, scrollable model list. */}
         <div className="flex w-72 shrink-0 flex-col border-r border-border/70">
            <div className="flex flex-col gap-2 border-b border-border/70 p-3">
               <Select value={grouping} onValueChange={(value) => setGrouping(value as Grouping)}>
                  <SelectTrigger className="h-8" aria-label="Group models by">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     {GROUPINGS.map((option) => (
                        <SelectItem key={option} value={option}>
                           Group by {GROUPING_LABELS[option]}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
               <div className="relative">
                  <Search
                     className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                     aria-hidden
                  />
                  <input
                     type="text"
                     value={search}
                     onChange={(event) => setSearch(event.target.value)}
                     placeholder="Search models…"
                     aria-label="Search models"
                     className="h-8 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-foreground placeholder:text-foreground/40 focus-visible:border-input focus-visible:outline-none"
                  />
               </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-1">
               {visible.length === 0 ? (
                  <p className="px-3 py-6 text-muted-foreground">No model matches.</p>
               ) : (
                  groups.map((group) => (
                     <div key={group.heading} className="pb-1">
                        <p className="px-3 pb-1 pt-2 font-medium uppercase tracking-wide text-muted-foreground">
                           {group.heading}
                        </p>
                        {group.models.map((entry) => {
                           const key = modelKey(entry);
                           const active = key === highlighted;
                           const saved = key === savedKey;
                           return (
                              <button
                                 key={key}
                                 type="button"
                                 onClick={() => setHighlighted(key)}
                                 className={cn(
                                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                                    active
                                       ? 'bg-accent text-accent-foreground'
                                       : 'hover:bg-accent/50'
                                 )}
                              >
                                 <span className="min-w-0 flex-1 truncate">
                                    {bareModelName(entry.id) || entry.displayName}
                                 </span>
                                 {saved ? (
                                    <Check className="size-3.5 shrink-0 text-muted-foreground" aria-label="Current model" />
                                 ) : null}
                              </button>
                           );
                        })}
                     </div>
                  ))
               )}
            </div>
         </div>

         {/* Right: full metadata for the highlighted model. */}
         <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
            {highlightedModel === null ? (
               <p className="text-muted-foreground">
                  Select a model to see what it is and what it costs.
               </p>
            ) : (
               <div className="flex flex-col gap-6">
                  <div className="flex items-start justify-between gap-4">
                     <div className="min-w-0">
                        <h2 className="truncate font-medium text-foreground">
                           {highlightedModel.displayName}
                        </h2>
                        <p className="mt-0.5 truncate text-muted-foreground">
                           {highlightedModel.id}
                        </p>
                     </div>
                     <div className="flex shrink-0 items-center gap-2">
                        <span
                           className="text-muted-foreground"
                           role="status"
                           aria-live="polite"
                        >
                           {state === 'saving' ? 'Switching…' : null}
                           {state === 'saved' && isSaved ? 'Saved' : null}
                        </span>
                        <button
                           type="button"
                           onClick={() => void save(highlightedModel)}
                           disabled={isSaved || state === 'saving'}
                           className={cn(
                              'rounded-md border px-3 py-1.5 font-medium transition-colors',
                              isSaved
                                 ? 'border-border/70 text-muted-foreground'
                                 : 'border-foreground bg-foreground text-background hover:opacity-90'
                           )}
                        >
                           {isSaved ? 'Current model' : 'Use this model'}
                        </button>
                     </div>
                  </div>

                  <div className="flex flex-col divide-y divide-border/60 border-y border-border/60">
                     <MetaRow icon={Tag} label="Provider">
                        {highlightedModel.provider}
                     </MetaRow>
                     <MetaRow icon={Cpu} label="Vendor">
                        {titleCase(modelVendor(highlightedModel))}
                     </MetaRow>
                     <MetaRow icon={Hash} label="Model ID">
                        <span className="break-all">{highlightedModel.id}</span>
                     </MetaRow>
                     <MetaRow icon={Layers} label="Tier">
                        {highlightedModel.tier || 'Unknown'}
                     </MetaRow>
                     <MetaRow icon={Layers} label="Context window">
                        {highlightedModel.contextWindow > 0
                           ? `${compactTokens(highlightedModel.contextWindow)} tokens`
                           : 'Unknown'}
                     </MetaRow>
                     <MetaRow icon={Tag} label="Input price">
                        {highlightedModel.inputCostPerM > 0
                           ? `${modelPrice(highlightedModel.inputCostPerM)} / M tokens`
                           : highlightedModel.inputCostPerM === 0
                             ? 'Unknown'
                             : '—'}
                     </MetaRow>
                     <MetaRow icon={Tag} label="Output price">
                        {highlightedModel.outputCostPerM > 0
                           ? `${modelPrice(highlightedModel.outputCostPerM)} / M tokens`
                           : highlightedModel.outputCostPerM === 0
                             ? 'Unknown'
                             : '—'}
                     </MetaRow>
                     <MetaRow icon={Wrench} label="Tool use">
                        {highlightedModel.supportsTools ? 'Supported' : 'Not supported'}
                     </MetaRow>
                     <MetaRow icon={Eye} label="Vision input">
                        {highlightedModel.supportsVision ? 'Supported' : 'Not supported'}
                     </MetaRow>
                  </div>

                  <p className="text-muted-foreground">
                     Prices come from a public dataset and read as Unknown when it does not list
                     this model. Context window and tier are not published by Bedrock for these
                     profiles.
                  </p>

                  {state === 'error' && message ? (
                     <p className="text-destructive" role="alert">
                        {message}. The agent still runs on its previous model.
                     </p>
                  ) : null}
               </div>
            )}
         </div>
      </div>
   );
}
