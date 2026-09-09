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

// Mirrors the server policy: 12–128 chars, confirm must match. The server is
// still the authority; this keeps a doomed submit from ever leaving the tab.
const signUpSchema = z
   .object({
      email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
      password: z
         .string()
         .min(12, 'Password must be at least 12 characters')
         .max(128, 'Password must be at most 128 characters'),
      confirmPassword: z.string().min(1, 'Confirm your password'),
   })
   .refine((values) => values.password === values.confirmPassword, {
      path: ['confirmPassword'],
      message: 'Passwords do not match',
   });

type SignUpValues = z.infer<typeof signUpSchema>;

const CONFLICT_ERROR = 'An account with that email already exists.';
const GENERIC_ERROR = 'We could not complete sign-up. Please try again.';

export default function SignUpPage() {
   const router = useRouter();
   const signUp = useSessionStore((state) => state.signUp);
   const [formError, setFormError] = useState<string | null>(null);

   const form = useForm<SignUpValues>({
      resolver: zodFormResolver(signUpSchema),
      defaultValues: { email: '', password: '', confirmPassword: '' },
   });

   const onSubmit = async (values: SignUpValues) => {
      setFormError(null);
      try {
         await signUp(values.email, values.password);
         // On success the store is 'ready', exactly like sign-in. Route to the
         // app root; the SessionGate carries the new user into onboarding.
         router.replace('/');
      } catch (error) {
         if (error instanceof BerryApiError && error.status === 409) {
            setFormError(CONFLICT_ERROR);
         } else {
            setFormError(GENERIC_ERROR);
         }
         // Keep the email; clear the secrets for a clean retry.
         form.resetField('password');
         form.resetField('confirmPassword');
      }
   };

   return (
      <AuthCard
         title="Create your Berry account"
         description="Set an email and password to get started."
         footer={
            <span>
               Already have an account?{' '}
               <Link href="/sign-in" className="font-medium text-foreground hover:underline">
                  Sign in
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
                              autoComplete="new-password"
                              placeholder="At least 12 characters"
                              {...field}
                           />
                        </FormControl>
                        <FormMessage />
                     </FormItem>
                  )}
               />
               <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                     <FormItem>
                        <FormLabel>Confirm password</FormLabel>
                        <FormControl>
                           <Input
                              type="password"
                              autoComplete="new-password"
                              placeholder="Re-enter your password"
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
                  {form.formState.isSubmitting ? 'Creating account…' : 'Create account'}
               </Button>
            </form>
         </Form>
      </AuthCard>
   );
}
