import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runtimeSessionId } from '../execution/agentcore-runtime.ts';
import { runtimeSessionIdFor, sessionKeyFor } from './session-id.ts';

const agentId = 'a0000000-0000-4000-8000-000000000001';
const issueId = 'b0000000-0000-4000-8000-000000000002';

test('the session is the (agent, issue) pair, not the run', () => {
   const first = runtimeSessionIdFor(sessionKeyFor({ kind: 'agent', runId: 'r1', agentId, issueId }));
   const second = runtimeSessionIdFor(sessionKeyFor({ kind: 'agent', runId: 'r2', agentId, issueId }));
   assert.equal(first, second);
});

test('the id is berry- plus sha256(agentId:issueId), long enough for AgentCore', () => {
   const id = runtimeSessionIdFor(sessionKeyFor({ kind: 'agent', runId: 'r1', agentId, issueId }));
   const expected = `berry-${createHash('sha256').update(`${agentId}:${issueId}`).digest('hex')}`;
   assert.equal(id, expected);
   assert.ok(id.length >= 33);
});

test('another issue, another agent, or a chat is another session', () => {
   const base = sessionKeyFor({ kind: 'agent', runId: 'r', agentId, issueId });
   assert.notEqual(base, sessionKeyFor({ kind: 'agent', runId: 'r', agentId, issueId: 'other' }));
   assert.notEqual(base, sessionKeyFor({ kind: 'agent', runId: 'r', agentId: 'other', issueId }));
   assert.notEqual(
      base,
      sessionKeyFor({ kind: 'agent', runId: 'r', agentId, chatSessionId: issueId })
   );
});

test('completion tasks get a fresh session per run', () => {
   const one = sessionKeyFor({ kind: 'completion', runId: 'r1', agentId, issueId });
   const two = sessionKeyFor({ kind: 'completion', runId: 'r2', agentId, issueId });
   assert.notEqual(runtimeSessionIdFor(one), runtimeSessionIdFor(two));
});

test('an agent task with neither issue nor chat cannot name a session', () => {
   assert.throws(() => sessionKeyFor({ kind: 'agent', runId: 'r', agentId }), /issue or a chat/);
});

test('the AgentCore driver derives its id the same way', () => {
   assert.equal(runtimeSessionId('x:y'), runtimeSessionIdFor('x:y'));
});
