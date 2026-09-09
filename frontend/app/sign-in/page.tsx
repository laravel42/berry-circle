'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import {
   Form,
   FormControl,
   FormField,
   FormItem,
   FormLabel,
   FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { BerryApiError } from '@/lib/api';
import { zodFormResolver } from '@/lib/zod-resolver';
import { useSessionStore } from '@/store/session-store';

// The server enforces the real password policy; the client only blocks empty
// submits so a wrong password reaches the API and returns the uniform 401.
const signInSchema = z.object({
   email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
   password: z.string().min(1, 'Password is required'),
});

type SignInValues = z.infer<typeof signInSchema>;

const CREDENTIAL_ERROR = 'That email or password is incorrect.';
const GENERIC_ERROR = 'We could not complete sign-in. Please try again.';

export default function SignInPage() {
   const router = useRouter();
   const signIn = useSessionStore((state) => state.signIn);
   const [formError, setFormError] = useState<string | null>(null);

   const form = useForm<SignInValues>({
      resolver: zodFormResolver(signInSchema),
      defaultValues: { email: '', password: '' },
   });

   const onSubmit = async (values: SignInValues) => {
      setFormError(null);
      try {
         await signIn(values.email, values.password);
         // The store is now 'ready'. Route to the app root and let the
         // SessionGate send the user to their workspace — one deterministic
         // place decides the destination.
         router.replace('/');
      } catch (error) {
         if (error instanceof BerryApiError && error.status === 401) {
            // Neutral message: never reveal whether the email is registered.
            setFormError(CREDENTIAL_ERROR);
         } else {
            setFormError(GENERIC_ERROR);
         }
         // Keep the entered email; only clear the password for a fresh attempt.
         form.resetField('password');
      }
   };

   return (
      <AuthCard
         title="Sign in to Berry"
         description="Enter your email and password to continue."
         footer={
            <span>
               New to Berry?{' '}
               <Link href="/sign-up" className="font-medium text-foreground hover:underline">
                  Create an account
               </Link>
            </span>
         }
      >
         <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4" noValidate>
               <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                     <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                           <Input
                              type="email"
                              autoComplete="email"
                              placeholder="you@example.com"
                              {...field}
                           />
                        </FormControl>
                        <FormMessage />
                     </FormItem>
                  )}
               />
               <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                     <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                           <Input
                              type="password"
                              autoComplete="current-password"
                              placeholder="Your password"
                              {...field}
                           />
                        </FormControl>
                        <FormMessage />
                     </FormItem>
                  )}
               />
               {formError ? (
                  <p role="alert" className="text-destructive-foreground">
                     {formError}
                  </p>
               ) : null}
               <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
               </Button>
            </form>
         </Form>
      </AuthCard>
   );
}
