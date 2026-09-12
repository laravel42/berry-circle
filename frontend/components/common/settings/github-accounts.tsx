'use client';

import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
   describeAccount,
   describeDisconnectCost,
   describeGitHubFailure,
   disconnectGitHubAccount,
   loadGitHubAccounts,
   type AccountDetail,
} from '@/lib/github';
import { startGitHubInstall } from '@/lib/integrations';
import { format, parseISO } from 'date-fns';
import { Building2, Plus, User } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SettingsRow } from './shared';

function when(iso: string | null | undefined): string {
   if (!iso) return '';
   try {
      return format(parseISO(iso), 'd MMM yyyy');
   } catch {
      return iso;
   }
}

/** "4 repositories · 2 in this workspace · added by Ann on 3 Sep 2026". */
function describeReach(account: AccountDetail): string {
   const parts = [
      account.repositoryCount === null || account.repositoryCount === undefined
         ? 'Repository count unavailable'
         : account.repositoryCount === 1
           ? '1 repository granted'
           : `${account.repositoryCount} repositories granted`,
      `${account.listedHere} in this workspace`,
      account.installedBy?.name ? `added by ${account.installedBy.name}` : null,
      account.installedAt ? `on ${when(account.installedAt)}` : null,
   ];
   return parts.filter(Boolean).join(' · ');
}

/**
 * The GitHub accounts this workspace reaches, and the two things to do with
 * them: add another, or disconnect one.
 *
 * A workspace works in a personal account and in one or more organisations at
 * once, so this is a list rather than a single connection. Adding one is
 * GitHub's own install page again — that is where an account is chosen — and
 * disconnecting one says how many of this workspace's repositories live under it
 * before it goes, because that number is the whole of the decision.
 */
export function GitHubAccountsList({
   workspaceId,
   canManage,
   reloadKey,
}: {
   workspaceId: string;
   canManage: boolean;
   /** Bumped by the caller when a workspace event says the accounts changed. */
   reloadKey?: number;
}) {
   const [accounts, setAccounts] = useState<AccountDetail[] | null>(null);
   const [pending, setPending] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState<number | 'add' | null>(null);
   const [confirming, setConfirming] = useState<AccountDetail | null>(null);

   const load = useCallback(async () => {
      if (!canManage) return;
      try {
         const state = await loadGitHubAccounts(workspaceId);
         setAccounts(state.accounts);
         setPending(state.installPending);
         setError(null);
      } catch (failure) {
         setError(describeGitHubFailure(failure));
      }
   }, [workspaceId, canManage]);

   useEffect(() => {
      void load();
   }, [load, reloadKey]);

   const add = async () => {
      setBusy('add');
      try {
         window.location.href = await startGitHubInstall();
      } catch (failure) {
         toast.error(describeGitHubFailure(failure));
         setBusy(null);
      }
   };

   const disconnect = async (account: AccountDetail) => {
      setBusy(account.installationId);
      try {
         await disconnectGitHubAccount(workspaceId, account.installationId);
         toast.success(`${account.accountLogin ?? 'That account'} disconnected`);
         await load();
      } catch (failure) {
         toast.error(describeGitHubFailure(failure));
      } finally {
         setBusy(null);
      }
   };

   // Only admins may ask the server for this list, so for everyone else the
   // accounts simply are not part of the page.
   if (!canManage) return null;

   return (
      <>
         {error && (
            <div className="px-4 py-3">
               <p role="alert" className="text-status-danger">
                  {error}
               </p>
            </div>
         )}
         {!error &&
            (accounts ?? []).map((account) => (
               <SettingsRow
                  key={account.installationId}
                  icon={
                     account.accountType === 'Organization' ? (
                        <Building2 className="size-4" />
                     ) : (
                        <User className="size-4" />
                     )
                  }
                  title={describeAccount(account)}
                  description={describeReach(account)}
                  trailing={
                     <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => setConfirming(account)}
                     >
                        {busy === account.installationId ? 'Working…' : 'Disconnect'}
                     </Button>
                  }
               />
            ))}
         {!error && pending && (
            <SettingsRow
               title="Waiting for an owner's approval"
               description="An owner of that organisation was asked to approve the install. Nothing else is needed here until they do."
               muted
            />
         )}
         {!error && (
            <div className="px-4 pb-3 pt-1">
               <Button
                  size="xs"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void add()}
               >
                  <Plus className="size-3.5" />
                  {busy === 'add'
                     ? 'Opening…'
                     : (accounts ?? []).length === 0
                       ? 'Add an account'
                       : 'Add another account'}
               </Button>
            </div>
         )}

         <AlertDialog
            open={confirming !== null}
            onOpenChange={(open) => !open && setConfirming(null)}
         >
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     Disconnect {confirming?.accountLogin ?? 'this account'}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                     {confirming ? describeDisconnectCost(confirming) : ''}
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>Keep connected</AlertDialogCancel>
                  <AlertDialogAction
                     className={buttonVariants({ variant: 'destructive' })}
                     onClick={() => {
                        const account = confirming;
                        setConfirming(null);
                        if (account) void disconnect(account);
                     }}
                  >
                     Disconnect
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </>
   );
}
