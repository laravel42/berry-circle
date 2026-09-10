import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { readZip, skillFromArchive } from './zip.ts';

function zip(files: { name: string; data: string; deflate: boolean }[]): Buffer {
   const locals: Buffer[] = [];
   const centrals: Buffer[] = [];
   let offset = 0;
   for (const file of files) {
      const raw = Buffer.from(file.data);
      const body = file.deflate ? deflateRawSync(raw) : raw;
      const name = Buffer.from(file.name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(file.deflate ? 8 : 0, 8);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(file.deflate ? 8 : 0, 10);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, name, body);
      centrals.push(central, name);
      offset += 30 + name.length + body.length;
   }
   const cd = Buffer.concat(centrals);
   const end = Buffer.alloc(22);
   end.writeUInt32LE(0x06054b50, 0);
   end.writeUInt16LE(files.length, 8);
   end.writeUInt16LE(files.length, 10);
   end.writeUInt32LE(cd.length, 12);
   end.writeUInt32LE(offset, 16);
   return Buffer.concat([...locals, cd, end]);
}

test('stored and deflated entries both read back byte for byte', () => {
   const entries = readZip(zip([
      { name: 'a.txt', data: 'plain', deflate: false },
      { name: 'b/c.txt', data: 'squeezed '.repeat(50), deflate: true },
   ]));
   assert.deepEqual(entries.map((e) => [e.path, e.content.toString()]), [
      ['a.txt', 'plain'],
      ['b/c.txt', 'squeezed '.repeat(50)],
   ]);
});

test('an archive with one top folder is unwrapped around SKILL.md', () => {
   const skill = skillFromArchive(readZip(zip([
      { name: 'pdf/SKILL.md', data: '---\nname: pdf-tools\n---\nbody', deflate: true },
      { name: 'pdf/ref.md', data: 'ref', deflate: false },
   ])));
   assert.equal(skill.name, 'pdf-tools');
   assert.deepEqual(skill.files, [{ path: 'ref.md', content: 'ref' }]);
   assert.equal(skill.sourceKind, 'zip');
});

test('bytes that are not a zip are refused', () => {
   assert.throws(() => readZip(Buffer.from('not a zip')));
});

test('an entry that inflates past the limit is refused before it is inflated', () => {
   // 2 MiB of zeros deflates to a few KiB: the declared size, not the archive size, must be checked.
   assert.throws(
      () => readZip(zip([{ name: 'SKILL.md', data: '\0'.repeat(2 << 20), deflate: true }])),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'SKILL_TOO_LARGE'
   );
});
