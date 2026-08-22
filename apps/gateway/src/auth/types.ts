import type { UserRole } from "~/db/schema";

/**
 * The authenticated user attached to a request by `requireAuth`. Carries the
 * role so downstream handlers authorize without a second lookup. Timestamps
 * are `Date`s (serialized to RFC 3339 strings by `toUserDto`).
 */
export type AuthUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Hono environment for auth-aware routers. Merge into a router's generics
 * (`new Hono<AuthEnv>()`) so `c.get("authUser")` is typed. `authUser` is
 * present only after `requireAuth` has run.
 */
export type AuthEnv = {
  Variables: {
    authUser: AuthUser;
  };
};
