import { Hono } from "hono";
import { z } from "zod";
import { getAuthUser, requireAuth } from "~/auth/middleware";
import { toUserDto } from "~/auth/serialize";
import { createSession, findUserByEmail, revokeSession } from "~/auth/sessions";
import { extractBearerToken } from "~/auth/tokens";
import type { AuthEnv } from "~/auth/types";
import { invalidRequest, unauthenticated, validationError } from "~/http/errors";

/**
 * Session auth endpoints (BERR-24), mounted at `/api/v1/auth`.
 *
 * Release 1 is self-hosted with a single workspace and no credential store yet,
 * so login authenticates by email against an existing `users` row and issues an
 * opaque session token. Passwords / SSO are a tracked follow-up; the security-
 * sensitive parts that this issue owns — random tokens, hash-only storage,
 * expiry, and revocation — are implemented in full. User provisioning is out of
 * scope here (the row must already exist).
 */

const loginSchema = z.object({
  email: z.string().trim().email(),
});

/** Best-effort client IP from the proxy header; null when absent. */
function clientIp(header: string | undefined): string | null {
  const first = header?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export const auth = new Hono<AuthEnv>()
  .post("/login", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw invalidRequest("Request body must be valid JSON.");
    }

    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }

    const user = await findUserByEmail(parsed.data.email);
    // Same response whether the email is unknown or otherwise unauthorized, so
    // login does not double as an account-enumeration oracle.
    if (!user) {
      throw unauthenticated("Invalid credentials.");
    }

    const { token, expiresAt } = await createSession(user.id, {
      userAgent: c.req.header("user-agent") ?? null,
      ip: clientIp(c.req.header("x-forwarded-for")),
    });

    return c.json({ token, expiresAt: expiresAt.toISOString(), user: toUserDto(user) });
  })
  .post("/logout", requireAuth, async (c) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (token) {
      await revokeSession(token);
    }
    return c.body(null, 204);
  })
  .get("/me", requireAuth, (c) => {
    return c.json(toUserDto(getAuthUser(c)));
  });
