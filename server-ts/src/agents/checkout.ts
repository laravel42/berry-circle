import type { ExecutionSession } from '../execution/driver.ts';

/**
 * Putting a repository into a run's workspace.
 *
 * The whole of this file exists to keep one thing true: **a credential never
 * appears in a command**. `run.command.started` records what ran verbatim and
 * streams it to every browser watching the run, so a clone URL with a token in
 * it would be published to the workspace and stored in the ledger for as long
 * as the run is kept.
 *
 * So the token is passed as an environment variable on the individual exec
 * that needs it. Per-command environment is not recorded by either substrate,
 * and — the part that matters — it does not persist into the container, so an
 * agent's own `run_command` calls afterwards cannot read it back out of `env`.
 * Berry clones; the agent works in the result and never holds the credential.
 *
 * `credential.helper` is given the *name* of the variable, never its value,
 * which is why the command below is safe to record in full.
 */

export interface CheckoutOptions {
   session: ExecutionSession;
   /** `owner/name`, as GitHub spells it. */
   repository: string;
   /** The branch the run's work goes on. */
   branch: string;
   /** Opened for this call only. Never stored, never logged, never in a command. */
   token: string;
   /** Where to clone. Defaults to the repository's own name under the workspace root. */
   directory?: string;
   /** Cloned from this branch. Defaults to the repository's default branch. */
   baseBranch?: string;
   /**
    * How much history to fetch. One commit is enough to build and test, and a
    * shallow clone of a large repository is the difference between a run
    * starting in seconds and in minutes.
    */
   depth?: number;
}

export interface Checkout {
   /** Where the working tree is, for a caller to pass as `cwd`. */
   directory: string;
   /** The commit the branch started from, for the run's record. */
   baseCommit: string;
   branch: string;
}

export class CheckoutFailed extends Error {
   override readonly name = 'CheckoutFailed';
   readonly exitCode: number;
   constructor(message: string, exitCode: number) {
      super(message);
      this.exitCode = exitCode;
   }
}

export const TOKEN_VARIABLE = 'BERRY_GIT_TOKEN';
const DEFAULT_DEPTH = 1;

/**
 * Reads the token from the environment and hands it to git as a password.
 *
 * Written as a one-line shell function rather than a file on disk: a file
 * would outlive the exec that created it and sit in the workspace where the
 * agent could read it.
 */
export const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$${TOKEN_VARIABLE}"; }; f`;

export async function checkout(options: CheckoutOptions): Promise<Checkout> {
   const repository = parseRepository(options.repository);
   const directory = options.directory ?? repository.name;
   const depth = options.depth ?? DEFAULT_DEPTH;

   // The token reaches git through this and nothing else. It is scoped to each
   // exec below, so it is gone the moment the command returns.
   const env = { [TOKEN_VARIABLE]: options.token };

   const url = `https://github.com/${repository.owner}/${repository.name}.git`;
   const branchArgs = options.baseBranch ? ` --branch ${shellQuote(options.baseBranch)}` : '';

   // A session is addressed by its run, so a retried request reaches the
   // workspace the previous attempt was using — and that attempt may have left
   // a half-cloned tree. Starting from empty is more predictable than resuming
   // something that failed for a reason nobody has diagnosed yet.
   await run(
      options.session,
      `rm -rf ${shellQuote(directory)}`,
      {},
      'clear the previous checkout'
   );

   await run(
      options.session,
      `git -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} clone --depth ${depth}${branchArgs} ${shellQuote(url)} ${shellQuote(directory)}`,
      { env },
      'clone the repository'
   );

   // Identity has to exist before a commit, and a run's commits are Berry's,
   // not a person's — attributing them to whoever connected GitHub would put
   // their name on work they did not write.
   await run(options.session, 'git config user.name "Berry"', { cwd: directory }, 'set the commit identity');
   await run(
      options.session,
      'git config user.email "agent@berry.invalid"',
      { cwd: directory },
      'set the commit identity'
   );

   const base = await run(
      options.session,
      'git rev-parse HEAD',
      { cwd: directory },
      'read the base commit'
   );

   await run(
      options.session,
      `git checkout -b ${shellQuote(options.branch)}`,
      { cwd: directory },
      'create the branch'
   );

   return { directory, baseCommit: base.trim(), branch: options.branch };
}

async function run(
   session: ExecutionSession,
   command: string,
   options: { cwd?: string; env?: Record<string, string> },
   what: string
): Promise<string> {
   const result = await session.exec(command, options);
   if (result.exitCode !== 0) {
      // stderr, not stdout: git says why there. The message is the operator's
      // — it reaches a run's failure record, not the model's prompt.
      throw new CheckoutFailed(
         `could not ${what}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
         result.exitCode
      );
   }
   return result.stdout;
}

/**
 * `owner/name`, validated.
 *
 * Refused rather than escaped: the value ends up in a URL and a shell command,
 * and a repository whose name contains a quote is not a repository anyone has.
 */
export function parseRepository(fullName: string): { owner: string; name: string } {
   const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(fullName.trim());
   if (!match) {
      throw new CheckoutFailed(`"${fullName}" is not an owner/name repository`, 0);
   }
   return { owner: match[1]!, name: match[2]!.replace(/\.git$/, '') };
}

/**
 * A branch name for a run, in the shape the product uses:
 * `forge/ber-142-passkey-enrolment`.
 *
 * Deterministic, so a retried run reuses its branch instead of leaving a
 * scatter of near-identical ones behind.
 */
export function branchName(agentName: string, issueRef: string, title: string): string {
   const agent = slug(agentName) || 'agent';
   const reference = slug(issueRef) || 'task';
   const subject = slug(title).split('-').slice(0, 6).join('-');
   return subject ? `${agent}/${reference}-${subject}` : `${agent}/${reference}`;
}

function slug(value: string): string {
   return value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '');
}

/**
 * Single-quotes a value for `sh -c`.
 *
 * Every substrate runs commands through a shell, so anything interpolated has
 * to survive it. The closing-quote dance is the standard one: end the quote,
 * emit an escaped quote, start a new one.
 */
export function shellQuote(value: string): string {
   return `'${value.replaceAll("'", `'\\''`)}'`;
}
