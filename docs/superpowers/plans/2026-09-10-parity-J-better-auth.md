# Parity J: Better Auth with GitHub-only sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Berry's hand-rolled password and opaque-session login with Better Auth, with GitHub as the only sign-in method. Keep `users.id`, personal API tokens, task-scoped bearer tokens, workspace membership and the SSE stream working.

**Architecture:** A Better Auth instance (`server-ts/src/auth/better-auth.ts`) talks to Postgres through a small `pg` Pool. It maps its user model onto the existing `users` table and keeps sessions, accounts and OAuth state in three new tables (`auth_sessions`, `auth_accounts`, `auth_verifications`). It is served at `/api/auth/*` through the mount registry. The existing `requireSession(sessions)` middleware keeps its name and signature, so the ~25 mounts using it do not change. Inside, `SessionService.resolveRequest(request)` accepts one of two credentials:
- an `Authorization: Bearer` header, dispatched to bearer resolvers (personal API tokens built in; workstream A can add task tokens);
- otherwise, the Better Auth session cookie, checked with `auth.api.getSession`.

The frontend drops its password forms and its sessionStorage bearer token. It uses `better-auth/react` for `signIn.social({ provider: 'github' })` and `signOut()`, and the cookie rides on every same-origin `fetch` (including the SSE `apiStream`).

**Tech Stack:**
- Server: Node 22 `--experimental-strip-types`, Hono 4, postgres.js, `better-auth@1.7.4` (MIT), `pg@8.23.0` (MIT), `@types/pg@8.23.1` (MIT), Zod v4, `node --test`.
- Frontend: Next.js 15, Zod v3, `better-auth@1.7.4` React client.

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md`, section 3a (workstream J). Executors read both documents.

## Global Constraints

- GitHub is the ONLY sign-in method. No Google, no email and password, no magic link. `emailAndPassword.enabled` is `false` and no magic-link, username or passkey plugin is added.
- Existing users keep their ids. Better Auth's user model is `users`. A GitHub account links to an existing user by a verified email (GitHub is not a trusted provider, so Better Auth links only when GitHub reports the address verified), and only a GitHub-verified email may create a user (a `databaseHooks.user.create.before` refusal in `better-auth.ts`).
- Existing sessions are invalidated at cutover. Migration 150 revokes every row in the legacy `sessions` table, and everyone signs in again with GitHub. Personal API tokens (`berry_pat_…`) keep working unchanged.
- Personal API tokens and task-scoped tokens stay valid as `Authorization: Bearer` credentials beside Better Auth sessions. A request that carries an `Authorization` header is authenticated by that header only and never falls back to the cookie.
- The SSE stream `GET /api/v1/events` authenticates with the session cookie.
- Workspace membership, invitations and the cross-tenant guards (`mountWorkspaceScope`, `resolveWorkspaceContext`, `boards.authorize*`) are not changed.
- The sign-in OAuth client id and secret are server config only: `BERRY_AUTH_GITHUB_CLIENT_ID`, `BERRY_AUTH_GITHUB_CLIENT_SECRET`, `BERRY_AUTH_SECRET`. Never `NEXT_PUBLIC_`.
- Sign-in is separate from repository access. The GitHub App (`src/integrations/github-app.ts`) and the legacy `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` connection OAuth are untouched. The sign-in OAuth App is a different GitHub OAuth App with only the `read:user` and `user:email` scopes.
- Migrations use block 150–159. They are forward-only, named `NNN_description.up.sql`, and an applied file is never edited.
- Server code has no emitted TS syntax (no enums, namespaces or parameter properties). Imports are relative with `.ts` extensions, types come in through `import type`, `strict` is on and `any` is not allowed. Server Zod is v4; frontend Zod is v3 (`^3.24.2`).
- Server style: 3-space indent, single quotes, 100 columns. Match the surrounding style, and write doc comments that say *why*.
- Frontend: Prettier 3-space, single quotes. The gates are `cd frontend && pnpm lint && pnpm build:check`.
- Server gates: `pnpm typecheck:server && pnpm test:server`. Database tests self-skip without `BERRY_TEST_DATABASE_URL`.
- Error envelope and codes are unchanged: a failed credential is the uniform 401 `UNAUTHENTICATED`.
- Realtime is unchanged: no WebSocket.
- Clean room: no multica code, copy or UI.
- Commits: `type(scope): imperative summary`, scope `server-ts` or `frontend`, and end with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- J merges first. Other workstreams keep writing `requireSession(options.sessions)` exactly as today.

## Cross-plan contract used by this plan

- Workstream A owns the `task_tokens` table and `/api/v1/agent-tools/*`. J does not define task tokens. J exports `BearerResolver` from `server-ts/src/auth/credentials.ts` and the `bearer` option of `SessionService`, so A can plug a task-token resolver into the shared middleware if it wants to. A's own mount may also keep its own middleware; J changes nothing under `/api/v1/agent-tools`.
- J owns migrations 150–159 only. It uses 150 and 151.
- Conflict to escalate, not to resolve here: the shared contract lists "Google OAuth" under workstream B, while spec 3a says GitHub is the only sign-in method. J adds no Google provider, and migration 150 pins `auth_accounts.provider_id = 'github'`. If B's "Google OAuth" means sign-in, it contradicts spec 3a; if it means a non-sign-in connection, it must not use Better Auth, `auth_accounts` or `/api/auth/*`.

## File Structure

**Server: create**
- `server-ts/migrations/150_better_auth.up.sql`: `users.email_verified`, lowercases emails, adds `auth_sessions`, `auth_accounts` and `auth_verifications`, and revokes legacy sessions.
- `server-ts/migrations/151_drop_password_credentials.up.sql`: drops the password and sign-up idempotency columns added by 050.
- `server-ts/src/auth/better-auth.ts`: `createBerryAuth(options)` builds the Better Auth instance; `devSessionCookies(auth, userId)` is the dev-login helper.
- `server-ts/src/auth/better-auth.test.ts`: database-gated. Covers a session for an existing user, linking a GitHub account by verified email, refusing an unverified email for an existing user, and refusing to create a new user from an unverified email.
- `server-ts/src/mounts/account.sessions.test.ts`: database-gated. The sessions settings list and delete only the caller's own `auth_sessions` rows (cross-user isolation).
- `server-ts/src/auth/credentials.ts`: the `BearerResolver` type and `personalTokenResolver(sql)`.
- `server-ts/src/auth/credentials.test.ts`: offline tests of the personal token resolver.
- `server-ts/src/auth/sessions.test.ts`: offline tests of `SessionService.resolveRequest` dispatch.
- `server-ts/src/auth/test-credentials.ts`: `issueTestToken(sql, userId)` mints a PAT for database tests.
- `server-ts/src/mounts/better-auth.ts`: `betterAuthMounts(auth)` serves `/api/auth/*`.
- `server-ts/src/mounts/better-auth.test.ts`: offline test that `/api/auth/ok` is served through the app shell.
- `server-ts/src/mounts/auth.test.ts`: offline tests for `GET /api/v1/auth/me` and the `dev-login` gate.
- `server-ts/src/mounts/events.auth.test.ts`: offline test that the SSE stream opens for a session cookie and refuses no credential.
- `server-ts/src/auth/no-password.test.ts`: guard test that no password code or column reference remains.
- Also modified in Task 10: `server-ts/ROUTING.md` (a new "Sign-in" section).

**Server: modify**
- `server-ts/package.json`: add dependencies.
- `server-ts/src/config/config.ts` and `server-ts/src/config/config.test.ts`: `auth: AuthConfig`.
- `server-ts/src/auth/tokens.ts` and `tokens.test.ts`: add `parseBearer`. `parseAuthorization` stays, because invitations use it (`identity/secrets.ts:323`).
- `server-ts/src/auth/sessions.ts`: rewritten `SessionService`. It keeps `User`, `Role`, `serializeUser` and `SessionUnauthenticated`, and drops password and token issuance.
- `server-ts/src/auth/middleware.ts` and `middleware.test.ts`: cookie or bearer, plus an `Origin` check for cookie-authenticated unsafe methods.
- `server-ts/src/mounts/auth.ts`: slimmed to `GET /me` and the dev-only `POST /dev-login`.
- `server-ts/src/mounts/account.ts`: the sessions list and delete read `auth_sessions`.
- `server-ts/src/mounts/platform.ts`: `Capabilities.githubSignIn`.
- `server-ts/src/index.ts`: wiring.
- `server-ts/src/mounts/cross-tenant-leakage.test.ts`, `workspace-reads.absent.property.test.ts`, `workspace-reads.cross-read.property.test.ts`: use `issueTestToken`.
- `server-ts/src/identity/repository.ts`: remove `createUserWithPassword`.
- `server-ts/src/seed/seed.ts`: remove `setUserPassword`.
- `docker-compose.yml`, `.env.example`, `scripts/check-compose-config.py`: new env names.
- `server-ts/SCOPE.md`, `docs/api/gateway-v1.md`, `AGENTS.md`: auth contract text.

**Server: delete**
- `server-ts/src/auth/password.ts`
- `server-ts/src/auth/password.test.ts`
- `server-ts/src/auth/password.verify.test.ts`
- `server-ts/src/auth/schemas.ts`
- `server-ts/src/auth/sessions.integration.test.ts`
- `server-ts/src/auth/sessions.issuance.test.ts`
- `server-ts/src/auth/sessions.lifecycle.test.ts`
- `server-ts/src/auth/sessions.ttl.test.ts`
- `server-ts/src/auth/middleware.faults.test.ts` and `server-ts/src/auth/middleware.property.test.ts`: folded into the new `middleware.test.ts`.
- `server-ts/src/mounts/auth.idempotency.test.ts`
- `server-ts/src/mounts/auth.passwordless.property.test.ts`
- `server-ts/src/mounts/auth.signin.test.ts`

**Frontend**
- Create `frontend/lib/auth-client.ts`.
- Modify:
  - `frontend/lib/auth.ts`
  - `frontend/store/session-store.ts`
  - `frontend/components/auth/use-sign-out.ts`
  - `frontend/components/auth/auth-card.tsx` (comment only)
  - `frontend/components/layout/session-gate.tsx`
  - `frontend/app/sign-in/page.tsx`
  - `frontend/lib/config.ts` (`AUTO_LOGIN_EMAIL` comment)
  - `frontend/package.json`
- Delete `frontend/lib/session.ts` and `frontend/app/sign-up/page.tsx`.
- Keep `frontend/app/login/page.tsx`, which redirects to `/sign-in`, so there is one sign-in page.

## Task order and parallelism

- Tasks 1, 2 and 4 can start at once. Task 4 only adds files; it needs Task 1's config type only through `tsc`.
- Task 3 needs 1 and 2.
- Task 5 needs 1 and 4. It is the credential cutover.
- Task 6 needs 3 and 5.
- Task 7 needs 5.
- Tasks 8 and 9 (frontend) need only the HTTP contract below. Give them to one subagent, back to back, starting at once. Their manual check (Task 9, step 4) runs after Task 6.
- Task 10 is last.

Each task ends with the server tree compiling and `pnpm test:server` green. The frontend build is green again at the end of Task 9.

**HTTP contract (frozen for the frontend):**
- `POST /api/auth/sign-in/social`, body `{ provider: 'github', callbackURL, errorCallbackURL }`. This is Better Auth's own route and returns `{ url, redirect: true }`.
- `GET /api/auth/callback/github`: GitHub redirects here and it sets the `berry.session_token` cookie. The error redirect is `errorCallbackURL?error=<code>`.
- `POST /api/auth/sign-out` (Better Auth).
- `GET /api/v1/auth/me` returns the `serializeUser` shape.
- `POST /api/v1/auth/dev-login` takes `{ email }` and returns `{ user }` plus `Set-Cookie`. It exists only when `APP_ENV` is `development` or `test` and `AUTH_ALLOW_PASSWORDLESS_LOGIN` is true; otherwise it answers 404 `ROUTE_NOT_FOUND`.
- `GET /api/v1/config` gains `capabilities.githubSignIn: boolean`.
- `POST /api/v1/auth/login`, `/sign-in`, `/sign-up`, `/sign-out` and `/logout` are removed and answer 404.

---

### Task 1: Dependencies and auth configuration

**Files:**
- Modify: `server-ts/package.json`
- Modify: `server-ts/src/config/config.ts`: the `Config` interface (lines 8-52), `loadConfig` (lines 237-283), and a new `auth()` reader beside `integrations()` (line 480)
- Test: `server-ts/src/config/config.test.ts`
- Modify: `docker-compose.yml` (the `berry-api` environment, near lines 43-44 and 136-143), `.env.example` (near line 24), `scripts/check-compose-config.py` (the pinned `env.update` dict, near line 48)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface AuthConfig {
     /** >= 32 chars. Null disables cookie sessions (bearer tokens still work). */
     secret: string | null;
     /** The browser-facing origin Better Auth builds callback URLs on. */
     baseUrl: string | null;
     /** Origins allowed to send cookie-authenticated unsafe requests. */
     trustedOrigins: string[];
     /** The sign-in OAuth App. Separate from integrations.github. */
     github: { clientId: string; clientSecret: string } | null;
     /** Development-only known-email login (dev-login route + testUtils plugin). */
     devLogin: boolean;
  }
  // Config gains: auth: AuthConfig
  ```

- [ ] **Step 1: Add the dependencies**

Run from the repo root:
```bash
pnpm --filter @berry/server add better-auth@1.7.4 pg@8.23.0
pnpm --filter @berry/server add -D @types/pg@8.23.1
```
Expected: `server-ts/package.json` lists `"better-auth": "1.7.4"` (pin exactly; remove any `^` pnpm adds), `"pg": "^8.23.0"`, and dev `"@types/pg": "^8.23.1"`. All three are MIT.

- [ ] **Step 2: Write the failing config tests**

Append to `server-ts/src/config/config.test.ts`. Keep the file's existing imports; add `loadConfig` and `ConfigError` if they are not imported yet.

```ts
const BASE_ENV = { DATABASE_URL: 'postgres://berry@localhost/berry' };

test('sign-in auth is off without a secret outside development', () => {
   const config = loadConfig({ ...BASE_ENV, APP_ENV: 'production' });
   assert.equal(config.auth.secret, null);
   assert.equal(config.auth.github, null);
   assert.equal(config.auth.devLogin, false);
});

test('development gets a stable fallback secret so a fresh checkout can sign in', () => {
   const first = loadConfig({ ...BASE_ENV, APP_ENV: 'development' });
   const second = loadConfig({ ...BASE_ENV, APP_ENV: 'development' });
   assert.ok(first.auth.secret && first.auth.secret.length >= 32);
   assert.equal(first.auth.secret, second.auth.secret);
});

test('an unset APP_ENV gets neither the fallback secret nor dev login', () => {
   const config = loadConfig({ ...BASE_ENV, AUTH_ALLOW_PASSWORDLESS_LOGIN: 'true' });
   assert.equal(config.auth.secret, null);
   assert.equal(config.auth.devLogin, false);
});

test('a short auth secret is refused at boot', () => {
   assert.throws(
      () => loadConfig({ ...BASE_ENV, BERRY_AUTH_SECRET: 'too-short' }),
      (error: unknown) =>
         error instanceof ConfigError && /BERRY_AUTH_SECRET/.test(error.message)
   );
});

test('half a GitHub sign-in credential is refused at boot', () => {
   assert.throws(
      () =>
         loadConfig({
            ...BASE_ENV,
            BERRY_AUTH_SECRET: 'x'.repeat(32),
            BERRY_AUTH_GITHUB_CLIENT_ID: 'Iv1.abc',
         }),
      (error: unknown) =>
         error instanceof ConfigError && /BERRY_AUTH_GITHUB_CLIENT_SECRET/.test(error.message)
   );
});

test('GitHub sign-in in production needs an explicit secret', () => {
   assert.throws(
      () =>
         loadConfig({
            ...BASE_ENV,
            APP_ENV: 'production',
            BERRY_AUTH_GITHUB_CLIENT_ID: 'Iv1.abc',
            BERRY_AUTH_GITHUB_CLIENT_SECRET: 'shh',
         }),
      (error: unknown) => error instanceof ConfigError && /BERRY_AUTH_SECRET/.test(error.message)
   );
});

test('sign-in credentials are separate from the integrations GitHub credential', () => {
   const config = loadConfig({
      ...BASE_ENV,
      BERRY_AUTH_SECRET: 'x'.repeat(32),
      BERRY_AUTH_GITHUB_CLIENT_ID: 'signin-id',
      BERRY_AUTH_GITHUB_CLIENT_SECRET: 'signin-secret',
      GITHUB_CLIENT_ID: 'integration-id',
      GITHUB_CLIENT_SECRET: 'integration-secret',
   });
   assert.deepEqual(config.auth.github, { clientId: 'signin-id', clientSecret: 'signin-secret' });
   assert.deepEqual(config.integrations.github, {
      clientId: 'integration-id',
      clientSecret: 'integration-secret',
   });
});

test('the auth base URL is the app origin, and both origins are trusted', () => {
   const config = loadConfig({
      ...BASE_ENV,
      BERRY_AUTH_SECRET: 'x'.repeat(32),
      BERRY_APP_URL: 'https://app.berry.test/',
      BERRY_PUBLIC_URL: 'https://api.berry.test',
   });
   assert.equal(config.auth.baseUrl, 'https://app.berry.test');
   assert.deepEqual(config.auth.trustedOrigins, [
      'https://app.berry.test',
      'https://api.berry.test',
   ]);
});

test('dev login needs both the flag and a development environment', () => {
   assert.equal(
      loadConfig({ ...BASE_ENV, APP_ENV: 'development', AUTH_ALLOW_PASSWORDLESS_LOGIN: 'true' })
         .auth.devLogin,
      true
   );
   assert.equal(
      loadConfig({
         ...BASE_ENV,
         APP_ENV: 'production',
         BERRY_AUTH_SECRET: 'x'.repeat(32),
         AUTH_ALLOW_PASSWORDLESS_LOGIN: 'true',
      }).auth.devLogin,
      false
   );
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `cd server-ts && node --test --experimental-strip-types src/config/config.test.ts`
Expected: FAIL. `config.auth` is undefined.

- [ ] **Step 4: Implement `AuthConfig`**

In `server-ts/src/config/config.ts`:

1. Add `auth: AuthConfig;` to `Config`, after `allowPasswordlessLogin`, with the doc comment `/** Better Auth: GitHub-only sign-in. See AuthConfig. */`. Add the `AuthConfig` interface from the Interfaces block below `IntegrationsConfig`.
2. In `loadConfig`, compute the auth config before the problems check:
   ```ts
   const appEnv = (env.APP_ENV ?? 'development').trim();
   const authConfig = auth(env, appEnv, problems);
   ```
   Keep this before the existing `if (problems.length > 0) throw ...`. In the returned object use `appEnv,` and add `auth: authConfig,` after `allowPasswordlessLogin`.
3. Add the reader below `integrations()`:

```ts
/**
 * A development-only secret, fixed rather than generated.
 *
 * Generated would differ between restarts and sign everyone out on every
 * reload; fixed and public is acceptable only because it is never used outside
 * development and test, which is checked below.
 */
const DEVELOPMENT_AUTH_SECRET = 'berry-development-only-auth-secret-do-not-deploy';

/**
 * Sign-in, which is Better Auth with GitHub and nothing else.
 *
 * Its GitHub credential has its own names on purpose: GITHUB_CLIENT_ID belongs
 * to the repository connection, and one OAuth App serving both would give
 * sign-in the repository scopes and repositories the sign-in callback.
 */
function auth(env: NodeJS.ProcessEnv, _appEnv: string, problems: string[]): AuthConfig {
   // Explicit APP_ENV only. `appEnv` defaults to 'development' when unset, and
   // a production host that forgot APP_ENV must not get the public fixed secret
   // or dev-login. Compose sets APP_ENV (default development), so local stacks
   // are unaffected.
   const development = ['development', 'test'].includes((env.APP_ENV ?? '').trim().toLowerCase());
   const explicit = (env.BERRY_AUTH_SECRET ?? '').trim();
   if (explicit && explicit.length < 32) {
      problems.push('BERRY_AUTH_SECRET must be at least 32 characters');
   }
   const secret = explicit.length >= 32 ? explicit : development ? DEVELOPMENT_AUTH_SECRET : null;

   const clientId = (env.BERRY_AUTH_GITHUB_CLIENT_ID ?? '').trim();
   const clientSecret = (env.BERRY_AUTH_GITHUB_CLIENT_SECRET ?? '').trim();
   if (clientId && !clientSecret) problems.push('BERRY_AUTH_GITHUB_CLIENT_SECRET is required with BERRY_AUTH_GITHUB_CLIENT_ID');
   if (clientSecret && !clientId) problems.push('BERRY_AUTH_GITHUB_CLIENT_ID is required with BERRY_AUTH_GITHUB_CLIENT_SECRET');
   const github = clientId && clientSecret ? { clientId, clientSecret } : null;
   if (github && !explicit && !development) {
      problems.push('BERRY_AUTH_SECRET is required when GitHub sign-in is configured');
   }

   const appUrl = origin(env.BERRY_APP_URL);
   const publicUrl = origin(env.BERRY_PUBLIC_URL);
   const baseUrl = appUrl ?? publicUrl ?? (development ? 'http://localhost:3000' : null);
   const trustedOrigins = [...new Set([appUrl, publicUrl, baseUrl].filter((value): value is string => value !== null))];

   return {
      secret,
      baseUrl,
      trustedOrigins,
      github,
      devLogin: development && boolean(env.AUTH_ALLOW_PASSWORDLESS_LOGIN, true),
   };
}
```
Wrap any line past 100 columns.

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `cd server-ts && node --test --experimental-strip-types src/config/config.test.ts`
Expected: PASS. Then run `pnpm typecheck:server` from the repo root. Expected: PASS (nothing reads `config.auth` yet).

- [ ] **Step 6: Wire the env names into Compose and the example file**

In `docker-compose.yml`, under the `berry-api` `environment:` block and next to `AUTH_ALLOW_PASSWORDLESS_LOGIN`, add:
```yaml
      # Sign-in (Better Auth, GitHub only). A separate GitHub OAuth App from
      # GITHUB_CLIENT_ID below, with callback <BERRY_APP_URL>/api/auth/callback/github.
      # Server-side only: never mirror these into a NEXT_PUBLIC_* variable.
      BERRY_AUTH_SECRET: "${BERRY_AUTH_SECRET:-}"
      BERRY_AUTH_GITHUB_CLIENT_ID: "${BERRY_AUTH_GITHUB_CLIENT_ID:-}"
      BERRY_AUTH_GITHUB_CLIENT_SECRET: "${BERRY_AUTH_GITHUB_CLIENT_SECRET:-}"
```
In `.env.example`, after `AUTH_ALLOW_PASSWORDLESS_LOGIN=true`, add:
```bash
# Sign-in is GitHub only (Better Auth). Register a GitHub OAuth App — not the
# repository GitHub App — with callback URL http://localhost:3000/api/auth/callback/github.
# BERRY_AUTH_SECRET: at least 32 random characters (openssl rand -base64 32).
# Development falls back to a fixed, public secret; production refuses to boot without one.
BERRY_AUTH_SECRET=
BERRY_AUTH_GITHUB_CLIENT_ID=
BERRY_AUTH_GITHUB_CLIENT_SECRET=
```
In `scripts/check-compose-config.py`, add `"BERRY_AUTH_SECRET": "",`, `"BERRY_AUTH_GITHUB_CLIENT_ID": ""` and `"BERRY_AUTH_GITHUB_CLIENT_SECRET": ""` to the pinned `env.update({...})` dict, keeping it alphabetical.

Run: `python3 scripts/check-compose-config.py`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server-ts/package.json pnpm-lock.yaml server-ts/pnpm-lock.yaml server-ts/src/config docker-compose.yml .env.example scripts/check-compose-config.py
git commit -m "feat(server-ts): configure GitHub-only sign-in apart from the repository App

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
(`git add` of a lockfile that did not change is a no-op; stage whichever lockfile pnpm touched.)

---

### Task 2: Migration 150, the Better Auth tables

**Files:**
- Create: `server-ts/migrations/150_better_auth.up.sql`

**Interfaces:**
- Consumes: `users` (id uuid, email with a unique index on `lower(email)`), and the legacy `sessions` table (`revoked_at`, from migration 004).
- Produces these tables and columns for Task 3's field mapping. The names are exact:
  - `users.email_verified boolean NOT NULL DEFAULT false`
  - `auth_sessions(id uuid, user_id uuid, token text UNIQUE, expires_at, ip_address, user_agent, created_at, updated_at)`
  - `auth_accounts(id uuid, user_id uuid, account_id text, provider_id text, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)`
  - `auth_verifications(id uuid, identifier text, value text, expires_at, created_at, updated_at)`

- [ ] **Step 1: Write the migration**

Create `server-ts/migrations/150_better_auth.up.sql`:

```sql
-- Sign-in moves to Better Auth, with GitHub as the only method (workstream J).
--
-- Better Auth's user model is the existing users table, so every user keeps
-- the id their workspaces, issues and tokens already point at. Sessions,
-- linked provider accounts and OAuth state get tables of their own: Better
-- Auth stores its session token as it is (the cookie is signed), which is a
-- different contract from the hashed bearer tokens in `sessions`, and mixing
-- the two in one table would make every row ambiguous.

-- Better Auth reads and writes this. Existing users start unverified; linking
-- relies on GitHub's verified email, not on this flag (see src/auth/better-auth.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- Better Auth looks users up by the lowercased address. The unique index on
-- lower(email) already rules out two users that differ only in case, so this
-- cannot collide; it only makes the stored spelling match the lookup.
UPDATE users SET email = lower(email) WHERE email <> lower(email);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token text NOT NULL,
    expires_at timestamptz NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_key ON auth_sessions (token);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_accounts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    -- Present only because Better Auth's account model has the column and
    -- selects it. Berry has no password sign-in, so it can never hold one.
    password text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_accounts_no_password_ck CHECK (password IS NULL),
    CONSTRAINT auth_accounts_github_only_ck CHECK (provider_id = 'github')
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_accounts_provider_account_key
    ON auth_accounts (provider_id, account_id);
CREATE INDEX IF NOT EXISTS auth_accounts_user_idx ON auth_accounts (user_id);

CREATE TABLE IF NOT EXISTS auth_verifications (
    id uuid PRIMARY KEY,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx ON auth_verifications (identifier);

-- Cutover: every session issued by the old login is ended. Nothing reads this
-- table after this release, and revoking rather than deleting keeps the record
-- that the access existed. Personal API tokens are a different table and keep
-- working.
UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;
```

- [ ] **Step 2: Apply it to a scratch database and confirm it is idempotent in shape**

Run, against the local Compose database (the same one `pnpm migrate:server` uses):
```bash
DATABASE_URL='postgres://berry:berry@127.0.0.1:5432/berry?sslmode=disable' pnpm migrate:server
psql 'postgres://berry:berry@127.0.0.1:5432/berry' -c '\d auth_sessions' -c '\d auth_accounts' -c '\d auth_verifications' -c "SELECT count(*) FILTER (WHERE revoked_at IS NULL) AS live FROM sessions"
```
Expected: the migrate command logs `150_better_auth` applied; all three tables are described; `live` is `0`. If port 5432 is shadowed by a host Postgres, use the socat bridge from `server-ts/ROUTING.md` ("Running the database-backed tests").

Then apply it to the test database through the runner, so the ledger records it (a bare `psql -f` would leave the ledger behind and make the next runner pass re-apply it):
```bash
DATABASE_URL="$BERRY_TEST_DATABASE_URL" pnpm migrate:server
```
Expected: `150_better_auth` applied, no error.

Note on ordering with other workstreams: the runner applies every file not in the ledger in ascending order and does not refuse a lower number after a higher one (`src/migrate/migrations.ts`), so A's 053+ can land after J's 150 and still apply.

- [ ] **Step 3: Commit**

```bash
git add server-ts/migrations/150_better_auth.up.sql
git commit -m "feat(server-ts): add the Better Auth session, account and verification tables

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: The Better Auth instance, mapped onto `users`

**Files:**
- Create: `server-ts/src/auth/better-auth.ts`
- Test: `server-ts/src/auth/better-auth.test.ts` (database-gated)

**Interfaces:**
- Consumes: `AuthConfig` (Task 1) and the tables from migration 150 (Task 2).
- Produces:
  ```ts
  export interface BerryAuthOptions {
     pool: Pool;                      // import type { Pool } from 'pg'
     secret: string;
     baseUrl: string;
     trustedOrigins: string[];
     github: { clientId: string; clientSecret: string } | null;
     sessionTtlMs: number;
     /** Enables Better Auth's testUtils plugin: dev-login and tests only. */
     testUtils?: boolean;
  }
  export function createBerryAuth(options: BerryAuthOptions): BerryAuth;
  export type BerryAuth = ReturnType<typeof createBerryAuth>;
  export const AUTH_BASE_PATH = '/api/auth';
  export const SESSION_COOKIE_PREFIX = 'berry';
  /** Set-Cookie header values for a fresh session; requires testUtils: true. */
  export function devSessionCookies(auth: BerryAuth, userId: string): Promise<string[]>;
  ```

- [ ] **Step 1: Write the failing database-gated tests**

Create `server-ts/src/auth/better-auth.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';

import pg from 'pg';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createBerryAuth, devSessionCookies, type BerryAuth } from './better-auth.ts';

/**
 * Better Auth against the real schema. Gated like every database test: without
 * BERRY_TEST_DATABASE_URL this skips and the default suite stays offline.
 * The test database needs migration 150 (see Task 2, step 2).
 *
 * GitHub is never contacted. Better Auth reaches GitHub with the global
 * `fetch`, so the three GitHub endpoints are answered by a stub for the length
 * of each OAuth test and every other URL is refused, so a surprise call fails
 * loudly instead of reaching the network.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;
const BASE = 'http://localhost:3000';

interface GitHubFixture {
   id: number;
   email: string;
   verified: boolean;
}

function stubGitHub(fixture: GitHubFixture): () => void {
   const original = globalThis.fetch;
   globalThis.fetch = (async (input: string | URL | Request) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const reply = (body: unknown) =>
         new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target.startsWith('https://github.com/login/oauth/access_token')) {
         return reply({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' });
      }
      if (target === 'https://api.github.com/user/emails') {
         return reply([{ email: fixture.email, primary: true, verified: fixture.verified, visibility: 'public' }]);
      }
      if (target === 'https://api.github.com/user') {
         return reply({
            id: fixture.id,
            login: 'ada-gh',
            name: 'Ada GitHub',
            email: null,
            avatar_url: `https://avatars.githubusercontent.com/u/${fixture.id}`,
         });
      }
      throw new Error(`unexpected fetch in test: ${target}`);
   }) as typeof fetch;
   return () => {
      globalThis.fetch = original;
   };
}

function cookieHeader(response: Response): string {
   return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
}

/** Drives the full GitHub round trip through Better Auth's own handler. */
async function signInWithGitHub(auth: BerryAuth): Promise<Response> {
   const start = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/social`, {
         method: 'POST',
         headers: { 'content-type': 'application/json', origin: BASE },
         body: JSON.stringify({
            provider: 'github',
            callbackURL: `${BASE}/`,
            errorCallbackURL: `${BASE}/sign-in`,
         }),
      })
   );
   assert.equal(start.status, 200, await start.clone().text());
   const { url: authorize } = (await start.json()) as { url: string };
   const state = new URL(authorize).searchParams.get('state');
   assert.ok(state, 'the authorize URL carries a state');

   return auth.handler(
      new Request(`${BASE}/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`, {
         headers: { cookie: cookieHeader(start) },
      })
   );
}

describe('Better Auth on the users table', { skip: !url }, () => {
   let sql: Sql;
   let pool: pg.Pool;
   let auth: BerryAuth;
   const created: string[] = [];

   before(() => {
      sql = openDatabase({ url: url! });
      pool = new pg.Pool({ connectionString: url, max: 2 });
      auth = createBerryAuth({
         pool,
         secret: 'test-secret-that-is-at-least-32-characters',
         baseUrl: BASE,
         trustedOrigins: [BASE],
         github: { clientId: 'test-client', clientSecret: 'test-secret' },
         sessionTtlMs: 60 * 60 * 1000,
         testUtils: true,
      });
   });

   afterEach(async () => {
      // auth_sessions and auth_accounts cascade from users.
      for (const id of created.splice(0)) await sql`DELETE FROM users WHERE id = ${id}`;
   });

   after(async () => {
      await pool.end();
      await closeDatabase(sql);
   });

   async function existingUser(email: string): Promise<string> {
      const id = randomUUID();
      await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${email}, 'Existing')`;
      created.push(id);
      return id;
   }

   test('a session minted for an existing user resolves to the same users.id', async () => {
      const id = await existingUser(`keep-${randomUUID()}@berry.test`);
      const cookies = await devSessionCookies(auth, id);
      assert.ok(cookies.some((cookie) => cookie.startsWith('berry.session_token=')));
      const session = await auth.api.getSession({
         headers: new Headers({ cookie: cookies.map((c) => c.split(';')[0]).join('; ') }),
      });
      assert.equal(session?.user.id, id);
      const [row] = await sql`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = ${id}`;
      assert.equal(row?.n, 1);
   });

   test('a GitHub account with a verified email links to the existing user', async () => {
      const email = `link-${randomUUID()}@berry.test`;
      const id = await existingUser(email);
      const restore = stubGitHub({ id: 4242001, email, verified: true });
      try {
         const callback = await signInWithGitHub(auth);
         assert.equal(callback.status, 302);
         assert.equal(callback.headers.get('location'), `${BASE}/`);
         assert.match(callback.headers.getSetCookie().join('\n'), /berry\.session_token=/);
      } finally {
         restore();
      }
      const accounts = await sql`
         SELECT user_id, provider_id, account_id FROM auth_accounts WHERE account_id = '4242001'`;
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0]?.user_id, id);
      assert.equal(accounts[0]?.provider_id, 'github');
      const users = await sql`SELECT id FROM users WHERE lower(email) = ${email}`;
      assert.equal(users.length, 1, 'no second user was created');
   });

   test('an unverified GitHub email neither links nor signs in', async () => {
      const email = `unverified-${randomUUID()}@berry.test`;
      const id = await existingUser(email);
      const restore = stubGitHub({ id: 4242002, email, verified: false });
      let callback: Response;
      try {
         callback = await signInWithGitHub(auth);
      } finally {
         restore();
      }
      assert.equal(callback.status, 302);
      const location = new URL(callback.headers.get('location') ?? '', BASE);
      assert.equal(location.pathname, '/sign-in');
      assert.ok(location.searchParams.get('error'), 'the error code is on the redirect');
      assert.doesNotMatch(callback.headers.getSetCookie().join('\n'), /berry\.session_token=[^;]+/);
      const accounts = await sql`SELECT 1 FROM auth_accounts WHERE user_id = ${id}`;
      assert.equal(accounts.length, 0);
   });

   test('an unverified GitHub email never creates a new Berry user', async () => {
      // No existing user: this is the sign-up path, which account linking does
      // not guard. Only the create hook in better-auth.ts refuses it.
      const email = `new-unverified-${randomUUID()}@berry.test`;
      const restore = stubGitHub({ id: 4242003, email, verified: false });
      let callback: Response;
      try {
         callback = await signInWithGitHub(auth);
      } finally {
         restore();
      }
      assert.equal(callback.status, 302);
      const location = new URL(callback.headers.get('location') ?? '', BASE);
      assert.equal(location.pathname, '/sign-in');
      assert.doesNotMatch(callback.headers.getSetCookie().join('\n'), /berry\.session_token=[^;]+/);
      const users = await sql`SELECT id FROM users WHERE lower(email) = ${email}`;
      for (const row of users) created.push(row.id as string);
      assert.equal(users.length, 0, 'no user was created from an unverified address');
      const accounts = await sql`SELECT 1 FROM auth_accounts WHERE account_id = '4242003'`;
      assert.equal(accounts.length, 0);
   });

   test('email and password sign-up is not served', async () => {
      const response = await auth.handler(
         new Request(`${BASE}/api/auth/sign-up/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: BASE },
            body: JSON.stringify({ email: 'x@berry.test', password: 'long-enough-password', name: 'x' }),
         })
      );
      assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
   });

   test('routes that bypass Berry or expose the GitHub token are not served', async () => {
      const id = await existingUser(`paths-${randomUUID()}@berry.test`);
      const cookie = (await devSessionCookies(auth, id)).map((c) => c.split(';')[0]).join('; ');
      for (const [method, path] of [
         ['POST', '/update-user'],
         ['POST', '/get-access-token'],
         ['POST', '/refresh-token'],
         ['GET', '/account-info'],
      ] as const) {
         const response = await auth.handler(
            new Request(`${BASE}/api/auth${path}`, {
               method,
               headers: { 'content-type': 'application/json', origin: BASE, cookie },
               body: method === 'POST' ? JSON.stringify({ providerId: 'github', name: 'x' }) : undefined,
            })
         );
         assert.equal(response.status, 404, `${method} ${path}`);
      }
      const [row] = await sql`SELECT name FROM users WHERE id = ${id}`;
      assert.equal(row?.name, 'Existing', 'update-user did not write the users row');
   });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd server-ts && BERRY_TEST_DATABASE_URL="$BERRY_TEST_DATABASE_URL" node --test --experimental-strip-types src/auth/better-auth.test.ts`
Expected: FAIL. `Cannot find module './better-auth.ts'`. Without the variable, the suite reports as skipped; run it with the database for this task.

- [ ] **Step 3: Implement `createBerryAuth`**

Create `server-ts/src/auth/better-auth.ts`:

```ts
import { betterAuth } from 'better-auth';
import { testUtils, type TestHelpers } from 'better-auth/plugins';
import type { Pool } from 'pg';

/**
 * Sign-in: Better Auth with GitHub and nothing else.
 *
 * Better Auth's user model *is* `users`, so an account keeps the id every
 * workspace, issue and token already points at. Its own state — sessions,
 * linked accounts, OAuth state — lives in the auth_* tables from migration 150.
 *
 * It talks to Postgres through a small `pg` pool rather than the server's
 * postgres.js client because its Kysely adapter speaks `pg`; the pool is sized
 * for sign-in and session lookups, not for product queries.
 */

export const AUTH_BASE_PATH = '/api/auth';
export const SESSION_COOKIE_PREFIX = 'berry';

export interface BerryAuthOptions {
   pool: Pool;
   secret: string;
   baseUrl: string;
   trustedOrigins: string[];
   github: { clientId: string; clientSecret: string } | null;
   sessionTtlMs: number;
   testUtils?: boolean;
}

export function createBerryAuth(options: BerryAuthOptions) {
   return betterAuth({
      appName: 'Berry',
      baseURL: options.baseUrl,
      basePath: AUTH_BASE_PATH,
      secret: options.secret,
      trustedOrigins: options.trustedOrigins,
      database: options.pool,
      // GitHub is the only way in. Stated rather than left to the default so
      // a future default cannot quietly open a second door.
      emailAndPassword: { enabled: false },
      // Better Auth routes that would bypass Berry: /update-user writes
      // users.name and users.avatar_url without the profile validation in
      // mounts/me.ts, and the token routes hand the stored GitHub OAuth token
      // (or GitHub's profile) to browser JavaScript. Sign-in needs none of them.
      disabledPaths: ['/update-user', '/get-access-token', '/refresh-token', '/account-info'],
      socialProviders: options.github
         ? {
              github: {
                 clientId: options.github.clientId,
                 clientSecret: options.github.clientSecret,
              },
           }
         : {},
      user: {
         modelName: 'users',
         fields: {
            image: 'avatar_url',
            emailVerified: 'email_verified',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
         },
         changeEmail: { enabled: false },
         deleteUser: { enabled: false },
      },
      databaseHooks: {
         user: {
            create: {
               // Better Auth has no "verified email only" switch for social
               // sign-up: linking an *existing* user already needs GitHub's
               // verified flag (it is not a trusted provider), but a *new* user
               // would be created from an unverified address. Refused here, so
               // an unverified GitHub email never becomes a Berry account.
               // Returning false aborts the create; the callback redirects to
               // errorCallbackURL with an error code.
               before: async (user) => (user.emailVerified === true ? { data: user } : false),
            },
         },
      },
      session: {
         modelName: 'auth_sessions',
         fields: {
            userId: 'user_id',
            expiresAt: 'expires_at',
            ipAddress: 'ip_address',
            userAgent: 'user_agent',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
         },
         expiresIn: Math.floor(options.sessionTtlMs / 1000),
      },
      account: {
         modelName: 'auth_accounts',
         fields: {
            userId: 'user_id',
            accountId: 'account_id',
            providerId: 'provider_id',
            accessToken: 'access_token',
            refreshToken: 'refresh_token',
            idToken: 'id_token',
            accessTokenExpiresAt: 'access_token_expires_at',
            refreshTokenExpiresAt: 'refresh_token_expires_at',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
         },
         // Sign-in never uses the GitHub token again, but if it is kept it is
         // kept sealed.
         encryptOAuthTokens: true,
         accountLinking: {
            enabled: true,
            // Not trusted by name: linking happens only on a GitHub-verified
            // address (userInfo.emailVerified from GitHub's /user/emails).
            trustedProviders: [],
            allowDifferentEmails: false,
            // Existing Berry users were never email-verified: they signed in
            // with a password or a dev login. The proof of ownership is
            // GitHub's verified address, and with password sign-in gone there
            // is no other way to create an unverified local user.
            requireLocalEmailVerified: false,
         },
      },
      verification: {
         modelName: 'auth_verifications',
         fields: {
            expiresAt: 'expires_at',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
         },
      },
      advanced: {
         cookiePrefix: SESSION_COOKIE_PREFIX,
         // users.id and every auth_* id are uuid columns.
         database: { generateId: 'uuid' },
      },
      plugins: options.testUtils ? [testUtils()] : [],
   });
}

export type BerryAuth = ReturnType<typeof createBerryAuth>;

/**
 * A signed session cookie for a user, as Set-Cookie header values.
 *
 * Only for the development dev-login route and tests: it needs the testUtils
 * plugin, which `createBerryAuth` installs only when asked to.
 */
export async function devSessionCookies(auth: BerryAuth, userId: string): Promise<string[]> {
   const context = (await auth.$context) as unknown as { test?: TestHelpers };
   if (!context.test) throw new Error('devSessionCookies needs createBerryAuth({ testUtils: true })');
   const { cookies } = await context.test.login({ userId });
   return cookies.map((cookie) => {
      const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path ?? '/'}`, 'HttpOnly'];
      parts.push(`SameSite=${cookie.sameSite ?? 'Lax'}`);
      if (cookie.secure) parts.push('Secure');
      if (typeof cookie.expires === 'number') {
         parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
      }
      return parts.join('; ');
   });
}
```

If `tsc` reports that a field in `cookies` has a different name or type in `better-auth@1.7.4` (`sameSite` casing, or `expires` as a `Date` rather than seconds), fix the serializer against the installed type in `node_modules/better-auth/dist/plugins/test-utils/*.d.ts` and keep the output shape: `name=value; Path=/; HttpOnly; SameSite=Lax[; Secure][; Expires=…]`. If a Better Auth option key above is not in the installed `BetterAuthOptions` type (for example `accountLinking.requireLocalEmailVerified`, `account.encryptOAuthTokens`, `advanced.database.generateId`, or the `databaseHooks.user.create.before` return shape), stop and report it rather than dropping it: the linking options and the create hook are load-bearing for "only a GitHub-verified email signs in". Do not add `requireEmailVerification` to the GitHub provider: it is an email-and-password option, not a social-provider one.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd server-ts && BERRY_TEST_DATABASE_URL="$BERRY_TEST_DATABASE_URL" node --test --experimental-strip-types src/auth/better-auth.test.ts`
Expected: 6 passing. Then run `pnpm typecheck:server`; expected PASS. (`disabledPaths` is in the installed `BetterAuthOptions`; if the disabled-routes test gets anything but 404, stop and report rather than loosening it.)

If either unverified-email test gets a 302 to `/` with a session, the verified-email guard (account linking for an existing user, the `databaseHooks.user.create.before` refusal for a new one) is not being honoured. Stop and report it rather than weakening the test.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/auth/better-auth.ts server-ts/src/auth/better-auth.test.ts
git commit -m "feat(server-ts): map Better Auth onto users with GitHub as the only provider

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: Bearer resolvers (personal tokens, and the hook for task tokens)

Additive only: nothing calls these yet, so the tree keeps compiling and every existing test still passes.

**Files:**
- Create: `server-ts/src/auth/credentials.ts`
- Create: `server-ts/src/auth/test-credentials.ts`
- Modify: `server-ts/src/auth/tokens.ts` (add `parseBearer` after `parseAuthorization`, line ~137)
- Test: `server-ts/src/auth/credentials.test.ts` (new), `server-ts/src/auth/tokens.test.ts` (append)

**Interfaces:**
- Consumes: `generatePersonalToken`, `isPersonalToken`, `parsePersonalToken`, `secretMatches`, `digestToken` and `Unauthenticated` from `tokens.ts`; `User` and `Role` from `sessions.ts` (unchanged in this task).
- Produces:
  ```ts
  // tokens.ts
  /** Strict `Bearer <token>`: one space, no other whitespace, token of [A-Za-z0-9._~+/=-]{1,512}.
   *  A token in the berry_pat_ namespace must also be a well-formed PAT. Throws Unauthenticated. */
  export function parseBearer(header: string | null | undefined): string;

  // credentials.ts
  export interface BearerResolver {
     /** A short name for logs, e.g. 'personal-token'. */
     readonly name: string;
     /** Whether this resolver owns the token's namespace. Checked in order; first match wins. */
     matches(token: string): boolean;
     /** Resolve or throw. Any throw is answered with the uniform 401. */
     resolve(token: string): Promise<User>;
  }
  export function personalTokenResolver(sql: Sql, now?: () => Date): BearerResolver;
  export function userFromRow(row: Record<string, unknown>): User;

  // test-credentials.ts (tests only)
  export function issueTestToken(sql: Sql, userId: string): Promise<string>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `server-ts/src/auth/tokens.test.ts` (it already imports `assert`, `test` and the token helpers; add `parseBearer` to the `./tokens.ts` import):

```ts
test('parseBearer accepts any single well-formed bearer, not only session-shaped ones', () => {
   assert.equal(parseBearer('Bearer abc.DEF-123_~+/='), 'abc.DEF-123_~+/=');
   const { token } = generatePersonalToken();
   assert.equal(parseBearer(`Bearer ${token}`), token);
});

test('parseBearer refuses every malformed header the same way', () => {
   for (const header of [
      undefined,
      null,
      '',
      'Bearer',
      'Bearer ',
      'bearer abc',
      'Basic abc',
      'Bearer  abc',
      'Bearer abc def',
      'Bearer abc, Bearer def',
      `Bearer ${'a'.repeat(513)}`,
      'Bearer ab"c',
      'Bearer berry_pat_malformed',
   ]) {
      assert.throws(() => parseBearer(header), Unauthenticated, String(header));
   }
});
```

Create `server-ts/src/auth/credentials.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Sql } from '../db/pool.ts';
import { personalTokenResolver } from './credentials.ts';
import { generatePersonalToken } from './tokens.ts';

/**
 * Offline: the SQL client is a stub that answers each tagged-template call
 * with the next queued result, and records how many calls were made.
 */
function scriptedSql(results: unknown[][]): { sql: Sql; calls: () => number } {
   let calls = 0;
   const sql = (async () => {
      const next = results[calls] ?? [];
      calls += 1;
      return next;
   }) as unknown as Sql;
   return { sql, calls: () => calls };
}

const NOW = new Date('2026-09-10T12:00:00Z');

function tokenRow(secretHash: Buffer, extra: Record<string, unknown> = {}) {
   return {
      id: 'tok-1',
      secret_hash: secretHash,
      expires_at: null,
      revoked_at: null,
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'ada@berry.test',
      name: 'Ada',
      avatar_url: null,
      role: 'member',
      last_workspace_id: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...extra,
   };
}

test('the personal token resolver owns only the berry_pat_ namespace', () => {
   const resolver = personalTokenResolver(scriptedSql([]).sql);
   assert.equal(resolver.matches(generatePersonalToken().token), true);
   assert.equal(resolver.matches('berry_task_whatever'), false);
   assert.equal(resolver.matches('some-session-token'), false);
});

test('a live personal token resolves to its user and stamps last use', async () => {
   const issued = generatePersonalToken();
   const touched = Object.assign([], { count: 1 });
   const { sql, calls } = scriptedSql([[tokenRow(issued.secretHash)], touched]);
   const user = await personalTokenResolver(sql, () => NOW).resolve(issued.token);
   assert.equal(user.id, '11111111-1111-1111-1111-111111111111');
   assert.equal(user.email, 'ada@berry.test');
   assert.equal(calls(), 2);
});

test('a wrong secret, a revoked token and an expired token are all refused', async () => {
   const issued = generatePersonalToken();
   const other = generatePersonalToken();
   const cases: Array<[string, unknown[][]]> = [
      ['wrong secret', [[tokenRow(other.secretHash)]]],
      ['revoked', [[tokenRow(issued.secretHash, { revoked_at: '2026-09-01T00:00:00Z' })]]],
      ['expired', [[tokenRow(issued.secretHash, { expires_at: '2026-09-09T00:00:00Z' })]]],
      ['unknown', [[]]],
   ];
   for (const [label, results] of cases) {
      const { sql } = scriptedSql(results);
      await assert.rejects(personalTokenResolver(sql, () => NOW).resolve(issued.token), label);
   }
});

test('a malformed personal token is refused before any query runs', async () => {
   const { sql, calls } = scriptedSql([]);
   await assert.rejects(personalTokenResolver(sql).resolve('berry_pat_short'));
   assert.equal(calls(), 0);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd server-ts && node --test --experimental-strip-types src/auth/tokens.test.ts src/auth/credentials.test.ts`
Expected: FAIL. `parseBearer` is not exported, and `./credentials.ts` is not found.

- [ ] **Step 3: Implement `parseBearer`**

In `server-ts/src/auth/tokens.ts`, after `parseAuthorization`:

```ts
/** The token characters a bearer may carry: RFC 6750's b64token, bounded. */
const BEARER_TOKEN = /^[A-Za-z0-9._~+/=-]{1,512}$/;

/**
 * Accepts exactly one strict bearer credential of any registered kind.
 *
 * Unlike {@link parseAuthorization} it does not insist on a session-shaped
 * token: sessions are cookies now, and a bearer is a personal token or
 * whatever another resolver registers (a task token). The scheme rules are
 * the same and just as strict, so every malformed header is refused alike;
 * which resolver owns the token is decided by the caller.
 */
export function parseBearer(header: string | undefined | null): string {
   if (!header || !header.startsWith('Bearer ') || countSpaces(header) !== 1) {
      throw new Unauthenticated();
   }
   const token = header.slice('Bearer '.length);
   if (!BEARER_TOKEN.test(token)) throw new Unauthenticated();
   if (isPersonalToken(token)) parsePersonalToken(token);
   return token;
}
```
Leave `parseAuthorization` unchanged: `identity/secrets.ts` uses it to shape-check invitation secrets.

- [ ] **Step 4: Implement `credentials.ts`**

Create `server-ts/src/auth/credentials.ts`. It moves `resolvePersonalToken` and `toUser` out of `sessions.ts` so Task 5 can delete the old class without losing them.

```ts
import { toRFC3339, type Sql } from '../db/pool.ts';
import type { Role, User } from './sessions.ts';
import { isPersonalToken, parsePersonalToken, secretMatches } from './tokens.ts';

/**
 * Bearer credentials: what an `Authorization: Bearer` header may carry now
 * that browser sessions are cookies.
 *
 * Each kind of token claims a namespace by prefix and resolves itself. The
 * list is ordered and the first resolver that claims a token decides it, so a
 * malformed token in one namespace is never retried as another kind.
 * Personal access tokens are built in; workstream A registers task tokens the
 * same way.
 */
export interface BearerResolver {
   readonly name: string;
   matches(token: string): boolean;
   resolve(token: string): Promise<User>;
}

class TokenRefused extends Error {
   constructor() {
      super('unauthenticated');
      this.name = 'TokenRefused';
   }
}

/**
 * `berry_pat_<publicId>_<secret>`: one indexed lookup on the public half, then
 * a constant-time comparison of the secret's digest. Unchanged from the
 * session service it used to live in.
 */
export function personalTokenResolver(sql: Sql, now: () => Date = () => new Date()): BearerResolver {
   return {
      name: 'personal-token',
      matches: isPersonalToken,
      async resolve(token) {
         let parsed: { publicId: string; secret: string };
         try {
            parsed = parsePersonalToken(token);
         } catch {
            throw new TokenRefused();
         }

         const at = now().toISOString();
         const [row] = await sql`
            SELECT t.id, t.secret_hash, t.expires_at, t.revoked_at,
                   u.id AS user_id, u.email, u.name, u.avatar_url, u.role::text AS role,
                   u.last_workspace_id, u.created_at, u.updated_at
              FROM personal_api_tokens AS t
              JOIN users AS u ON u.id = t.user_id
             WHERE t.public_id = ${parsed.publicId}`;
         if (!row) throw new TokenRefused();

         const expiresAt = row.expires_at as string | null;
         if (row.revoked_at !== null || (expiresAt !== null && new Date(expiresAt) <= new Date(at))) {
            throw new TokenRefused();
         }
         if (!secretMatches(parsed.secret, row.secret_hash as Buffer)) throw new TokenRefused();

         // GREATEST, so a delayed request cannot move last_used_at backwards.
         const touched = await sql`
            UPDATE personal_api_tokens
               SET last_used_at = GREATEST(COALESCE(last_used_at, ${at}), ${at})
             WHERE id = ${row.id as string} AND revoked_at IS NULL`;
         if (touched.count !== 1) throw new TokenRefused();

         return userFromRow({ ...row, id: row.user_id });
      },
   };
}

/** A users row (with `role::text AS role`) as every authenticated surface sees it. */
export function userFromRow(row: Record<string, unknown>): User {
   return {
      id: row.id as string,
      email: row.email as string,
      name: row.name as string,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      role: row.role as Role,
      currentWorkspaceId: (row.last_workspace_id as string | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}
```

- [ ] **Step 5: Implement the test helper**

Create `server-ts/src/auth/test-credentials.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { digestToken, generatePersonalToken } from './tokens.ts';

/**
 * A real personal access token for a database test, inserted directly.
 *
 * Tests that only need *a* signed-in caller use this rather than a browser
 * session: a PAT goes through the production bearer path, needs no Better
 * Auth instance, and is as real a credential as the cookie. Not imported by
 * production code.
 */
export async function issueTestToken(sql: Sql, userId: string): Promise<string> {
   const issued = generatePersonalToken();
   await sql`
      INSERT INTO personal_api_tokens (
         user_id, name, public_id, secret_hash, idempotency_key_hash, request_fingerprint
      ) VALUES (
         ${userId}, 'test', ${issued.publicId}, ${issued.secretHash},
         ${digestToken(randomBytes(16).toString('hex'))},
         ${digestToken(randomBytes(16).toString('hex'))}
      )`;
   return issued.token;
}
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `cd server-ts && node --test --experimental-strip-types src/auth/tokens.test.ts src/auth/credentials.test.ts && cd .. && pnpm typecheck:server`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/auth/tokens.ts server-ts/src/auth/tokens.test.ts server-ts/src/auth/credentials.ts server-ts/src/auth/credentials.test.ts server-ts/src/auth/test-credentials.ts
git commit -m "feat(server-ts): resolve bearer tokens through registered resolvers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 5: Switch `requireSession` to cookie-or-bearer

This is the cutover of credential resolution. After it, an old opaque session bearer no longer authenticates, a Better Auth cookie does (once Task 6 constructs the instance), and a PAT still does. Every mount keeps calling `requireSession(options.sessions)`.

**Files:**
- Rewrite: `server-ts/src/auth/sessions.ts`
- Rewrite: `server-ts/src/auth/middleware.ts`
- Create: `server-ts/src/auth/sessions.test.ts`
- Rewrite: `server-ts/src/auth/middleware.test.ts`
- Rewrite: `server-ts/src/mounts/auth.ts` (slim version; `dev-login` arrives in Task 6)
- Modify: `server-ts/src/index.ts`: `new SessionService` (lines 104-107) and `authMounts(...)` (lines 487-497)
- Modify: `server-ts/src/mounts/cross-tenant-leakage.test.ts` (lines ~31, 83, 177-181), `server-ts/src/mounts/workspace-reads.absent.property.test.ts` (lines ~65, 155), `server-ts/src/mounts/workspace-reads.cross-read.property.test.ts` (lines ~188, 202, 210)
- Delete:
  - `server-ts/src/auth/middleware.faults.test.ts` and `server-ts/src/auth/middleware.property.test.ts`: their guarantees move into the new `middleware.test.ts` and `sessions.test.ts`.
  - `server-ts/src/auth/sessions.integration.test.ts`, `sessions.issuance.test.ts`, `sessions.lifecycle.test.ts`, `sessions.ttl.test.ts`: session issuance, TTL and revocation now belong to Better Auth and are covered by `better-auth.test.ts`.
  - `server-ts/src/mounts/auth.idempotency.test.ts`, `auth.passwordless.property.test.ts`, `auth.signin.test.ts`: the routes are removed.

**Interfaces:**
- Consumes: `BearerResolver`, `personalTokenResolver` and `userFromRow` (Task 4); `parseBearer` (Task 4); `issueTestToken` (Task 4).
- Produces (`sessions.ts`):
  ```ts
  export type Role = 'admin' | 'member' | 'viewer';
  export interface User { id; email; name; avatarUrl: string | null; role: Role; currentWorkspaceId: string | null; createdAt; updatedAt } // unchanged
  export class SessionUnauthenticated extends Error {}
  export class CrossOriginRefused extends Error {}
  /** What SessionService needs from Better Auth; auth.api satisfies it. */
  export interface SessionLookup {
     getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
  }
  export interface SessionServiceOptions {
     sql: Sql;
     auth: SessionLookup | null;
     bearer?: BearerResolver[];        // default []
     trustedOrigins?: string[];        // default []
  }
  export class SessionService {
     constructor(options: SessionServiceOptions);
     resolveRequest(request: Request): Promise<User>;
     loadUser(userId: string): Promise<User>;
  }
  export function serializeUser(user: User): Record<string, unknown>; // unchanged
  ```
- Produces (`middleware.ts`): `requireSession(sessions: SessionService)` and `requireRole(...roles)`, with the same signatures as today. `AuthVariables` is unchanged.
- Produces (`mounts/auth.ts`): `authMounts(options: AuthOptions): Mount[]`, where for now `AuthOptions = { sessions: SessionService }`. Task 6 extends it.

- [ ] **Step 1: Write the failing `sessions.test.ts`**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Sql } from '../db/pool.ts';
import type { BearerResolver } from './credentials.ts';
import {
   CrossOriginRefused,
   SessionService,
   SessionUnauthenticated,
   type SessionLookup,
   type User,
} from './sessions.ts';

const USER_ROW = {
   id: '11111111-1111-1111-1111-111111111111',
   email: 'ada@berry.test',
   name: 'Ada',
   avatar_url: null,
   role: 'member',
   last_workspace_id: null,
   created_at: '2026-01-01T00:00:00Z',
   updated_at: '2026-01-01T00:00:00Z',
};

const PAT_USER: User = {
   id: '22222222-2222-2222-2222-222222222222',
   email: 'pat@berry.test',
   name: 'Pat',
   avatarUrl: null,
   role: 'member',
   currentWorkspaceId: null,
   createdAt: '2026-01-01T00:00:00Z',
   updatedAt: '2026-01-01T00:00:00Z',
};

function sqlReturning(rows: unknown[]): Sql {
   return (async () => rows) as unknown as Sql;
}

/** A Better Auth stand-in: a session exists exactly when the cookie says so. */
function cookieAuth(calls: { count: number } = { count: 0 }): SessionLookup {
   return {
      async getSession({ headers }) {
         calls.count += 1;
         return headers.get('cookie')?.includes('berry.session_token=good')
            ? { user: { id: USER_ROW.id } }
            : null;
      },
   };
}

const patResolver: BearerResolver = {
   name: 'personal-token',
   matches: (token) => token.startsWith('berry_pat_'),
   async resolve(token) {
      if (token === 'berry_pat_ok') return PAT_USER;
      throw new Error('refused');
   },
};

function service(overrides: Partial<ConstructorParameters<typeof SessionService>[0]> = {}) {
   return new SessionService({
      sql: sqlReturning([USER_ROW]),
      auth: cookieAuth(),
      bearer: [patResolver],
      trustedOrigins: ['http://localhost:3000'],
      ...overrides,
   });
}

function request(init: { method?: string; headers?: Record<string, string> } = {}): Request {
   return new Request('http://localhost:4000/api/v1/me', {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
   });
}

test('a valid session cookie resolves to the users row', async () => {
   const user = await service().resolveRequest(request({ headers: { cookie: 'berry.session_token=good' } }));
   assert.equal(user.id, USER_ROW.id);
   assert.equal(user.role, 'member');
});

test('no credential at all is unauthenticated', async () => {
   await assert.rejects(service().resolveRequest(request()), SessionUnauthenticated);
});

test('a server with no Better Auth instance refuses every cookie', async () => {
   await assert.rejects(
      service({ auth: null }).resolveRequest(request({ headers: { cookie: 'berry.session_token=good' } })),
      SessionUnauthenticated
   );
});

test('a bearer is decided by its resolver and never falls back to the cookie', async () => {
   const calls = { count: 0 };
   const sessions = service({ auth: cookieAuth(calls) });
   const user = await sessions.resolveRequest(
      request({ headers: { authorization: 'Bearer berry_pat_ok', cookie: 'berry.session_token=good' } })
   );
   assert.equal(user.id, PAT_USER.id);
   await assert.rejects(
      sessions.resolveRequest(
         request({ headers: { authorization: 'Bearer berry_pat_bad', cookie: 'berry.session_token=good' } })
      )
   );
   assert.equal(calls.count, 0, 'the cookie was never consulted');
});

test('a bearer no resolver claims is refused, including an old session token', async () => {
   await assert.rejects(
      service().resolveRequest(request({ headers: { authorization: 'Bearer oldOpaqueSessionToken' } })),
      SessionUnauthenticated
   );
});

test('a malformed or stacked Authorization header is refused', async () => {
   for (const authorization of ['bearer berry_pat_ok', 'Bearer  berry_pat_ok', 'Bearer berry_pat_ok, Bearer x']) {
      await assert.rejects(
         service().resolveRequest(request({ headers: { authorization } })),
         SessionUnauthenticated,
         authorization
      );
   }
});

test('a cookie-authenticated write from a foreign origin is refused', async () => {
   await assert.rejects(
      service().resolveRequest(
         request({ method: 'POST', headers: { cookie: 'berry.session_token=good', origin: 'https://evil.test' } })
      ),
      CrossOriginRefused
   );
});

test('a cookie-authenticated write from a trusted origin, and a foreign-origin read, are allowed', async () => {
   const sessions = service();
   await sessions.resolveRequest(
      request({ method: 'PATCH', headers: { cookie: 'berry.session_token=good', origin: 'http://localhost:3000' } })
   );
   await sessions.resolveRequest(
      request({ method: 'GET', headers: { cookie: 'berry.session_token=good', origin: 'https://evil.test' } })
   );
});

test('a session whose user row is gone is unauthenticated', async () => {
   await assert.rejects(
      service({ sql: sqlReturning([]) }).resolveRequest(request({ headers: { cookie: 'berry.session_token=good' } })),
      SessionUnauthenticated
   );
});
```

- [ ] **Step 2: Rewrite `middleware.test.ts` (failing)**

Replace the whole file:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';
import { Hono } from 'hono';

import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { requireRole, requireSession, type AuthVariables } from './middleware.ts';
import { CrossOriginRefused, type SessionService, type User } from './sessions.ts';

/**
 * The guarantees Berry leans on for `requireSession`, whatever the credential:
 * the resolved user is on the context before the handler, every failure is
 * the byte-identical 401 envelope, a resolution throw of any kind (a database
 * blip included) is a 401 and never a 500, the handler never runs on a
 * failure, and a cross-origin cookie write is a 403. Offline: `resolveRequest`
 * is a stub.
 */

const USER: User = {
   id: '11111111-1111-1111-1111-111111111111',
   email: 'ada@berry.test',
   name: 'Ada',
   avatarUrl: null,
   role: 'member',
   currentWorkspaceId: null,
   createdAt: '2024-01-01T00:00:00Z',
   updatedAt: '2024-01-01T00:00:00Z',
};

function harness(resolve: (request: Request) => Promise<User>, roles: string[] = []) {
   let ran = false;
   let seen: User | undefined;
   const sessions = { resolveRequest: resolve } as unknown as SessionService;
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(sessions));
   if (roles.length > 0) route.use('*', requireRole(...roles));
   route.all('/', (context) => {
      ran = true;
      seen = context.get('user');
      return context.json({ ok: true });
   });
   const registry = new Registry();
   registry.register({ prefix: '/probe', handler: route });
   const app = createApp(registry);
   return {
      fetch: (init: RequestInit = {}) =>
         Promise.resolve(
            app.request('/probe', { ...init, headers: { 'x-request-id': 'req_fixedfixedfixed', ...(init.headers ?? {}) } })
         ),
      ran: () => ran,
      seen: () => seen,
   };
}

test('a resolved user is on the context before the handler runs', async () => {
   const probe = harness(async () => USER);
   const response = await probe.fetch();
   assert.equal(response.status, 200);
   assert.equal(probe.seen()?.id, USER.id);
});

test('every kind of resolution failure is the same 401, and the handler never runs', async () => {
   const failures: Array<() => Promise<User>> = [
      async () => {
         throw new Error('unauthenticated');
      },
      async () => {
         throw new Error('connection terminated unexpectedly');
      },
      async () => {
         throw new TypeError('boom');
      },
   ];
   const bodies = new Set<string>();
   for (const fail of failures) {
      const probe = harness(fail);
      const response = await probe.fetch();
      assert.equal(response.status, 401);
      bodies.add(await response.text());
      assert.equal(probe.ran(), false);
   }
   assert.equal(bodies.size, 1, 'the 401 bodies are byte-identical');
   assert.match([...bodies][0] ?? '', /"code":"UNAUTHENTICATED"/);
});

test('a cross-origin cookie write is a 403, not a 401', async () => {
   const probe = harness(async () => {
      throw new CrossOriginRefused();
   });
   const response = await probe.fetch({ method: 'POST' });
   assert.equal(response.status, 403);
   assert.equal(probe.ran(), false);
});

test('whatever the headers, a refusing resolver yields the identical 401', async () => {
   const reference = await (await harness(async () => { throw new Error('x'); }).fetch()).text();
   await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 80 }), async (value) => {
         const probe = harness(async () => {
            throw new Error('refused');
         });
         const headers: Record<string, string> = {};
         try {
            new Headers({ authorization: value });
            headers.authorization = value;
         } catch {
            // Not a legal header value; the client could not have sent it.
         }
         const response = await probe.fetch({ headers });
         assert.equal(response.status, 401);
         assert.equal(await response.text(), reference);
      }),
      { numRuns: 100 }
   );
});

test('requireRole refuses a user without the role', async () => {
   const probe = harness(async () => USER, ['admin']);
   const response = await probe.fetch();
   assert.equal(response.status, 403);
   assert.equal(probe.ran(), false);
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `cd server-ts && node --test --experimental-strip-types src/auth/sessions.test.ts src/auth/middleware.test.ts`
Expected: FAIL. `CrossOriginRefused` and `resolveRequest` do not exist yet.

- [ ] **Step 4: Rewrite `sessions.ts`**

Replace the whole file:

```ts
import type { Sql } from '../db/pool.ts';
import { userFromRow, type BearerResolver } from './credentials.ts';
import { parseBearer } from './tokens.ts';

/**
 * Who is calling.
 *
 * Two credentials, never mixed. A request with an Authorization header is
 * decided by that header alone — a personal access token, or any token a
 * registered resolver claims — and a bad one is not retried against the
 * cookie, so a caller cannot stack credentials and have the server pick. A
 * request without one is decided by the Better Auth session cookie, which is
 * how the browser (and its event stream) signs in.
 *
 * Sessions themselves — issue, refresh, expiry, sign-out — belong to Better
 * Auth (src/auth/better-auth.ts). This only asks it who a cookie belongs to
 * and reads that user's row.
 */

export type Role = 'admin' | 'member' | 'viewer';

/** A user as every authenticated surface sees them. */
export interface User {
   id: string;
   email: string;
   name: string;
   avatarUrl: string | null;
   role: Role;
   currentWorkspaceId: string | null;
   createdAt: string;
   updatedAt: string;
}

export class SessionUnauthenticated extends Error {
   constructor() {
      super('unauthenticated');
      this.name = 'SessionUnauthenticated';
   }
}

/** A cookie-authenticated write sent from an origin Berry does not serve. */
export class CrossOriginRefused extends Error {
   constructor() {
      super('cross-origin request refused');
      this.name = 'CrossOriginRefused';
   }
}

export interface SessionLookup {
   getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
}

export interface SessionServiceOptions {
   sql: Sql;
   auth: SessionLookup | null;
   bearer?: BearerResolver[];
   trustedOrigins?: string[];
}

/**
 * Methods a browser sends cross-site without a preflight being able to stop
 * it. A cookie rides along on those, so their Origin is checked; reads are
 * harmless to replay and are not.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class SessionService {
   private readonly sql: Sql;
   private readonly auth: SessionLookup | null;
   private readonly bearer: BearerResolver[];
   private readonly trustedOrigins: Set<string>;

   constructor(options: SessionServiceOptions) {
      this.sql = options.sql;
      this.auth = options.auth;
      this.bearer = options.bearer ?? [];
      this.trustedOrigins = new Set(options.trustedOrigins ?? []);
   }

   async resolveRequest(request: Request): Promise<User> {
      const authorization = request.headers.get('authorization');
      if (authorization !== null) return this.resolveBearer(authorization);
      return this.resolveCookie(request);
   }

   /** One users row by id; a user deleted since the credential was issued is not a caller. */
   async loadUser(userId: string): Promise<User> {
      const [row] = await this.sql`
         SELECT id, email, name, avatar_url, role::text AS role, last_workspace_id,
                created_at, updated_at
           FROM users
          WHERE id = ${userId}
          LIMIT 1`;
      if (!row) throw new SessionUnauthenticated();
      return userFromRow(row);
   }

   private async resolveBearer(header: string): Promise<User> {
      let token: string;
      try {
         token = parseBearer(header);
      } catch {
         throw new SessionUnauthenticated();
      }
      const resolver = this.bearer.find((candidate) => candidate.matches(token));
      if (!resolver) throw new SessionUnauthenticated();
      return resolver.resolve(token);
   }

   private async resolveCookie(request: Request): Promise<User> {
      if (!this.auth) throw new SessionUnauthenticated();
      if (!SAFE_METHODS.has(request.method.toUpperCase())) {
         // SameSite=Lax already keeps the cookie off most cross-site writes;
         // this closes the rest (a sibling subdomain is "same site"). A
         // request with no Origin is not a browser acting for someone else.
         const origin = request.headers.get('origin');
         if (origin !== null && !this.trustedOrigins.has(origin)) throw new CrossOriginRefused();
      }
      const found = await this.auth.getSession({ headers: request.headers });
      if (!found) throw new SessionUnauthenticated();
      return this.loadUser(found.user.id);
   }
}

/**
 * The user shape on the wire.
 *
 * Built key by key in Go's field order, and deliberately without
 * `currentWorkspaceId` — adding a field to a response is as much a contract
 * change as removing one.
 */
export function serializeUser(user: User): Record<string, unknown> {
   return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
   };
}
```

- [ ] **Step 5: Rewrite `middleware.ts`**

```ts
import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http/errors.ts';
import { CrossOriginRefused, type SessionService, type User } from './sessions.ts';

/**
 * Authentication for every signed-in mount: a Better Auth session cookie, or
 * one bearer token (see SessionService).
 *
 * Every failure — no credential, a malformed header, an unknown or revoked
 * token, an expired session, a database error while checking — is the
 * identical 401 envelope. Nothing distinguishes them, because a caller
 * learning *why* a credential failed learns something about credentials. The
 * one exception is a cookie write from a foreign origin, a 403: it says
 * nothing about the credential, only about where the request came from.
 */

export interface AuthVariables {
   user: User;
   requestId: string;
}

export function requireSession(sessions: SessionService): MiddlewareHandler<{
   Variables: AuthVariables;
}> {
   return async (context, next) => {
      let user: User;
      try {
         user = await sessions.resolveRequest(context.req.raw);
      } catch (error) {
         if (error instanceof CrossOriginRefused) throw ApiError.forbidden();
         // Deliberately everything else: a database failure here must not
         // become a 500 that tells a caller their credential was probably valid.
         throw ApiError.unauthorized();
      }
      context.set('user', user);
      await next();
   };
}

/** Requires an authenticated user to hold one of the given roles. */
export function requireRole(...allowed: string[]): MiddlewareHandler<{ Variables: AuthVariables }> {
   return async (context, next) => {
      const user = context.get('user');
      // Runs after requireSession, so an absent user is a wiring mistake
      // rather than an anonymous caller — and it still must not fall open.
      if (!user || !allowed.includes(user.role)) throw ApiError.forbidden();
      await next();
   };
}
```

- [ ] **Step 6: Slim `mounts/auth.ts`**

Replace the whole file:

```ts
import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import { serializeUser, type SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/auth`.
 *
 * Signing in and out is Better Auth's, at `/api/auth/*` (mounts/better-auth.ts),
 * and GitHub is the only way in. What stays here is `GET /me`, which answers
 * for any credential — the browser's cookie or an API client's token.
 */

export interface AuthOptions {
   sessions: SessionService;
}

export function authMounts(options: AuthOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();

   route.get('/me', requireSession(options.sessions), (context) =>
      json(serializeUser(context.get('user')))
   );

   return [{ prefix: '/api/v1/auth', handler: route }];
}
```

- [ ] **Step 7: Construct the service in `index.ts`**

Add `import { personalTokenResolver } from './auth/credentials.ts';` beside the `SessionService` import. Replace lines 104-107 with:

```ts
// Better Auth is constructed in Task 6; until then only bearer tokens resolve.
const sessions = new SessionService({
   sql,
   auth: null,
   bearer: [personalTokenResolver(sql)],
   trustedOrigins: config.auth.trustedOrigins,
});
```
Replace the `authMounts({...})` call (lines 487-497) with `registry.registerAll(authMounts({ sessions }));`.

- [ ] **Step 8: Move the three database tests to `issueTestToken`**

In each of `server-ts/src/mounts/cross-tenant-leakage.test.ts`, `workspace-reads.absent.property.test.ts` and `workspace-reads.cross-read.property.test.ts`:

1. Add the imports:
   ```ts
   import { personalTokenResolver } from '../auth/credentials.ts';
   import { issueTestToken } from '../auth/test-credentials.ts';
   ```
2. Replace every `new SessionService({ sql, sessionTtlMs: TTL_MS })` with:
   ```ts
   new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] })
   ```
3. Replace every `(await sessions.issueForUser(userId)).token` form with `await issueTestToken(sql, userId)`:
   - `cross-tenant-leakage.test.ts:180-181` becomes `world.u1Token = await issueTestToken(sql, u1Id);`
   - `workspace-reads.absent.property.test.ts:155-156` (`const issued = await built.sessions.issueForUser(fixture.userId); token = issued.token;`) become the single assignment `token = await issueTestToken(sql, fixture.userId);`. Do NOT write `const token`: `token` is the suite-level variable every request reads, and shadowing it leaves the suite sending an empty bearer, so every read is a 401 and the "absent and cross-workspace reads are indistinguishable" property passes vacuously. In the same `before`, add a positive control right after the assignment: issue one of the suite's own-workspace reads (a resource in the caller's own workspace, with the `Authorization: Bearer <token>` header the suite already uses) and assert it is 200, so a broken credential fails loudly instead of turning every read into an indistinguishable 401. (`buildApp` mounts only `workspaceReadMounts`, so there is no `/api/v1/me` to probe.) Also update `buildApp` so it no longer returns `sessions` if nothing else uses it.
   - `workspace-reads.cross-read.property.test.ts:202,210` become `const token = await issueTestToken(sql, userId);`.
4. Delete the now-unused `TTL_MS` constants.
5. Update any comment that says "session token" to "personal access token (the same bearer path an API client uses)".

The `Authorization: Bearer ${token}` headers stay as they are.

- [ ] **Step 9: Delete the retired tests**

```bash
git rm server-ts/src/auth/middleware.faults.test.ts server-ts/src/auth/middleware.property.test.ts \
  server-ts/src/auth/sessions.integration.test.ts server-ts/src/auth/sessions.issuance.test.ts \
  server-ts/src/auth/sessions.lifecycle.test.ts server-ts/src/auth/sessions.ttl.test.ts \
  server-ts/src/mounts/auth.idempotency.test.ts server-ts/src/mounts/auth.passwordless.property.test.ts \
  server-ts/src/mounts/auth.signin.test.ts
```

- [ ] **Step 10: Run everything**

Run: `pnpm typecheck:server && pnpm test:server`
Expected: PASS. If `tsc` reports `schemas.ts` or `password.ts` as unused, that is fine; Task 7 deletes them. If a remaining file still calls `sessions.issue*` or `resolveCredential`, grep for it with `grep -rnE "issueForUser|issueKnownEmail|issuePassword|resolveCredential|sessionTtlMs" server-ts/src` and move it to the new API. Expected grep output after the fix: only `config/config.ts`, `auth/better-auth.ts` and `auth/better-auth.test.ts` mention `sessionTtlMs` (the last two are Better Auth's `BerryAuthOptions.sessionTtlMs` from Task 3; `index.ts` passes it again from Task 6).

Then, with the database: `BERRY_TEST_DATABASE_URL=... pnpm test:server`. Expected: PASS, including the cross-tenant and workspace-reads suites.

- [ ] **Step 11: Commit**

```bash
git add -A server-ts/src/auth server-ts/src/mounts server-ts/src/index.ts
git commit -m "refactor(server-ts): authenticate by session cookie or a registered bearer token

Old opaque session bearers no longer authenticate; personal access tokens do.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: Serve Better Auth, dev login, sessions settings and the capability

**Files:**
- Create: `server-ts/src/mounts/better-auth.ts`
- Create: `server-ts/src/mounts/better-auth.test.ts`
- Create: `server-ts/src/mounts/auth.test.ts`
- Create: `server-ts/src/mounts/events.auth.test.ts`
- Create: `server-ts/src/mounts/account.sessions.test.ts` (database-gated, step 5)
- Modify: `server-ts/src/mounts/auth.ts` (add `dev-login`)
- Modify: `server-ts/src/mounts/account.ts`: `GET /sessions` and `DELETE /sessions/:sessionId` (lines 65-109)
- Modify: `server-ts/src/mounts/platform.ts`: `Capabilities` (lines 19-26) and `configRoute` (lines ~115-130)
- Modify: `server-ts/src/index.ts`: auth construction, mount registration, capabilities, shutdown

**Interfaces:**
- Consumes: `createBerryAuth`, `devSessionCookies`, `BerryAuth` and `AUTH_BASE_PATH` (Task 3); `SessionService` and `SessionLookup` (Task 5); `config.auth` (Task 1).
- Produces:
  ```ts
  // mounts/better-auth.ts
  export function betterAuthMounts(auth: { handler(request: Request): Promise<Response> }): Mount[]; // prefix '/api/auth'
  // mounts/auth.ts
  export interface AuthOptions {
     sessions: SessionService;
     sql: Sql;
     /** Non-null only when config.auth.devLogin: Set-Cookie values for a user id. */
     devSession: ((userId: string) => Promise<string[]>) | null;
  }
  // platform.ts: Capabilities gains `githubSignIn: boolean`, emitted last in capabilities.
  ```

- [ ] **Step 1: Write the failing tests**

`server-ts/src/mounts/better-auth.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { betterAuthMounts } from './better-auth.ts';

function appWith(handler: (request: Request) => Promise<Response>) {
   const registry = new Registry();
   registry.registerAll(betterAuthMounts({ handler }));
   return createApp(registry);
}

test('everything under /api/auth reaches Better Auth with the original URL', async () => {
   const seen: string[] = [];
   const app = appWith(async (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
   });
   assert.equal((await app.request('/api/auth/ok')).status, 200);
   await app.request('/api/auth/sign-in/social', { method: 'POST', body: '{}' });
   assert.deepEqual(seen, ['GET /api/auth/ok', 'POST /api/auth/sign-in/social']);
});

test('a redirect from Better Auth survives the standard headers', async () => {
   // Response.redirect() has immutable headers; the shell must still stamp its
   // own security headers on it rather than throwing a 500.
   const app = appWith(async () => Response.redirect('http://localhost:3000/', 302));
   const response = await app.request('/api/auth/callback/github?code=x&state=y');
   assert.equal(response.status, 302);
   assert.equal(response.headers.get('location'), 'http://localhost:3000/');
   assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('the Better Auth prefix does not shadow /api/v1', () => {
   const registry = new Registry();
   registry.registerAll(betterAuthMounts({ handler: async () => new Response(null) }));
   registry.register({ prefix: '/api/v1/auth', handler: new (class {})() as never });
   assert.deepEqual(registry.prefixes.sort(), ['/api/auth', '/api/v1/auth']);
});
```
If `Registry` exposes `prefixes` under a different name, use the accessor `index.ts` logs as `mounts: registry.prefixes`; that property exists today.

`server-ts/src/mounts/auth.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Sql } from '../db/pool.ts';
import { SessionService } from '../auth/sessions.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { authMounts } from './auth.ts';

const ROW = {
   id: '11111111-1111-1111-1111-111111111111',
   email: 'ada@berry.test',
   name: 'Ada',
   avatar_url: null,
   role: 'member',
   last_workspace_id: null,
   created_at: '2026-01-01T00:00:00Z',
   updated_at: '2026-01-01T00:00:00Z',
};

function build(devSession: ((userId: string) => Promise<string[]>) | null, rows: unknown[] = [ROW]) {
   const sql = (async () => rows) as unknown as Sql;
   const sessions = new SessionService({
      sql,
      auth: {
         getSession: async ({ headers }) =>
            headers.get('cookie')?.includes('berry.session_token=good') ? { user: { id: ROW.id } } : null,
      },
   });
   const registry = new Registry();
   registry.registerAll(authMounts({ sessions, sql, devSession }));
   return createApp(registry);
}

test('GET /api/v1/auth/me answers for a session cookie', async () => {
   const response = await build(null).request('/api/v1/auth/me', {
      headers: { cookie: 'berry.session_token=good' },
   });
   assert.equal(response.status, 200);
   const body = (await response.json()) as Record<string, unknown>;
   assert.deepEqual(Object.keys(body), ['id', 'email', 'name', 'avatarUrl', 'role', 'createdAt', 'updatedAt']);
});

test('the password and passwordless routes are gone', async () => {
   const app = build(null);
   for (const path of ['login', 'sign-in', 'sign-up', 'sign-out', 'logout']) {
      const response = await app.request(`/api/v1/auth/${path}`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 404, path);
   }
});

test('dev login is not served unless the deployment enabled it', async () => {
   const response = await build(null).request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@berry.test' }),
   });
   assert.equal(response.status, 404);
});

test('dev login sets the session cookie for a known email', async () => {
   const minted: string[] = [];
   const app = build(async (userId) => {
      minted.push(userId);
      return ['berry.session_token=abc.sig; Path=/; HttpOnly; SameSite=Lax'];
   });
   const response = await app.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ADA@berry.test' }),
   });
   assert.equal(response.status, 200);
   assert.deepEqual(minted, [ROW.id]);
   assert.match(response.headers.getSetCookie().join('\n'), /berry\.session_token=abc\.sig/);
});

test('dev login for an unknown email is the uniform 401', async () => {
   const app = build(async () => ['x=y'], []);
   const response = await app.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@berry.test' }),
   });
   assert.equal(response.status, 401);
});
```

`server-ts/src/mounts/events.auth.test.ts`. This test proves the SSE stream authenticates with the cookie:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Sql } from '../db/pool.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { ReplayRepository } from '../realtime/replay.ts';
import { SessionService } from '../auth/sessions.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { eventMounts } from './events.ts';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';

function build() {
   const sql = (async () => [
      {
         id: USER_ID, email: 'ada@berry.test', name: 'Ada', avatar_url: null, role: 'member',
         last_workspace_id: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      },
   ]) as unknown as Sql;
   const sessions = new SessionService({
      sql,
      auth: {
         getSession: async ({ headers }) =>
            headers.get('cookie')?.includes('berry.session_token=good') ? { user: { id: USER_ID } } : null,
      },
   });
   const boards = {
      authorizeWorkspace: async () => undefined,
      authorize: async () => undefined,
   } as unknown as BoardRepository;
   const replay = {
      replay: async () => [],
      resolveCursor: async () => null,
   } as unknown as ReplayRepository;
   const registry = new Registry();
   registry.registerAll(eventMounts({ sessions, replay, boards, pollMs: 10, heartbeatMs: 1000 }));
   return createApp(registry);
}

test('the event stream opens for a session cookie', async () => {
   const response = await build().request(`/api/v1/events?workspaceId=${WORKSPACE}`, {
      headers: { cookie: 'berry.session_token=good', accept: 'text/event-stream' },
   });
   assert.equal(response.status, 200);
   assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
   await response.body?.cancel();
});

test('the event stream refuses a request with no credential', async () => {
   const response = await build().request(`/api/v1/events?workspaceId=${WORKSPACE}`);
   assert.equal(response.status, 401);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd server-ts && node --test --experimental-strip-types src/mounts/better-auth.test.ts src/mounts/auth.test.ts src/mounts/events.auth.test.ts`
Expected: `better-auth.test.ts` fails with a missing module; `auth.test.ts` fails because `dev-login` is not found (404 where 200 was expected). `events.auth.test.ts` should already pass after Task 5; it pins the guarantee.

- [ ] **Step 3: Implement `mounts/better-auth.ts`**

```ts
import { Hono } from 'hono';
import type { Mount } from '../http/registry.ts';
import { AUTH_BASE_PATH } from '../auth/better-auth.ts';

/**
 * `/api/auth/*` — Better Auth's own routes: start GitHub sign-in, the OAuth
 * callback, read and end the session. Beside `/api/v1`, not under it, because
 * these are Better Auth's wire shapes rather than Berry's contract.
 */
export function betterAuthMounts(auth: { handler(request: Request): Promise<Response> }): Mount[] {
   const route = new Hono();
   route.on(['GET', 'POST'], '/*', async (context) => {
      const response = await auth.handler(context.req.raw);
      // Re-wrapped so the headers are mutable: a redirect built with
      // Response.redirect() has immutable headers, and the app shell stamps
      // its security headers onto every response.
      return new Response(response.body, response);
   });
   return [{ prefix: AUTH_BASE_PATH, handler: route }];
}
```

- [ ] **Step 4: Add `dev-login` to `mounts/auth.ts`**

Replace the `AuthOptions` interface and `authMounts` from Task 5 with this version, and add the imports `import type { Sql } from '../db/pool.ts';` and `import { ApiError } from '../http/errors.ts';`:

```ts
export interface AuthOptions {
   sessions: SessionService;
   sql: Sql;
   /**
    * Development only: Set-Cookie values for a session belonging to a user id.
    * Null — and the route absent — anywhere config.auth.devLogin is false,
    * which it always is outside development and test.
    */
   devSession: ((userId: string) => Promise<string[]>) | null;
}

const MAX_DEV_LOGIN_BODY_BYTES = 1024;

export function authMounts(options: AuthOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();

   route.get('/me', requireSession(options.sessions), (context) =>
      json(serializeUser(context.get('user')))
   );

   const devSession = options.devSession;
   if (devSession) {
      /**
       * Signs in as an existing account by email, with no GitHub round trip,
       * so a local stack with no OAuth App still has a way in. Not a sign-in
       * method: it is never registered outside development and test.
       */
      route.post('/dev-login', async (context) => {
         const text = await context.req.raw.text();
         if (Buffer.byteLength(text, 'utf8') > MAX_DEV_LOGIN_BODY_BYTES) {
            throw ApiError.badRequest('The request body is too large.');
         }
         let email = '';
         try {
            const parsed: unknown = JSON.parse(text || '{}');
            if (parsed && typeof parsed === 'object' && typeof (parsed as { email?: unknown }).email === 'string') {
               email = (parsed as { email: string }).email.trim();
            }
         } catch {
            throw ApiError.badRequest('The request body is not valid JSON.');
         }
         const [row] = email
            ? await options.sql`SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1`
            : [];
         // The uniform 401 (Global Constraints): an unknown email looks like
         // every other failed credential.
         if (!row) throw ApiError.unauthorized();

         const user = await options.sessions.loadUser(row.id as string);
         const response = json({ user: serializeUser(user) });
         for (const cookie of await devSession(user.id)) response.headers.append('set-cookie', cookie);
         return response;
      });
   }

   return [{ prefix: '/api/v1/auth', handler: route }];
}
```
If `json()` from `http/app.ts` returns a `Response` with immutable headers, build the response with `new Response(goJSON(...), { status: 200, headers })` instead, using the same helper `json` uses.

- [ ] **Step 5: Point the sessions settings at `auth_sessions`**

Write the test first: create `server-ts/src/mounts/account.sessions.test.ts` (shown below this code block), run it, and confirm it FAILS against the current routes (the list reads the legacy `sessions` table and returns no nodes). Then, in `server-ts/src/mounts/account.ts`, replace the two session routes (lines 65-109) with:

```ts
   /**
    * Where this account is signed in: live Better Auth sessions.
    *
    * `lastUsedAt` is when Better Auth last refreshed the session (it does so
    * at most once a day of use), which is coarser than the old per-request
    * stamp and is what the column can honestly say.
    */
   route.get('/sessions', async (context) => {
      const rows = await sql`
         SELECT id, user_agent, ip_address, created_at, updated_at, expires_at
           FROM auth_sessions
          WHERE user_id = ${context.get('user').id}
            AND expires_at > now()
          ORDER BY updated_at DESC, id DESC
          LIMIT 100`;
      return json({
         nodes: rows.map((row) => ({
            id: row.id as string,
            userAgent: (row.user_agent as string | null) ?? null,
            ip: (row.ip_address as string | null) ?? null,
            createdAt: toRFC3339(row.created_at as string)!,
            lastUsedAt: toRFC3339(row.updated_at as string | null),
            expiresAt: toRFC3339(row.expires_at as string)!,
         })),
      });
   });

   /**
    * Signs a device out. Deleted, because a Better Auth session has no revoked
    * state: a row that exists is a live session. Scoped to the caller in the
    * statement, so an id belonging to someone else deletes nothing.
    */
   route.delete('/sessions/:sessionId', async (context) => {
      const sessionId = pathId(context.req.param('sessionId'), 'Session');
      const rows = await sql`
         DELETE FROM auth_sessions
          WHERE id = ${sessionId} AND user_id = ${context.get('user').id}
          RETURNING id`;
      if (rows.length === 0) throw ApiError.notFound('Session');
      return new Response(null, { status: 204 });
   });
```
The wire shape (`nodes[].{id,userAgent,ip,createdAt,lastUsedAt,expiresAt}`) is unchanged.

The test file `server-ts/src/mounts/account.sessions.test.ts` (database-gated; needs migration 150 on the test database; write it before the route change above). It pins that the sessions settings are the caller's own, now that they read a new table:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { Hono } from 'hono';

import { personalTokenResolver } from '../auth/credentials.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import type { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { accountRoutes } from './account.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('sessions settings on auth_sessions', { skip: !url }, () => {
   let sql: Sql;
   let app: Hono<{ Variables: AuthVariables }>;
   const alice = randomUUID();
   const bob = randomUUID();
   const aliceSession = randomUUID();
   const bobSession = randomUUID();
   let aliceToken = '';

   before(async () => {
      sql = openDatabase({ url: url! });
      for (const [id, name] of [[alice, 'alice'], [bob, 'bob']] as const) {
         await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${`${name}-${id}@berry.test`}, ${name})`;
      }
      for (const [id, userId] of [[aliceSession, alice], [bobSession, bob]] as const) {
         await sql`
            INSERT INTO auth_sessions (id, user_id, token, expires_at)
            VALUES (${id}, ${userId}, ${randomUUID()}, now() + interval '1 day')`;
      }
      aliceToken = await issueTestToken(sql, alice);
      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      app = new Hono<{ Variables: AuthVariables }>();
      app.use('*', requireSession(sessions));
      app.route('/', accountRoutes({ sql, boards: {} as unknown as BoardRepository }));
   });

   after(async () => {
      await sql`DELETE FROM users WHERE id IN (${alice}, ${bob})`;
      await closeDatabase(sql);
   });

   test('the list holds only the caller\'s sessions', async () => {
      const response = await app.request('/sessions', { headers: { authorization: `Bearer ${aliceToken}` } });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { nodes: Array<{ id: string }> };
      assert.deepEqual(body.nodes.map((node) => node.id), [aliceSession]);
   });

   test('deleting another user\'s session is a 404 and leaves it in place', async () => {
      const response = await app.request(`/sessions/${bobSession}`, {
         method: 'DELETE',
         headers: { authorization: `Bearer ${aliceToken}` },
      });
      assert.equal(response.status, 404);
      const [row] = await sql`SELECT count(*)::int AS n FROM auth_sessions WHERE id = ${bobSession}`;
      assert.equal(row?.n, 1);
   });

   test('deleting one\'s own session removes it', async () => {
      const response = await app.request(`/sessions/${aliceSession}`, {
         method: 'DELETE',
         headers: { authorization: `Bearer ${aliceToken}` },
      });
      assert.equal(response.status, 204);
      const [row] = await sql`SELECT count(*)::int AS n FROM auth_sessions WHERE id = ${aliceSession}`;
      assert.equal(row?.n, 0);
   });
});
```
If `ApiError` thrown from these routes is not turned into an envelope by a bare `Hono` (it is by `createApp`'s `onError`), mount the router through a `Registry` and `createApp` instead, with prefix `/api/v1/me`, and adjust the paths. Run: `BERRY_TEST_DATABASE_URL=... node --test --experimental-strip-types src/mounts/account.sessions.test.ts`. Expected before step 5: FAIL (the list reads the legacy `sessions` table and returns no nodes); after: PASS.

- [ ] **Step 6: Add the capability**

In `server-ts/src/mounts/platform.ts`:
- add `/** GitHub sign-in is configured, so the sign-in page can offer it. */ githubSignIn: boolean;` to `Capabilities` after `planner`;
- in `configRoute`, add `githubSignIn: capabilities.githubSignIn,` after `planner: capabilities.planner,`.

- [ ] **Step 7: Wire Better Auth in `index.ts`**

Add these imports:
```ts
import pg from 'pg';
import { createBerryAuth, devSessionCookies } from './auth/better-auth.ts';
import { betterAuthMounts } from './mounts/better-auth.ts';
```
Replace the `sessions` construction from Task 5 with:
```ts
/**
 * Sign-in, when this deployment has a secret to sign cookies with and an
 * origin to send the browser back to. Without them the server still serves
 * API clients on personal access tokens; the browser just cannot sign in.
 */
const authPool =
   config.auth.secret && config.auth.baseUrl
      ? new pg.Pool({ connectionString: config.databaseUrl, max: 5 })
      : null;
const auth =
   authPool && config.auth.secret && config.auth.baseUrl
      ? createBerryAuth({
           pool: authPool,
           secret: config.auth.secret,
           baseUrl: config.auth.baseUrl,
           trustedOrigins: config.auth.trustedOrigins,
           github: config.auth.github,
           sessionTtlMs: config.sessionTtlMs,
           testUtils: config.auth.devLogin,
        })
      : null;

const sessions = new SessionService({
   sql,
   auth: auth ? { getSession: (input) => auth.api.getSession(input) } : null,
   bearer: [personalTokenResolver(sql)],
   trustedOrigins: config.auth.trustedOrigins,
});
```
Replace `registry.registerAll(authMounts({ sessions }));` with:
```ts
registry.registerAll(
   authMounts({
      sessions,
      sql,
      devSession: auth && config.auth.devLogin ? (userId) => devSessionCookies(auth, userId) : null,
   })
);
if (auth) registry.registerAll(betterAuthMounts(auth));
```
In `platformMounts({ capabilities: {...} })`, add after `planner`:
```ts
         // True only when a GitHub OAuth App is configured for sign-in and
         // Better Auth is running — not when only the repository App exists.
         githubSignIn: auth !== null && config.auth.github !== null,
```
In the boot log object, add `signIn: auth ? (config.auth.github ? 'github' : 'no GitHub OAuth App') : 'off',`.

In the shutdown handler, change `.then(() => closeDatabase(sql))` to:
```ts
            .then(() => closeDatabase(sql))
            .then(() => authPool?.end())
```
If `tsc` rejects `(input) => auth.api.getSession(input)` because the return type includes extra fields, that is fine: `SessionLookup` only needs `user.id`. If it rejects the parameter shape, write `({ headers }) => auth.api.getSession({ headers })`.

- [ ] **Step 8: Run everything**

Run: `pnpm typecheck:server && pnpm test:server`
Expected: PASS.

Then do a manual smoke test against the Compose database, with a dev secret and no GitHub credentials:
```bash
APP_ENV=development AUTH_ALLOW_PASSWORDLESS_LOGIN=true DATABASE_URL=... pnpm dev:server &
curl -s localhost:4000/api/v1/config | grep -o '"githubSignIn":[a-z]*'
curl -si -X POST localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"<seeded user email from src/seed/seed.ts UserEmail>"}' | grep -i set-cookie
```
Expected: `"githubSignIn":false`, and a `set-cookie: berry.session_token=…` line. Then:
```bash
curl -s localhost:4000/api/v1/me -H "cookie: berry.session_token=<value from above>"
```
Expected: the seeded profile JSON. Stop the dev server afterwards.

- [ ] **Step 9: Commit**

```bash
git add server-ts/src/mounts server-ts/src/index.ts
git commit -m "feat(server-ts): serve Better Auth sign-in and read sessions from it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 7: Remove password sign-in for good

**Files:**
- Create: `server-ts/migrations/151_drop_password_credentials.up.sql`
- Delete: `server-ts/src/auth/password.ts`, `server-ts/src/auth/password.test.ts`, `server-ts/src/auth/password.verify.test.ts`, `server-ts/src/auth/schemas.ts`
- Modify: `server-ts/src/identity/repository.ts`. Remove `createUserWithPassword` (lines ~278-358) and `classifyUserWrite` (line ~360 onward, the unique-violation mapper for sign-up). Remove the `createHash` import and the `IdempotencyConflict` import, and `timingSafeEqualBytes` if nothing else in the file uses it.
- Modify: `server-ts/src/seed/seed.ts`. Remove the `hashPassword` import (line 1), the `UserPassword` import (line 15), the `await setUserPassword(tx, now);` call (line 46) and the `setUserPassword` function (lines 233-247). Also remove `UserPassword` from `server-ts/src/seed/ids.ts` if nothing else imports it.

**Interfaces:**
- Consumes: nothing new.
- Produces: no password columns on `users`, and no password code anywhere in `server-ts/src`.

- [ ] **Step 1: Write a failing guard test**

Create `server-ts/src/auth/no-password.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * GitHub is the only sign-in method. These pin that the password path is
 * gone rather than merely unrouted, so it cannot come back by a stray import.
 */

const SRC = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
   return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
   });
}

test('the password modules no longer exist', () => {
   assert.equal(existsSync(join(SRC, 'auth', 'password.ts')), false);
   assert.equal(existsSync(join(SRC, 'auth', 'schemas.ts')), false);
});

test('no server source reads or writes a user password column', () => {
   const offenders = sources(SRC).filter((file) =>
      /password_hash|password_salt|hashPassword|verifyPassword|createUserWithPassword/.test(
         readFileSync(file, 'utf8')
      )
   );
   assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/auth/no-password.test.ts`
Expected: FAIL. It lists `auth/password.ts`, `identity/repository.ts` and `seed/seed.ts`.

- [ ] **Step 3: Delete the code**

```bash
git rm server-ts/src/auth/password.ts server-ts/src/auth/password.test.ts \
  server-ts/src/auth/password.verify.test.ts server-ts/src/auth/schemas.ts
```
Then make the `repository.ts`, `seed.ts` and `ids.ts` edits listed under **Files**. The seed's user keeps its id and email, and signs in locally through `dev-login` or by linking a GitHub account with the same verified email. Replace the removed seed comment with:
```ts
   // The seeded user has no credential of its own: locally it signs in through
   // POST /api/v1/auth/dev-login (development only), and anywhere else by
   // linking a GitHub account whose verified email matches UserEmail.
```
placed above `upsertUser`.

- [ ] **Step 4: Write migration 151**

Create `server-ts/migrations/151_drop_password_credentials.up.sql`:

```sql
-- Password sign-in is gone (workstream J): GitHub via Better Auth is the only
-- way in. The credentials and the sign-up idempotency pair added by 050 are
-- dropped rather than left as dead secrets in every users row.
DROP INDEX IF EXISTS users_creation_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_key_pair_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_fingerprint_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_key_hash_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_salt_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_hash_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_pair_ck;
ALTER TABLE users DROP COLUMN IF EXISTS creation_fingerprint;
ALTER TABLE users DROP COLUMN IF EXISTS creation_key_hash;
ALTER TABLE users DROP COLUMN IF EXISTS password_updated_at;
ALTER TABLE users DROP COLUMN IF EXISTS password_salt;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
```

- [ ] **Step 5: Run everything**

Run:
```bash
pnpm typecheck:server && pnpm test:server
DATABASE_URL=... pnpm migrate:server && DATABASE_URL=... pnpm seed:server
DATABASE_URL="$BERRY_TEST_DATABASE_URL" pnpm migrate:server
BERRY_TEST_DATABASE_URL=... pnpm test:server
```
Expected: all PASS. `migrate` applies `151_drop_password_credentials`, the seed completes, and `\d users` shows no `password_*` or `creation_*` columns.

- [ ] **Step 6: Commit**

```bash
git add -A server-ts/src server-ts/migrations/151_drop_password_credentials.up.sql
git commit -m "refactor(server-ts): drop password credentials now that GitHub is the only sign-in

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Frontend auth client and session store

**Files:**
- Modify: `frontend/package.json` (add `better-auth`)
- Create: `frontend/lib/auth-client.ts`
- Rewrite: `frontend/lib/auth.ts`
- Rewrite: `frontend/store/session-store.ts`: `SessionState`, `hydrateFromStorage`, remove `signIn`/`signUp`, and `signOut`
- Modify: `frontend/components/auth/use-sign-out.ts`
- Modify: `frontend/lib/config.ts` (the `AUTO_LOGIN_EMAIL` doc comment)
- Delete: `frontend/lib/session.ts`

**Interfaces:**
- Consumes: the HTTP contract at the top of this plan.
- Produces:
  ```ts
  // lib/auth-client.ts
  export function authClient(): ReturnType<typeof createAuthClient>; // browser only, created lazily
  // lib/auth.ts
  export type LoginUser; export type BootstrapWorkspace; export type BootstrapPayload; // unchanged shapes
  export function signInWithGitHub(): Promise<void>;          // navigates away on success
  export function devLogin(email: string): Promise<LoginUser>;
  export function logoutSession(): Promise<void>;
  export function fetchBootstrap(): Promise<BootstrapPayload>; // unchanged
  export function fetchGitHubSignInAvailable(): Promise<boolean>;
  // store/session-store.ts
  // SessionState loses signIn/signUp; gains markAnonymous(): void.
  // hydrateFromStorage keeps its name: SessionGate calls it.
  ```

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter berry-frontend add better-auth@1.7.4`
Expected: `frontend/package.json` has `"better-auth": "1.7.4"` (pin exactly). Better Auth carries its own Zod v4 as a dependency; the frontend's own `zod` stays `^3.24.2`.

- [ ] **Step 2: Create `frontend/lib/auth-client.ts`**

```ts
'use client';

import { createAuthClient } from 'better-auth/react';

import { API_BASE_URL } from './config';

type AuthClient = ReturnType<typeof createAuthClient>;

let client: AuthClient | null = null;

/**
 * The Better Auth client, for starting GitHub sign-in and signing out.
 *
 * Created on first use in the browser rather than at import, so a page that
 * imports it can still be prerendered: there is no origin to point at on the
 * server. Same-origin by default (Next rewrites /api/* to the server); the
 * explicit API URL only in cross-origin development.
 */
export function authClient(): AuthClient {
   if (typeof window === 'undefined') {
      throw new Error('The auth client is browser-only');
   }
   client ??= createAuthClient({
      baseURL: API_BASE_URL || window.location.origin,
      basePath: '/api/auth',
   });
   return client;
}
```

- [ ] **Step 3: Rewrite `frontend/lib/auth.ts`**

```ts
import { z } from 'zod';

import { apiFetch } from './api';
import { authClient } from './auth-client';

const userSchema = z.object({
   id: z.string(),
   email: z.string(),
   name: z.string(),
   avatarUrl: z.string().nullable(),
   role: z.string().optional(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const devLoginResponseSchema = z.object({ user: userSchema });

const workspaceSchema = z.object({
   id: z.string(),
   name: z.string(),
   slug: z.string(),
   description: z.string().nullable(),
   role: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const bootstrapSchema = z.object({
   user: userSchema.extend({
      settings: z.object({
         theme: z.string(),
         timezone: z.string(),
         reducedMotion: z.boolean(),
      }),
   }),
   workspaces: z.array(workspaceSchema),
   currentWorkspaceId: z.string().nullable(),
});

const configSchema = z.object({
   capabilities: z.object({ githubSignIn: z.boolean().optional() }).passthrough(),
});

export type LoginUser = z.infer<typeof userSchema>;
export type BootstrapWorkspace = z.infer<typeof workspaceSchema>;
export type BootstrapPayload = z.infer<typeof bootstrapSchema>;

/**
 * Starts GitHub sign-in. The browser leaves for GitHub and comes back through
 * the server's callback, which sets the session cookie and lands on `/`; a
 * refusal lands on `/sign-in?error=<code>` instead.
 */
export async function signInWithGitHub(): Promise<void> {
   const origin = window.location.origin;
   const { error } = await authClient().signIn.social({
      provider: 'github',
      callbackURL: `${origin}/`,
      errorCallbackURL: `${origin}/sign-in`,
   });
   if (error) {
      throw new Error(error.message || 'GitHub sign-in could not start');
   }
}

/**
 * Development-only sign-in as an existing account. The server registers the
 * route only in development and test, so this 404s anywhere else.
 */
export async function devLogin(email: string): Promise<LoginUser> {
   const json: unknown = await apiFetch('/api/v1/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim() }),
   });
   const parsed = devLoginResponseSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Login response was not recognized');
   }
   return parsed.data.user;
}

export async function fetchBootstrap(): Promise<BootstrapPayload> {
   const json: unknown = await apiFetch('/api/v1/me/bootstrap');
   const parsed = bootstrapSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Bootstrap response was not recognized');
   }
   return parsed.data;
}

/** Whether this server can sign anyone in with GitHub (an OAuth App is configured). */
export async function fetchGitHubSignInAvailable(): Promise<boolean> {
   const json: unknown = await apiFetch('/api/v1/config');
   const parsed = configSchema.safeParse(json);
   return parsed.success && parsed.data.capabilities.githubSignIn === true;
}

/** Ends the session on the server; the cookie is cleared by the response. */
export async function logoutSession(): Promise<void> {
   const { error } = await authClient().signOut();
   if (error && error.status !== 401) {
      throw new Error(error.message || 'Sign-out failed');
   }
}
```
If the installed client's `error` object has no `status` field, compare on `error.code` or drop the 401 special case; a failed sign-out still falls back to a local clear in `use-sign-out.ts`.

- [ ] **Step 4: Rewrite the session store's auth actions**

In `frontend/store/session-store.ts`:
1. Replace the imports from `@/lib/auth` with `fetchBootstrap, devLogin, logoutSession, type BootstrapWorkspace`.
2. Delete the `clearSessionToken, restoreSessionToken` import from `@/lib/session`.
3. In `SessionState`, delete `signIn` and `signUp`, and add:
   ```ts
   /** Drops to anonymous locally, without a server round trip (sign-out fallback). */
   markAnonymous: () => void;
   ```
4. Replace `hydrateFromStorage`, `signIn`, `signUp` and `signOut` with:

```ts
   hydrateFromStorage: async () => {
      // The session is a cookie the browser sends on its own, so "is anyone
      // signed in" is simply whether bootstrap answers. A 401 is the normal
      // anonymous answer, not an error worth showing.
      try {
         const ready = await loadReadyState();
         set({ status: 'ready', error: null, ...ready });
         return;
      } catch (error) {
         if (!(error instanceof BerryApiError) || error.status !== 401) {
            set({ ...ANONYMOUS, error: error instanceof BerryApiError ? error.message : null });
            return;
         }
      }

      // Development only: sign in as a configured account through dev-login.
      // The server serves that route only in development and test, so a stray
      // value cannot sign anyone in against a production API.
      if (AUTO_LOGIN_EMAIL) {
         try {
            await devLogin(AUTO_LOGIN_EMAIL);
            const ready = await loadReadyState();
            set({ status: 'ready', error: null, ...ready });
            return;
         } catch {
            // A convenience, not a guarantee: fall through to the sign-in page.
         }
      }

      set({ ...ANONYMOUS });
   },

   signOut: async () => {
      await logoutSession();
      set({ ...ANONYMOUS });
   },

   markAnonymous: () => set({ ...ANONYMOUS }),
```
Keep `loadReadyState`, `pickWorkspace`, `refreshWorkspaces` and `switchWorkspace` as they are.

- [ ] **Step 5: Update the sign-out hook and config comment**

In `frontend/components/auth/use-sign-out.ts`:
- replace `import { clearSessionToken } from '@/lib/session';` with nothing;
- add `const markAnonymous = useSessionStore((state) => state.markAnonymous);`;
- replace both `clearSessionToken();` calls with `markAnonymous();`;
- add `markAnonymous` to the `useCallback` dependency list.

In `frontend/lib/config.ts`, change the `AUTO_LOGIN_EMAIL` comment to say the store signs in through `POST /api/v1/auth/dev-login` when no session cookie is present, and that the route exists only in development and test.

- [ ] **Step 6: Delete the token store**

Run: `git rm frontend/lib/session.ts`
Then: `cd frontend && grep -rn "lib/session'\|lib/session\"\|signInWithPassword\|signUpWithPassword\|loginWithEmail\|persistSessionToken" app components lib store hooks`
Expected: the only hits are `app/sign-in/page.tsx` and `app/sign-up/page.tsx`, which Task 9 replaces. The build is expected to fail on those two pages until Task 9 lands; run the gate at the end of Task 9. `lib/api.ts` keeps its `ApiSession` support, which is unused by the app and harmless for API-client callers.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/package.json pnpm-lock.yaml frontend/lib frontend/store/session-store.ts frontend/components/auth/use-sign-out.ts
git commit -m "feat(frontend): sign in with Better Auth's GitHub flow instead of a stored token

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
Tasks 8 and 9 go to one subagent back to back, or Task 9 immediately follows. The frontend build is green only after Task 9.

---
### Task 9: One "Continue with GitHub" page

**Files:**
- Rewrite: `frontend/app/sign-in/page.tsx`
- Delete: `frontend/app/sign-up/page.tsx`
- Keep: `frontend/app/login/page.tsx`. It already forwards to `/sign-in`, so there is one page and old links still work.
- Modify: `frontend/components/layout/session-gate.tsx` (line 12, the `AUTH_ROUTES` set, and its comment)
- Modify: `frontend/components/auth/auth-card.tsx` (doc comment only: "shared by sign-in" instead of "sign-in and sign-up")
- Modify: `frontend/app/page.tsx` (comment line 4: "Sign-in returns to `/`")

**Interfaces:**
- Consumes: `signInWithGitHub` and `fetchGitHubSignInAvailable` from `@/lib/auth` (Task 8), `AuthCard`, `Button`, and `RiGithubFill` from `@remixicon/react`.
- Produces: the `/sign-in` route; `/login` redirects to it; `/sign-up` is a 404.

- [ ] **Step 1: Rewrite `frontend/app/sign-in/page.tsx`**

```tsx
'use client';

import { RiGithubFill } from '@remixicon/react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { fetchGitHubSignInAvailable, signInWithGitHub } from '@/lib/auth';

/**
 * What a refused GitHub round trip means, in Berry's words. The server sends
 * the browser back here with `?error=<code>`; anything not listed gets the
 * general message rather than the raw code.
 */
const ERROR_MESSAGES: Record<string, string> = {
   account_not_linked:
      'Your GitHub account could not be linked. Make sure its primary email is verified on GitHub.',
   email_not_verified: 'Verify your primary email on GitHub, then try again.',
   // Better Auth's code when the create hook refuses an unverified address.
   unable_to_create_user: 'Verify your primary email on GitHub, then try again.',
   access_denied: 'GitHub sign-in was cancelled.',
};
const GENERIC_ERROR = 'We could not sign you in with GitHub. Please try again.';

function SignInContent() {
   const params = useSearchParams();
   const returned = params.get('error');
   const [available, setAvailable] = useState<boolean | null>(null);
   const [pending, setPending] = useState(false);
   const [error, setError] = useState<string | null>(
      returned ? (ERROR_MESSAGES[returned] ?? GENERIC_ERROR) : null
   );

   useEffect(() => {
      let cancelled = false;
      fetchGitHubSignInAvailable()
         .then((value) => {
            if (!cancelled) setAvailable(value);
         })
         .catch(() => {
            if (!cancelled) setAvailable(false);
         });
      return () => {
         cancelled = true;
      };
   }, []);

   const start = async () => {
      setError(null);
      setPending(true);
      try {
         // On success the browser navigates to GitHub; nothing after this runs.
         await signInWithGitHub();
      } catch {
         setError(GENERIC_ERROR);
         setPending(false);
      }
   };

   return (
      <AuthCard title="Sign in to Berry" description="Berry uses your GitHub account to sign you in.">
         <div className="grid gap-4">
            <Button
               type="button"
               className="w-full"
               onClick={() => void start()}
               disabled={pending || available !== true}
            >
               <RiGithubFill aria-hidden className="size-4" />
               {pending ? 'Opening GitHub…' : 'Continue with GitHub'}
            </Button>
            {available === false ? (
               <p role="status" className="text-muted-foreground">
                  GitHub sign-in is not configured on this server. An administrator needs to set
                  BERRY_AUTH_GITHUB_CLIENT_ID and BERRY_AUTH_GITHUB_CLIENT_SECRET.
               </p>
            ) : null}
            {error ? (
               <p role="alert" className="text-destructive-foreground">
                  {error}
               </p>
            ) : null}
         </div>
      </AuthCard>
   );
}

/** `useSearchParams` needs a Suspense boundary for the page to prerender. */
export default function SignInPage() {
   return (
      <Suspense fallback={null}>
         <SignInContent />
      </Suspense>
   );
}
```
Before relying on `RiGithubFill`, check it exists: `grep -c "RiGithubFill" frontend/node_modules/@remixicon/react/index.d.ts`. If it does not, use `FaGithub` from `react-icons/fa`, which is also a dependency.

- [ ] **Step 2: Remove sign-up and narrow the gate**

Run: `git rm frontend/app/sign-up/page.tsx`

In `frontend/components/layout/session-gate.tsx`, replace lines 9-12 with:
```ts
// Routes that must render for an anonymous visitor. `/login` is the legacy
// entry that forwards to `/sign-in`, the one sign-in page; keep it here so a
// 'ready' user landing on it is bounced into the app rather than left on a shim.
const AUTH_ROUTES = new Set(['/sign-in', '/login']);
```
Update the `auth-card.tsx` and `app/page.tsx` comments as listed under **Files**.

- [ ] **Step 3: Run the frontend gates**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed. The build route list shows `/sign-in` and `/login` and no `/sign-up`. Also run `grep -rn "sign-up\|password" app components/auth lib/auth.ts store/session-store.ts`. Expected: no hits except unrelated uses outside auth, if any.

- [ ] **Step 4: Manual check of the changed view**

With the stack running (`docker compose up -d --build`, or `pnpm dev:server` plus `cd frontend && pnpm dev`):

1. Visit `http://localhost:3000/sign-up`. Expected: the not-found page.
2. Visit `http://localhost:3000/login`. Expected: you land on `/sign-in`.
3. With no `BERRY_AUTH_GITHUB_*` set, `/sign-in` shows "Continue with GitHub" disabled and the not-configured notice.
4. With a GitHub OAuth App configured (callback `http://localhost:3000/api/auth/callback/github`) and the server restarted: click the button, authorize, and land in your workspace. DevTools shows a `berry.session_token` cookie (HttpOnly) and no `berry.session.v1` in sessionStorage. The events stream request (`/api/v1/events?…`) is 200 with no `Authorization` header. Sign out returns to `/sign-in`, and `/api/v1/me` is then 401.
5. With `NEXT_PUBLIC_AUTO_LOGIN_EMAIL` set to the seeded email in development: a fresh load goes straight into the workspace through `dev-login`.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/app frontend/components
git commit -m "feat(frontend): replace sign-in and sign-up forms with Continue with GitHub

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Contract docs and the full gate

**Files:**
- Modify: `server-ts/SCOPE.md`: add `/api/auth` to the served block (line ~19)
- Modify: `docs/api/gateway-v1.md`: the Authentication row (line 33) and the 401 row (line 153)
- Modify: `AGENTS.md`: the "wire shape is a contract" bullet (lines 78-81)
- Modify: `server-ts/ROUTING.md`: add a short "Sign-in" section after "Linking a GitHub repository"

**Interfaces:** none (documentation).

- [ ] **Step 1: Update the docs**

`server-ts/SCOPE.md`: add `/api/auth` as the first entry of the served prefix block, keeping the column layout. Under it add one line: `` `/api/auth` is Better Auth's own route set (GitHub sign-in, callback, session, sign-out), outside `/api/v1` because its shapes are the library's. ``

`docs/api/gateway-v1.md` line 33 becomes:
```
| Authentication | Browser: the `berry.session_token` cookie set by GitHub sign-in (`/api/auth/*`, Better Auth). API clients: `Authorization: Bearer berry_pat_<id>_<secret>`. A request with an `Authorization` header is decided by it alone. |
```
Line 153 becomes: ``| 401 | `UNAUTHENTICATED` | Missing, invalid or expired session cookie or bearer token |``. Add a row after it: ``| 403 | `FORBIDDEN` | Also: a cookie-authenticated write sent from an origin the server does not trust |``, unless a 403 row already exists; in that case extend its description.

`AGENTS.md` lines 78-81: replace "opaque session tokens and `berry_pat_` tokens keep their exact shapes" with "`berry_pat_` tokens keep their exact shape; browser sessions are Better Auth cookies (GitHub is the only sign-in method, workstream J)". Leave the rest of the bullet as is.

`server-ts/ROUTING.md`, new section:
```markdown
## Sign-in

GitHub is the only way in, through Better Auth at `/api/auth/*`. It uses a
GitHub **OAuth App** of its own (`BERRY_AUTH_GITHUB_CLIENT_ID`/`_SECRET`,
scopes `read:user user:email`, callback `<BERRY_APP_URL>/api/auth/callback/github`),
separate from the repository GitHub App so sign-in never holds repository
access. A GitHub account links to an existing Berry user only through a
GitHub-verified email. Sessions are the `berry.session_token` cookie; personal
access tokens remain the bearer credential for API clients. Sessions issued
before migration 150 were revoked at cutover.
```

- [ ] **Step 2: Run the full gate**

```bash
pnpm typecheck:server && pnpm test:server
BERRY_TEST_DATABASE_URL=... pnpm test:server
python3 scripts/check-compose-config.py
cd frontend && pnpm lint && pnpm build:check
grep -rnI --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.next-verify "NEXT_PUBLIC_.*AUTH\|NEXT_PUBLIC_.*GITHUB" frontend server-ts docker-compose.yml .env.example
```
Expected: every command passes, and the last grep prints nothing. The OAuth secret is never browser-public.

- [ ] **Step 3: Commit**

```bash
git add server-ts/SCOPE.md server-ts/ROUTING.md docs/api/gateway-v1.md AGENTS.md
git commit -m "docs: record GitHub-only sign-in through Better Auth

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review (spec 3a against this plan)

| Spec 3a requirement | Task |
|---|---|
| Replace `server-ts/src/auth/` login and the auth, me and account mounts with Better Auth | 3, 5, 6, 7 (`me.ts` needs no change: it resolves through `requireSession`; `account.ts` sessions move to `auth_sessions`) |
| GitHub only; no Google, email and password, or magic link | 3 (`emailAndPassword.enabled: false`, only `socialProviders.github`, test that `/sign-up/email` is refused), 7 (password code and columns removed, with a guard test) |
| Single "Continue with GitHub" page; sign-up and password forms removed | 9 |
| Existing users keep ids; Better Auth maps onto `users`; links by verified email | 2, 3 (tests: same `users.id`, linked account, no second user; unverified refused for an existing user and for a new one) |
| Better Auth adds no side door around Berry (profile writes, GitHub token read-back) | 3 (`disabledPaths` for `/update-user`, `/get-access-token`, `/refresh-token`, `/account-info`, with a test); the `testUtils` plugin registers no HTTP routes and is installed only when `devLogin` is on |
| Account sessions settings stay per-user | 6 (`account.sessions.test.ts`: list and delete are scoped to the caller) |
| Existing sessions may be invalidated | 2 (revokes all legacy `sessions`), 5 (old bearers no longer resolve) |
| PATs and task-scoped tokens work as bearer auth beside sessions | 4 (`BearerResolver`, PAT resolver), 5 (tests: bearer never falls back to the cookie); A plugs task tokens into `bearer` |
| SSE stream authenticates with the session cookie | 6 (`events.auth.test.ts`), 8 (`apiStream` already sends `credentials: 'include'`) |
| Membership, invitations and cross-tenant guards unchanged | 5 (the cross-tenant and workspace-reads suites run unchanged apart from their credential); `parseAuthorization` kept for invitations |
| GitHub client id and secret are server config, never `NEXT_PUBLIC_` | 1, 10 (grep check) |
| Sign-in separate from the GitHub App | 1 (distinct env names, with a test), 3 (only the default `read:user`/`user:email` scopes), 10 (docs) |
| Migrations 150–159 | 150, 151 |
| Update every auth test | 4, 5 (rewritten or deleted with the reason stated), 6, 7 |

Placeholders: none. Every code step carries its code. The only conditional instructions are where the installed `better-auth@1.7.4` typings may name a field differently, and each of those says exactly what to check and what shape to keep.

Type consistency: `SessionService({ sql, auth, bearer, trustedOrigins })`, `resolveRequest(request)`, `loadUser(id)`, `SessionLookup.getSession({ headers })`, `BearerResolver { name, matches, resolve }`, `personalTokenResolver(sql, now?)`, `userFromRow`, `issueTestToken(sql, userId)`, `createBerryAuth(BerryAuthOptions)`, `devSessionCookies(auth, userId)`, `betterAuthMounts(auth)`, `authMounts({ sessions, sql, devSession })` and `Capabilities.githubSignIn` are used with the same names and shapes in every task.
