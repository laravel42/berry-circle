import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres from "postgres";
import { createApp } from "~/app";
import { requireAuth, requireRole } from "~/auth/middleware";
import { hashToken } from "~/auth/tokens";
import type { AuthEnv } from "~/auth/types";
import { passwordlessLoginAllowed } from "~/config";
import { closeDb } from "~/db/client";
import { sessions, users } from "~/db/schema";

/**
 * Auth endpoint + middleware coverage (BERR-24).
 *
 * The guard/validation/envelope cases run without a database because they
 * short-circuit before any DB access. The full login → me → logout flow,
 * expiry, and role plumbing are integration tests gated on both DATABASE_URL
 * and the passwordless-login opt-in, matching the self-skip pattern in
 * `src/db/schema.constraints.test.ts` so a plain `bun test` stays green.
 */

type ErrorEnvelope = {
  error: { code: string; message: string; requestId?: unknown; details?: unknown };
};

/** Asserts a value is defined and returns it narrowed, without `!`. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error("Expected value to be defined");
  }
  return value;
}

describe("auth guards + error envelope (no database required)", () => {
  test("GET /api/v1/auth/me without a token is 401 UNAUTHENTICATED", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  test("GET /api/v1/auth/me with a non-Bearer scheme is 401", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/me", {
      headers: { authorization: "Basic Zm9vOmJhcg==" },
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/v1/auth/logout without a token is 401", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("POST /api/v1/auth/login with a missing email is 422 with field details", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorEnvelope & {
      error: { details?: { fields?: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details?.fields?.[0]?.path).toBe("/email");
  });

  test("POST /api/v1/auth/login with a non-email is 422", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(422);
  });

  test("POST /api/v1/auth/login with malformed JSON is 400 INVALID_REQUEST", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  test("error envelope carries requestId (body + X-Request-Id header) and details", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/me");
    const headerId = res.headers.get("x-request-id");
    expect(headerId).toBeTruthy();
    const body = (await res.json()) as ErrorEnvelope;
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId).toBe(headerId);
    // `details` is a required key of the envelope: null when there is none.
    expect(body.error.details).toBeNull();
  });

  test("404 uses the same envelope with a requestId", async () => {
    const app = createApp();
    const res = await app.request("/no-such-route");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });
});

const loginDisabled = !passwordlessLoginAllowed();
const describeIfLoginDisabled = loginDisabled ? describe : describe.skip;

describeIfLoginDisabled("passwordless login disabled (default / production)", () => {
  test("POST /api/v1/auth/login with a valid email is 403 PASSWORDLESS_LOGIN_DISABLED", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.test" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("PASSWORDLESS_LOGIN_DISABLED");
  });
});

const databaseUrl = process.env.DATABASE_URL;
// Integration tests need a database AND the passwordless path enabled — run them
// with `AUTH_ALLOW_PASSWORDLESS_LOGIN=true DATABASE_URL=... bun test`.
const describeIfDb = databaseUrl && passwordlessLoginAllowed() ? describe : describe.skip;

describeIfDb("auth flow (integration)", () => {
  const client = postgres(databaseUrl ?? "", { max: 1 });
  const db = drizzle(client);
  const createdUserIds: string[] = [];

  async function seedUser(role: "admin" | "member"): Promise<{ id: string; email: string }> {
    const email = `berr24-${crypto.randomUUID()}@example.test`;
    const [row] = await db
      .insert(users)
      .values({ email, name: `Test ${role}`, role })
      .returning({ id: users.id });
    const id = must(row).id;
    createdUserIds.push(id);
    return { id, email };
  }

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id));
    }
    await client.end();
    await closeDb();
  });

  test("login issues a token and returns the user with its role", async () => {
    const app = createApp();
    const { email } = await seedUser("member");

    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      expiresAt: string;
      user: { email: string; role: string };
    };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.user.email).toBe(email);
    expect(body.user.role).toBe("member");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("login is case-insensitive on email and rejects unknown users with 401", async () => {
    const app = createApp();
    const { email } = await seedUser("member");

    const ok = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.toUpperCase() }),
    });
    expect(ok.status).toBe(200);

    const unknown = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `missing-${crypto.randomUUID()}@example.test` }),
    });
    expect(unknown.status).toBe(401);
    const body = (await unknown.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  test("me returns the authenticated user; logout revokes the session", async () => {
    const app = createApp();
    const { email } = await seedUser("member");

    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const { token } = (await login.json()) as { token: string };
    const authHeader = { authorization: `Bearer ${token}` };

    const me = await app.request("/api/v1/auth/me", { headers: authHeader });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(email);

    const logout = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: authHeader,
    });
    expect(logout.status).toBe(204);

    const meAfter = await app.request("/api/v1/auth/me", { headers: authHeader });
    expect(meAfter.status).toBe(401);
  });

  test("an expired session token does not authenticate", async () => {
    const app = createApp();
    const { id } = await seedUser("member");
    const token = "expired-token-fixture";
    await db.insert(sessions).values({
      userId: id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await app.request("/api/v1/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("requireRole gates a route to admins; the role is plumbed from the session", async () => {
    const roleApp = new Hono<AuthEnv>();
    roleApp.get("/admin-only", requireAuth, requireRole("admin"), (c) => c.json({ ok: true }));

    const app = createApp();
    const loginAs = async (email: string) => {
      const res = await app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      return ((await res.json()) as { token: string }).token;
    };

    const admin = await seedUser("admin");
    const member = await seedUser("member");
    const adminToken = await loginAs(admin.email);
    const memberToken = await loginAs(member.email);

    const asAdmin = await roleApp.request("/admin-only", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(asAdmin.status).toBe(200);

    const asMember = await roleApp.request("/admin-only", {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    // Status-only assertion: this bare app exercises the guard, not the central
    // envelope renderer (covered by the no-DB envelope test above).
    expect(asMember.status).toBe(403);
  });
});
