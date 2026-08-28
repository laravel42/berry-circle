import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEvent, decodeEvents, encodeFrame, isTerminal, readFrames } from './events.ts';
import type { ExecEvent } from './driver.ts';

/**
 * The stream parser, which is where a live run log either survives the network
 * or quietly loses its last event.
 */

function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
   const encoder = new TextEncoder();
   return new ReadableStream({
      start(controller) {
         for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
         controller.close();
      },
   });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
   const out: T[] = [];
   for await (const item of source) out.push(item);
   return out;
}

test('frames survive being split across chunk boundaries', async () => {
   // The network decides where a chunk ends, and it will land mid-frame.
   const frames = await collect(
      readFrames(bodyOf('data: {"a"', ':1}\n\ndata: {"b', '":2}\n\n'))
   );
   assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
});

test('the last frame is not lost when the stream ends without a blank line', async () => {
   // The specification says discard it. Here that frame carries the exit code,
   // and dropping it turns a finished command into one that appears to hang.
   const frames = await collect(readFrames(bodyOf('data: {"exit":0}')));
   assert.deepEqual(frames, ['{"exit":0}']);
});

test('heartbeat comments and unknown fields are ignored', async () => {
   const frames = await collect(
      readFrames(bodyOf(': keep-alive\nevent: ignored\nid: 7\ndata: {"a":1}\n\n'))
   );
   assert.deepEqual(frames, ['{"a":1}']);
});

test('carriage returns from a proxy do not corrupt the payload', async () => {
   const frames = await collect(readFrames(bodyOf('data: {"a":1}\r\n\r\n')));
   assert.deepEqual(frames, ['{"a":1}']);
});

test('multiple data lines in one frame join with a newline', async () => {
   const frames = await collect(readFrames(bodyOf('data: line one\ndata: line two\n\n')));
   assert.deepEqual(frames, ['line one\nline two']);
});

test('every event shape round-trips through the wire format', async () => {
   const events: ExecEvent[] = [
      { type: 'start', seq: 0, command: 'pnpm test' },
      { type: 'stdout', seq: 1, data: '84 passed' },
      { type: 'stderr', seq: 2, data: 'warn' },
      { type: 'error', seq: 3, message: 'OOM' },
      { type: 'exit', seq: 4, exitCode: 0 },
   ];
   const decoded = await collect(decodeEvents(bodyOf(...events.map(encodeFrame))));
   assert.deepEqual(decoded, events);
});

test('a payload with a newline in it survives JSON framing', async () => {
   // Command output is full of newlines; they must not be read as frame ends.
   const event: ExecEvent = { type: 'stdout', seq: 0, data: 'one\ntwo\n\nthree' };
   const decoded = await collect(decodeEvents(bodyOf(encodeFrame(event))));
   assert.deepEqual(decoded, [event]);
});

test('a frame that is not this protocol is refused, not guessed at', () => {
   assert.throws(() => decodeEvent('<html>502 Bad Gateway</html>'), /not JSON/);
   assert.throws(() => decodeEvent('{"type":"stdout"}'), /unrecognised event/);
   assert.throws(() => decodeEvent('{"type":"exit","seq":0}'), /unrecognised event/);
   assert.throws(() => decodeEvent('{"type":"nope","seq":0}'), /unrecognised event/);
});

test('a huge malformed frame is clipped in the error, not echoed whole', () => {
   assert.throws(
      () => decodeEvent('x'.repeat(50_000)),
      (error: Error) => error.message.length < 400
   );
});

test('only exit and error end a stream', () => {
   assert.equal(isTerminal({ type: 'exit', seq: 0, exitCode: 0 }), true);
   assert.equal(isTerminal({ type: 'error', seq: 0, message: 'x' }), true);
   assert.equal(isTerminal({ type: 'stdout', seq: 0, data: 'x' }), false);
   assert.equal(isTerminal({ type: 'start', seq: 0, command: 'x' }), false);
});

test('frames the worker actually writes decode here, byte for byte', async () => {
   // Pinned as literal bytes rather than round-tripped through encodeFrame, so
   // this fails if either side of PROTOCOL.md drifts from the other.
   const captured =
      'data: {"type":"start","seq":0,"command":"pnpm test"}\n\n' +
      'data: {"type":"stdout","seq":1,"data":"84 passed\\n"}\n\n' +
      'data: {"type":"stderr","seq":2,"data":"1 flaky"}\n\n' +
      'data: {"type":"exit","seq":3,"exitCode":0}\n\n';

   assert.deepEqual(await collect(decodeEvents(bodyOf(captured))), [
      { type: 'start', seq: 0, command: 'pnpm test' },
      { type: 'stdout', seq: 1, data: '84 passed\n' },
      { type: 'stderr', seq: 2, data: '1 flaky' },
      { type: 'exit', seq: 3, exitCode: 0 },
   ]);
});

test('an error frame from the worker is decoded as terminal', async () => {
   const captured =
      'data: {"type":"error","seq":0,"message":"command stream ended without reporting an exit"}\n\n';
   const [event] = await collect(decodeEvents(bodyOf(captured)));
   assert.ok(event);
   assert.equal(isTerminal(event), true);
});
