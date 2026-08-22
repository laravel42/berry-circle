import { Hono } from "hono";
import { z } from "zod";
import { getAuthUser, requireAuth } from "~/auth/middleware";
import { toUserDto } from "~/auth/serialize";
import { createSession, findUserByEmail, revokeSession } from "~/auth/sessions";
import { extractBearerToken } from "~/auth/tokens";
import type { AuthEnv } from "~/auth/types";
import { passwordlessLoginAllowed } from "~/config";
import { apiError, invalidRequest, unauthenticated, validationError } from "~/http/errors";

/**
 * Session auth endpoints (BERR-24), mounted at `/api/v1/auth`.
 *
 * Release 1 is self-hosted with a single workspace and no credential store yet.
 * The only login path is credential-less "log in by known email against an
 * existing `users` row" — inherently insecure, so it is gated behind
 * `passwordlessLoginAllowed()` (opt-in flag, never honored in production) and
 * must not reach a network-exposed deploy. Passwords / SSO and user
 * provisioning are tracked follow-ups. The session machinery this issue owns —
 * random tokens, hash-only storage, expiry, and revocation — is implemented in
 * full.
 */

const loginSchema = z.object({
  email: z.string().trim().email(),
});

/**
 * Best-effort client IP from the proxy header, stored only as audit metadata on
 * the session row. `X-Forwarded-For` is client-spoofable and is NOT trusted for
 * any authorization decision.
 */
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

    // Gate the credential-less path before any DB access or token issuance, so the
    // insecure mode can never be reached by default or in production — no session
    // is ever created while it is disabled.
    if (!passwordlessLoginAllowed()) {
      throw apiError(
        403,
        "PASSWORDLESS_LOGIN_DISABLED",
        "Passwordless login is disabled. Set AUTH_ALLOW_PASSWORDLESS_LOGIN=true in a non-production environment to enable it.",
      );
    }

    const user = await findUserByEmail(parsed.data.email);
    // Like any login that issues a session, this reveals account existence: a
    // known email yields a token, an unknown one a 401. That is inherent to a
    // login endpoint and accepted for the self-hosted Release 1 posture — not
    // something this path hides.
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
