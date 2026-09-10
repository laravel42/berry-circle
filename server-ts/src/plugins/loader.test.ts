import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidPluginInput, PluginUnreachable } from './errors.ts';
import { loadPackage } from './loader.ts';
import type { PluginNetwork } from './net.ts';
import { HELLO } from './fixture.test-support.ts';

function fakeNet(status: number, body: string): PluginNetwork {
   return { request: async () => ({ status, body }) };
}

test('an uploaded package is parsed and marked as an upload', async () => {
   const loaded = await loadPackage(fakeNet(500, ''), { package: HELLO });
   assert.equal(loaded.source, 'upload');
   assert.equal(loaded.sourceUrl, null);
   assert.equal(loaded.pkg.manifest.key, 'hello');
});

test('a URL package is fetched and remembers where it came from', async () => {
   const loaded = await loadPackage(fakeNet(200, JSON.stringify(HELLO)), { url: 'https://hello.example.com/berry-plugin.json' });
   assert.equal(loaded.source, 'url');
   assert.equal(loaded.sourceUrl, 'https://hello.example.com/berry-plugin.json');
});

test('a URL that fails or is not a package is refused', async () => {
   await assert.rejects(loadPackage(fakeNet(404, ''), { url: 'https://x.example.com/p.json' }), PluginUnreachable);
   await assert.rejects(loadPackage(fakeNet(200, 'not json'), { url: 'https://x.example.com/p.json' }), InvalidPluginInput);
});
