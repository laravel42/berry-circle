import type { Env, Hono } from 'hono';

/**
 * A mounted subtree's own environment is its business, not the registry's —
 * `platform` needs no context variables while an authenticated mount will.
 * Hono's `route()` is generic over exactly this, so the registry stays
 * indifferent to it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHono = Hono<any, any, any>;

/**
 * Disjoint prefix mounts.
 *
 * Domain modules contribute subtrees and the registry refuses two that could
 * ever match the same path. That rule is why no central module has to import
 * every handler, and why a prefix can be added, moved or retired on its own
 * without auditing what else might answer the same request.
 *
 * Overlap is checked at startup rather than discovered at request time,
 * because a route silently shadowed by another is the kind of bug that only
 * shows up in production under a path nobody tested.
 */

export interface Mount {
   /** An absolute path prefix, e.g. `/api/v1/issues`. */
   prefix: string;
   /** Routes relative to the prefix. */
   handler: AnyHono;
}

export class MountConflict extends Error {
   constructor(first: string, second: string) {
      super(`mount ${first} overlaps ${second}`);
      this.name = 'MountConflict';
   }
}

/** Whether two prefixes could ever match the same request path. */
export function overlaps(first: string, second: string): boolean {
   return (
      first === second ||
      first === '/' ||
      second === '/' ||
      first.startsWith(second + '/') ||
      second.startsWith(first + '/')
   );
}

export class Registry {
   private readonly mounts: Mount[] = [];

   /** Adds a mount, refusing one that overlaps anything already registered. */
   register(mount: Mount): void {
      if (!mount.prefix.startsWith('/')) {
         throw new Error(`mount prefix ${mount.prefix} must be absolute`);
      }
      if (mount.prefix.length > 1 && mount.prefix.endsWith('/')) {
         throw new Error(`mount prefix ${mount.prefix} must not end in a slash`);
      }
      for (const existing of this.mounts) {
         if (overlaps(mount.prefix, existing.prefix)) {
            throw new MountConflict(mount.prefix, existing.prefix);
         }
      }
      this.mounts.push(mount);
   }

   registerAll(mounts: Mount[]): void {
      for (const mount of mounts) this.register(mount);
   }

   /** Attaches every mount to an app, longest prefix first. */
   attach<E extends Env>(app: Hono<E>): void {
      // Longest first so a router cannot shadow a more specific sibling even
      // if a future change relaxes the overlap rule.
      const ordered = [...this.mounts].sort((a, b) => b.prefix.length - a.prefix.length);
      for (const mount of ordered) app.route(mount.prefix, mount.handler);
   }

   get prefixes(): string[] {
      return this.mounts.map((mount) => mount.prefix);
   }
}
