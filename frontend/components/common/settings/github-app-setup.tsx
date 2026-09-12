'use client';

import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import {
   forgetGitHubInstall,
   loadGitHubApp,
   startGitHubAppCreation,
   startGitHubInstall,
   type GitHubAppState,
} from '@/lib/integrations';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * Creating and installing the GitHub App, without a credential passing through
 * anyone's hands.
 *
 * GitHub's manifest flow is a form POST, not a link: the browser submits the
 * manifest, a person presses Create, and GitHub returns a one-time code the
 * server exchanges for the App — id, both halves of the OAuth credential, the
 * private key and the webhook secret at once. That is also what registers the
 * callback URLs, so the redirect_uri can never be registered wrong.
 */
function submitManifest(postUrl: string, manifest: unknown): void {
   const form = document.createElement('form');
   form.method = 'POST';
   form.action = postUrl;
   const field = document.createElement('input');
   field.type = 'hidden';
   field.name = 'manifest';
   field.value = JSON.stringify(manifest);
   form.append(field);
   // Must be in the document to submit, and this navigates away from the page.
   document.body.append(form);
   form.submit();
}

export function GitHubAppSetup() {
   const [state, setState] = useState<GitHubAppState | null>(null);
   const [busy, setBusy] = useState(false);

   const read = useCallback(() => {
      void loadGitHubApp()
         .then(setState)
         .catch(() =>
            setState({
               app: null,
               installation: null,
               installations: [],
               installPending: false,
               installUrl: null,
               installReason: null,
            })
         );
   }, []);

   useEffect(read, [read]);

   const fail = (error: unknown, fallback: string) =>
      toast.error(error instanceof BerryApiError ? error.message : fallback);

   const create = () => {
      setBusy(true);
      void startGitHubAppCreation()
         .then(({ postUrl, manifest }) => submitManifest(postUrl, manifest))
         .catch((error: unknown) => {
            fail(error, 'The App could not be prepared.');
            setBusy(false);
         });
   };

   const install = () => {
      setBusy(true);
      void startGitHubInstall()
         .then((url) => {
            window.location.href = url;
         })
         .catch((error: unknown) => {
            fail(error, 'The install could not be started.');
            setBusy(false);
         });
   };

   const forget = () => {
      setBusy(true);
      void forgetGitHubInstall()
         .then(() => {
            toast.success('Installation forgotten');
            read();
         })
         .catch((error: unknown) => fail(error, 'The installation could not be forgotten.'))
         .finally(() => setBusy(false));
   };

   if (!state) return null;

   if (!state.app) {
      return (
         <div className="mt-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
            <p className="text-muted-foreground">
               No GitHub App yet. Berry can create one for you — GitHub shows you what it will be
               allowed to do, and hands the credentials straight back here. Nothing to copy, and no
               callback URL to register.
            </p>
            <Button size="xs" className="mt-2" disabled={busy} onClick={create}>
               {busy ? 'Preparing…' : 'Create GitHub App'}
            </Button>
         </div>
      );
   }

   if (!state.installation) {
      return (
         <div className="mt-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
            {/* An install on an organisation may need an owner's approval.
                Until it is given there is no installation, which without this
                would read exactly like nobody having tried. */}
            <p className="text-muted-foreground">
               {state.installPending ? (
                  <>
                     <span className="text-foreground">{state.app.name}</span> is waiting for an
                     owner of that organisation to approve the install. Until they do, Berry reaches
                     no repositories — nothing else is needed from you.
                  </>
               ) : (
                  <>
                     <span className="text-foreground">{state.app.name}</span> exists but is not
                     installed on an account yet, so there are no repositories it can reach.
                     Installing is where you choose which ones.
                  </>
               )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
               <Button size="xs" disabled={busy} onClick={install}>
                  {busy
                     ? 'Opening…'
                     : state.installPending
                       ? 'Install somewhere else'
                       : 'Install on GitHub'}
               </Button>
               {state.app.htmlUrl && (
                  <Button size="xs" variant="secondary" asChild>
                     <a href={state.app.htmlUrl} target="_blank" rel="noreferrer">
                        App settings
                     </a>
                  </Button>
               )}
            </div>
         </div>
      );
   }

   return (
      <div className="mt-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
         <p className="text-muted-foreground">
            <span className="text-foreground">{state.app.name}</span> is installed
            {state.installation.accountLogin ? ` on ${state.installation.accountLogin}` : ''}.
            Agents mint a fresh token per run, so nothing here expires between runs.
         </p>
         <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="xs" variant="secondary" disabled={busy} onClick={install}>
               Change repositories
            </Button>
            <Button size="xs" variant="secondary" disabled={busy} onClick={forget}>
               {busy ? 'Working…' : 'Forget installation'}
            </Button>
         </div>
      </div>
   );
}
