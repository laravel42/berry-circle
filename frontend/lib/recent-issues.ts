/**
 * The tasks this person looked at, most recent first.
 *
 * Kept in `localStorage` rather than on the server: it is a reading history on
 * one machine, it has to be there before the first render of a rail that shows
 * it, and it is worth nothing to anyone but its owner. The key and the shape
 * are a contract with whatever renders the list — changing either silently
 * empties someone's history, so both are fixed here and read nowhere else.
 */

const KEY = 'berry.recentIssues';
const LIMIT = 20;

export interface RecentIssue {
   id: string;
   identifier: string;
   title: string;
}

function isRecentIssue(value: unknown): value is RecentIssue {
   if (typeof value !== 'object' || value === null) return false;
   const entry = value as Record<string, unknown>;
   return (
      typeof entry.id === 'string' &&
      typeof entry.identifier === 'string' &&
      typeof entry.title === 'string'
   );
}

/** Every remembered task, newest first. Empty when there is nothing to read. */
export function readRecentIssues(): RecentIssue[] {
   if (typeof window === 'undefined') return [];
   try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRecentIssue).slice(0, LIMIT);
   } catch {
      // A private window, cleared site data, or something else's value under
      // the same key. An empty history is the honest answer to all of them.
      return [];
   }
}

/**
 * Record a visit.
 *
 * The entry moves to the front rather than being added again, so re-reading
 * one task does not push the other nineteen out of the list one refresh at a
 * time. Matching is by id: an identifier can be re-pointed and a title is
 * edited constantly, but the id is the task.
 */
export function rememberIssue(entry: RecentIssue): RecentIssue[] {
   if (typeof window === 'undefined') return [];
   if (!entry.id || !entry.identifier) return readRecentIssues();
   const next = [entry, ...readRecentIssues().filter((seen) => seen.id !== entry.id)].slice(
      0,
      LIMIT
   );
   try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
   } catch {
      // Storage full or refused. The visit is not worth failing a page over.
   }
   return next;
}

/** Drop a task from the history — used when it turns out not to exist. */
export function forgetIssue(issueId: string): void {
   if (typeof window === 'undefined') return;
   try {
      window.localStorage.setItem(
         KEY,
         JSON.stringify(readRecentIssues().filter((seen) => seen.id !== issueId))
      );
   } catch {
      // As above.
   }
}
