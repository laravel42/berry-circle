'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { createAgent, listAgentModels, modelKey, type AgentModel } from '@/lib/agents';

const formSchema = z.object({
   name: z.string().trim().min(1, 'Give the agent a name.').max(100),
   description: z.string().max(5000),
   instructions: z.string().max(20000),
   /** `provider/model`, or empty for the workspace default. */
   model: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

const DEFAULT_MODEL = '__default__';

export default function NewAgentManual() {
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const [models, setModels] = useState<AgentModel[]>([]);
   // A server with no model catalogue (503) simply does not offer the field.
   const [catalog, setCatalog] = useState<'loading' | 'ready' | 'unavailable'>('loading');

   useEffect(() => {
      let cancelled = false;
      listAgentModels()
         .then((found) => {
            if (cancelled) return;
            setModels(found);
            setCatalog('ready');
         })
         .catch(() => {
            if (!cancelled) setCatalog('unavailable');
         });
      return () => {
         cancelled = true;
      };
   }, []);

   const form = useForm<FormValues>({
      resolver: zodResolver(formSchema),
      defaultValues: { name: '', description: '', instructions: '', model: undefined },
   });

   const submit = form.handleSubmit(async (values) => {
      const chosen = values.model ? models.find((model) => modelKey(model) === values.model) : undefined;
      try {
         const agent = await createAgent({
            name: values.name.trim(),
            ...(values.description ? { description: values.description } : {}),
            ...(values.instructions ? { instructions: values.instructions } : {}),
            ...(chosen ? { provider: chosen.provider, model: chosen.id } : {}),
         });
         toast.success(`Created ${agent.name}`);
         router.push(`/${orgId}/agents/${agent.id}`);
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'The agent could not be created.');
      }
   });

   const nameError = form.formState.errors.name?.message;

   return (
      <form className="flex max-w-2xl flex-col gap-4" onSubmit={(event) => void submit(event)}>
         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">Name</span>
            <Input {...form.register('name')} aria-invalid={Boolean(nameError)} />
            {nameError ? <span className="text-red-500">{nameError}</span> : null}
         </label>
         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">Description</span>
            <Input {...form.register('description')} placeholder="What this agent is for." />
         </label>
         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">Instructions</span>
            <Textarea
               rows={8}
               {...form.register('instructions')}
               placeholder="How this agent should approach every task, what it produces, what it avoids."
            />
         </label>
         {catalog === 'ready' && models.length > 0 ? (
            <div className="flex flex-col gap-1.5">
               <span className="text-muted-foreground">Model</span>
               <Controller
                  control={form.control}
                  name="model"
                  render={({ field }) => (
                     <Select
                        value={field.value ?? DEFAULT_MODEL}
                        onValueChange={(value) => field.onChange(value === DEFAULT_MODEL ? undefined : value)}
                     >
                        <SelectTrigger className="w-80" aria-label="Model">
                           <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                           <SelectItem value={DEFAULT_MODEL}>Workspace default</SelectItem>
                           {models.map((model) => (
                              <SelectItem key={modelKey(model)} value={modelKey(model)}>
                                 {model.displayName} · {model.provider}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  )}
               />
            </div>
         ) : null}
         <Button type="submit" size="sm" className="w-fit" disabled={form.formState.isSubmitting}>
            Create agent
         </Button>
      </form>
   );
}
