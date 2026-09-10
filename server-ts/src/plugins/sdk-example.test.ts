import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parsePackage } from './manifest.ts';

test('the SDK example package is a valid package for this server', async () => {
   const raw = await readFile(new URL('../../../packages/plugin-sdk/examples/hello/berry-plugin.json', import.meta.url), 'utf8');
   const pkg = parsePackage(JSON.parse(raw));
   assert.equal(pkg.manifest.key, 'hello');
});
