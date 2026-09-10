/**
 * Which Berry issues a pull request names, and how it should be shown.
 *
 * Pure, so the rules can be read and tested without a webhook or a database.
 * The caller supplies the workspace's own issue prefix; a key with any other
 * prefix is never read as belonging here, and the issue a number names is
 * looked up inside the workspace the webhook was routed to — never across.
 */

export type LinkSource = 'branch' | 'title' | 'body' | 'run';

export interface LinkIntent {
   number: number;
   /** The pull request said it closes the issue (`Fixes ABC-7`). */
   closeIntent: boolean;
   source: LinkSource;
}

/**
 * A closing keyword ending the text before a key.
 *
 * Anchored at the end so it has to sit directly before the key, with an
 * optional colon and whitespace between. The leading `\b` keeps a word that
 * merely ends in one (`prefix`) from counting.
 */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s*$/i;

function escapeRegExp(value: string): string {
   return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every issue number the branch, title or body names, in that order of
 * preference for `source`.
 *
 * A branch cannot close anything: nobody writes "fixes" in a branch name, and
 * reading one there would close issues on a word that happened to precede.
 */
export function findLinkIntents(input: {
   prefix: string;
   branch: string;
   title: string;
   body: string | null;
}): LinkIntent[] {
   const prefix = input.prefix.trim();
   if (!prefix) return [];
   const key = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(prefix)}-(\\d+)(?!\\d)`, 'gi');
   const found = new Map<number, LinkIntent>();

   const scan = (text: string, source: LinkSource): void => {
      for (const match of text.matchAll(key)) {
         const number = Number(match[1]);
         if (!Number.isSafeInteger(number) || number <= 0) continue;
         const close = source !== 'branch' && CLOSING_KEYWORD.test(text.slice(0, match.index));
         const previous = found.get(number);
         if (previous) previous.closeIntent = previous.closeIntent || close;
         else found.set(number, { number, closeIntent: close, source });
      }
   };

   scan(input.branch, 'branch');
   scan(input.title, 'title');
   scan(input.body ?? '', 'body');
   return [...found.values()];
}

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

export function pullRequestState(pr: {
   state: string;
   merged: boolean;
   draft: boolean;
}): PullRequestState {
   if (pr.merged) return 'merged';
   if (pr.state === 'closed') return 'closed';
   return pr.draft ? 'draft' : 'open';
}

export type CheckRollup = 'success' | 'failure' | 'pending' | 'neutral' | 'none';

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
const PASSED = new Set(['success', 'skipped']);

/**
 * One verdict for a pull request's checks.
 *
 * A failure anywhere is the answer even while other checks run, because it is
 * already decided; otherwise anything unfinished keeps the whole pending.
 */
export function rollupChecks(
   checks: ReadonlyArray<{ status: string; conclusion: string | null }>
): CheckRollup {
   if (checks.length === 0) return 'none';
   if (checks.some((check) => FAILED.has(check.conclusion ?? ''))) return 'failure';
   if (checks.some((check) => check.status !== 'completed')) return 'pending';
   if (checks.some((check) => PASSED.has(check.conclusion ?? ''))) return 'success';
   return 'neutral';
}
