import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEnvelopeForTest, encodeEnvelopeForTest } from './relay.ts';

/**
 * Envelopes captured verbatim off the shared stream.
 *
 * Every node publishes into one stream, so an envelope a node cannot read is
 * an event that node's clients never see. These were checked live in both
 * directions: captured bytes decoded here, and bytes published from here
 * decoded by another node.
 */
const CAPTURED_ENVELOPES: Record<string, string> = {
   'nested payload': String.raw`{"version":1,"nodeId":"node-go","event":{"id":"evt-3","workspaceId":"ws-1","type":"issue.created","payload":{"z":1,"a":{"b":[1,2]}},"occurredAt":"2026-08-27T06:30:00.123456789Z"}}`,
   'no board': String.raw`{"version":1,"nodeId":"node-go","event":{"id":"evt-2","workspaceId":"ws-1","type":"run.started","payload":null,"occurredAt":"2026-08-27T06:30:00.123456789Z"}}`,
   'with board': String.raw`{"version":1,"nodeId":"node-go","event":{"id":"evt-1","workspaceId":"ws-1","boardId":"board-1","type":"issue.updated","payload":{"a":1},"occurredAt":"2026-08-27T06:30:00.123456789Z"}}`,
};

test("captured envelopes decode here", () => {
   const withBoard = decodeEnvelopeForTest(['event', CAPTURED_ENVELOPES['with board']!]);
   assert.ok(withBoard);
   assert.equal(withBoard.nodeId, 'node-go');
   assert.equal(withBoard.event.id, 'evt-1');
   assert.equal(withBoard.event.boardId, 'board-1');
   assert.equal(withBoard.event.type, 'issue.updated');
   assert.equal(withBoard.event.payload, '{"a":1}');

   const noBoard = decodeEnvelopeForTest(['event', CAPTURED_ENVELOPES['no board']!]);
   assert.ok(noBoard);
   assert.equal(noBoard.event.boardId, undefined, 'omitempty means absent, not empty');
   assert.equal(noBoard.event.payload, 'null');

   const nested = decodeEnvelopeForTest(['event', CAPTURED_ENVELOPES['nested payload']!]);
   assert.ok(nested);
   assert.equal(nested.event.payload, '{"z":1,"a":{"b":[1,2]}}', 'payload key order is preserved');
});

test('an envelope written here matches the captured shape', () => {
   const encoded = encodeEnvelopeForTest('node-go', {
      id: 'evt-1',
      workspaceId: 'ws-1',
      boardId: 'board-1',
      type: 'issue.updated',
      payload: '{"a":1}',
      occurredAt: new Date('2026-08-27T06:30:00.123Z'),
   });
   assert.equal(
      encoded,
      String.raw`{"version":1,"nodeId":"node-go","event":{"id":"evt-1","workspaceId":"ws-1","boardId":"board-1","type":"issue.updated","payload":{"a":1},"occurredAt":"2026-08-27T06:30:00.123Z"}}`
   );
});

test('boardId is omitted rather than sent empty', () => {
   const encoded = encodeEnvelopeForTest('node-ts', {
      id: 'evt-2',
      workspaceId: 'ws-1',
      type: 'run.started',
      payload: 'null',
      occurredAt: new Date('2026-08-27T06:30:00.000Z'),
   });
   assert.ok(!encoded.includes('boardId'), encoded);
});

test('a malformed envelope is rejected rather than delivered', () => {
   const refused: string[][] = [
      ['event', 'not json'],
      ['event', '{"version":2,"nodeId":"n","event":{}}'],
      ['event', '{"version":1,"nodeId":"n"}'],
      // A valid envelope carrying an event that is not valid.
      ['event', '{"version":1,"nodeId":"n","event":{"id":"a","workspaceId":"","type":"x","payload":null,"occurredAt":"2026-08-27T06:30:00Z"}}'],
      ['other', '{"version":1}'],
      [],
   ];
   for (const fields of refused) {
      assert.equal(decodeEnvelopeForTest(fields), null, JSON.stringify(fields));
   }
});
