import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_GITHUB_SETTINGS, type GitHubSettings } from './github-settings.ts';
import { GitHubEvents, parseCheck, parsePullRequest, type GitHubEventDeps } from './github-events.ts';
import type { CheckInput, PullRequestInput } from './pull-requests.ts';

/**
 * Routing a verified GitHub webhook to the workspace that installed the App.
 *
 * Offline, with fakes: the guarantees here are about which workspace a payload
 * is applied to and whether the switches are honoured, and those are decisions
 * made before any SQL runs.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

interface Calls {
   upserts: Array<{ workspaceId: string; pr: PullRequestInput }>;
   links: Array<{ workspaceId: string; autoLink: boolean }>;
   closes: string[];
   checks: CheckInput[];
   published: Array<{ issueIds: readonly string[]; pullRequestId: string | null }>;
   removed: number[];
   connections: string[];
}

function harness(
   options: { installed?: boolean; settings?: Partial<GitHubSettings>; stale?: boolean } = {}
): { events: GitHubEvents; calls: Calls } {
   const calls: Calls = {
      upserts: [],
      links: [],
      closes: [],
      checks: [],
      published: [],
      removed: [],
      connections: [],
   };
   const deps: GitHubEventDeps = {
      workspaceForInstallation: async (id) => (options.installed === false || id !== 7 ? null : WORKSPACE),
      settings: { get: async () => ({ ...DEFAULT_GITHUB_SETTINGS, ...options.settings }) },
      pullRequests: {
         upsertPullRequest: async (workspaceId, pr) => {
            calls.upserts.push({ workspaceId, pr });
            return { id: 'pr-row', stale: options.stale === true };
         },
         linkIssues: async (workspaceId, _id, _pr, link) => {
            calls.links.push({ workspaceId, autoLink: link.autoLink });
            return ['issue-a'];
         },
         closeLinkedIssues: async (_workspaceId, pullRequestId) => {
            calls.closes.push(pullRequestId);
            return ['issue-a'];
         },
         upsertCheck: async (_workspaceId, check) => {
            calls.checks.push(check);
            return ['issue-b'];
         },
         publishUpdated: async (_workspaceId, issueIds, pullRequestId) => {
            calls.published.push({ issueIds, pullRequestId });
         },
      },
      removeInstallation: async (id) => {
         calls.removed.push(id);
         return id === 7 ? WORKSPACE : null;
      },
      publishConnection: async (workspaceId) => {
         calls.connections.push(workspaceId);
      },
   };
   return { events: new GitHubEvents(deps), calls };
}

function pullRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
   return {
      action: 'opened',
      installation: { id: 7 },
      repository: { id: 42, full_name: 'acme/api' },
      pull_request: {
         id: 1001,
         number: 5,
         title: 'ABC-1 tidy',
         html_url: 'https://github.com/acme/api/pull/5',
         state: 'open',
         draft: false,
         merged: false,
         merged_at: null,
         closed_at: null,
         updated_at: '2026-09-10T10:00:00Z',
         body: 'Fixes ABC-1',
         head: { ref: 'feature/abc-1', sha: 'abc123' },
         user: { login: 'octo' },
         ...overrides,
      },
   };
}

describe('which GitHub events are ours', () => {
   test('pull requests, checks and installations; not pushes', () => {
      const { events } = harness();
      for (const event of ['pull_request', 'check_run', 'check_suite', 'installation']) {
         assert.equal(events.handles(event), true, event);
      }
      assert.equal(events.handles('push'), false);
   });
});

describe('a pull request event', () => {
   test('from an installation no workspace owns changes nothing', async () => {
      const { events, calls } = harness({ installed: false });
      const result = await events.apply('pull_request', pullRequestPayload());
      assert.equal(result.applied, false);
      assert.equal(calls.upserts.length, 0);
   });

   test('with no installation at all changes nothing', async () => {
      const { events, calls } = harness();
      const payload = pullRequestPayload();
      delete payload.installation;
      assert.equal((await events.apply('pull_request', payload)).applied, false);
      assert.equal(calls.upserts.length, 0);
   });

   test('with the master switch off changes nothing', async () => {
      const { events, calls } = harness({ settings: { enabled: false } });
      const result = await events.apply('pull_request', pullRequestPayload());
      assert.equal(result.applied, false);
      assert.equal(calls.upserts.length, 0);
   });

   test('is recorded against the installing workspace, linked, and published', async () => {
      const { events, calls } = harness({ settings: { autoLinkPullRequests: false } });
      const result = await events.apply('pull_request', pullRequestPayload());
      assert.equal(result.applied, true);
      assert.equal(calls.upserts[0]?.workspaceId, WORKSPACE);
      assert.deepEqual(calls.links, [{ workspaceId: WORKSPACE, autoLink: false }]);
      assert.equal(calls.closes.length, 0, 'an open pull request closes nothing');
      assert.deepEqual(calls.published, [{ issueIds: ['issue-a'], pullRequestId: 'pr-row' }]);
   });

   test('a merge asks for the linked issues it closes to be moved', async () => {
      const { events, calls } = harness();
      await events.apply(
         'pull_request',
         pullRequestPayload({ state: 'closed', merged: true, merged_at: '2026-09-10T11:00:00Z' })
      );
      assert.deepEqual(calls.closes, ['pr-row']);
   });

   test('a late, older delivery does not close anything', async () => {
      const { events, calls } = harness({ stale: true });
      await events.apply('pull_request', pullRequestPayload({ state: 'closed', merged: true }));
      assert.equal(calls.closes.length, 0);
   });

   test('a payload that is not a pull request is ignored', async () => {
      const { events, calls } = harness();
      const result = await events.apply('pull_request', { installation: { id: 7 } });
      assert.equal(result.applied, false);
      assert.equal(calls.upserts.length, 0);
   });
});

describe('a check event', () => {
   test('a check run is recorded and the affected issues are told', async () => {
      const { events, calls } = harness();
      const result = await events.apply('check_run', {
         installation: { id: 7 },
         repository: { id: 42 },
         check_run: {
            id: 55,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            head_sha: 'abc123',
            html_url: 'https://github.com/acme/api/runs/55',
         },
      });
      assert.equal(result.applied, true);
      assert.equal(calls.checks[0]?.kind, 'run');
      assert.equal(calls.checks[0]?.conclusion, 'failure');
      assert.deepEqual(calls.published, [{ issueIds: ['issue-b'], pullRequestId: null }]);
   });

   test('with the master switch off a check is not recorded', async () => {
      const { events, calls } = harness({ settings: { enabled: false } });
      await events.apply('check_suite', {
         installation: { id: 7 },
         repository: { id: 42 },
         check_suite: { id: 66, head_sha: 'abc123', status: 'queued', conclusion: null },
      });
      assert.equal(calls.checks.length, 0);
   });
});

describe('an installation event', () => {
   test('an uninstall on GitHub forgets the installation and says so', async () => {
      const { events, calls } = harness({ settings: { enabled: false } });
      const result = await events.apply('installation', { action: 'deleted', installation: { id: 7 } });
      assert.equal(result.applied, true);
      assert.deepEqual(calls.removed, [7]);
      assert.deepEqual(calls.connections, [WORKSPACE]);
   });

   test('other installation actions change nothing', async () => {
      const { events, calls } = harness();
      await events.apply('installation', { action: 'created', installation: { id: 7 } });
      assert.equal(calls.removed.length, 0);
   });
});

describe('reading GitHub payloads', () => {
   test('a pull request maps its state, draft flag and head', () => {
      const merged = parsePullRequest(pullRequestPayload({ state: 'closed', merged: true }));
      assert.equal(merged?.state, 'merged');
      assert.equal(merged?.repoId, 42);
      assert.equal(merged?.headRef, 'feature/abc-1');
      const draft = parsePullRequest(pullRequestPayload({ draft: true }));
      assert.equal(draft?.state, 'draft');
      assert.equal(draft?.draft, true);
   });

   test('a check suite takes its name from the app that ran it', () => {
      const check = parseCheck('check_suite', {
         repository: { id: 42 },
         check_suite: { id: 66, head_sha: 'abc', status: 'completed', conclusion: 'success', app: { name: 'CI' } },
      });
      assert.equal(check?.kind, 'suite');
      assert.equal(check?.name, 'CI');
   });

   test('a check without a head commit is refused', () => {
      assert.equal(parseCheck('check_run', { repository: { id: 42 }, check_run: { id: 1 } }), null);
   });
});
