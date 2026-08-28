import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Demultiplexer } from './demux.ts';

/**
 * The frame parser, where a run log either keeps stdout and stderr apart or
 * silently interleaves them.
 */

function frame(kind: 1 | 2, text: string): Buffer {
   const payload = Buffer.from(text, 'utf8');
   const header = Buffer.alloc(8);
   header[0] = kind;
   header.writeUInt32BE(payload.length, 4);
   return Buffer.concat([header, payload]);
}

test('stdout and stderr are kept apart, in arrival order', () => {
   const demux = new Demultiplexer();
   const frames = demux.push(
      Buffer.concat([frame(1, '84 passed\n'), frame(2, '1 flaky\n'), frame(1, 'done\n')])
   );
   assert.deepEqual(frames, [
      { kind: 'stdout', data: '84 passed\n' },
      { kind: 'stderr', data: '1 flaky\n' },
      { kind: 'stdout', data: 'done\n' },
   ]);
});

test('a frame split across chunks is held until it is whole', () => {
   // The socket decides where a chunk ends, and it will land mid-payload.
   const whole = frame(1, 'installing dependencies');
   const demux = new Demultiplexer();
   assert.deepEqual(demux.push(whole.subarray(0, 12)), []);
   assert.deepEqual(demux.push(whole.subarray(12)), [
      { kind: 'stdout', data: 'installing dependencies' },
   ]);
   assert.equal(demux.pending, 0);
});

test('a header split across chunks is held too', () => {
   const whole = frame(2, 'error');
   const demux = new Demultiplexer();
   assert.deepEqual(demux.push(whole.subarray(0, 3)), []);
   assert.deepEqual(demux.push(whole.subarray(3)), [{ kind: 'stderr', data: 'error' }]);
});

test('a multi-byte character split across frames is not corrupted', () => {
   // Decoders are held per stream for exactly this: decoding each frame alone
   // turns one character into two replacement marks.
   const bytes = Buffer.from('café ☕', 'utf8');
   const demux = new Demultiplexer();
   const first = demux.push(
      Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 4]), bytes.subarray(0, 4)])
   );
   const second = demux.push(
      Buffer.concat([
         Buffer.from([1, 0, 0, 0, 0, 0, 0, bytes.length - 4]),
         bytes.subarray(4),
      ])
   );
   assert.equal(
      [...first, ...second].map((f) => f.data).join(''),
      'café ☕'
   );
});

test('an empty frame is not a ledger row', () => {
   assert.deepEqual(new Demultiplexer().push(frame(1, '')), []);
});

test('a stdin frame is ignored rather than reported as output', () => {
   const demux = new Demultiplexer();
   const stdin = Buffer.alloc(8);
   stdin[0] = 0;
   stdin.writeUInt32BE(3, 4);
   assert.deepEqual(demux.push(Buffer.concat([stdin, Buffer.from('abc')])), []);
});

test('an implausible frame length is refused rather than allocated for', () => {
   // A corrupt header claiming a gigabyte is how a bad read becomes an OOM.
   const header = Buffer.alloc(8);
   header[0] = 1;
   header.writeUInt32BE(0xffffffff, 4);
   assert.throws(() => new Demultiplexer().push(header), /implausible frame/);
});

test('a truncated tail is visible rather than silently dropped', () => {
   const demux = new Demultiplexer();
   demux.push(frame(1, 'partial').subarray(0, 10));
   assert.ok(demux.pending > 0);
});
