'use client';

import { Switch } from '@/components/ui/switch';
import {
   AGENT_PERMISSIONS,
   loadWorkspaceAgents,
   setAgentPermissions,
   type Agent,
} from '@/lib/agents';
import { cn } from '@/lib/utils';
import { Bot, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace "Agents": who can be assigned work, and what each may do.
 *
 * This page used to list five product features — Coding sessions, Loops, Code
 * Intelligence, Triage Intelligence — with switches that wrote nothing. They
 * are gone. What is real is the roster and its permissions, and those are the
 * setting that actually decides what happens when an agent runs.
 *
 * Revoking a permission makes the *runtime* refuse the call, not this page
 * hide a button. That is the claim the whole permission model rests on, so the
 * page says it rather than leaving it to be assumed.
 */
export default function AiAgents() {
   const agents = useSettingsResource<Agent[]>(loadWorkspaceAgents);
   const [open, setOpen] = useState<string | null>(null);

   const toggle = (agent: Agent, key: string, granted: boolean) => {
      const next = granted
         ? [...new Set([...agent.permissions, key])]
         : agent.permissions.filter((entry) => entry !== key);
      void agents.mutate(
         (agents.value ?? []).map((entry) =>
            entry.id === agent.id ? { ...entry, permissions: next } : entry
         ),
         () => setAgentPermissions(agent.id, next).then(() => undefined)
      );
   };

   return (
      <SettingsShell
         title="Agents"
         description="Who can be assigned a task, and what each one may do. Revoking a permission makes the runtime refuse the call."
      >
         <SettingsSection description={agents.error ?? undefined}>
            <SettingsCard>
               {agents.loading ? <SettingsRow title="Loading…" /> : null}
               {!agents.loading && (agents.value ?? []).length === 0 ? (
                  <SettingsRow
                     title="No agents"
                     description="A workspace gets an Orchestrator when it is created."
                  />
               ) : null}

               {(agents.value ?? []).map((agent) => {
                  const expanded = open === agent.id;
                  const risky = agent.permissions.includes('merge_without_approval');
                  return (
                     <div key={agent.id}>
                        <SettingsRow
                           icon={<Bot className="size-4" />}
                           title={agent.name}
                           description={[
                              agent.modelName ?? 'no model set',
                              `${agent.permissions.length} of ${AGENT_PERMISSIONS.length} permissions`,
                              risky ? 'can merge without review' : null,
                           ]
                              .filter(Boolean)
                              .join(' · ')}
                           trailing={
                              <ChevronDown
                                 className={cn(
                                    'size-4 text-muted-foreground transition-transform',
                                    expanded && 'rotate-180'
                                 )}
                              />
                           }
                           onClick={() => setOpen(expanded ? null : agent.id)}
                        />
                        {expanded ? (
                           <div className="border-b border-border/50 bg-accent/20 px-4 py-2">
                              {AGENT_PERMISSIONS.map((permission) => (
                                 <label
                                    key={permission.key}
                                    className="flex items-start gap-3 py-2"
                                    htmlFor={`${agent.id}-${permission.key}`}
                                 >
                                    <span className="min-w-0 flex-1">
                                       <span
                                          className={cn(
                                             'block font-medium',
                                             'dangerous' in permission && 'text-status-danger'
                                          )}
                                       >
                                          {permission.label}
                                       </span>
                                       <span className="block text-muted-foreground">
                                          {permission.description}
                                       </span>
                                    </span>
                                    <Switch
                                       id={`${agent.id}-${permission.key}`}
                                       checked={agent.permissions.includes(permission.key)}
                                       disabled={agents.saving}
                                       onCheckedChange={(granted) =>
                                          toggle(agent, permission.key, granted)
                                       }
                                    />
                                 </label>
                              ))}
                           </div>
                        ) : null}
                     </div>
                  );
               })}
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
