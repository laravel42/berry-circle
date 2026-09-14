'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import {
   createWorkspace,
   selectWorkspace,
   slugFromWorkspaceName,
   updateWorkspaceSettings,
} from '@/lib/workspaces';
import { useSessionStore } from '@/store/session-store';

/**
 * Slugs that would shadow a page Berry already serves.
 *
 * Workspace routes are `/{slug}/…` at the root, so a workspace called
 * "settings" or "invite" would sit on top of an existing route and be
 * unreachable — or worse, make the real page unreachable. Refused here rather
 * than discovered later, when renaming means breaking every link.
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

/**
 * Create a workspace.
 *
 * Onboarding's version of this asks for a name and derives everything else
 * silently, which is fine for a first workspace and wrong for a deliberate
 * second one: the address and the task prefix are both in every link and every
 * task reference afterwards, and the address cannot be changed at all. Both are
 * shown, derived from the name as you type, and editable before anything is
 * created — which is the only moment either is cheap to decide.
 */
export default function NewWorkspacePage() {
   const t = useTranslations('workspaceAdmin.newWorkspace');
   const router = useRouter();
   const refreshWorkspaces = useSessionStore((state) => state.refreshWorkspaces);

   const [name, setName] = useState('');
   const [slug, setSlug] = useState('');
   const [slugEdited, setSlugEdited] = useState(false);
   const [prefix, setPrefix] = useState('');
   const [prefixEdited, setPrefixEdited] = useState(false);
   const [description, setDescription] = useState('');
   const [creating, setCreating] = useState(false);
   const [failure, setFailure] = useState<string | null>(null);

   // Derived until touched: typing a name fills both, and editing either one
   // pins it, so the derivation never overwrites a deliberate choice.
   const effectiveSlug = slugEdited ? slug : slugFromWorkspaceName(name);
   const effectivePrefix = prefixEdited ? prefix : prefixFromName(name);

   const slugProblem =
      name.trim() === ''
         ? null
         : RESERVED.has(effectiveSlug)
           ? t('slugReserved')
           : SLUG.test(effectiveSlug)
             ? null
             : t('slugInvalid');
   const prefixProblem =
      name.trim() === '' || PREFIX.test(effectivePrefix) ? null : t('prefixInvalid');
   const ready = name.trim() !== '' && slugProblem === null && prefixProblem === null;

   const create = async () => {
      setCreating(true);
      setFailure(null);
      try {
         const workspace = await createWorkspace({
            name: name.trim(),
            slug: effectiveSlug,
            description: description.trim() || undefined,
         });

         // Create takes no prefix — the server derives one from the name — so a
         // chosen one is applied straight afterwards, while the workspace has
         // no tasks and renumbering costs nothing.
         if (workspace.settings?.issuePrefix !== effectivePrefix) {
            await updateWorkspaceSettings(workspace.id, { issuePrefix: effectivePrefix }).catch(
               () => undefined
            );
         }

         await selectWorkspace(workspace.id).catch(() => undefined);
         const entered = await refreshWorkspaces().catch(() => null);
         router.replace(`/${entered?.slug ?? workspace.slug}/tasks`);
      } catch (cause) {
         setFailure(
            cause instanceof BerryApiError && cause.status === 409
               ? t('slugTaken')
               : cause instanceof Error
                 ? cause.message
                 : t('createFailed')
         );
         setCreating(false);
      }
   };

   return (
      <div className="flex min-h-svh justify-center bg-background px-6 py-16">
         <div className="w-full max-w-xl">
            <h1 className="font-display tracking-[-0.025em]">{t('title')}</h1>
            <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>

            <div className="mt-8 flex flex-col gap-5">
               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{t('name')}</span>
                  <Input
                     value={name}
                     autoFocus
                     placeholder={t('namePlaceholder')}
                     disabled={creating}
                     onChange={(event) => setName(event.target.value)}
                  />
               </label>

               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{t('slug')}</span>
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
                     {slugProblem ?? t('slugHint', { url: `/${effectiveSlug || '…'}` })}
                  </span>
               </label>

               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{t('prefix')}</span>
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
                     {prefixProblem ?? t('prefixHint', { example: `${effectivePrefix || 'WS'}-1` })}
                  </span>
               </label>

               <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{t('description')}</span>
                  <Textarea
                     value={description}
                     rows={3}
                     maxLength={5000}
                     placeholder={t('descriptionPlaceholder')}
                     disabled={creating}
                     onChange={(event) => setDescription(event.target.value)}
                  />
               </label>

               {failure ? (
                  <p role="alert" className="text-status-danger">
                     {failure}
                  </p>
               ) : null}

               <div className="flex items-center justify-between gap-3">
                  <Link href="/onboarding" className="text-muted-foreground hover:underline">
                     {t('cancel')}
                  </Link>
                  <Button disabled={!ready || creating} onClick={() => void create()}>
                     {creating ? t('creating') : t('create')}
                  </Button>
               </div>
            </div>
         </div>
      </div>
   );
}
