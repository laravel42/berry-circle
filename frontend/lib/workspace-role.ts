/**
 * What the signed-in account may do in the workspace it is looking at.
 *
 * Mirrors the server's permission matrix (`server-ts/src/identity/roles.ts`),
 * which is the authority: every write is checked there, and a screen that got
 * this wrong would only produce a 403 instead of a quiet success. It exists so
 * a screen can *offer* the right things — a lock instead of a menu, a disabled
 * button instead of a doomed request — rather than to decide anything.
 *
 * An unknown role grants nothing, so a role Berry does not recognise reads as
 * the most restricted one rather than the least.
 */

const PRODUCT_WRITERS = new Set(['owner', 'admin', 'member']);
const SETTINGS_WRITERS = new Set(['owner', 'admin']);

/** Skills, squads, autopilots and tasks: the work itself. */
export function canEditProduct(role: string | undefined | null): boolean {
   return role ? PRODUCT_WRITERS.has(role) : false;
}

/** Runtimes and workspace configuration. */
export function canEditSettings(role: string | undefined | null): boolean {
   return role ? SETTINGS_WRITERS.has(role) : false;
}

/** Queuing a run by hand — running an autopilot now, assigning to a squad. */
export function canDispatchRuns(role: string | undefined | null): boolean {
   return role ? PRODUCT_WRITERS.has(role) : false;
}
