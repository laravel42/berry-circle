import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactPath, partToBytes } from './artifact-service.ts';
import { InvalidKey, sniffContentType, validateKey } from '../storage/storage.ts';

/**
 * The pure halves of the artifact path. The parts that need PostgreSQL and a
 * bucket were driven against both directly: two agents sharing one run, one
 * writing a file and the other listing, reading and quoting it — which is the
 * handoff a per-agent volume made impossible.
 */

test('a filename passes through, separators and all', () => {
   // ADK JS percent-encodes its own keys rather than refusing separators, and
   // run_artifacts.path permits them, so a nested path survives intact.
   assert.equal(artifactPath('report.md'), 'report.md');
   assert.equal(artifactPath('findings/report.md'), 'findings/report.md');
   assert.equal(artifactPath('src/main/index.ts'), 'src/main/index.ts');
});

test("ADK's user namespace is folded into the path, not dropped", () => {
   // The prefix means "this outlives one session". Discarding it would let a
   // user-scoped file collide with a run-scoped one of the same name.
   assert.equal(artifactPath('user:preferences.json'), 'berry-user/preferences.json');
   assert.notEqual(artifactPath('user:notes.md'), artifactPath('notes.md'));
});

test('a text part is stored as UTF-8 rather than refused', () => {
   // An agent writing a note is the ordinary case; making it base64-encode
   // prose would be a worse interface.
   assert.equal(partToBytes({ text: 'hello' }).toString('utf8'), 'hello');
   assert.equal(partToBytes({ text: 'héllo — em dash' }).toString('utf8'), 'héllo — em dash');
});

test('inline data is decoded from base64', () => {
   const encoded = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
   assert.deepEqual(
      [...partToBytes({ inlineData: { mimeType: 'image/png', data: encoded } })],
      [0x89, 0x50, 0x4e, 0x47]
   );
});

test('a part carrying neither text nor data is refused', () => {
   // Silently writing an empty file would leave a reader with something that
   // looks saved and says nothing.
   assert.throws(() => partToBytes({}), /neither inline data nor text/);
});

test('an unsafe storage key is refused rather than sanitised', () => {
   // A rewritten key points somewhere the caller did not mean, and the caller
   // never finds out.
   for (const key of ['', '../escape', '/absolute', 'back\\slash', 'a//b', 'a/./b', 'a/../b']) {
      assert.throws(() => validateKey(key), InvalidKey, JSON.stringify(key));
   }
   assert.throws(() => validateKey('x'.repeat(1025)), InvalidKey);
   assert.throws(() => validateKey('has\0null'), InvalidKey);
});

test('an ordinary key is accepted and split', () => {
   assert.deepEqual(validateKey('artifacts/ws/run/id'), ['artifacts', 'ws', 'run', 'id']);
});

test('content sniffing recognises what agents produce and admits the rest', () => {
   // A confident wrong guess is worse than an honest unknown, because the
   // browser acts on it.
   assert.equal(sniffContentType(Buffer.from('# heading\n')), 'text/plain; charset=utf-8');
   assert.equal(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
   assert.equal(sniffContentType(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
   assert.equal(sniffContentType(Buffer.from('%PDF-1.7')), 'application/pdf');
   assert.equal(sniffContentType(Buffer.from([0x00, 0x01, 0x02])), 'application/octet-stream');
   assert.equal(sniffContentType(Buffer.alloc(0)), 'application/octet-stream');
});

test('tabs and newlines do not make a file binary', () => {
   assert.equal(sniffContentType(Buffer.from('a\tb\nc\r\n')), 'text/plain; charset=utf-8');
});
