'use client';

import { FormEvent, useEffect, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { loadRuntimeModels, probeRuntimeChat, type RuntimeModel } from '@/lib/runtime';
import { SettingsCard, SettingsRow, SettingsSection } from './shared';

const DEFAULT_PROMPT = 'Reply with the single word berry.';

/** Operator playground for OpenFang model discovery and chat probes. */
export function ModelPlayground() {
   const [models, setModels] = useState<RuntimeModel[]>([]);
   const [loadingModels, setLoadingModels] = useState(true);
   const [modelId, setModelId] = useState('');
   const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
   const [response, setResponse] = useState('');
   const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null);
   const [pending, setPending] = useState(false);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      let cancelled = false;
      void (async () => {
         setLoadingModels(true);
         setError(null);
         try {
            const listed = await loadRuntimeModels();
            if (cancelled) return;
            setModels(listed);
            setModelId((current) => current || listed[0]?.id || '');
         } catch (loadError) {
            if (cancelled) return;
            setError(
               loadError instanceof BerryApiError
                  ? loadError.message
                  : 'Could not load runtime models.'
            );
         } finally {
            if (!cancelled) setLoadingModels(false);
         }
      })();
      return () => {
         cancelled = true;
      };
   }, []);

   async function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!modelId.trim()) {
         toast.error('Choose a model first.');
         return;
      }
      setPending(true);
      setError(null);
      setResponse('');
      setUsage(null);
      try {
         const result = await probeRuntimeChat({ model: modelId, prompt });
         setResponse(result.content);
         setUsage(result.usage);
      } catch (probeError) {
         const message =
            probeError instanceof BerryApiError
               ? probeError.message
               : 'Runtime chat probe failed.';
         setError(message);
         toast.error(message);
      } finally {
         setPending(false);
      }
   }

   return (
      <SettingsSection
         title="Model playground"
         description="Probe OpenFang model discovery and chat completions through Berry. Requires the compose stack with at least one provider key."
      >
         <SettingsCard>
            <form className="flex flex-col gap-4 p-4" onSubmit={(event) => void handleSubmit(event)}>
               <SettingsRow
                  title="Model"
                  description={
                     loadingModels
                        ? 'Loading models from the runtime…'
                        : models.length > 0
                          ? `${models.length} model${models.length === 1 ? '' : 's'} available`
                          : 'No models returned yet. Check OpenFang health and provider keys.'
                  }
                  trailing={
                     <Select
                        value={modelId}
                        onValueChange={setModelId}
                        disabled={loadingModels || models.length === 0}
                     >
                        <SelectTrigger className="w-[220px]">
                           <SelectValue placeholder="Select model" />
                        </SelectTrigger>
                        <SelectContent>
                           {models.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                 {model.id}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  }
               />
               <div className="space-y-2">
                  <label htmlFor="runtime-prompt" className="text-sm font-medium">
                     Prompt
                  </label>
                  <Textarea
                     id="runtime-prompt"
                     value={prompt}
                     onChange={(event) => setPrompt(event.target.value)}
                     rows={4}
                     disabled={pending}
                  />
               </div>
               <div className="flex items-center gap-2">
                  <Button type="submit" size="sm" disabled={pending || loadingModels || !modelId}>
                     {pending ? (
                        <>
                           <LoaderCircle className="size-4 animate-spin" />
                           Running probe…
                        </>
                     ) : (
                        <>
                           <Sparkles className="size-4" />
                           Send probe
                        </>
                     )}
                  </Button>
                  {usage ? (
                     <span className="text-xs text-muted-foreground">
                        {usage.inputTokens} in / {usage.outputTokens} out tokens
                     </span>
                  ) : null}
               </div>
               {error ? (
                  <p className="text-sm text-destructive">{error}</p>
               ) : null}
               {response ? (
                  <div className="rounded-lg border bg-muted/20 p-3">
                     <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Response
                     </p>
                     <pre className="whitespace-pre-wrap text-sm">{response}</pre>
                  </div>
               ) : null}
            </form>
         </SettingsCard>
      </SettingsSection>
   );
}
