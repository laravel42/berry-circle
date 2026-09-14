'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import {
   deleteWorkspace,
   leaveWorkspace,
   listWorkspaceMemberRoles,
   loadWorkspace,
   updateWorkspace,
   updateWorkspaceSettings,
   type WorkspaceSummary,
} from '@/lib/workspaces';
import { useSessionStore } from '@/store/session-store';
import { SaveIndicator } from './save-indicator';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useAutosave } from './use-autosave';
import { useSettingsResource } from './use-settings-resource';

const CONTEXT_MAX = 10_000;
const PREFIX_MAX = 10;

/**
 * The server's rule, not a looser one: the first character must be a letter,
 * and two is the minimum. A prefix this refuses would be refused by the API,
 * and finding that out after a confirm dialog is a worse way to learn it.
 */
const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/**
 * Workspace "General".
 *
 * Everything here except the issue prefix saves itself. The prefix does not,
 * because it is the one field whose change is not confined to this page:
 * issue identifiers are derived from it at read time, so saving it renames
 * every task reference in the workspace at once. That earns a confirm and an
 * example of what the references will look like afterwards.
 *
 * The slug is shown and not editable. It is in every URL anyone has
 * bookmarked, and Berry has no redirect from the old one — so offering a field
 * that silently breaks links would be worse than not offering it.
 *
 * Owners and admins edit; everyone else reads. The server enforces this with
 * `workspace.update`, and the page reflects it rather than letting someone
 * type into a field whose save is going to 403.
 */
export default function WorkspaceGeneral() {
   const t = useTranslations('workspaceAdmin.general');
   const router = useRouter();
   const current = useSessionStore((state) => state.workspace);
   const refreshWorkspaces = useSessionStore((state) => state.refreshWorkspaces);
   const workspaceId = current?.id ?? '';

   const workspace = useSettingsResource<WorkspaceSummary>(
      () =>
         workspaceId
            ? loadWorkspace(workspaceId)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );
   const record = workspace.value;
   const canEdit = record?.role === 'owner' || record?.role === 'admin';
   const isOwner = record?.role === 'owner';

   // Only to answer "are you the last owner?". A sole owner who left would
   // abandon a workspace nobody can administer, and the server refuses it — so
   // the button says so instead of offering an action that cannot succeed.
   const [owners, setOwners] = useState<number | null>(null);
   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      void listWorkspaceMemberRoles(workspaceId)
         .then((members) => {
            if (!cancelled) setOwners(members.filter((m) => m.role === 'owner').length);
         })
         .catch(() => {
            if (!cancelled) setOwners(null);
         });
      return () => {
         cancelled = true;
      };
   }, [workspaceId]);
   const soleOwner = isOwner && owners === 1;

   const write = useCallback(
      async (patch: Parameters<typeof updateWorkspace>[1]) => {
         const saved = await updateWorkspace(workspaceId, patch);
         workspace.set(saved);
      },
      // `workspace.set` is stable (a useState setter behind the resource).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [workspaceId]
   );

   const name = useAutosave<string>({
      saved: record?.name,
      equals: (a, b) => a.trim() === b.trim(),
      accepts: (next) => next.trim() !== '',
      save: (next) => write({ name: next.trim() }),
   });

   const description = useAutosave<string>({
      saved: record?.description ?? '',
      equals: (a, b) => a.trim() === b.trim(),
      save: (next) => write({ description: next.trim() === '' ? null : next.trim() }),
   });

   const logo = useAutosave<string>({
      saved: record?.logoUrl ?? '',
      equals: (a, b) => a.trim() === b.trim(),
      save: (next) => write({ logoUrl: next.trim() === '' ? null : next.trim() }),
   });

   const context = useAutosave<string>({
      saved: record?.agentContext ?? '',
      equals: (a, b) => a.trim() === b.trim(),
      save: (next) => write({ agentContext: next.trim() === '' ? null : next.trim() }),
   });

   const contextText = context.value ?? '';

   // ------------------------------------------------------------ issue prefix

   const savedPrefix = record?.settings?.issuePrefix ?? '';
   const [prefix, setPrefix] = useState('');
   const [confirmingPrefix, setConfirmingPrefix] = useState(false);
   const [savingPrefix, setSavingPrefix] = useState(false);
   useEffect(() => setPrefix(savedPrefix), [savedPrefix]);

   const prefixValid = PREFIX_PATTERN.test(prefix);
   const prefixChanged = prefix !== savedPrefix && prefix !== '';

   const commitPrefix = async () => {
      setSavingPrefix(true);
      try {
         const saved = await updateWorkspaceSettings(workspaceId, { issuePrefix: prefix });
         if (record) workspace.set({ ...record, settings: saved });
         setConfirmingPrefix(false);
         toast.success(t('prefixSaved'));
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('prefixFailed'));
      } finally {
         setSavingPrefix(false);
      }
   };

   // ------------------------------------------------------------ danger zone

   const [leaving, setLeaving] = useState(false);
   const [confirmingLeave, setConfirmingLeave] = useState(false);
   const [confirmingDelete, setConfirmingDelete] = useState(false);
   const [deleting, setDeleting] = useState(false);
   const [typedName, setTypedName] = useState('');

   /**
    * Where someone lands after they no longer belong here. Bootstrap is
    * re-read first, so the destination is a workspace the server still agrees
    * they are in — routing from a stale list would land them on a page that
    * immediately refuses them.
    */
   const goElsewhere = useCallback(async () => {
      const next = await refreshWorkspaces().catch(() => null);
      router.replace(next ? `/${next.slug}/tasks` : '/onboarding');
   }, [refreshWorkspaces, router]);

   const confirmLeave = async () => {
      setLeaving(true);
      try {
         await leaveWorkspace(workspaceId);
         setConfirmingLeave(false);
         await goElsewhere();
      } catch (cause) {
         toast.error(
            cause instanceof BerryApiError && cause.status === 409
               ? t('leaveSoleOwner')
               : cause instanceof Error
                 ? cause.message
                 : t('leaveFailed')
         );
         setLeaving(false);
      }
   };

   const confirmDelete = async () => {
      setDeleting(true);
      try {
         await deleteWorkspace(workspaceId);
         await goElsewhere();
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('deleteFailed'));
         setDeleting(false);
      }
   };

   const nameMatches = useMemo(
      () => typedName.trim() === (record?.name ?? '').trim() && typedName.trim() !== '',
      [typedName, record?.name]
   );

   return (
      <SettingsShell title={t('title')} description={t('subtitle')}>
         <SettingsSection description={workspace.error ?? (canEdit ? undefined : t('readOnly'))}>
            <SettingsCard>
               <SettingsRow
                  title={t('logo')}
                  description={t('logoDescription')}
                  trailing={
                     <span className="flex items-center gap-2">
                        <SaveIndicator state={logo.state} error={logo.error} onRetry={logo.retry} />
                        <Input
                           value={logo.value ?? ''}
                           aria-label={t('logoLabel')}
                           placeholder="https://"
                           inputMode="url"
                           disabled={!canEdit || workspace.loading}
                           className="h-8 w-52"
                           onChange={(event) => logo.change(event.target.value)}
                           onBlur={logo.flush}
                           onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                              if (event.key === 'Escape') logo.revert();
                           }}
                        />
                     </span>
                  }
               />
               <SettingsRow
                  title={t('name')}
                  trailing={
                     <span className="flex items-center gap-2">
                        <SaveIndicator state={name.state} error={name.error} onRetry={name.retry} />
                        <Input
                           value={name.value ?? ''}
                           aria-label={t('name')}
                           disabled={!canEdit || workspace.loading}
                           className="h-8 w-52"
                           onChange={(event) => name.change(event.target.value)}
                           onBlur={() =>
                              (name.value ?? '').trim() === '' ? name.revert() : name.flush()
                           }
                           onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                              if (event.key === 'Escape') name.revert();
                           }}
                        />
                     </span>
                  }
               />
               <SettingsRow
                  title={t('slug')}
                  description={t('slugDescription')}
                  trailing={
                     <span className="font-mono text-foreground">{record?.slug ?? '—'}</span>
                  }
               />
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title={t('description')} description={t('descriptionDescription')}>
            <SettingsCard className="p-4">
               <Textarea
                  value={description.value ?? ''}
                  rows={3}
                  maxLength={5000}
                  aria-label={t('description')}
                  placeholder={t('descriptionPlaceholder')}
                  disabled={!canEdit || workspace.loading}
                  onChange={(event) => description.change(event.target.value)}
                  onBlur={description.flush}
               />
               <div className="mt-2">
                  <SaveIndicator
                     state={description.state}
                     error={description.error}
                     onRetry={description.retry}
                  />
               </div>
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title={t('context')} description={t('contextDescription')}>
            <SettingsCard className="p-4">
               <Textarea
                  value={contextText}
                  rows={6}
                  maxLength={CONTEXT_MAX}
                  aria-label={t('context')}
                  placeholder={t('contextPlaceholder')}
                  disabled={!canEdit || workspace.loading}
                  onChange={(event) => context.change(event.target.value)}
                  onBlur={context.flush}
               />
               <div className="mt-2 flex items-center justify-between gap-3">
                  <SaveIndicator
                     state={context.state}
                     error={context.error}
                     onRetry={context.retry}
                  />
                  <span className="text-muted-foreground tabular-nums">
                     {t('counter', { count: contextText.length, max: CONTEXT_MAX })}
                  </span>
               </div>
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title={t('prefix')} description={t('prefixDescription')}>
            <SettingsCard>
               <SettingsRow
                  title={
                     <Input
                        value={prefix}
                        aria-label={t('prefix')}
                        disabled={!canEdit || workspace.loading}
                        maxLength={PREFIX_MAX}
                        className="h-8 w-40 font-mono uppercase"
                        onChange={(event) =>
                           // Filtered as it is typed: the field only ever holds
                           // characters the server accepts, so the example below
                           // is always a real identifier.
                           setPrefix(
                              event.target.value
                                 .toUpperCase()
                                 .replace(/[^A-Z0-9]/g, '')
                                 .slice(0, PREFIX_MAX)
                           )
                        }
                     />
                  }
                  description={
                     prefix === ''
                        ? t('prefixEmpty')
                        : prefixValid
                          ? t('prefixExample', { example: `${prefix}-128` })
                          : t('prefixInvalid')
                  }
                  trailing={
                     <span className="flex items-center gap-2">
                        {prefixChanged ? (
                           <Button size="xs" variant="ghost" onClick={() => setPrefix(savedPrefix)}>
                              {t('cancel')}
                           </Button>
                        ) : null}
                        <Button
                           size="xs"
                           disabled={!canEdit || !prefixValid || !prefixChanged}
                           onClick={() => setConfirmingPrefix(true)}
                        >
                           {t('prefixSave')}
                        </Button>
                     </span>
                  }
               />
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title={t('danger')}>
            <SettingsCard>
               <SettingsRow
                  title={t('leave')}
                  description={soleOwner ? t('leaveSoleOwner') : t('leaveDescription')}
                  trailing={
                     <Button
                        size="xs"
                        variant="ghost"
                        className="text-status-danger hover:text-status-danger"
                        disabled={soleOwner || leaving || !workspaceId}
                        onClick={() => setConfirmingLeave(true)}
                     >
                        {t('leave')}
                     </Button>
                  }
               />
               {isOwner ? (
                  <SettingsRow
                     title={t('delete')}
                     description={t('deleteDescription')}
                     trailing={
                        <Button
                           size="xs"
                           variant="destructive"
                           disabled={!workspaceId}
                           onClick={() => {
                              setTypedName('');
                              setConfirmingDelete(true);
                           }}
                        >
                           {t('delete')}
                        </Button>
                     }
                  />
               ) : null}
            </SettingsCard>
         </SettingsSection>

         {/* Changing the prefix renames every reference in the workspace, so it
             is said plainly, with both forms shown. */}
         <Dialog
            open={confirmingPrefix}
            onOpenChange={(open) => !savingPrefix && setConfirmingPrefix(open)}
         >
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>{t('prefixConfirmTitle')}</DialogTitle>
                  <DialogDescription>
                     {t('prefixConfirmBody', {
                        before: `${savedPrefix}-128`,
                        after: `${prefix}-128`,
                     })}
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button
                     variant="secondary"
                     disabled={savingPrefix}
                     onClick={() => setConfirmingPrefix(false)}
                  >
                     {t('cancel')}
                  </Button>
                  <Button disabled={savingPrefix} onClick={() => void commitPrefix()}>
                     {savingPrefix ? t('saving') : t('prefixConfirmAction')}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>

         <Dialog
            open={confirmingLeave}
            onOpenChange={(open) => !leaving && setConfirmingLeave(open)}
         >
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>{t('leaveConfirmTitle')}</DialogTitle>
                  <DialogDescription>
                     {t('leaveConfirmBody', { name: record?.name ?? '' })}
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button
                     variant="secondary"
                     disabled={leaving}
                     onClick={() => setConfirmingLeave(false)}
                  >
                     {t('cancel')}
                  </Button>
                  <Button
                     variant="destructive"
                     disabled={leaving}
                     onClick={() => void confirmLeave()}
                  >
                     {leaving ? t('leaving') : t('leaveConfirmAction')}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>

         {/* While the delete is in flight the dialog cannot be dismissed: the
             workspace is going away underneath the page, and a half-closed
             dialog over a dying route is not a state worth having. */}
         <Dialog
            open={confirmingDelete}
            onOpenChange={(open) => !deleting && setConfirmingDelete(open)}
         >
            <DialogContent
               onEscapeKeyDown={(event) => deleting && event.preventDefault()}
               onInteractOutside={(event) => deleting && event.preventDefault()}
            >
               <DialogHeader>
                  <DialogTitle>{t('deleteConfirmTitle')}</DialogTitle>
                  <DialogDescription>
                     {t('deleteConfirmBody', { name: record?.name ?? '' })}
                  </DialogDescription>
               </DialogHeader>
               <Input
                  value={typedName}
                  aria-label={t('deleteTypeName')}
                  placeholder={record?.name ?? ''}
                  disabled={deleting}
                  onChange={(event) => setTypedName(event.target.value)}
               />
               <DialogFooter>
                  <Button
                     variant="secondary"
                     disabled={deleting}
                     onClick={() => setConfirmingDelete(false)}
                  >
                     {t('cancel')}
                  </Button>
                  <Button
                     variant="destructive"
                     disabled={!nameMatches || deleting}
                     onClick={() => void confirmDelete()}
                  >
                     {deleting ? t('deleting') : t('deleteConfirmAction')}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </SettingsShell>
   );
}
