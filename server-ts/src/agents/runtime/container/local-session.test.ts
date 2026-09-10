import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalSession } from './local-session.ts';

const session = () => new LocalSession({ id: 's', root: mkdtempSync(join(tmpdir(), 'berry-local-')) });

test('a command runs through a shell and reports its exit code', async () => {
   const result = await session().exec('echo one && echo two >&2; exit 3');
   assert.deepEqual(result, { stdout: 'one\n', stderr: 'two\n', exitCode: 3 });
});

test('the stream starts, carries output, and ends with exit', async () => {
   const types: string[] = [];
   for await (const event of session().stream('printf hi')) types.push(event.type);
   assert.deepEqual([types[0], types.at(-1)], ['start', 'exit']);
   assert.ok(types.includes('stdout'));
});

test('cwd is relative to the session root and env reaches the command', async () => {
   const s = session();
   await s.exec('mkdir -p sub');
   const result = await s.exec('pwd; echo $GREETING', { cwd: 'sub', env: { GREETING: 'hello' } });
   assert.match(result.stdout, /\/sub\nhello\n$/);
});

test('files written are read back byte for byte', async () => {
   const s = session();
   await s.writeFile('deep/dir/a.txt', 'EOF\nline\n');
   assert.equal(await s.readFile('deep/dir/a.txt'), 'EOF\nline\n');
});

test('an aborted command ends with an error and a non-zero exit', async () => {
   const controller = new AbortController();
   setTimeout(() => controller.abort(), 50);
   const result = await session().exec('sleep 5', { signal: controller.signal });
   assert.notEqual(result.exitCode, 0);
});
