import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginUnreachable } from './errors.ts';
import { createPluginNetwork, isPrivateAddress } from './net.ts';

test('private, loopback, link-local and mapped addresses are private', () => {
   for (const ip of [
      '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1',
      // WHATWG URL rewrites [::ffff:10.0.0.1] to this hex form, so it must be caught too.
      '::ffff:a00:1', '::ffff:7f00:1', '::a9fe:a9fe', '64:ff9b::a00:1', '2002:a00:1::1', 'not-an-ip',
   ]) {
      assert.equal(isPrivateAddress(ip), true, ip);
   }
   for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:808:808']) {
      assert.equal(isPrivateAddress(ip), false, ip);
   }
});

test('a bracketed mapped address in a URL is refused', async () => {
   const net = createPluginNetwork({ allowPrivate: false, fetchImpl: async () => new Response('{}') });
   await assert.rejects(
      net.request('https://[::ffff:10.0.0.1]/x', { method: 'GET', timeoutMs: 1000, maxBytes: 1000 }),
      PluginUnreachable
   );
});

const ok = async () => new Response('{"ok":true}', { status: 200 });
const init = { method: 'GET' as const, timeoutMs: 1000, maxBytes: 1000 };

test('http and private destinations are refused unless private networking is allowed', async () => {
   const net = createPluginNetwork({ allowPrivate: false, resolve: async () => ['10.0.0.5'], fetchImpl: ok });
   await assert.rejects(net.request('http://plugin.example.com/x', init), PluginUnreachable);
   await assert.rejects(net.request('https://plugin.example.com/x', init), PluginUnreachable);
   await assert.rejects(net.request('https://127.0.0.1/x', init), PluginUnreachable);

   const open = createPluginNetwork({ allowPrivate: true, fetchImpl: ok });
   assert.deepEqual(await open.request('http://127.0.0.1/x', init), { status: 200, body: '{"ok":true}' });
});

test('a public destination is fetched; redirects and oversize bodies are refused', async () => {
   const net = createPluginNetwork({ allowPrivate: false, resolve: async () => ['8.8.8.8'], fetchImpl: ok });
   assert.equal((await net.request('https://plugin.example.com/x', init)).status, 200);

   const redirecting = createPluginNetwork({
      allowPrivate: false,
      resolve: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1' } }),
   });
   await assert.rejects(redirecting.request('https://plugin.example.com/x', init), PluginUnreachable);

   const big = createPluginNetwork({
      allowPrivate: false,
      resolve: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response('x'.repeat(2000), { status: 200 }),
   });
   await assert.rejects(big.request('https://plugin.example.com/x', init), PluginUnreachable);
});
