import { join } from 'node:path';
import { CREDENTIAL_HELPER, TOKEN_VARIABLE, checkout, shellQuote } from '../../checkout.ts';
import { commitAndPush } from '../../delivery.ts';
import { verify } from '../../verification.ts';
import { emitterSink } from './emitter.ts';
import type { RepositoryStep } from './handler.ts';

/**
 * The run's repository, cloned and pushed from inside the runtime.
 *
 * Warm, the checkout from the last run on this issue is still on disk on the
 * issue's branch and is reused as it stands. Cold, the microVM was reaped:
 * clone the base shallowly, then pick up whatever an earlier run pushed to
 * the issue's branch, so a reaped VM loses no delivered work.
 */
const DIRECTORY = 'repo';

export function containerRepository(): RepositoryStep {
   return {
      async prepare({ envelope, session, warm, emit }) {
         const repo = envelope.repo;
         if (!repo) return null;
         const directory = join(session.root, DIRECTORY);
         const sink = emitterSink(emit);

         if (warm) {
            const head = await session.exec('git rev-parse --abbrev-ref HEAD', { cwd: directory });
            if (head.exitCode === 0 && head.stdout.trim() === repo.branch) {
               const base = await session.exec('git rev-parse HEAD', { cwd: directory });
               await sink.appendRepositoryReady(envelope.runId, {
                  repository: repo.fullName, branch: repo.branch, baseCommit: base.stdout.trim(),
               });
               return directory;
            }
         }

         const result = await checkout({
            session,
            repository: repo.fullName,
            branch: repo.branch,
            token: repo.credential.password,
            baseBranch: repo.baseBranch,
            directory,
         });
         const env = { [TOKEN_VARIABLE]: repo.credential.password };
         const helper = `-c credential.helper=${shellQuote(CREDENTIAL_HELPER)}`;
         const pushed = await session.exec(
            `git ${helper} fetch --depth 50 origin ${shellQuote(repo.branch)}`,
            { cwd: directory, env }
         );
         if (pushed.exitCode === 0) {
            await session.exec('git reset --hard FETCH_HEAD', { cwd: directory });
         }
         await sink.appendRepositoryReady(envelope.runId, {
            repository: repo.fullName, branch: result.branch, baseCommit: result.baseCommit,
         });
         return directory;
      },

      async deliver({ envelope, session, directory, summary, emit }) {
         const repo = envelope.repo;
         if (!repo) return null;
         const sink = emitterSink(emit);
         const report = await verify({ session, directory, commands: repo.verifyCommands });
         if (report.results.length > 0) {
            await sink.appendVerified(envelope.runId, {
               passed: report.passed,
               complete: report.complete,
               durationMs: report.durationMs,
               results: report.results.map((r) => ({
                  command: r.command, exitCode: r.exitCode, passed: r.passed, durationMs: r.durationMs, error: r.error,
               })),
            });
         }
         const delivery = await commitAndPush({
            session,
            directory,
            branch: repo.branch,
            token: repo.credential.password,
            message: `${repo.issueReference}: ${repo.issueTitle}`,
            ...(summary ? { body: summary } : {}),
         });
         return { ...delivery, branch: repo.branch };
      },
   };
}
