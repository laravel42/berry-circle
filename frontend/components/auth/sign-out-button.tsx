'use client';

import { Button } from '@/components/ui/button';
import { useSignOut } from '@/components/auth/use-sign-out';

interface SignOutButtonProps extends React.ComponentProps<typeof Button> {
   /** Rendered inside the button; defaults to a plain "Log out". */
   children?: React.ReactNode;
}

/**
 * Sign-out control. Wraps {@link useSignOut}, which revokes the session,
 * returns to `/sign-in`, and falls back to a local clear after 5s if the
 * server does not answer.
 */
export function SignOutButton({ children, ...buttonProps }: SignOutButtonProps) {
   const { signOut, pending } = useSignOut();

   return (
      <Button type="button" onClick={() => void signOut()} disabled={pending} {...buttonProps}>
         {children ?? 'Log out'}
      </Button>
   );
}
