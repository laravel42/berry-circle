'use client';

import { useCallback, useEffect, useState } from 'react';
import { Eye, Plus, Trash2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { AgentModelPicker } from '@/components/common/agents/agent-model-picker';
import { BerryMark } from '@/components/brand/berry-mark';
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
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import {
   listAgentEnvAudit,
   revealAgentEnv,
   setAgentAccess,
   setAgentEnv,
   updateAgentConfig,
   uploadAgentAvatar,
   useAgentAvatarSrc,
   getAgentAccess,
   type Agent,
   type AgentAccess,
   type AgentEnvAuditEntry,
   type AgentRoster,
} from '@/lib/agents';
import { loadWorkspaceMembers } from '@/lib/members';
import { bindAgentRuntime, listRuntimes, unbindAgentRuntime, type Runtime } from '@/lib/runtimes';
import { useSessionStore } from '@/store/session-store';

const NO_RUNTIME = '__none__';

const reason = (error: unknown, fallback: string) =>
   error instanceof BerryApiError ? error.message : fallback;

interface AgentSettingsTabProps {
   agent: Agent;
   roster: AgentRoster | undefined;
   readOnly: boolean;
   onChange: (agent: Agent) => void;
   /** Re-read the roster after a runtime binding changes. */
   onRosterStale: () => void;
   /** Called when the server refuses a write, so the page can say so once. */
   onForbidden: () => void;
}

function Section({
   title,
   hint,
   children,
}: {
   title: string;
   hint?: string;
   children: React.ReactNode;
}) {
   return (
      <section className="flex flex-col gap-2 border-t border-border/70 pt-6 first:border-t-0 first:pt-0">
         <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-medium">{title}</h3>
            {hint ? <p className="text-muted-foreground">{hint}</p> : null}
         </div>
         {children}
      </section>
   );
}

/**
 * Everything about the agent that is a setting rather than a capability.
 *
 * The environment section is the one part of this page that is not simply a
 * form: its values are sealed, so editing them means asking for them back, and
 * asking is an act the server records. The section therefore shows what is
 * stored (names), what happened (the history), and only reveals values when
 * somebody says so.
 */
export default function AgentSettingsTab({
   agent,
   roster,
   readOnly,
   onChange,
   onRosterStale,
   onForbidden,
}: AgentSettingsTabProps) {
   const t = useTranslations('agentsChat.detail');
   const common = useTranslations('agentsChat.common');
   const list = useTranslations('agentsChat.list');

   /**
    * A refusal is reported once as a toast, and once as a standing fact: a
    * reader who cannot change this agent should be told that, not left to
    * discover it one failed save at a time.
    */
   const failed = (error: unknown) => {
      if (error instanceof BerryApiError && error.status === 403) onForbidden();
      toast.error(reason(error, t('failureUnknown')));
   };
   const format = useFormatter();
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const sessionUserId = useSessionStore((state) => state.user?.id);

   const [name, setName] = useState(agent.name);
   const [description, setDescription] = useState(agent.description ?? '');
   const [concurrency, setConcurrency] = useState(
      agent.maxConcurrency === null || agent.maxConcurrency === undefined
         ? ''
         : String(agent.maxConcurrency)
   );
   const [saving, setSaving] = useState(false);
   const [runtimes, setRuntimes] = useState<Runtime[]>([]);
   const [customModel, setCustomModel] = useState('');
   const [access, setAccess] = useState<AgentAccess | null>(null);
   const [members, setMembers] = useState<User[]>([]);

   // Whether the caller may see the environment at all. Asked rather than
   // assumed: the server is the authority, and a 403 from the history read is
   // the same answer it would give to a reveal.
   const [envAllowed, setEnvAllowed] = useState<boolean | null>(null);
   const [audit, setAudit] = useState<AgentEnvAuditEntry[]>([]);
   const [envRows, setEnvRows] = useState<{ name: string; value: string }[] | null>(null);
   const [revealing, setRevealing] = useState(false);

   const avatarSrc = useAgentAvatarSrc(agent.avatarUrl);

   useEffect(() => {
      setName(agent.name);
      setDescription(agent.description ?? '');
   }, [agent.name, agent.description]);

   useEffect(() => {
      listRuntimes().then(setRuntimes, () => setRuntimes([]));
      getAgentAccess(agent.id).then(setAccess, () => setAccess(null));
   }, [agent.id]);

   const refreshAudit = useCallback(async () => {
      try {
         setAudit(await listAgentEnvAudit(agent.id));
         setEnvAllowed(true);
      } catch (error) {
         if (error instanceof BerryApiError && error.status === 403) {
            setEnvAllowed(false);
            return;
         }
         setEnvAllowed(true);
      }
   }, [agent.id]);

   useEffect(() => {
      void refreshAudit();
   }, [refreshAudit]);

   const listed = access?.assign === 'listed';
   useEffect(() => {
      if (!listed || !workspaceId) return;
      loadWorkspaceMembers(workspaceId).then(setMembers, () => setMembers([]));
   }, [listed, workspaceId]);

   const saveConfig = async (patch: Parameters<typeof updateAgentConfig>[1], done?: string) => {
      setSaving(true);
      try {
         onChange(await updateAgentConfig(agent.id, patch));
         toast.success(done ?? common('saved'));
      } catch (error) {
         failed(error);
      } finally {
         setSaving(false);
      }
   };

   const chooseRuntime = async (value: string) => {
      try {
         if (value === NO_RUNTIME) {
            if (roster?.runtimeId) await unbindAgentRuntime(roster.runtimeId, agent.id);
         } else {
            await bindAgentRuntime(value, agent.id);
         }
         onRosterStale();
         toast.success(common('saved'));
      } catch (error) {
         failed(error);
      }
   };

   const saveAccess = async (next: AgentAccess) => {
      setAccess(next);
      try {
         onChange(await setAgentAccess(agent.id, next));
      } catch (error) {
         failed(error);
         getAgentAccess(agent.id).then(setAccess, () => undefined);
      }
   };

   /** `only me` is the listed scope with exactly one member: the caller. */
   const accessMode: 'me' | 'workspace' | 'people' = !access
      ? 'workspace'
      : access.assign === 'listed'
        ? access.members.length === 1 && access.members[0] === sessionUserId
           ? 'me'
           : 'people'
        : 'workspace';

   const reveal = async () => {
      setRevealing(true);
      try {
         const env = await revealAgentEnv(agent.id);
         setEnvRows(
            Object.entries(env)
               .sort(([left], [right]) => left.localeCompare(right))
               .map(([key, value]) => ({ name: key, value }))
         );
         await refreshAudit();
         toast.success(t('envRevealed'));
      } catch (error) {
         failed(error);
      } finally {
         setRevealing(false);
      }
   };

   const saveEnv = async () => {
      if (!envRows) return;
      setSaving(true);
      try {
         const envNames = await setAgentEnv(
            agent.id,
            Object.fromEntries(
               envRows.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value])
            )
         );
         onChange({ ...agent, envNames });
         setEnvRows(null);
         await refreshAudit();
         toast.success(common('saved'));
      } catch (error) {
         failed(error);
      } finally {
         setSaving(false);
      }
   };

   return (
      <div className="flex max-w-3xl flex-col gap-8 px-8 py-6">
         <Section title={t('setGeneral')}>
            <div className="flex items-center gap-3">
               <span className="flex size-12 items-center justify-center overflow-hidden rounded-md bg-muted/40">
                  {avatarSrc ? (
                     // eslint-disable-next-line @next/next/no-img-element -- a blob or external URL, not an optimisable asset
                     <img src={avatarSrc} alt="" className="size-full object-cover" />
                  ) : (
                     <BerryMark size="sm" tone="working" label={agent.name} />
                  )}
               </span>
               {readOnly ? null : (
                  <input
                     type="file"
                     accept="image/png,image/jpeg,image/webp,image/gif"
                     aria-label={t('setGeneral')}
                     onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        uploadAgentAvatar(agent.id, file).then(onChange, (error: unknown) =>
                           toast.error(reason(error, t('failureUnknown')))
                        );
                     }}
                  />
               )}
            </div>

            <label className="flex flex-col gap-1.5">
               <span className="text-muted-foreground">{t('setName')}</span>
               <Input
                  value={name}
                  disabled={readOnly}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => {
                     const next = name.trim();
                     if (!next || next === agent.name) {
                        setName(agent.name);
                        return;
                     }
                     void saveConfig({ name: next });
                  }}
               />
            </label>

            <label className="flex flex-col gap-1.5">
               <span className="text-muted-foreground">{t('setDescription')}</span>
               <Textarea
                  rows={3}
                  value={description}
                  disabled={readOnly}
                  onChange={(event) => setDescription(event.target.value)}
                  onBlur={() => {
                     if (description === (agent.description ?? '')) return;
                     void saveConfig({ description });
                  }}
               />
            </label>
         </Section>

         <Section title={t('setRuntime')} hint={t('setRuntimeHint')}>
            <Select
               value={roster?.runtimeId ?? NO_RUNTIME}
               disabled={readOnly}
               onValueChange={(value) => void chooseRuntime(value)}
            >
               <SelectTrigger className="w-80" aria-label={t('setRuntime')}>
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value={NO_RUNTIME}>{t('setRuntimeNone')}</SelectItem>
                  {runtimes.map((runtime) => (
                     <SelectItem key={runtime.id} value={runtime.id}>
                        {runtime.name}
                        {runtime.status === 'active' ? '' : ` · ${list('runtimeUnreachable')}`}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
         </Section>

         <Section title={t('setModel')}>
            <AgentModelPicker
               agentId={agent.id}
               provider={agent.modelProvider ?? null}
               model={agent.modelName ?? null}
            />
            {readOnly ? null : (
               <div className="flex flex-wrap items-center gap-2">
                  <Input
                     value={customModel}
                     className="w-80"
                     placeholder="provider/model-id"
                     aria-label={t('setModelCustom')}
                     onChange={(event) => setCustomModel(event.target.value)}
                  />
                  <Button
                     size="xs"
                     variant="secondary"
                     disabled={saving || !customModel.includes('/')}
                     onClick={() => {
                        const divider = customModel.indexOf('/');
                        void saveConfig({
                           provider: customModel.slice(0, divider).trim(),
                           model: customModel.slice(divider + 1).trim(),
                        }).then(() => setCustomModel(''));
                     }}
                  >
                     {t('setModelCustom')}
                  </Button>
                  <Button
                     size="xs"
                     variant="ghost"
                     disabled={saving || !agent.modelName}
                     onClick={() => void saveConfig({ provider: null, model: null })}
                  >
                     {t('setModelClear')}
                  </Button>
               </div>
            )}
         </Section>

         <Section title={t('setConcurrency')} hint={t('setConcurrencyHint')}>
            <div className="flex items-center gap-2">
               <Input
                  type="number"
                  min={1}
                  max={20}
                  value={concurrency}
                  disabled={readOnly}
                  className="w-24"
                  aria-label={t('setConcurrency')}
                  onChange={(event) => setConcurrency(event.target.value)}
               />
               {readOnly ? null : (
                  <Button
                     size="xs"
                     variant="secondary"
                     disabled={saving}
                     onClick={() =>
                        void saveConfig({
                           maxConcurrency: concurrency.trim() === '' ? null : Number(concurrency),
                        })
                     }
                  >
                     {common('save')}
                  </Button>
               )}
            </div>
         </Section>

         <Section title={t('setAccess')}>
            <div className="flex flex-wrap gap-2">
               {(
                  [
                     ['me', t('accessOnlyMe')],
                     ['workspace', t('accessWorkspace')],
                     ['people', t('accessPeople')],
                  ] as const
               ).map(([mode, label]) => (
                  <Button
                     key={mode}
                     size="xs"
                     variant={accessMode === mode ? 'default' : 'secondary'}
                     disabled={readOnly || !access}
                     onClick={() => {
                        if (!access) return;
                        if (mode === 'workspace') {
                           void saveAccess({ ...access, assign: 'everyone', mention: 'everyone' });
                        } else if (mode === 'me') {
                           void saveAccess({
                              assign: 'listed',
                              mention: 'listed',
                              members: sessionUserId ? [sessionUserId] : [],
                           });
                        } else {
                           void saveAccess({ ...access, assign: 'listed', mention: 'listed' });
                        }
                     }}
                  >
                     {label}
                  </Button>
               ))}
            </div>
            {accessMode === 'people' && access ? (
               <div className="flex flex-wrap gap-2">
                  {members.map((member) => {
                     const on = access.members.includes(member.id);
                     return (
                        <button
                           key={member.id}
                           type="button"
                           aria-pressed={on}
                           disabled={readOnly}
                           className={
                              on
                                 ? 'rounded-md border border-foreground px-2 py-0.5'
                                 : 'rounded-md border border-border/70 px-2 py-0.5 text-muted-foreground'
                           }
                           onClick={() =>
                              void saveAccess({
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
            ) : null}
         </Section>

         <Section title={t('setEnv')} hint={envAllowed === false ? t('envAdminOnly') : undefined}>
            {envAllowed === false ? null : (
               <>
                  <p className="text-muted-foreground">{t('envMasked')}</p>
                  {envRows === null ? (
                     <>
                        <p>
                           {agent.envNames.length === 0
                              ? common('none')
                              : agent.envNames.map((entry) => `${entry}: ••••`).join(' · ')}
                        </p>
                        {readOnly ? null : (
                           <Button
                              size="xs"
                              variant="secondary"
                              className="w-fit"
                              disabled={revealing}
                              onClick={() => void reveal()}
                           >
                              <Eye className="size-4" />
                              {revealing ? t('envRevealing') : t('envReveal')}
                           </Button>
                        )}
                     </>
                  ) : (
                     <div className="flex flex-col gap-2 rounded-md bg-muted/30 p-3">
                        {envRows.map((row, index) => (
                           <div key={index} className="flex items-center gap-2">
                              <Input
                                 value={row.name}
                                 aria-label={t('setEnv')}
                                 onChange={(event) =>
                                    setEnvRows(
                                       envRows.map((entry, at) =>
                                          at === index
                                             ? { ...entry, name: event.target.value.toUpperCase() }
                                             : entry
                                       )
                                    )
                                 }
                              />
                              <Input
                                 value={row.value}
                                 autoComplete="off"
                                 aria-label={`${row.name} value`}
                                 onChange={(event) =>
                                    setEnvRows(
                                       envRows.map((entry, at) =>
                                          at === index
                                             ? { ...entry, value: event.target.value }
                                             : entry
                                       )
                                    )
                                 }
                              />
                              <Button
                                 size="xs"
                                 variant="ghost"
                                 aria-label={common('remove')}
                                 onClick={() => setEnvRows(envRows.filter((_, at) => at !== index))}
                              >
                                 <Trash2 className="size-4" />
                              </Button>
                           </div>
                        ))}
                        <div className="flex flex-wrap items-center gap-2">
                           <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => setEnvRows([...envRows, { name: '', value: '' }])}
                           >
                              <Plus className="size-4" />
                              {t('setEnv')}
                           </Button>
                           <Button size="xs" disabled={saving} onClick={() => void saveEnv()}>
                              {saving ? common('saving') : common('save')}
                           </Button>
                           <Button size="xs" variant="ghost" onClick={() => setEnvRows(null)}>
                              {t('envHide')}
                           </Button>
                        </div>
                     </div>
                  )}

                  <div className="mt-2">
                     <h4 className="font-medium">{t('envAudit')}</h4>
                     {audit.length === 0 ? (
                        <p className="mt-1 text-muted-foreground">{t('envAuditEmpty')}</p>
                     ) : (
                        <ul className="mt-1 flex flex-col gap-1">
                           {audit.map((entry) => (
                              <li key={entry.id} className="text-muted-foreground">
                                 {entry.action === 'reveal'
                                    ? t('envAuditReveal')
                                    : t('envAuditUpdate')}{' '}
                                 ·{' '}
                                 {t('envAuditBy', {
                                    name: entry.actorName ?? list('ownerWorkspace'),
                                    when: format.relativeTime(new Date(entry.occurredAt)),
                                 })}
                                 {entry.envNames.length > 0
                                    ? ` · ${entry.envNames.join(', ')}`
                                    : ''}
                              </li>
                           ))}
                        </ul>
                     )}
                  </div>
               </>
            )}
         </Section>
      </div>
   );
}
