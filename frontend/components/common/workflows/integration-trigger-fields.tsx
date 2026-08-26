'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   BUILT_IN_PROVIDER,
   describeProviderState,
   toolOperation,
   triggerTools,
   type Provider,
} from '@/lib/integrations';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/store/providers-store';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export interface IntegrationTriggerValue {
   provider: string;
   operation: string;
}

/** What is missing before the trigger can be sent, or null. */
export function integrationTriggerProblem(value: IntegrationTriggerValue): string | null {
   if (!value.provider) return 'Pick a provider.';
   if (!value.operation) return 'Pick the event that starts the workflow.';
   return null;
}

/** True when a workflow may start on this provider's events right now. */
export function providerReady(provider: Provider): boolean {
   return provider.id === BUILT_IN_PROVIDER || provider.connected;
}

const NONE = '__none__';

interface IntegrationTriggerFieldsProps {
   value: IntegrationTriggerValue;
   onChange: (value: IntegrationTriggerValue) => void;
   /** Stack the controls, for a narrow panel. */
   compact?: boolean;
}

/**
 * A provider and one of its trigger events from the live catalog. Every
 * provider that publishes events is listed so a person can see what is
 * possible; the events themselves open only once the provider is
 * connected, with Connect a click away until then.
 */
export function IntegrationTriggerFields({
   value,
   onChange,
   compact = false,
}: IntegrationTriggerFieldsProps) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const providers = useProvidersStore((state) => state.providers);
   const loaded = useProvidersStore((state) => state.loaded);
   const withTriggers = providers.filter((provider) => triggerTools(provider).length > 0);
   const provider = providers.find((candidate) => candidate.id === value.provider);
   const tools = provider ? triggerTools(provider) : [];
   const tool = tools.find((candidate) => toolOperation(candidate.name) === value.operation);
   const ready = provider ? providerReady(provider) : false;
   const state = provider ? describeProviderState(provider) : null;

   return (
      <div className="flex min-w-0 flex-col gap-3">
         <div className={cn('grid gap-3', !compact && 'sm:grid-cols-2')}>
            <div className="flex min-w-0 flex-col gap-1">
               <Label className="text-muted-foreground">Provider</Label>
               <Select
                  value={value.provider || NONE}
                  onValueChange={(next) =>
                     onChange({ provider: next === NONE ? '' : next, operation: '' })
                  }
               >
                  <SelectTrigger className="h-8 w-full">
                     <SelectValue placeholder={loaded ? 'Pick a provider' : 'Loading providers…'} />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value={NONE}>
                        {loaded ? 'Pick a provider' : 'Loading providers…'}
                     </SelectItem>
                     {withTriggers.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                           {candidate.name}
                           {!providerReady(candidate) && (
                              <span className="text-muted-foreground"> · not connected</span>
                           )}
                        </SelectItem>
                     ))}
                     {loaded && withTriggers.length === 0 && (
                        <SelectItem value="__empty__" disabled>
                           No provider publishes events on this deployment
                        </SelectItem>
                     )}
                  </SelectContent>
               </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
               <Label className="text-muted-foreground">Event</Label>
               <Select
                  value={value.operation || NONE}
                  onValueChange={(next) =>
                     onChange({ provider: value.provider, operation: next === NONE ? '' : next })
                  }
                  disabled={!provider || !ready}
               >
                  <SelectTrigger className="h-8 w-full">
                     <SelectValue
                        placeholder={
                           !provider
                              ? 'Pick a provider first'
                              : ready
                                ? 'Pick an event'
                                : `Connect ${provider.name} first`
                        }
                     />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value={NONE}>Pick an event</SelectItem>
                     {tools.map((candidate) => (
                        <SelectItem
                           key={candidate.name}
                           value={toolOperation(candidate.name)}
                           textValue={toolOperation(candidate.name)}
                        >
                           <span className="flex flex-col">
                              <span className="font-mono">{toolOperation(candidate.name)}</span>
                              {candidate.description && (
                                 <span className="text-muted-foreground">
                                    {candidate.description}
                                 </span>
                              )}
                           </span>
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
            </div>
         </div>

         {provider && state && !ready && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2">
               <BerryMark size="sm" tone={state.tone} state="hollow" />
               <span className="min-w-0 flex-1">
                  {provider.name} is {state.label.toLowerCase()}. Its events reach this workspace
                  only through a live connection.
               </span>
               <Button asChild size="xs" variant="secondary">
                  <Link
                     href={`/${orgId}/settings/integrations?provider=${encodeURIComponent(provider.id)}`}
                  >
                     Connect
                  </Link>
               </Button>
            </div>
         )}

         {provider && ready && (
            <p className="text-muted-foreground">
               {tool?.description ??
                  (provider.id === BUILT_IN_PROVIDER
                     ? 'Berry’s own events; the matching topic starts a run.'
                     : `A verified ${provider.name} delivery with this event starts a run; its body is trigger.payload.`)}
               {tool && provider.id !== BUILT_IN_PROVIDER && (
                  <>
                     {' '}
                     The delivery is <code className="font-mono">trigger.payload</code>.
                  </>
               )}
            </p>
         )}
      </div>
   );
}
