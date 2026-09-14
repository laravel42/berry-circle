'use client';

import { RiGithubFill } from '@remixicon/react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { fetchGitHubSignInAvailable, signInWithGitHub } from '@/lib/auth';

/**
 * What a refused GitHub round trip means, in Berry's words. The server sends
 * the browser back here with `?error=<code>`; anything not listed gets the
 * general message rather than the raw code.
 */
const ERROR_MESSAGES: Record<string, string> = {
   account_not_linked:
      'Your GitHub account could not be linked. Make sure its primary email is verified on GitHub.',
   email_not_verified: 'Verify your primary email on GitHub, then try again.',
   // Better Auth's code when the create hook refuses an unverified address.
   unable_to_create_user: 'Verify your primary email on GitHub, then try again.',
   access_denied: 'GitHub sign-in was cancelled.',
};
const GENERIC_ERROR = 'We could not sign you in with GitHub. Please try again.';

function SignInContent() {
   const params = useSearchParams();
   const returned = params.get('error');
   const [available, setAvailable] = useState<boolean | null>(null);
   const [pending, setPending] = useState(false);
   const [error, setError] = useState<string | null>(
      returned ? (ERROR_MESSAGES[returned] ?? GENERIC_ERROR) : null
   );

   useEffect(() => {
      let cancelled = false;
      fetchGitHubSignInAvailable()
         .then((value) => {
            if (!cancelled) setAvailable(value);
         })
         .catch(() => {
            if (!cancelled) setAvailable(false);
         });
      return () => {
         cancelled = true;
      };
   }, []);

   const start = async () => {
      setError(null);
      setPending(true);
      try {
         // On success the browser navigates to GitHub; nothing after this runs.
         await signInWithGitHub();
      } catch {
         setError(GENERIC_ERROR);
         setPending(false);
      }
   };

   return (
      <AuthCard title="Sign in to Berry" description="Berry uses your GitHub account to sign you in.">
         <div className="grid gap-4">
            <Button
               type="button"
               className="w-full"
               onClick={() => void start()}
               disabled={pending || available !== true}
            >
               <RiGithubFill aria-hidden className="size-4" />
               {pending ? 'Opening GitHub…' : 'Continue with GitHub'}
            </Button>
            {available === false ? (
               <p role="status" className="text-muted-foreground">
                  GitHub sign-in is not configured on this server. An administrator needs to set
                  BERRY_AUTH_GITHUB_CLIENT_ID and BERRY_AUTH_GITHUB_CLIENT_SECRET.
               </p>
            ) : null}
            {error ? (
               <p role="alert" className="text-destructive-foreground">
                  {error}
               </p>
            ) : null}
         </div>
      </AuthCard>
   );
}

/** `useSearchParams` needs a Suspense boundary for the page to prerender. */
export default function SignInPage() {
   return (
      <Suspense fallback={null}>
         <SignInContent />
      </Suspense>
   );
}
