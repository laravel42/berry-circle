import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { RunLedger } from '../runs/ledger.ts';
import {
   deliverRepository,
   insideRepository,
   loadIssue,
   prepareRepository,
   pullRequestBody,
   type RepositoryRunDeps,
} from './repository-run.ts';
import { ConnectionUnavailable, type ConnectionRepository } from '../integrations/connections.ts';
import { GitHubError, type GitHubClient, type PullRequest, type Repository } from '../integrations/github.ts';
import { CheckoutFailed } from './checkout.ts';
import type { ExecResult, ExecutionSession } from '../execution/driver.ts';
import { DEFAULT_PERMISSIONS, PermissionDenied, permissionsOf } from './permissions.ts';

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
      let openedBodies: string[] = [];
      let commands: Array<{ command: string; env: Record<string, string> | undefined }> = [];
      let writes: Array<{ path: string; content: string }> = [];
      let outputs: string[] = [];

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
               // A file write is now bytes through the shell: `... | base64 -d > 'path'`.
               // Recorded as a write, ordered with the commands, so a test can
               // still say "before git add".
               const written = /base64 -d >>? '((?:[^']|'\\'')+)'$/.exec(command);
               if (written) {
                  const path = written[1]!.replaceAll(`'\\''`, "'");
                  writes.push({ path, content: '' });
                  commands.push({ command: `write ${path}`, env: undefined });
                  return { stdout: '', stderr: '', exitCode: 0 } as ExecResult;
               }
               const match = Object.keys(results).find((key) => command.includes(key));
               return {
                  stdout: '',
                  stderr: '',
                  exitCode: 0,
                  ...(match ? results[match] : {}),
               } as ExecResult;
            },
            stream: () => ({ async *[Symbol.asyncIterator]() {} }),
            writeFile: async (path: string, content: string) => {
               writes.push({ path, content });
               // Ordered with the commands, so a test can say "before git add".
               commands.push({ command: `write ${path}`, env: undefined });
            },
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
               openPullRequest: async (input: { body: string }): Promise<PullRequest> => {
                  openedBodies.push(input.body);
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
         openedBodies = [];
         outputs = [];
         const ledger = {
            appendOutput: async (_id: string, _channel: string, text: string) =>
               void outputs.push(text),
            appendVerified: async (_id: string, p: object) =>
               void events.push({ type: 'verified', ...p }),
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
         repository: string | null,
         verifyCommands: string[] = []
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
               INSERT INTO projects (id, workspace_id, name, github_repo_full_name, github_repo_id,
                                     verify_commands, created_by)
               VALUES (${projectId}, ${fixture.workspaceId!}, ${`P${(repoId += 1)}`},
                       ${repository}, ${repoId}, ${verifyCommands}, ${fixture.userId!})`;
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
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
            session: async () => fakeSession(),
         });
         assert.equal(prepared, null);
         assert.deepEqual(events, []);
      });

      test('no substrate and no connection each mean no repository', async () => {
         const { dispatch } = await newIssue('Has a repo', 'berry/frontend');

         assert.equal(
            await prepareRepository(deps(), {
               dispatch,
               agentName: 'Forge',
               permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
               session: null,
            }),
            null
         );
         assert.equal(
            await prepareRepository(deps({ connections: undefined }), {
               dispatch,
               agentName: 'Forge',
               permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
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
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
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
               permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
               session: async () => fakeSession(),
            }),
            (error: GitHubError) => {
               assert.equal(error.status, 403);
               assert.equal(error.remedy, 'grant-access');
               return true;
            }
         );
      });

      test("the minter's own grant outranks the repository's permissions field", async () => {
         // GitHub computes `permissions` for a user and answers an App token
         // with all-false, so a credential that knows it was granted
         // `contents: write` must be believed over that field — and one that
         // knows it was not must be refused even when the field says yes.
         const { dispatch } = await newIssue('App credential', 'berry/frontend');
         const granted = deps({
            gitCredential: async () => ({ username: 'x-access-token', password: TOKEN, canPush: true }),
            github: fakeGitHub({ repository: { canPush: false } }),
         });
         const prepared = await prepareRepository(granted, {
            dispatch,
            agentName: 'Forge',
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
            session: async () => fakeSession(),
         });
         assert.ok(prepared, 'a credential granted write is enough to start');

         const { dispatch: second } = await newIssue('App credential, read only', 'berry/frontend');
         await assert.rejects(
            prepareRepository(
               deps({
                  gitCredential: async () => ({ username: 'x-access-token', password: TOKEN, canPush: false }),
                  github: fakeGitHub({ repository: { canPush: true } }),
               }),
               {
                  dispatch: second,
                  agentName: 'Forge',
                  permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
                  session: async () => fakeSession(),
               }
            ),
            (error: GitHubError) => error.remedy === 'grant-access'
         );
      });

      test('a missing credential stops the run rather than cloning anonymously', async () => {
         const { dispatch } = await newIssue('No credential', 'berry/frontend');
         await assert.rejects(
            prepareRepository(
               deps({ connections: fakeConnections(new ConnectionUnavailable('not connected', 'missing')) }),
               {
                  dispatch,
                  agentName: 'Forge',
                  permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
                  session: async () => fakeSession(),
               }
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
               permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
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
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
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
               // The gate is part of the record, not a separate lookup.
               mergeRequiresApproval: true,
            },
         ]);
      });

      test('files the agent saved are written into the checkout before the commit', async () => {
         // The contract tells the agent to save committable files with
         // write_file. Nothing used to carry them into the working tree, so a
         // compliant agent committed nothing and the run reported success.
         const { dispatch } = await newIssue('Bridge artifacts', 'berry/frontend');
         const collaborators = deps();
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         assert.ok(prepared);

         commands = [];
         writes = [];
         events = [];
         const saved: Record<string, string> = {
            'src/api/handler.go': 'package api\n',
            'docs/notes.md': '# notes\n',
            '../escape.txt': 'nope',
            '/etc/passwd': 'nope',
         };
         await deliverRepository(collaborators, {
            dispatch,
            prepared,
            session: fakeSession({
               numstat: { stdout: '1\t0\tsrc/api/handler.go\n1\t0\tdocs/notes.md\n' },
               'rev-parse': { stdout: 'a1b2c3d\n' },
            }),
            summary: 'Wrote the handler.',
            artifacts: {
               paths: async () => Object.keys(saved),
               read: async (path) => Buffer.from(saved[path]!),
            },
         });

         assert.deepEqual(
            writes.map((write) => write.path),
            [`${prepared.checkout.directory}/src/api/handler.go`, `${prepared.checkout.directory}/docs/notes.md`],
            'only paths inside the repository are written'
         );
         const firstWrite = commands.findIndex((entry) => entry.command.startsWith('write '));
         const add = commands.findIndex((entry) => entry.command === 'git add -A');
         assert.ok(firstWrite >= 0 && add > firstWrite, 'written before the tree is staged');
         assert.ok(
            outputs.some((text) => /Refused to write \.\.\/escape\.txt/.test(text)),
            'a refused path is said in the run log'
         );
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
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
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
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
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
         // Exactly three commands are trusted with it, and only through their
         // own env: the clone, the fetch that reads the branch the push leases
         // against, and the push.
         const trusted = commands.filter((call) => call.env?.BERRY_GIT_TOKEN).map((call) => call.command);
         assert.equal(trusted.length, 3, `commands given the credential: ${trusted.join(' | ')}`);
         assert.match(trusted[0]!, /^git -c credential\.helper='[^']*' clone /);
         assert.match(trusted[1]!, /^git -c credential\.helper='[^']*' fetch origin /);
         assert.match(trusted[2]!, /^git -c credential\.helper='[^']*' push --force-with-lease=/);
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

      test("a project's checks run before the push, and land in the pull request", async () => {
         const { dispatch } = await newIssue('Checked work', 'berry/frontend', [
            'pnpm lint',
            'pnpm test',
         ]);
         const collaborators = deps();
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         assert.ok(prepared);
         assert.deepEqual(prepared.repository.verifyCommands, ['pnpm lint', 'pnpm test']);

         events = [];
         commands = [];
         await deliverRepository(collaborators, {
            dispatch,
            prepared,
            session: fakeSession({
               'pnpm test': { exitCode: 1, stdout: '2 failed\n' },
               numstat: { stdout: '1\t0\ta.ts\n' },
               'rev-parse': { stdout: 'abc\n' },
            }),
            summary: 'Added the abort signal.',
         });

         const verified = events.find((event) => event.type === 'verified')!;
         assert.equal(verified.passed, false);
         assert.equal(events.indexOf(verified), 0);

         // Checks describe the tree being delivered, so they run before it is
         // committed rather than after.
         const ranAt = commands.findIndex((call) => call.command.includes('pnpm test'));
         const committedAt = commands.findIndex((call) => call.command.includes('git commit'));
         assert.ok(ranAt >= 0 && ranAt < committedAt, 'checks must run before the commit');

         // A failing check does not withhold the pull request — the reviewer is
         // the point, and they need to see it.
         const delivered = events.find((event) => event.type === 'delivered')!;
         assert.equal(delivered.committed, true);
         assert.ok(delivered.pullRequest);

         assert.match(openedBodies[0]!, /## Evidence/);
         assert.match(openedBodies[0]!, /Some checks did not pass/);
         assert.match(openedBodies[0]!, /`pnpm test` — failed \(exit 1\)/);
      });

      test('a project with no checks delivers without an evidence section', async () => {
         const { dispatch } = await newIssue('Unchecked', 'berry/frontend');
         const collaborators = deps();
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         events = [];
         await deliverRepository(collaborators, {
            dispatch,
            prepared: prepared!,
            session: fakeSession({
               numstat: { stdout: '1\t0\ta.ts\n' },
               'rev-parse': { stdout: 'abc\n' },
            }),
            summary: null,
         });

         assert.equal(
            events.find((event) => event.type === 'verified'),
            undefined
         );
         assert.doesNotMatch(openedBodies[0]!, /## Evidence/);
      });

      test('the pull request body puts the verdict where a reviewer looks first', () => {
         const body = pullRequestBody(
            'Added an abort signal.',
            {
               passed: true,
               complete: true,
               durationMs: 1000,
               results: [
                  {
                     command: 'pnpm test',
                     exitCode: 0,
                     passed: true,
                     durationMs: 900,
                     output: '',
                     error: null,
                  },
               ],
            },
            'run-1',
            'RUN-7'
         );
         assert.match(body, /^Added an abort signal\./);
         assert.match(body, /All checks passed\./);
         assert.match(body, /Berry run `run-1` · task RUN-7$/);
      });

      test('an agent that may not read the repository never gets a credential opened', async () => {
         // Checked before the token is decrypted, so a denied agent does not
         // cause a secret to be unsealed on its behalf.
         const { dispatch } = await newIssue('Denied read', 'berry/frontend');
         let opened = 0;
         const collaborators = deps({
            connections: {
               find: async () => null,
               token: async () => {
                  opened += 1;
                  return TOKEN;
               },
            } as unknown as ConnectionRepository,
         });

         await assert.rejects(
            prepareRepository(collaborators, {
               dispatch,
               agentName: 'Forge',
               permissions: permissionsOf(['run_commands'], 'Forge'),
               session: async () => fakeSession(),
            }),
            (error: PermissionDenied) => {
               assert.equal(error.name, 'PermissionDenied');
               assert.equal(error.permission, 'read_repository');
               return true;
            }
         );
         assert.equal(opened, 0, 'a credential was opened for a denied agent');
      });

      test('an agent may push its branch and still not open a pull request', async () => {
         // The push already happened — the work is not lost — but opening a
         // pull request is a separate act with its own permission.
         const { dispatch } = await newIssue('No PR permission', 'berry/frontend');
         const collaborators = deps();
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            permissions: permissionsOf(
               ['read_repository', 'create_branches', 'run_commands'],
               'Forge'
            ),
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         assert.ok(prepared);

         commands = [];
         await assert.rejects(
            deliverRepository(collaborators, {
               dispatch,
               prepared,
               session: fakeSession({
                  numstat: { stdout: '1\t0\ta.ts\n' },
                  'rev-parse': { stdout: 'abc\n' },
               }),
               summary: null,
            }),
            (error: PermissionDenied) => {
               assert.equal(error.permission, 'open_pull_requests');
               return true;
            }
         );
         assert.ok(
            commands.some((call) => call.command.includes('push')),
            'the branch should still have been pushed'
         );
      });

      test('the merge gate is recorded, and said in the pull request itself', async () => {
         // Nothing in Berry merges yet. Recording the gate now means whatever
         // does will read this rather than deciding for itself — and the
         // person looking at the pull request is told without having to know
         // Berry exists.
         const { dispatch } = await newIssue('Gated', 'berry/frontend');
         const collaborators = deps();
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            permissions: permissionsOf(DEFAULT_PERMISSIONS, 'Forge'),
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         events = [];
         await deliverRepository(collaborators, {
            dispatch,
            prepared: prepared!,
            session: fakeSession({
               numstat: { stdout: '1\t0\ta.ts\n' },
               'rev-parse': { stdout: 'abc\n' },
            }),
            summary: null,
         });

         assert.equal(events.find((e) => e.type === 'delivered')!.mergeRequiresApproval, true);
         assert.match(openedBodies[0]!, /needs a human approval before it merges/);
      });

      test('an agent trusted to merge is recorded as such, and the notice is dropped', async () => {
         const { dispatch } = await newIssue('Trusted', 'berry/frontend');
         const collaborators = deps();
         const trusted = permissionsOf([...DEFAULT_PERMISSIONS, 'merge_without_approval'], 'Forge');
         const prepared = await prepareRepository(collaborators, {
            dispatch,
            agentName: 'Forge',
            permissions: trusted,
            session: async () => fakeSession({ 'rev-parse': { stdout: 'base\n' } }),
         });
         events = [];
         await deliverRepository(collaborators, {
            dispatch,
            prepared: prepared!,
            session: fakeSession({
               numstat: { stdout: '1\t0\ta.ts\n' },
               'rev-parse': { stdout: 'abc\n' },
            }),
            summary: null,
         });

         assert.equal(events.find((e) => e.type === 'delivered')!.mergeRequiresApproval, false);
         assert.doesNotMatch(openedBodies[0]!, /needs a human approval/);
      });
   }
);

test('a path is inside the repository or it is refused', () => {
   assert.equal(insideRepository('src/a.ts'), 'src/a.ts');
   assert.equal(insideRepository('./src//a.ts'), 'src/a.ts');
   assert.equal(insideRepository('docs\\notes.md'), 'docs/notes.md');
   assert.equal(insideRepository('../escape.txt'), null);
   assert.equal(insideRepository('src/../../escape.txt'), null);
   assert.equal(insideRepository('/etc/passwd'), null);
   assert.equal(insideRepository('C:/x'), null);
   assert.equal(insideRepository(''), null);
   assert.equal(insideRepository('.'), null);
});
