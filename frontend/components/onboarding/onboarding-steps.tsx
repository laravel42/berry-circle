'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { saveOnboarding, type OnboardingAnswerKey } from '@/lib/onboarding';
import { listRuntimes, updateRuntime, type Runtime } from '@/lib/runtimes';
import { createWorkspace, slugFromWorkspaceName, updateWorkspaceSettings } from '@/lib/workspaces';

/**
 * First-run setup, as steps rather than a single form.
 *
 * There were no steps before: a person with no workspace got one card asking
 * for a name, and everything else — the address, the task prefix, the runtime
 * their agents would use — was derived in silence and discovered later, when
 * two of the three could no longer be changed.
 *
 * So each decision gets the moment it is cheap in:
 *
 *  - welcome, which asks nothing and can be walked past;
 *  - about you, which is skippable by design — the answers shape what Berry
 *    suggests, and nobody owes them;
 *  - workspace, where the address and the task prefix are shown as they are
 *    derived, and can be corrected before anything exists to break;
 *  - runtime, which picks the AgentCore runtime the workspace's agents run on,
 *    or leaves the workspace default alone.
 *
 * "Skip setup" is on every step, because the only thing genuinely required is
 * the workspace, and anybody who wants to get on with it should be able to.
 * The server records skipping as a way of completing, which is what it is.
 */

type Step = 'welcome' | 'aboutYou' | 'workspace' | 'runtime';

/**
 * Slugs that would shadow a page Berry already serves.
 *
 * Workspace routes sit at the root as `/{slug}/…`, so a workspace called
 * "settings" or "invite" would be unreachable, or would make the real page
 * unreachable. Refused here rather than discovered later, when the address
 * cannot be changed at all.
 */
const RESERVED = new Set([
   'api',
   'invitations',
   'invite',
   'join',
   'login',
   'onboarding',
   'settings',
   'sign-in',
   'sign-up',
   'workspaces',
]);

const SLUG = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const PREFIX = /^[A-Z][A-Z0-9]{1,9}$/;

/** The server's own derivation, mirrored so the field shows what it will get. */
function prefixFromName(name: string): string {
   const letters = name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 3);
   return letters.length >= 2 && /^[A-Z]/.test(letters) ? letters : 'WS';
}

export function OnboardingSteps({
   onEntered,
   onSkipped,
}: {
   /** Called with a workspace the user now belongs to; the parent routes in. */
   onEntered: (workspaceId: string) => Promise<void> | void;
   /** Called when setup is abandoned before a workspace exists. */
   onSkipped: () => void;
}) {
   const t = useTranslations('workspaceAdmin.onboarding');
   const nw = useTranslations('workspaceAdmin.newWorkspace');

   const [step, setStep] = useState<Step>('welcome');
   const [failure, setFailure] = useState<string | null>(null);

   // about you
   const [answers, setAnswers] = useState<Partial<Record<OnboardingAnswerKey, string>>>({});

   // workspace
   const [name, setName] = useState('');
   const [slug, setSlug] = useState('');
   const [slugEdited, setSlugEdited] = useState(false);
   const [prefix, setPrefix] = useState('');
   const [prefixEdited, setPrefixEdited] = useState(false);
   const [creating, setCreating] = useState(false);
   const [workspaceId, setWorkspaceId] = useState<string | null>(null);

   // runtime
   const [runtimes, setRuntimes] = useState<Runtime[] | null>(null);
   const [choosing, setChoosing] = useState(false);

   const effectiveSlug = slugEdited ? slug : slugFromWorkspaceName(name);
   const effectivePrefix = prefixEdited ? prefix : prefixFromName(name);

   const slugProblem = useMemo(() => {
      if (name.trim() === '') return null;
      if (RESERVED.has(effectiveSlug)) return nw('slugReserved');
      return SLUG.test(effectiveSlug) ? null : nw('slugInvalid');
   }, [name, effectiveSlug, nw]);
   const prefixProblem =
      name.trim() === '' || PREFIX.test(effectivePrefix) ? null : nw('prefixInvalid');
   const workspaceReady = name.trim() !== '' && slugProblem === null && prefixProblem === null;

   // Only once the workspace exists, since runtimes are read inside it.
   useEffect(() => {
      if (step !== 'runtime' || runtimes !== null) return;
      void listRuntimes()
         .then(setRuntimes)
         .catch(() => setRuntimes([]));
   }, [step, runtimes]);

   /** Records the step on the account, but never blocks moving on. */
   const go = (next: Step) => {
      setStep(next);
      void saveOnboarding({ step: next === 'runtime' ? 'workspace' : next }).catch(() => undefined);
   };

   const skip = () => {
      void saveOnboarding({ skipped: true }).catch(() => undefined);
      if (workspaceId) void onEntered(workspaceId);
      else onSkipped();
   };

   const saveAnswers = () => {
      const filled = Object.fromEntries(
         Object.entries(answers).filter(([, value]) => value.trim() !== '')
      );
      if (Object.keys(filled).length > 0) {
         void saveOnboarding({ answers: filled }).catch(() => undefined);
      }
      go('workspace');
   };

   const create = async () => {
      setCreating(true);
      setFailure(null);
      try {
         const workspace = await createWorkspace({
            name: name.trim(),
            slug: effectiveSlug,
         });
         // Create takes no prefix — the server derives one — so a chosen one is
         // applied straight afterwards, while there are no tasks and
         // renumbering costs nothing.
         if (workspace.settings?.issuePrefix !== effectivePrefix) {
            await updateWorkspaceSettings(workspace.id, { issuePrefix: effectivePrefix }).catch(
               () => undefined
            );
         }
         setWorkspaceId(workspace.id);
         go('runtime');
      } catch (cause) {
         setFailure(
            cause instanceof BerryApiError && cause.status === 409
               ? nw('slugTaken')
               : cause instanceof Error
                 ? cause.message
                 : nw('createFailed')
         );
      } finally {
         setCreating(false);
      }
   };

   const finish = async (runtimeId: string | null) => {
      setChoosing(true);
      if (runtimeId) {
         // Making it the default is the whole choice: an agent with nothing
         // said about it runs on the workspace's default runtime.
         await updateRuntime(runtimeId, { isDefault: true }).catch(() => undefined);
      }
      await saveOnboarding({ completed: true }).catch(() => undefined);
      if (workspaceId) await onEntered(workspaceId);
      setChoosing(false);
   };

   const skipLink = (
      <button type="button" className="text-muted-foreground hover:underline" onClick={skip}>
         {t('skip')}
      </button>
   );

   if (step === 'welcome') {
      return (
         <AuthCard title={t('welcomeTitle')} description={t('welcomeBody')}>
            <div className="flex flex-col gap-3">
               <ul className="flex flex-col gap-2 text-muted-foreground">
                  <li>{t('welcomePoint1')}</li>
                  <li>{t('welcomePoint2')}</li>
                  <li>{t('welcomePoint3')}</li>
               </ul>
               <Button onClick={() => go('aboutYou')}>{t('start')}</Button>
               <div className="text-center">{skipLink}</div>
            </div>
         </AuthCard>
      );
   }

   if (step === 'aboutYou') {
      return (
         <AuthCard title={t('aboutTitle')} description={t('aboutBody')}>
            <div className="flex flex-col gap-4">
               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{t('role')}</span>
                  <Input
                     value={answers.role ?? ''}
                     placeholder={t('rolePlaceholder')}
                     maxLength={500}
                     onChange={(event) =>
                        setAnswers((current) => ({ ...current, role: event.target.value }))
                     }
                  />
               </label>
               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{t('goal')}</span>
                  <Textarea
                     value={answers.goal ?? ''}
                     rows={3}
                     maxLength={500}
                     placeholder={t('goalPlaceholder')}
                     onChange={(event) =>
                        setAnswers((current) => ({ ...current, goal: event.target.value }))
                     }
                  />
               </label>
               <div className="flex items-center justify-between gap-3">
                  <button
                     type="button"
                     className="text-muted-foreground hover:underline"
                     onClick={() => go('workspace')}
                  >
                     {t('skipStep')}
                  </button>
                  <Button onClick={saveAnswers}>{t('next')}</Button>
               </div>
               <div className="text-center">{skipLink}</div>
            </div>
         </AuthCard>
      );
   }

   if (step === 'workspace') {
      return (
         <AuthCard title={t('workspaceTitle')} description={t('workspaceBody')}>
            <div className="flex flex-col gap-4">
               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{nw('name')}</span>
                  <Input
                     value={name}
                     autoFocus
                     placeholder={nw('namePlaceholder')}
                     disabled={creating}
                     onChange={(event) => setName(event.target.value)}
                  />
               </label>

               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{nw('slug')}</span>
                  <Input
                     value={effectiveSlug}
                     className="font-mono"
                     disabled={creating}
                     aria-invalid={slugProblem !== null}
                     onChange={(event) => {
                        setSlugEdited(true);
                        setSlug(
                           event.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9-]/g, '')
                              .slice(0, 50)
                        );
                     }}
                  />
                  <span className={slugProblem ? 'text-status-danger' : 'text-muted-foreground'}>
                     {slugProblem ?? nw('slugHint', { url: `/${effectiveSlug || '…'}` })}
                  </span>
               </label>

               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{nw('prefix')}</span>
                  <Input
                     value={effectivePrefix}
                     className="w-40 font-mono"
                     disabled={creating}
                     aria-invalid={prefixProblem !== null}
                     onChange={(event) => {
                        setPrefixEdited(true);
                        setPrefix(
                           event.target.value
                              .toUpperCase()
                              .replace(/[^A-Z0-9]/g, '')
                              .slice(0, 10)
                        );
                     }}
                  />
                  <span className={prefixProblem ? 'text-status-danger' : 'text-muted-foreground'}>
                     {prefixProblem ??
                        nw('prefixHint', { example: `${effectivePrefix || 'WS'}-1` })}
                  </span>
               </label>

               {failure ? (
                  <p role="alert" className="text-status-danger">
                     {failure}
                  </p>
               ) : null}

               <Button disabled={!workspaceReady || creating} onClick={() => void create()}>
                  {creating ? nw('creating') : nw('create')}
               </Button>
               <div className="text-center">{skipLink}</div>
            </div>
         </AuthCard>
      );
   }

   return (
      <AuthCard title={t('runtimeTitle')} description={t('runtimeBody')}>
         <div className="flex flex-col gap-3">
            {runtimes === null ? (
               <p className="text-muted-foreground">{t('runtimeLoading')}</p>
            ) : null}
            {runtimes !== null && runtimes.length === 0 ? (
               <p className="text-muted-foreground">{t('runtimeNone')}</p>
            ) : null}
            {(runtimes ?? []).map((runtime) => (
               <button
                  key={runtime.id}
                  type="button"
                  disabled={choosing}
                  onClick={() => void finish(runtime.id)}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/40"
               >
                  <span className="min-w-0">
                     <span className="block truncate font-medium">{runtime.name}</span>
                     <span className="block truncate text-muted-foreground">
                        {runtime.isDefault ? t('runtimeIsDefault') : t('runtimeMakeDefault')}
                     </span>
                  </span>
               </button>
            ))}
            <Button variant="secondary" disabled={choosing} onClick={() => void finish(null)}>
               {t('runtimeKeepDefault')}
            </Button>
         </div>
      </AuthCard>
   );
}
