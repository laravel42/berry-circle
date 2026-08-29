import type { Sql } from '../db/pool.ts';
import type { Dispatch, RunLedger } from '../runs/ledger.ts';
import type { ExecutionSession } from '../execution/driver.ts';
import type { ConnectionRepository } from '../integrations/connections.ts';
import { GitHubError, type GitHubClient, type PullRequest } from '../integrations/github.ts';
import { branchName, checkout, parseRepository, type Checkout } from './checkout.ts';
import { commitAndPush } from './delivery.ts';
import { summarise, verify, type VerificationReport } from './verification.ts';
import { repositoryForIssue, type RepositoryContext } from './repository-context.ts';
import type { PermissionSet } from './permissions.ts';

/**
 * The repository half of a run: getting the code in, and getting the work out.
 *
 * Separated from the executor because it is the part with decisions in it —
 * when a missing repository is fine and when it is not, what happens to a run
 * that worked but could not push — and those decisions deserve tests that do
 * not need a language model to reach them.
 */

export interface IssueReference {
   title: string;
   /** `BER-142`, as the product spells it. */
   reference: string;
}

export interface PreparedRepository {
   repository: RepositoryContext;
   checkout: Checkout;
   defaultBranch: string;
   issue: IssueReference;
   /** Carried forward, because delivery has its own permission to check. */
   permissions: PermissionSet;
}

export interface RepositoryRunDeps {
   sql: Sql;
   ledger: RunLedger;
   /** Absent means a run never gets a repository, even when its project names one. */
   connections: ConnectionRepository | undefined;
   github: (token: string) => GitHubClient;
}

/**
 * Puts the task's repository in the run's workspace, when it has one.
 *
 * Returns null — not an error — when the task is in no project, its project
 * names no repository, or the deployment has no substrate to clone into.
 * Plenty of work is answering a question, and a run that failed because there
 * was no code to change would be wrong about what it was asked.
 *
 * A configured repository that *cannot* be prepared does raise, because an
 * agent turned loose in an empty workspace will answer confidently about code
 * it never saw.
 */
export async function prepareRepository(
   deps: RepositoryRunDeps,
   input: {
      dispatch: Dispatch;
      agentName: string;
      permissions: PermissionSet;
      /** Opens the run's workspace. Not called when there is no repository. */
      session: (() => Promise<ExecutionSession>) | null;
   }
): Promise<PreparedRepository | null> {
   if (!input.session || !deps.connections) return null;

   const repository = await repositoryForIssue(deps.sql, input.dispatch.issueId);
   if (!repository) return null;

   // Checked before the credential is opened, so an agent that may not read
   // the repository never causes a token to be decrypted on its behalf.
   input.permissions.require('read_repository');
   input.permissions.require('create_branches');

   const token = await deps.connections.token(input.dispatch.workspaceId, 'github');
   const client = deps.github(token);
   const { owner, name } = parseRepository(repository.fullName);

   // Asked before the work rather than after: an agent that spends ten minutes
   // building something and then cannot push has wasted the tokens and the
   // wait.
   const remote = await client.repository(owner, name);
   if (!remote.canPush) {
      throw new GitHubError(
         `the GitHub connection cannot push to ${repository.fullName}`,
         403,
         'grant-access'
      );
   }

   const issue = await loadIssue(deps.sql, input.dispatch.issueId);
   const result = await checkout({
      session: await input.session(),
      repository: repository.fullName,
      branch: branchName(input.agentName, issue.reference, issue.title),
      token,
      baseBranch: remote.defaultBranch,
   });

   await deps.ledger.appendRepositoryReady(input.dispatch.runId, {
      repository: repository.fullName,
      branch: result.branch,
      baseCommit: result.baseCommit,
   });

   return {
      repository,
      checkout: result,
      defaultBranch: remote.defaultBranch,
      issue,
      permissions: input.permissions,
   };
}

/**
 * Pushes what the run produced and opens a pull request for it.
 *
 * The token is fetched again rather than held across the run: a run can take
 * longer than a credential lasts, and a stale one fails at the push with an
 * error that reads like a permissions problem.
 */
export async function deliverRepository(
   deps: RepositoryRunDeps,
   input: {
      dispatch: Dispatch;
      prepared: PreparedRepository;
      /** The workspace the checkout went into — a fresh one has nothing to push. */
      session: ExecutionSession;
      summary: string | null;
   }
): Promise<void> {
   const { dispatch, prepared, summary } = input;
   const token = await deps.connections!.token(dispatch.workspaceId, 'github');
   const title = `${prepared.issue.reference}: ${prepared.issue.title}`;

   // Before the push, so the evidence describes the tree being delivered
   // rather than whatever the branch looked like afterwards. A failing check
   // does not stop the delivery: the reviewer is the point, and they need to
   // see the failure with the diff that caused it.
   const report = await verify({
      session: input.session,
      directory: prepared.checkout.directory,
      commands: prepared.repository.verifyCommands,
   });
   if (report.results.length > 0) {
      await deps.ledger.appendVerified(dispatch.runId, {
         passed: report.passed,
         complete: report.complete,
         durationMs: report.durationMs,
         results: report.results.map((result) => ({
            command: result.command,
            exitCode: result.exitCode,
            passed: result.passed,
            durationMs: result.durationMs,
            error: result.error,
         })),
      });
   }

   const delivery = await commitAndPush({
      session: input.session,
      directory: prepared.checkout.directory,
      branch: prepared.checkout.branch,
      token,
      message: title,
      ...(summary ? { body: summary } : {}),
   });

   let pullRequest: PullRequest | null = null;
   if (delivery.committed) {
      // The push has happened — the branch exists and the work is not lost —
      // but opening a pull request is a separate act with its own permission.
      prepared.permissions.require('open_pull_requests');
      const { owner, name } = parseRepository(prepared.repository.fullName);
      pullRequest = await deps.github(token).openPullRequest({
         owner,
         name,
         head: prepared.checkout.branch,
         base: prepared.defaultBranch,
         title,
         // The run is named so a reviewer can get from the pull request back to
         // the log of how it was produced.
         body: pullRequestBody(summary, report, dispatch.runId, prepared.issue.reference, {
            mergeRequiresApproval: !prepared.permissions.has('merge_without_approval'),
         }),
      });
   }

   await deps.ledger.appendDelivered(dispatch.runId, {
      committed: delivery.committed,
      commit: delivery.commit,
      branch: prepared.checkout.branch,
      filesChanged: delivery.filesChanged,
      insertions: delivery.insertions,
      deletions: delivery.deletions,
      files: delivery.files,
      pullRequest: pullRequest
         ? { number: pullRequest.number, url: pullRequest.url, created: pullRequest.created }
         : null,
      // Recorded even though nothing in Berry merges yet: when something does,
      // it reads this rather than deciding for itself, and until then a run's
      // record already says what the gate was.
      mergeRequiresApproval: !prepared.permissions.has('merge_without_approval'),
   });
}

/** The task's reference and title, for the branch, the commit and the pull request. */
export async function loadIssue(sql: Sql, issueId: string): Promise<IssueReference> {
   const [row] = await sql<Array<{ title: string; number: number; prefix: string }>>`
      SELECT i.title, i.number, COALESCE(w.settings->>'issuePrefix', 'BER') AS prefix
        FROM issues i
        JOIN boards b ON b.id = i.board_id
        JOIN workspaces w ON w.id = b.workspace_id
       WHERE i.id = ${issueId}`;
   if (!row) throw new Error(`issue ${issueId} was not found`);
   return { title: row.title, reference: `${row.prefix}-${row.number}` };
}

/**
 * What a reviewer reads before opening anything.
 *
 * The evidence goes above the fold, because the question it answers — did this
 * pass — is the one they opened the pull request to ask.
 */
export function pullRequestBody(
   summary: string | null,
   report: VerificationReport,
   runId: string,
   reference: string,
   gate: { mergeRequiresApproval: boolean } = { mergeRequiresApproval: true }
): string {
   const sections = [summary ?? 'No summary was produced.'];

   const evidence = summarise(report);
   if (evidence !== '') {
      const verdict = report.passed ? 'All checks passed.' : 'Some checks did not pass.';
      sections.push(`## Evidence\n\n${verdict}\n\n${evidence}`);
   }

   // Said where the reviewer is, not only in Berry: the person looking at this
   // pull request is the gate, and they should not have to know that.
   if (gate.mergeRequiresApproval) {
      sections.push('This was produced by an agent and needs a human approval before it merges.');
   }

   sections.push(`---\nBerry run \`${runId}\` · task ${reference}`);
   return sections.join('\n\n');
}
