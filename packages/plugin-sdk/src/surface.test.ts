import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSurfaceLaunch } from './surface.ts';

test('a launch fragment is read into its fields', () => {
   const hash = '#' + new URLSearchParams({
      token: 'berry_plg_x', expiresAt: '2026-09-10T10:00:00.000Z', apiUrl: 'https://berry.example.com',
      workspaceId: 'w', installationId: 'i',
   }).toString();
   assert.deepEqual(readSurfaceLaunch(hash), {
      token: 'berry_plg_x', expiresAt: '2026-09-10T10:00:00.000Z', apiUrl: 'https://berry.example.com',
      workspaceId: 'w', installationId: 'i',
   });
});

test('a fragment without a plugin token is not a launch', () => {
   assert.equal(readSurfaceLaunch(''), null);
   assert.equal(readSurfaceLaunch('#token=abc'), null);
});
