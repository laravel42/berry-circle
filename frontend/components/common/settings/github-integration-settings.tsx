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
import { GitHubAppSetup } from '@/components/common/settings/github-app-setup';
import { Button, buttonVariants } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { subscribeWorkspaceEvents } from '@/lib/events';
import {
   GITHUB_EVENTS,
   describeGitHubFailure,
   disconnectGitHub,
   loadGitHubSettings,
   updateGitHubSettings,
   type GitHubSettingsPatch,
   type GitHubSettingsState,
} from '@/lib/github';
import { startGitHubInstall } from '@/lib/integrations';
import { useSessionStore } from '@/store/session-store';
import { format, parseISO } from 'date-fns';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SettingsCard, SettingsRow } from './shared';

type ToggleKey = keyof GitHubSettingsPatch;

/** The three feature toggles, in Berry's words. */
const FEATURES: Array<{ key: Exclude<ToggleKey, 'enabled'>; title: string; description: string }> = [
   {
      key: 'showLinkedPullRequests',
      title: 'Pull requests on tasks',
      description:
         'Show the pull requests that name a task, with their state and checks, in the task’s sidebar.',
   },
   {
      key: 'coAuthorTrailer',
      title: 'Credit the requester on agent commits',
      description:
         'Agent commits add a Co-authored-by line for the person who started the run, so GitHub shows them on the commit.',
   },
   {
      key: 'autoLinkPullRequests',
      title: 'Link pull requests by task key',
      description:
         'Link a pull request when its branch, title or description names a task key. “Fixes KEY-12” in a merged pull request moves that task to done.',
   },
];

function when(iso: string | null | undefined): string {
   if (!iso) return '';
   try {
      return format(parseISO(iso), 'd MMM yyyy');
   } catch {
      return iso;
   }
}

/**
 * The workspace's GitHub switches: the master switch, the App connection and
 * who made it, and the three feature toggles.
 *
 * Only admins can change anything. Everyone else sees the same page with
 * every control disabled and a line saying why, rather than a page that
 * pretends the settings do not exist.
 */
export function GitHubIntegrationSettings() {
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const [state, setState] = useState<GitHubSettingsState | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState<ToggleKey | 'connection' | null>(null);
   const [confirming, setConfirming] = useState(false);

   const load = useCallback(async () => {
      if (!workspaceId) return;
      try {
         setState(await loadGitHubSettings(workspaceId));
         setError(null);
      } catch (failure) {
         setError(describeGitHubFailure(failure));
      }
   }, [workspaceId]);

   useEffect(() => {
      void load();
   }, [load]);

   // Another admin's change, or an uninstall on GitHub, shows here without a reload.
   useEffect(
      () =>
         subscribeWorkspaceEvents((event) => {
            if (event.workspaceId && event.workspaceId !== workspaceId) return;
            if (event.type === GITHUB_EVENTS.settings || event.type === GITHUB_EVENTS.connection) {
               void load();
            }
         }),
      [workspaceId, load]
   );

   const toggle = async (key: ToggleKey, value: boolean) => {
      if (!workspaceId || !state) return;
      const previous = state;
      setState({ ...state, settings: { ...state.settings, [key]: value } });
      setBusy(key);
      try {
         const settings = await updateGitHubSettings(workspaceId, { [key]: value });
         setState((current) => (current ? { ...current, settings } : current));
      } catch (failure) {
         setState(previous);
         toast.error(describeGitHubFailure(failure));
      } finally {
         setBusy(null);
      }
   };

   const connect = async () => {
      setBusy('connection');
      try {
         window.location.href = await startGitHubInstall();
      } catch (failure) {
         toast.error(describeGitHubFailure(failure));
         setBusy(null);
      }
   };

   const disconnect = async () => {
      if (!workspaceId) return;
      setBusy('connection');
      try {
         await disconnectGitHub(workspaceId);
         toast.success('GitHub disconnected from this workspace');
         await load();
      } catch (failure) {
         toast.error(describeGitHubFailure(failure));
      } finally {
         setBusy(null);
      }
   };

   if (error) {
      return (
         <p role="alert" className="text-status-danger">
            {error}
         </p>
      );
   }
   if (!state) {
      return (
         <p role="status" className="text-muted-foreground">
            Loading GitHub settings…
         </p>
      );
   }

   const { settings, canManage, connection } = state;
   const locked = !canManage || busy !== null;
   const connectedBy = [
      connection.accountLogin ? `Connected to ${connection.accountLogin}` : 'Connected',
      connection.installedBy?.name ? `by ${connection.installedBy.name}` : null,
      connection.installedAt ? `on ${when(connection.installedAt)}` : null,
   ]
      .filter(Boolean)
      .join(' ');

   return (
      <section aria-labelledby="github-settings-heading" className="flex flex-col gap-3">
         <div>
            <h2 id="github-settings-heading" className="font-medium">
               GitHub
            </h2>
            {!canManage && (
               <p className="mt-0.5 text-muted-foreground">
                  Only workspace admins can change these settings.
               </p>
            )}
         </div>

         <SettingsCard>
            <SettingsRow
               title="Use GitHub in this workspace"
               description="When off, Berry ignores GitHub events here, hides linked pull requests and adds no commit trailers. Nothing is deleted."
               trailing={
                  <Switch
                     checked={settings.enabled}
                     disabled={locked}
                     aria-label="Use GitHub in this workspace"
                     onCheckedChange={(value) => void toggle('enabled', value)}
                  />
               }
            />
            <SettingsRow
               title={connection.appName ?? 'GitHub App'}
               description={
                  connection.installed
                     ? connectedBy
                     : connection.appConfigured
                       ? 'Not connected to a GitHub account yet. Connecting is where you choose which repositories Berry can reach.'
                       : 'This deployment has no GitHub App yet.'
               }
               trailing={
                  canManage && connection.appConfigured ? (
                     connection.installed ? (
                        <>
                           <Button
                              size="xs"
                              variant="secondary"
                              disabled={busy !== null}
                              onClick={() => void connect()}
                           >
                              Change repositories
                           </Button>
                           <Button
                              size="xs"
                              variant="secondary"
                              disabled={busy !== null}
                              onClick={() => setConfirming(true)}
                           >
                              {busy === 'connection' ? 'Working…' : 'Disconnect'}
                           </Button>
                        </>
                     ) : (
                        <Button size="xs" disabled={busy !== null} onClick={() => void connect()}>
                           {busy === 'connection' ? 'Opening…' : 'Connect'}
                        </Button>
                     )
                  ) : undefined
               }
            />
            {canManage && !connection.appConfigured && (
               <div className="px-4 pb-3">
                  <GitHubAppSetup />
               </div>
            )}
            {FEATURES.map((feature) => (
               <SettingsRow
                  key={feature.key}
                  title={feature.title}
                  description={feature.description}
                  muted={!settings.enabled}
                  trailing={
                     <Switch
                        checked={settings[feature.key]}
                        disabled={locked || !settings.enabled}
                        aria-label={feature.title}
                        onCheckedChange={(value) => void toggle(feature.key, value)}
                     />
                  }
               />
            ))}
         </SettingsCard>

         <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect GitHub from this workspace?</AlertDialogTitle>
                  <AlertDialogDescription>
                     Agents here stop getting repository access, and GitHub events stop updating
                     tasks. The App stays installed on GitHub; remove it there if you want it gone.
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>Keep connected</AlertDialogCancel>
                  <AlertDialogAction
                     className={buttonVariants({ variant: 'destructive' })}
                     onClick={() => {
                        setConfirming(false);
                        void disconnect();
                     }}
                  >
                     Disconnect
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </section>
   );
}
