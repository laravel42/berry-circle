import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERMISSIONS, ROLES, allows, validPermission, validRole } from './roles.ts';

/**
 * Extracted from Go's `rolePermissions` table itself, not transcribed from
 * reading it. Counting permissions would pass with two swapped between roles.
 */
const GO_MATRIX: Record<string, string[]> = {
   "admin": [
      "comments.write",
      "invitations.read",
      "invitations.write",
      "members.manage",
      "members.read",
      "product.read",
      "product.write",
      "runs.dispatch",
      "settings.read",
      "settings.write",
      "workspace.read",
      "workspace.update"
   ],
   "member": [
      "comments.write",
      "members.read",
      "product.read",
      "product.write",
      "runs.dispatch",
      "settings.read",
      "workspace.read"
   ],
   "owner": [
      "comments.write",
      "invitations.read",
      "invitations.write",
      "members.manage",
      "members.read",
      "owners.manage",
      "product.read",
      "product.write",
      "runs.dispatch",
      "settings.read",
      "settings.write",
      "workspace.delete",
      "workspace.read",
      "workspace.update"
   ],
   "viewer": [
      "members.read",
      "product.read",
      "settings.read",
      "workspace.read"
   ]
};

test('the matrix matches Go role for role, permission for permission', () => {
   assert.deepEqual([...ROLES].sort(), Object.keys(GO_MATRIX).sort());
   for (const role of ROLES) {
      const granted = PERMISSIONS.filter((permission) => allows(role, permission)).sort();
      assert.deepEqual(granted, GO_MATRIX[role], role);
   }
});

test('only an owner may delete a workspace or manage owners', () => {
   // The boundary a role hierarchy would quietly erase: an admin who could
   // manage owners could promote themselves and then remove the owner.
   for (const permission of ['workspace.delete', 'owners.manage'] as const) {
      assert.ok(allows('owner', permission));
      assert.ok(!allows('admin', permission));
      assert.ok(!allows('member', permission));
      assert.ok(!allows('viewer', permission));
   }
});

test('a viewer reads and never writes', () => {
   assert.ok(allows('viewer', 'product.read'));
   assert.ok(!allows('viewer', 'product.write'));
   assert.ok(!allows('viewer', 'comments.write'));
   assert.ok(!allows('viewer', 'runs.dispatch'));
   assert.ok(!allows('viewer', 'members.manage'));
});

test('a member writes product data but cannot administer the workspace', () => {
   assert.ok(allows('member', 'product.write'));
   assert.ok(allows('member', 'runs.dispatch'));
   assert.ok(!allows('member', 'workspace.update'));
   assert.ok(!allows('member', 'settings.write'));
   assert.ok(!allows('member', 'members.manage'));
   assert.ok(!allows('member', 'invitations.write'));
});

test('an unknown role grants nothing', () => {
   // Reached whenever a column holds something the schema no longer uses;
   // defaulting to deny is the only safe reading.
   assert.ok(!allows('superuser', 'workspace.read'));
   assert.ok(!allows('', 'workspace.read'));
   assert.ok(!validRole('superuser'));
   assert.ok(validRole('owner'));
});

test('Object.prototype names are neither roles nor permissions and grant nothing', () => {
   // A plain-object lookup would resolve these to inherited functions and
   // read them as grants (Property 4 found 'toString' and 'valueOf').
   const inherited = ['toString', 'valueOf', '__proto__', 'constructor', 'hasOwnProperty'];
   for (const name of inherited) {
      assert.equal(validRole(name), false, `${name} is not a role`);
      assert.equal(validPermission(name), false, `${name} is not a permission`);
      for (const permission of PERMISSIONS) {
         assert.equal(allows(name, permission), false, `${name} grants ${permission}`);
      }
      for (const role of ROLES) {
         assert.equal(allows(role, name as never), false, `${role} grants ${name}`);
      }
   }
   assert.ok(validPermission('workspace.read'));
});
