import { create } from 'zustand';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import { devLogin, fetchBootstrap, logoutSession, type BootstrapWorkspace } from '@/lib/auth';
import { AUTO_LOGIN_EMAIL } from '@/lib/config';
import { listBoards, selectBoardId } from '@/lib/boards';
import { toUiUser } from '@/lib/catalog';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { selectWorkspace } from '@/lib/workspaces';

export type SessionStatus = 'booting' | 'anonymous' | 'ready';

export interface SessionWorkspace {
   id: string;
   name: string;
   slug: string;
   /** The signed-in account's role here, which decides what a screen may offer. */
   role: string;
}

interface SessionState {
   status: SessionStatus;
   user: User | null;
   /** The active workspace: the persisted selection, resolved on load. */
   workspace: SessionWorkspace | null;
   /** Every workspace the user belongs to, for the switcher menu. */
   workspaces: SessionWorkspace[];
   boardId: string | null;
   /** The account's interface language, from bootstrap; null when anonymous. */
   preferredLocale: Locale | null;
   /** Settings calls this after saving, so LocaleSync does not revert the choice. */
   setPreferredLocale: (locale: Locale) => void;
   error: string | null;
   hydrateFromStorage: () => Promise<void>;
   signOut: () => Promise<void>;
   /** Drops to anonymous locally, without a server round trip (sign-out fallback). */
   markAnonymous: () => void;
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
   role: workspace.role,
});

async function loadReadyState(): Promise<
   Pick<SessionState, 'user' | 'workspace' | 'workspaces' | 'boardId' | 'preferredLocale'>
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
      preferredLocale: isLocale(bootstrap.user.settings.locale)
         ? bootstrap.user.settings.locale
         : null,
   };
}

const ANONYMOUS = {
   status: 'anonymous' as const,
   user: null,
   workspace: null,
   workspaces: [] as SessionWorkspace[],
   boardId: null,
   preferredLocale: null,
   error: null,
};

export const useSessionStore = create<SessionState>((set, get) => ({
   status: 'booting',
   user: null,
   workspace: null,
   workspaces: [],
   boardId: null,
   preferredLocale: null,
   error: null,

   setPreferredLocale: (locale) => set({ preferredLocale: locale }),

   hydrateFromStorage: async () => {
      // The session is a cookie the browser sends on its own, so "is anyone
      // signed in" is simply whether bootstrap answers. A 401 is the normal
      // anonymous answer, not an error worth showing.
      try {
         const ready = await loadReadyState();
         set({ status: 'ready', error: null, ...ready });
         return;
      } catch (error) {
         if (!(error instanceof BerryApiError) || error.status !== 401) {
            set({ ...ANONYMOUS, error: error instanceof BerryApiError ? error.message : null });
            return;
         }
      }

      // Development only: sign in as a configured account through dev-login.
      // The server serves that route only in development and test, so a stray
      // value cannot sign anyone in against a production API.
      if (AUTO_LOGIN_EMAIL) {
         try {
            await devLogin(AUTO_LOGIN_EMAIL);
            const ready = await loadReadyState();
            set({ status: 'ready', error: null, ...ready });
            return;
         } catch {
            // A convenience, not a guarantee: fall through to the sign-in page.
         }
      }

      set({ ...ANONYMOUS });
   },

   signOut: async () => {
      await logoutSession();
      set({ ...ANONYMOUS });
   },

   markAnonymous: () => set({ ...ANONYMOUS }),

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
