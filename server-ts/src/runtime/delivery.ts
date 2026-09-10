import type { Sql } from '../db/pool.ts';
import type { GitHubClient } from '../integrations/github.ts';
import { parseRepository } from '../agents/checkout.ts';
import { pullRequestBody } from '../agents/repository-run.ts';
import type { VerificationReport } from '../agents/verification.ts';
import type { RunLedger } from '../runs/ledger.ts';
import type { DeliveryPlan } from './envelope-builder.ts';
import type { TaskDelivery, TaskMessage } from './lifecycle.ts';

/**
 * The half of delivery that needs the GitHub App: the runtime committed and
 * pushed the branch; Berry opens the pull request and records the delivery.
 * Called before the run is marked succeeded, while the ledger still accepts
 * events for it.
 */
export async function recordDelivery(deps: {
   sql: Sql;
   ledger: RunLedger;
   github: GitHubClient | null;
   runId: string;
   plan: DeliveryPlan;
   delivery: TaskDelivery;
   summary: string | null;
   verified: Extract<TaskMessage, { kind: 'verified' }> | null;
}): Promise<void> {
   const { plan, delivery } = deps;
   let pullRequest: { number: number; url: string; created: boolean } | null = null;
   if (delivery.committed && plan.mayOpenPullRequest && deps.github) {
      const report: VerificationReport = deps.verified
         ? {
              // The runtime reports each check's verdict, not its output tail.
              results: deps.verified.results.map((r) => ({ ...r, output: '' })),
              passed: deps.verified.passed,
              complete: deps.verified.complete,
              durationMs: deps.verified.durationMs,
           }
         : { results: [], passed: true, complete: true, durationMs: 0 };
      const { owner, name } = parseRepository(plan.fullName);
      const opened = await deps.github.openPullRequest({
         owner,
         name,
         head: plan.branch,
         base: plan.defaultBranch,
         title: `${plan.reference}: ${plan.title}`,
         body: pullRequestBody(deps.summary, report, deps.runId, plan.reference, { mergeRequiresApproval: plan.mergeRequiresApproval }),
      });
      pullRequest = { number: opened.number, url: opened.url, created: opened.created };
   }
   await deps.sql`
      UPDATE runs SET branch = ${plan.branch}, head_commit = ${delivery.commit},
             pull_request_number = ${pullRequest ? pullRequest.number : null}, updated_at = now()
       WHERE id = ${deps.runId}`;
   await deps.ledger.appendDelivered(deps.runId, {
      committed: delivery.committed,
      commit: delivery.commit,
      branch: plan.branch,
      filesChanged: delivery.filesChanged,
      insertions: delivery.insertions,
      deletions: delivery.deletions,
      files: delivery.files,
      pullRequest,
      mergeRequiresApproval: plan.mergeRequiresApproval,
   });
}
