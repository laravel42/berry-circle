'use client';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import { acceptJoinLink, lookupJoinLink } from '@/lib/join-links';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type State =
   | { kind: 'loading' }
   | { kind: 'invalid' }
   | { kind: 'ready'; workspace: string; role: string }
   | { kind: 'signin' }
   | { kind: 'error' };

/** Public landing for a join link: shows the workspace, then joins it. */
export default function JoinPage() {
   const { token } = useParams<{ token: string }>();
   const router = useRouter();
   const [state, setState] = useState<State>({ kind: 'loading' });
   const [joining, setJoining] = useState(false);

   useEffect(() => {
      void lookupJoinLink(token)
         .then((found) => setState({ kind: 'ready', workspace: found.workspace.name, role: found.role }))
         .catch(() => setState({ kind: 'invalid' }));
   }, [token]);

   const join = () => {
      setJoining(true);
      void acceptJoinLink(token)
         .then(() => router.push('/'))
         .catch((cause: unknown) =>
            setState(cause instanceof BerryApiError && cause.status === 401 ? { kind: 'signin' } : { kind: 'error' })
         )
         .finally(() => setJoining(false));
   };

   return (
      <AuthCard title="Join a workspace">
         {state.kind === 'loading' ? <p className="text-muted-foreground">Checking the link…</p> : null}
         {state.kind === 'invalid' ? <p>This join link is not valid. It may have expired or been revoked.</p> : null}
         {state.kind === 'ready' ? (
            <div className="flex flex-col gap-4">
               <p>
                  Join <strong>{state.workspace}</strong> as {state.role}.
               </p>
               <Button onClick={join} disabled={joining}>
                  Join workspace
               </Button>
            </div>
         ) : null}
         {state.kind === 'signin' ? (
            <p>
               <Link className="underline" href="/sign-in">
                  Sign in
               </Link>
               , then open this link again to join.
            </p>
         ) : null}
         {state.kind === 'error' ? <p>Joining failed. Try the link again.</p> : null}
      </AuthCard>
   );
}
