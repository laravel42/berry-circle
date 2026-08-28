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

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
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

/** False for an unknown role, so an unrecognised value grants nothing. */
export function allows(role: string, permission: Permission): boolean {
   return ROLE_PERMISSIONS[role as Role]?.has(permission) ?? false;
}

export function validRole(role: string): role is Role {
   return role in ROLE_PERMISSIONS;
}
