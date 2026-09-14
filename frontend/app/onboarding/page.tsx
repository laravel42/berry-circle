'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AuthCard } from '@/components/auth/auth-card';
import { CreateOrJoin } from '@/components/onboarding/create-or-join';
import { OnboardingSteps } from '@/components/onboarding/onboarding-steps';
import { loadOnboarding } from '@/lib/onboarding';
import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { getGuideAgent } from '@/lib/agents';
import { fetchBootstrap } from '@/lib/auth';
import { nextGitHubInstallStep } from '@/lib/integrations';
import { selectWorkspace } from '@/lib/workspaces';
import { useSessionStore } from '@/store/session-store';

/**
 * Onboarding — the single hand-off after auth.
 *
 * On a ready session it reads `/me/bootstrap` once and branches:
 *  - ≥1 membership: resolve the target (previously selected if still valid,
 *    else earliest-joined) and route into it within budget, without ever
 *    showing a creation step (Requirement 10.1).
 *  - no membership: render the create-or-join step and do not auto-create
 *    (Requirement 10.2). Create / join / select go through the workspace
 *    helpers (Requirements 10.4, 10.5, 10.6); on success the session store is
 *    refreshed and we route into the workspace.
 *
 * An anonymous visitor never reaches the branch: the SessionGate has already
 * sent them to `/sign-in`. While the store is still `booting`, the gate shows
 * its own boot screen, so here we only act once the status is settled.
 */

type Phase = 'resolving' | 'choose';

// Route into a workspace by slug. One place builds the destination so the
// with-membership and after-create/join paths stay identical.
function workspacePath(slug: string): string {
   return `/${slug}/tasks`;
}

/**
 * What the GitHub install trip came back with, in Berry's words.
 *
 * The install runs on the App's own setup URL, so it returns to this page
 * rather than to settings — nobody asked for settings, they asked to log in.
 * Anything that is not an install and not a request is said plainly and left
 * behind: the account works either way, and Settings → Repositories offers the
 * same link again.
 */
function describeInstallReturn(status: string): { ok: boolean; message: string } {
   switch (status) {
      case 'installed':
         return { ok: true, message: 'Berry can now reach the repositories you chose.' };
      case 'install_requested':
         return {
            ok: true,
            message: 'An owner of that organisation was asked to approve the install.',
         };
      default:
         return {
            ok: false,
            message: 'The GitHub install did not finish. You can try again in Settings.',
         };
   }
}

export default function OnboardingPage() {
   const router = useRouter();
   const searchParams = useSearchParams();
   // The workspace switcher links here with `?add=1` to create or join another
   // workspace. That intent forces the choose step even for a user who already
   // has memberships, who would otherwise be routed straight back into one.
   const addIntent = searchParams.get('add') === '1';
   const status = useSessionStore((state) => state.status);
   const refreshWorkspaces = useSessionStore((state) => state.refreshWorkspaces);

   // GitHub sends the install trip back here with its outcome in the query. It
   // is said once, and the resolve below carries on into the workspace — the
   // toast survives that navigation, the address does not have to.
   const installReturn =
      searchParams.get('integration') === 'github' ? searchParams.get('status') : null;
   const announced = useRef<string | null>(null);
   useEffect(() => {
      if (!installReturn || announced.current === installReturn) return;
      announced.current = installReturn;
      const outcome = describeInstallReturn(installReturn);
      if (outcome.ok) toast.success(outcome.message);
      else toast.error(outcome.message);
   }, [installReturn]);

   const [phase, setPhase] = useState<Phase>('resolving');
   const [error, setError] = useState<string | null>(null);
   /**
    * Whether to run the guided steps rather than the short create-or-join.
    *
    * Read from the account, where the server has modelled it all along: it is
    * first run only, and adding a second workspace from the switcher is not
    * first run. A read that fails leaves it off, so a broken call costs a
    * welcome screen rather than the ability to make a workspace.
    */
   const [guided, setGuided] = useState(false);

   useEffect(() => {
      if (status !== 'ready' || addIntent) return;
      let cancelled = false;
      void loadOnboarding()
         .then((state) => {
            if (!cancelled) setGuided(!state.completed && !state.skipped);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [status, addIntent]);

   useEffect(() => {
      // The gate owns the anonymous and booting cases; only a ready session
      // resolves here. No cross-render ref guard: under React Strict Mode the
      // effect mounts, is torn down, and remounts, and a ref that survived that
      // teardown would let the first (cancelled) run block the second from ever
      // fetching — leaving the page stuck on the resolving spinner. Instead each
      // run owns its own `cancelled` flag, and `/me/bootstrap` is a safe GET to
      // repeat. React also drops a state update from a cancelled run, so the
      // double-invoke settles on the second run's result.
      if (status !== 'ready') return;

      // Explicit "add a workspace" intent: show create/join directly instead of
      // resolving into an existing workspace.
      if (addIntent) {
         setPhase('choose');
         return;
      }

      let cancelled = false;
      void (async () => {
         try {
            const bootstrap = await fetchBootstrap();
            if (cancelled) return;

            if (bootstrap.workspaces.length === 0) {
               setPhase('choose');
               return;
            }

            // Previously selected if the server still reports it as a valid
            // membership, else the earliest-joined by createdAt (id breaks
            // ties for determinism).
            const current = bootstrap.workspaces.find(
               (workspace) => workspace.id === bootstrap.currentWorkspaceId
            );
            const target =
               current ??
               [...bootstrap.workspaces].sort((a, b) => {
                  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
                  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
               })[0];

            // Repository access is granted once, at a first login. Whoever has
            // already been asked is never sent back — the server answers from a
            // row, so declining GitHub's form costs a person nothing but the
            // access, and never traps them here. The workspace is made current
            // first because it is the one the install would belong to.
            if (bootstrap.currentWorkspaceId !== target.id) {
               await selectWorkspace(target.id).catch(() => undefined);
               if (cancelled) return;
            }
            const step = await nextGitHubInstallStep();
            if (cancelled) return;
            if (step.installUrl) {
               window.location.assign(step.installUrl);
               return;
            }

            router.replace(workspacePath(target.slug));
         } catch {
            if (cancelled) return;
            // Bootstrap failed on a ready session: surface a retryable error
            // rather than trapping them on a blank screen.
            setError('We could not load your workspaces. Please try again.');
         }
      })();

      return () => {
         cancelled = true;
      };
   }, [status, router, addIntent]);

   // After a create or join: the workspace, and its Guide agent if it has one.
   const [ready, setReady] = useState<{ slug: string; guideId: string } | null>(null);

   // Shared by create and join: make the workspace the selected one, refresh
   // the store from the server, and route into it — or, when the workspace has
   // a Guide, offer it first, since a new member is who it is for.
   const enterWorkspace = useCallback(
      async (workspaceId: string) => {
         setError(null);
         const selected = await selectWorkspace(workspaceId);
         await refreshWorkspaces();
         // After the workspace, not before it: an installation belongs to a
         // workspace, so there is nothing to record it against until this point.
         const step = await nextGitHubInstallStep();
         if (step.installUrl) {
            window.location.assign(step.installUrl);
            return;
         }
         const guide = await getGuideAgent().catch(() => null);
         if (guide) {
            setReady({ slug: selected.slug, guideId: guide.id });
            return;
         }
         router.replace(workspacePath(selected.slug));
      },
      [refreshWorkspaces, router]
   );

   if (ready) {
      return (
         <AuthCard
            title="Your workspace is ready"
            description="Start with your tasks, or ask the Guide how Berry works."
         >
            <div className="flex flex-col gap-2">
               <Button onClick={() => router.replace(workspacePath(ready.slug))}>
                  Go to my tasks
               </Button>
               <Button
                  variant="secondary"
                  onClick={() =>
                     router.push(`/${ready.slug}/chat?agent=${encodeURIComponent(ready.guideId)}`)
                  }
               >
                  Questions? Ask the Guide
               </Button>
            </div>
         </AuthCard>
      );
   }

   if (phase === 'choose') {
      // First run gets the steps; somebody who has been through them once —
      // or who came here from the switcher to add a second workspace — gets
      // the short form, because they already know what all of it is.
      if (guided) {
         return (
            <>
               {error ? (
                  <p role="alert" className="mb-4 text-destructive-foreground">
                     {error}
                  </p>
               ) : null}
               <OnboardingSteps onEntered={enterWorkspace} onSkipped={() => setGuided(false)} />
            </>
         );
      }
      return (
         <AuthCard
            title="Set up your workspace"
            description="Create a new workspace or join one you were invited to."
         >
            {error ? (
               <p role="alert" className="mb-4 text-destructive-foreground">
                  {error}
               </p>
            ) : null}
            <CreateOrJoin onEntered={enterWorkspace} />
         </AuthCard>
      );
   }

   // Resolving (or routing away): match the boot screen's language so the
   // move from "loading" to the workspace does not feel like a different app.
   return (
      <div className="flex min-h-svh items-center justify-center bg-background">
         <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <div className="flex items-center gap-2">
               <BerryMark size="md" tone="brand" pulse label="Setting up Berry" />
               <span>Setting up your workspace</span>
            </div>
            {error ? (
               <p role="alert" className="text-destructive-foreground">
                  {error}
               </p>
            ) : null}
         </div>
      </div>
   );
}
