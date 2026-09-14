import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { ExecResult, ExecutionSession } from './driver.ts';
import { FileTooLarge, getBytes, putBytes } from './bytes.ts';

/**
 * A session with a real shell behind it: the commands are the point, so they
 * run on this machine, in a temporary directory, rather than being matched.
 */
function shellSession(root: string): { session: ExecutionSession; commands: string[] } {
   const commands: string[] = [];
   const session: ExecutionSession = {
      id: 's',
      exec: async (command: string, options?: { cwd?: string }): Promise<ExecResult> => {
         commands.push(command);
         const { spawnSync } = await import('node:child_process');
         const result = spawnSync('/bin/bash', ['-c', command], {
            cwd: options?.cwd ?? root,
            maxBuffer: 64 * 1024 * 1024,
         });
         return { stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'), exitCode: result.status ?? 1 };
      },
      stream: () => ({ async *[Symbol.asyncIterator]() {} }),
      writeFile: async () => undefined,
      readFile: async () => '',
      stop: async () => undefined,
      destroy: async () => undefined,
   };
   return { session, commands };
}

async function tempRoot(): Promise<string> {
   const { mkdtemp } = await import('node:fs/promises');
   const { tmpdir } = await import('node:os');
   return mkdtemp(`${tmpdir()}/berry-bytes-`);
}

test('bytes survive the round trip, every byte value and a size over one chunk', async () => {
   // An MP4 is the case: through writeFile it came back as UTF-8, and an
   // agent asked to add narration merged a corrupt clip.
   const root = await tempRoot();
   const { session, commands } = shellSession(root);
   const bytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_x, i) => i)), randomBytes(900 * 1024)]);

   await putBytes(session, 'video/clip.mp4', bytes);
   const back = await getBytes(session, 'video/clip.mp4', { maxBytes: 2 * 1024 * 1024 });

   assert.ok(back && Buffer.from(back).equals(bytes));
   const writes = commands.filter((c) => c.includes('base64 -d'));
   assert.ok(writes.length >= 3, 'written in more than one chunk');
   // The command channel's ceiling, measured on AgentCore: 64 KB is refused.
   for (const command of writes) assert.ok(command.length < 48 * 1024, `a write command of ${command.length} bytes`);
   for (const command of commands) assert.ok(!command.includes('\n'), 'one line per command');
});

test('a second write replaces the file rather than appending to it', async () => {
   const root = await tempRoot();
   const { session } = shellSession(root);
   await putBytes(session, 'a.bin', Buffer.from('first version'));
   await putBytes(session, 'a.bin', Buffer.from('second'));
   const back = await getBytes(session, 'a.bin', { maxBytes: 1024 });
   assert.equal(Buffer.from(back!).toString('utf8'), 'second');
});

test('an empty file is written, and read back empty', async () => {
   const root = await tempRoot();
   const { session } = shellSession(root);
   await putBytes(session, 'empty', Buffer.alloc(0));
   const back = await getBytes(session, 'empty', { maxBytes: 1024 });
   assert.equal(back?.byteLength, 0);
});

test('a missing file is null, not an error, and an oversized one is refused before it is read', async () => {
   const root = await tempRoot();
   const { session, commands } = shellSession(root);
   assert.equal(await getBytes(session, 'nope.mp4', { maxBytes: 1024 }), null);

   await putBytes(session, 'big.bin', randomBytes(4096));
   commands.length = 0;
   await assert.rejects(getBytes(session, 'big.bin', { maxBytes: 1024 }), (error: FileTooLarge) => {
      assert.equal(error.name, 'FileTooLarge');
      assert.equal(error.sizeBytes, 4096);
      return true;
   });
   assert.ok(!commands.some((c) => c.includes('base64 |')), 'no chunk was read');
});

test("a path with a quote in it is the shell's problem, not the caller's", async () => {
   const root = await tempRoot();
   const { session } = shellSession(root);
   await putBytes(session, "it's/a file.txt", Buffer.from('ok'));
   const back = await getBytes(session, "it's/a file.txt", { maxBytes: 1024 });
   assert.equal(Buffer.from(back!).toString('utf8'), 'ok');
});
