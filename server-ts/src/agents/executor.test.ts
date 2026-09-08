import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResultText, splitUtf8, toAgentName } from './executor.ts';
import { commentBody, truncateUtf8 } from '../runs/result-comment.ts';
import { buildMessage } from './prompt.ts';

/**
 * The parts of the executor that do not need a model or a database. What it
 * does with a real agent, real tools and a real ledger was driven end to end
 * against Bedrock, PostgreSQL and MinIO together.
 */

const dispatch = {
   runId: 'run',
   issueId: 'issue',
   boardId: 'board',
   workspaceId: 'workspace',
   agentId: 'agent',
   issueTitle: 'Write the release note',
   issueDescription: 'Cover the ledger change.',
   issueIdentifier: 'BER-42',
   instructions: null,
   repository: '',
   requestId: '',
   traceParent: '',
};

test('the result is the last substantive turn, not the last thing said', () => {
   // The failure this encodes: an agent's closing line after a long answer is
   // usually a sign-off, and recording it lost the answer it followed.
   const result = new ResultText();
   result.append('I will look into this.');
   result.endTurn();
   result.append('x'.repeat(500));
   result.endTurn();
   result.append('Let me know if you need anything else.');
   result.endTurn();

   assert.equal(result.final()[0], 'x'.repeat(500));
});

test('a turn that says nothing leaves the result alone', () => {
   // A bare tool call is a turn with no text; treating it as the final message
   // would report emptiness for a run that had produced an answer.
   const result = new ResultText();
   result.append('The answer is 42, and here is why: ' + 'y'.repeat(400));
   result.endTurn();
   result.endTurn();
   result.endTurn();

   assert.match(result.final()[0], /^The answer is 42/);
});

test('when nothing was substantive, the last thing said is the result', () => {
   const result = new ResultText();
   result.append('Short but complete.');
   result.endTurn();
   assert.equal(result.final()[0], 'Short but complete.');
});

test('an empty run reports nothing rather than something', () => {
   const result = new ResultText();
   result.endTurn();
   assert.deepEqual(result.final(), ['', false]);
});

test('a delta is split on character boundaries, never mid-sequence', () => {
   // A cut sequence reaches the browser as a replacement character in the
   // middle of a word.
   const pieces = splitUtf8('héllo wörld — em dash', 8);
   assert.equal(pieces.join(''), 'héllo wörld — em dash');
   for (const piece of pieces) {
      assert.ok(Buffer.byteLength(piece, 'utf8') <= 8, JSON.stringify(piece));
      assert.ok(!piece.includes('�'), JSON.stringify(piece));
   }
});

test('text that fits is one piece, and empty text is none', () => {
   assert.deepEqual(splitUtf8('short', 64), ['short']);
   assert.deepEqual(splitUtf8('', 64), []);
});

test('truncation cuts on a character boundary and keeps whole characters', () => {
   // 'é' is two bytes: a budget of 3 keeps one and drops the half of the next.
   assert.equal(truncateUtf8('éé', 3), 'é');
   // A budget landing exactly on a boundary keeps the character, rather than
   // stripping it as a stray continuation byte.
   assert.equal(truncateUtf8('éé', 4), 'éé');
   assert.equal(truncateUtf8('ascii', 99), 'ascii');
   assert.equal(truncateUtf8('é', 1), '');
});

test('a bounded comment says it was cut', () => {
   const long = 'x'.repeat(200_000);
   const body = commentBody(long, false);
   assert.ok(Buffer.byteLength(body, 'utf8') <= 100_000);
   assert.match(body, /Truncated by Berry/);
   // A report already cut upstream is marked even when it now fits, because
   // the reader is being shown less than the agent wrote either way.
   assert.match(commentBody('short', true), /Truncated by Berry/);
   assert.equal(commentBody('short', false), 'short');
});

test('an agent name becomes an identifier without being rejected', () => {
   assert.equal(toAgentName('Prototype Writer'), 'prototype_writer');
   assert.equal(toAgentName('QA / Review'), 'qa_review');
   assert.equal(toAgentName('  '), 'agent');
   assert.equal(toAgentName('日本語'), 'agent');
});

test('the prompt carries the task and ends with the contracts', () => {
   const message = buildMessage(dispatch);
   assert.match(message, /^Berry issue BER-42\n\nTitle: Write the release note/);
   assert.match(message, /Description:\nCover the ledger change\./);
   assert.match(message, /Reporting your result/);
   // No repository means no delivery contract: telling an agent how to hand
   // back code it was not asked to write is noise it has to read.
   assert.doesNotMatch(message, /Delivering your work/);
   // The contracts describe the tools that exist, not the old output directory.
   assert.match(message, /write_file/);
   assert.doesNotMatch(message, /output\//);
});

test('a repository run is told how its files are delivered', () => {
   const message = buildMessage({ ...dispatch, repository: 'berry/circle' });
   assert.match(message, /Repository: berry\/circle/);
   assert.match(message, /Delivering your work/);
});

test('a rejected task carries the review that sent it back', () => {
   const message = buildMessage({ ...dispatch, reviewFeedback: 'The tests are missing.' });
   assert.match(message, /already worked once and sent back/);
   assert.match(message, /The tests are missing\./);
   // Files from the earlier attempt survive now that artifacts are shared, so
   // the agent is told to read them rather than to start again.
   assert.match(message, /list_files/);
});

test('the contracts survive a description long enough to fill the prompt', () => {
   // The cap cuts from the tail, so without reserved room the contracts —
   // which go last — would be the first thing dropped.
   const message = buildMessage({ ...dispatch, issueDescription: 'z'.repeat(200_000) });
   assert.ok(Buffer.byteLength(message, 'utf8') <= 64 * 1024);
   assert.match(message, /Reporting your result/);
});
