import type { ExecutionSession } from '../execution/driver.ts';
import { withTrailers } from '../scm/commit-trailer.ts';
import { CheckoutFailed, shellQuote } from './checkout.ts';

/**
 * Turning a working tree into a branch someone can review.
 *
 * The credential rule from `checkout.ts` holds here too and for the same
 * reason: the push is a command, commands are recorded verbatim, so the token
 * travels as per-command environment and git is told the variable's name.
 *
 * The interesting case is the boring one. An agent that ran and changed
 * nothing is a *result* — a question answered, a bug found not to exist — not
 * a failure, and not something to open an empty pull request about. It is
 * reported as `committed: false` and the caller decides what to say.
 */

export interface DeliveryOptions {
   session: ExecutionSession;
   /** The checkout's directory, as `checkout()` returned it. */
   directory: string;
   branch: string;
   /** Opened for this call only. Never stored, never logged, never in a command. */
   token: string;
   /** The commit subject. A body is appended after a blank line when given. */
   message: string;
   body?: string;
   /** Trailer lines (`Key: value`) appended after the body. */
   trailers?: string[];
}

export interface Delivery {
   /** False when the tree was clean and nothing was pushed. */
   committed: boolean;
   commit: string | null;
   filesChanged: number;
   insertions: number;
   deletions: number;
   /** Paths, for a reviewer's summary. Bounded — a rename storm is not a report. */
   files: string[];
}

/** Beyond this a file list stops being useful and starts being a wall. */
const MAX_LISTED_FILES = 50;

export async function commitAndPush(options: DeliveryOptions): Promise<Delivery> {
   const at = { cwd: options.directory };

   // Everything, including files the agent created. `-A` rather than `-u`,
   // because a new file is the usual shape of an agent's work.
   await run(options.session, 'git add -A', at, 'stage the changes');

   const staged = await run(options.session, 'git diff --cached --numstat', at, 'read the changes');
   const stat = parseNumstat(staged);

   if (stat.filesChanged === 0) {
      // Nothing to commit, so nothing to push and nothing to open. Saying so
      // is the answer; inventing an empty commit would put a pull request in
      // front of a reviewer with nothing in it.
      return { committed: false, commit: null, ...stat };
   }

   const message = withTrailers(
      options.body ? `${options.message}\n\n${options.body}` : options.message,
      options.trailers ?? []
   );
   await run(
      options.session,
      // Single-quoted, which sh preserves newlines inside — so a message with
      // a body survives without the protocol needing to carry stdin. The
      // message is recorded in the run log, which is correct: it is not a
      // secret, and it is what the commit will say.
      `git commit --quiet --message=${shellQuote(message)}`,
      at,
      'commit the changes'
   );

   const commit = (
      await run(options.session, 'git rev-parse HEAD', at, 'read the commit')
   ).trim();

   // What the remote has on this branch right now, so the push can say what
   // it expects to replace. A retried run's earlier attempt already pushed
   // the branch; a fresh shallow clone knows nothing about it, and the
   // implicit lease was refused with "stale info" even once the branch had
   // been fetched — reproduced against a bare repository, and specific to a
   // shallow clone. An explicit lease is honoured in both. The refspec is
   // spelled out because `clone --branch` is a single-branch clone whose
   // remote covers only the default branch.
   await options.session.exec(
      `git -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} fetch origin ${shellQuote(`+refs/heads/${options.branch}:refs/remotes/origin/${options.branch}`)}`,
      { ...at, env: { [TOKEN_VARIABLE]: options.token } }
   );
   const remote = await options.session.exec(
      `git rev-parse --verify --quiet ${shellQuote(`refs/remotes/origin/${options.branch}`)}`,
      at
   );
   // Empty when the branch does not exist yet: the lease then means "create
   // it, and refuse if somebody made one meanwhile".
   const expected = remote.exitCode === 0 ? remote.stdout.trim() : '';

   await run(
      options.session,
      // The lease names what it expects, so a retried run updates its own
      // branch and still refuses if someone else has pushed to it meanwhile.
      `git -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} push --force-with-lease=${shellQuote(`${options.branch}:${expected}`)} --set-upstream origin ${shellQuote(options.branch)}`,
      { ...at, env: { [TOKEN_VARIABLE]: options.token } },
      'push the branch'
   );

   return { committed: true, commit, ...stat };
}

const TOKEN_VARIABLE = 'BERRY_GIT_TOKEN';
const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$${TOKEN_VARIABLE}"; }; f`;

/**
 * `git diff --numstat`, which is one line per file: insertions, deletions, path.
 *
 * A binary file reports `-` for both counts. Those are files that changed, so
 * they count towards the total and contribute nothing to the line numbers —
 * reading `-` as zero would be right by accident and wrong in principle.
 */
export function parseNumstat(output: string): {
   filesChanged: number;
   insertions: number;
   deletions: number;
   files: string[];
} {
   let filesChanged = 0;
   let insertions = 0;
   let deletions = 0;
   const files: string[] = [];

   for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const parts = trimmed.split('\t');
      if (parts.length < 3) continue;

      filesChanged += 1;
      insertions += count(parts[0]);
      deletions += count(parts[1]);
      if (files.length < MAX_LISTED_FILES) {
         // A rename is `old => new`; the path after the arrow is the one that
         // exists now and the one a reviewer will open.
         files.push(renamedTo(parts.slice(2).join('\t')));
      }
   }
   return { filesChanged, insertions, deletions, files };
}

function count(value: string | undefined): number {
   const parsed = Number(value);
   return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The path a renamed file now has.
 *
 * git writes a rename compactly, keeping the parts that did not change:
 * `src/{old => new}/file.ts` means `src/new/file.ts`, and there can be more
 * than one group in a path. Taking everything after the arrow looks right on
 * the simple case and quietly loses the prefix on every other one.
 *
 * Without braces the whole path was replaced, and the half after the arrow is
 * the answer.
 */
function renamedTo(path: string): string {
   if (path.includes('{')) {
      // A component removed entirely leaves `{old => }`, which expands to an
      // empty segment; collapse it rather than emitting `src//file.ts`.
      return path.replace(/\{[^{}]*? => ([^{}]*?)\}/g, '$1').replace(/\/{2,}/g, '/');
   }
   const arrow = path.indexOf(' => ');
   return arrow === -1 ? path : path.slice(arrow + 4);
}

async function run(
   session: ExecutionSession,
   command: string,
   options: { cwd?: string; env?: Record<string, string> },
   what: string
): Promise<string> {
   const result = await session.exec(command, options);
   if (result.exitCode !== 0) {
      throw new CheckoutFailed(
         `could not ${what}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
         result.exitCode
      );
   }
   return result.stdout;
}
