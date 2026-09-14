/**
 * Berry's workspace permission matrix.
 *
 * Written out per role rather than derived from a hierarchy. A hierarchy would
 * be shorter and would quietly grant an admin the one thing they must not
 * have: `owners.manage`, the permission that stops an admin from promoting
 * themselves. Explicit sets make that boundary visible and reviewable.
 */

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
   'workspace.read',
   'workspace.update',
   'workspace.delete',
   'settings.read',
   'settings.write',
   'members.read',
   'members.manage',
   'owners.manage',
   'invitations.read',
   'invitations.write',
   'product.read',
   'product.write',
   'comments.write',
   'runs.dispatch',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS_BY_NAME: Record<Role, ReadonlySet<Permission>> = {
   owner: new Set([
      'workspace.read',
      'workspace.update',
      'workspace.delete',
      'settings.read',
      'settings.write',
      'members.read',
      'members.manage',
      'owners.manage',
      'invitations.read',
      'invitations.write',
      'product.read',
      'product.write',
      'comments.write',
      'runs.dispatch',
   ]),
   admin: new Set([
      'workspace.read',
      'workspace.update',
      'settings.read',
      'settings.write',
      'members.read',
      'members.manage',
      'invitations.read',
      'invitations.write',
      'product.read',
      'product.write',
      'comments.write',
      'runs.dispatch',
   ]),
   member: new Set([
      'workspace.read',
      'settings.read',
      'members.read',
      'product.read',
      'product.write',
      'comments.write',
      'runs.dispatch',
   ]),
   viewer: new Set(['workspace.read', 'settings.read', 'members.read', 'product.read']),
};

/**
 * Looked up through a Map, never the object literal above: a plain-object
 * lookup resolves inherited names ('toString', '__proto__', 'constructor')
 * to Object.prototype members, which an `in` check or a truthy read would
 * take for a role.
 */
const ROLE_PERMISSIONS: ReadonlyMap<string, ReadonlySet<Permission>> = new Map(
   ROLES.map((role) => [role, ROLE_PERMISSIONS_BY_NAME[role]])
);

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/** False for an unknown role or permission, so an unrecognised value grants nothing. */
export function allows(role: string, permission: Permission): boolean {
   if (!validPermission(permission)) return false;
   return ROLE_PERMISSIONS.get(role)?.has(permission) ?? false;
}

export function validRole(role: string): role is Role {
   return ROLE_PERMISSIONS.has(role);
}

export function validPermission(permission: string): permission is Permission {
   return PERMISSION_SET.has(permission);
}
