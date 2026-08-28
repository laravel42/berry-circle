import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { list } from './migrations.ts';

/**
 * The gates that keep the ledger's checksums meaningful: a migration edited
 * after it was applied cannot be detected at runtime without them, and cannot
 * be fixed once it has been.
 */

const MIGRATIONS = path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   '..',
   '..',
   'migrations'
);

async function scratch(files: Record<string, string>): Promise<string> {
   const directory = await mkdtemp(path.join(tmpdir(), 'berry-migrations-'));
   for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(directory, name), body, 'utf8');
   }
   return directory;
}

test('the shipped migrations load in ascending order with unique versions', async () => {
   const migrations = await list();

   assert.ok(migrations.length > 0, 'no migrations were found');
   const versions = migrations.map((migration) => migration.version);
   assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
   assert.equal(new Set(versions).size, versions.length);

   // Every .up.sql on disk is loaded — a file the runner silently skipped
   // would be a schema change that never runs.
   const onDisk = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.up.sql'));
   assert.equal(migrations.length, onDisk.length);
});

test('a checksum is the SHA-256 of the file, so an edit changes it', async () => {
   const [first] = await list();
   assert.ok(first);

   const body = await readFile(path.join(MIGRATIONS, first.name));
   assert.equal(first.checksum, createHash('sha256').update(body).digest('hex'));

   const edited = await scratch({ [first.name]: `${body.toString('utf8')}\n-- edited\n` });
   const [reloaded] = await list(edited);
   assert.ok(reloaded);
   assert.notEqual(reloaded.checksum, first.checksum);
});

test('two files claiming one version are refused rather than ordered arbitrarily', async () => {
   const directory = await scratch({
      '001_first.up.sql': 'SELECT 1;',
      '001_second.up.sql': 'SELECT 2;',
   });
   await assert.rejects(list(directory), /duplicate migration version 001/);
});

test('a filename outside the convention is refused', async () => {
   const directory = await scratch({ 'oops.up.sql': 'SELECT 1;' });
   await assert.rejects(list(directory), /invalid migration filename/);
});
