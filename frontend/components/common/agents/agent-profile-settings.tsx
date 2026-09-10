'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import {
   archiveAgent,
   copyAgent,
   getAgentAccess,
   restoreAgent,
   setAgentAccess,
   setAgentEnv,
   setAgentLabels,
   uploadAgentAvatar,
   useAgentAvatarSrc,
   type Agent,
   type AgentAccess,
} from '@/lib/agents';
import { loadWorkspaceMembers } from '@/lib/members';
import { useSessionStore } from '@/store/session-store';

type Scope = AgentAccess['assign'];

const SCOPE_LABEL: Record<Scope, string> = {
   everyone: 'Everyone',
   admins: 'Admins only',
   listed: 'Listed members',
};

const reason = (error: unknown, fallback: string) =>
   error instanceof BerryApiError ? error.message : fallback;

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
   return (
      <section className="flex flex-col gap-2 border-t border-border/70 pt-4">
         <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-medium text-foreground">{title}</h3>
            <p className="text-muted-foreground">{hint}</p>
         </div>
         {children}
      </section>
   );
}

function AvatarField({ agent, onChange }: { agent: Agent; onChange: (agent: Agent) => void }) {
   const src = useAgentAvatarSrc(agent.avatarUrl);
   return (
      <Section title="Avatar" hint="PNG, JPEG, WebP or GIF, up to 512 KiB.">
         <div className="flex items-center gap-3">
            <span className="flex size-12 items-center justify-center overflow-hidden rounded-md bg-muted/40">
               {src ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a blob or external URL, not an optimisable asset
                  <img src={src} alt="" className="size-full object-cover" />
               ) : (
                  <BerryMark size="sm" tone="working" label={agent.name} />
               )}
            </span>
            <input
               type="file"
               accept="image/png,image/jpeg,image/webp,image/gif"
               aria-label="Upload avatar"
               onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  uploadAgentAvatar(agent.id, file).then(
                     (next) => {
                        onChange(next);
                        toast.success('Avatar updated');
                     },
                     (error: unknown) => toast.error(reason(error, 'The avatar could not be uploaded.'))
                  );
               }}
            />
         </div>
      </Section>
   );
}

function LabelsField({ agent, onChange }: { agent: Agent; onChange: (agent: Agent) => void }) {
   const [draft, setDraft] = useState('');
   const save = (labels: string[]) =>
      setAgentLabels(agent.id, labels).then(onChange, (error: unknown) =>
         toast.error(reason(error, 'The labels could not be saved.'))
      );
   return (
      <Section title="Labels" hint="Short tags to group and find agents.">
         <div className="flex flex-wrap items-center gap-2">
            {agent.labels.map((label) => (
               <span
                  key={label}
                  className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-0.5"
               >
                  {label}
                  <button
                     type="button"
                     aria-label={`Remove ${label}`}
                     className="text-muted-foreground hover:text-foreground"
                     onClick={() => void save(agent.labels.filter((entry) => entry !== label))}
                  >
                     ×
                  </button>
               </span>
            ))}
            <Input
               value={draft}
               placeholder="Add a label"
               aria-label="New label"
               className="h-7 w-40"
               onChange={(event) => setDraft(event.target.value)}
               onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !draft.trim()) return;
                  event.preventDefault();
                  void save([...agent.labels, draft.trim()]).then(() => setDraft(''));
               }}
            />
         </div>
      </Section>
   );
}

function EnvField({ agent, onChange }: { agent: Agent; onChange: (agent: Agent) => void }) {
   const [editing, setEditing] = useState(false);
   const [rows, setRows] = useState<{ name: string; value: string }[]>([]);
   const start = () => {
      setRows(agent.envNames.map((name) => ({ name, value: '' })));
      setEditing(true);
   };
   const incomplete = rows.some((row) => !row.name.trim() || row.value === '');
   const save = async () => {
      try {
         const envNames = await setAgentEnv(
            agent.id,
            Object.fromEntries(rows.map((row) => [row.name.trim(), row.value]))
         );
         onChange({ ...agent, envNames });
         setEditing(false);
         toast.success('Environment saved');
      } catch (error) {
         toast.error(reason(error, 'The environment could not be saved.'));
      }
   };
   return (
      <Section
         title="Environment variables"
         hint="Values are encrypted and can't be viewed again. Saving replaces every variable."
      >
         {agent.envNames.length > 0 ? (
            <p className="text-muted-foreground">{agent.envNames.join(', ')}</p>
         ) : (
            <p className="text-muted-foreground">No variables.</p>
         )}
         {editing ? (
            <div className="flex flex-col gap-2 rounded-md bg-muted/30 p-3">
               {rows.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                     <Input
                        value={row.name}
                        placeholder="NAME"
                        aria-label="Variable name"
                        onChange={(event) =>
                           setRows(
                              rows.map((entry, at) =>
                                 at === index ? { ...entry, name: event.target.value.toUpperCase() } : entry
                              )
                           )
                        }
                     />
                     <Input
                        type="password"
                        value={row.value}
                        placeholder="Value (re-enter to keep it)"
                        aria-label="Variable value"
                        autoComplete="off"
                        onChange={(event) =>
                           setRows(rows.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)))
                        }
                     />
                     <Button
                        size="xs"
                        variant="ghost"
                        aria-label="Remove variable"
                        onClick={() => setRows(rows.filter((_, at) => at !== index))}
                     >
                        <Trash2 className="size-4" />
                     </Button>
                  </div>
               ))}
               <div className="flex items-center gap-2">
                  <Button
                     size="xs"
                     variant="secondary"
                     onClick={() => setRows([...rows, { name: '', value: '' }])}
                  >
                     <Plus className="size-4" />
                     Add variable
                  </Button>
                  <Button size="xs" disabled={incomplete} onClick={() => void save()}>
                     Save all
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                     Cancel
                  </Button>
               </div>
            </div>
         ) : (
            <Button size="xs" variant="secondary" className="w-fit" onClick={start}>
               Edit variables
            </Button>
         )}
      </Section>
   );
}

function AccessField({ agent, onChange }: { agent: Agent; onChange: (agent: Agent) => void }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const [access, setAccess] = useState<AgentAccess | null>(null);
   const [members, setMembers] = useState<User[]>([]);

   useEffect(() => {
      let cancelled = false;
      getAgentAccess(agent.id).then(
         (loaded) => {
            if (!cancelled) setAccess(loaded);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [agent.id]);

   const listed = access?.assign === 'listed' || access?.mention === 'listed';
   useEffect(() => {
      if (!listed || !workspaceId) return;
      let cancelled = false;
      loadWorkspaceMembers(workspaceId).then(
         (loaded) => {
            if (!cancelled) setMembers(loaded);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [listed, workspaceId]);

   if (!access) return null;

   const save = (next: AgentAccess) => {
      setAccess(next);
      setAgentAccess(agent.id, next).then(onChange, (error: unknown) => {
         toast.error(reason(error, 'Access could not be changed.'));
         getAgentAccess(agent.id).then(setAccess, () => undefined);
      });
   };

   const scopeSelect = (label: string, value: Scope, apply: (scope: Scope) => AgentAccess) => (
      <label className="flex items-center gap-3">
         <span className="w-32 text-muted-foreground">{label}</span>
         <Select value={value} onValueChange={(next) => save(apply(next as Scope))}>
            <SelectTrigger className="w-48" aria-label={label}>
               <SelectValue />
            </SelectTrigger>
            <SelectContent>
               {(Object.keys(SCOPE_LABEL) as Scope[]).map((scope) => (
                  <SelectItem key={scope} value={scope}>
                     {SCOPE_LABEL[scope]}
                  </SelectItem>
               ))}
            </SelectContent>
         </Select>
      </label>
   );

   return (
      <Section title="Access" hint="Who may assign work to this agent or mention it. Admins always may.">
         {scopeSelect('Assign', access.assign, (assign) => ({ ...access, assign }))}
         {scopeSelect('Mention', access.mention, (mention) => ({ ...access, mention }))}
         {listed ? (
            <div className="flex flex-col gap-1">
               <span className="text-muted-foreground">Listed members</span>
               <div className="flex flex-wrap gap-2">
                  {members.map((member) => {
                     const on = access.members.includes(member.id);
                     return (
                        <button
                           key={member.id}
                           type="button"
                           aria-pressed={on}
                           className={
                              on
                                 ? 'rounded-md border border-foreground px-2 py-0.5'
                                 : 'rounded-md border border-border/70 px-2 py-0.5 text-muted-foreground'
                           }
                           onClick={() =>
                              save({
                                 ...access,
                                 members: on
                                    ? access.members.filter((id) => id !== member.id)
                                    : [...access.members, member.id],
                              })
                           }
                        >
                           {member.name}
                        </button>
                     );
                  })}
               </div>
            </div>
         ) : null}
      </Section>
   );
}

function LifecycleField({ agent, onChange }: { agent: Agent; onChange: (agent: Agent) => void }) {
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   // The protected orchestrator is the one agent the list marks by capability.
   const protectedAgent = agent.capabilities.includes('orchestrate');
   return (
      <Section title="Lifecycle" hint="Duplicate this agent, or archive it to take it out of the roster.">
         {agent.archivedAt ? (
            <div className="flex items-center gap-3 rounded-md bg-muted/40 px-3 py-2">
               <span>This agent is archived.</span>
               <Button
                  size="xs"
                  onClick={() =>
                     void restoreAgent(agent.id).then(
                        (next) => {
                           onChange(next);
                           toast.success('Agent restored');
                        },
                        (error: unknown) => toast.error(reason(error, 'The agent could not be restored.'))
                     )
                  }
               >
                  Restore
               </Button>
            </div>
         ) : null}
         <div className="flex items-center gap-2">
            <Button
               size="xs"
               variant="secondary"
               onClick={() =>
                  void copyAgent(agent.id).then(
                     (copy) => {
                        toast.success(`Created ${copy.name}`);
                        router.push(`/${orgId}/agents/${copy.id}`);
                     },
                     (error: unknown) => toast.error(reason(error, 'The agent could not be duplicated.'))
                  )
               }
            >
               Duplicate
            </Button>
            {agent.archivedAt ? null : (
               <Button
                  size="xs"
                  variant="secondary"
                  disabled={protectedAgent}
                  title={protectedAgent ? 'The workspace orchestrator cannot be archived.' : undefined}
                  onClick={() => {
                     if (!window.confirm(`Archive ${agent.name}? Its tasks and history are kept.`)) return;
                     void archiveAgent(agent.id).then(
                        () => {
                           toast.success('Agent archived');
                           router.push(`/${orgId}/agents`);
                        },
                        (error: unknown) => toast.error(reason(error, 'The agent could not be archived.'))
                     );
                  }}
               >
                  Archive
               </Button>
            )}
         </div>
      </Section>
   );
}

interface AgentProfileSettingsProps {
   agent: Agent;
   onChange: (agent: Agent) => void;
}

/** The parts of an agent's profile beyond its configuration. */
export default function AgentProfileSettings({ agent, onChange }: AgentProfileSettingsProps) {
   return (
      <>
         <AvatarField agent={agent} onChange={onChange} />
         <LabelsField agent={agent} onChange={onChange} />
         <EnvField agent={agent} onChange={onChange} />
         <AccessField agent={agent} onChange={onChange} />
         <LifecycleField agent={agent} onChange={onChange} />
      </>
   );
}
