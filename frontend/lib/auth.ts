import { z } from 'zod';

import { apiFetch } from './api';
import { authClient } from './auth-client';

const userSchema = z.object({
   id: z.string(),
   email: z.string(),
   name: z.string(),
   avatarUrl: z.string().nullable(),
   role: z.string().optional(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const devLoginResponseSchema = z.object({ user: userSchema });

const workspaceSchema = z.object({
   id: z.string(),
   name: z.string(),
   slug: z.string(),
   description: z.string().nullable(),
   role: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const bootstrapSchema = z.object({
   user: userSchema.extend({
      settings: z.object({
         theme: z.string(),
         timezone: z.string(),
         reducedMotion: z.boolean(),
         locale: z.string().default('en'),
      }),
   }),
   workspaces: z.array(workspaceSchema),
   currentWorkspaceId: z.string().nullable(),
});

const configSchema = z.object({
   capabilities: z.object({ githubSignIn: z.boolean().optional() }).passthrough(),
});

export type LoginUser = z.infer<typeof userSchema>;
export type BootstrapWorkspace = z.infer<typeof workspaceSchema>;
export type BootstrapPayload = z.infer<typeof bootstrapSchema>;

/**
 * Starts GitHub sign-in. The browser leaves for GitHub and comes back through
 * the server's callback, which sets the session cookie and lands on `/`; a
 * refusal lands on `/sign-in?error=<code>` instead.
 */
export async function signInWithGitHub(): Promise<void> {
   const origin = window.location.origin;
   const { error } = await authClient().signIn.social({
      provider: 'github',
      callbackURL: `${origin}/`,
      errorCallbackURL: `${origin}/sign-in`,
   });
   if (error) {
      throw new Error(error.message || 'GitHub sign-in could not start');
   }
}

/**
 * Development-only sign-in as an existing account. The server registers the
 * route only in development and test, so this 404s anywhere else.
 */
export async function devLogin(email: string): Promise<LoginUser> {
   const json: unknown = await apiFetch('/api/v1/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim() }),
   });
   const parsed = devLoginResponseSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Login response was not recognized');
   }
   return parsed.data.user;
}

export async function fetchBootstrap(): Promise<BootstrapPayload> {
   const json: unknown = await apiFetch('/api/v1/me/bootstrap');
   const parsed = bootstrapSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Bootstrap response was not recognized');
   }
   return parsed.data;
}

/** Whether this server can sign anyone in with GitHub (an OAuth App is configured). */
export async function fetchGitHubSignInAvailable(): Promise<boolean> {
   const json: unknown = await apiFetch('/api/v1/config');
   const parsed = configSchema.safeParse(json);
   return parsed.success && parsed.data.capabilities.githubSignIn === true;
}

/** Ends the session on the server; the cookie is cleared by the response. */
export async function logoutSession(): Promise<void> {
   const { error } = await authClient().signOut();
   if (error && error.status !== 401) {
      throw new Error(error.message || 'Sign-out failed');
   }
}
