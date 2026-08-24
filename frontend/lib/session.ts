import { createMemoryApiSession, setApiSession } from './api';

const STORAGE_KEY = 'berry.session.v1';

function normalizedToken(value: string | null | undefined): string | null {
   const token = value?.trim() ?? '';
   return token.length > 0 ? token : null;
}

/** Reads the tab-scoped prototype session token. */
export function readStoredSessionToken(): string | null {
   if (typeof window === 'undefined') return null;
   try {
      return normalizedToken(window.sessionStorage.getItem(STORAGE_KEY));
   } catch {
      return null;
   }
}

/** Installs a bearer session for `apiFetch` and keeps it for this tab. */
export function persistSessionToken(token: string): void {
   const normalized = normalizedToken(token);
   if (!normalized) {
      throw new Error('Session token is empty');
   }
   setApiSession(createMemoryApiSession(normalized));
   window.sessionStorage.setItem(STORAGE_KEY, normalized);
}

/** Restores a previous tab session into the API client. */
export function restoreSessionToken(): boolean {
   const token = readStoredSessionToken();
   if (!token) return false;
   setApiSession(createMemoryApiSession(token));
   return true;
}

/** Clears the installed API session and tab storage. */
export function clearSessionToken(): void {
   if (typeof window !== 'undefined') {
      setApiSession(undefined);
      window.sessionStorage.removeItem(STORAGE_KEY);
   }
}
