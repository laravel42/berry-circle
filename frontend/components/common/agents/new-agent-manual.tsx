'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
   createAgent,
   getWorkspaceAgent,
   listAgentModels,
   modelKey,
   setAgentAccess,
   type AgentModel,
} from '@/lib/agents';
import { loadWorkspaceMembers } from '@/lib/members';
import { bindAgentRuntime, listRuntimes, type Runtime } from '@/lib/runtimes';
import { listSkills, setSkillForAgent, type Skill } from '@/lib/skills';
import { useSessionStore } from '@/store/session-store';

const DEFAULT_MODEL = '__default__';
const NO_RUNTIME = '__none__';
const DRAFT_KEY = 'berry.new-agent.draft';

type AccessMode = 'me' | 'workspace' | 'people';

interface Draft {
   name: string;
   description: string;
   instructions: string;
   model: string;
   runtimeId: string;
   skillIds: string[];
   access: AccessMode;
   members: string[];
}

const EMPTY: Draft = {
   name: '',
   description: '',
   instructions: '',
   model: DEFAULT_MODEL,
   runtimeId: NO_RUNTIME,
   skillIds: [],
   access: 'workspace',
   members: [],
};

interface NewAgentManualProps {
   /** Prefill from an existing agent (`?duplicate=`). */
   duplicateId?: string | null;
}

/**
 * Setting up an agent by hand.
 *
 * Everything here is written after the agent exists, not with it: skills,
 * runtime and access are separate resources with their own routes, and an
 * agent that was created but whose runtime binding failed is a better outcome
 * than a form that silently discards the rest of what was typed. Each failure
 * is reported against the thing that failed.
 *
 * The draft is kept in this browser, because losing a carefully written set of
 * instructions to a reload is the one failure this form can actually prevent.
 */
export default function NewAgentManual({ duplicateId }: NewAgentManualProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const t = useTranslations('agentsChat.create');
   const detail = useTranslations('agentsChat.detail');
   const common = useTranslations('agentsChat.common');
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const sessionUserId = useSessionStore((state) => state.user?.id);

   const [draft, setDraft] = useState<Draft>(EMPTY);
   const [restored, setRestored] = useState(false);
   const [models, setModels] = useState<AgentModel[]>([]);
   const [runtimes, setRuntimes] = useState<Runtime[]>([]);
   const [skills, setSkills] = useState<Skill[]>([]);
   const [members, setMembers] = useState<User[]>([]);
   const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState<string | null>(null);

   const set = useCallback(
      (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch })),
      []
   );

   useEffect(() => {
      listAgentModels().then(setModels, () => setModels([]));
      listRuntimes().then(setRuntimes, () => setRuntimes([]));
      listSkills().then(setSkills, () => setSkills([]));
   }, []);

   useEffect(() => {
      if (!workspaceId) return;
      loadWorkspaceMembers(workspaceId).then(setMembers, () => setMembers([]));
   }, [workspaceId]);

   // A duplicate wins over a stored draft: the person asked for this agent's
   // instructions, not for whatever they were writing yesterday.
   useEffect(() => {
      if (!duplicateId) return;
      let cancelled = false;
      void getWorkspaceAgent(duplicateId)
         .then(async (source) => {
            if (cancelled) return;
            const bound = await listSkills({ agentId: source.id }).catch(() => []);
            if (cancelled) return;
            setCopiedFrom(source.name);
            setDraft({
               ...EMPTY,
               name: `${source.name} copy`,
               description: source.description ?? '',
               instructions: source.instructions ?? '',
               model:
                  source.modelProvider && source.modelName
                     ? `${source.modelProvider}/${source.modelName}`
                     : DEFAULT_MODEL,
               // Environment variables and MCP servers are deliberately not
               // copied: they are this agent's credentials and its reach.
               skillIds: bound
                  .filter((skill) => skill.agentEnabled === true)
                  .map((skill) => skill.id),
            });
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [duplicateId]);

   useEffect(() => {
      if (duplicateId) return;
      try {
         const stored = localStorage.getItem(DRAFT_KEY);
         if (!stored) return;
         const parsed = JSON.parse(stored) as Partial<Draft>;
         if (!parsed.name && !parsed.instructions && !parsed.description) return;
         setDraft({ ...EMPTY, ...parsed });
         setRestored(true);
      } catch {
         /* An unreadable draft is no draft. */
      }
   }, [duplicateId]);

   useEffect(() => {
      if (draft === EMPTY) return;
      try {
         localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
         /* Not being able to keep a draft is not worth interrupting anyone. */
      }
   }, [draft]);

   const clearDraft = () => {
      try {
         localStorage.removeItem(DRAFT_KEY);
      } catch {
         /* Nothing to do. */
      }
   };

   const submit = async () => {
      const name = draft.name.trim();
      if (!name) return;
      setBusy(true);
      setError(null);
      const chosen =
         draft.model === DEFAULT_MODEL
            ? undefined
            : models.find((m) => modelKey(m) === draft.model);
      try {
         const agent = await createAgent({
            name,
            ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
            ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
            ...(chosen ? { provider: chosen.provider, model: chosen.id } : {}),
         });

         // The extras, each against its own route. A failure here leaves a
         // real agent that is missing one setting, which the detail page can
         // fix — rather than no agent at all.
         const problems: string[] = [];
         for (const skillId of draft.skillIds) {
            await setSkillForAgent(skillId, agent.id, true).catch(() => problems.push(t('skills')));
         }
         if (draft.runtimeId !== NO_RUNTIME) {
            await bindAgentRuntime(draft.runtimeId, agent.id).catch(() =>
               problems.push(t('runtime'))
            );
         }
         if (draft.access !== 'workspace') {
            const listed =
               draft.access === 'me' ? (sessionUserId ? [sessionUserId] : []) : draft.members;
            await setAgentAccess(agent.id, {
               assign: 'listed',
               mention: 'listed',
               members: listed,
            }).catch(() => problems.push(t('access')));
         }

         clearDraft();
         toast.success(agent.name);
         if (problems.length > 0) toast.error(problems.join(', '));
         router.push(`/${orgId}/agents/${agent.id}`);
      } catch (cause) {
         setError(cause instanceof BerryApiError ? cause.message : detail('failureUnknown'));
      } finally {
         setBusy(false);
      }
   };

   return (
      <form
         className="flex max-w-2xl flex-col gap-4"
         onSubmit={(event) => {
            event.preventDefault();
            void submit();
         }}
      >
         {copiedFrom ? (
            <div className="rounded-md border border-border/70 px-3 py-2">
               <p>{t('duplicateFrom', { name: copiedFrom })}</p>
               <p className="text-muted-foreground">{t('duplicateNote')}</p>
            </div>
         ) : null}

         {restored ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/70 px-3 py-2">
               <span>{t('draftRestored')}</span>
               <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                     clearDraft();
                     setDraft(EMPTY);
                     setRestored(false);
                  }}
               >
                  {t('discardDraft')}
               </Button>
            </div>
         ) : null}

         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">{t('name')}</span>
            <Input
               value={draft.name}
               placeholder={t('namePlaceholder')}
               onChange={(event) => set({ name: event.target.value })}
            />
         </label>

         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">{t('description')}</span>
            <Input
               value={draft.description}
               onChange={(event) => set({ description: event.target.value })}
            />
         </label>

         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">{t('instructions')}</span>
            <Textarea
               rows={8}
               value={draft.instructions}
               onChange={(event) => set({ instructions: event.target.value })}
            />
         </label>

         {skills.length > 0 ? (
            <div className="flex flex-col gap-1.5">
               <span className="text-muted-foreground">{t('skills')}</span>
               <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
                  {skills.map((skill) => (
                     <li
                        key={skill.id}
                        className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0"
                     >
                        <Checkbox
                           checked={draft.skillIds.includes(skill.id)}
                           aria-label={skill.name}
                           onCheckedChange={() =>
                              set({
                                 skillIds: draft.skillIds.includes(skill.id)
                                    ? draft.skillIds.filter((id) => id !== skill.id)
                                    : [...draft.skillIds, skill.id],
                              })
                           }
                        />
                        <div className="min-w-0">
                           <p className="truncate">{skill.name}</p>
                           {skill.description ? (
                              <p className="line-clamp-1 text-muted-foreground">
                                 {skill.description}
                              </p>
                           ) : null}
                        </div>
                     </li>
                  ))}
               </ul>
            </div>
         ) : null}

         <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">{t('runtime')}</span>
            <Select value={draft.runtimeId} onValueChange={(value) => set({ runtimeId: value })}>
               <SelectTrigger className="w-80" aria-label={t('runtime')}>
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value={NO_RUNTIME}>{detail('setRuntimeNone')}</SelectItem>
                  {runtimes.map((runtime) => (
                     <SelectItem key={runtime.id} value={runtime.id}>
                        {runtime.name}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
         </div>

         {models.length > 0 ? (
            <div className="flex flex-col gap-1.5">
               <span className="text-muted-foreground">{t('model')}</span>
               <Select value={draft.model} onValueChange={(value) => set({ model: value })}>
                  <SelectTrigger className="w-80" aria-label={t('model')}>
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value={DEFAULT_MODEL}>{t('modelDefault')}</SelectItem>
                     {models.map((model) => (
                        <SelectItem key={modelKey(model)} value={modelKey(model)}>
                           {model.displayName} · {model.provider}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
            </div>
         ) : null}

         <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">{t('access')}</span>
            <div className="flex flex-wrap gap-2">
               {(
                  [
                     ['me', detail('accessOnlyMe')],
                     ['workspace', detail('accessWorkspace')],
                     ['people', detail('accessPeople')],
                  ] as const
               ).map(([mode, label]) => (
                  <Button
                     key={mode}
                     type="button"
                     size="xs"
                     variant={draft.access === mode ? 'default' : 'secondary'}
                     onClick={() => set({ access: mode })}
                  >
                     {label}
                  </Button>
               ))}
            </div>
            {draft.access === 'people' ? (
               <div className="flex flex-wrap gap-2">
                  {members.map((member) => {
                     const on = draft.members.includes(member.id);
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
                              set({
                                 members: on
                                    ? draft.members.filter((id) => id !== member.id)
                                    : [...draft.members, member.id],
                              })
                           }
                        >
                           {member.name}
                        </button>
                     );
                  })}
               </div>
            ) : null}
         </div>

         {error ? (
            <p role="alert" className="text-destructive">
               {error}
            </p>
         ) : null}

         <div className="flex items-center gap-3">
            <Button type="submit" size="sm" className="w-fit" disabled={busy || !draft.name.trim()}>
               {busy ? t('creating') : t('create')}
            </Button>
            <span className="text-muted-foreground">{t('draftSaved')}</span>
            <span className="sr-only">{common('save')}</span>
         </div>
      </form>
   );
}
