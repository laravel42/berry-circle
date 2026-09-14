'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { useSessionStore } from '@/store/session-store';

const LOCAL_SIGN_OUT_DEADLINE_MS = 5000;

/**
 * Sign-out behavior shared by the button and the workspace menu item. It asks
 * the server to revoke the session and returns to `/sign-in`. If the server
 * does not answer within 5s the session is cleared locally anyway — a person
 * who clicked "log out" should never be left looking signed in while a request
 * hangs — and a toast says the session ended locally.
 */
export function useSignOut() {
   const router = useRouter();
   const signOut = useSessionStore((state) => state.signOut);
   const markAnonymous = useSessionStore((state) => state.markAnonymous);
   const [pending, setPending] = useState(false);

   const run = useCallback(async () => {
      if (pending) return;
      setPending(true);

      let settled = false;
      const claim = () => {
         if (settled) return true;
         settled = true;
         return false;
      };

      const timer = setTimeout(() => {
         if (claim()) return;
         markAnonymous();
         toast('Your session ended locally.');
         router.replace('/sign-in');
      }, LOCAL_SIGN_OUT_DEADLINE_MS);

      try {
         await signOut();
         if (claim()) return;
         clearTimeout(timer);
         router.replace('/sign-in');
      } catch {
         if (claim()) return;
         clearTimeout(timer);
         markAnonymous();
         toast('Your session ended locally.');
         router.replace('/sign-in');
      } finally {
         setPending(false);
      }
   }, [markAnonymous, pending, router, signOut]);

   return { signOut: run, pending };
}
