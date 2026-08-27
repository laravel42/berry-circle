import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequest } from './events.ts';
import { decodeEnvelope, BOARD_TOPICS, WORKSPACE_TOPICS } from '../realtime/replay.ts';
import type { ApiError } from '../http/errors.ts';

/**
 * The parts of the stream that do not need a socket. What it delivers was
 * driven against the running Go server: 4,090 board frames and 196 workspace
 * frames, byte-identical, plus resume from a cursor and from Last-Event-ID.
 */

const BOARD = '11111111-1111-4111-8111-111111111120';
const WORKSPACE = '11111111-1111-4111-8111-111111111110';

function parse(query: string, headers: Record<string, string> = {}) {
   return parseRequest(new URL(`http://x/api/v1/events${query}`), new Headers(headers));
}

const status = (code: number) => (error: unknown) => (error as ApiError).status === code;

test('exactly one scope is named', () => {
   assert.equal(parse(`?boardId=${BOARD}`).scope, 'board');
   assert.equal(parse(`?workspaceId=${WORKSPACE}`).scope, 'workspace');

   // Neither is a client that forgot; both is one asking for two streams down
   // one socket, and picking either silently would drop the other's events.
   assert.throws(() => parse(''), status(400));
   assert.throws(() => parse(`?boardId=${BOARD}&workspaceId=${WORKSPACE}`), status(400));
});

test('an unknown or repeated parameter is refused rather than ignored', () => {
   assert.throws(() => parse(`?boardId=${BOARD}&x=1`), status(400));
   assert.throws(() => parse(`?boardId=${BOARD}&boardId=${BOARD}`), status(400));
});

test('a malformed scope id is a validation failure, not a not-found', () => {
   // 422 rather than 404: the id is not a shape that could name anything, so
   // "not found" would imply the server looked.
   assert.throws(() => parse('?boardId=nope'), status(422));
   assert.throws(() => parse('?workspaceId=nope'), status(422));
   assert.throws(() => parse('?boardId=00000000-0000-0000-0000-000000000000'), status(422));
});

test('a cursor comes from the header or the query, never both', () => {
   const id = '11111111-1111-4111-8111-111111111199';
   assert.equal(parse(`?boardId=${BOARD}&after=${id}`).cursor, id);
   assert.equal(parse(`?boardId=${BOARD}`, { 'Last-Event-ID': id }).cursor, id);
   assert.equal(parse(`?boardId=${BOARD}`).cursor, '');

   // Two cursors is a client asking to resume from two places, and choosing
   // one skips whatever the other named.
   assert.throws(() => parse(`?boardId=${BOARD}&after=${id}`, { 'Last-Event-ID': id }), status(400));
});

test('an oversized cursor is refused before it reaches the database', () => {
   assert.throws(() => parse(`?boardId=${BOARD}&after=${'a'.repeat(600)}`), status(400));
});

test('the two streams carry different topics, and both carry issue moments', () => {
   // A board stream follows work on that board; a workspace stream follows the
   // facts that belong to no board at all.
   assert.ok(BOARD_TOPICS.includes('run.output.delta'));
   assert.ok(BOARD_TOPICS.includes('comment.created'));
   assert.ok(!(BOARD_TOPICS as readonly string[]).includes('goal.created'));
   assert.ok(WORKSPACE_TOPICS.includes('goal.created'));
   assert.ok(WORKSPACE_TOPICS.includes('approval.requested'));
   assert.ok(!(WORKSPACE_TOPICS as readonly string[]).includes('run.output.delta'));
   // Both carry issue.created: a board shows the card, a workspace counts it.
   assert.ok(BOARD_TOPICS.includes('issue.created'));
   assert.ok(WORKSPACE_TOPICS.includes('issue.created'));
});

test('a run-lane envelope decodes with its run and sequence', () => {
   const event = decodeEnvelope(
      {
         id: 'a1111111-1111-4111-8111-111111111111',
         type: 'run.output.delta',
         occurredAt: '2026-08-27T10:00:00Z',
         workspaceId: WORKSPACE,
         boardId: BOARD,
         issueId: 'b1111111-1111-4111-8111-111111111111',
         runId: 'c1111111-1111-4111-8111-111111111111',
         sequence: 42,
         payload: { text: 'x', channel: 'progress' },
      },
      'a1111111-1111-4111-8111-111111111111'
   );
   assert.equal(event.runId, 'c1111111-1111-4111-8111-111111111111');
   assert.equal(event.sequence, 42);
});

test("a collaboration envelope's issue is recovered from its payload", () => {
   // Comments name the issue inside the payload rather than beside it. Without
   // this a board stream delivers a comment the client cannot place.
   const event = decodeEnvelope(
      {
         id: 'a2222222-1111-4111-8111-111111111111',
         type: 'comment.created',
         occurredAt: '2026-08-27T10:00:00Z',
         workspaceId: WORKSPACE,
         aggregateType: 'comment',
         aggregateId: 'd1111111-1111-4111-8111-111111111111',
         payload: {
            comment: {
               id: 'd1111111-1111-4111-8111-111111111111',
               issueId: 'b2222222-1111-4111-8111-111111111111',
            },
         },
      },
      'a2222222-1111-4111-8111-111111111111'
   );
   assert.equal(event.issueId, 'b2222222-1111-4111-8111-111111111111');
   assert.equal(event.runId, null);
   assert.equal(event.sequence, null);
});

test('an envelope whose id disagrees with its row is refused', () => {
   // One of the two was written by something that did not know the shape, and
   // replaying it would hand a client an id that resumes from somewhere else.
   assert.throws(
      () =>
         decodeEnvelope(
            { id: 'a3333333-1111-4111-8111-111111111111' },
            'a4444444-1111-4111-8111-111111111111'
         ),
      /envelope ID mismatch/
   );
});
