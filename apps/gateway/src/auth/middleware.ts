import type { Context, MiddlewareHandler } from "hono";
import { resolveSession } from "~/auth/sessions";
import { extractBearerToken } from "~/auth/tokens";
import type { AuthEnv, AuthUser } from "~/auth/types";
import type { UserRole } from "~/db/schema";
import { forbidden, unauthenticated } from "~/http/errors";

/**
 * Route guards.
 *
 * `requireAuth` validates the `Authorization: Bearer <token>` session token and
 * attaches the resolved user to the context. `requireRole` layers a role check
 * on top. Both are exported so any router — issues, comments, runs — can guard
 * itself with `router.use("*", requireAuth)` and read `c.get("authUser")`.
 */

/**
 * Rejects requests without a valid, unexpired session token, otherwise sets
 * `authUser` on the context. Missing/malformed `Authorization` headers are
 * rejected before any database access, so guarded routes stay cheap for
 * unauthenticated callers.
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) {
    throw unauthenticated();
  }
  const user = await resolveSession(token);
  if (!user) {
    throw unauthenticated("Session is invalid or has expired.");
  }
  c.set("authUser", user);
  await next();
};

/**
 * Requires the authenticated user to hold one of `roles`. Must run after
 * `requireAuth`. Returns `401` if somehow unauthenticated, `403` if the role
 * is insufficient.
 */
export function requireRole(...roles: UserRole[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get("authUser");
    if (!user) {
      throw unauthenticated();
    }
    if (!roles.includes(user.role)) {
      throw forbidden();
    }
    await next();
  };
}

/** Typed accessor for the authenticated user set by `requireAuth`. */
export function getAuthUser(c: Context<AuthEnv>): AuthUser {
  return c.get("authUser");
}
