/**
 * What an agent is allowed to do.
 *
 * Berry's claim about agents is that revoking a permission makes the runtime
 * refuse the call — not that it hides a button. So the check belongs at the
 * point of action, where it cannot be routed around, and this module is what
 * every one of those points asks.
 *
 * Two rules make the default safe rather than convenient:
 *
 *   - **Absence is denial.** An unknown name grants nothing, and an agent with
 *     no permissions recorded can do nothing. A permission model that opens up
 *     when it does not recognise its own input is not one.
 *   - **`merge_without_approval` is never a default.** An agent that could
 *     merge its own work would make the human review gate advisory, and the
 *     gate is the product.
 */

export const PERMISSIONS = [
   'read_repository',
   'create_branches',
   'run_commands',
   'open_pull_requests',
   'merge_without_approval',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * What a new agent gets, and what migration 034 gave existing ones.
 *
 * Everything an agent needs to take a task from checkout to pull request, and
 * nothing that lets it finish the job without a person.
 */
export const DEFAULT_PERMISSIONS: readonly Permission[] = [
   'read_repository',
   'create_branches',
   'run_commands',
   'open_pull_requests',
];

export class PermissionDenied extends Error {
   override readonly name = 'PermissionDenied';
   readonly permission: Permission;
   readonly agentName: string;
   constructor(permission: Permission, agentName: string) {
      // Phrased for whoever reads it — a run's failure record, or the agent
      // being told why its tool call did not happen.
      super(`${agentName} does not have permission to ${describe(permission)}`);
      this.permission = permission;
      this.agentName = agentName;
   }
}

export interface PermissionSet {
   has(permission: Permission): boolean;
   /** Throws `PermissionDenied`. The enforcement point, not a hint. */
   require(permission: Permission): void;
   /** What was granted, for a run's record. Ordered, so it reads the same twice. */
   granted(): Permission[];
}

/**
 * Reads a stored permission array.
 *
 * Anything not in `PERMISSIONS` is dropped rather than carried: a typo, or a
 * name from a newer version of Berry, must not become a grant that this
 * version cannot reason about.
 */
export function permissionsOf(stored: readonly string[] | null | undefined, agentName: string): PermissionSet {
   const known = new Set<Permission>();
   for (const name of stored ?? []) {
      if ((PERMISSIONS as readonly string[]).includes(name)) known.add(name as Permission);
   }

   return {
      has: (permission) => known.has(permission),
      require: (permission) => {
         if (!known.has(permission)) throw new PermissionDenied(permission, agentName);
      },
      granted: () => PERMISSIONS.filter((permission) => known.has(permission)),
   };
}

/** A set that grants nothing. Used where an agent could not be identified. */
export function noPermissions(agentName: string): PermissionSet {
   return permissionsOf([], agentName);
}

function describe(permission: Permission): string {
   switch (permission) {
      case 'read_repository':
         return 'read this repository';
      case 'create_branches':
         return 'create branches';
      case 'run_commands':
         return 'run commands';
      case 'open_pull_requests':
         return 'open pull requests';
      case 'merge_without_approval':
         return 'merge without approval';
      default: {
         // Unreachable while the union is exhausted, and a compile error the
         // day a permission is added without a sentence for it.
         const unhandled: never = permission;
         return String(unhandled);
      }
   }
}
