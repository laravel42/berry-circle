import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceControlConflictError } from '../agentcore/errors.ts';
import type { AgentCoreGatewayClient, ToolDefinition } from '../agentcore/gateway-client.ts';
import { resolveTools } from '../agentcore/tool-map.ts';
import { AgentCoreGitHubProvider } from './agentcore-github-provider.ts';
import { ScmError } from './provider.ts';

/**
 * GitHub through the gateway, with AgentCore mocked at the transport.
 *
 * The domain is not mocked: this drives the real provider, the real tool
 * resolution and the real argument shaping, and fakes only `callTool` — which
 * is the boundary the migration brief asks for.
 */

function tool(name: string, properties: string[]): ToolDefinition {
   return {
      name,
      description: '',
      inputSchema: {
         type: 'object',
         properties: Object.fromEntries(properties.map((p) => [p, { type: 'string' }])),
      },
   };
}

const GITHUB_TOOLS = [
   tool('github___get_repository', ['owner', 'repo']),
   tool('github___create_issue', ['owner', 'repo', 'title', 'body', 'milestone', 'labels']),
   tool('github___update_issue', ['owner', 'repo', 'issue_number', 'title', 'body', 'state']),
   tool('github___create_milestone', ['owner', 'repo', 'title', 'description', 'due_on', 'state']),
   tool('github___create_pull_request', ['owner', 'repo', 'title', 'body', 'head', 'base']),
   tool('github___list_pull_requests', ['owner', 'repo', 'head', 'state']),
];

function provider(
   answers: Record<string, unknown | (() => unknown)>,
   tools: ToolDefinition[] = GITHUB_TOOLS
) {
   const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
   const gateway = {
      async callTool(name: string, args: Record<string, unknown>) {
         calls.push({ name, args });
         const answer = answers[name];
         if (typeof answer === 'function') return (answer as () => unknown)();
         return answer ?? {};
      },
   } as unknown as AgentCoreGatewayClient;

   return {
      calls,
      github: new AgentCoreGitHubProvider({
         gateway,
         tools: resolveTools(tools),
         definitions: new Map(tools.map((t) => [t.name, t])),
         gitCredential: async () => ({ username: 'x-access-token', password: 'ghs_from_identity' }),
      }),
   };
}

const REPO = { owner: 'acme', name: 'atlas' };

test('a capability is called by the tool the gateway actually exposes', async () => {
   const p = provider({
      github___create_issue: { id: 1, number: 7, title: 'Wire it', html_url: 'https://gh/7' },
   });
   const issue = await p.github.createIssue(REPO, { title: 'Wire it' });

   assert.equal(p.calls[0]?.name, 'github___create_issue');
   assert.equal(issue.number, 7);
});

test('arguments are named the way the tool declares them', async () => {
   // `milestoneNumber` is Berry's word; this tool calls it `milestone`.
   const p = provider({ github___create_issue: { id: 1, number: 7 } });
   await p.github.createIssue(REPO, { title: 'T', milestoneId: 4, labels: ['bug'] });

   assert.deepEqual(p.calls[0]?.args, {
      owner: 'acme',
      repo: 'atlas',
      title: 'T',
      milestone: 4,
      labels: ['bug'],
   });
});

test('a field the tool does not accept is dropped, not sent', async () => {
   // Sending an undeclared field is how a whole call gets refused for
   // something nobody needed.
   const p = provider({ github___update_issue: { id: 1, number: 7 } });
   await p.github.updateIssue(REPO, 7, { title: 'T', assignees: ['someone'] });

   assert.ok(!('assignees' in (p.calls[0]?.args ?? {})));
   assert.equal(p.calls[0]?.args.issue_number, 7);
});

test('a field left undefined is omitted rather than nulled', async () => {
   // A PATCH that sends every field would overwrite whatever somebody set on
   // GitHub, which is the loop this integration works to avoid.
   const p = provider({ github___update_issue: { id: 1, number: 7 } });
   await p.github.updateIssue(REPO, 7, { state: 'closed' });

   assert.deepEqual(p.calls[0]?.args, { owner: 'acme', repo: 'atlas', issue_number: 7, state: 'closed' });
});

test('a response is read whatever the target calls its fields', async () => {
   const p = provider({
      github___get_repository: { id: 9, name: 'atlas', owner: { login: 'acme' }, defaultBranch: 'trunk' },
   });
   const repo = await p.github.getRepository(REPO);

   assert.equal(repo.id, 9);
   assert.equal(repo.defaultBranch, 'trunk');
   assert.equal(repo.fullName, 'acme/atlas');
});

test('a wrapped resource is unwrapped', async () => {
   const p = provider({ github___get_repository: { result: { id: 9, name: 'atlas', owner: { login: 'acme' } } } });
   assert.equal((await p.github.getRepository(REPO)).id, 9);
});

test('a duplicate pull request returns the existing one rather than failing', async () => {
   // A retried delivery must not fail because the previous attempt succeeded.
   const p = provider({
      github___create_pull_request: () => {
         throw new SourceControlConflictError('A pull request already exists');
      },
      github___list_pull_requests: [
         { id: 5, number: 12, state: 'open', head: { ref: 'berry/42' }, base: { ref: 'main' } },
      ],
   });
   const pull = await p.github.openPullRequest(REPO, { title: 'W', head: 'berry/42', base: 'main' });

   assert.equal(pull.number, 12);
   assert.equal(pull.created, false);
});

test('a conflict with no existing pull request is still a failure', async () => {
   const p = provider({
      github___create_pull_request: () => {
         throw new SourceControlConflictError('something else entirely');
      },
      github___list_pull_requests: [],
   });
   await assert.rejects(
      p.github.openPullRequest(REPO, { title: 'W', head: 'berry/42', base: 'main' }),
      SourceControlConflictError
   );
});

test('a merged pull request is reported merged from merged_at alone', async () => {
   const p = provider({
      github___list_pull_requests: [
         { number: 3, state: 'closed', merged_at: '2026-01-01T00:00:00Z', head: { ref: 'b' }, base: { ref: 'main' } },
      ],
   });
   assert.equal((await p.github.findPullRequest(REPO, 'b'))?.merged, true);
});

test('a capability the gateway lacks fails by name', async () => {
   const p = provider({}, [tool('github___get_repository', ['owner', 'repo'])]);
   await assert.rejects(p.github.createIssue(REPO, { title: 'T' }), /createIssue/);
});

test('an absent optional capability degrades rather than throwing', async () => {
   // Without a review tool Berry simply has no reviews to show; that is a
   // thinner page, not a broken run.
   const p = provider({}, [tool('github___get_repository', ['owner', 'repo'])]);
   assert.deepEqual(await p.github.listReviews(REPO, 1), []);
});

test('deleting a repository is refused without reaching the gateway', async () => {
   const p = provider({});
   await assert.rejects(p.github.deleteRepository(), ScmError);
   assert.equal(p.calls.length, 0);
});

test('the git credential comes from Identity, not from the gateway', async () => {
   // git is a wire protocol; no tool call can hand a repository to `git clone`.
   const p = provider({});
   assert.deepEqual(await p.github.runCredential(), {
      username: 'x-access-token',
      password: 'ghs_from_identity',
   });
   assert.equal(p.calls.length, 0);
});
