import { create } from 'zustand';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import { fetchBootstrap, loginWithEmail, logoutSession, type BootstrapWorkspace } from '@/lib/auth';
import { AUTO_LOGIN_EMAIL } from '@/lib/config';
import { listBoards, selectBoardId } from '@/lib/boards';
import { toUiUser } from '@/lib/catalog';
import { clearSessionToken, restoreSessionToken } from '@/lib/session';

export type SessionStatus = 'booting' | 'anonymous' | 'ready';

export interface SessionWorkspace {
   id: string;
   name: string;
   slug: string;
}

interface SessionState {
   status: SessionStatus;
   user: User | null;
   workspace: SessionWorkspace | null;
   boardId: string | null;
   error: string | null;
   hydrateFromStorage: () => Promise<void>;
   signIn: (email: string) => Promise<void>;
   signOut: () => Promise<void>;
}

function pickWorkspace(workspaces: BootstrapWorkspace[], currentId: string | null) {
   return workspaces.find((workspace) => workspace.id === currentId) ?? workspaces[0] ?? null;
}

async function loadReadyState(): Promise<Pick<SessionState, 'user' | 'workspace' | 'boardId'>> {
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
      workspace: workspace
         ? { id: workspace.id, name: workspace.name, slug: workspace.slug }
         : null,
      boardId: selectBoardId(boards),
   };
}

export const useSessionStore = create<SessionState>((set) => ({
   status: 'booting',
   user: null,
   workspace: null,
   boardId: null,
   error: null,

   hydrateFromStorage: async () => {
      if (restoreSessionToken()) {
         try {
            const ready = await loadReadyState();
            set({ status: 'ready', error: null, ...ready });
         } catch (error) {
            clearSessionToken();
            set({
               status: 'anonymous',
               user: null,
               workspace: null,
               boardId: null,
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
         } catch (error) {
            set({
               status: 'anonymous',
               user: null,
               workspace: null,
               boardId: null,
               error: error instanceof BerryApiError ? error.message : null,
            });
            return;
         }
      }

      set({ status: 'anonymous', user: null, workspace: null, boardId: null, error: null });
   },

   signIn: async (email: string) => {
      await loginWithEmail(email);
      const ready = await loadReadyState();
      set({ status: 'ready', error: null, ...ready });
   },

   signOut: async () => {
      await logoutSession();
      set({ status: 'anonymous', user: null, workspace: null, boardId: null, error: null });
   },
}));
