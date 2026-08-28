import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { RunLedger } from '../runs/ledger.ts';
import { deliverRepository, loadIssue, prepareRepository, type RepositoryRunDeps } from './repository-run.ts';
import { ConnectionUnavailable, type ConnectionRepository } from '../integrations/connections.ts';
import { GitHubError, type GitHubClient, type PullRequest, type Repository } from '../integrations/github.ts';
import { CheckoutFailed } from './checkout.ts';
import type { ExecResult, ExecutionSession } from '../execution/driver.ts';

/**
 * The repository half of a run, against a real database and a fake everything
 * else.
 *
 * Real SQL because the lookups are joins and the reference format is built
 * from a workspace setting — a fake would agree with whatever the code said.
 * Fake substrate and GitHub because the decisions being tested are about when
 * to clone, when not to, and what happens to a run that worked but could not
 * push.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;
const TOKEN = 'ghu_TestTokenValue00000000000000000000000';

interface Recorded {
   type: string;
   [key: string]: unknown;
}

describe(
   'the repository half of a run',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      const fixture: Record<string, string> = {};
      let events: Recorded[] = [];
      let commands: Array<{ command: string; env: Record<string, string> | undefined }> = [];

      before(async () => {
         sql = openDatabase({ url: url! });
         const suffix = randomUUID().slice(0, 8);
         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`repo-run-${suffix}@berry.test`}, 'Repo Run') RETURNING id`;
         fixture.userId = user!.id as string;

         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`RepoRun ${suffix}`}, ${`repo-run-${suffix}`},
                    ${sql.json({ issuePrefix: 'RUN', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${fixture.userId})
            RETURNING id`;
         fixture.workspaceId = workspace!.id as string;
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${fixture.workspaceId}, ${fixture.userId}, 'owner')`;

         const [board] = await sql`
            INSERT INTO boards (id, workspace_id, name, slug, created_by)
            VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Run board', ${`run-${suffix}`}, ${fixture.userId})
            RETURNING id`;
         fixture.boardId = board!.id as string;

         const [agent] = await sql`
            INSERT INTO agents (id, workspace_id, board_id, name)
            VALUES (${randomUUID()}, ${fixture.workspaceId}, ${fixture.boardId}, 'Forge') RETURNING id`;
         fixture.agentId = agent!.id as string;
      });

      after(async () => {
         if (!sql) return;
         await sql`DELETE FROM run_events WHERE board_id = ${fixture.boardId!}`;
         await sql`UPDATE issues SET active_run_id = NULL WHERE board_id = ${fixture.boardId!}`;
         await sql`DELETE FROM runs WHERE board_id = ${fixture.boardId!}`;
         await sql`DELETE FROM issue_project_links WHERE workspace_id = ${fixture.workspaceId!}`;
         await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId!}`;
         await sql`DELETE FROM projects WHERE workspace_id = ${fixture.workspaceId!}`;
         await closeDatabase(sql);
      });

      // ------------------------------------------------------------- fakes

      function fakeSession(results: Record<string, Partial<ExecResult>> = {}): ExecutionSession {
         return {
            id: 'session',
            exec: async (command, options) => {
               commands.push({ command, env: options?.env });
               const match = Object.keys(results).find((key) => command.includes(key));
               return {
                  stdout: '',
                  stderr: '',
                  exitCode: 0,
                  ...(match ? results[match] : {}),
               } as ExecResult;
            },
            stream: () => ({ async *[Symbol.asyncIterator]() {} }),
            writeFile: async () => undefined,
            readFile: async () => '',
            stop: async () => undefined,
            destroy: async () => undefined,
         };
      }

      function fakeConnections(token: string | Error = TOKEN): ConnectionRepository {
         return {
            find: async () => null,
            token: async () => {
               if (token instanceof Error) throw token;
               return token;
            },
         } as unknown as ConnectionRepository;
      }

      function fakeGitHub(
         overrides: { repository?: Partial<Repository>; pull?: Partial<PullRequest> | Error } = {}
      ): (token: string) => GitHubClient {
         return () =>
            ({
               repository: async (): Promise<Repository> => ({
                  defaultBranch: 'main',
                  canPush: true,
                  ...overrides.repository,
               }),
               openPullRequest: async (): Promise<PullRequest> => {
                  if (overrides.pull instanceof Error) throw overrides.pull;
                  return {
                     number: 381,
                     url: 'https://github.com/berry/frontend/pull/381',
                     state: 'open',
                     created: true,
                     ...overrides.pull,
                  };
               },
               findPullRequest: async () => null,
            }) as unknown as GitHubClient;
      }

      function deps(over: Partial<RepositoryRunDeps> = {}): RepositoryRunDeps {
         events = [];
         const ledger = {
            appendRepositoryReady: async (_id: string, p: object) =>
               void events.push({ type: 'repository.ready', ...p }),
            appendDelivered: async (_id: string, p: object) =>
               void events.push({ type: 'delivered', ...p }),
         } as unknown as RunLedger;
         return {
            sql,
            ledger,
            connections: fakeConnections(),
            github: fakeGitHub(),
            ...over,
         };
      }

      // ------------------------------------------------------------ fixture

      let repoId = 5000;
      async function newIssue(
         title: string,
         repository: string | null
      ): Promise<{ issueId: string; runId: string; dispatch: never }> {
         const issueId = randomUUID();
         const runId = randomUUID();
         const [counter] = await sql`
            UPDATE boards SET issue_counter = issue_counter + 1
             WHERE id = ${fixture.boardId!} RETURNING issue_counter`;
         await sql`
            INSERT INTO issues (id, board_id, number, title, status, created_by)
            VALUES (${issueId}, ${fixture.boardId!}, ${Number(counter!.issue_counter)}, ${title},
                    'in_progress', ${fixture.userId!})`;
         if (repository) {
            const projectId = randomUUID();
            await sql`
               INSERT INTO projects (id, workspace_id, name, github_repo_full_name, github_repo_id, created_by)
               VALUES (${projectId}, ${fixture.workspaceId!}, ${`P${(repoId += 1)}`},
                       ${repository}, ${repoId}, ${fixture.userId!})`;
            await sql`
               INSERT INTO issue_project_links (workspace_id, issue_id, project_id, linked_by)
               VALUES (${fixture.workspaceId!}, ${issueId}, ${projectId}, ${fixture.userId!})`;
         }
         const dispatch = {
            runId,
            issueId,
            boardId: fixture.boardId!,
            agentId: fixture.agentId!,
            workspaceId: fixture.workspaceId!,
         } as never;
         return { issueId, runId, dispatch };
      }

      // -------------------------------------------------------------- tests

      test('a task with no repository prepares nothing, and that is not an error', async () => {
         const { dispatch } = await newIssue('Answer a question', null);
         const prepared = await prepareRepository(deps(), {
            dispatch,
            agentName: 'Forge',
            session: async () => fakeSession(),
         });
         assert.equal(prepared, null);
         assert.deepEqual(events, []);
      });

      test('no substrate and no connection each mean no repository', async () => {
         const { dispatch } = await newIssue('Has a repo', 'berry/frontend');

         assert.equal(
            await prepareRepository(deps(), { dispatch, agentName: 'Forge', session: null }),
            null
         );
         assert.equal(
            await prepareRepository(deps({ connections: undefined }), {
               dispatch,
               agentName: 'Forge',
               session: async () => fakeSession(),
            }),
            null
         );
      });

      test('a repository is cloned onto a branch named from the task', async () => {
         const { dispatch } = await newIssue('Implement passkey enrolment', 'berry/frontend');
         commands = [];
         const prepared = await prepareRepository(deps(), {
            dispatch,
            agentName: 'Forge',
            session: async () => fakeSession({ 'rev-parse': { stdout: '4f2a9c1\n' } }),
         });

         assert.ok(prepared);
         assert.equal(prepared.repository.fullName, 'berry/frontend');
         assert.equal(prepared.defaultBranch, 'main');
         // The workspace's own prefix and the issue number, as the product
         // spells a reference.
         assert.match(prepared.issue.reference, /^RUN-\d+$/);
         assert.match(prepared.checkout.branch, /^forge\/run-\d+-implement-passkey-enrolment$/);
         assert.deepEqual(events, [
            {
               type: 'repository.ready',
               repository: 'berry/frontend',
               branch: prepared.checkout.branch,
               baseCommit: '4f2a9c1',
            },
         ]);
      });

      test('a connection that cannot push stops the run before it earns one', async () => {
         // Ten minutes of work and then a refused push is the failure this
         // check exists to turn into an immediate one.
         const { dispatch } = await newIssue('Needs write access', 'berry/frontend');
         await assert.rejects(
            prepareRepository(deps({ github: fakeGitHub({ repository: { canPush: false } }) }), {
               dispatch,
               agentName: 'Forge',
               session: async () => fakeSession(),
            }),
            (error: GitHubError) => {
               assert.equal(error.status, 403);
               assert.equal(error.remedy, 'grant-access');
               return true;
            }
         );
      });

      test('a missing credential stops the run rather than cloning anonymously', async () => {
         const { dispatch } = await newIssue('No credential', 'berry/frontend');
         await assert.rejects(
            prepareRepository(
               deps({ connections: fakeConnections(new ConnectionUnavailable('not connected', 'missing')) }),
               { dispatch, agentName: 'Forge', session: async () => fakeSession() }
            ),
            ConnectionUnavailable
         );
      });

      test('a clone that fails raises rather than running an agent in an empty workspace', async () => {
         // An agent with no code will answer confidently about code it never
         // saw, which is worse than a run that stops.
         const { dispatch } = await newIssue('Clone fails', 'berry/frontend');
         await assert.rejects(
            prepareRepository(deps(), {
               dispatch,
               agentName: 'Forge',
               session: async () =>
                  fakeSession({ clone: { exitCode: 128, stderr: 'fatal: not found\n' } }),
            }),
            CheckoutFailed
         );
      });

      test('delivering pushes, opens a pull request, and records both', async () => {
         const { dispatch } = await newIssue('Deliver me', 'berry/frontend');
         const collaborators = deps();
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         assert.ok(prepared);

         events = [];
         await deliverRepository(collaborators, {
            dispatch,
            prepared,
            session: fakeSession({
               numstat: { stdout: '12\t3\tsrc/a.ts\n' },
               'rev-parse': { stdout: 'a1b2c3d\n' },
            }),
            summary: 'Added an abort signal.',
         });

         assert.deepEqual(events, [
            {
               type: 'delivered',
               committed: true,
               commit: 'a1b2c3d',
               branch: prepared.checkout.branch,
               filesChanged: 1,
               insertions: 12,
               deletions: 3,
               files: ['src/a.ts'],
               pullRequest: {
                  number: 381,
                  url: 'https://github.com/berry/frontend/pull/381',
                  created: true,
               },
            },
         ]);
      });

      test('an agent that changed nothing is recorded as delivering nothing', async () => {
         // Not a failure, and not an empty pull request in front of a reviewer.
         const { dispatch } = await newIssue('No changes', 'berry/frontend');
         const collaborators = deps({
            github: fakeGitHub({ pull: new Error('a pull request must not be opened') }),
         });
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         assert.ok(prepared);

         events = [];
         await deliverRepository(collaborators, {
            dispatch,
            prepared,
            session: fakeSession({ numstat: { stdout: '' } }),
            summary: 'Nothing needed changing.',
         });

         const delivered = events[0]!;
         assert.equal(delivered.committed, false);
         assert.equal(delivered.commit, null);
         assert.equal(delivered.pullRequest, null);
      });

      test('the credential never reaches a recorded command', async () => {
         const { dispatch } = await newIssue('Secret safety', 'berry/frontend');
         const collaborators = deps();
         commands = [];
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         await deliverRepository(collaborators, {
            dispatch,
            prepared: prepared!,
            session: fakeSession({
               numstat: { stdout: '1\t0\ta.ts\n' },
               'rev-parse': { stdout: 'abc\n' },
            }),
            summary: null,
         });

         assert.ok(commands.length > 0);
         for (const call of commands) {
            assert.ok(!call.command.includes(TOKEN), `token leaked into: ${call.command}`);
         }
         // Exactly two commands are trusted with it: the clone and the push.
         assert.equal(commands.filter((call) => call.env?.BERRY_GIT_TOKEN).length, 2);
      });

      test('a reference is built from the workspace prefix, not a hardcoded one', async () => {
         const { issueId } = await newIssue('Reference shape', null);
         const issue = await loadIssue(sql, issueId);
         assert.match(issue.reference, /^RUN-\d+$/);
         assert.equal(issue.title, 'Reference shape');
      });

      test('an issue that does not exist is named in the error', async () => {
         const missing = randomUUID();
         await assert.rejects(loadIssue(sql, missing), new RegExp(missing));
      });
   }
);
