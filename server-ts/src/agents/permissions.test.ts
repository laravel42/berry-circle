import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   DEFAULT_PERMISSIONS,
   PERMISSIONS,
   PermissionDenied,
   noPermissions,
   permissionsOf,
} from './permissions.ts';

/**
 * What an agent is allowed to do.
 *
 * The tests that matter here are the ones about denial: a permission model
 * that opens up when it does not recognise its input is not a permission
 * model, and a default that includes merging would make the review gate
 * advisory.
 */

test('merging without approval is never a default', () => {
   // The product is the gate. An agent that could merge its own work would
   // make it advisory, so this is asserted rather than left to review.
   assert.ok(!DEFAULT_PERMISSIONS.includes('merge_without_approval'));
   assert.equal(permissionsOf(DEFAULT_PERMISSIONS, 'Forge').has('merge_without_approval'), false);
});

test('the defaults are everything needed to reach a pull request, and no more', () => {
   assert.deepEqual([...DEFAULT_PERMISSIONS], [
      'read_repository',
      'create_branches',
      'run_commands',
      'open_pull_requests',
   ]);
});

test('absence is denial', () => {
   const none = permissionsOf([], 'Forge');
   for (const permission of PERMISSIONS) {
      assert.equal(none.has(permission), false, permission);
      assert.throws(() => none.require(permission), PermissionDenied, permission);
   }
   assert.deepEqual(none.granted(), []);
});

test('a name the server does not know grants nothing', () => {
   // A typo, or a name from a newer Berry. Either way it must not become a
   // grant this version cannot reason about.
   const set = permissionsOf(['merge_wthout_approval', 'admin', '*', 'run_commands'], 'Forge');
   assert.equal(set.has('merge_without_approval'), false);
   assert.equal(set.has('run_commands'), true);
   assert.deepEqual(set.granted(), ['run_commands']);
});

test('null and undefined are treated as no permissions, not as all of them', () => {
   for (const stored of [null, undefined]) {
      const set = permissionsOf(stored, 'Forge');
      assert.deepEqual(set.granted(), []);
      assert.throws(() => set.require('read_repository'), PermissionDenied);
   }
});

test('a denial names the agent and the thing it tried to do', () => {
   // It reaches a run's failure record and the agent's own tool result, so it
   // has to read as a sentence rather than a code.
   try {
      permissionsOf(['run_commands'], 'Forge').require('merge_without_approval');
      assert.fail('the denial did not throw');
   } catch (error) {
      assert.ok(error instanceof PermissionDenied);
      assert.equal(error.permission, 'merge_without_approval');
      assert.equal(error.message, 'Forge does not have permission to merge without approval');
   }
});

test('every permission has a sentence, so no denial reads as a symbol', () => {
   for (const permission of PERMISSIONS) {
      const error = new PermissionDenied(permission, 'Forge');
      assert.doesNotMatch(error.message, /_/, `${permission} has no sentence`);
      assert.match(error.message, /^Forge does not have permission to /);
   }
});

test('what was granted reads the same way twice', () => {
   // Ordered by the canonical list rather than by insertion, so a run's record
   // does not differ because a column was written in a different order.
   const a = permissionsOf(['run_commands', 'read_repository'], 'Forge').granted();
   const b = permissionsOf(['read_repository', 'run_commands'], 'Forge').granted();
   assert.deepEqual(a, b);
   assert.deepEqual(a, ['read_repository', 'run_commands']);
});

test('an unidentified agent gets nothing', () => {
   const set = noPermissions('unknown');
   assert.deepEqual(set.granted(), []);
   assert.throws(() => set.require('run_commands'), PermissionDenied);
});
