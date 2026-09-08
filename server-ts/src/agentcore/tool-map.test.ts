import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolUnavailableError } from './errors.ts';
import type { ToolDefinition } from './gateway-client.ts';
import { missingRequired, resolveTools } from './tool-map.ts';

/**
 * Matching Berry's capabilities to whatever a gateway happens to call its tools.
 *
 * These are the tests that stand in for discovery against a real gateway: the
 * naming conventions below are the ones AgentCore targets actually produce
 * from an OpenAPI or Smithy target, and Berry has to work against all of them
 * without a name compiled in anywhere.
 */

function tools(...names: string[]): ToolDefinition[] {
   return names.map((name) => ({ name, description: '', inputSchema: {} }));
}

test('a double-underscore target prefix is seen through', () => {
   const resolved = resolveTools(tools('github___create_issue', 'github___get_repository'));
   assert.equal(resolved.require('createIssue'), 'github___create_issue');
   assert.equal(resolved.require('getRepository'), 'github___get_repository');
});

test('camelCase names resolve the same way', () => {
   const resolved = resolveTools(tools('createIssue', 'getRepository', 'createPullRequest'));
   assert.equal(resolved.require('createIssue'), 'createIssue');
   assert.equal(resolved.require('createPullRequest'), 'createPullRequest');
});

test('dotted names resolve the same way', () => {
   const resolved = resolveTools(tools('github.issue.create', 'github.repository.get'));
   assert.equal(resolved.require('createIssue'), 'github.issue.create');
   assert.equal(resolved.require('getRepository'), 'github.repository.get');
});

test('creating an issue is not confused with commenting on one', () => {
   // The mistake this would otherwise make on nearly every real gateway: a
   // comment tool contains both "create" and "issue".
   const resolved = resolveTools(tools('create_issue_comment', 'create_issue'));
   assert.equal(resolved.require('createIssue'), 'create_issue');
});

test('an issue tool never claims a pull request', () => {
   const resolved = resolveTools(tools('create_pull_request_issue_link', 'create_issue'));
   assert.equal(resolved.require('createIssue'), 'create_issue');
});

test('the plainest name wins over a longer variant', () => {
   const resolved = resolveTools(tools('create_issue_from_template', 'create_issue'));
   assert.equal(resolved.require('createIssue'), 'create_issue');
});

test('a review tool is not mistaken for a pull request tool', () => {
   const resolved = resolveTools(tools('create_pull_request', 'create_pull_request_review'));
   assert.equal(resolved.require('createPullRequest'), 'create_pull_request');
});

test('an explicit override beats the matching outright', () => {
   // An operator who names a tool has settled the question.
   const resolved = resolveTools(tools('create_issue', 'make_a_ticket'), {
      createIssue: 'make_a_ticket',
   });
   assert.equal(resolved.require('createIssue'), 'make_a_ticket');
});

test('an override naming a tool the gateway lacks does not silently fall through', () => {
   // A typo in a mapping must not be indistinguishable from a missing tool.
   const resolved = resolveTools(tools('create_issue'), { createIssue: 'typo_tool' });
   const problems = (resolved as unknown as { problems?: string[] }).problems ?? [];
   assert.ok(problems.some((p) => p.includes('typo_tool')), 'the bad override should be reported');
});

test('a capability the gateway lacks is a named failure, not a silent null', () => {
   const resolved = resolveTools(tools('get_repository'));
   assert.throws(() => resolved.require('createIssue'), (error: ToolUnavailableError) => {
      assert.equal(error.capability, 'createIssue');
      // The message lists what the gateway did offer, because "no tool" and
      // "the wrong tools" need different fixes.
      assert.match(error.message, /get_repository/);
      return true;
   });
});

test('the required set is what Berry cannot work without', () => {
   const bare = resolveTools(tools('list_branches'));
   assert.deepEqual(missingRequired(bare), [
      'getRepository',
      'createIssue',
      'updateIssue',
      'createMilestone',
      'createPullRequest',
   ]);
});

test('a gateway serving everything reports nothing missing', () => {
   const resolved = resolveTools(
      tools(
         'get_repository',
         'create_issue',
         'update_issue',
         'create_milestone',
         'create_pull_request'
      )
   );
   assert.deepEqual(missingRequired(resolved), []);
});

test('an empty gateway is reported as empty rather than crashing', () => {
   const resolved = resolveTools([]);
   assert.deepEqual(resolved.available(), []);
   assert.deepEqual(resolved.tools(), []);
   assert.throws(() => resolved.require('createIssue'), ToolUnavailableError);
});
