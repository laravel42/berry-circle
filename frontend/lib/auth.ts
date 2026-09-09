import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { clearSessionToken, persistSessionToken } from './session';

const userSchema = z.object({
   id: z.string(),
   email: z.string(),
   name: z.string(),
   avatarUrl: z.string().nullable(),
   role: z.string().optional(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const loginResponseSchema = z.object({
   token: z.string().min(1),
   expiresAt: z.string(),
   user: userSchema,
});

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
      }),
   }),
   workspaces: z.array(workspaceSchema),
   currentWorkspaceId: z.string().nullable(),
});

export type LoginUser = z.infer<typeof userSchema>;
export type BootstrapWorkspace = z.infer<typeof workspaceSchema>;
export type BootstrapPayload = z.infer<typeof bootstrapSchema>;

/** Passwordless known-email login used by the development prototype. */
export async function loginWithEmail(email: string): Promise<LoginUser> {
   const json: unknown = await apiFetch('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim() }),
   });
   const parsed = loginResponseSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Login response was not recognized');
   }
   persistSessionToken(parsed.data.token);
   return parsed.data.user;
}

/**
 * Password sign-in. On success the raw token is installed in memory and tab
 * storage; on a 401 the server returns the uniform invalid-credentials
 * envelope, which the caller surfaces without revealing whether the email is
 * registered.
 */
export async function signInWithPassword(email: string, password: string): Promise<LoginUser> {
   const json: unknown = await apiFetch('/api/v1/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), password }),
   });
   const parsed = loginResponseSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Sign-in response was not recognized');
   }
   persistSessionToken(parsed.data.token);
   return parsed.data.user;
}

/**
 * Password sign-up. Creates the account and issues a session in one server
 * transaction, so a 201 already carries a usable token — treated exactly like
 * sign-in from here on.
 */
export async function signUpWithPassword(email: string, password: string): Promise<LoginUser> {
   const json: unknown = await apiFetch('/api/v1/auth/sign-up', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), password }),
   });
   const parsed = loginResponseSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Sign-up response was not recognized');
   }
   persistSessionToken(parsed.data.token);
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

export async function logoutSession(): Promise<void> {
   try {
      await apiFetch('/api/v1/auth/sign-out', { method: 'POST' });
   } catch (error) {
      if (!(error instanceof BerryApiError) || error.status !== 401) {
         throw error;
      }
   } finally {
      clearSessionToken();
   }
}
