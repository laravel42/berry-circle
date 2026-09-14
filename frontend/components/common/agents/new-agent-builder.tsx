'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
   applyBuilderDraft,
   discardBuilderSession,
   getBuilderSession,
   sendBuilderTurn,
   startBuilderSession,
   type AgentDraft,
} from '@/lib/agent-builder';
import { BerryApiError } from '@/lib/api';
import { updateAgentConfig } from '@/lib/agents';
import { cn } from '@/lib/utils';

interface Turn {
   draftId: string;
   prompt: string;
   draft: AgentDraft;
   unknownSkills: string[];
}

interface NewAgentBuilderProps {
   /** An existing session to resume, or null to start one on the first turn. */
   sessionId: string | null;
}

/**
 * Describing an agent, and watching it take shape.
 *
 * Two panels: the conversation on the left, the draft on the right. The draft
 * is editable, because the last mile of a generated agent is almost always a
 * sentence the person would rather write themselves than ask for — and asking
 * for it costs a whole turn. Edits are applied to the created agent right
 * after the draft is, since the builder's apply route creates from what it
 * stored rather than from what is on screen.
 */
export default function NewAgentBuilder({ sessionId }: NewAgentBuilderProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const t = useTranslations('agentsChat.create');
   const detail = useTranslations('agentsChat.detail');
   const common = useTranslations('agentsChat.common');

   const [id, setId] = useState<string | null>(sessionId);
   const [turns, setTurns] = useState<Turn[]>([]);
   const [selected, setSelected] = useState<string | null>(null);
   const [prompt, setPrompt] = useState('');
   const [busy, setBusy] = useState(false);
   const [notice, setNotice] = useState<string | null>(null);
   const [edited, setEdited] = useState<{
      name: string;
      description: string;
      instructions: string;
   }>({ name: '', description: '', instructions: '' });
   const aborter = useRef<AbortController | null>(null);

   const shown = turns.find((turn) => turn.draftId === selected) ?? turns.at(-1) ?? null;

   // Resuming: the session's drafts come back in order, and the newest is the
   // one the person was last looking at.
   useEffect(() => {
      if (!sessionId) return;
      let cancelled = false;
      void getBuilderSession(sessionId)
         .then((session) => {
            if (cancelled) return;
            if (session.status === 'applied' && session.appliedAgentId) {
               router.replace(`/${orgId}/agents/${session.appliedAgentId}`);
               return;
            }
            const restored = session.drafts.map((entry) => ({
               draftId: entry.id,
               prompt: entry.prompt,
               draft: entry.draft,
               unknownSkills: [] as string[],
            }));
            setTurns(restored);
            setSelected(restored.at(-1)?.draftId ?? null);
            if (restored.length > 0) toast.info(t('aiResume'));
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [sessionId, orgId, router, t]);

   // The editable panel follows whichever draft is being shown, until it is
   // touched — after which the person's text is what matters.
   useEffect(() => {
      if (!shown) return;
      setEdited({
         name: shown.draft.name,
         description: shown.draft.description,
         instructions: shown.draft.instructions,
      });
   }, [shown?.draftId]); // eslint-disable-line react-hooks/exhaustive-deps -- reseed per draft, not per keystroke

   const draft = useCallback(async () => {
      const text = prompt.trim();
      if (!text) return;
      setBusy(true);
      setNotice(null);
      const controller = new AbortController();
      aborter.current = controller;
      try {
         let session = id;
         if (!session) {
            session = (await startBuilderSession()).id;
            setId(session);
            // The session now exists, so it gets a URL: leaving this page and
            // coming back finds the drafts rather than an empty builder.
            router.replace(`/${orgId}/agents/new/ai/${session}`);
         }
         const result = await sendBuilderTurn(session, text, controller.signal);
         setTurns((current) => [...current, { ...result, prompt: text }]);
         setSelected(result.draftId);
         setPrompt('');
      } catch (error) {
         if (controller.signal.aborted) return;
         if (error instanceof BerryApiError && error.code === 'AGENT_BUILDER_UNAVAILABLE') {
            toast.error(t('aiUnavailable'));
            router.push(`/${orgId}/agents/new`);
         } else {
            toast.error(error instanceof BerryApiError ? error.message : detail('failureUnknown'));
         }
      } finally {
         aborter.current = null;
         setBusy(false);
      }
   }, [prompt, id, orgId, router, t, detail]);

   const create = async () => {
      if (!id || !shown) return;
      setBusy(true);
      try {
         const { agentId } = await applyBuilderDraft(id, shown.draftId);
         const patch: Parameters<typeof updateAgentConfig>[1] = {};
         if (edited.name.trim() && edited.name.trim() !== shown.draft.name) {
            patch.name = edited.name.trim();
         }
         if (edited.description !== shown.draft.description) patch.description = edited.description;
         if (edited.instructions !== shown.draft.instructions) {
            patch.instructions = edited.instructions;
         }
         if (Object.keys(patch).length > 0) {
            await updateAgentConfig(agentId, patch).catch(() =>
               toast.error(detail('failureUnknown'))
            );
         }
         toast.success(edited.name.trim() || shown.draft.name);
         router.push(`/${orgId}/agents/${agentId}`);
      } catch (error) {
         if (error instanceof BerryApiError && error.code === 'MCP_SETTINGS_REQUIRED') {
            // The session stays open, so another turn can drop the servers.
            setNotice(detail('capMcpAgent'));
         } else {
            toast.error(error instanceof BerryApiError ? error.message : detail('failureUnknown'));
         }
      } finally {
         setBusy(false);
      }
   };

   const discard = async () => {
      if (!window.confirm(t('aiDiscardConfirm'))) return;
      if (id) await discardBuilderSession(id).catch(() => undefined);
      router.push(`/${orgId}/agents/new`);
   };

   return (
      <div className="grid gap-6 lg:grid-cols-2">
         <div className="flex flex-col gap-3">
            <Textarea
               rows={5}
               value={prompt}
               onChange={(event) => setPrompt(event.target.value)}
               placeholder={turns.length === 0 ? t('aiPromptFirst') : t('aiPrompt')}
               aria-label={t('ai')}
            />
            <div className="flex flex-wrap items-center gap-2">
               <Button
                  size="sm"
                  disabled={busy || prompt.trim() === ''}
                  onClick={() => void draft()}
               >
                  {turns.length === 0 ? t('aiDraft') : t('aiRefine')}
               </Button>
               {busy ? (
                  <Button
                     size="sm"
                     variant="secondary"
                     onClick={() => {
                        aborter.current?.abort();
                        setBusy(false);
                     }}
                  >
                     {t('aiStop')}
                  </Button>
               ) : null}
               {id ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void discard()}>
                     {t('aiDiscard')}
                  </Button>
               ) : null}
            </div>

            {turns.length > 0 ? (
               <ol className="flex flex-col gap-1">
                  {turns.map((turn, index) => (
                     <li key={turn.draftId}>
                        <button
                           type="button"
                           onClick={() => setSelected(turn.draftId)}
                           className={cn(
                              'w-full truncate rounded-md px-2 py-1 text-left hover:bg-sidebar/50',
                              shown?.draftId === turn.draftId && 'bg-muted/50'
                           )}
                        >
                           {index + 1}. {turn.prompt}
                        </button>
                     </li>
                  ))}
               </ol>
            ) : null}
         </div>

         <div className="flex flex-col gap-3 rounded-md border border-border p-4">
            {shown ? (
               <>
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('name')}</span>
                     <Input
                        value={edited.name}
                        onChange={(event) => setEdited({ ...edited, name: event.target.value })}
                     />
                  </label>
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('description')}</span>
                     <Input
                        value={edited.description}
                        onChange={(event) =>
                           setEdited({ ...edited, description: event.target.value })
                        }
                     />
                  </label>
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('instructions')}</span>
                     <Textarea
                        rows={10}
                        value={edited.instructions}
                        onChange={(event) =>
                           setEdited({ ...edited, instructions: event.target.value })
                        }
                     />
                  </label>

                  {shown.draft.skills.length > 0 ? (
                     <div className="flex flex-col gap-1">
                        <span className="text-muted-foreground">{t('skills')}</span>
                        <div className="flex flex-wrap gap-2">
                           {shown.draft.skills.map((skill) => {
                              const unknown = shown.unknownSkills.includes(skill);
                              return (
                                 <span
                                    key={skill}
                                    className={cn(
                                       'rounded-md border border-border/70 px-2 py-0.5',
                                       unknown && 'text-muted-foreground line-through'
                                    )}
                                 >
                                    {skill}
                                 </span>
                              );
                           })}
                        </div>
                     </div>
                  ) : null}

                  {shown.draft.model ? (
                     <p className="text-muted-foreground">
                        {t('model')}: {shown.draft.model}
                     </p>
                  ) : null}

                  {notice ? <p className="rounded-md bg-muted/40 px-3 py-2">{notice}</p> : null}

                  <Button
                     size="sm"
                     className="w-fit"
                     disabled={busy || !edited.name.trim()}
                     onClick={() => void create()}
                  >
                     {busy ? t('creating') : t('aiCreate')}
                  </Button>
               </>
            ) : (
               <p className="text-muted-foreground">{busy ? common('loading') : t('aiNoDraft')}</p>
            )}
         </div>
      </div>
   );
}
