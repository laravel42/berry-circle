import { create } from 'zustand';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import {
   fetchBootstrap,
   loginWithEmail,
   logoutSession,
   signInWithPassword,
   signUpWithPassword,
   type BootstrapWorkspace,
} from '@/lib/auth';
import { AUTO_LOGIN_EMAIL } from '@/lib/config';
import { listBoards, selectBoardId } from '@/lib/boards';
import { toUiUser } from '@/lib/catalog';
import { clearSessionToken, restoreSessionToken } from '@/lib/session';
import { selectWorkspace } from '@/lib/workspaces';

export type SessionStatus = 'booting' | 'anonymous' | 'ready';

export interface SessionWorkspace {
   id: string;
   name: string;
   slug: string;
}

interface SessionState {
   status: SessionStatus;
   user: User | null;
   /** The active workspace: the persisted selection, resolved on load. */
   workspace: SessionWorkspace | null;
   /** Every workspace the user belongs to, for the switcher menu. */
   workspaces: SessionWorkspace[];
   boardId: string | null;
   error: string | null;
   hydrateFromStorage: () => Promise<void>;
   signIn: (email: string, password: string) => Promise<void>;
   signUp: (email: string, password: string) => Promise<void>;
   signOut: () => Promise<void>;
   /**
    * Re-read `/me/bootstrap` and re-derive the ready state. Onboarding calls
    * this after creating or joining a workspace so the store reflects the new
    * membership, then routes into the resolved workspace. Returns the resolved
    * workspace (or null when the account still has none).
    */
   refreshWorkspaces: () => Promise<SessionWorkspace | null>;
   /**
    * Persist a new active workspace the user belongs to and make it current in
    * the store. Returns the switched-to workspace, or null when the id is not
    * one of the user's memberships. Callers navigate into it on success.
    */
   switchWorkspace: (workspaceId: string) => Promise<SessionWorkspace | null>;
}

/**
 * The selection rule (Requirements 10.1, 10.4, 10.5): the previously selected
 * workspace when it is still a valid membership, otherwise the earliest-joined.
 * The server returns `currentId` as previous-if-valid-else-null, so a null here
 * means fall back to the earliest by `createdAt` (ties broken by id for a
 * deterministic pick) rather than trusting incoming array order.
 */
function pickWorkspace(workspaces: BootstrapWorkspace[], currentId: string | null) {
   const current = workspaces.find((workspace) => workspace.id === currentId);
   if (current) return current;
   const earliest = [...workspaces].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
   });
   return earliest[0] ?? null;
}

const toSessionWorkspace = (workspace: BootstrapWorkspace): SessionWorkspace => ({
   id: workspace.id,
   name: workspace.name,
   slug: workspace.slug,
});

async function loadReadyState(): Promise<
   Pick<SessionState, 'user' | 'workspace' | 'workspaces' | 'boardId'>
> {
   const bootstrap = await fetchBootstrap();
   const workspace = pickWorkspace(bootstrap.workspaces, bootstrap.currentWorkspaceId);
   const boards = await listBoards();
   return {
      user: toUiUser({
         id: bootstrap.user.id,
         name: bootstrap.user.name,
         avatarUrl: bootstrap.user.avatarUrl,
         email: bootstrap.user.email,
         type: 'user',
      }),
      workspace: workspace ? toSessionWorkspace(workspace) : null,
      workspaces: bootstrap.workspaces.map(toSessionWorkspace),
      boardId: selectBoardId(boards),
   };
}

const ANONYMOUS = {
   status: 'anonymous' as const,
   user: null,
   workspace: null,
   workspaces: [] as SessionWorkspace[],
   boardId: null,
   error: null,
};

export const useSessionStore = create<SessionState>((set, get) => ({
   status: 'booting',
   user: null,
   workspace: null,
   workspaces: [],
   boardId: null,
   error: null,

   hydrateFromStorage: async () => {
      // A tab-stored token is the normal way in. When none exists and a
      // development AUTO_LOGIN_EMAIL is configured, sign in as that account
      // through the passwordless route before falling back to anonymous. The
      // route is server-gated to development/test and 404s in production, so a
      // stray value cannot establish a session against a production API — a
      // failed auto-login simply lands on the sign-in screen.
      if (restoreSessionToken()) {
         try {
            const ready = await loadReadyState();
            set({ status: 'ready', error: null, ...ready });
         } catch (error) {
            clearSessionToken();
            set({
               ...ANONYMOUS,
               error: error instanceof BerryApiError ? error.message : null,
            });
         }
         return;
      }

      if (AUTO_LOGIN_EMAIL) {
         try {
            await loginWithEmail(AUTO_LOGIN_EMAIL);
            const ready = await loadReadyState();
            set({ status: 'ready', error: null, ...ready });
            return;
         } catch {
            // Auto-login is a convenience, not a guarantee: on any failure
            // (route disabled, unknown account, network) clear any partial
            // token and present the sign-in screen rather than an error.
            clearSessionToken();
            set({ ...ANONYMOUS });
            return;
         }
      }

      set({ ...ANONYMOUS });
   },

   signIn: async (email: string, password: string) => {
      await signInWithPassword(email, password);
      const ready = await loadReadyState();
      set({ status: 'ready', error: null, ...ready });
   },

   signUp: async (email: string, password: string) => {
      await signUpWithPassword(email, password);
      const ready = await loadReadyState();
      set({ status: 'ready', error: null, ...ready });
   },

   signOut: async () => {
      await logoutSession();
      set({ ...ANONYMOUS });
   },

   refreshWorkspaces: async () => {
      const ready = await loadReadyState();
      set({ status: 'ready', error: null, ...ready });
      return ready.workspace;
   },

   switchWorkspace: async (workspaceId: string) => {
      // Only a workspace the user belongs to can be switched to; the server
      // re-checks membership on select and 404s otherwise, but guarding here
      // keeps a stale menu from issuing a doomed request.
      const target = get().workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target) return null;
      if (get().workspace?.id === workspaceId) return target;

      await selectWorkspace(workspaceId);
      set({ workspace: target });
      return target;
   },
}));
