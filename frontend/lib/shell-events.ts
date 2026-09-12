/**
 * Shell-wide announcements: things the chrome does that a page may want to
 * react to.
 *
 * The command palette can fold every comment on a task, but the palette does
 * not own the comment list and must not reach into it. So it says what
 * happened and whoever is rendering comments decides what that means — the
 * same relationship the workspace event stream has with the stores.
 *
 * DOM `CustomEvent` on `window` rather than a store: these are moments, not
 * state. Nothing should be able to ask "are the comments folded?" of the
 * shell, because the shell does not know.
 */

export interface ShellEventMap {
   /** Fold or unfold every comment thread on the task in view. */
   'berry:comments-fold': { folded: boolean };
}

export function publishShellEvent<K extends keyof ShellEventMap>(
   type: K,
   detail: ShellEventMap[K]
): void {
   if (typeof window === 'undefined') return;
   window.dispatchEvent(new CustomEvent(type, { detail }));
}

/** Listen for one shell announcement; returns the unsubscribe function. */
export function subscribeShellEvent<K extends keyof ShellEventMap>(
   type: K,
   listener: (detail: ShellEventMap[K]) => void
): () => void {
   if (typeof window === 'undefined') return () => undefined;
   const handler = (event: Event) => {
      listener((event as CustomEvent<ShellEventMap[K]>).detail);
   };
   window.addEventListener(type, handler);
   return () => window.removeEventListener(type, handler);
}
