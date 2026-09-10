'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import {
   archiveQuickAction,
   createQuickAction,
   loadQuickActions,
   type QuickAction,
} from '@/lib/quick-actions';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Prompt templates run on a task as an agent task. `{{issue.identifier}}`,
 * `{{issue.title}}` and `{{issue.description}}` are filled in when run.
 */
export default function QuickActionsSettings() {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const actions = useSettingsResource<QuickAction[]>(
      () => (workspaceId ? loadQuickActions(workspaceId) : Promise.reject(new Error('No workspace is selected.'))),
      [workspaceId]
   );
   const [agents, setAgents] = useState<Agent[]>([]);
   const [name, setName] = useState('');
   const [agentId, setAgentId] = useState('');
   const [prompt, setPrompt] = useState('');
   const [visibility, setVisibility] = useState<'private' | 'workspace'>('workspace');

   useEffect(() => {
      void loadWorkspaceAgents()
         .then(setAgents)
         .catch(() => setAgents([]));
   }, []);

   const create = async () => {
      try {
         const created = await createQuickAction(workspaceId, { name: name.trim(), targetAgentId: agentId, prompt, visibility });
         actions.set([...(actions.value ?? []), created]);
         setName('');
         setPrompt('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The quick action could not be created.');
      }
   };

   return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
         <div>
            <h1 className="font-display">Quick actions</h1>
            <p className="text-muted-foreground">
               Saved prompts an agent runs on a task. Use {'{{issue.title}}'}, {'{{issue.identifier}}'} and{' '}
               {'{{issue.description}}'}.
            </p>
         </div>
         <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2">
               <Input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
               <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger className="w-48">
                     <SelectValue placeholder="Agent" />
                  </SelectTrigger>
                  <SelectContent>
                     {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                           {agent.name}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
               <Select value={visibility} onValueChange={(value) => setVisibility(value as 'private' | 'workspace')}>
                  <SelectTrigger className="w-36">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value="workspace">Workspace</SelectItem>
                     <SelectItem value="private">Only me</SelectItem>
                  </SelectContent>
               </Select>
            </div>
            <Textarea placeholder="Prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} />
            <Button className="self-end" onClick={() => void create()} disabled={!name.trim() || !agentId || !prompt.trim()}>
               Add
            </Button>
         </div>
         {actions.error ? <p role="alert" className="text-muted-foreground">{actions.error}</p> : null}
         <ul className="flex flex-col divide-y rounded-md border">
            {(actions.value ?? []).map((action) => (
               <li key={action.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                     <div>
                        {action.name}{' '}
                        <span className="text-muted-foreground">
                           · {agents.find((agent) => agent.id === action.targetAgentId)?.name ?? 'Agent'} ·{' '}
                           {action.visibility === 'private' ? 'only me' : 'workspace'}
                        </span>
                     </div>
                     <p className="truncate text-muted-foreground">{action.prompt}</p>
                  </div>
                  <Button
                     variant="ghost"
                     size="sm"
                     onClick={() =>
                        void actions.mutate(
                           (actions.value ?? []).filter((entry) => entry.id !== action.id),
                           () => archiveQuickAction(workspaceId, action.id)
                        )
                     }
                  >
                     Archive
                  </Button>
               </li>
            ))}
         </ul>
      </div>
   );
}
