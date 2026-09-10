import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidPluginInput } from './errors.ts';
import { HELLO } from './fixture.test-support.ts';
import { describePackage, parsePackage, validateConfig } from './manifest.ts';

function fields(work: () => unknown): string[] {
   try {
      work();
   } catch (error) {
      assert.ok(error instanceof InvalidPluginInput);
      return error.fields.map((field) => field.path);
   }
   assert.fail('expected InvalidPluginInput');
}

test('a complete package parses with defaults filled in', () => {
   const pkg = parsePackage(HELLO);
   assert.equal(pkg.manifest.key, 'hello');
   assert.equal(pkg.manifest.description, '');
   assert.equal(pkg.manifest.hooks.length, 2);
   assert.equal(pkg.files.length, 1);
});

test('unknown manifest fields and bad keys are refused with their path', () => {
   assert.deepEqual(fields(() => parsePackage({ manifest: { ...HELLO.manifest, extra: 1 } })), ['/manifest']);
   assert.ok(fields(() => parsePackage({ manifest: { ...HELLO.manifest, key: 'Bad Key' } })).includes('/manifest/key'));
   assert.ok(fields(() => parsePackage({ manifest: { ...HELLO.manifest, scopes: ['admin'] } })).includes('/manifest/scopes/0'));
});

test('duplicate hook keys and path traversal are refused', () => {
   const hooks = [HELLO.manifest.hooks[0], HELLO.manifest.hooks[0]];
   assert.ok(fields(() => parsePackage({ manifest: { ...HELLO.manifest, hooks } })).includes('/manifest/hooks/1/key'));
   assert.ok(fields(() => parsePackage({ ...HELLO, files: [{ path: '../x', content: '' }] })).includes('/files/0/path'));
   const surfaces = [{ key: 'panel', title: 'P', path: '/a/../b' }];
   assert.ok(fields(() => parsePackage({ manifest: { ...HELLO.manifest, surfaces } })).includes('/manifest/surfaces/0/path'));
});

test('config is checked against the manifest', () => {
   const { manifest } = parsePackage(HELLO);
   assert.deepEqual(validateConfig(manifest, { greeting: 'hi' }), { greeting: 'hi' });
   assert.deepEqual(fields(() => validateConfig(manifest, {})), ['/config/greeting']);
   assert.deepEqual(fields(() => validateConfig(manifest, { greeting: 1 })), ['/config/greeting']);
   assert.deepEqual(fields(() => validateConfig(manifest, { greeting: 'hi', other: 'x' })), ['/config/other']);
});

test('the preview names everything the admin is agreeing to', () => {
   const preview = describePackage(parsePackage(HELLO));
   assert.deepEqual(preview.scopes, ['issues:read', 'comments:write']);
   assert.deepEqual(preview.events, ['comment.created']);
   assert.deepEqual(preview.schedules, [{ key: 'nightly', everyMinutes: 1440 }]);
   assert.deepEqual(preview.mcpTools, ['say_hello']);
   assert.deepEqual(preview.files, [{ path: 'README.md', size: 7 }]);
});
