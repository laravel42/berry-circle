import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentDisposition } from './attachments.ts';

/**
 * The header a download hangs on. What the routes return was compared against
 * the running Go server on a real object in MinIO — the bytes, the headers and
 * the metadata all identical.
 */

test('an ordinary filename is quoted as it is', () => {
   assert.equal(contentDisposition('notes.txt'), 'attachment; filename="notes.txt"');
   // An ampersand is not special in a quoted header value, and encoding it
   // would show the reader `probe %26 notes.txt` when they save the file.
   assert.equal(contentDisposition('probe & notes.txt'), 'attachment; filename="probe & notes.txt"');
});

test('a filename that could end the header early is encoded instead', () => {
   // A quote would close the value and everything after it becomes a header
   // the browser reads, which is how a filename turns into a response split.
   for (const name of ['say "hi".txt', 'back\\slash.txt', 'line\nbreak.txt']) {
      const value = contentDisposition(name);
      assert.match(value, /^attachment; filename\*=utf-8''/);
      assert.ok(!value.includes('"'), value);
      assert.ok(!value.includes('\n'), JSON.stringify(value));
   }
});

test('a non-ASCII filename is encoded rather than sent raw', () => {
   // Latin-1 is what an unencoded header value means on the wire, so a
   // Japanese filename sent raw arrives as mojibake.
   const value = contentDisposition('設計メモ.txt');
   assert.match(value, /^attachment; filename\*=utf-8''/);
   assert.ok(value.includes('%E8%A8%AD'), value);
});
