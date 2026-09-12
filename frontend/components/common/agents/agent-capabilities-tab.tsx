'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { McpServerManager } from '@/components/common/settings/mcp-servers';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { updateAgentConfig, type Agent } from '@/lib/agents';
import { listSkills, setSkillForAgent, type Skill } from '@/lib/skills';

const MAX_STARTERS = 3;

const reason = (error: unknown, fallback: string) =>
   error instanceof BerryApiError ? error.message : fallback;

interface AgentCapabilitiesTabProps {
   agent: Agent;
   readOnly: boolean;
   onChange: (agent: Agent) => void;
   /** Told whenever an editor holds unsaved text, for the page's leave guard. */
   onDirtyChange: (dirty: boolean) => void;
   /** Called when the server refuses a write, so the page can say so once. */
   onForbidden: () => void;
}

/**
 * What the agent knows how to do: its instructions, the openers it offers, the
 * skills it carries, and the MCP servers it may reach.
 *
 * Instructions and starters are drafts until saved, which is why this tab
 * reports dirtiness upwards — navigating away from half-written instructions
 * silently is the one failure mode that costs real work.
 */
export default function AgentCapabilitiesTab({
   agent,
   readOnly,
   onChange,
   onDirtyChange,
   onForbidden,
}: AgentCapabilitiesTabProps) {
   const t = useTranslations('agentsChat.detail');
   const common = useTranslations('agentsChat.common');

   /**
    * A refusal is reported once as a toast, and once as a standing fact: a
    * reader who cannot edit this agent should be told that, not left to
    * discover it one failed save at a time.
    */
   const failed = (error: unknown) => {
      if (error instanceof BerryApiError && error.status === 403) onForbidden();
      toast.error(reason(error, t('failureUnknown')));
   };

   const [instructions, setInstructions] = useState(agent.instructions ?? '');
   const [starters, setStarters] = useState<string[]>(agent.conversationStarters);
   const [saving, setSaving] = useState(false);
   const [skills, setSkills] = useState<Skill[] | null>(null);
   const [picking, setPicking] = useState(false);
   const [query, setQuery] = useState('');
   const [chosen, setChosen] = useState<string[]>([]);

   useEffect(() => {
      setInstructions(agent.instructions ?? '');
      setStarters(agent.conversationStarters);
   }, [agent.instructions, agent.conversationStarters]);

   const instructionsDirty = instructions !== (agent.instructions ?? '');
   const startersDirty =
      starters.length !== agent.conversationStarters.length ||
      starters.some((entry, index) => entry !== agent.conversationStarters[index]);

   useEffect(() => {
      onDirtyChange(instructionsDirty || startersDirty);
   }, [instructionsDirty, startersDirty, onDirtyChange]);

   const loadSkills = useCallback(async () => {
      try {
         setSkills(await listSkills({ agentId: agent.id }));
      } catch (error) {
         // A read that fails says nothing about whether this agent is
         // editable, so it reports itself and nothing more.
         toast.error(reason(error, t('failureUnknown')));
      }
   }, [agent.id, t]);

   useEffect(() => {
      void loadSkills();
   }, [loadSkills]);

   const save = async (patch: { instructions?: string; starters?: string[] }) => {
      setSaving(true);
      try {
         onChange(await updateAgentConfig(agent.id, patch));
         toast.success(common('saved'));
      } catch (error) {
         failed(error);
      } finally {
         setSaving(false);
      }
   };

   const assigned = (skills ?? []).filter((skill) => skill.agentEnabled === true);
   const available = (skills ?? []).filter(
      (skill) =>
         skill.agentEnabled !== true &&
         (query.trim() === '' ||
            skill.name.toLowerCase().includes(query.trim().toLowerCase()) ||
            skill.description.toLowerCase().includes(query.trim().toLowerCase()))
   );

   const setSkill = async (skill: Skill, enabled: boolean | null) => {
      try {
         await setSkillForAgent(skill.id, agent.id, enabled);
         await loadSkills();
      } catch (error) {
         failed(error);
      }
   };

   return (
      <div className="flex max-w-3xl flex-col gap-8 px-8 py-6">
         <section className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
               <h3 className="font-medium">{t('capInstructions')}</h3>
               <p className="text-muted-foreground">{t('capInstructionsHint')}</p>
               {instructionsDirty ? (
                  <span className="ml-auto text-amber-500">{t('capUnsaved')}</span>
               ) : null}
            </div>
            <Textarea
               rows={10}
               value={instructions}
               disabled={readOnly}
               aria-label={t('capInstructions')}
               onChange={(event) => setInstructions(event.target.value)}
            />
            {readOnly ? null : (
               <Button
                  size="xs"
                  className="w-fit"
                  disabled={saving || !instructionsDirty}
                  onClick={() => void save({ instructions })}
               >
                  {saving ? common('saving') : common('save')}
               </Button>
            )}
         </section>

         <section className="flex flex-col gap-2 border-t border-border/70 pt-6">
            <div className="flex items-baseline gap-2">
               <h3 className="font-medium">{t('capStarters')}</h3>
               <p className="text-muted-foreground">{t('capStartersHint')}</p>
               {startersDirty ? (
                  <span className="ml-auto text-amber-500">{t('capUnsaved')}</span>
               ) : null}
            </div>
            <div className="flex flex-col gap-2">
               {starters.map((starter, index) => (
                  <div key={index} className="flex items-center gap-2">
                     <Input
                        value={starter}
                        disabled={readOnly}
                        aria-label={`${t('capStarters')} ${index + 1}`}
                        onChange={(event) =>
                           setStarters(
                              starters.map((entry, at) =>
                                 at === index ? event.target.value : entry
                              )
                           )
                        }
                     />
                     {readOnly ? null : (
                        <Button
                           size="xs"
                           variant="ghost"
                           aria-label={t('capStarterRemove')}
                           onClick={() => setStarters(starters.filter((_, at) => at !== index))}
                        >
                           <Trash2 className="size-4" />
                        </Button>
                     )}
                  </div>
               ))}
               {readOnly ? null : starters.length < MAX_STARTERS ? (
                  <Button
                     size="xs"
                     variant="secondary"
                     className="w-fit"
                     onClick={() => setStarters([...starters, ''])}
                  >
                     <Plus className="size-4" />
                     {t('capStarterAdd')}
                  </Button>
               ) : (
                  <p className="text-muted-foreground">{t('capStartersFull')}</p>
               )}
            </div>

            {starters.some((entry) => entry.trim()) ? (
               <div className="mt-2 rounded-lg border border-border/70 p-3">
                  <p className="text-muted-foreground">{t('capStarterPreview')}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                     {starters
                        .filter((entry) => entry.trim())
                        .map((entry, index) => (
                           <span
                              key={index}
                              className="rounded-md bg-muted/60 px-2.5 py-1 text-muted-foreground"
                           >
                              {entry.trim()}
                           </span>
                        ))}
                  </div>
               </div>
            ) : null}

            {readOnly ? null : (
               <Button
                  size="xs"
                  className="w-fit"
                  disabled={saving || !startersDirty}
                  onClick={() => void save({ starters: starters.filter((entry) => entry.trim()) })}
               >
                  {saving ? common('saving') : common('save')}
               </Button>
            )}
         </section>

         <section className="flex flex-col gap-2 border-t border-border/70 pt-6">
            <div className="flex items-baseline gap-2">
               <h3 className="font-medium">{t('capSkills')}</h3>
               {readOnly ? null : (
                  <Button
                     size="xs"
                     variant="secondary"
                     className="ml-auto"
                     onClick={() => {
                        setChosen([]);
                        setQuery('');
                        setPicking(true);
                     }}
                  >
                     {t('capSkillsAssign')}
                  </Button>
               )}
            </div>
            {skills === null ? (
               <p className="text-muted-foreground">{common('loading')}</p>
            ) : assigned.length === 0 ? (
               <p className="text-muted-foreground">{t('capSkillsEmpty')}</p>
            ) : (
               <ul className="flex flex-col rounded-md border border-border">
                  {assigned.map((skill) => (
                     <li
                        key={skill.id}
                        className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5 last:border-b-0"
                     >
                        <div className="min-w-0">
                           <p className="truncate font-medium">{skill.name}</p>
                           {skill.description ? (
                              <p className="line-clamp-1 text-muted-foreground">
                                 {skill.description}
                              </p>
                           ) : null}
                        </div>
                        {readOnly ? null : (
                           <Button
                              size="xs"
                              variant="ghost"
                              aria-label={t('capSkillRemove', { name: skill.name })}
                              onClick={() => void setSkill(skill, null)}
                           >
                              <Trash2 className="size-4" />
                           </Button>
                        )}
                     </li>
                  ))}
               </ul>
            )}
         </section>

         <section className="flex flex-col gap-4 border-t border-border/70 pt-6">
            <div className="flex flex-col gap-2">
               <h3 className="font-medium">{t('capMcpAgent')}</h3>
               <McpServerManager agentId={agent.id} readOnly={readOnly} />
            </div>
            <div className="flex flex-col gap-2">
               <h3 className="font-medium">{t('capMcpWorkspace')}</h3>
               <McpServerManager agentId={null} readOnly />
            </div>
         </section>

         <Dialog open={picking} onOpenChange={setPicking}>
            <DialogContent className="sm:max-w-lg">
               <DialogHeader>
                  <DialogTitle>{t('capSkillsDialogTitle')}</DialogTitle>
                  <DialogDescription>{t('capStartersHint')}</DialogDescription>
               </DialogHeader>
               <Input
                  autoFocus
                  value={query}
                  placeholder={t('capSkillsSearch')}
                  aria-label={t('capSkillsSearch')}
                  onChange={(event) => setQuery(event.target.value)}
               />
               <ul className="max-h-72 overflow-y-auto rounded-md border border-border">
                  {available.length === 0 ? (
                     <li className="px-3 py-2.5 text-muted-foreground">{t('capSkillsEmpty')}</li>
                  ) : (
                     available.map((skill) => (
                        <li
                           key={skill.id}
                           className="flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
                        >
                           <Checkbox
                              checked={chosen.includes(skill.id)}
                              aria-label={skill.name}
                              onCheckedChange={() =>
                                 setChosen(
                                    chosen.includes(skill.id)
                                       ? chosen.filter((id) => id !== skill.id)
                                       : [...chosen, skill.id]
                                 )
                              }
                           />
                           <div className="min-w-0">
                              <p className="truncate font-medium">{skill.name}</p>
                              {skill.description ? (
                                 <p className="line-clamp-2 text-muted-foreground">
                                    {skill.description}
                                 </p>
                              ) : null}
                           </div>
                        </li>
                     ))
                  )}
               </ul>
               <div className="flex items-center gap-2">
                  <Button
                     size="sm"
                     disabled={chosen.length === 0}
                     onClick={() => {
                        const picked = (skills ?? []).filter((skill) => chosen.includes(skill.id));
                        setPicking(false);
                        void (async () => {
                           for (const skill of picked) await setSkill(skill, true);
                        })();
                     }}
                  >
                     {t('capSkillsAdd')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
                     {common('cancel')}
                  </Button>
               </div>
            </DialogContent>
         </Dialog>
      </div>
   );
}
