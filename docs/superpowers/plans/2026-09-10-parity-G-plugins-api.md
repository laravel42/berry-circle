# Parity G — Plugins and Public API v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Berry's public API v1 (`/v1/context`, `/v1/issues/:ref`, `/v1/issues/:ref/comments`, `/v1/storage/*`), authenticated by scoped personal access tokens or short-lived plugin tokens. Also ship workspace plugins: install from a URL or an upload with a preview, config, enable and disable, sealed secrets, key/value storage, an invocations log, event and scheduled hooks, iframe surfaces, and plugin MCP tools behind an admin approval list. Add a minimal TypeScript SDK in `packages/plugin-sdk`.

**Architecture:** A new `server-ts/src/plugins/` domain holds these pieces:
- the manifest schema (Zod v4) and the package loader;
- an SSRF-guarded outbound network;
- `PluginRepository` for installations, which seals secrets and the signing secret with `integrations/sealing.ts`;
- `PluginRuntimeStore` for plugin tokens, storage and the invocations log;
- `PluginHookRunner`, which polls `outbox_events` behind a Postgres-leased cursor row and fires interval schedules claimed with `FOR UPDATE SKIP LOCKED`.

There are two new mounts. `/v1` (`mounts/public-api.ts`) uses its own bearer middleware (`public-api/auth.ts`), which accepts only `berry_pat_` and `berry_plg_` tokens. `/api/v1/plugins/:workspaceId/*` (`mounts/plugins.ts`) sits behind the existing `mountWorkspaceScope` gate. Hooks and surfaces receive a freshly minted plugin token limited to the scopes the admin granted at install. A plugin always acts as, and never beyond, the member who installed it. Realtime uses `plugin.*` workspace topics written to `outbox_events`.

**Tech Stack:**
- Server: Node 22 `--experimental-strip-types`, Hono 4, postgres.js 3, Zod ^4.2.1, `node --test`, `node:crypto`/`node:dns`.
- SDK: the same Node toolchain, no runtime dependencies.
- Frontend: Next.js 15 App Router, React 19, Zod ^3.24.2, shadcn/ui primitives in `components/ui`, `sonner`.

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` §8 (Plugins and public API). §11 and §13 hold the cross-cutting gates.

## Global Constraints

- Migration block for G is **130–139**. This plan uses `130_plugins` and `131_personal_token_scopes`. Migrations are forward-only and immutable, named `NNN_description.up.sql` with a matching `.down.sql` as in the surrounding files.
- Every new table carries `workspace_id`. Every workspace mount goes through the existing workspace guard (`mountWorkspaceScope` / `ScopedDb`) and is added to the cross-tenant leakage tests.
- Secrets are stored only through `sealing.ts` (`Sealer.seal` / `Sealer.open`). They are never sent to the browser and never logged. Plugin secret values go only to the plugin's own endpoint in a hook call body.
- One deliberate, bounded exception: the plugin **signing secret** is Berry-generated and must reach the admin once so they can configure the plugin. It appears only in the `201` install response (`Cache-Control: no-store`). It is never readable again through any route, and it is stored sealed. Short-lived plugin tokens reach the browser only inside a surface launch URL fragment, and are scoped and time-limited.
- Server: no emitted TS syntax (no enums, namespaces or parameter properties), relative imports with `.ts` extensions, `import type` for types (`verbatimModuleSyntax`), `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, no `any`, no `!` in new code. Use 3-space indent and single quotes. Zod v4 is imported as `import { z } from 'zod';`.
- Server errors: throw `ApiError(status, CODE, message, details)` from `src/http/errors.ts`. Codes are stable `SCREAMING_SNAKE_CASE`. New codes: `INSUFFICIENT_SCOPE` (403), `PLUGIN_TOKEN_REQUIRED` (403), `PLUGIN_ALREADY_INSTALLED` (409), `PLUGIN_DISABLED` (409), `PLUGIN_UNREACHABLE` (502), `PLUGINS_NOT_CONFIGURED` (412), `UNSUPPORTED_MEDIA_TYPE` (415), `PAYLOAD_TOO_LARGE` (413). Reused codes: `INVALID_TRANSITION` (409) and `INVALID_PARENT` (422), both already used by issues and comments.
- **Precondition: workstream J (Better Auth) is merged.** J rewrites `SessionService` so its constructor is `{ sql, auth, bearer?, trustedOrigins? }` and it has no `resolvePersonalToken` method, and J moves PAT resolution into `personalTokenResolver(sql)` in `src/auth/credentials.ts`. G is written against that shape: `/v1` resolves PATs through `personalTokenResolver(sql)`, and tests build sessions with `testSessions(sql)` from the plugin fixture (T4). `requireSession` and `mountWorkspaceScope` keep their signatures under J. Do not start T4 (its fixture imports `auth/credentials.ts`) or any later DB-backed task until J's Task 5 is on the branch. T1–T3 and T11 do not depend on J.
- `plugin_event_cursor` is the one new table with no `workspace_id`. It is a single global row recording how far the hook runner has read `outbox_events` (which spans workspaces). It holds no tenant data, and no mount reads it.
- Server tests: `node --test`, co-located as `*.test.ts`. DB tests skip without `BERRY_TEST_DATABASE_URL`. Mount tests drive `createApp(registry)` with `app.request(...)`.
- Frontend: Prettier 3-space, single quotes, `@/*` alias, Zod v3, no `any`, no `!`, no `text-*` font-size utilities (ESLint rule). Gates: `pnpm lint:frontend` and `pnpm build:frontend`.
- Realtime: new events go through `outbox_events` + the existing SSE hub. No WebSocket.
- Clean-room: never copy multica source, schema text, copy or UI. All names and strings here are Berry's own. Web only. No new integrations (no GitLab/Gitea/Forgejo, no Slack/Telegram/Lark/DingTalk/WeCom, no Composio).
- Shared contract (owned elsewhere, do not redefine): `enqueueTask`, `registerAgentTool`, `TaskEnvelope`, `LifecycleEvent`, `recordTaskUsage`, `task_tokens`, `agent_runtimes`. G only **exports** `pluginMcpServers()` for D's envelope builder to consume (Task 10). G does not edit A's or D's files.
- The `/api/v1` wire shape is a contract. `/api/v1/tokens` only gains an additive `scopes` request field and an appended `scopes` response field.
- Commits: `type(scope): imperative summary`, scope `server-ts`, `plugin-sdk` or `frontend`. Executors commit per task. Nothing is committed while this plan is being written.

---

## File Structure

**Server — `server-ts/`**

| File | Responsibility |
|---|---|
| `migrations/130_plugins.{up,down}.sql` | plugin tables |
| `migrations/131_personal_token_scopes.{up,down}.sql` | `personal_api_tokens.scopes text[]` (NULL = every scope) |
| `src/public-api/scopes.ts` | `API_SCOPES`, `ApiScope`, `parseScopes`, `grants` |
| `src/plugins/tokens.ts` | `berry_plg_` token and signing-secret primitives |
| `src/plugins/errors.ts` | `InvalidPluginInput`, `PluginUnreachable`, `PluginAlreadyInstalled`, `zodFields` |
| `src/plugins/manifest.ts` | manifest + package Zod schemas, `parsePackage`, `validateConfig`, `describePackage` |
| `src/plugins/net.ts` | `isPrivateAddress`, `createPluginNetwork` (https, public IPs, no redirects, byte cap, timeout) |
| `src/plugins/loader.ts` | `loadPackage` from `{url}` or `{package}` |
| `src/plugins/events.ts` | `appendPluginEvent` into `outbox_events` |
| `src/plugins/repository.ts` | `PluginRepository` (installations, config, secrets, tool approvals, files) |
| `src/plugins/runtime-store.ts` | `PluginRuntimeStore` (tokens, storage, invocations) |
| `src/plugins/signing.ts` | `signPayload`, `SIGNATURE_HEADER` |
| `src/plugins/hooks.ts` | `PluginCaller`, `PluginHookRunner` |
| `src/plugins/mcp.ts` | `pluginMcpServers()` for the envelope builder |
| `src/plugins/fixture.test-support.ts` | shared DB fixture for plugin tests |
| `src/http/json-body.ts` | `readJson(context, zodSchema)` |
| `src/public-api/auth.ts` | `requireApiCredential`, `resolvePrincipal`, `requireScope`, `requirePlugin` |
| `src/mounts/public-api.ts` | `/v1` mount |
| `src/mounts/plugins.ts` | `/api/v1/plugins` admin mount |
| `src/mounts/plugins.cross-tenant.test.ts` | leakage tests for both new mounts |
| Modify `src/identity/secrets.ts`, `src/mounts/secrets.ts` | PAT scopes |
| Modify `src/realtime/replay.ts` | add `plugin.*` to `WORKSPACE_TOPICS` |
| Modify `src/config/config.ts` | `pluginsAllowPrivateNetwork` |
| Modify `src/index.ts` | wiring |
| Modify `SCOPE.md` (`server-ts/SCOPE.md`), `../docs/api/gateway-v1.md` | served prefixes and the v1 contract |

**SDK — `packages/plugin-sdk/`** (new pnpm workspace): `package.json`, `tsconfig.json`, `src/index.ts`, `src/manifest.ts` (types), `src/signature.ts`, `src/client.ts`, `src/surface.ts`, `src/*.test.ts`, `examples/hello/berry-plugin.json`. Modify root `pnpm-workspace.yaml` and `package.json`.

**Frontend — `frontend/`**

| File | Responsibility |
|---|---|
| `lib/plugins.ts` | Zod v3 client for the admin mount |
| `components/common/settings/plugins-settings.tsx` | list + install (URL or `.json` upload) with preview |
| `components/common/settings/plugin-detail.tsx` | config, enable, secrets, tool approvals, storage, invocations, uninstall |
| `components/common/plugins/plugin-surface.tsx` | sandboxed iframe launcher |
| `app/[orgId]/settings/plugins/page.tsx`, `app/[orgId]/settings/plugins/[pluginId]/page.tsx`, `app/[orgId]/plugins/[pluginId]/[surface]/page.tsx` | pages |
| Modify `components/layout/sidebar/nav-settings.tsx` | one `plugins` item (workstream I rewrites this file; G appends its item as I's comment instructs) |
| Modify `lib/settings.ts`, `components/common/settings/account-security.tsx` | PAT scopes |

## Task graph (for parallel subagents)

- Wave 1 (independent): **T1** migrations, **T2** scopes and tokens, **T3** manifest, network and loader, **T11** SDK.
- Wave 2: **T4** repository (T1, T2, T3), **T5** runtime store (T1, T2).
- Wave 3: **T6** auth + PAT scopes (T5), **T8** admin mount (T4, T5).
- Wave 4: **T7** public mount (T6), **T9** hooks (T4, T5), **T10** MCP export (T4, T5).
- Wave 5: **T12**, **T13**, **T14** frontend (T8; T14 needs T6).

## Test database

DB-gated tests need the new migrations applied to the database the test DB is dumped from. After T1, and whenever a migration changes:

```bash
cd /Users/secret/Code/berry-circle
docker compose exec -T berry-api node --experimental-strip-types src/migrate/index.ts
docker compose exec -T postgres sh -c 'dropdb -U berry --if-exists berry_test; createdb -U berry berry_test; pg_dump -U berry --schema-only --no-owner --no-privileges berry | psql -U berry -d berry_test -q'
docker run -d --rm --name berry-pg-bridge --network berry-stack_default -p 15432:15432 alpine/socat tcp-listen:15432,fork,reuseaddr tcp:postgres:5432 || true
export BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable'
```

`pg_dump --schema-only` does not copy the `plugin_event_cursor` seed row, so the T1 test inserts it with `ON CONFLICT DO NOTHING`.

---

### Task 1: Plugin schema and PAT scopes migrations

**Files:**
- Create: `server-ts/migrations/130_plugins.up.sql`, `server-ts/migrations/130_plugins.down.sql`
- Create: `server-ts/migrations/131_personal_token_scopes.up.sql`, `server-ts/migrations/131_personal_token_scopes.down.sql`
- Test: `server-ts/src/plugins/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces these tables, used by T4, T5, T9 and T10:
  - `plugin_installations(id, workspace_id, plugin_key, name, version, manifest jsonb, source, source_url, base_url, enabled, config jsonb, granted_scopes text[], signing_secret_encrypted bytea, installed_by, created_at, updated_at)`
  - `plugin_files`, `plugin_secrets`, `plugin_storage`, `plugin_invocations`, `plugin_tokens`, `plugin_hook_state`, `plugin_event_cursor` (single row `id = 1`), `plugin_tool_approvals`
  - `personal_api_tokens.scopes text[] NULL`

- [ ] **Step 1: Write the failing test**

`server-ts/src/plugins/schema.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';

/** The plugin tables exist with the constraints the repositories rely on. */

const url = process.env.BERRY_TEST_DATABASE_URL;

const TABLES = [
   'plugin_installations',
   'plugin_files',
   'plugin_secrets',
   'plugin_storage',
   'plugin_invocations',
   'plugin_tokens',
   'plugin_hook_state',
   'plugin_event_cursor',
   'plugin_tool_approvals',
];

describe('plugin schema', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   before(() => {
      sql = openDatabase({ url: url as string });
   });
   after(async () => {
      await closeDatabase(sql);
   });

   test('every plugin table exists and carries workspace_id', async () => {
      for (const table of TABLES) {
         const [exists] = await sql`SELECT to_regclass(${table}) AS name`;
         assert.equal(exists?.name, table, `${table} exists`);
         // The cursor is the one documented exception: a single global row.
         if (table === 'plugin_event_cursor') continue;
         const rows = await sql`
            SELECT column_name FROM information_schema.columns
             WHERE table_name = ${table} AND column_name = 'workspace_id'`;
         assert.equal(rows.length, 1, `${table}.workspace_id`);
      }
   });

   test('the event cursor is a single row', async () => {
      await sql`INSERT INTO plugin_event_cursor (id) VALUES (1) ON CONFLICT DO NOTHING`;
      const rows = await sql`SELECT id FROM plugin_event_cursor`;
      assert.equal(rows.length, 1);
      await assert.rejects(sql`INSERT INTO plugin_event_cursor (id) VALUES (2)`);
   });

   test('personal tokens carry nullable scopes', async () => {
      const [column] = await sql`
         SELECT is_nullable, data_type FROM information_schema.columns
          WHERE table_name = 'personal_api_tokens' AND column_name = 'scopes'`;
      assert.equal(column?.is_nullable, 'YES');
      assert.equal(column?.data_type, 'ARRAY');
   });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=$BERRY_TEST_DATABASE_URL node --test --experimental-strip-types src/plugins/schema.test.ts`
Expected: FAIL, `plugin_installations.workspace_id` (0 !== 1).

- [ ] **Step 3: Write the migrations**

`server-ts/migrations/130_plugins.up.sql`:

```sql
-- Workspace plugins: a package (manifest plus files) installed into one
-- workspace, calling back into Berry with short-lived plugin tokens.
--
-- Every table carries workspace_id, even where the installation already
-- implies it, so a scoped query can filter on the column directly.

CREATE TABLE IF NOT EXISTS plugin_installations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    plugin_key text NOT NULL,
    name text NOT NULL,
    version text NOT NULL,
    manifest jsonb NOT NULL,
    source text NOT NULL,
    source_url text,
    base_url text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    granted_scopes text[] NOT NULL DEFAULT '{}',
    signing_secret_encrypted bytea NOT NULL,
    installed_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plugin_installations_key_ck CHECK (plugin_key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    CONSTRAINT plugin_installations_source_ck CHECK (source IN ('url', 'upload')),
    CONSTRAINT plugin_installations_source_url_ck CHECK ((source = 'url') = (source_url IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_installations_workspace_key
    ON plugin_installations (workspace_id, plugin_key);

CREATE TABLE IF NOT EXISTS plugin_files (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path text NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (installation_id, path),
    CONSTRAINT plugin_files_size_ck CHECK (octet_length(content) <= 262144)
);

CREATE TABLE IF NOT EXISTS plugin_secrets (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    value_encrypted bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (installation_id, name),
    CONSTRAINT plugin_secrets_name_ck CHECK (name ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE TABLE IF NOT EXISTS plugin_storage (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (installation_id, key),
    CONSTRAINT plugin_storage_key_ck CHECK (char_length(key) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS plugin_invocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    kind text NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    http_status integer,
    duration_ms integer NOT NULL DEFAULT 0,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plugin_invocations_kind_ck CHECK (kind IN ('event', 'schedule', 'surface', 'mcp')),
    CONSTRAINT plugin_invocations_status_ck CHECK (status IN ('ok', 'error'))
);
CREATE INDEX IF NOT EXISTS plugin_invocations_recent
    ON plugin_invocations (installation_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS plugin_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    public_id text NOT NULL,
    secret_hash bytea NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}',
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plugin_tokens_public_id_ck CHECK (public_id ~ '^[A-Za-z0-9_-]{16}$'),
    CONSTRAINT plugin_tokens_hash_ck CHECK (octet_length(secret_hash) = 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_tokens_public_id_key ON plugin_tokens (public_id);
CREATE INDEX IF NOT EXISTS plugin_tokens_expiry ON plugin_tokens (expires_at);

CREATE TABLE IF NOT EXISTS plugin_hook_state (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    hook_key text NOT NULL,
    interval_minutes integer NOT NULL,
    next_fire_at timestamptz NOT NULL,
    last_fired_at timestamptz,
    PRIMARY KEY (installation_id, hook_key),
    CONSTRAINT plugin_hook_state_interval_ck CHECK (interval_minutes BETWEEN 5 AND 10080)
);
CREATE INDEX IF NOT EXISTS plugin_hook_state_due ON plugin_hook_state (next_fire_at);

-- One row: how far the event hook runner has read outbox_events. Locked
-- FOR UPDATE SKIP LOCKED so exactly one server delivers each event.
CREATE TABLE IF NOT EXISTS plugin_event_cursor (
    id smallint PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    event_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    CONSTRAINT plugin_event_cursor_single_ck CHECK (id = 1)
);
INSERT INTO plugin_event_cursor (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS plugin_tool_approvals (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tool_name text NOT NULL,
    approved_by uuid NOT NULL REFERENCES users(id),
    approved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (installation_id, tool_name)
);

-- The hook runner reads outbox_events in (occurred_at, id) order every few
-- seconds; the existing index covers only unpublished rows.
CREATE INDEX IF NOT EXISTS outbox_events_occurred_order_idx
    ON outbox_events (occurred_at, id);
```

`server-ts/migrations/130_plugins.down.sql`:

```sql
DROP INDEX IF EXISTS outbox_events_occurred_order_idx;
DROP TABLE IF EXISTS plugin_tool_approvals;
DROP TABLE IF EXISTS plugin_event_cursor;
DROP TABLE IF EXISTS plugin_hook_state;
DROP TABLE IF EXISTS plugin_tokens;
DROP TABLE IF EXISTS plugin_invocations;
DROP TABLE IF EXISTS plugin_storage;
DROP TABLE IF EXISTS plugin_secrets;
DROP TABLE IF EXISTS plugin_files;
DROP TABLE IF EXISTS plugin_installations;
```

`server-ts/migrations/131_personal_token_scopes.up.sql`:

```sql
-- Scopes on personal access tokens for the public API.
-- NULL means every scope, so tokens issued before scopes existed keep working.
ALTER TABLE personal_api_tokens ADD COLUMN IF NOT EXISTS scopes text[];
COMMENT ON COLUMN personal_api_tokens.scopes IS
    'Public API scopes this token holds; NULL grants every scope (legacy tokens).';
```

`server-ts/migrations/131_personal_token_scopes.down.sql`:

```sql
ALTER TABLE personal_api_tokens DROP COLUMN IF EXISTS scopes;
```

- [ ] **Step 4: Apply the migrations, rebuild the test DB and run the test**

Run the "Test database" commands above, then:
`cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server-ts/migrations/130_plugins.*.sql server-ts/migrations/131_personal_token_scopes.*.sql server-ts/src/plugins/schema.test.ts
git commit -m "feat(server-ts): add plugin tables and personal token scopes"
```

---

### Task 2: API scopes and plugin token primitives

**Files:**
- Create: `server-ts/src/public-api/scopes.ts`, `server-ts/src/plugins/tokens.ts`
- Test: `server-ts/src/public-api/scopes.test.ts`, `server-ts/src/plugins/tokens.test.ts`

**Interfaces:**
- Consumes: `digestToken`, `Unauthenticated` from `src/auth/tokens.ts`.
- Produces:
  - `API_SCOPES: readonly ['issues:read','issues:write','comments:read','comments:write','storage:read','storage:write']`
  - `type ApiScope`
  - `isApiScope(v: unknown): v is ApiScope`
  - `parseScopes(v: unknown): ApiScope[] | null`, where null means invalid input. The result is sorted and deduplicated.
  - `grants(held: readonly ApiScope[] | null, needed: ApiScope): boolean`, where `held === null` grants all.
  - `PLUGIN_TOKEN_PREFIX = 'berry_plg_'`
  - `generatePluginToken(random?): { token: string; publicId: string; secretHash: Buffer }`
  - `isPluginToken(t: string): boolean`
  - `parsePluginToken(t: string): { publicId: string; secret: string }`, which throws `Unauthenticated`
  - `generateSigningSecret(random?): string` (`berry_whsec_` + 43 chars)

- [ ] **Step 1: Write the failing tests**

`server-ts/src/public-api/scopes.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_SCOPES, grants, isApiScope, parseScopes } from './scopes.ts';

test('parseScopes accepts known scopes, sorted and without duplicates', () => {
   assert.deepEqual(parseScopes(['issues:write', 'comments:read', 'issues:write']), [
      'comments:read',
      'issues:write',
   ]);
   assert.deepEqual(parseScopes([]), []);
});

test('parseScopes refuses anything that is not a list of known scopes', () => {
   assert.equal(parseScopes(['issues:admin']), null);
   assert.equal(parseScopes('issues:read'), null);
   assert.equal(parseScopes([1]), null);
});

test('a null scope list grants everything; a list grants only what it names', () => {
   for (const scope of API_SCOPES) assert.equal(grants(null, scope), true);
   assert.equal(grants(['issues:read'], 'issues:read'), true);
   assert.equal(grants(['issues:read'], 'issues:write'), false);
   assert.equal(isApiScope('storage:write'), true);
   assert.equal(isApiScope('storage'), false);
});
```

`server-ts/src/plugins/tokens.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestToken, Unauthenticated } from '../auth/tokens.ts';
import {
   generatePluginToken,
   generateSigningSecret,
   isPluginToken,
   parsePluginToken,
   PLUGIN_TOKEN_PREFIX,
} from './tokens.ts';

test('a generated plugin token parses back to its halves', () => {
   const generated = generatePluginToken();
   assert.ok(generated.token.startsWith(PLUGIN_TOKEN_PREFIX));
   assert.ok(isPluginToken(generated.token));
   const parsed = parsePluginToken(generated.token);
   assert.equal(parsed.publicId, generated.publicId);
   assert.deepEqual(digestToken(parsed.secret), generated.secretHash);
});

test('a public id containing the separator still splits by position', () => {
   // 0xff bytes encode to '_' in base64url, so the id is full of separators.
   const token = generatePluginToken((size) => Buffer.alloc(size, 0xff)).token;
   const parsed = parsePluginToken(token);
   assert.equal(parsed.publicId.length, 16);
   assert.equal(parsed.secret.length, 43);
});

test('malformed plugin tokens are refused identically', () => {
   const good = generatePluginToken().token;
   for (const bad of [
      'berry_pat_' + good.slice(PLUGIN_TOKEN_PREFIX.length),
      good.slice(0, -1),
      good + 'A',
      good.slice(0, -1) + '+',
      PLUGIN_TOKEN_PREFIX,
   ]) {
      assert.throws(() => parsePluginToken(bad), Unauthenticated);
   }
});

test('signing secrets are prefixed and unique', () => {
   const a = generateSigningSecret();
   const b = generateSigningSecret();
   assert.match(a, /^berry_whsec_[A-Za-z0-9_-]{43}$/);
   assert.notEqual(a, b);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/public-api/scopes.test.ts src/plugins/tokens.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./scopes.ts` and `./tokens.ts`.

- [ ] **Step 3: Implement**

`server-ts/src/public-api/scopes.ts`:

```ts
/**
 * What a public API credential may do.
 *
 * A personal token with no scopes (NULL) predates scopes and keeps full
 * access; a plugin token always carries an explicit list, intersected with
 * what the admin granted the installation.
 */

export const API_SCOPES = [
   'issues:read',
   'issues:write',
   'comments:read',
   'comments:write',
   'storage:read',
   'storage:write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: unknown): value is ApiScope {
   return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

/** A sorted, de-duplicated scope list, or null when anything in it is unknown. */
export function parseScopes(value: unknown): ApiScope[] | null {
   if (!Array.isArray(value)) return null;
   const scopes: ApiScope[] = [];
   for (const entry of value) {
      if (!isApiScope(entry)) return null;
      if (!scopes.includes(entry)) scopes.push(entry);
   }
   return scopes.sort();
}

export function grants(held: readonly ApiScope[] | null, needed: ApiScope): boolean {
   return held === null || held.includes(needed);
}
```

`server-ts/src/plugins/tokens.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { digestToken, Unauthenticated } from '../auth/tokens.ts';

/**
 * `berry_plg_<publicId>_<secret>`: the same fixed-width shape as a personal
 * token, in its own namespace, so the public API can tell the two apart by
 * prefix and index the public half.
 */

export const PLUGIN_TOKEN_PREFIX = 'berry_plg_';
const SIGNING_PREFIX = 'berry_whsec_';
const ID_BYTES = 12;
const SECRET_BYTES = 32;
const ID_LENGTH = 16;
const SECRET_LENGTH = 43;

export interface GeneratedPluginToken {
   token: string;
   publicId: string;
   secretHash: Buffer;
}

export function generatePluginToken(
   random: (size: number) => Buffer = randomBytes
): GeneratedPluginToken {
   const publicId = random(ID_BYTES).toString('base64url');
   const secret = random(SECRET_BYTES).toString('base64url');
   return {
      token: `${PLUGIN_TOKEN_PREFIX}${publicId}_${secret}`,
      publicId,
      secretHash: digestToken(secret),
   };
}

export function isPluginToken(token: string): boolean {
   return token.startsWith(PLUGIN_TOKEN_PREFIX);
}

/** Split by position: both halves are base64url, whose alphabet includes '_'. */
export function parsePluginToken(token: string): { publicId: string; secret: string } {
   if (!isPluginToken(token)) throw new Unauthenticated();
   const rest = token.slice(PLUGIN_TOKEN_PREFIX.length);
   if (rest.length !== ID_LENGTH + 1 + SECRET_LENGTH || rest[ID_LENGTH] !== '_') {
      throw new Unauthenticated();
   }
   const publicId = rest.slice(0, ID_LENGTH);
   const secret = rest.slice(ID_LENGTH + 1);
   if (!decodesTo(publicId, ID_BYTES) || !decodesTo(secret, SECRET_BYTES)) {
      throw new Unauthenticated();
   }
   return { publicId, secret };
}

/** The HMAC key a plugin verifies Berry's calls with. Shown once, stored sealed. */
export function generateSigningSecret(random: (size: number) => Buffer = randomBytes): string {
   return SIGNING_PREFIX + random(SECRET_BYTES).toString('base64url');
}

/** Node's decoder skips unknown characters; re-encoding makes the check strict. */
function decodesTo(value: string, bytes: number): boolean {
   const decoded = Buffer.from(value, 'base64url');
   return decoded.length === bytes && decoded.toString('base64url') === value;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/public-api/scopes.test.ts src/plugins/tokens.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/public-api/scopes.ts server-ts/src/public-api/scopes.test.ts server-ts/src/plugins/tokens.ts server-ts/src/plugins/tokens.test.ts
git commit -m "feat(server-ts): add public API scopes and plugin token primitives"
```

---
### Task 3: Manifest schema, SSRF-guarded network, package loader

**Files:**
- Create: `server-ts/src/plugins/errors.ts`, `server-ts/src/plugins/manifest.ts`, `server-ts/src/plugins/net.ts`, `server-ts/src/plugins/loader.ts`
- Modify: `server-ts/src/config/config.ts`: add `pluginsAllowPrivateNetwork`
- Test: `server-ts/src/plugins/manifest.test.ts`, `server-ts/src/plugins/net.test.ts`, `server-ts/src/plugins/loader.test.ts`

**Interfaces:**
- Consumes: `API_SCOPES` from T2.
- Produces:
  - `class InvalidPluginInput extends Error { fields: PluginFieldError[] }`
  - `interface PluginFieldError { path: string; message: string }`
  - `class PluginUnreachable extends Error`
  - `class PluginAlreadyInstalled extends Error`
  - `zodFields(error: z.ZodError): PluginFieldError[]`
  - `pluginManifestSchema`, `type PluginManifest`, `pluginPackageSchema`, `type PluginPackage`
  - `type PluginConfig = Record<string, string | number | boolean>`
  - `parsePackage(v: unknown): PluginPackage`, which throws `InvalidPluginInput`
  - `validateConfig(m: PluginManifest, v: unknown): PluginConfig`, which throws `InvalidPluginInput`
  - `describePackage(p: PluginPackage): PluginPreview`
  - `interface PluginNetwork { request(url: string, init: PluginRequest): Promise<{ status: number; body: string }> }`
  - `interface PluginRequest { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number }`
  - `createPluginNetwork(o: { allowPrivate: boolean; resolve?: (host: string) => Promise<string[]>; fetchImpl?: (url: URL, init: RequestInit) => Promise<Response> }): PluginNetwork`
  - `isPrivateAddress(ip: string): boolean`
  - `type PackageSource = { url: string } | { package: unknown }`
  - `loadPackage(net: PluginNetwork, source: PackageSource): Promise<{ pkg: PluginPackage; source: 'url' | 'upload'; sourceUrl: string | null }>`
  - `Config.pluginsAllowPrivateNetwork: boolean`

- [ ] **Step 1: Write the failing tests**

`server-ts/src/plugins/manifest.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidPluginInput } from './errors.ts';
import { HELLO } from './fixture.test-support.ts';
import { describePackage, parsePackage, validateConfig } from './manifest.ts';

function fields(work: () => unknown): string[] {
   try {
      work();
   } catch (error) {
      assert.ok(error instanceof InvalidPluginInput);
      return error.fields.map((field) => field.path);
   }
   assert.fail('expected InvalidPluginInput');
}

test('a complete package parses with defaults filled in', () => {
   const pkg = parsePackage(HELLO);
   assert.equal(pkg.manifest.key, 'hello');
   assert.equal(pkg.manifest.description, '');
   assert.equal(pkg.manifest.hooks.length, 2);
   assert.equal(pkg.files.length, 1);
});

test('unknown manifest fields and bad keys are refused with their path', () => {
   assert.deepEqual(fields(() => parsePackage({ manifest: { ...HELLO.manifest, extra: 1 } })), ['/manifest']);
   assert.ok(fields(() => parsePackage({ manifest: { ...HELLO.manifest, key: 'Bad Key' } })).includes('/manifest/key'));
   assert.ok(fields(() => parsePackage({ manifest: { ...HELLO.manifest, scopes: ['admin'] } })).includes('/manifest/scopes/0'));
});

test('duplicate hook keys and path traversal are refused', () => {
   const hooks = [HELLO.manifest.hooks[0], HELLO.manifest.hooks[0]];
   assert.ok(fields(() => parsePackage({ manifest: { ...HELLO.manifest, hooks } })).includes('/manifest/hooks/1/key'));
   assert.ok(fields(() => parsePackage({ ...HELLO, files: [{ path: '../x', content: '' }] })).includes('/files/0/path'));
   const surfaces = [{ key: 'panel', title: 'P', path: '/a/../b' }];
   assert.ok(fields(() => parsePackage({ manifest: { ...HELLO.manifest, surfaces } })).includes('/manifest/surfaces/0/path'));
});

test('config is checked against the manifest', () => {
   const { manifest } = parsePackage(HELLO);
   assert.deepEqual(validateConfig(manifest, { greeting: 'hi' }), { greeting: 'hi' });
   assert.deepEqual(fields(() => validateConfig(manifest, {})), ['/config/greeting']);
   assert.deepEqual(fields(() => validateConfig(manifest, { greeting: 1 })), ['/config/greeting']);
   assert.deepEqual(fields(() => validateConfig(manifest, { greeting: 'hi', other: 'x' })), ['/config/other']);
});

test('the preview names everything the admin is agreeing to', () => {
   const preview = describePackage(parsePackage(HELLO));
   assert.deepEqual(preview.scopes, ['issues:read', 'comments:write']);
   assert.deepEqual(preview.events, ['comment.created']);
   assert.deepEqual(preview.schedules, [{ key: 'nightly', everyMinutes: 1440 }]);
   assert.deepEqual(preview.mcpTools, ['say_hello']);
   assert.deepEqual(preview.files, [{ path: 'README.md', size: 7 }]);
});
```

`server-ts/src/plugins/net.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginUnreachable } from './errors.ts';
import { createPluginNetwork, isPrivateAddress } from './net.ts';

test('private, loopback, link-local and mapped addresses are private', () => {
   for (const ip of [
      '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1',
      // WHATWG URL rewrites [::ffff:10.0.0.1] to this hex form, so it must be caught too.
      '::ffff:a00:1', '::ffff:7f00:1', '::a9fe:a9fe', '64:ff9b::a00:1', '2002:a00:1::1', 'not-an-ip',
   ]) {
      assert.equal(isPrivateAddress(ip), true, ip);
   }
   for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:808:808']) {
      assert.equal(isPrivateAddress(ip), false, ip);
   }
});

test('a bracketed mapped address in a URL is refused', async () => {
   const net = createPluginNetwork({ allowPrivate: false, fetchImpl: async () => new Response('{}') });
   await assert.rejects(
      net.request('https://[::ffff:10.0.0.1]/x', { method: 'GET', timeoutMs: 1000, maxBytes: 1000 }),
      PluginUnreachable
   );
});

const ok = async () => new Response('{"ok":true}', { status: 200 });
const init = { method: 'GET' as const, timeoutMs: 1000, maxBytes: 1000 };

test('http and private destinations are refused unless private networking is allowed', async () => {
   const net = createPluginNetwork({ allowPrivate: false, resolve: async () => ['10.0.0.5'], fetchImpl: ok });
   await assert.rejects(net.request('http://plugin.example.com/x', init), PluginUnreachable);
   await assert.rejects(net.request('https://plugin.example.com/x', init), PluginUnreachable);
   await assert.rejects(net.request('https://127.0.0.1/x', init), PluginUnreachable);

   const open = createPluginNetwork({ allowPrivate: true, fetchImpl: ok });
   assert.deepEqual(await open.request('http://127.0.0.1/x', init), { status: 200, body: '{"ok":true}' });
});

test('a public destination is fetched; redirects and oversize bodies are refused', async () => {
   const net = createPluginNetwork({ allowPrivate: false, resolve: async () => ['8.8.8.8'], fetchImpl: ok });
   assert.equal((await net.request('https://plugin.example.com/x', init)).status, 200);

   const redirecting = createPluginNetwork({
      allowPrivate: false,
      resolve: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1' } }),
   });
   await assert.rejects(redirecting.request('https://plugin.example.com/x', init), PluginUnreachable);

   const big = createPluginNetwork({
      allowPrivate: false,
      resolve: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response('x'.repeat(2000), { status: 200 }),
   });
   await assert.rejects(big.request('https://plugin.example.com/x', init), PluginUnreachable);
});
```

`server-ts/src/plugins/loader.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidPluginInput, PluginUnreachable } from './errors.ts';
import { loadPackage } from './loader.ts';
import type { PluginNetwork } from './net.ts';
import { HELLO } from './fixture.test-support.ts';

function fakeNet(status: number, body: string): PluginNetwork {
   return { request: async () => ({ status, body }) };
}

test('an uploaded package is parsed and marked as an upload', async () => {
   const loaded = await loadPackage(fakeNet(500, ''), { package: HELLO });
   assert.equal(loaded.source, 'upload');
   assert.equal(loaded.sourceUrl, null);
   assert.equal(loaded.pkg.manifest.key, 'hello');
});

test('a URL package is fetched and remembers where it came from', async () => {
   const loaded = await loadPackage(fakeNet(200, JSON.stringify(HELLO)), { url: 'https://hello.example.com/berry-plugin.json' });
   assert.equal(loaded.source, 'url');
   assert.equal(loaded.sourceUrl, 'https://hello.example.com/berry-plugin.json');
});

test('a URL that fails or is not a package is refused', async () => {
   await assert.rejects(loadPackage(fakeNet(404, ''), { url: 'https://x.example.com/p.json' }), PluginUnreachable);
   await assert.rejects(loadPackage(fakeNet(200, 'not json'), { url: 'https://x.example.com/p.json' }), InvalidPluginInput);
});
```

Both tests import `HELLO` from `server-ts/src/plugins/fixture.test-support.ts`, which is not a test file, so importing it registers no tests. Create that file now with exactly this content. T4 replaces the file and keeps `HELLO` byte for byte.

```ts
/** Shared by the plugin and public API tests. Not a test file itself. */

export const HELLO = {
   manifest: {
      schemaVersion: 1,
      key: 'hello',
      name: 'Hello',
      version: '1.0.0',
      baseUrl: 'https://hello.example.com',
      scopes: ['issues:read', 'comments:write'],
      config: [{ key: 'greeting', label: 'Greeting', type: 'string', required: true }],
      secrets: [{ name: 'API_KEY' }],
      hooks: [
         { key: 'on-comment', trigger: 'event', events: ['comment.created'], path: '/hooks/comment' },
         { key: 'nightly', trigger: 'schedule', everyMinutes: 1440, path: '/hooks/nightly' },
      ],
      surfaces: [{ key: 'panel', title: 'Hello panel', path: '/ui' }],
      mcp: { path: '/mcp', tools: [{ name: 'say_hello' }] },
   },
   files: [{ path: 'README.md', content: '# Hello' }],
};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/manifest.test.ts src/plugins/net.test.ts src/plugins/loader.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `errors.ts`**

```ts
import type { z } from 'zod';

export interface PluginFieldError {
   path: string;
   message: string;
}

/** A package, config or secret the plugin does not allow. Mapped to 422. */
export class InvalidPluginInput extends Error {
   override readonly name = 'InvalidPluginInput';
   readonly fields: PluginFieldError[];
   constructor(fields: PluginFieldError[]) {
      super('invalid plugin input');
      this.fields = fields;
   }
}

/** The plugin's endpoint could not be reached safely. Mapped to 502. */
export class PluginUnreachable extends Error {
   override readonly name = 'PluginUnreachable';
}

/** The workspace already has a plugin with this key. Mapped to 409. */
export class PluginAlreadyInstalled extends Error {
   override readonly name = 'PluginAlreadyInstalled';
}

export function zodFields(error: z.ZodError): PluginFieldError[] {
   return error.issues.map((issue) => ({
      path: '/' + issue.path.map(String).join('/'),
      message: issue.message,
   }));
}
```

Note that a Zod v4 unrecognized-keys issue reports the object's path (for example `/manifest`), which is what the test expects.

- [ ] **Step 4: Implement `manifest.ts`**

```ts
import { z } from 'zod';
import { API_SCOPES } from '../public-api/scopes.ts';
import { InvalidPluginInput, zodFields, type PluginFieldError } from './errors.ts';

/**
 * The plugin package: a manifest describing what the plugin asks for, plus a
 * few text files shown in the install preview. Berry never serves the files
 * as pages — surfaces are the plugin's own https URLs, loaded in an iframe.
 */

const KEY = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SHORT_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FILE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const pathSchema = z
   .string()
   .regex(/^\/[A-Za-z0-9._~/-]{0,200}$/, 'Path must start with / and use URL-safe characters.')
   .refine((path) => !path.split('/').includes('..'), 'Path must not contain "..".');

const baseUrlSchema = z
   .string()
   .max(500)
   .refine((value) => {
      try {
         const url = new URL(value);
         return (
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            url.username === '' &&
            url.password === '' &&
            url.search === '' &&
            url.hash === ''
         );
      } catch {
         return false;
      }
   }, 'Base URL must be an http(s) URL without credentials, query or fragment.');

const configFieldSchema = z
   .object({
      key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
      label: z.string().trim().min(1).max(80),
      type: z.enum(['string', 'number', 'boolean']),
      required: z.boolean().default(false),
   })
   .strict();

const hookSchema = z.discriminatedUnion('trigger', [
   z
      .object({
         key: z.string().regex(SHORT_KEY),
         trigger: z.literal('event'),
         events: z.array(z.string().regex(/^[a-z]+(\.[a-z_]+)+$/)).min(1).max(20),
         path: pathSchema,
      })
      .strict(),
   z
      .object({
         key: z.string().regex(SHORT_KEY),
         trigger: z.literal('schedule'),
         everyMinutes: z.number().int().min(5).max(10080),
         path: pathSchema,
      })
      .strict(),
]);

export const pluginManifestSchema = z
   .object({
      schemaVersion: z.literal(1),
      key: z.string().regex(KEY),
      name: z.string().trim().min(1).max(80),
      version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
      description: z.string().max(500).default(''),
      baseUrl: baseUrlSchema,
      scopes: z.array(z.enum(API_SCOPES)).max(API_SCOPES.length).default([]),
      config: z.array(configFieldSchema).max(50).default([]),
      secrets: z
         .array(
            z
               .object({
                  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
                  description: z.string().max(200).default(''),
               })
               .strict()
         )
         .max(20)
         .default([]),
      hooks: z.array(hookSchema).max(20).default([]),
      surfaces: z
         .array(
            z
               .object({
                  key: z.string().regex(SHORT_KEY),
                  title: z.string().trim().min(1).max(60),
                  path: pathSchema,
               })
               .strict()
         )
         .max(10)
         .default([]),
      mcp: z
         .object({
            path: pathSchema,
            tools: z
               .array(
                  z
                     .object({
                        name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
                        description: z.string().max(500).default(''),
                     })
                     .strict()
               )
               .min(1)
               .max(50),
         })
         .strict()
         .optional(),
   })
   .strict()
   .superRefine((manifest, ctx) => {
      const unique = (values: string[], path: (index: number) => (string | number)[]) => {
         const seen = new Set<string>();
         values.forEach((value, index) => {
            if (seen.has(value)) ctx.addIssue({ code: 'custom', message: 'Must be unique.', path: path(index) });
            seen.add(value);
         });
      };
      unique(manifest.config.map((f) => f.key), (i) => ['config', i, 'key']);
      unique(manifest.secrets.map((s) => s.name), (i) => ['secrets', i, 'name']);
      unique(manifest.hooks.map((h) => h.key), (i) => ['hooks', i, 'key']);
      unique(manifest.surfaces.map((s) => s.key), (i) => ['surfaces', i, 'key']);
      unique((manifest.mcp?.tools ?? []).map((t) => t.name), (i) => ['mcp', 'tools', i, 'name']);
   });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const pluginPackageSchema = z
   .object({
      manifest: pluginManifestSchema,
      files: z
         .array(
            z
               .object({
                  path: z
                     .string()
                     .max(200)
                     .regex(FILE_PATH)
                     .refine((p) => !p.split('/').some((s) => s === '..' || s === '.'), 'Invalid path.'),
                  content: z.string().max(262_144),
               })
               .strict()
         )
         .max(50)
         .default([]),
   })
   .strict()
   .superRefine((pkg, ctx) => {
      const total = pkg.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
      if (total > 1_000_000) ctx.addIssue({ code: 'custom', message: 'Files exceed 1 MB in total.', path: ['files'] });
      const seen = new Set<string>();
      pkg.files.forEach((file, index) => {
         if (seen.has(file.path)) ctx.addIssue({ code: 'custom', message: 'Must be unique.', path: ['files', index, 'path'] });
         seen.add(file.path);
      });
   });

export type PluginPackage = z.infer<typeof pluginPackageSchema>;
export type PluginConfigValue = string | number | boolean;
export type PluginConfig = Record<string, PluginConfigValue>;

export function parsePackage(value: unknown): PluginPackage {
   const parsed = pluginPackageSchema.safeParse(value);
   if (!parsed.success) throw new InvalidPluginInput(zodFields(parsed.error));
   return parsed.data;
}

/** Config must name only declared keys, with the declared type; required keys must be present. */
export function validateConfig(manifest: PluginManifest, value: unknown): PluginConfig {
   if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidPluginInput([{ path: '/config', message: 'Config must be an object.' }]);
   }
   const input = value as Record<string, unknown>;
   const fields: PluginFieldError[] = [];
   const config: PluginConfig = {};
   const declared = new Map(manifest.config.map((field) => [field.key, field]));
   for (const key of Object.keys(input)) {
      if (!declared.has(key)) fields.push({ path: `/config/${key}`, message: 'The plugin does not declare this setting.' });
   }
   for (const field of manifest.config) {
      const entry = input[field.key];
      if (entry === undefined || entry === null || entry === '') {
         if (field.required) fields.push({ path: `/config/${field.key}`, message: `${field.label} is required.` });
         continue;
      }
      const typeOk =
         (field.type === 'string' && typeof entry === 'string' && entry.length <= 2000) ||
         (field.type === 'number' && typeof entry === 'number' && Number.isFinite(entry)) ||
         (field.type === 'boolean' && typeof entry === 'boolean');
      if (!typeOk) {
         fields.push({ path: `/config/${field.key}`, message: `${field.label} must be a ${field.type}.` });
         continue;
      }
      config[field.key] = entry as PluginConfigValue;
   }
   if (fields.length > 0) throw new InvalidPluginInput(fields);
   return config;
}

export interface PluginPreview {
   key: string;
   name: string;
   version: string;
   description: string;
   baseUrl: string;
   scopes: string[];
   config: PluginManifest['config'];
   secrets: PluginManifest['secrets'];
   events: string[];
   schedules: { key: string; everyMinutes: number }[];
   surfaces: { key: string; title: string }[];
   mcpTools: string[];
   files: { path: string; size: number }[];
}

export function describePackage(pkg: PluginPackage): PluginPreview {
   const { manifest } = pkg;
   const events = new Set<string>();
   const schedules: { key: string; everyMinutes: number }[] = [];
   for (const hook of manifest.hooks) {
      if (hook.trigger === 'event') for (const event of hook.events) events.add(event);
      else schedules.push({ key: hook.key, everyMinutes: hook.everyMinutes });
   }
   return {
      key: manifest.key,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      baseUrl: manifest.baseUrl,
      scopes: [...manifest.scopes],
      config: manifest.config,
      secrets: manifest.secrets,
      events: [...events].sort(),
      schedules,
      surfaces: manifest.surfaces.map((s) => ({ key: s.key, title: s.title })),
      mcpTools: (manifest.mcp?.tools ?? []).map((t) => t.name),
      files: pkg.files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content, 'utf8') })),
   };
}
```

- [ ] **Step 5: Implement `net.ts`**

```ts
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PluginUnreachable } from './errors.ts';

/**
 * Every outbound request to a plugin goes through here. A plugin's base URL
 * is admin-supplied, so without this Berry would fetch any address it is
 * told to — cloud metadata endpoints and the database included.
 *
 * Checked on the resolved addresses, with redirects refused. A DNS answer
 * that changes between check and connect is a residual risk; it is narrowed,
 * not closed, by the short timeout.
 */

export interface PluginRequest {
   method: 'GET' | 'POST';
   headers?: Record<string, string>;
   body?: string;
   timeoutMs: number;
   maxBytes: number;
}

export interface PluginNetwork {
   request(url: string, init: PluginRequest): Promise<{ status: number; body: string }>;
}

export interface NetworkOptions {
   /** Development and tests only: allows http and private addresses. */
   allowPrivate: boolean;
   resolve?: (host: string) => Promise<string[]>;
   fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
}

/**
 * The IPv4 address an IPv6 address carries, when it is one of the forms that
 * route to IPv4: mapped (::ffff:0:0/96), compatible (::/96), NAT64
 * (64:ff9b::/96) or 6to4 (2002::/16). Handles both the dotted and the hex
 * spelling, because WHATWG URL parsing rewrites `[::ffff:10.0.0.1]` to
 * `[::ffff:a00:1]`.
 */
function embeddedIPv4(address: string): string | null {
   const groups = expandIPv6(address);
   if (!groups) return null;
   const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
   const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
   const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
   if (zeroPrefix && (g5 === 0xffff || g5 === 0) && !(g5 === 0 && g6 === 0)) return quad(g6, g7);
   if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return quad(g6, g7);
   if (g0 === 0x2002) return quad(g1, g2);
   return null;
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function expandIPv6(address: string): number[] | null {
   if (isIP(address) !== 6) return null;
   let text = address.toLowerCase();
   const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
   if (dotted) {
      const [a = 0, b = 0, c = 0, d = 0] = (dotted[1] ?? '').split('.').map(Number);
      text = text.slice(0, -(dotted[1] ?? '').length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
   }
   const [head = '', tail] = text.split('::');
   const left = head === '' ? [] : head.split(':');
   const right = tail === undefined || tail === '' ? [] : tail.split(':');
   const missing = 8 - left.length - right.length;
   const all = tail === undefined ? left : [...left, ...Array.from({ length: missing }, () => '0'), ...right];
   return all.length === 8 ? all.map((group) => Number.parseInt(group, 16)) : null;
}

export function isPrivateAddress(address: string): boolean {
   const embedded = embeddedIPv4(address);
   if (embedded) return isPrivateAddress(embedded);
   if (isIP(address) === 4) {
      const [a = 0, b = 0] = address.split('.').map(Number);
      return (
         a === 0 ||
         a === 10 ||
         a === 127 ||
         a >= 224 ||
         (a === 100 && b >= 64 && b <= 127) ||
         (a === 169 && b === 254) ||
         (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) ||
         (a === 198 && (b === 18 || b === 19))
      );
   }
   if (isIP(address) === 6) {
      const [first = 0] = expandIPv6(address) ?? [0];
      const lower = address.toLowerCase();
      return (
         lower === '::1' ||
         lower === '::' ||
         (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
         (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
         (first & 0xff00) === 0xff00 // multicast ff00::/8
      );
   }
   // Not an address at all: refuse rather than guess.
   return true;
}

const defaultResolve = async (host: string): Promise<string[]> =>
   (await lookup(host, { all: true })).map((entry) => entry.address);

export function createPluginNetwork(options: NetworkOptions): PluginNetwork {
   const resolve = options.resolve ?? defaultResolve;
   const fetchImpl = options.fetchImpl ?? ((url: URL, init: RequestInit) => fetch(url, init));

   return {
      async request(url, init) {
         let parsed: URL;
         try {
            parsed = new URL(url);
         } catch {
            throw new PluginUnreachable('plugin URL is not valid');
         }
         if (!options.allowPrivate) {
            if (parsed.protocol !== 'https:') throw new PluginUnreachable('plugin endpoints must use https');
            const host = parsed.hostname.replace(/^\[|\]$/g, '');
            let addresses: string[];
            try {
               addresses = isIP(host) ? [host] : await resolve(host);
            } catch (cause) {
               throw new PluginUnreachable('plugin host could not be resolved', { cause });
            }
            if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
               throw new PluginUnreachable('plugin endpoint resolves to a private address');
            }
         } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new PluginUnreachable('plugin endpoints must use http(s)');
         }

         const controller = new AbortController();
         const timer = setTimeout(() => controller.abort(), init.timeoutMs);
         try {
            const response = await fetchImpl(parsed, {
               method: init.method,
               redirect: 'manual',
               signal: controller.signal,
               ...(init.headers ? { headers: init.headers } : {}),
               ...(init.body !== undefined ? { body: init.body } : {}),
            });
            if (response.status >= 300 && response.status < 400) {
               throw new PluginUnreachable('plugin endpoint redirected');
            }
            return { status: response.status, body: await readLimited(response, init.maxBytes) };
         } catch (error) {
            if (error instanceof PluginUnreachable) throw error;
            const timedOut = error instanceof Error && error.name === 'AbortError';
            throw new PluginUnreachable(
               timedOut ? 'plugin endpoint timed out' : 'plugin endpoint could not be reached',
               { cause: error }
            );
         } finally {
            clearTimeout(timer);
         }
      },
   };
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
   if (!response.body) return '';
   const reader = response.body.getReader();
   const chunks: Uint8Array[] = [];
   let total = 0;
   for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
         await reader.cancel();
         throw new PluginUnreachable('plugin response is too large');
      }
      chunks.push(value);
   }
   return Buffer.concat(chunks).toString('utf8');
}
```

- [ ] **Step 6: Implement `loader.ts`**

```ts
import { InvalidPluginInput, PluginUnreachable } from './errors.ts';
import { parsePackage, type PluginPackage } from './manifest.ts';
import type { PluginNetwork } from './net.ts';

export type PackageSource = { url: string } | { package: unknown };

export interface LoadedPackage {
   pkg: PluginPackage;
   source: 'url' | 'upload';
   sourceUrl: string | null;
}

/** Reads a package from where the admin pointed, and validates it. Writes nothing. */
export async function loadPackage(net: PluginNetwork, source: PackageSource): Promise<LoadedPackage> {
   if ('package' in source) {
      return { pkg: parsePackage(source.package), source: 'upload', sourceUrl: null };
   }
   const response = await net.request(source.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 10_000,
      maxBytes: 1_500_000,
   });
   if (response.status !== 200) {
      throw new PluginUnreachable(`plugin package answered ${response.status}`);
   }
   let json: unknown;
   try {
      json = JSON.parse(response.body);
   } catch {
      throw new InvalidPluginInput([{ path: '/url', message: 'The URL did not return a plugin package.' }]);
   }
   return { pkg: parsePackage(json), source: 'url', sourceUrl: source.url };
}
```

- [ ] **Step 7: Add the config flag**

In `server-ts/src/config/config.ts`, add this field to the `Config` interface directly below `integrationKey: string | null;` (around line 34):

```ts
   /**
    * Lets plugin calls reach http and private addresses. Development only: in
    * production a plugin must be a public https endpoint.
    */
   pluginsAllowPrivateNetwork: boolean;
```

In the object `loadConfig` returns, directly below `integrationKey: (env.INTEGRATION_ENCRYPTION_KEY ?? '').trim() || null,` (around line 279), add:

```ts
      pluginsAllowPrivateNetwork: (env.BERRY_PLUGINS_ALLOW_PRIVATE_NETWORK ?? '').trim() === '1',
```

Then run `grep -rn "integrationKey:" server-ts/src` and add `pluginsAllowPrivateNetwork: false,` to any literal `Config` fixture it finds outside `config.ts`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/manifest.test.ts src/plugins/net.test.ts src/plugins/loader.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server-ts/src/plugins/errors.ts server-ts/src/plugins/manifest.ts server-ts/src/plugins/net.ts server-ts/src/plugins/loader.ts server-ts/src/plugins/fixture.test-support.ts server-ts/src/plugins/*.test.ts server-ts/src/config/config.ts
git commit -m "feat(server-ts): parse plugin packages and guard plugin network calls"
```

---
### Task 4: `PluginRepository`: installations, config, secrets, approvals, realtime events

**Files:**
- Create: `server-ts/src/plugins/events.ts`, `server-ts/src/plugins/repository.ts`
- Modify: `server-ts/src/plugins/fixture.test-support.ts` (add the DB fixture), `server-ts/src/realtime/replay.ts:35-43` (topics)
- Test: `server-ts/src/plugins/repository.test.ts`

**Interfaces:**
- Consumes: T1 tables; T2 `generateSigningSecret`, `isApiScope`, `ApiScope`; T3 `PluginPackage`, `PluginManifest`, `PluginConfig`, `validateConfig`, `pluginManifestSchema`, `InvalidPluginInput`, `PluginAlreadyInstalled`; `Sealer` (`src/integrations/sealing.ts`), `NotFound` (`src/identity/errors.ts`), `Queryable`/`Sql`/`toRFC3339` (`src/db/pool.ts`).
- Produces:
  - `interface PluginInstallation { id; workspaceId; key; name; version; description; manifest: PluginManifest; source: 'url' | 'upload'; sourceUrl: string | null; enabled: boolean; config: PluginConfig; grantedScopes: ApiScope[]; secretNames: string[]; approvedTools: string[]; installedBy: string; createdAt: string; updatedAt: string }`
  - `class PluginRepository`, constructed with `{ sql: Sql; sealer: Sealer; clock?: () => Date; random?: (n: number) => Buffer }`. Methods:
    - `install(tx: Queryable, input: { workspaceId: string; installedBy: string; pkg: PluginPackage; source: 'url' | 'upload'; sourceUrl: string | null; config: unknown }): Promise<{ installation: PluginInstallation; signingSecret: string }>`
    - `list(workspaceId: string): Promise<PluginInstallation[]>`
    - `get(workspaceId: string, id: string): Promise<PluginInstallation>` (throws `NotFound`)
    - `listEnabled(workspaceId: string): Promise<PluginInstallation[]>`
    - `update(tx: Queryable, workspaceId: string, id: string, patch: { enabled?: boolean | undefined; config?: unknown }): Promise<PluginInstallation>`
    - `uninstall(tx: Queryable, workspaceId: string, id: string): Promise<void>`
    - `setSecret(tx: Queryable, workspaceId: string, id: string, name: string, value: string): Promise<void>`
    - `deleteSecret(tx: Queryable, workspaceId: string, id: string, name: string): Promise<void>`
    - `openSecrets(workspaceId: string, id: string): Promise<Record<string, string>>`
    - `signingSecret(workspaceId: string, id: string): Promise<string>`
    - `setToolApproval(tx: Queryable, workspaceId: string, id: string, tool: string, approved: boolean, userId: string): Promise<void>`
    - `files(workspaceId: string, id: string): Promise<{ path: string; size: number }[]>`
  - `appendPluginEvent(tx, type: PluginEventType, workspaceId, installationId, pluginKey, occurredAt: string): Promise<void>`
  - `type PluginEventType = 'plugin.installed' | 'plugin.updated' | 'plugin.uninstalled'`
  - Fixture:
    - `HELLO`
    - `testSealer(): Sealer`
    - `seedWorld(sql: Sql, label: string): Promise<World>`
    - `dropWorld(sql: Sql, world: World): Promise<void>`
    - `interface World { userId: string; workspaceId: string; boardId: string; issueId: string; identifier: string }`
    - `testSessions(sql: Sql): SessionService`, which is J's `SessionService` accepting PAT bearers only (no cookie auth)

- [ ] **Step 1: Complete the test fixture**

Replace `server-ts/src/plugins/fixture.test-support.ts` with the content below. Keep `HELLO` exactly as in T3; it is repeated here in full.

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { sealerFromKey, type Sealer } from '../integrations/sealing.ts';

/** Shared by the plugin and public API tests. Not a test file itself. */

/** Sessions as J builds them in index.ts, minus cookies: tests authenticate with PATs. */
export function testSessions(sql: Sql): SessionService {
   return new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
}

export const HELLO = {
   manifest: {
      schemaVersion: 1,
      key: 'hello',
      name: 'Hello',
      version: '1.0.0',
      baseUrl: 'https://hello.example.com',
      scopes: ['issues:read', 'comments:write'],
      config: [{ key: 'greeting', label: 'Greeting', type: 'string', required: true }],
      secrets: [{ name: 'API_KEY' }],
      hooks: [
         { key: 'on-comment', trigger: 'event', events: ['comment.created'], path: '/hooks/comment' },
         { key: 'nightly', trigger: 'schedule', everyMinutes: 1440, path: '/hooks/nightly' },
      ],
      surfaces: [{ key: 'panel', title: 'Hello panel', path: '/ui' }],
      mcp: { path: '/mcp', tools: [{ name: 'say_hello' }] },
   },
   files: [{ path: 'README.md', content: '# Hello' }],
};

export interface World {
   userId: string;
   workspaceId: string;
   boardId: string;
   issueId: string;
   identifier: string;
}

export function testSealer(): Sealer {
   return sealerFromKey(randomBytes(32).toString('base64'));
}

/** A random, letters-only issue prefix, so identifier lookups never collide across runs. */
function randomPrefix(): string {
   return 'G' + Array.from(randomBytes(4), (byte) => String.fromCharCode(65 + (byte % 26))).join('');
}

export async function seedWorld(sql: Sql, label: string): Promise<World> {
   const suffix = randomUUID().slice(0, 8);
   const prefix = randomPrefix();
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${label}-${suffix}@berry.test`}, ${label})
      RETURNING id`;
   const userId = user?.id as string;
   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label}-${suffix}`},
              ${sql.json({ issuePrefix: prefix, defaultRole: 'member', allowMemberInvites: false } as never)},
              ${userId})
      RETURNING id`;
   const workspaceId = workspace?.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, ${label}, ${`b-${suffix}`}, ${userId})
      RETURNING id`;
   const boardId = board?.id as string;
   const [counter] = await sql`
      UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${boardId}
      RETURNING issue_counter`;
   const number = Number(counter?.issue_counter);
   const issueId = randomUUID();
   await sql`
      INSERT INTO issues (id, board_id, number, title, created_by)
      VALUES (${issueId}, ${boardId}, ${number}, ${`${label} task`}, ${userId})`;
   return { userId, workspaceId, boardId, issueId, identifier: `${prefix}-${number}` };
}

export async function dropWorld(sql: Sql, world: World): Promise<void> {
   if (!world.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM plugin_installations WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${world.boardId}`;
   await sql`ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`;
   try {
      await sql`DELETE FROM agents WHERE workspace_id = ${world.workspaceId}`;
   } finally {
      await sql`ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`;
   }
   await sql`DELETE FROM boards WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${world.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${world.userId}`;
}
```

- [ ] **Step 2: Write the failing test**

`server-ts/src/plugins/repository.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { InvalidPluginInput, PluginAlreadyInstalled } from './errors.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from './fixture.test-support.ts';
import { parsePackage } from './manifest.ts';
import { PluginRepository } from './repository.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('PluginRepository', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let repo: PluginRepository;
   let world: World;
   let other: World;

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new PluginRepository({ sql, sealer: testSealer() });
      world = await seedWorld(sql, 'plug-a');
      other = await seedWorld(sql, 'plug-b');
   });
   after(async () => {
      await dropWorld(sql, world);
      await dropWorld(sql, other);
      await closeDatabase(sql);
   });

   const install = (workspace: World) =>
      sql.begin((tx) =>
         repo.install(tx, {
            workspaceId: workspace.workspaceId,
            installedBy: workspace.userId,
            pkg: parsePackage(HELLO),
            source: 'upload',
            sourceUrl: null,
            config: { greeting: 'hi' },
         })
      );

   test('an install stores the manifest, grants its scopes and returns the signing secret once', async () => {
      const { installation, signingSecret } = await install(world);
      assert.match(signingSecret, /^berry_whsec_/);
      assert.equal(installation.key, 'hello');
      assert.equal(installation.enabled, true);
      assert.deepEqual(installation.config, { greeting: 'hi' });
      assert.deepEqual(installation.grantedScopes, ['issues:read', 'comments:write']);
      assert.equal(await repo.signingSecret(world.workspaceId, installation.id), signingSecret);

      const [stored] = await sql`
         SELECT signing_secret_encrypted FROM plugin_installations WHERE id = ${installation.id}`;
      assert.ok(!Buffer.from(stored?.signing_secret_encrypted as Buffer).toString('utf8').includes(signingSecret));

      const events = await sql`
         SELECT topic FROM outbox_events WHERE aggregate_id = ${installation.id}`;
      assert.deepEqual(events.map((e) => e.topic), ['plugin.installed']);

      const hooks = await sql`SELECT hook_key FROM plugin_hook_state WHERE installation_id = ${installation.id}`;
      assert.deepEqual(hooks.map((h) => h.hook_key), ['nightly']);
      assert.deepEqual(await repo.files(world.workspaceId, installation.id), [{ path: 'README.md', size: 7 }]);
   });

   test('installing the same key twice in one workspace is a conflict', async () => {
      await assert.rejects(install(world), PluginAlreadyInstalled);
   });

   test('another workspace cannot read, change or remove the installation', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await assert.rejects(repo.get(other.workspaceId, found.id), NotFound);
      await assert.rejects(sql.begin((tx) => repo.update(tx, other.workspaceId, found.id, { enabled: false })), NotFound);
      await assert.rejects(sql.begin((tx) => repo.uninstall(tx, other.workspaceId, found.id)), NotFound);
      assert.deepEqual(await repo.list(other.workspaceId), []);
   });

   test('config updates are validated and enable toggles', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await assert.rejects(
         sql.begin((tx) => repo.update(tx, world.workspaceId, found.id, { config: { greeting: 3 } })),
         InvalidPluginInput
      );
      const updated = await sql.begin((tx) =>
         repo.update(tx, world.workspaceId, found.id, { enabled: false, config: { greeting: 'hey' } })
      );
      assert.equal(updated.enabled, false);
      assert.deepEqual(updated.config, { greeting: 'hey' });
      assert.deepEqual(await repo.listEnabled(world.workspaceId), []);
   });

   test('only declared secrets are stored, sealed, and opened for the caller', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await assert.rejects(
         sql.begin((tx) => repo.setSecret(tx, world.workspaceId, found.id, 'OTHER', 'x')),
         InvalidPluginInput
      );
      await sql.begin((tx) => repo.setSecret(tx, world.workspaceId, found.id, 'API_KEY', 'sk-123'));
      const [row] = await sql`SELECT value_encrypted FROM plugin_secrets WHERE installation_id = ${found.id}`;
      assert.ok(!Buffer.from(row?.value_encrypted as Buffer).toString('utf8').includes('sk-123'));
      assert.deepEqual(await repo.openSecrets(world.workspaceId, found.id), { API_KEY: 'sk-123' });
      assert.deepEqual((await repo.get(world.workspaceId, found.id)).secretNames, ['API_KEY']);
      await sql.begin((tx) => repo.deleteSecret(tx, world.workspaceId, found.id, 'API_KEY'));
      assert.deepEqual(await repo.openSecrets(world.workspaceId, found.id), {});
   });

   test('only declared MCP tools can be approved', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await assert.rejects(
         sql.begin((tx) => repo.setToolApproval(tx, world.workspaceId, found.id, 'rm_rf', true, world.userId)),
         InvalidPluginInput
      );
      await sql.begin((tx) => repo.setToolApproval(tx, world.workspaceId, found.id, 'say_hello', true, world.userId));
      assert.deepEqual((await repo.get(world.workspaceId, found.id)).approvedTools, ['say_hello']);
      await sql.begin((tx) => repo.setToolApproval(tx, world.workspaceId, found.id, 'say_hello', false, world.userId));
      assert.deepEqual((await repo.get(world.workspaceId, found.id)).approvedTools, []);
   });

   test('uninstall removes the installation and everything under it', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await sql.begin((tx) => repo.uninstall(tx, world.workspaceId, found.id));
      assert.deepEqual(await repo.list(world.workspaceId), []);
      const files = await sql`SELECT 1 FROM plugin_files WHERE installation_id = ${found.id}`;
      assert.equal(files.length, 0);
   });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/repository.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./repository.ts`.

- [ ] **Step 4: Implement `events.ts` and register the topics**

`server-ts/src/plugins/events.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable } from '../db/pool.ts';

export type PluginEventType = 'plugin.installed' | 'plugin.updated' | 'plugin.uninstalled';

/**
 * A workspace fact about a plugin, written in the caller's transaction so it
 * is published exactly when the change commits. No board: plugins belong to
 * the workspace, so these ride the workspace stream only.
 */
export async function appendPluginEvent(
   tx: Queryable,
   type: PluginEventType,
   workspaceId: string,
   installationId: string,
   pluginKey: string,
   occurredAt: string
): Promise<void> {
   const id = randomUUID();
   const envelope = {
      id,
      type,
      occurredAt: toRFC3339(occurredAt),
      workspaceId,
      aggregateType: 'plugin',
      aggregateId: installationId,
      payload: { plugin: { id: installationId, key: pluginKey } },
   };
   await tx`
      INSERT INTO outbox_events (
         id, topic, aggregate_type, aggregate_id, workspace_id, payload, occurred_at, available_at
      ) VALUES (
         ${id}, ${type}, 'plugin', ${installationId}, ${workspaceId},
         ${tx.json(envelope as never)}, ${occurredAt}, ${occurredAt}
      )`;
}
```

In `server-ts/src/realtime/replay.ts`, add a line to `WORKSPACE_TOPICS` directly after `'artifact.created',`:

```ts
   'plugin.installed', 'plugin.updated', 'plugin.uninstalled',
```

- [ ] **Step 5: Implement `repository.ts`**

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Sealer } from '../integrations/sealing.ts';
import { isApiScope, type ApiScope } from '../public-api/scopes.ts';
import { InvalidPluginInput, PluginAlreadyInstalled } from './errors.ts';
import { appendPluginEvent } from './events.ts';
import {
   pluginManifestSchema,
   validateConfig,
   type PluginConfig,
   type PluginManifest,
   type PluginPackage,
} from './manifest.ts';
import { generateSigningSecret } from './tokens.ts';

/**
 * Installed plugins, one workspace at a time.
 *
 * Every method takes the workspace id and filters on it, and every write takes
 * the caller's transaction — the mount obtains that from `ScopedDb.mutate`, so
 * a write cannot happen without the membership and permission check.
 */

export interface PluginInstallation {
   id: string;
   workspaceId: string;
   key: string;
   name: string;
   version: string;
   description: string;
   manifest: PluginManifest;
   source: 'url' | 'upload';
   sourceUrl: string | null;
   enabled: boolean;
   config: PluginConfig;
   grantedScopes: ApiScope[];
   secretNames: string[];
   approvedTools: string[];
   installedBy: string;
   createdAt: string;
   updatedAt: string;
}

const COLUMNS = `i.id, i.workspace_id, i.plugin_key, i.name, i.version, i.manifest, i.source,
   i.source_url, i.enabled, i.config, i.granted_scopes, i.installed_by, i.created_at, i.updated_at,
   COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM plugin_secrets s
              WHERE s.installation_id = i.id), '{}') AS secret_names,
   COALESCE((SELECT array_agg(a.tool_name ORDER BY a.tool_name) FROM plugin_tool_approvals a
              WHERE a.installation_id = i.id), '{}') AS approved_tools`;

export interface PluginRepositoryOptions {
   sql: Sql;
   sealer: Sealer;
   clock?: () => Date;
   random?: (size: number) => Buffer;
}

export class PluginRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;
   readonly #clock: () => Date;
   readonly #random: (size: number) => Buffer;

   constructor(options: PluginRepositoryOptions) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
      this.#clock = options.clock ?? (() => new Date());
      this.#random = options.random ?? randomBytes;
   }

   async install(
      tx: Queryable,
      input: {
         workspaceId: string;
         installedBy: string;
         pkg: PluginPackage;
         source: 'url' | 'upload';
         sourceUrl: string | null;
         config: unknown;
      }
   ): Promise<{ installation: PluginInstallation; signingSecret: string }> {
      const manifest = input.pkg.manifest;
      const config = validateConfig(manifest, input.config ?? {});
      const id = randomUUID();
      const now = this.#clock().toISOString();
      const signingSecret = generateSigningSecret(this.#random);

      await tx`
         INSERT INTO plugin_installations (
            id, workspace_id, plugin_key, name, version, manifest, source, source_url, base_url,
            enabled, config, granted_scopes, signing_secret_encrypted, installed_by, created_at, updated_at
         ) VALUES (
            ${id}, ${input.workspaceId}, ${manifest.key}, ${manifest.name}, ${manifest.version},
            ${tx.json(manifest as never)}, ${input.source}, ${input.sourceUrl}, ${manifest.baseUrl},
            true, ${tx.json(config as never)}, ${tx.array([...manifest.scopes])},
            ${this.#sealer.seal(signingSecret)}, ${input.installedBy}, ${now}, ${now}
         )`.catch((error: unknown) => {
         if ((error as { code?: string }).code === '23505') throw new PluginAlreadyInstalled();
         throw error;
      });

      for (const file of input.pkg.files) {
         await tx`
            INSERT INTO plugin_files (installation_id, workspace_id, path, content)
            VALUES (${id}, ${input.workspaceId}, ${file.path}, ${file.content})`;
      }
      for (const hook of manifest.hooks) {
         if (hook.trigger !== 'schedule') continue;
         const next = new Date(Date.parse(now) + hook.everyMinutes * 60_000).toISOString();
         await tx`
            INSERT INTO plugin_hook_state (installation_id, workspace_id, hook_key, interval_minutes, next_fire_at)
            VALUES (${id}, ${input.workspaceId}, ${hook.key}, ${hook.everyMinutes}, ${next})`;
      }
      await appendPluginEvent(tx, 'plugin.installed', input.workspaceId, id, manifest.key, now);
      return { installation: await readOne(tx, input.workspaceId, id), signingSecret };
   }

   async list(workspaceId: string): Promise<PluginInstallation[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM plugin_installations AS i
          WHERE i.workspace_id = ${workspaceId}
          ORDER BY i.name, i.id`;
      return rows.map(toInstallation);
   }

   async listEnabled(workspaceId: string): Promise<PluginInstallation[]> {
      return (await this.list(workspaceId)).filter((installation) => installation.enabled);
   }

   async get(workspaceId: string, id: string): Promise<PluginInstallation> {
      return readOne(this.#sql, workspaceId, id);
   }

   async update(
      tx: Queryable,
      workspaceId: string,
      id: string,
      patch: { enabled?: boolean | undefined; config?: unknown }
   ): Promise<PluginInstallation> {
      const [locked] = await tx`
         SELECT manifest, enabled, config FROM plugin_installations
          WHERE id = ${id} AND workspace_id = ${workspaceId}
          FOR UPDATE`;
      if (!locked) throw new NotFound();
      const manifest = pluginManifestSchema.parse(locked.manifest);
      const config = patch.config === undefined ? (locked.config as PluginConfig) : validateConfig(manifest, patch.config);
      const enabled = patch.enabled ?? (locked.enabled as boolean);
      const now = this.#clock().toISOString();
      await tx`
         UPDATE plugin_installations
            SET enabled = ${enabled}, config = ${tx.json(config as never)}, updated_at = ${now}
          WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      await appendPluginEvent(tx, 'plugin.updated', workspaceId, id, manifest.key, now);
      return readOne(tx, workspaceId, id);
   }

   async uninstall(tx: Queryable, workspaceId: string, id: string): Promise<void> {
      const [removed] = await tx`
         DELETE FROM plugin_installations WHERE id = ${id} AND workspace_id = ${workspaceId}
         RETURNING plugin_key`;
      if (!removed) throw new NotFound();
      await appendPluginEvent(
         tx,
         'plugin.uninstalled',
         workspaceId,
         id,
         removed.plugin_key as string,
         this.#clock().toISOString()
      );
   }

   async setSecret(tx: Queryable, workspaceId: string, id: string, name: string, value: string): Promise<void> {
      const manifest = await lockedManifest(tx, workspaceId, id);
      if (!manifest.secrets.some((secret) => secret.name === name)) {
         throw new InvalidPluginInput([{ path: '/name', message: 'The plugin does not declare this secret.' }]);
      }
      if (value.length < 1 || value.length > 4096) {
         throw new InvalidPluginInput([{ path: '/value', message: 'Secret must contain 1 to 4096 characters.' }]);
      }
      const now = this.#clock().toISOString();
      await tx`
         INSERT INTO plugin_secrets (installation_id, workspace_id, name, value_encrypted, updated_at)
         VALUES (${id}, ${workspaceId}, ${name}, ${this.#sealer.seal(value)}, ${now})
         ON CONFLICT (installation_id, name)
         DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = EXCLUDED.updated_at`;
   }

   async deleteSecret(tx: Queryable, workspaceId: string, id: string, name: string): Promise<void> {
      await lockedManifest(tx, workspaceId, id);
      await tx`
         DELETE FROM plugin_secrets
          WHERE installation_id = ${id} AND workspace_id = ${workspaceId} AND name = ${name}`;
   }

   /** Decrypted secrets, for the hook call body only. Never serialized to a client. */
   async openSecrets(workspaceId: string, id: string): Promise<Record<string, string>> {
      const rows = await this.#sql`
         SELECT name, value_encrypted FROM plugin_secrets
          WHERE installation_id = ${id} AND workspace_id = ${workspaceId}`;
      const secrets: Record<string, string> = {};
      for (const row of rows) {
         secrets[row.name as string] = this.#sealer.open(Buffer.from(row.value_encrypted as Buffer));
      }
      return secrets;
   }

   async signingSecret(workspaceId: string, id: string): Promise<string> {
      const [row] = await this.#sql`
         SELECT signing_secret_encrypted FROM plugin_installations
          WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return this.#sealer.open(Buffer.from(row.signing_secret_encrypted as Buffer));
   }

   async setToolApproval(
      tx: Queryable,
      workspaceId: string,
      id: string,
      tool: string,
      approved: boolean,
      userId: string
   ): Promise<void> {
      const manifest = await lockedManifest(tx, workspaceId, id);
      if (!(manifest.mcp?.tools ?? []).some((declared) => declared.name === tool)) {
         throw new InvalidPluginInput([{ path: '/tool', message: 'The plugin does not declare this tool.' }]);
      }
      if (approved) {
         await tx`
            INSERT INTO plugin_tool_approvals (installation_id, workspace_id, tool_name, approved_by, approved_at)
            VALUES (${id}, ${workspaceId}, ${tool}, ${userId}, ${this.#clock().toISOString()})
            ON CONFLICT (installation_id, tool_name) DO NOTHING`;
      } else {
         await tx`
            DELETE FROM plugin_tool_approvals
             WHERE installation_id = ${id} AND workspace_id = ${workspaceId} AND tool_name = ${tool}`;
      }
   }

   async files(workspaceId: string, id: string): Promise<{ path: string; size: number }[]> {
      await this.get(workspaceId, id);
      const rows = await this.#sql`
         SELECT path, octet_length(content) AS size FROM plugin_files
          WHERE installation_id = ${id} AND workspace_id = ${workspaceId}
          ORDER BY path`;
      return rows.map((row) => ({ path: row.path as string, size: Number(row.size) }));
   }
}

async function readOne(sql: Queryable, workspaceId: string, id: string): Promise<PluginInstallation> {
   const [row] = await sql`
      SELECT ${sql.unsafe(COLUMNS)} FROM plugin_installations AS i
       WHERE i.id = ${id} AND i.workspace_id = ${workspaceId}`;
   if (!row) throw new NotFound();
   return toInstallation(row);
}

async function lockedManifest(tx: Queryable, workspaceId: string, id: string): Promise<PluginManifest> {
   const [row] = await tx`
      SELECT manifest FROM plugin_installations
       WHERE id = ${id} AND workspace_id = ${workspaceId}
       FOR UPDATE`;
   if (!row) throw new NotFound();
   return pluginManifestSchema.parse(row.manifest);
}

function toInstallation(row: Record<string, unknown>): PluginInstallation {
   const manifest = pluginManifestSchema.parse(row.manifest);
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      key: row.plugin_key as string,
      name: row.name as string,
      version: row.version as string,
      description: manifest.description,
      manifest,
      source: row.source === 'url' ? 'url' : 'upload',
      sourceUrl: (row.source_url as string | null) ?? null,
      enabled: row.enabled as boolean,
      config: row.config as PluginConfig,
      grantedScopes: (row.granted_scopes as string[]).filter(isApiScope),
      secretNames: row.secret_names as string[],
      approvedTools: row.approved_tools as string[],
      installedBy: row.installed_by as string,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}
```

If `tx.unsafe`, `tx.json` or `tx.array` does not type-check on `Queryable`, open `src/db/pool.ts:21` and use the member that union exposes. Both `postgres.Sql` and `postgres.TransactionSql` have all three.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/repository.test.ts src/mounts/events.test.ts && pnpm typecheck`
Expected: PASS. The `events.test.ts` topic assertions still hold.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/plugins/events.ts server-ts/src/plugins/repository.ts server-ts/src/plugins/repository.test.ts server-ts/src/plugins/fixture.test-support.ts server-ts/src/realtime/replay.ts
git commit -m "feat(server-ts): store plugin installations with sealed secrets"
```

---
### Task 5: `PluginRuntimeStore`: plugin tokens, storage, invocations log

**Files:**
- Create: `server-ts/src/plugins/runtime-store.ts`
- Test: `server-ts/src/plugins/runtime-store.test.ts`

**Interfaces:**
- Consumes: T1 tables; T2 `generatePluginToken`, `parsePluginToken`, `isApiScope`, `ApiScope`; T3 `InvalidPluginInput`; T4 `PluginRepository` (tests only); `secretMatches` from `src/auth/tokens.ts`; `TimeCursor` from `src/http/cursor.ts`.
- Produces:
  - `interface PluginPrincipal { installationId: string; workspaceId: string; pluginKey: string; installedBy: string; scopes: ApiScope[] }`
  - `class PluginTokenInvalid extends Error`
  - `interface StoredValue { key: string; value: unknown; updatedAt: string }`
  - `interface PluginInvocation { id: string; kind: InvocationKind; trigger: string; status: 'ok' | 'error'; httpStatus: number | null; durationMs: number; error: string | null; createdAt: string }`
  - `type InvocationKind = 'event' | 'schedule' | 'surface' | 'mcp'`
  - `validStorageKey(key: string): boolean`
  - `class PluginRuntimeStore`, constructed with `{ sql: Sql; clock?: () => Date; random?: (n: number) => Buffer }`. Methods:
    - `mintToken(input: { workspaceId: string; installationId: string; scopes: readonly ApiScope[]; ttlMs: number }): Promise<{ token: string; expiresAt: string }>`
    - `resolveToken(token: string): Promise<PluginPrincipal>` (throws `PluginTokenInvalid`)
    - `getValue(installationId: string, key: string): Promise<StoredValue | null>`
    - `putValue(owner: { installationId: string; workspaceId: string }, key: string, value: unknown): Promise<StoredValue>`
    - `deleteValue(installationId: string, key: string): Promise<boolean>`
    - `listValues(installationId: string, options: { prefix: string; after: string | null; limit: number }): Promise<StoredValue[]>`
    - `recordInvocation(input: Omit<PluginInvocation, 'id' | 'createdAt'> & { workspaceId: string; installationId: string }): Promise<void>`
    - `listInvocations(workspaceId: string, installationId: string, cursor: TimeCursor | null, limit: number): Promise<PluginInvocation[]>`
    - `pruneTokens(): Promise<number>`

- [ ] **Step 1: Write the failing test**

`server-ts/src/plugins/runtime-store.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { InvalidPluginInput } from './errors.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from './fixture.test-support.ts';
import { parsePackage } from './manifest.ts';
import { PluginRepository, type PluginInstallation } from './repository.ts';
import { PluginRuntimeStore, PluginTokenInvalid, validStorageKey } from './runtime-store.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('PluginRuntimeStore', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let store: PluginRuntimeStore;
   let repo: PluginRepository;
   let world: World;
   let installation: PluginInstallation;

   before(async () => {
      sql = openDatabase({ url: url as string });
      store = new PluginRuntimeStore({ sql });
      repo = new PluginRepository({ sql, sealer: testSealer() });
      world = await seedWorld(sql, 'runtime');
      installation = (
         await sql.begin((tx) =>
            repo.install(tx, {
               workspaceId: world.workspaceId,
               installedBy: world.userId,
               pkg: parsePackage(HELLO),
               source: 'upload',
               sourceUrl: null,
               config: { greeting: 'hi' },
            })
         )
      ).installation;
   });
   after(async () => {
      await dropWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a minted token resolves to its installation, scopes limited to what was granted', async () => {
      const { token } = await store.mintToken({
         workspaceId: world.workspaceId,
         installationId: installation.id,
         scopes: ['issues:read', 'issues:write'],
         ttlMs: 60_000,
      });
      const principal = await store.resolveToken(token);
      assert.equal(principal.installationId, installation.id);
      assert.equal(principal.workspaceId, world.workspaceId);
      assert.equal(principal.installedBy, world.userId);
      // issues:write was never granted at install, so the token cannot carry it.
      assert.deepEqual(principal.scopes, ['issues:read']);
   });

   test('expired, tampered and disabled-plugin tokens are refused', async () => {
      const expired = await store.mintToken({
         workspaceId: world.workspaceId, installationId: installation.id, scopes: ['issues:read'], ttlMs: -1000,
      });
      await assert.rejects(store.resolveToken(expired.token), PluginTokenInvalid);

      const good = await store.mintToken({
         workspaceId: world.workspaceId, installationId: installation.id, scopes: ['issues:read'], ttlMs: 60_000,
      });
      const tampered = good.token.slice(0, -2) + (good.token.endsWith('AA') ? 'BB' : 'AA');
      await assert.rejects(store.resolveToken(tampered), PluginTokenInvalid);
      await assert.rejects(store.resolveToken('berry_plg_nope'), PluginTokenInvalid);

      await sql.begin((tx) => repo.update(tx, world.workspaceId, installation.id, { enabled: false }));
      await assert.rejects(store.resolveToken(good.token), PluginTokenInvalid);
      await sql.begin((tx) => repo.update(tx, world.workspaceId, installation.id, { enabled: true }));
      assert.ok(await store.pruneTokens() >= 1);
   });

   test('storage round-trips JSON values and lists by prefix in key order', async () => {
      const owner = { installationId: installation.id, workspaceId: world.workspaceId };
      await store.putValue(owner, 'sync/b', { n: 2 });
      await store.putValue(owner, 'sync/a', { n: 1 });
      await store.putValue(owner, 'other', true);
      assert.deepEqual((await store.getValue(installation.id, 'sync/a'))?.value, { n: 1 });
      const listed = await store.listValues(installation.id, { prefix: 'sync/', after: null, limit: 10 });
      assert.deepEqual(listed.map((v) => v.key), ['sync/a', 'sync/b']);
      const page = await store.listValues(installation.id, { prefix: 'sync/', after: 'sync/a', limit: 10 });
      assert.deepEqual(page.map((v) => v.key), ['sync/b']);
      assert.equal(await store.deleteValue(installation.id, 'sync/a'), true);
      assert.equal(await store.getValue(installation.id, 'sync/a'), null);
      assert.equal(await store.deleteValue(installation.id, 'sync/a'), false);
   });

   test('storage refuses bad keys and oversized values', async () => {
      const owner = { installationId: installation.id, workspaceId: world.workspaceId };
      assert.equal(validStorageKey('a b'), false);
      assert.equal(validStorageKey('a'.repeat(201)), false);
      await assert.rejects(store.putValue(owner, 'big', 'x'.repeat(70_000)), InvalidPluginInput);
   });

   test('invocations list newest first with a cursor', async () => {
      // A clock one second apart per call, so the (created_at, id) order never
      // falls back to comparing random uuids.
      const base = Date.now() + 60_000;
      let tick = 0;
      const timed = new PluginRuntimeStore({ sql, clock: () => new Date(base + tick++ * 1000) });
      for (const trigger of ['one', 'two', 'three']) {
         await timed.recordInvocation({
            workspaceId: world.workspaceId, installationId: installation.id, kind: 'event',
            trigger, status: 'ok', httpStatus: 200, durationMs: 5, error: null,
         });
      }
      const first = await store.listInvocations(world.workspaceId, installation.id, null, 2);
      assert.deepEqual(first.map((i) => i.trigger), ['three', 'two']);
      const last = first.at(-1);
      assert.ok(last);
      const next = await store.listInvocations(world.workspaceId, installation.id, { createdAt: last.createdAt, id: last.id }, 2);
      assert.deepEqual(next.map((i) => i.trigger), ['one']);
   });

   test('another installation cannot read or delete this one\'s storage', async () => {
      const owner = { installationId: installation.id, workspaceId: world.workspaceId };
      await store.putValue(owner, 'mine', 1);
      const stranger = '00000000-0000-4000-8000-000000000001';
      assert.equal(await store.getValue(stranger, 'mine'), null);
      assert.equal(await store.deleteValue(stranger, 'mine'), false);
      assert.equal((await store.getValue(installation.id, 'mine'))?.value, 1);
   });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/runtime-store.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `runtime-store.ts`**

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { secretMatches } from '../auth/tokens.ts';
import { toRFC3339, type Sql } from '../db/pool.ts';
import type { TimeCursor } from '../http/cursor.ts';
import { isApiScope, type ApiScope } from '../public-api/scopes.ts';
import { InvalidPluginInput } from './errors.ts';
import { generatePluginToken, parsePluginToken } from './tokens.ts';

/**
 * What a running plugin touches: the short-lived tokens it calls Berry with,
 * its key/value storage, and the log of every call Berry made to it.
 *
 * Tokens are stored as the digest of their secret half, like personal tokens.
 * Scopes are intersected with the installation's grant at resolve time, so an
 * admin narrowing a grant takes effect on tokens already handed out.
 */

export interface PluginPrincipal {
   installationId: string;
   workspaceId: string;
   pluginKey: string;
   installedBy: string;
   scopes: ApiScope[];
}

export class PluginTokenInvalid extends Error {
   override readonly name = 'PluginTokenInvalid';
}

export interface StoredValue {
   key: string;
   value: unknown;
   updatedAt: string;
}

export type InvocationKind = 'event' | 'schedule' | 'surface' | 'mcp';

export interface PluginInvocation {
   id: string;
   kind: InvocationKind;
   trigger: string;
   status: 'ok' | 'error';
   httpStatus: number | null;
   durationMs: number;
   error: string | null;
   createdAt: string;
}

const STORAGE_KEY = /^[A-Za-z0-9._:/-]{1,200}$/;
const MAX_VALUE_BYTES = 65_536;

export function validStorageKey(key: string): boolean {
   return STORAGE_KEY.test(key);
}

export class PluginRuntimeStore {
   readonly #sql: Sql;
   readonly #clock: () => Date;
   readonly #random: (size: number) => Buffer;

   constructor(options: { sql: Sql; clock?: () => Date; random?: (size: number) => Buffer }) {
      this.#sql = options.sql;
      this.#clock = options.clock ?? (() => new Date());
      this.#random = options.random ?? randomBytes;
   }

   async mintToken(input: {
      workspaceId: string;
      installationId: string;
      scopes: readonly ApiScope[];
      ttlMs: number;
   }): Promise<{ token: string; expiresAt: string }> {
      const generated = generatePluginToken(this.#random);
      const now = this.#clock();
      const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
      await this.#sql`
         INSERT INTO plugin_tokens (id, workspace_id, installation_id, public_id, secret_hash, scopes, expires_at, created_at)
         VALUES (${randomUUID()}, ${input.workspaceId}, ${input.installationId}, ${generated.publicId},
                 ${generated.secretHash}, ${this.#sql.array([...input.scopes])}, ${expiresAt}, ${now.toISOString()})`;
      return { token: generated.token, expiresAt };
   }

   async resolveToken(token: string): Promise<PluginPrincipal> {
      let parsed: { publicId: string; secret: string };
      try {
         parsed = parsePluginToken(token);
      } catch {
         throw new PluginTokenInvalid();
      }
      const [row] = await this.#sql`
         SELECT t.secret_hash, t.expires_at, t.scopes, i.id AS installation_id, i.workspace_id,
                i.plugin_key, i.installed_by, i.granted_scopes
           FROM plugin_tokens AS t
           JOIN plugin_installations AS i ON i.id = t.installation_id AND i.enabled
          WHERE t.public_id = ${parsed.publicId}`;
      if (!row) throw new PluginTokenInvalid();
      if (new Date(row.expires_at as string) <= this.#clock()) throw new PluginTokenInvalid();
      if (!secretMatches(parsed.secret, row.secret_hash as Buffer)) throw new PluginTokenInvalid();
      const granted = new Set((row.granted_scopes as string[]).filter(isApiScope));
      const scopes = (row.scopes as string[]).filter(isApiScope).filter((scope) => granted.has(scope)).sort();
      return {
         installationId: row.installation_id as string,
         workspaceId: row.workspace_id as string,
         pluginKey: row.plugin_key as string,
         installedBy: row.installed_by as string,
         scopes,
      };
   }

   async getValue(installationId: string, key: string): Promise<StoredValue | null> {
      const [row] = await this.#sql`
         SELECT key, value, updated_at FROM plugin_storage
          WHERE installation_id = ${installationId} AND key = ${key}`;
      return row ? toStored(row) : null;
   }

   async putValue(
      owner: { installationId: string; workspaceId: string },
      key: string,
      value: unknown
   ): Promise<StoredValue> {
      if (!validStorageKey(key)) {
         throw new InvalidPluginInput([{ path: '/key', message: 'Key must be 1 to 200 URL-safe characters.' }]);
      }
      const encoded = JSON.stringify(value);
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES) {
         throw new InvalidPluginInput([{ path: '/value', message: 'Value must be JSON of at most 64 KB.' }]);
      }
      const now = this.#clock().toISOString();
      const [row] = await this.#sql`
         INSERT INTO plugin_storage (installation_id, workspace_id, key, value, updated_at)
         VALUES (${owner.installationId}, ${owner.workspaceId}, ${key}, ${this.#sql.json(value as never)}, ${now})
         ON CONFLICT (installation_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
         RETURNING key, value, updated_at`;
      if (!row) throw new Error('storage upsert returned no row');
      return toStored(row);
   }

   async deleteValue(installationId: string, key: string): Promise<boolean> {
      const result = await this.#sql`
         DELETE FROM plugin_storage WHERE installation_id = ${installationId} AND key = ${key}`;
      return result.count > 0;
   }

   async listValues(
      installationId: string,
      options: { prefix: string; after: string | null; limit: number }
   ): Promise<StoredValue[]> {
      const rows = await this.#sql`
         SELECT key, value, updated_at FROM plugin_storage
          WHERE installation_id = ${installationId}
            AND starts_with(key, ${options.prefix})
            AND (${options.after}::text IS NULL OR key > ${options.after})
          ORDER BY key
          LIMIT ${options.limit}`;
      return rows.map(toStored);
   }

   async recordInvocation(input: {
      workspaceId: string;
      installationId: string;
      kind: InvocationKind;
      trigger: string;
      status: 'ok' | 'error';
      httpStatus: number | null;
      durationMs: number;
      error: string | null;
   }): Promise<void> {
      await this.#sql`
         INSERT INTO plugin_invocations (
            id, workspace_id, installation_id, kind, trigger, status, http_status, duration_ms, error, created_at
         ) VALUES (
            ${randomUUID()}, ${input.workspaceId}, ${input.installationId}, ${input.kind},
            ${input.trigger.slice(0, 200)}, ${input.status}, ${input.httpStatus},
            ${Math.max(0, Math.round(input.durationMs))}, ${input.error?.slice(0, 500) ?? null},
            ${this.#clock().toISOString()}
         )`;
   }

   async listInvocations(
      workspaceId: string,
      installationId: string,
      cursor: TimeCursor | null,
      limit: number
   ): Promise<PluginInvocation[]> {
      const rows = await this.#sql`
         SELECT id, kind, trigger, status, http_status, duration_ms, error, created_at
           FROM plugin_invocations
          WHERE workspace_id = ${workspaceId} AND installation_id = ${installationId}
            AND (${cursor?.createdAt ?? null}::timestamptz IS NULL
                 OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         kind: row.kind as InvocationKind,
         trigger: row.trigger as string,
         status: row.status === 'ok' ? 'ok' : 'error',
         httpStatus: (row.http_status as number | null) ?? null,
         durationMs: row.duration_ms as number,
         error: (row.error as string | null) ?? null,
         createdAt: toRFC3339(row.created_at as string) ?? '',
      }));
   }

   async pruneTokens(): Promise<number> {
      const result = await this.#sql`
         DELETE FROM plugin_tokens WHERE expires_at <= ${this.#clock().toISOString()}`;
      return result.count;
   }
}

function toStored(row: Record<string, unknown>): StoredValue {
   return {
      key: row.key as string,
      value: row.value,
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/runtime-store.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/plugins/runtime-store.ts server-ts/src/plugins/runtime-store.test.ts
git commit -m "feat(server-ts): mint plugin tokens and keep plugin storage and invocations"
```

---
### Task 6: Public API credentials (PAT scopes and plugin tokens)

**Files:**
- Create: `server-ts/src/public-api/auth.ts`, `server-ts/src/http/json-body.ts`
- Modify: `server-ts/src/identity/secrets.ts` (lines 24-44 `PERSONAL_TOKEN_COLUMNS` / `PersonalToken`, 105-148 `createPersonalToken`, and `toPersonalToken`), `server-ts/src/mounts/secrets.ts` (`tokenRoutes` POST, `serializePersonalToken`)
- Test: `server-ts/src/public-api/auth.test.ts`, `server-ts/src/http/json-body.test.ts`, `server-ts/src/identity/secrets.scopes.test.ts`

**Interfaces:**
- Consumes: T2 `parseScopes`, `grants`, `isApiScope`, `isPluginToken`, `parsePluginToken`; T5 `PluginRuntimeStore.resolveToken`, `PluginPrincipal`; `User` (`src/auth/sessions.ts`); J's `BearerResolver` and `personalTokenResolver(sql)` (`src/auth/credentials.ts`), which checks revocation and expiry and records last use; `isPersonalToken`, `parsePersonalToken`, `Unauthenticated` (`src/auth/tokens.ts`).
- Produces:
  - `type ApiPrincipal = { kind: 'user'; user: User; scopes: readonly ApiScope[] | null } | { kind: 'plugin'; plugin: PluginPrincipal; scopes: readonly ApiScope[] }`
  - `interface PublicApiVariables { principal: ApiPrincipal; requestId: string }`
  - `interface CredentialDeps { personalTokens: Pick<BearerResolver, 'resolve'>; plugins: Pick<PluginRuntimeStore, 'resolveToken'> | null; personalScopes: (publicId: string) => Promise<ApiScope[] | null> }`
  - `personalTokenScopes(sql: Sql): (publicId: string) => Promise<ApiScope[] | null>`
  - `resolvePrincipal(deps: CredentialDeps, header: string): Promise<ApiPrincipal>`
  - `requireApiCredential(deps: CredentialDeps): MiddlewareHandler<{ Variables: PublicApiVariables }>`
  - `requireScope(p: ApiPrincipal, s: ApiScope): void` (403 `INSUFFICIENT_SCOPE`)
  - `requirePlugin(p: ApiPrincipal): PluginPrincipal` (403 `PLUGIN_TOKEN_REQUIRED`)
  - `actorId(p: ApiPrincipal): string`
  - `readJson<T extends z.ZodType>(context: Context, schema: T, maxBytes?: number): Promise<z.output<T>>`
  - `SecretsRepository.createPersonalToken` now accepts `scopes: ApiScope[] | null`
  - `PersonalToken.scopes: string[] | null`
  - `POST /api/v1/tokens` accepts an optional `scopes` array, and token responses end with `scopes`.

- [ ] **Step 1: Write the failing tests**

`server-ts/src/public-api/auth.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User } from '../auth/sessions.ts';
import { Unauthenticated, generatePersonalToken } from '../auth/tokens.ts';
import type { ApiError } from '../http/errors.ts';
import { generatePluginToken } from '../plugins/tokens.ts';
import { PluginTokenInvalid } from '../plugins/runtime-store.ts';
import { requirePlugin, requireScope, resolvePrincipal, type CredentialDeps } from './auth.ts';

const USER: User = {
   id: '11111111-1111-4111-8111-111111111111', email: 'a@berry.test', name: 'A', avatarUrl: null,
   role: 'member', currentWorkspaceId: null, createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
};
const PLUGIN = {
   installationId: '22222222-2222-4222-8222-222222222222', workspaceId: '33333333-3333-4333-8333-333333333333',
   pluginKey: 'hello', installedBy: USER.id, scopes: ['issues:read' as const],
};
const plugin = generatePluginToken().token;
const pat = generatePersonalToken().token;

const deps: CredentialDeps = {
   personalTokens: { resolve: async (token) => { if (token !== pat) throw new Error('no'); return USER; } },
   plugins: { resolveToken: async (token) => { if (token !== plugin) throw new PluginTokenInvalid(); return PLUGIN; } },
   personalScopes: async () => ['comments:read'],
};

test('a personal token resolves to its user with the scopes stored on it', async () => {
   const principal = await resolvePrincipal(deps, `Bearer ${pat}`);
   assert.equal(principal.kind, 'user');
   assert.deepEqual(principal.scopes, ['comments:read']);
});

test('a plugin token resolves to its installation', async () => {
   const principal = await resolvePrincipal(deps, `Bearer ${plugin}`);
   assert.equal(principal.kind, 'plugin');
   assert.deepEqual(requirePlugin(principal), PLUGIN);
});

test('session tokens, malformed headers and plugin tokens without a store are refused', async () => {
   const session = Buffer.alloc(32, 7).toString('base64url');
   for (const header of [`Bearer ${session}`, `bearer ${pat}`, `Bearer  ${pat}`, `Bearer ${pat} x`, 'Basic abc']) {
      await assert.rejects(resolvePrincipal(deps, header), Unauthenticated, header);
   }
   await assert.rejects(resolvePrincipal({ ...deps, plugins: null }, `Bearer ${plugin}`), Unauthenticated);
});

test('scope and principal checks answer 403 with stable codes', async () => {
   const user = await resolvePrincipal(deps, `Bearer ${pat}`);
   assert.throws(() => requireScope(user, 'issues:write'), (e) => (e as ApiError).code === 'INSUFFICIENT_SCOPE' && (e as ApiError).status === 403);
   assert.throws(() => requirePlugin(user), (e) => (e as ApiError).code === 'PLUGIN_TOKEN_REQUIRED');
   requireScope({ kind: 'user', user: USER, scopes: null }, 'storage:write');
});
```

`server-ts/src/http/json-body.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { createApp } from './app.ts';
import { readJson } from './json-body.ts';
import { Registry } from './registry.ts';

const schema = z.object({ title: z.string().min(1) }).strict();
const route = new Hono();
route.post('/', async (context) => context.json(await readJson(context, schema)));
const registry = new Registry();
registry.register({ prefix: '/t', handler: route });
const app = createApp(registry);

const post = (body: string, type = 'application/json') =>
   app.request('/t', { method: 'POST', headers: { 'content-type': type }, body });

test('a valid body parses', async () => {
   const response = await post('{"title":"x"}');
   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), { title: 'x' });
});

test('wrong media type, bad JSON and schema failures get their own statuses', async () => {
   assert.equal((await post('{}', 'text/plain')).status, 415);
   assert.equal((await post('{nope')).status, 400);
   const invalid = await post('{"title":""}');
   assert.equal(invalid.status, 422);
   const body = (await invalid.json()) as { error: { details: { fields: { path: string }[] } } };
   assert.equal(body.error.details.fields[0]?.path, '/title');
});
```

`assertValid` (`src/http/body.ts:26`) throws `ValidationFailed`, whose details are `{ fields: FieldError[] }`, so the assertion reads `error.details.fields`.

Every test in this plan that calls `createPersonalToken` passes `fingerprint: Buffer.alloc(32, …)`. `personal_api_tokens` has `CHECK (octet_length(request_fingerprint) = 32)` (`migrations/004_identity_workspaces.up.sql`), so a shorter buffer fails the insert before the test asserts anything.

`server-ts/src/identity/secrets.scopes.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropWorld, seedWorld, type World } from '../plugins/fixture.test-support.ts';
import { personalTokenScopes } from '../public-api/auth.ts';
import { parsePersonalToken } from '../auth/tokens.ts';
import { SecretsRepository } from './secrets.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('personal token scopes', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'patscope');
   });
   after(async () => {
      await dropWorld(sql, world);
      await closeDatabase(sql);
   });

   test('scopes are stored with the token, and a token without scopes holds every scope', async () => {
      const secrets = new SecretsRepository(sql);
      const scoped = await secrets.createPersonalToken({
         userId: world.userId, name: 'ci', expiresAt: null, idempotencyKey: 'k'.repeat(20),
         fingerprint: Buffer.alloc(32, 'a'), scopes: ['issues:read'],
      });
      const open = await secrets.createPersonalToken({
         userId: world.userId, name: 'all', expiresAt: null, idempotencyKey: 'j'.repeat(20),
         fingerprint: Buffer.alloc(32, 'b'), scopes: null,
      });
      assert.deepEqual(scoped.token.scopes, ['issues:read']);
      assert.equal(open.token.scopes, null);
      const lookup = personalTokenScopes(sql);
      assert.deepEqual(await lookup(parsePersonalToken(scoped.secret).publicId), ['issues:read']);
      assert.equal(await lookup(parsePersonalToken(open.secret).publicId), null);
   });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/public-api/auth.test.ts src/http/json-body.test.ts src/identity/secrets.scopes.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./auth.ts` and `./json-body.ts`.

- [ ] **Step 3: Implement `json-body.ts`**

```ts
import type { Context } from 'hono';
import type { z } from 'zod';
import { assertValid, fieldError } from './body.ts';
import { ApiError } from './errors.ts';

/**
 * A JSON body parsed by a Zod schema, for mounts that validate with Zod
 * rather than the Go-compatible `decodeBody`. The failure statuses match it:
 * 415 for another media type, 413 when too large, 400 for malformed JSON,
 * 422 with one field error per issue.
 */
export async function readJson<T extends z.ZodType>(
   context: Context,
   schema: T,
   maxBytes = 1_000_000
): Promise<z.output<T>> {
   const mediaType = (context.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
   if (mediaType !== 'application/json') {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
   }
   const raw = await context.req.text();
   if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   let value: unknown;
   try {
      value = JSON.parse(raw);
   } catch {
      throw ApiError.badRequest('Request body must be valid JSON.');
   }
   const parsed = schema.safeParse(value);
   if (!parsed.success) {
      assertValid(
         parsed.error.issues.map((issue) =>
            fieldError('/' + issue.path.map(String).join('/'), issue.code, issue.message)
         )
      );
      throw ApiError.badRequest('Request body is invalid.');
   }
   return parsed.data;
}
```

- [ ] **Step 4: Implement `public-api/auth.ts`**

```ts
import type { MiddlewareHandler } from 'hono';
import type { BearerResolver } from '../auth/credentials.ts';
import type { User } from '../auth/sessions.ts';
import { isPersonalToken, parsePersonalToken, Unauthenticated } from '../auth/tokens.ts';
import type { Sql } from '../db/pool.ts';
import { ApiError } from '../http/errors.ts';
import type { PluginPrincipal, PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { isPluginToken, parsePluginToken } from '../plugins/tokens.ts';
import { grants, isApiScope, type ApiScope } from './scopes.ts';

/**
 * Bearer authentication for `/v1`: personal access tokens and plugin tokens
 * only. A browser session is not a credential here — the public API is for
 * programs, and a session cookie leaking into one would carry a person's full
 * rights with no scope at all.
 *
 * Every failure is the same 401, as in `auth/middleware.ts`.
 */

export type ApiPrincipal =
   | { kind: 'user'; user: User; scopes: readonly ApiScope[] | null }
   | { kind: 'plugin'; plugin: PluginPrincipal; scopes: readonly ApiScope[] };

export interface PublicApiVariables {
   principal: ApiPrincipal;
   requestId: string;
}

export interface CredentialDeps {
   /** J's `personalTokenResolver(sql)`: revocation, expiry and last-use are its job. */
   personalTokens: Pick<BearerResolver, 'resolve'>;
   plugins: Pick<PluginRuntimeStore, 'resolveToken'> | null;
   personalScopes: (publicId: string) => Promise<ApiScope[] | null>;
}

export function personalTokenScopes(sql: Sql): (publicId: string) => Promise<ApiScope[] | null> {
   return async (publicId) => {
      const [row] = await sql`SELECT scopes FROM personal_api_tokens WHERE public_id = ${publicId}`;
      const scopes = row?.scopes as string[] | null | undefined;
      return scopes === null || scopes === undefined ? null : scopes.filter(isApiScope);
   };
}

export async function resolvePrincipal(deps: CredentialDeps, header: string): Promise<ApiPrincipal> {
   // Exactly "Bearer " and one token: no second space anywhere.
   if (!header.startsWith('Bearer ') || header.indexOf(' ', 'Bearer '.length) !== -1) {
      throw new Unauthenticated();
   }
   const token = header.slice('Bearer '.length);
   try {
      if (isPluginToken(token)) {
         parsePluginToken(token);
         if (!deps.plugins) throw new Unauthenticated();
         const plugin = await deps.plugins.resolveToken(token);
         return { kind: 'plugin', plugin, scopes: plugin.scopes };
      }
      if (isPersonalToken(token)) {
         const { publicId } = parsePersonalToken(token);
         const user = await deps.personalTokens.resolve(token);
         return { kind: 'user', user, scopes: await deps.personalScopes(publicId) };
      }
   } catch {
      throw new Unauthenticated();
   }
   throw new Unauthenticated();
}

export function requireApiCredential(
   deps: CredentialDeps
): MiddlewareHandler<{ Variables: PublicApiVariables }> {
   return async (context, next) => {
      const headers = context.req.raw.headers;
      let count = 0;
      for (const [name] of headers) if (name.toLowerCase() === 'authorization') count += 1;
      const supplied = headers.get('authorization');
      if (supplied === null || count !== 1) throw ApiError.unauthorized();
      let principal: ApiPrincipal;
      try {
         principal = await resolvePrincipal(deps, supplied);
      } catch {
         throw ApiError.unauthorized();
      }
      context.set('principal', principal);
      await next();
   };
}

export function requireScope(principal: ApiPrincipal, scope: ApiScope): void {
   if (!grants(principal.scopes, scope)) {
      throw new ApiError(403, 'INSUFFICIENT_SCOPE', `This token does not hold the ${scope} scope.`, {
         required: scope,
      });
   }
}

export function requirePlugin(principal: ApiPrincipal): PluginPrincipal {
   if (principal.kind !== 'plugin') {
      throw new ApiError(403, 'PLUGIN_TOKEN_REQUIRED', 'Storage is available to plugin tokens only.');
   }
   return principal.plugin;
}

/** Who a write is recorded as: the person, or the member who installed the plugin. */
export function actorId(principal: ApiPrincipal): string {
   return principal.kind === 'user' ? principal.user.id : principal.plugin.installedBy;
}
```

- [ ] **Step 5: Add scopes to personal tokens**

In `server-ts/src/identity/secrets.ts`:
1. Change `PERSONAL_TOKEN_COLUMNS` so its last line reads `expires_at, last_used_at, revoked_at, created_at, scopes`.
2. Add `scopes: string[] | null;` as the last field of `interface PersonalToken`.
3. In `toPersonalToken` (search `function toPersonalToken`), add `scopes: (row.scopes as string[] | null) ?? null,` as the last property.
4. Add `import type { ApiScope } from '../public-api/scopes.ts';`. Add `scopes: ApiScope[] | null;` to the `createPersonalToken` params. In its `INSERT`, add `scopes` after `expires_at` in the column list and `${params.scopes === null ? null : tx.array(params.scopes)}` after `${params.expiresAt}` in the values.

In `server-ts/src/mounts/secrets.ts` `tokenRoutes` `route.post('/')`:
1. Extend the `decodeBody` generic and schema with `scopes?: unknown` / `scopes: 'raw'`.
2. After the expiry check and before `assertValid(fields)`, add:

```ts
      let scopes: ApiScope[] | null = null;
      if (value.scopes !== undefined && value.scopes !== null) {
         scopes = parseScopes(value.scopes);
         if (scopes === null) {
            fields.push(
               fieldError('/scopes', 'invalid_enum_value', `Scopes must be a list of: ${API_SCOPES.join(', ')}.`)
            );
         }
      }
```

3. Pass `scopes` in the `secrets.createPersonalToken({ ... })` call.
4. Append `scopes: token.scopes,` as the last property of `serializePersonalToken`.
5. Add `import { API_SCOPES, parseScopes, type ApiScope } from '../public-api/scopes.ts';`.

`decodeBody` drops `null` for non-`raw` specs, and `raw` keeps `null`. That is why the check treats `null` like an omission, which also means "every scope".

- [ ] **Step 6: Run the tests and the full suite**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/public-api/auth.test.ts src/http/json-body.test.ts src/identity/secrets.scopes.test.ts && pnpm typecheck && pnpm test`
Expected: PASS. If a pinned `/api/v1/tokens` body comparison fails, add `scopes: null` as the last field of the expected token object in that test. The change is additive and appended last.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/public-api/auth.ts server-ts/src/public-api/auth.test.ts server-ts/src/http/json-body.ts server-ts/src/http/json-body.test.ts server-ts/src/identity/secrets.ts server-ts/src/identity/secrets.scopes.test.ts server-ts/src/mounts/secrets.ts
git commit -m "feat(server-ts): authenticate the public API with scoped personal and plugin tokens"
```

---
### Task 7: `/v1` public API mount (context, issues, comments, storage)

**Files:**
- Create: `server-ts/src/mounts/public-api.ts`
- Modify: `server-ts/src/index.ts` (construct `PluginRuntimeStore` and register the mount), `server-ts/SCOPE.md` (served block), `docs/api/gateway-v1.md` (new section), `frontend/next.config.ts` (proxy `/v1` like `/api`)
- Test: `server-ts/src/mounts/public-api.test.ts`

**Interfaces:**
- Consumes: T6 `requireApiCredential`, `personalTokenScopes`, `requireScope`, `requirePlugin`, `actorId`, `readJson`, `PublicApiVariables`, `ApiPrincipal`; T5 `PluginRuntimeStore`, `validStorageKey`; `IssueRepository.get/authorize/update`, `Issue`, `IssuePatch`, `InvalidTransition`, `apiStatusToDb`, `dbStatusToApi` (`src/core/issues.ts`); `CommentRepository.list/create`, `InvalidParent`, `Comment` (`src/core/comments.ts`); `Broadcaster` (`src/realtime/hub.ts`).
- Produces:
  - `publicApiMounts(options: PublicApiOptions): Mount[]`, with prefix `/v1`
  - `interface PublicApiOptions { personalTokens: Pick<BearerResolver, 'resolve'>; sql: Sql; issues: IssueRepository; comments: CommentRepository; plugins: PluginRuntimeStore | null; broadcaster?: Broadcaster | undefined; clock?: () => Date }`
  - Permissions checked for the acting member: issue reads `product.read`, issue writes `product.write`, comment writes `comments.write` (so a viewer's PAT cannot comment).
  - Wire contract:
    - `GET /v1/context` → `{ principal, scopes, workspaces: [{ id, name, slug, role }] }`
    - `GET /v1/issues/:ref` / `PATCH /v1/issues/:ref` → `PublicIssue { id, identifier, workspaceId, boardId, title, description, status, priority, dueDate, assignee, createdAt, updatedAt }`
    - `GET /v1/issues/:ref/comments?first=` → `{ nodes: PublicComment[] }`
    - `POST /v1/issues/:ref/comments` → 201 `PublicComment { id, issueId, parentId, body, author: { type, id, name }, createdAt, updatedAt }`
    - `GET /v1/storage?prefix=&after=&first=` → `{ nodes: [{ key, value, updatedAt }], pageInfo: { hasNextPage, endCursor } }`
    - `GET|PUT|DELETE /v1/storage/:key`

- [ ] **Step 1: Write the failing test**

`server-ts/src/mounts/public-api.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from '../plugins/fixture.test-support.ts';
import { parsePackage } from '../plugins/manifest.ts';
import { PluginRepository } from '../plugins/repository.ts';
import { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { publicApiMounts } from './public-api.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('/v1 public API', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let w1: World;
   let w2: World;
   let viewerId = '';
   const tokens = { full: '', readOnly: '', plugin: '', viewer: '' };

   before(async () => {
      sql = openDatabase({ url: url as string });
      const runtime = new PluginRuntimeStore({ sql });
      const registry = new Registry();
      registry.registerAll(
         publicApiMounts({
            personalTokens: personalTokenResolver(sql),
            sql,
            issues: new IssueRepository(sql),
            comments: new CommentRepository(sql),
            plugins: runtime,
         })
      );
      app = createApp(registry);
      w1 = await seedWorld(sql, 'v1-a');
      w2 = await seedWorld(sql, 'v1-b');

      const secrets = new SecretsRepository(sql);
      const make = async (key: string, scopes: ['issues:read'] | null) =>
         (await secrets.createPersonalToken({
            userId: w1.userId, name: key, expiresAt: null, idempotencyKey: key.repeat(16),
            fingerprint: Buffer.alloc(32, key), scopes,
         })).secret;
      tokens.full = await make('f', null);
      tokens.readOnly = await make('r', ['issues:read']);

      // A viewer of W1 with a full-access key: reads work, writes are refused by role.
      const [viewer] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`v-${randomUUID()}@berry.test`}, 'V')
         RETURNING id`;
      viewerId = viewer?.id as string;
      await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${w1.workspaceId}, ${viewerId}, 'viewer')`;
      tokens.viewer = (await secrets.createPersonalToken({
         userId: viewerId, name: 'v', expiresAt: null, idempotencyKey: 'v'.repeat(16),
         fingerprint: Buffer.alloc(32, 'v'), scopes: null,
      })).secret;

      const repo = new PluginRepository({ sql, sealer: testSealer() });
      const { installation } = await sql.begin((tx) =>
         repo.install(tx, {
            workspaceId: w1.workspaceId, installedBy: w1.userId,
            // HELLO is not granted storage. resolveToken intersects a token's
            // scopes with the install grant, so without this the storage test
            // would get INSUFFICIENT_SCOPE instead of exercising storage.
            pkg: parsePackage({
               ...HELLO,
               manifest: { ...HELLO.manifest, scopes: ['issues:read', 'comments:write', 'storage:read', 'storage:write'] },
            }),
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         })
      );
      tokens.plugin = (
         await runtime.mintToken({
            workspaceId: w1.workspaceId, installationId: installation.id,
            scopes: ['issues:read', 'comments:write', 'storage:read', 'storage:write'], ttlMs: 60_000,
         })
      ).token;
   });
   after(async () => {
      await sql`DELETE FROM personal_api_tokens WHERE user_id = ${viewerId}`;
      await sql`DELETE FROM workspace_memberships WHERE user_id = ${viewerId}`;
      await dropWorld(sql, w1);
      await dropWorld(sql, w2);
      await sql`DELETE FROM users WHERE id = ${viewerId}`;
      await closeDatabase(sql);
   });

   const call = (path: string, token: string, init: RequestInit = {}) =>
      app.request(path, {
         ...init,
         headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      });

   test('a viewer reads but cannot write issues or comments, whatever the key scopes', async () => {
      assert.equal((await call(`/v1/issues/${w1.identifier}`, tokens.viewer)).status, 200);
      const patch = await call(`/v1/issues/${w1.identifier}`, tokens.viewer, {
         method: 'PATCH', body: JSON.stringify({ title: 'Nope' }),
      });
      assert.equal(patch.status, 403);
      const comment = await call(`/v1/issues/${w1.identifier}/comments`, tokens.viewer, {
         method: 'POST', body: JSON.stringify({ body: 'Nope' }),
      });
      assert.equal(comment.status, 403);
   });
   const code = async (response: Response) =>
      ((await response.json()) as { error: { code: string } }).error.code;

   test('context names the caller and their workspaces', async () => {
      const response = await call('/v1/context', tokens.full);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { principal: { type: string }; scopes: unknown; workspaces: { id: string }[] };
      assert.equal(body.principal.type, 'user');
      assert.equal(body.scopes, null);
      assert.deepEqual(body.workspaces.map((w) => w.id), [w1.workspaceId]);
   });

   test('an issue reads by identifier; another tenant reads as missing', async () => {
      const own = await call(`/v1/issues/${w1.identifier}`, tokens.readOnly);
      assert.equal(own.status, 200);
      assert.equal(((await own.json()) as { identifier: string }).identifier, w1.identifier);
      const foreign = await call(`/v1/issues/${w2.identifier}`, tokens.full);
      assert.equal(foreign.status, 404);
      const random = await call('/v1/issues/ZZZZ-999999', tokens.full);
      assert.equal(random.status, 404);
   });

   test('writing needs the write scope', async () => {
      const denied = await call(`/v1/issues/${w1.identifier}`, tokens.readOnly, {
         method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }),
      });
      assert.equal(denied.status, 403);
      assert.equal(await code(denied), 'INSUFFICIENT_SCOPE');
      const allowed = await call(`/v1/issues/${w1.identifier}`, tokens.full, {
         method: 'PATCH', body: JSON.stringify({ title: 'Renamed', priority: 'high' }),
      });
      assert.equal(allowed.status, 200);
      const body = (await allowed.json()) as { title: string; priority: string };
      assert.equal(body.title, 'Renamed');
      assert.equal(body.priority, 'high');
      const invalid = await call(`/v1/issues/${w1.identifier}`, tokens.full, {
         method: 'PATCH', body: JSON.stringify({ status: 'nope' }),
      });
      assert.equal(invalid.status, 422);
   });

   test('comments are created and listed', async () => {
      const created = await call(`/v1/issues/${w1.identifier}/comments`, tokens.full, {
         method: 'POST', body: JSON.stringify({ body: 'From the API.' }),
      });
      assert.equal(created.status, 201);
      const listed = await call(`/v1/issues/${w1.identifier}/comments`, tokens.full);
      const nodes = ((await listed.json()) as { nodes: { body: string }[] }).nodes;
      assert.ok(nodes.some((n) => n.body === 'From the API.'));
   });

   test('a session-shaped or missing credential is 401', async () => {
      assert.equal((await app.request('/v1/context')).status, 401);
      assert.equal((await call('/v1/context', Buffer.alloc(32, 1).toString('base64url'))).status, 401);
   });

   test('a plugin token sees only its own workspace and its granted scopes', async () => {
      assert.equal((await call(`/v1/issues/${w1.identifier}`, tokens.plugin)).status, 200);
      assert.equal((await call(`/v1/issues/${w2.identifier}`, tokens.plugin)).status, 404);
      const patch = await call(`/v1/issues/${w1.identifier}`, tokens.plugin, {
         method: 'PATCH', body: JSON.stringify({ title: 'x' }),
      });
      assert.equal(await code(patch), 'INSUFFICIENT_SCOPE');
      const context = (await (await call('/v1/context', tokens.plugin)).json()) as { principal: { type: string } };
      assert.equal(context.principal.type, 'plugin');
   });

   test('storage is plugin-only and round-trips values', async () => {
      assert.equal(await code(await call('/v1/storage', tokens.full)), 'PLUGIN_TOKEN_REQUIRED');
      const put = await call('/v1/storage/sync/cursor', tokens.plugin, {
         method: 'PUT', body: JSON.stringify({ value: { at: 3 } }),
      });
      assert.equal(put.status, 200);
      const got = await call('/v1/storage/sync/cursor', tokens.plugin);
      assert.deepEqual(((await got.json()) as { value: unknown }).value, { at: 3 });
      const listed = await call('/v1/storage?prefix=sync/', tokens.plugin);
      assert.deepEqual(((await listed.json()) as { nodes: { key: string }[] }).nodes.map((n) => n.key), ['sync/cursor']);
      assert.equal((await call('/v1/storage/sync/cursor', tokens.plugin, { method: 'DELETE' })).status, 204);
      assert.equal((await call('/v1/storage/sync/cursor', tokens.plugin)).status, 404);
   });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/public-api.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./public-api.ts`.

- [ ] **Step 3: Implement `mounts/public-api.ts`**

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { BearerResolver } from '../auth/credentials.ts';
import { InvalidParent, type Comment, type CommentRepository } from '../core/comments.ts';
import {
   apiStatusToDb,
   dbStatusToApi,
   InvalidTransition,
   type Issue,
   type IssuePatch,
   type IssueRepository,
} from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { readJson } from '../http/json-body.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { Permission } from '../identity/roles.ts';
import { InvalidPluginInput } from '../plugins/errors.ts';
import { validStorageKey, type PluginRuntimeStore } from '../plugins/runtime-store.ts';
import {
   actorId,
   personalTokenScopes,
   requireApiCredential,
   requirePlugin,
   requireScope,
   type ApiPrincipal,
   type PublicApiVariables,
} from '../public-api/auth.ts';
import type { Broadcaster } from '../realtime/hub.ts';

/**
 * `/v1` — Berry's public API for programs and plugins.
 *
 * Deliberately small and separate from `/api/v1`: it has its own credential
 * rules (tokens only, with scopes) and its own response shapes, so the
 * product API can keep evolving with the frontend without breaking scripts.
 * Every issue read and write still goes through the same membership check as
 * the product API, as the token's owner — for a plugin, the member who
 * installed it.
 */

export interface PublicApiOptions {
   /** J's `personalTokenResolver(sql)`. */
   personalTokens: Pick<BearerResolver, 'resolve'>;
   sql: Sql;
   issues: IssueRepository;
   comments: CommentRepository;
   plugins: PluginRuntimeStore | null;
   broadcaster?: Broadcaster | undefined;
   clock?: () => Date;
}

const STATUSES = ['backlog', 'todo', 'inProgress', 'inReview', 'done', 'blocked', 'cancelled'] as const;
const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;

const patchSchema = z
   .object({
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(100_000).nullable().optional(),
      status: z.enum(STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
   })
   .strict()
   .refine((value) => Object.keys(value).length > 0, 'Name at least one field to change.');

const commentSchema = z
   .object({
      body: z.string().trim().min(1).max(50_000),
      parentId: z.uuid().nullable().optional(),
   })
   .strict();

const storageSchema = z.object({ value: z.json() }).strict();

export function publicApiMounts(options: PublicApiOptions): Mount[] {
   return [{ prefix: '/v1', handler: publicApiRoutes(options) }];
}

function publicApiRoutes(options: PublicApiOptions): Hono<{ Variables: PublicApiVariables }> {
   const route = new Hono<{ Variables: PublicApiVariables }>();
   const clock = options.clock ?? (() => new Date());
   route.use(
      '*',
      requireApiCredential({
         personalTokens: options.personalTokens,
         plugins: options.plugins,
         personalScopes: personalTokenScopes(options.sql),
      })
   );

   route.get('/context', async (context) => {
      const principal = context.get('principal');
      if (principal.kind === 'user') {
         const workspaces = await options.sql`
            SELECT w.id, w.name, w.slug, m.role::text AS role
              FROM workspace_memberships AS m
              JOIN workspaces AS w ON w.id = m.workspace_id AND w.deleted_at IS NULL
             WHERE m.user_id = ${principal.user.id}
             ORDER BY w.created_at, w.id`;
         return json({
            principal: { type: 'user', id: principal.user.id, name: principal.user.name, email: principal.user.email },
            scopes: principal.scopes,
            workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, slug: w.slug, role: w.role })),
         });
      }
      const [workspace] = await options.sql`
         SELECT id, name, slug FROM workspaces WHERE id = ${principal.plugin.workspaceId}`;
      return json({
         principal: {
            type: 'plugin',
            installationId: principal.plugin.installationId,
            pluginKey: principal.plugin.pluginKey,
         },
         scopes: principal.scopes,
         workspaces: workspace ? [{ id: workspace.id, name: workspace.name, slug: workspace.slug, role: null }] : [],
      });
   });

   route.get('/issues/:ref', async (context) => {
      const principal = context.get('principal');
      requireScope(principal, 'issues:read');
      const issue = await loadIssue(options, principal, context.req.param('ref'), 'product.read');
      return json(serializeIssue(issue));
   });

   route.patch('/issues/:ref', async (context) => {
      const principal = context.get('principal');
      requireScope(principal, 'issues:write');
      const issue = await loadIssue(options, principal, context.req.param('ref'), 'product.write');
      const body = await readJson(context, patchSchema);
      const patch: IssuePatch = {
         descriptionSet: body.description !== undefined,
         dueDateSet: false,
         assigneeSet: false,
         projectSet: false,
         ...(body.title !== undefined ? { title: body.title } : {}),
         ...(body.description !== undefined ? { description: body.description } : {}),
         ...(body.status !== undefined ? { status: apiStatusToDb(body.status) } : {}),
         ...(body.priority !== undefined ? { priority: body.priority } : {}),
      };
      const result = await options.issues
         .update({ issueId: issue.id, patch, actorId: actorId(principal) })
         .catch((error: unknown) => {
            if (error instanceof InvalidTransition) {
               throw new ApiError(409, 'INVALID_TRANSITION', `Cannot move from ${error.from} to ${error.to}.`);
            }
            return mapIssueError(error);
         });
      await publish(options.broadcaster, result.events);
      return json(serializeIssue(result.issue));
   });

   route.get('/issues/:ref/comments', async (context) => {
      const principal = context.get('principal');
      requireScope(principal, 'comments:read');
      const issue = await loadIssue(options, principal, context.req.param('ref'), 'product.read');
      const first = Math.min(100, Math.max(1, Number(context.req.query('first') ?? '50') || 50));
      const found = await options.comments.list(issue.id, null, first);
      return json({ nodes: found.map(serializeComment) });
   });

   route.post('/issues/:ref/comments', async (context) => {
      const principal = context.get('principal');
      requireScope(principal, 'comments:write');
      const issue = await loadIssue(options, principal, context.req.param('ref'), 'comments.write');
      const body = await readJson(context, commentSchema);
      const created = await options.comments
         .create({
            issueId: issue.id,
            authorId: actorId(principal),
            body: body.body,
            parentId: body.parentId ?? null,
            createdAt: clock().toISOString(),
         })
         .catch((error: unknown) => {
            if (error instanceof InvalidParent) {
               throw new ApiError(422, 'INVALID_PARENT', 'A reply must hang off a top-level comment on this issue.');
            }
            return mapIssueError(error);
         });
      await publish(options.broadcaster, [created.event]);
      return json(serializeComment(created.comment), 201);
   });

   route.get('/storage', async (context) => {
      const principal = context.get('principal');
      const plugin = requirePlugin(principal);
      requireScope(principal, 'storage:read');
      const store = requireStore(options.plugins);
      const first = Math.min(100, Math.max(1, Number(context.req.query('first') ?? '50') || 50));
      const found = await store.listValues(plugin.installationId, {
         prefix: context.req.query('prefix') ?? '',
         after: context.req.query('after') ?? null,
         limit: first + 1,
      });
      const nodes = found.slice(0, first);
      return json({
         nodes,
         pageInfo: { hasNextPage: found.length > first, endCursor: nodes.at(-1)?.key ?? null },
      });
   });

   route.get('/storage/:key{.+}', async (context) => {
      const principal = context.get('principal');
      const plugin = requirePlugin(principal);
      requireScope(principal, 'storage:read');
      const found = await requireStore(options.plugins).getValue(plugin.installationId, storageKey(context.req.param('key')));
      if (!found) throw ApiError.notFound('Storage key');
      return json(found);
   });

   route.put('/storage/:key{.+}', async (context) => {
      const principal = context.get('principal');
      const plugin = requirePlugin(principal);
      requireScope(principal, 'storage:write');
      const key = storageKey(context.req.param('key'));
      const body = await readJson(context, storageSchema, 100_000);
      try {
         return json(await requireStore(options.plugins).putValue(plugin, key, body.value));
      } catch (error) {
         if (error instanceof InvalidPluginInput) {
            throw new ApiError(422, 'VALIDATION_FAILED', error.fields[0]?.message ?? 'Invalid value.', { fields: error.fields });
         }
         throw error;
      }
   });

   route.delete('/storage/:key{.+}', async (context) => {
      const principal = context.get('principal');
      const plugin = requirePlugin(principal);
      requireScope(principal, 'storage:write');
      await requireStore(options.plugins).deleteValue(plugin.installationId, storageKey(context.req.param('key')));
      return new Response(null, { status: 204 });
   });

   return route;
}

async function loadIssue(
   options: PublicApiOptions,
   principal: ApiPrincipal,
   reference: string,
   permission: Permission
): Promise<Issue> {
   const issue = await options.issues.get(reference).catch(mapIssueError);
   // A plugin is bound to one workspace; outside it, an issue does not exist.
   if (principal.kind === 'plugin' && issue.workspaceId !== principal.plugin.workspaceId) {
      throw ApiError.notFound('Issue');
   }
   await options.issues.authorize(actorId(principal), issue.id, permission).catch(mapIssueError);
   return issue;
}

function mapIssueError(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Issue');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}

function requireStore(store: PluginRuntimeStore | null): PluginRuntimeStore {
   if (!store) throw new ApiError(412, 'PLUGINS_NOT_CONFIGURED', 'Plugins are not available on this deployment.');
   return store;
}

function storageKey(raw: string): string {
   if (!validStorageKey(raw)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Key must be 1 to 200 URL-safe characters.');
   }
   return raw;
}

async function publish(
   broadcaster: Broadcaster | undefined,
   events: { id: string; type: string; workspaceId: string; boardId: string; payload: string; occurredAt: Date }[]
): Promise<void> {
   if (!broadcaster) return;
   for (const event of events) {
      try {
         await broadcaster.publish({
            id: event.id,
            workspaceId: event.workspaceId,
            boardId: event.boardId,
            type: event.type,
            payload: event.payload,
            occurredAt: event.occurredAt,
         });
      } catch {
         // The outbox row is committed; the SSE replay delivers it on the next poll.
      }
   }
}

function serializeIssue(issue: Issue): Record<string, unknown> {
   return {
      id: issue.id,
      identifier: issue.identifier,
      workspaceId: issue.workspaceId,
      boardId: issue.boardId,
      title: issue.title,
      description: issue.description,
      status: dbStatusToApi(issue.status),
      priority: issue.priority,
      dueDate: issue.dueDate,
      assignee: issue.assignee ? { type: issue.assignee.type, id: issue.assignee.id, name: issue.assignee.name } : null,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
   };
}

function serializeComment(comment: Comment): Record<string, unknown> {
   return {
      id: comment.id,
      issueId: comment.issueId,
      parentId: comment.parentId,
      body: comment.body,
      author: { type: comment.author.type, id: comment.author.id, name: comment.author.name },
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
   };
}
```

Implementation notes (checked against the code):
- `z.json()` and `z.uuid()` are top-level APIs in Zod ^4.2.1.
- `Comment` (`src/core/comments.ts:28`) has `id, issueId, body, author: ActorRef, parentId, createdAt, updatedAt`. `IssueMutationEvent` and `CommentEvent` both have `id, type, workspaceId, boardId, issueId, payload, occurredAt: Date`, so the structural `publish` parameter fits both. `Broadcaster.publish(event: Event)` (`src/realtime/event.ts`) takes `boardId` as optional and has no `issueId`.
- `IssueRepository.authorize(userId, issueId, permission)` (`src/core/issues.ts:199`) accepts any `Permission`, `comments.write` included.

- [ ] **Step 4: Wire into `index.ts`**

In `server-ts/src/index.ts`:
- Add `import { PluginRuntimeStore } from './plugins/runtime-store.ts';` and `import { publicApiMounts } from './mounts/public-api.ts';`. J's wiring already imports `personalTokenResolver` from `./auth/credentials.ts`; add it to the import if it is not there.
- After `const agents = new AgentRepository(sql);`, add:

```ts
// Plugin tokens, storage and the invocation log. Needs no key: nothing it
// holds is a secret in the clear (tokens are digests).
const pluginRuntime = new PluginRuntimeStore({ sql });
```

- After `registry.registerAll(commentMounts(commentOptions));`, add:

```ts
registry.registerAll(
   publicApiMounts({
      personalTokens: personalTokenResolver(sql),
      sql,
      issues,
      comments,
      plugins: pluginRuntime,
      broadcaster,
   })
);
```

In `frontend/next.config.ts` `rewrites()`, add this entry directly after the `/api/:path*` entry. Plugins call `${apiUrl}/v1/...` with `apiUrl = BERRY_PUBLIC_URL`. When that origin is the web app rather than the API, `/v1` would otherwise answer with the Next.js 404.

```ts
         {
            source: '/v1/:path*',
            destination: `${apiOrigin}/v1/:path*`,
         },
```

- [ ] **Step 5: Document the contract**

In `server-ts/SCOPE.md`, add `/v1` to the served block, as its own line after the `/health /metrics /ready /readyz` line:

```
/v1                   (public API: personal and plugin tokens only)
```

In `docs/api/gateway-v1.md`, append a section:

```markdown
## Public API v1 (`/v1`)

A small, stable API for scripts and plugins, separate from the product API.

- **Credentials.** `Authorization: Bearer berry_pat_…` (a personal access token) or `Bearer berry_plg_…` (a plugin token Berry hands a plugin on each call). A session token is refused with 401.
- **Scopes.** `issues:read`, `issues:write`, `comments:read`, `comments:write`, `storage:read`, `storage:write`. A personal token created without `scopes` holds all of them. A missing scope is `403 INSUFFICIENT_SCOPE` with `details.required`.
- **Tenancy.** A personal token acts as its user, through the same membership checks as `/api/v1`. A plugin token acts as the member who installed the plugin, and only inside that plugin's workspace. An issue in another workspace is `404`, the same as a missing one.
- `GET /v1/context` — `{ principal, scopes, workspaces[] }`.
- `GET /v1/issues/{ref}` and `PATCH /v1/issues/{ref}` — `ref` is a UUID or an identifier such as `BER-12`. PATCH accepts `title`, `description`, `status` (`backlog`, `todo`, `inProgress`, `inReview`, `done`, `blocked`, `cancelled`) and `priority` (`none`, `urgent`, `high`, `medium`, `low`). Status moves follow the board's rules (`409 INVALID_TRANSITION`).
- `GET /v1/issues/{ref}/comments?first=1..100` — `{ nodes[] }`, oldest first. `POST` accepts `{ body, parentId? }` and returns `201`.
- `GET /v1/storage?prefix=&after=&first=`, `GET|PUT|DELETE /v1/storage/{key}` — plugin tokens only (`403 PLUGIN_TOKEN_REQUIRED` otherwise). Keys are 1–200 of `A–Z a–z 0–9 . _ : / -`. `PUT` takes `{ value }`, any JSON of at most 64 KB.
- `POST /api/v1/tokens` accepts an optional `scopes` array. Token responses end with `scopes` (`null` = every scope).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/public-api.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/mounts/public-api.ts server-ts/src/mounts/public-api.test.ts server-ts/src/index.ts server-ts/SCOPE.md docs/api/gateway-v1.md frontend/next.config.ts
git commit -m "feat(server-ts): serve the public API v1 for tokens and plugins"
```

---
### Task 8: Plugin admin mount `/api/v1/plugins/:workspaceId/*` + cross-tenant tests

**Files:**
- Create: `server-ts/src/mounts/plugins.ts`
- Modify: `server-ts/src/index.ts`, `server-ts/SCOPE.md`
- Test: `server-ts/src/mounts/plugins.test.ts`, `server-ts/src/mounts/plugins.cross-tenant.test.ts`

**Interfaces:**
- Consumes: T3 `loadPackage`, `describePackage`, `PluginNetwork`, `createPluginNetwork`, error classes; T4 `PluginRepository`, `PluginInstallation`; T5 `PluginRuntimeStore`; T6 `readJson`; `mountWorkspaceScope`, `ScopedVariables`, `pathId` (`src/mounts/shared.ts`); `allows` (`src/identity/roles.ts`); `parsePageQuery`, `decodeTimeCursor`, `encodeCursor` (`src/http/cursor.ts`).
- Produces:
  - `pluginMounts(options: PluginMountOptions): Mount[]`, with prefix `/api/v1/plugins`
  - `interface PluginMountOptions { sessions: SessionService; sql: Sql; plugins: PluginRepository | null; runtime: PluginRuntimeStore; network: PluginNetwork; publicUrl: string | null; clock?: () => Date }`
  - `serializeInstallation(i: PluginInstallation): Record<string, unknown>`
  - `SURFACE_TOKEN_TTL_MS = 15 * 60_000`
  - A surface launch mints its token with the installation's granted scopes, narrowed to the launching member's role. `issues:write` and `storage:write` need `product.write`, and `comments:write` needs `comments.write`.
  - Routes. Writes need `settings.write`; storage and invocations need `settings.read`; everything else needs membership.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/:ws/preview` | `{ url }` or `{ package }` | `PluginPreview` |
| GET | `/:ws/installations` | | `{ nodes: Installation[] }` |
| POST | `/:ws/installations` | `{ url \| package, config? }` | 201 `{ installation, signingSecret }`, `Cache-Control: no-store` |
| GET | `/:ws/installations/:id` | | `Installation & { files }` |
| PATCH | `/:ws/installations/:id` | `{ enabled?, config? }` | `Installation` |
| DELETE | `/:ws/installations/:id` | | 204 |
| PUT / DELETE | `/:ws/installations/:id/secrets/:name` | `{ value }` | 204 |
| PUT | `/:ws/installations/:id/tools/:tool` | `{ approved }` | `Installation` |
| GET | `/:ws/installations/:id/storage?first&after` | | `{ nodes, pageInfo }` |
| GET | `/:ws/installations/:id/invocations?first&after` | | `{ nodes, pageInfo }` |
| POST | `/:ws/installations/:id/surfaces/:surface/launch` | | `{ url, expiresAt }` |

The serialized `Installation` is `{ id, workspaceId, key, name, version, description, source, sourceUrl, enabled, config, configFields, secrets: [{ name, description, set }], scopes, hooks, surfaces, mcpTools: [{ name, description, approved }], installedBy, createdAt, updatedAt }`. It never includes secret values.

- [ ] **Step 1: Write the failing tests**

`server-ts/src/mounts/plugins.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { dropWorld, HELLO, seedWorld, testSealer, testSessions, type World } from '../plugins/fixture.test-support.ts';
import { PluginRepository } from '../plugins/repository.ts';
import { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { pluginMounts } from './plugins.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('/api/v1/plugins', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: World;
   let memberId = '';
   let viewerId = '';
   const tokens = { owner: '', member: '', viewer: '' };

   before(async () => {
      sql = openDatabase({ url: url as string });
      const registry = new Registry();
      registry.registerAll(
         pluginMounts({
            sessions: testSessions(sql),
            sql,
            plugins: new PluginRepository({ sql, sealer: testSealer() }),
            runtime: new PluginRuntimeStore({ sql }),
            network: { request: async () => ({ status: 200, body: JSON.stringify(HELLO) }) },
            publicUrl: 'https://berry.example.com',
         })
      );
      app = createApp(registry);
      world = await seedWorld(sql, 'admin');
      const [member] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`m-${randomUUID()}@berry.test`}, 'M')
         RETURNING id`;
      memberId = member?.id as string;
      await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${world.workspaceId}, ${memberId}, 'member')`;
      const secrets = new SecretsRepository(sql);
      const pat = async (userId: string, key: string) =>
         (await secrets.createPersonalToken({
            userId, name: key, expiresAt: null, idempotencyKey: key.repeat(16), fingerprint: Buffer.alloc(32, key), scopes: null,
         })).secret;
      tokens.owner = await pat(world.userId, 'o');
      tokens.member = await pat(memberId, 'm');
      const [viewer] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`v-${randomUUID()}@berry.test`}, 'V')
         RETURNING id`;
      viewerId = viewer?.id as string;
      await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${world.workspaceId}, ${viewerId}, 'viewer')`;
      tokens.viewer = await pat(viewerId, 'v');
   });
   after(async () => {
      for (const userId of [memberId, viewerId]) {
         await sql`DELETE FROM personal_api_tokens WHERE user_id = ${userId}`;
         await sql`DELETE FROM workspace_memberships WHERE user_id = ${userId}`;
      }
      await dropWorld(sql, world);
      await sql`DELETE FROM users WHERE id IN (${memberId}, ${viewerId})`;
      await closeDatabase(sql);
   });

   const call = (path: string, token: string, init: RequestInit = {}) =>
      app.request(`/api/v1/plugins/${world.workspaceId}${path}`, {
         ...init,
         headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });

   let installationId = '';

   test('preview reads a package from a URL without installing it', async () => {
      const response = await call('/preview', tokens.owner, {
         method: 'POST', body: JSON.stringify({ url: 'https://hello.example.com/berry-plugin.json' }),
      });
      assert.equal(response.status, 200);
      const preview = (await response.json()) as { key: string; scopes: string[] };
      assert.equal(preview.key, 'hello');
      assert.deepEqual(preview.scopes, ['issues:read', 'comments:write']);
      const list = (await (await call('/installations', tokens.owner)).json()) as { nodes: unknown[] };
      assert.equal(list.nodes.length, 0);
   });

   test('a member cannot install; an owner can, and sees the signing secret once', async () => {
      const denied = await call('/installations', tokens.member, {
         method: 'POST', body: JSON.stringify({ package: HELLO, config: { greeting: 'hi' } }),
      });
      assert.equal(denied.status, 403);
      const created = await call('/installations', tokens.owner, {
         method: 'POST', body: JSON.stringify({ package: HELLO, config: { greeting: 'hi' } }),
      });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get('cache-control'), 'no-store');
      const body = (await created.json()) as { installation: { id: string }; signingSecret: string };
      assert.match(body.signingSecret, /^berry_whsec_/);
      installationId = body.installation.id;
      const again = await call('/installations', tokens.owner, {
         method: 'POST', body: JSON.stringify({ package: HELLO, config: { greeting: 'hi' } }),
      });
      assert.equal(again.status, 409);
   });

   test('config, secrets and tool approvals change; secret values never come back', async () => {
      const patched = await call(`/installations/${installationId}`, tokens.owner, {
         method: 'PATCH', body: JSON.stringify({ config: { greeting: 'yo' } }),
      });
      assert.equal(patched.status, 200);
      assert.equal((await call(`/installations/${installationId}/secrets/API_KEY`, tokens.owner, {
         method: 'PUT', body: JSON.stringify({ value: 'sk-secret-value' }),
      })).status, 204);
      const tool = await call(`/installations/${installationId}/tools/say_hello`, tokens.owner, {
         method: 'PUT', body: JSON.stringify({ approved: true }),
      });
      assert.equal(tool.status, 200);
      const detail = await call(`/installations/${installationId}`, tokens.member);
      const text = await detail.text();
      assert.ok(!text.includes('sk-secret-value'));
      const parsed = JSON.parse(text) as { secrets: { name: string; set: boolean }[]; mcpTools: { approved: boolean }[] };
      assert.deepEqual(parsed.secrets, [{ name: 'API_KEY', description: '', set: true }]);
      assert.equal(parsed.mcpTools[0]?.approved, true);
   });

   test('a member launches a surface and the launch is logged', async () => {
      const launched = await call(`/installations/${installationId}/surfaces/panel/launch`, tokens.member, { method: 'POST' });
      assert.equal(launched.status, 200);
      const body = (await launched.json()) as { url: string };
      assert.ok(body.url.startsWith('https://hello.example.com/ui#'));
      const fragment = new URLSearchParams(body.url.split('#')[1] ?? '');
      assert.match(fragment.get('token') ?? '', /^berry_plg_/);
      assert.equal(fragment.get('apiUrl'), 'https://berry.example.com');
      const log = (await (await call(`/installations/${installationId}/invocations`, tokens.owner)).json()) as {
         nodes: { kind: string }[];
      };
      assert.equal(log.nodes[0]?.kind, 'surface');
      assert.equal((await call(`/installations/${installationId}/surfaces/nope/launch`, tokens.member, { method: 'POST' })).status, 404);
   });

   test('a viewer\'s surface token carries no write scope, although the plugin was granted one', async () => {
      const launched = await call(`/installations/${installationId}/surfaces/panel/launch`, tokens.viewer, { method: 'POST' });
      assert.equal(launched.status, 200);
      const token = new URLSearchParams(((await launched.json()) as { url: string }).url.split('#')[1] ?? '').get('token') ?? '';
      const principal = await new PluginRuntimeStore({ sql }).resolveToken(token);
      // HELLO is granted issues:read and comments:write; a viewer may not write comments.
      assert.deepEqual(principal.scopes, ['issues:read']);
   });

   test('a viewer cannot change the plugin', async () => {
      const denied = await call(`/installations/${installationId}`, tokens.viewer, {
         method: 'PATCH', body: JSON.stringify({ enabled: false }),
      });
      assert.equal(denied.status, 403);
   });

   test('uninstall removes it', async () => {
      assert.equal((await call(`/installations/${installationId}`, tokens.owner, { method: 'DELETE' })).status, 204);
      assert.equal((await call(`/installations/${installationId}`, tokens.owner)).status, 404);
   });
});
```

`server-ts/src/mounts/plugins.cross-tenant.test.ts`:

```ts
// Cross-tenant leakage for the plugin admin mount and the public API, in the
// shape of cross-tenant-leakage.test.ts: U1 owns W1, W2 belongs to someone
// else and has a plugin installed. Nothing of W2 is readable or writable by U1.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { dropWorld, HELLO, seedWorld, testSealer, testSessions, type World } from '../plugins/fixture.test-support.ts';
import { parsePackage } from '../plugins/manifest.ts';
import { PluginRepository } from '../plugins/repository.ts';
import { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { pluginMounts } from './plugins.ts';
import { publicApiMounts } from './public-api.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const REQUEST_ID = 'req_' + 'b'.repeat(32);

describe('Feature: plugins, cross-tenant leakage', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let w1: World;
   let w2: World;
   let u1Token = '';
   let w2Installation = '';
   let w2PluginToken = '';
   let plugins: PluginRepository;

   before(async () => {
      sql = openDatabase({ url: url as string });
      const sessions = testSessions(sql);
      plugins = new PluginRepository({ sql, sealer: testSealer() });
      const runtime = new PluginRuntimeStore({ sql });
      const registry = new Registry();
      registry.registerAll(
         pluginMounts({ sessions, sql, plugins, runtime, network: { request: async () => ({ status: 500, body: '' }) }, publicUrl: null })
      );
      registry.registerAll(
         publicApiMounts({
            personalTokens: personalTokenResolver(sql),
            sql,
            issues: new IssueRepository(sql),
            comments: new CommentRepository(sql),
            plugins: runtime,
         })
      );
      app = createApp(registry);
      w1 = await seedWorld(sql, 'leak-p1');
      w2 = await seedWorld(sql, 'leak-p2');
      u1Token = (await new SecretsRepository(sql).createPersonalToken({
         userId: w1.userId, name: 'u1', expiresAt: null, idempotencyKey: 'u'.repeat(20), fingerprint: Buffer.alloc(32, 'u'), scopes: null,
      })).secret;
      const { installation } = await sql.begin((tx) =>
         plugins.install(tx, {
            workspaceId: w2.workspaceId, installedBy: w2.userId, pkg: parsePackage(HELLO),
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         })
      );
      w2Installation = installation.id;
      w2PluginToken = (await runtime.mintToken({
         workspaceId: w2.workspaceId, installationId: installation.id, scopes: ['issues:read'], ttlMs: 60_000,
      })).token;
   });
   after(async () => {
      await dropWorld(sql, w1);
      await dropWorld(sql, w2);
      await closeDatabase(sql);
   });

   const as = (path: string, token: string | null, method = 'GET', body?: unknown) =>
      app.request(path, {
         method,
         headers: {
            'x-request-id': REQUEST_ID,
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
         },
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

   test('(a) U1 listing W1 never sees the W2 installation', async () => {
      const body = (await (await as(`/api/v1/plugins/${w1.workspaceId}/installations`, u1Token)).json()) as { nodes: { id: string }[] };
      assert.ok(!body.nodes.some((n) => n.id === w2Installation));
   });

   test('(b) a W2 path answers as a missing workspace, and a W2 id under W1 as a missing plugin', async () => {
      for (const path of [
         `/api/v1/plugins/${w2.workspaceId}/installations`,
         `/api/v1/plugins/${w2.workspaceId}/installations/${w2Installation}`,
         `/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}`,
         `/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/storage`,
         `/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/invocations`,
      ]) {
         assert.equal((await as(path, u1Token)).status, 404, path);
      }
      assert.equal((await as(`/api/v1/plugins/${w2.workspaceId}/preview`, u1Token, 'POST', { package: HELLO })).status, 404);
   });

   test('(c) U1 mutating the W2 installation gets 404 and W2 is unchanged', async () => {
      await sql.begin((tx) => plugins.setSecret(tx, w2.workspaceId, w2Installation, 'API_KEY', 'w2-secret'));
      for (const [path, method, body] of [
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}`, 'PATCH', { enabled: false }],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}`, 'DELETE', undefined],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/secrets/API_KEY`, 'PUT', { value: 'x' }],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/secrets/API_KEY`, 'DELETE', undefined],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/tools/say_hello`, 'PUT', { approved: true }],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/surfaces/panel/launch`, 'POST', undefined],
         [`/api/v1/plugins/${w2.workspaceId}/installations/${w2Installation}`, 'PATCH', { enabled: false }],
         [`/api/v1/plugins/${w2.workspaceId}/installations`, 'POST', { package: HELLO, config: { greeting: 'x' } }],
      ] as const) {
         assert.equal((await as(path, u1Token, method, body)).status, 404, `${method} ${path}`);
      }
      const [row] = await sql`SELECT enabled FROM plugin_installations WHERE id = ${w2Installation}`;
      assert.equal(row?.enabled, true);
      assert.deepEqual(await plugins.openSecrets(w2.workspaceId, w2Installation), { API_KEY: 'w2-secret' });
      const approvals = await sql`SELECT 1 FROM plugin_tool_approvals WHERE installation_id = ${w2Installation}`;
      assert.equal(approvals.length, 0);
      const tokens = await sql`SELECT 1 FROM plugin_tokens WHERE installation_id = ${w2Installation}`;
      assert.equal(tokens.length, 1, 'only the token minted in before()');
   });

   test("(c'') a W2 plugin token sees only W2 in context", async () => {
      const context = (await (await as('/v1/context', w2PluginToken)).json()) as { workspaces: { id: string }[] };
      assert.deepEqual(context.workspaces.map((w) => w.id), [w2.workspaceId]);
   });

   test("(c') a W2 plugin token cannot read a W1 issue", async () => {
      assert.equal((await as(`/v1/issues/${w1.identifier}`, w2PluginToken)).status, 404);
   });

   test('(d) no credential is 401 on both mounts', async () => {
      assert.equal((await as(`/api/v1/plugins/${w1.workspaceId}/installations`, null)).status, 401);
      assert.equal((await as('/v1/context', null)).status, 401);
   });

   test('(e) U1 cannot read or write a W2 issue through /v1, and W2 is unchanged', async () => {
      const [before] = await sql`SELECT title FROM issues WHERE id = ${w2.issueId}`;
      assert.equal((await as(`/v1/issues/${w2.issueId}`, u1Token)).status, 404);
      assert.equal((await as(`/v1/issues/${w2.identifier}`, u1Token, 'PATCH', { title: 'Leaked' })).status, 404);
      assert.equal((await as(`/v1/issues/${w2.identifier}/comments`, u1Token)).status, 404);
      assert.equal((await as(`/v1/issues/${w2.identifier}/comments`, u1Token, 'POST', { body: 'Leaked' })).status, 404);
      const [after] = await sql`SELECT title FROM issues WHERE id = ${w2.issueId}`;
      assert.equal(after?.title, before?.title);
      const comments = await sql`SELECT 1 FROM comments WHERE issue_id = ${w2.issueId}`;
      assert.equal(comments.length, 0);
   });
});
```

`IssueRepository.authorize` throws `NotFound` when the caller has no membership row for the issue's workspace (`src/core/issues.ts`, `scopeFrom`). `/v1` maps that to 404, so a foreign issue and a missing one answer the same way.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/plugins.test.ts src/mounts/plugins.cross-tenant.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./plugins.ts`.

- [ ] **Step 3: Implement `mounts/plugins.ts`**

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { ApiError } from '../http/errors.ts';
import { readJson } from '../http/json-body.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import type { ScopedDb } from '../identity/workspace-context.ts';
import { InvalidPluginInput, PluginAlreadyInstalled, PluginUnreachable } from '../plugins/errors.ts';
import { loadPackage, type PackageSource } from '../plugins/loader.ts';
import { describePackage } from '../plugins/manifest.ts';
import type { PluginNetwork } from '../plugins/net.ts';
import type { PluginInstallation, PluginRepository } from '../plugins/repository.ts';
import type { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { mountWorkspaceScope, pathId, type ScopedVariables } from './shared.ts';

/**
 * `/api/v1/plugins/:workspaceId/*` — installing and running plugins.
 *
 * Its own prefix rather than a sub-route of `/api/v1/workspaces`, because the
 * registry refuses overlapping prefixes. The workspace gate is the same one
 * `workspace-reads` uses: membership before any handler runs, and the
 * permission each write needs checked inside `ScopedDb.mutate`.
 */

export const SURFACE_TOKEN_TTL_MS = 15 * 60_000;

export interface PluginMountOptions {
   sessions: SessionService;
   sql: Sql;
   /** Null without INTEGRATION_ENCRYPTION_KEY: nothing can seal a plugin's secrets. */
   plugins: PluginRepository | null;
   runtime: PluginRuntimeStore;
   network: PluginNetwork;
   /** Where a plugin reaches `/v1`. BERRY_PUBLIC_URL. */
   publicUrl: string | null;
   clock?: () => Date;
}

const sourceFields = {
   url: z.url().max(500).optional(),
   package: z.unknown().optional(),
};
const oneSource = (value: { url?: string | undefined; package?: unknown }) =>
   (value.url === undefined) !== (value.package === undefined);
const previewSchema = z.object(sourceFields).strict().refine(oneSource, 'Give either url or package.');
const installSchema = z
   .object({ ...sourceFields, config: z.record(z.string(), z.unknown()).optional() })
   .strict()
   .refine(oneSource, 'Give either url or package.');
const patchSchema = z
   .object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() })
   .strict();
const secretSchema = z.object({ value: z.string().min(1).max(4096) }).strict();
const toolSchema = z.object({ approved: z.boolean() }).strict();

export function pluginMounts(options: PluginMountOptions): Mount[] {
   return [{ prefix: '/api/v1/plugins', handler: pluginRoutes(options) }];
}

function pluginRoutes(options: PluginMountOptions): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();
   mountWorkspaceScope(route, { sessions: options.sessions, sql: options.sql });
   const clock = options.clock ?? (() => new Date());
   const repo = (): PluginRepository => {
      if (!options.plugins) {
         throw new ApiError(412, 'PLUGINS_NOT_CONFIGURED', 'Plugins need INTEGRATION_ENCRYPTION_KEY to hold their secrets.');
      }
      return options.plugins;
   };
   const id = (raw: string | undefined) => pathId(raw, 'Plugin');

   route.post('/:workspaceId/preview', async (context) => {
      requirePermission(context.get('scoped'), 'settings.write');
      const body = await readJson(context, previewSchema, 2_000_000);
      const loaded = await loadPackage(options.network, toSource(body)).catch(mapPluginError);
      return json(describePackage(loaded.pkg));
   });

   route.get('/:workspaceId/installations', async (context) => {
      const found = await repo().list(context.get('scoped').ctx.workspaceId);
      return json({ nodes: found.map(serializeInstallation) });
   });

   route.post('/:workspaceId/installations', async (context) => {
      const scoped = context.get('scoped');
      requirePermission(scoped, 'settings.write');
      const body = await readJson(context, installSchema, 2_000_000);
      const loaded = await loadPackage(options.network, toSource(body)).catch(mapPluginError);
      const { installation, signingSecret } = await scoped
         .mutate('settings.write', (tx, ctx) =>
            repo().install(tx, {
               workspaceId: ctx.workspaceId,
               installedBy: ctx.userId,
               pkg: loaded.pkg,
               source: loaded.source,
               sourceUrl: loaded.sourceUrl,
               config: body.config ?? {},
            })
         )
         .catch(mapPluginError);
      const response = json({ installation: serializeInstallation(installation), signingSecret }, 201);
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   route.get('/:workspaceId/installations/:id', async (context) => {
      const workspaceId = context.get('scoped').ctx.workspaceId;
      const installationId = id(context.req.param('id'));
      const installation = await repo().get(workspaceId, installationId).catch(mapPluginError);
      const files = await repo().files(workspaceId, installationId);
      return json({ ...serializeInstallation(installation), files });
   });

   route.patch('/:workspaceId/installations/:id', async (context) => {
      const scoped = context.get('scoped');
      const installationId = id(context.req.param('id'));
      const body = await readJson(context, patchSchema);
      const updated = await scoped
         .mutate('settings.write', (tx, ctx) =>
            repo().update(tx, ctx.workspaceId, installationId, {
               ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
               ...(body.config !== undefined ? { config: body.config } : {}),
            })
         )
         .catch(mapPluginError);
      return json(serializeInstallation(updated));
   });

   route.delete('/:workspaceId/installations/:id', async (context) => {
      const installationId = id(context.req.param('id'));
      await context
         .get('scoped')
         .mutate('settings.write', (tx, ctx) => repo().uninstall(tx, ctx.workspaceId, installationId))
         .catch(mapPluginError);
      return new Response(null, { status: 204 });
   });

   route.put('/:workspaceId/installations/:id/secrets/:name', async (context) => {
      const installationId = id(context.req.param('id'));
      const name = context.req.param('name');
      const body = await readJson(context, secretSchema);
      await context
         .get('scoped')
         .mutate('settings.write', (tx, ctx) => repo().setSecret(tx, ctx.workspaceId, installationId, name, body.value))
         .catch(mapPluginError);
      const response = new Response(null, { status: 204 });
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   route.delete('/:workspaceId/installations/:id/secrets/:name', async (context) => {
      const installationId = id(context.req.param('id'));
      const name = context.req.param('name');
      await context
         .get('scoped')
         .mutate('settings.write', (tx, ctx) => repo().deleteSecret(tx, ctx.workspaceId, installationId, name))
         .catch(mapPluginError);
      return new Response(null, { status: 204 });
   });

   route.put('/:workspaceId/installations/:id/tools/:tool', async (context) => {
      const scoped = context.get('scoped');
      const installationId = id(context.req.param('id'));
      const tool = context.req.param('tool');
      const body = await readJson(context, toolSchema);
      await scoped
         .mutate('settings.write', (tx, ctx) =>
            repo().setToolApproval(tx, ctx.workspaceId, installationId, tool, body.approved, ctx.userId)
         )
         .catch(mapPluginError);
      return json(serializeInstallation(await repo().get(scoped.ctx.workspaceId, installationId)));
   });

   route.get('/:workspaceId/installations/:id/storage', async (context) => {
      const scoped = context.get('scoped');
      requirePermission(scoped, 'settings.read');
      const installationId = id(context.req.param('id'));
      await repo().get(scoped.ctx.workspaceId, installationId).catch(mapPluginError);
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const found = await options.runtime.listValues(installationId, {
         prefix: '',
         after: after === '' ? null : after,
         limit: first + 1,
      });
      const nodes = found.slice(0, first);
      return json({ nodes, pageInfo: { hasNextPage: found.length > first, endCursor: nodes.at(-1)?.key ?? null } });
   });

   route.get('/:workspaceId/installations/:id/invocations', async (context) => {
      const scoped = context.get('scoped');
      requirePermission(scoped, 'settings.read');
      const installationId = id(context.req.param('id'));
      await repo().get(scoped.ctx.workspaceId, installationId).catch(mapPluginError);
      const scope = `plugins.invocations.${installationId}`;
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const cursor = after === '' ? null : decodeTimeCursor(after, scope);
      const found = await options.runtime.listInvocations(scoped.ctx.workspaceId, installationId, cursor, first + 1);
      const nodes = found.slice(0, first);
      const last = nodes.at(-1);
      return json({
         nodes,
         pageInfo: {
            hasNextPage: found.length > first,
            endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
         },
      });
   });

   route.post('/:workspaceId/installations/:id/surfaces/:surface/launch', async (context) => {
      const workspaceId = context.get('scoped').ctx.workspaceId;
      const installationId = id(context.req.param('id'));
      const installation = await repo().get(workspaceId, installationId).catch(mapPluginError);
      const surface = installation.manifest.surfaces.find((s) => s.key === context.req.param('surface'));
      if (!surface) throw ApiError.notFound('Surface');
      if (!installation.enabled) throw new ApiError(409, 'PLUGIN_DISABLED', 'This plugin is disabled.');
      const started = clock().getTime();
      // The token acts as the installer, but the person opening the page may
      // hold less. Never hand a viewer a token that can write what they cannot.
      const role = context.get('scoped').ctx.role;
      const scopes = installation.grantedScopes.filter((scope) => {
         if (scope === 'issues:write' || scope === 'storage:write') return allows(role, 'product.write');
         if (scope === 'comments:write') return allows(role, 'comments.write');
         return true;
      });
      const { token, expiresAt } = await options.runtime.mintToken({
         workspaceId,
         installationId,
         scopes,
         ttlMs: SURFACE_TOKEN_TTL_MS,
      });
      await options.runtime.recordInvocation({
         workspaceId, installationId, kind: 'surface', trigger: surface.key,
         status: 'ok', httpStatus: null, durationMs: clock().getTime() - started, error: null,
      });
      // The fragment never reaches a server log: the browser keeps it.
      const fragment = new URLSearchParams({
         token,
         expiresAt,
         apiUrl: options.publicUrl ?? '',
         workspaceId,
         installationId,
      });
      const base = installation.manifest.baseUrl.replace(/\/+$/, '');
      return json({ url: `${base}${surface.path}#${fragment.toString()}`, expiresAt });
   });

   return route;
}

function toSource(body: { url?: string | undefined; package?: unknown }): PackageSource {
   return body.url !== undefined ? { url: body.url } : { package: body.package };
}

function requirePermission(scoped: ScopedDb, permission: Permission): void {
   if (!allows(scoped.ctx.role, permission)) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
}

function mapPluginError(error: unknown): never {
   if (error instanceof InvalidPluginInput) {
      throw new ApiError(422, 'VALIDATION_FAILED', error.fields[0]?.message ?? 'The plugin input is invalid.', {
         fields: error.fields,
      });
   }
   if (error instanceof PluginUnreachable) throw new ApiError(502, 'PLUGIN_UNREACHABLE', error.message);
   if (error instanceof PluginAlreadyInstalled) {
      throw new ApiError(409, 'PLUGIN_ALREADY_INSTALLED', 'A plugin with this key is already installed here.');
   }
   if (error instanceof NotFound) throw ApiError.notFound('Plugin');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}

export function serializeInstallation(installation: PluginInstallation): Record<string, unknown> {
   const { manifest } = installation;
   return {
      id: installation.id,
      workspaceId: installation.workspaceId,
      key: installation.key,
      name: installation.name,
      version: installation.version,
      description: installation.description,
      source: installation.source,
      sourceUrl: installation.sourceUrl,
      enabled: installation.enabled,
      config: installation.config,
      configFields: manifest.config,
      secrets: manifest.secrets.map((s) => ({
         name: s.name,
         description: s.description,
         set: installation.secretNames.includes(s.name),
      })),
      scopes: installation.grantedScopes,
      hooks: manifest.hooks.map((h) =>
         h.trigger === 'event'
            ? { key: h.key, trigger: 'event', events: h.events }
            : { key: h.key, trigger: 'schedule', everyMinutes: h.everyMinutes }
      ),
      surfaces: manifest.surfaces.map((s) => ({ key: s.key, title: s.title })),
      mcpTools: (manifest.mcp?.tools ?? []).map((t) => ({
         name: t.name,
         description: t.description,
         approved: installation.approvedTools.includes(t.name),
      })),
      installedBy: installation.installedBy,
      createdAt: installation.createdAt,
      updatedAt: installation.updatedAt,
   };
}
```

Notes (checked against the code):
- `allows(role: string, permission: Permission)` (`src/identity/roles.ts:75`) takes the role as a string, and `ScopedDb.ctx.role` is a string.
- `decodeTimeCursor(token: string, scope: string)` (`src/http/cursor.ts:128`), `encodeCursor(scope, key)` and `parsePageQuery(url)` exist with these signatures.
- Hono `context.req.param('name')` is typed `string` for a declared param.

- [ ] **Step 4: Wire into `index.ts`**

Add these imports:

```ts
import { PluginRepository } from './plugins/repository.ts';
import { createPluginNetwork } from './plugins/net.ts';
import { pluginMounts } from './mounts/plugins.ts';
```

After the `githubApp` constant, add:

```ts
// Plugins hold sealed secrets and a sealed signing key, so they need the same
// key integrations do. Without it the mount answers PLUGINS_NOT_CONFIGURED.
const pluginRepository = config.integrationKey
   ? new PluginRepository({ sql, sealer: sealerFromKey(config.integrationKey) })
   : null;
const pluginNetwork = createPluginNetwork({ allowPrivate: config.pluginsAllowPrivateNetwork });
```

After the `publicApiMounts` registration from T7, add:

```ts
registry.registerAll(
   pluginMounts({
      sessions,
      sql,
      plugins: pluginRepository,
      runtime: pluginRuntime,
      network: pluginNetwork,
      publicUrl: config.integrations.publicUrl,
   })
);
```

In `server-ts/SCOPE.md`, add `/api/v1/plugins` to the served block in alphabetical position, next to `/api/v1/plans`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/plugins.test.ts src/mounts/plugins.cross-tenant.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/mounts/plugins.ts server-ts/src/mounts/plugins.test.ts server-ts/src/mounts/plugins.cross-tenant.test.ts server-ts/src/index.ts server-ts/SCOPE.md
git commit -m "feat(server-ts): install, configure and launch workspace plugins"
```

---
### Task 9: Hooks: signed calls, event delivery, schedules

**Files:**
- Create: `server-ts/src/plugins/signing.ts`, `server-ts/src/plugins/hooks.ts`
- Modify: `server-ts/src/index.ts` (start and stop the runner)
- Test: `server-ts/src/plugins/signing.test.ts`, `server-ts/src/plugins/hooks.test.ts`

**Interfaces:**
- Consumes: T3 `PluginNetwork`, `PluginUnreachable`; T4 `PluginRepository` (`listEnabled`, `get`, `openSecrets`, `signingSecret`), `PluginInstallation`; T5 `PluginRuntimeStore` (`mintToken`, `recordInvocation`, `pruneTokens`).
- Produces:
  - `SIGNATURE_HEADER = 'Berry-Signature'`
  - `signPayload(secret: string, timestamp: number, body: string): string` → `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`
  - `HOOK_TOKEN_TTL_MS = 10 * 60_000`
  - `class PluginCaller`, constructed with `{ plugins: PluginRepository; runtime: PluginRuntimeStore; network: PluginNetwork; publicUrl: string | null; clock?: () => Date }`. Method: `call(installation: PluginInstallation, input: { kind: 'event' | 'schedule'; trigger: string; path: string; event?: unknown }): Promise<'ok' | 'error'>`
  - `class PluginHookRunner`, constructed with `{ sql: Sql; plugins: PluginRepository; caller: PluginCaller; batchSize?: number; onError?: (message: string, error: unknown) => void }`. Methods:
    - `tick(): Promise<{ events: number; schedules: number }>`
    - `start(intervalMs?: number): void`
    - `stop(): Promise<void>`
  - Hook request body, which the SDK types mirror in T11: `{ type: 'event' | 'schedule', trigger, pluginKey, installationId, workspaceId, config, secrets, api: { url, token, expiresAt }, event: { id, type, occurredAt, payload } | null }`
  - Headers: `content-type: application/json`, `Berry-Signature`.

- [ ] **Step 1: Write the failing tests**

`server-ts/src/plugins/signing.test.ts`:

```ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { signPayload } from './signing.ts';

test('the signature is an HMAC of timestamp and body under the signing secret', () => {
   const expected = createHmac('sha256', 'berry_whsec_k').update('1700000000.{"a":1}').digest('hex');
   assert.equal(signPayload('berry_whsec_k', 1700000000, '{"a":1}'), `t=1700000000,v1=${expected}`);
   assert.notEqual(signPayload('berry_whsec_k', 1700000000, '{"a":2}'), signPayload('berry_whsec_k', 1700000000, '{"a":1}'));
});
```

`server-ts/src/plugins/hooks.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from './fixture.test-support.ts';
import { PluginCaller, PluginHookRunner } from './hooks.ts';
import { parsePackage } from './manifest.ts';
import type { PluginNetwork, PluginRequest } from './net.ts';
import { PluginRepository, type PluginInstallation } from './repository.ts';
import { PluginRuntimeStore } from './runtime-store.ts';
import { SIGNATURE_HEADER, signPayload } from './signing.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('plugin hooks', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let repo: PluginRepository;
   let runtime: PluginRuntimeStore;
   let installation: PluginInstallation;
   let signingSecret = '';
   let failPaths = new Set<string>();
   // A base URL unique to this run, so deliveries to other tests' plugins are ignored.
   const baseUrl = `https://hooks-${randomUUID().slice(0, 8)}.example.com`;
   const calls: { url: string; init: PluginRequest }[] = [];
   const network: PluginNetwork = {
      request: async (target, init) => {
         calls.push({ url: target, init });
         const path = new URL(target).pathname;
         return { status: failPaths.has(path) ? 500 : 200, body: '{}' };
      },
   };
   const ours = () => calls.filter((c) => c.url.startsWith(baseUrl));

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'hooks');
      repo = new PluginRepository({ sql, sealer: testSealer() });
      runtime = new PluginRuntimeStore({ sql });
      const pkg = parsePackage({ ...HELLO, manifest: { ...HELLO.manifest, baseUrl } });
      const installed = await sql.begin((tx) =>
         repo.install(tx, {
            workspaceId: world.workspaceId, installedBy: world.userId, pkg,
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         })
      );
      installation = installed.installation;
      signingSecret = installed.signingSecret;
      await sql.begin((tx) => repo.setSecret(tx, world.workspaceId, installation.id, 'API_KEY', 'sk-1'));
      await sql`INSERT INTO plugin_event_cursor (id) VALUES (1) ON CONFLICT DO NOTHING`;
      // Just before the test's own events, so one batch reaches them even when
      // other suites have written outbox rows recently.
      await sql`UPDATE plugin_event_cursor SET occurred_at = now() - interval '11 seconds', event_id = '00000000-0000-0000-0000-000000000000' WHERE id = 1`;
   });
   after(async () => {
      await dropWorld(sql, world);
      await closeDatabase(sql);
   });

   const runner = () =>
      new PluginHookRunner({
         sql,
         plugins: repo,
         caller: new PluginCaller({ plugins: repo, runtime, network, publicUrl: 'https://berry.example.com' }),
      });

   test('an outbox event matching a hook is delivered once, signed, with config, secrets and a token', async () => {
      const eventId = randomUUID();
      await sql`
         INSERT INTO outbox_events (id, topic, aggregate_type, aggregate_id, workspace_id, payload, occurred_at, available_at)
         VALUES (${eventId}, 'comment.created', 'comment', ${randomUUID()}, ${world.workspaceId},
                 ${sql.json({ id: eventId, type: 'comment.created', payload: { comment: { body: 'hi' } } } as never)},
                 now() - interval '10 seconds', now() - interval '10 seconds')`;
      await runner().tick();
      await runner().tick();
      const delivered = ours().filter((c) => c.url === `${baseUrl}/hooks/comment`);
      assert.equal(delivered.length, 1);
      const call = delivered[0];
      assert.ok(call);
      const body = call.init.body ?? '';
      const header = call.init.headers?.[SIGNATURE_HEADER] ?? '';
      const timestamp = Number(/t=(\d+)/.exec(header)?.[1]);
      assert.equal(header, signPayload(signingSecret, timestamp, body));
      const parsed = JSON.parse(body) as {
         type: string; trigger: string; config: unknown; secrets: unknown; api: { token: string; url: string };
         event: { id: string; payload: unknown };
      };
      // HELLO is not granted comments:read, so the comment body is withheld.
      assert.equal(parsed.event.payload, null);
      assert.equal(parsed.type, 'event');
      assert.equal(parsed.trigger, 'comment.created');
      assert.deepEqual(parsed.config, { greeting: 'hi' });
      assert.deepEqual(parsed.secrets, { API_KEY: 'sk-1' });
      assert.match(parsed.api.token, /^berry_plg_/);
      assert.equal(parsed.api.url, 'https://berry.example.com');
      assert.equal(parsed.event.id, eventId);
      const logged = await runtime.listInvocations(world.workspaceId, installation.id, null, 10);
      assert.equal(logged[0]?.kind, 'event');
      assert.equal(logged[0]?.status, 'ok');
   });

   test('a due schedule fires once and moves its next time forward; failures are logged as errors', async () => {
      failPaths = new Set(['/hooks/nightly']);
      await sql`UPDATE plugin_hook_state SET next_fire_at = now() - interval '1 second' WHERE installation_id = ${installation.id}`;
      await runner().tick();
      await runner().tick();
      assert.equal(ours().filter((c) => c.url === `${baseUrl}/hooks/nightly`).length, 1);
      const [state] = await sql`SELECT next_fire_at > now() AS ahead FROM plugin_hook_state WHERE installation_id = ${installation.id}`;
      assert.equal(state?.ahead, true);
      const logged = await runtime.listInvocations(world.workspaceId, installation.id, null, 1);
      assert.equal(logged[0]?.kind, 'schedule');
      assert.equal(logged[0]?.status, 'error');
      assert.equal(logged[0]?.httpStatus, 500);
   });

   test('a disabled plugin receives nothing', async () => {
      await sql.begin((tx) => repo.update(tx, world.workspaceId, installation.id, { enabled: false }));
      const before = ours().length;
      const eventId = randomUUID();
      await sql`
         INSERT INTO outbox_events (id, topic, aggregate_type, aggregate_id, workspace_id, payload, occurred_at, available_at)
         VALUES (${eventId}, 'comment.created', 'comment', ${randomUUID()}, ${world.workspaceId},
                 ${sql.json({ id: eventId } as never)}, now() - interval '5 seconds', now() - interval '5 seconds')`;
      await sql`UPDATE plugin_hook_state SET next_fire_at = now() - interval '1 second' WHERE installation_id = ${installation.id}`;
      await runner().tick();
      assert.equal(ours().length, before);
   });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/signing.test.ts src/plugins/hooks.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `signing.ts`**

```ts
import { createHmac } from 'node:crypto';

/**
 * How a plugin knows a call came from Berry: an HMAC over the timestamp and
 * the exact body bytes, under the signing secret shown once at install. The
 * timestamp lets the plugin refuse replays (the SDK allows five minutes).
 */

export const SIGNATURE_HEADER = 'Berry-Signature';

export function signPayload(secret: string, timestamp: number, body: string): string {
   const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
   return `t=${timestamp},v1=${digest}`;
}
```

- [ ] **Step 4: Implement `hooks.ts`**

```ts
import type { Sql } from '../db/pool.ts';
import type { ApiScope } from '../public-api/scopes.ts';
import { PluginUnreachable } from './errors.ts';
import type { PluginNetwork } from './net.ts';
import type { PluginInstallation, PluginRepository } from './repository.ts';
import type { PluginRuntimeStore } from './runtime-store.ts';
import { SIGNATURE_HEADER, signPayload } from './signing.ts';

/**
 * Berry calling plugins.
 *
 * Event hooks follow `outbox_events` through one cursor row. The row is locked
 * FOR UPDATE SKIP LOCKED, so across several servers exactly one reads each
 * batch. The cursor advances before delivery, so delivery is at most once: a
 * plugin that was down misses the event rather than receiving it twice, and
 * the invocation log shows the failure. Events are read with a two-second lag
 * so a transaction that commits slightly out of order is not skipped. Only
 * subscribed topics are read, and when a batch is not full the cursor jumps
 * to the lag horizon. A plugin installed later therefore sees only events
 * from after its install.
 *
 * Schedule hooks claim due rows the same way and move `next_fire_at` forward
 * in the same statement.
 *
 * A plugin that writes back on the event it was told about (a comment on
 * `comment.created`) will be told about its own write. That is the plugin's
 * loop to break; the SDK docs say so.
 */

export const HOOK_TOKEN_TTL_MS = 10 * 60_000;

/**
 * The read scope an event's payload needs. Subscribing to a topic is not a
 * grant: a plugin without the scope is told that the event happened (id, type,
 * time) but not what it says. Families with no public API scope are never
 * shared.
 */
export function payloadScope(topic: string): ApiScope | null {
   if (topic.startsWith('issue.')) return 'issues:read';
   if (topic.startsWith('comment.')) return 'comments:read';
   return null;
}

export interface CallerOptions {
   plugins: PluginRepository;
   runtime: PluginRuntimeStore;
   network: PluginNetwork;
   publicUrl: string | null;
   clock?: () => Date;
}

export class PluginCaller {
   readonly #options: CallerOptions;
   readonly #clock: () => Date;

   constructor(options: CallerOptions) {
      this.#options = options;
      this.#clock = options.clock ?? (() => new Date());
   }

   async call(
      installation: PluginInstallation,
      input: { kind: 'event' | 'schedule'; trigger: string; path: string; event?: unknown }
   ): Promise<'ok' | 'error'> {
      const { plugins, runtime, network, publicUrl } = this.#options;
      const started = this.#clock().getTime();
      let status: 'ok' | 'error' = 'error';
      let httpStatus: number | null = null;
      let error: string | null = null;
      try {
         const { token, expiresAt } = await runtime.mintToken({
            workspaceId: installation.workspaceId,
            installationId: installation.id,
            scopes: installation.grantedScopes,
            ttlMs: HOOK_TOKEN_TTL_MS,
         });
         const body = JSON.stringify({
            type: input.kind,
            trigger: input.trigger,
            pluginKey: installation.key,
            installationId: installation.id,
            workspaceId: installation.workspaceId,
            config: installation.config,
            secrets: await plugins.openSecrets(installation.workspaceId, installation.id),
            api: { url: publicUrl, token, expiresAt },
            event: input.event ?? null,
         });
         const secret = await plugins.signingSecret(installation.workspaceId, installation.id);
         const timestamp = Math.floor(this.#clock().getTime() / 1000);
         const base = installation.manifest.baseUrl.replace(/\/+$/, '');
         const response = await network.request(`${base}${input.path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signPayload(secret, timestamp, body) },
            body,
            timeoutMs: 10_000,
            maxBytes: 65_536,
         });
         httpStatus = response.status;
         status = response.status >= 200 && response.status < 300 ? 'ok' : 'error';
         if (status === 'error') error = `plugin answered ${response.status}`;
      } catch (cause) {
         // Only our own messages are recorded: an arbitrary error could carry
         // a URL with a credential in it.
         error = cause instanceof PluginUnreachable ? cause.message : 'plugin call failed';
      }
      await runtime.recordInvocation({
         workspaceId: installation.workspaceId,
         installationId: installation.id,
         kind: input.kind,
         trigger: input.trigger,
         status,
         httpStatus,
         durationMs: this.#clock().getTime() - started,
         error,
      });
      return status;
   }
}

export interface RunnerOptions {
   sql: Sql;
   plugins: PluginRepository;
   caller: PluginCaller;
   batchSize?: number;
   onError?: (message: string, error: unknown) => void;
}

export class PluginHookRunner {
   readonly #options: RunnerOptions;
   readonly #batch: number;
   #timer: NodeJS.Timeout | null = null;
   #running: Promise<unknown> | null = null;

   constructor(options: RunnerOptions) {
      this.#options = options;
      this.#batch = options.batchSize ?? 100;
   }

   async tick(): Promise<{ events: number; schedules: number }> {
      const events = await this.#deliverEvents();
      const schedules = await this.#fireSchedules();
      return { events, schedules };
   }

   start(intervalMs = 5_000): void {
      if (this.#timer) return;
      void this.#options.sql`INSERT INTO plugin_event_cursor (id) VALUES (1) ON CONFLICT DO NOTHING`.catch((error: unknown) =>
         this.#options.onError?.('plugin cursor init failed', error)
      );
      this.#timer = setInterval(() => {
         if (this.#running) return;
         this.#running = this.tick()
            .catch((error: unknown) => this.#options.onError?.('plugin hook tick failed', error))
            .finally(() => {
               this.#running = null;
            });
      }, intervalMs);
      this.#timer.unref();
   }

   async stop(): Promise<void> {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = null;
      await this.#running;
   }

   async #deliverEvents(): Promise<number> {
      const { sql, plugins, caller } = this.#options;
      const rows = await sql.begin(async (tx) => {
         const [cursor] = await tx`
            SELECT occurred_at, event_id FROM plugin_event_cursor WHERE id = 1 FOR UPDATE SKIP LOCKED`;
         if (!cursor) return [];
         // Read only topics some enabled plugin subscribes to. outbox_events also
         // carries high-volume topics (run.output.delta from src/runs/ledger.ts);
         // without this filter they fill every batch, and the cursor falls
         // further behind on every tick.
         const subscribed = await tx`
            SELECT DISTINCT e.topic
              FROM plugin_installations AS i,
                   jsonb_array_elements(i.manifest->'hooks') AS h,
                   jsonb_array_elements_text(h->'events') AS e(topic)
             WHERE i.enabled AND h->>'trigger' = 'event'`;
         const topics = subscribed.map((row) => row.topic as string);
         const [clock] = await tx`SELECT now() - interval '2 seconds' AS horizon`;
         const horizon = clock?.horizon as string;
         const found =
            topics.length === 0
               ? []
               : await tx`
                  SELECT id, topic, workspace_id, payload, occurred_at FROM outbox_events
                   WHERE (occurred_at, id) > (${cursor.occurred_at as string}::timestamptz, ${cursor.event_id as string}::uuid)
                     AND occurred_at <= ${horizon}::timestamptz
                     AND topic = ANY(${tx.array(topics)}::text[])
                   ORDER BY occurred_at, id
                   LIMIT ${this.#batch}`;
         const last = found.at(-1);
         if (last && found.length === this.#batch) {
            // A full batch: there may be more before the horizon. Resume after the last row.
            await tx`
               UPDATE plugin_event_cursor SET occurred_at = ${last.occurred_at as string}, event_id = ${last.id as string}
                WHERE id = 1`;
         } else {
            // Every subscribed event up to the horizon has been read, so jump there.
            // The all-f uuid sorts after every id at that instant.
            await tx`
               UPDATE plugin_event_cursor
                  SET occurred_at = ${horizon}::timestamptz, event_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                WHERE id = 1`;
         }
         return found;
      });

      const byWorkspace = new Map<string, typeof rows>();
      for (const row of rows) {
         const workspaceId = row.workspace_id as string | null;
         if (!workspaceId) continue;
         const list = byWorkspace.get(workspaceId) ?? [];
         list.push(row);
         byWorkspace.set(workspaceId, list);
      }
      let delivered = 0;
      for (const [workspaceId, events] of byWorkspace) {
         const installations = await plugins.listEnabled(workspaceId);
         for (const installation of installations) {
            for (const hook of installation.manifest.hooks) {
               if (hook.trigger !== 'event') continue;
               for (const event of events) {
                  if (!hook.events.includes(event.topic as string)) continue;
                  const envelope = event.payload as { payload?: unknown } | null;
                  const needed = payloadScope(event.topic as string);
                  const shared = needed !== null && installation.grantedScopes.includes(needed);
                  await caller.call(installation, {
                     kind: 'event',
                     trigger: event.topic as string,
                     path: hook.path,
                     event: {
                        id: event.id,
                        type: event.topic,
                        occurredAt: event.occurred_at,
                        payload: shared ? (envelope?.payload ?? null) : null,
                     },
                  });
                  delivered += 1;
               }
            }
         }
      }
      return delivered;
   }

   async #fireSchedules(): Promise<number> {
      const { sql, plugins, caller } = this.#options;
      const due = await sql`
         UPDATE plugin_hook_state AS s
            SET last_fired_at = now(), next_fire_at = now() + make_interval(mins => s.interval_minutes)
          WHERE (s.installation_id, s.hook_key) IN (
                SELECT installation_id, hook_key FROM plugin_hook_state
                 WHERE next_fire_at <= now()
                 ORDER BY next_fire_at
                 LIMIT ${this.#batch}
                 FOR UPDATE SKIP LOCKED)
         RETURNING s.installation_id, s.workspace_id, s.hook_key`;
      let fired = 0;
      for (const row of due) {
         const installation = await plugins
            .get(row.workspace_id as string, row.installation_id as string)
            .catch(() => null);
         if (!installation || !installation.enabled) continue;
         const hook = installation.manifest.hooks.find((h) => h.key === row.hook_key && h.trigger === 'schedule');
         if (!hook) continue;
         await caller.call(installation, { kind: 'schedule', trigger: hook.key, path: hook.path });
         fired += 1;
      }
      return fired;
   }
}
```

- [ ] **Step 5: Start the runner in `index.ts`**

In `server-ts/src/index.ts`, add `import { PluginCaller, PluginHookRunner } from './plugins/hooks.ts';`. After the `pluginMounts` registration, add:

```ts
// Plugin hooks run in every server process; the cursor and schedule rows are
// claimed with SKIP LOCKED, so two processes never deliver the same thing.
const pluginHooks = pluginRepository
   ? new PluginHookRunner({
        sql,
        plugins: pluginRepository,
        caller: new PluginCaller({
           plugins: pluginRepository,
           runtime: pluginRuntime,
           network: pluginNetwork,
           publicUrl: config.integrations.publicUrl,
        }),
        onError: (message, error) =>
           logger.error(message, { error: error instanceof Error ? error.message : String(error) }),
     })
   : null;
pluginHooks?.start();
```

In the shutdown handler, change `void (dispatcher ? dispatcher.stop() : Promise.resolve())` to:

```ts
         void Promise.all([
            dispatcher ? dispatcher.stop() : Promise.resolve(),
            pluginHooks ? pluginHooks.stop() : Promise.resolve(),
         ])
```

Keep the `.then(() => closeDatabase(sql))` chain unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/signing.test.ts src/plugins/hooks.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/plugins/signing.ts server-ts/src/plugins/signing.test.ts server-ts/src/plugins/hooks.ts server-ts/src/plugins/hooks.test.ts server-ts/src/index.ts
git commit -m "feat(server-ts): deliver signed event and scheduled plugin hooks"
```

---
### Task 10: Plugin MCP servers for the agent envelope

**Files:**
- Create: `server-ts/src/plugins/mcp.ts`
- Test: `server-ts/src/plugins/mcp.test.ts`

**Interfaces:**
- Consumes: T4 `PluginRepository.listEnabled`; T5 `PluginRuntimeStore.mintToken`, `recordInvocation`, `resolveToken` (test).
- Produces:
  - `interface PluginMcpServer { name: string; url: string; transport: 'streamable_http'; headers: Record<string, string>; allowedTools: string[]; installationId: string }`. Its first four fields are exactly D's `EnvelopeMcpServer` (`{ name, url, transport: 'streamable_http' | 'sse', headers }`), so D can append a `PluginMcpServer` without mapping.
  - `pluginMcpServers(deps: { plugins: PluginRepository; runtime: PluginRuntimeStore }, workspaceId: string, ttlMs: number): Promise<PluginMcpServer[]>`
- Handoff to workstream D, which owns the MCP entries in `TaskEnvelope.agent.mcpServers`. D's envelope builder calls `pluginMcpServers(deps, workspaceId, leaseHorizonMs)` and appends the results. D's container MCP client must expose **only** `allowedTools` from each server. G does not edit A's or D's files. The headers carry a plugin token, so the envelope is the only place it travels, matching the spec's "only the envelope carries decrypted env".
- **Open cross-plan dependency. G cannot close this alone.** As written, D's plan neither calls `pluginMcpServers` nor filters tools by `allowedTools`: `EnvelopeMcpServer` has no such field, and A's `mcpServerRefSchema` has none either (its transport enum is `'http' | 'sse'`). Until D adds both, plugin MCP tools never reach agents. That is safe, because nothing unapproved is exposed, but the spec's "surfaced to agents" line is unmet. The coordinator must add a D task covering: (1) append `pluginMcpServers(...)` in the envelope builder; (2) carry `allowedTools` through A's schema, or drop unlisted tools in the container's MCP client; (3) reconcile the transport enum between A (`'http'`) and D (`'streamable_http'`).

- [ ] **Step 1: Write the failing test**

`server-ts/src/plugins/mcp.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from './fixture.test-support.ts';
import { parsePackage } from './manifest.ts';
import { pluginMcpServers } from './mcp.ts';
import { PluginRepository, type PluginInstallation } from './repository.ts';
import { PluginRuntimeStore } from './runtime-store.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('pluginMcpServers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let plugins: PluginRepository;
   let runtime: PluginRuntimeStore;
   let installation: PluginInstallation;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'mcp');
      plugins = new PluginRepository({ sql, sealer: testSealer() });
      runtime = new PluginRuntimeStore({ sql });
      installation = (await sql.begin((tx) =>
         plugins.install(tx, {
            workspaceId: world.workspaceId, installedBy: world.userId, pkg: parsePackage(HELLO),
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         })
      )).installation;
   });
   after(async () => {
      await dropWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a plugin with no approved tools reaches no agent', async () => {
      assert.deepEqual(await pluginMcpServers({ plugins, runtime }, world.workspaceId, 60_000), []);
   });

   test('approved tools are exposed with a working plugin token', async () => {
      await sql.begin((tx) => plugins.setToolApproval(tx, world.workspaceId, installation.id, 'say_hello', true, world.userId));
      const [server] = await pluginMcpServers({ plugins, runtime }, world.workspaceId, 60_000);
      assert.ok(server);
      assert.equal(server.name, 'plugin-hello');
      assert.equal(server.url, 'https://hello.example.com/mcp');
      assert.deepEqual(server.allowedTools, ['say_hello']);
      const token = (server.headers.Authorization ?? '').replace(/^Bearer /, '');
      assert.equal((await runtime.resolveToken(token)).installationId, installation.id);
   });

   test('a disabled plugin reaches no agent', async () => {
      await sql.begin((tx) => plugins.update(tx, world.workspaceId, installation.id, { enabled: false }));
      assert.deepEqual(await pluginMcpServers({ plugins, runtime }, world.workspaceId, 60_000), []);
   });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/mcp.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `mcp.ts`**

```ts
import type { PluginRepository } from './repository.ts';
import type { PluginRuntimeStore } from './runtime-store.ts';

/**
 * A plugin's remote MCP server, as an agent run sees it.
 *
 * Only tools an admin approved are listed, and a plugin with none approved is
 * left out entirely — declaring a tool in a manifest is a request, not a
 * grant. The bearer token is minted per call so it expires with the run it
 * was handed to; `ttlMs` should be that run's lease horizon.
 */

export interface PluginMcpServer {
   name: string;
   url: string;
   transport: 'streamable_http';
   headers: Record<string, string>;
   allowedTools: string[];
   installationId: string;
}

export async function pluginMcpServers(
   deps: { plugins: PluginRepository; runtime: PluginRuntimeStore },
   workspaceId: string,
   ttlMs: number
): Promise<PluginMcpServer[]> {
   const servers: PluginMcpServer[] = [];
   for (const installation of await deps.plugins.listEnabled(workspaceId)) {
      const mcp = installation.manifest.mcp;
      if (!mcp) continue;
      const allowedTools = mcp.tools
         .map((tool) => tool.name)
         .filter((name) => installation.approvedTools.includes(name));
      if (allowedTools.length === 0) continue;
      const { token } = await deps.runtime.mintToken({
         workspaceId,
         installationId: installation.id,
         scopes: installation.grantedScopes,
         ttlMs,
      });
      await deps.runtime.recordInvocation({
         workspaceId, installationId: installation.id, kind: 'mcp', trigger: 'agent-session',
         status: 'ok', httpStatus: null, durationMs: 0, error: null,
      });
      servers.push({
         name: `plugin-${installation.key}`,
         url: installation.manifest.baseUrl.replace(/\/+$/, '') + mcp.path,
         transport: 'streamable_http',
         headers: { Authorization: `Bearer ${token}` },
         allowedTools,
         installationId: installation.id,
      });
   }
   return servers;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/plugins/mcp.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/plugins/mcp.ts server-ts/src/plugins/mcp.test.ts
git commit -m "feat(server-ts): expose approved plugin MCP tools for agent runs"
```

---
### Task 11: `packages/plugin-sdk`: a minimal TypeScript SDK

**Files:**
- Modify: `pnpm-workspace.yaml`, root `package.json` (scripts)
- Create:
  - `packages/plugin-sdk/package.json`, `packages/plugin-sdk/tsconfig.json`, `packages/plugin-sdk/README.md`
  - `packages/plugin-sdk/src/index.ts`, `src/types.ts`, `src/signature.ts`, `src/client.ts`, `src/surface.ts`, `src/handler.ts`
  - `packages/plugin-sdk/examples/hello/berry-plugin.json`
  - `server-ts/src/plugins/sdk-example.test.ts`
- Test: `packages/plugin-sdk/src/signature.test.ts`, `src/client.test.ts`, `src/surface.test.ts`, `src/handler.test.ts`

**Interfaces:**
- Consumes: the wire contracts from T7 (`/v1`), T8 (surface launch fragment) and T9 (hook body and `Berry-Signature`). The SDK does not import server code.
- Produces (`@berry/plugin-sdk`):
  - `type ApiScope`
  - `interface PluginManifest`
  - `interface PluginPackage`
  - `definePlugin(pkg: PluginPackage): PluginPackage`
  - `interface HookRequest`
  - `verifySignature(input: { secret: string; header: string | null; body: string; now?: number; toleranceSeconds?: number }): boolean`
  - `class BerryClient` with `context()`, `getIssue(ref)`, `updateIssue(ref, patch)`, `listComments(ref)`, `createComment(ref, body, parentId?)` and `storage.{get, put, delete, list}`
  - `class BerryApiError { status; code }`
  - `interface SurfaceLaunch { token; expiresAt; apiUrl; workspaceId; installationId }`
  - `readSurfaceLaunch(hash: string): SurfaceLaunch | null`
  - `createHookHandler(options: { signingSecret: string; onEvent?: (req: HookRequest, api: BerryClient) => Promise<void>; onSchedule?: (req: HookRequest, api: BerryClient) => Promise<void> }): (request: Request) => Promise<Response>`

- [ ] **Step 1: Scaffold the workspace**

`pnpm-workspace.yaml`:

```yaml
packages:
   - frontend
   - server-ts
   - packages/plugin-sdk
```

Add these scripts to the root `package.json` after `"reset:server"`:

```json
      "test:plugin-sdk": "pnpm --filter @berry/plugin-sdk test",
      "typecheck:plugin-sdk": "pnpm --filter @berry/plugin-sdk typecheck"
```

`packages/plugin-sdk/package.json`:

```json
{
   "name": "@berry/plugin-sdk",
   "private": true,
   "type": "module",
   "version": "0.1.0",
   "description": "Build Berry plugins: verify hook calls, call the public API, read surface launches.",
   "exports": {
      ".": "./src/index.ts"
   },
   "scripts": {
      "typecheck": "tsc --noEmit",
      "test": "node --test --experimental-strip-types 'src/**/*.test.ts'"
   },
   "devDependencies": {
      "@types/node": "^26.4.0",
      "typescript": "^7.0.2"
   },
   "license": "MIT"
}
```

`packages/plugin-sdk/tsconfig.json`: copy `server-ts/tsconfig.json` verbatim, then change `"lib": ["ES2023"]` to `"lib": ["ES2023", "DOM"]` (the SDK uses `fetch`, `Request`, `Response`, `URLSearchParams`), and change `"include"` to `["src/**/*.ts"]`.

Run: `cd /Users/secret/Code/berry-circle && pnpm install`
Expected: the lockfile gains the `packages/plugin-sdk` importer. No other dependency changes.

- [ ] **Step 2: Write the failing tests**

`packages/plugin-sdk/src/signature.test.ts`:

```ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from './signature.ts';

const sign = (secret: string, t: number, body: string) =>
   `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('a fresh signature over the exact body verifies', () => {
   const now = 1_700_000_000;
   assert.equal(verifySignature({ secret: 's', header: sign('s', now, '{}'), body: '{}', now }), true);
});

test('a wrong secret, altered body, stale timestamp or missing header fails', () => {
   const now = 1_700_000_000;
   assert.equal(verifySignature({ secret: 'x', header: sign('s', now, '{}'), body: '{}', now }), false);
   assert.equal(verifySignature({ secret: 's', header: sign('s', now, '{}'), body: '{ }', now }), false);
   assert.equal(verifySignature({ secret: 's', header: sign('s', now - 600, '{}'), body: '{}', now }), false);
   assert.equal(verifySignature({ secret: 's', header: null, body: '{}', now }), false);
   assert.equal(verifySignature({ secret: 's', header: 'garbage', body: '{}', now }), false);
});
```

`packages/plugin-sdk/src/client.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BerryApiError, BerryClient } from './client.ts';

function recorder(status: number, body: unknown) {
   const calls: { url: string; init: RequestInit }[] = [];
   const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
   };
   return { calls, fetchImpl };
}

test('requests carry the bearer token and hit /v1 paths', async () => {
   const { calls, fetchImpl } = recorder(200, { identifier: 'BER-1' });
   const client = new BerryClient({ apiUrl: 'https://berry.example.com/', token: 'berry_plg_x', fetchImpl });
   await client.getIssue('BER-1');
   await client.updateIssue('BER-1', { title: 'T' });
   await client.storage.put('a/b', { n: 1 });
   assert.equal(calls[0]?.url, 'https://berry.example.com/v1/issues/BER-1');
   assert.equal(new Headers(calls[0]?.init.headers).get('authorization'), 'Bearer berry_plg_x');
   assert.equal(calls[1]?.init.method, 'PATCH');
   assert.equal(calls[1]?.init.body, '{"title":"T"}');
   assert.equal(calls[2]?.url, 'https://berry.example.com/v1/storage/a/b');
   assert.equal(calls[2]?.init.body, '{"value":{"n":1}}');
});

test('a storage miss reads as null; other errors throw with their code', async () => {
   const missing = recorder(404, { error: { code: 'NOT_FOUND', message: 'Storage key not found.' } });
   assert.equal(await new BerryClient({ apiUrl: 'https://b', token: 't', fetchImpl: missing.fetchImpl }).storage.get('k'), null);
   const denied = recorder(403, { error: { code: 'INSUFFICIENT_SCOPE', message: 'no' } });
   await assert.rejects(
      new BerryClient({ apiUrl: 'https://b', token: 't', fetchImpl: denied.fetchImpl }).getIssue('X-1'),
      (error) => error instanceof BerryApiError && error.status === 403 && error.code === 'INSUFFICIENT_SCOPE'
   );
});
```

`packages/plugin-sdk/src/surface.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSurfaceLaunch } from './surface.ts';

test('a launch fragment is read into its fields', () => {
   const hash = '#' + new URLSearchParams({
      token: 'berry_plg_x', expiresAt: '2026-09-10T10:00:00.000Z', apiUrl: 'https://berry.example.com',
      workspaceId: 'w', installationId: 'i',
   }).toString();
   assert.deepEqual(readSurfaceLaunch(hash), {
      token: 'berry_plg_x', expiresAt: '2026-09-10T10:00:00.000Z', apiUrl: 'https://berry.example.com',
      workspaceId: 'w', installationId: 'i',
   });
});

test('a fragment without a plugin token is not a launch', () => {
   assert.equal(readSurfaceLaunch(''), null);
   assert.equal(readSurfaceLaunch('#token=abc'), null);
});
```

`packages/plugin-sdk/src/handler.test.ts`:

```ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createHookHandler } from './handler.ts';
import type { HookRequest } from './types.ts';

const body = JSON.stringify({
   type: 'event', trigger: 'comment.created', pluginKey: 'hello', installationId: 'i', workspaceId: 'w',
   config: {}, secrets: {}, api: { url: 'https://berry.example.com', token: 'berry_plg_x', expiresAt: 'z' },
   event: { id: 'e', type: 'comment.created', occurredAt: 'z', payload: {} },
});
const signed = (secret: string) => {
   const t = Math.floor(Date.now() / 1000);
   return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};

test('a signed event reaches onEvent with a client bound to the call token', async () => {
   let seen: HookRequest | null = null;
   const handle = createHookHandler({ signingSecret: 's', onEvent: async (request) => { seen = request; } });
   const response = await handle(new Request('https://plugin/hooks', {
      method: 'POST', body, headers: { 'Berry-Signature': signed('s') },
   }));
   assert.equal(response.status, 204);
   assert.equal((seen as HookRequest | null)?.trigger, 'comment.created');
});

test('an unsigned or mis-signed call is refused before the handler runs', async () => {
   let ran = false;
   const handle = createHookHandler({ signingSecret: 's', onEvent: async () => { ran = true; } });
   const response = await handle(new Request('https://plugin/hooks', {
      method: 'POST', body, headers: { 'Berry-Signature': signed('other') },
   }));
   assert.equal(response.status, 401);
   assert.equal(ran, false);
});
```

Run: `cd /Users/secret/Code/berry-circle && pnpm test:plugin-sdk`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the SDK**

`packages/plugin-sdk/src/types.ts`:

```ts
/** The shapes Berry sends and accepts. They mirror the server's contract; see docs/api/gateway-v1.md. */

export type ApiScope =
   | 'issues:read'
   | 'issues:write'
   | 'comments:read'
   | 'comments:write'
   | 'storage:read'
   | 'storage:write';

export interface PluginManifest {
   schemaVersion: 1;
   key: string;
   name: string;
   version: string;
   description?: string;
   baseUrl: string;
   scopes?: ApiScope[];
   config?: { key: string; label: string; type: 'string' | 'number' | 'boolean'; required?: boolean }[];
   secrets?: { name: string; description?: string }[];
   hooks?: (
      | { key: string; trigger: 'event'; events: string[]; path: string }
      | { key: string; trigger: 'schedule'; everyMinutes: number; path: string }
   )[];
   surfaces?: { key: string; title: string; path: string }[];
   mcp?: { path: string; tools: { name: string; description?: string }[] };
}

export interface PluginPackage {
   manifest: PluginManifest;
   files?: { path: string; content: string }[];
}

export interface HookRequest {
   type: 'event' | 'schedule';
   trigger: string;
   pluginKey: string;
   installationId: string;
   workspaceId: string;
   config: Record<string, string | number | boolean>;
   secrets: Record<string, string>;
   api: { url: string | null; token: string; expiresAt: string };
   event: { id: string; type: string; occurredAt: string; payload: unknown } | null;
}

/** Typed identity: write a package in TypeScript and serialise it to berry-plugin.json. */
export function definePlugin(pkg: PluginPackage): PluginPackage {
   return pkg;
}
```

`packages/plugin-sdk/src/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'Berry-Signature';

/** Checks `t=<seconds>,v1=<hex>` over the exact body bytes, within a replay window. */
export function verifySignature(input: {
   secret: string;
   header: string | null;
   body: string;
   now?: number;
   toleranceSeconds?: number;
}): boolean {
   if (!input.header) return false;
   const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(input.header);
   if (!match) return false;
   const timestamp = Number(match[1]);
   const now = input.now ?? Math.floor(Date.now() / 1000);
   if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) return false;
   const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest();
   const given = Buffer.from(match[2] ?? '', 'hex');
   return given.length === expected.length && timingSafeEqual(given, expected);
}
```

`packages/plugin-sdk/src/client.ts`:

```ts
/** A small client for Berry's public API (`/v1`). */

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class BerryApiError extends Error {
   override readonly name = 'BerryApiError';
   readonly status: number;
   readonly code: string;
   constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
   }
}

export interface IssuePatch {
   title?: string;
   description?: string | null;
   status?: 'backlog' | 'todo' | 'inProgress' | 'inReview' | 'done' | 'blocked' | 'cancelled';
   priority?: 'none' | 'urgent' | 'high' | 'medium' | 'low';
}

export class BerryClient {
   readonly #base: string;
   readonly #token: string;
   readonly #fetch: FetchLike;

   constructor(options: { apiUrl: string; token: string; fetchImpl?: FetchLike }) {
      this.#base = options.apiUrl.replace(/\/+$/, '');
      this.#token = options.token;
      this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
   }

   context(): Promise<unknown> {
      return this.#json('GET', '/v1/context');
   }

   getIssue(ref: string): Promise<unknown> {
      return this.#json('GET', `/v1/issues/${encodeURIComponent(ref)}`);
   }

   updateIssue(ref: string, patch: IssuePatch): Promise<unknown> {
      return this.#json('PATCH', `/v1/issues/${encodeURIComponent(ref)}`, patch);
   }

   listComments(ref: string): Promise<unknown> {
      return this.#json('GET', `/v1/issues/${encodeURIComponent(ref)}/comments`);
   }

   createComment(ref: string, body: string, parentId?: string): Promise<unknown> {
      return this.#json('POST', `/v1/issues/${encodeURIComponent(ref)}/comments`, parentId ? { body, parentId } : { body });
   }

   readonly storage = {
      get: async (key: string): Promise<unknown> => {
         try {
            return ((await this.#json('GET', `/v1/storage/${storagePath(key)}`)) as { value: unknown }).value;
         } catch (error) {
            if (error instanceof BerryApiError && error.status === 404) return null;
            throw error;
         }
      },
      put: (key: string, value: unknown): Promise<unknown> =>
         this.#json('PUT', `/v1/storage/${storagePath(key)}`, { value }),
      delete: async (key: string): Promise<void> => {
         await this.#json('DELETE', `/v1/storage/${storagePath(key)}`);
      },
      list: (prefix = '', after?: string): Promise<unknown> => {
         const query = new URLSearchParams({ prefix });
         if (after) query.set('after', after);
         return this.#json('GET', `/v1/storage?${query.toString()}`);
      },
   };

   async #json(method: string, path: string, body?: unknown): Promise<unknown> {
      const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.#fetch(`${this.#base}${path}`, {
         method,
         headers,
         ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 204) return undefined;
      const parsed: unknown = await response.json().catch(() => null);
      if (!response.ok) {
         const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
         throw new BerryApiError(response.status, error?.code ?? 'REQUEST_FAILED', error?.message ?? `Berry answered ${response.status}`);
      }
      return parsed;
   }
}

/** Keys may contain '/', which the route keeps; each segment is escaped on its own. */
function storagePath(key: string): string {
   return key.split('/').map(encodeURIComponent).join('/');
}
```

`packages/plugin-sdk/src/surface.ts`:

```ts
export interface SurfaceLaunch {
   token: string;
   expiresAt: string;
   apiUrl: string;
   workspaceId: string;
   installationId: string;
}

/**
 * Reads what Berry put in the iframe URL's fragment. Call it once on load and
 * then clear `location.hash`, so the token does not linger in history.
 */
export function readSurfaceLaunch(hash: string): SurfaceLaunch | null {
   const params = new URLSearchParams(hash.replace(/^#/, ''));
   const token = params.get('token') ?? '';
   if (!token.startsWith('berry_plg_')) return null;
   return {
      token,
      expiresAt: params.get('expiresAt') ?? '',
      apiUrl: params.get('apiUrl') ?? '',
      workspaceId: params.get('workspaceId') ?? '',
      installationId: params.get('installationId') ?? '',
   };
}
```

`packages/plugin-sdk/src/handler.ts`:

```ts
import { BerryClient } from './client.ts';
import { SIGNATURE_HEADER, verifySignature } from './signature.ts';
import type { HookRequest } from './types.ts';

type Hook = (request: HookRequest, api: BerryClient) => Promise<void>;

/**
 * A fetch-style handler for hook calls (works with any server that speaks
 * `Request`/`Response`). The signature is checked over the raw body before
 * anything is parsed. If your hook writes back to Berry, remember Berry will
 * tell you about that write too — skip events you caused.
 */
export function createHookHandler(options: {
   signingSecret: string;
   onEvent?: Hook;
   onSchedule?: Hook;
}): (request: Request) => Promise<Response> {
   return async (request) => {
      const body = await request.text();
      if (!verifySignature({ secret: options.signingSecret, header: request.headers.get(SIGNATURE_HEADER), body })) {
         return new Response('invalid signature', { status: 401 });
      }
      const hook = JSON.parse(body) as HookRequest;
      const api = new BerryClient({ apiUrl: hook.api.url ?? '', token: hook.api.token });
      const handler = hook.type === 'event' ? options.onEvent : options.onSchedule;
      if (handler) await handler(hook, api);
      return new Response(null, { status: 204 });
   };
}
```

`packages/plugin-sdk/src/index.ts`:

```ts
export { BerryApiError, BerryClient, type IssuePatch } from './client.ts';
export { createHookHandler } from './handler.ts';
export { SIGNATURE_HEADER, verifySignature } from './signature.ts';
export { readSurfaceLaunch, type SurfaceLaunch } from './surface.ts';
export { definePlugin, type ApiScope, type HookRequest, type PluginManifest, type PluginPackage } from './types.ts';
```

`packages/plugin-sdk/examples/hello/berry-plugin.json` must contain the exact JSON of `HELLO` from `server-ts/src/plugins/fixture.test-support.ts`: `{ "manifest": { … }, "files": [{ "path": "README.md", "content": "# Hello" }] }`.

`packages/plugin-sdk/README.md`:

````markdown
# @berry/plugin-sdk

Build a Berry plugin: a web service that Berry calls on events and schedules,
that can show pages inside Berry, and that calls back through Berry's public API.

1. **Describe it.** Write `berry-plugin.json` (see `examples/hello`). It lists
   the scopes, settings, secrets, hooks, pages and agent tools the plugin needs.
2. **Install it.** In Berry, open Settings → Plugins. Paste the URL that serves
   the file, or upload it, then review the preview and click Install.
3. **Keep the signing secret.** It is shown once. Put it in your plugin's
   environment, for example as `BERRY_SIGNING_SECRET`.
4. **Handle hooks.** Serve `createHookHandler({ signingSecret, onEvent, onSchedule })`
   at each hook path. It refuses unsigned calls and calls older than five
   minutes. Each call carries a short-lived token, and `api` is a
   `BerryClient` already bound to it.
5. **Show pages.** In the page's script, call `readSurfaceLaunch(location.hash)`,
   clear `location.hash`, then use `new BerryClient({ apiUrl, token })`.

**Write-back loops.** If a hook writes to Berry, for example by commenting on
`comment.created`, Berry tells the plugin about that write too. Skip events
your plugin caused.
````

- [ ] **Step 4: Pin the example against the server schema**

`server-ts/src/plugins/sdk-example.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parsePackage } from './manifest.ts';

test('the SDK example package is a valid package for this server', async () => {
   const raw = await readFile(new URL('../../../packages/plugin-sdk/examples/hello/berry-plugin.json', import.meta.url), 'utf8');
   const pkg = parsePackage(JSON.parse(raw));
   assert.equal(pkg.manifest.key, 'hello');
});
```

- [ ] **Step 5: Run everything**

Run: `cd /Users/secret/Code/berry-circle && pnpm test:plugin-sdk && pnpm typecheck:plugin-sdk && cd server-ts && node --test --experimental-strip-types src/plugins/sdk-example.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml packages/plugin-sdk server-ts/src/plugins/sdk-example.test.ts
git commit -m "feat(plugin-sdk): add a minimal TypeScript SDK for Berry plugins"
```

---
### Task 12: Frontend: plugin client, Plugins settings page (list + install with preview)

**Files:**
- Create: `frontend/lib/plugins.ts`, `frontend/components/common/settings/plugin-config-form.tsx`, `frontend/components/common/settings/plugins-settings.tsx`, `frontend/app/[orgId]/settings/plugins/page.tsx`
- Modify: `frontend/components/layout/sidebar/nav-settings.tsx` (one item)

**Interfaces:**
- Consumes: T8 routes and response shapes; `apiFetch` (`lib/api.ts`), `useSessionStore` (`store/session-store.ts`), `useSettingsResource` (`components/common/settings/use-settings-resource.ts`), and `SettingsShell`, `SettingsSection`, `SettingsCard`, `SettingsRow`, `EnabledDot` (`components/common/settings/shared.tsx`).
- Produces (`lib/plugins.ts`, used by T13):
  - Types: `PluginInstallation`, `PluginPreview`, `PluginInvocation`, `PluginStoredValue`, `PluginConfigField`, `PluginConfigValue`, `PluginSource = { url: string } | { package: unknown }`
  - Loaders:
    - `loadPlugins(ws): Promise<PluginInstallation[]>`
    - `previewPlugin(ws, source): Promise<PluginPreview>`
    - `installPlugin(ws, source, config): Promise<{ installation: PluginInstallation; signingSecret: string }>`
    - `loadPlugin(ws, id): Promise<PluginInstallation & { files: { path: string; size: number }[] }>`
    - `loadPluginInvocations(ws, id): Promise<PluginInvocation[]>`
    - `loadPluginStorage(ws, id): Promise<PluginStoredValue[]>`
  - Mutations:
    - `updatePlugin(ws, id, patch: { enabled?: boolean; config?: Record<string, PluginConfigValue> }): Promise<PluginInstallation>`
    - `uninstallPlugin(ws, id): Promise<void>`
    - `setPluginSecret(ws, id, name, value): Promise<void>`
    - `deletePluginSecret(ws, id, name): Promise<void>`
    - `setPluginTool(ws, id, tool, approved): Promise<PluginInstallation>`
    - `launchPluginSurface(ws, id, surface): Promise<{ url: string; expiresAt: string }>`
  - `PluginConfigForm({ fields, value, onChange, disabled? })` (`plugin-config-form.tsx`)

- [ ] **Step 1: Write `lib/plugins.ts`**

```ts
import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Workspace plugins, as `/api/v1/plugins/{workspaceId}` serves them.
 * Secret values are write-only: the server says whether one is set, never what it is.
 */

const configValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const configFieldSchema = z.object({
   key: z.string(),
   label: z.string(),
   type: z.enum(['string', 'number', 'boolean']),
   required: z.boolean(),
});

const installationSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   key: z.string(),
   name: z.string(),
   version: z.string(),
   description: z.string(),
   source: z.enum(['url', 'upload']),
   sourceUrl: z.string().nullable(),
   enabled: z.boolean(),
   config: z.record(configValueSchema),
   configFields: z.array(configFieldSchema),
   secrets: z.array(z.object({ name: z.string(), description: z.string(), set: z.boolean() })),
   scopes: z.array(z.string()),
   hooks: z.array(
      z.object({
         key: z.string(),
         trigger: z.enum(['event', 'schedule']),
         events: z.array(z.string()).optional(),
         everyMinutes: z.number().optional(),
      })
   ),
   surfaces: z.array(z.object({ key: z.string(), title: z.string() })),
   mcpTools: z.array(z.object({ name: z.string(), description: z.string(), approved: z.boolean() })),
   installedBy: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const previewSchema = z.object({
   key: z.string(),
   name: z.string(),
   version: z.string(),
   description: z.string(),
   baseUrl: z.string(),
   scopes: z.array(z.string()),
   config: z.array(configFieldSchema),
   secrets: z.array(z.object({ name: z.string(), description: z.string() })),
   events: z.array(z.string()),
   schedules: z.array(z.object({ key: z.string(), everyMinutes: z.number() })),
   surfaces: z.array(z.object({ key: z.string(), title: z.string() })),
   mcpTools: z.array(z.string()),
   files: z.array(z.object({ path: z.string(), size: z.number() })),
});

const invocationSchema = z.object({
   id: z.string(),
   kind: z.enum(['event', 'schedule', 'surface', 'mcp']),
   trigger: z.string(),
   status: z.enum(['ok', 'error']),
   httpStatus: z.number().nullable(),
   durationMs: z.number(),
   error: z.string().nullable(),
   createdAt: z.string(),
});

const storedValueSchema = z.object({ key: z.string(), value: z.unknown(), updatedAt: z.string() });

export type PluginConfigValue = z.infer<typeof configValueSchema>;
export type PluginConfigField = z.infer<typeof configFieldSchema>;
export type PluginInstallation = z.infer<typeof installationSchema>;
export type PluginPreview = z.infer<typeof previewSchema>;
export type PluginInvocation = z.infer<typeof invocationSchema>;
export type PluginStoredValue = z.infer<typeof storedValueSchema>;
export type PluginSource = { url: string } | { package: unknown };

const base = (workspaceId: string) => `/api/v1/plugins/${encodeURIComponent(workspaceId)}`;
const one = (workspaceId: string, id: string) =>
   `${base(workspaceId)}/installations/${encodeURIComponent(id)}`;

function parse<T extends z.ZodTypeAny>(schema: T, json: unknown, what: string): z.infer<T> {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} response was not recognized`);
   return parsed.data;
}

export async function loadPlugins(workspaceId: string): Promise<PluginInstallation[]> {
   return parse(
      z.object({ nodes: z.array(installationSchema) }),
      await apiFetch(`${base(workspaceId)}/installations`),
      'Plugins'
   ).nodes;
}

export async function previewPlugin(workspaceId: string, source: PluginSource): Promise<PluginPreview> {
   return parse(
      previewSchema,
      await apiFetch(`${base(workspaceId)}/preview`, { method: 'POST', body: JSON.stringify(source) }),
      'Preview'
   );
}

export async function installPlugin(
   workspaceId: string,
   source: PluginSource,
   config: Record<string, PluginConfigValue>
): Promise<{ installation: PluginInstallation; signingSecret: string }> {
   return parse(
      z.object({ installation: installationSchema, signingSecret: z.string() }),
      await apiFetch(`${base(workspaceId)}/installations`, {
         method: 'POST',
         body: JSON.stringify({ ...source, config }),
      }),
      'Plugin'
   );
}

export async function loadPlugin(
   workspaceId: string,
   id: string
): Promise<PluginInstallation & { files: { path: string; size: number }[] }> {
   return parse(
      installationSchema.extend({ files: z.array(z.object({ path: z.string(), size: z.number() })) }),
      await apiFetch(one(workspaceId, id)),
      'Plugin'
   );
}

export async function updatePlugin(
   workspaceId: string,
   id: string,
   patch: { enabled?: boolean; config?: Record<string, PluginConfigValue> }
): Promise<PluginInstallation> {
   return parse(
      installationSchema,
      await apiFetch(one(workspaceId, id), { method: 'PATCH', body: JSON.stringify(patch) }),
      'Plugin'
   );
}

export async function uninstallPlugin(workspaceId: string, id: string): Promise<void> {
   await apiFetch(one(workspaceId, id), { method: 'DELETE' });
}

export async function setPluginSecret(
   workspaceId: string,
   id: string,
   name: string,
   value: string
): Promise<void> {
   await apiFetch(`${one(workspaceId, id)}/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
   });
}

export async function deletePluginSecret(workspaceId: string, id: string, name: string): Promise<void> {
   await apiFetch(`${one(workspaceId, id)}/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function setPluginTool(
   workspaceId: string,
   id: string,
   tool: string,
   approved: boolean
): Promise<PluginInstallation> {
   return parse(
      installationSchema,
      await apiFetch(`${one(workspaceId, id)}/tools/${encodeURIComponent(tool)}`, {
         method: 'PUT',
         body: JSON.stringify({ approved }),
      }),
      'Plugin'
   );
}

export async function loadPluginInvocations(
   workspaceId: string,
   id: string
): Promise<PluginInvocation[]> {
   return parse(
      z.object({ nodes: z.array(invocationSchema) }),
      await apiFetch(`${one(workspaceId, id)}/invocations?first=50`),
      'Invocations'
   ).nodes;
}

export async function loadPluginStorage(workspaceId: string, id: string): Promise<PluginStoredValue[]> {
   return parse(
      z.object({ nodes: z.array(storedValueSchema) }),
      await apiFetch(`${one(workspaceId, id)}/storage?first=50`),
      'Storage'
   ).nodes;
}

export async function launchPluginSurface(
   workspaceId: string,
   id: string,
   surface: string
): Promise<{ url: string; expiresAt: string }> {
   return parse(
      z.object({ url: z.string(), expiresAt: z.string() }),
      await apiFetch(`${one(workspaceId, id)}/surfaces/${encodeURIComponent(surface)}/launch`, {
         method: 'POST',
      }),
      'Surface'
   );
}
```

- [ ] **Step 2: Write `plugin-config-form.tsx`**

```tsx
'use client';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { PluginConfigField, PluginConfigValue } from '@/lib/plugins';
import { SettingsCard, SettingsRow } from './shared';

/** The settings a plugin declares, as form rows. Shared by install and detail. */
export function PluginConfigForm({
   fields,
   value,
   onChange,
   disabled,
}: {
   fields: PluginConfigField[];
   value: Record<string, PluginConfigValue>;
   onChange: (next: Record<string, PluginConfigValue>) => void;
   disabled?: boolean;
}) {
   if (fields.length === 0) return null;
   const set = (key: string, next: PluginConfigValue) => onChange({ ...value, [key]: next });
   return (
      <SettingsCard>
         {fields.map((field) => (
            <SettingsRow
               key={field.key}
               title={field.required ? `${field.label} *` : field.label}
               trailing={
                  field.type === 'boolean' ? (
                     <Switch
                        checked={value[field.key] === true}
                        disabled={disabled}
                        onCheckedChange={(checked) => set(field.key, checked)}
                     />
                  ) : (
                     <Input
                        className="h-8 w-56"
                        disabled={disabled}
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={String(value[field.key] ?? '')}
                        onChange={(event) =>
                           set(
                              field.key,
                              field.type === 'number' ? Number(event.target.value) : event.target.value
                           )
                        }
                     />
                  )
               }
            />
         ))}
      </SettingsCard>
   );
}
```

- [ ] **Step 3: Write `plugins-settings.tsx`**

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   installPlugin,
   loadPlugins,
   previewPlugin,
   type PluginConfigValue,
   type PluginInstallation,
   type PluginPreview,
   type PluginSource,
} from '@/lib/plugins';
import { useSessionStore } from '@/store/session-store';
import { Loader2, Puzzle } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PluginConfigForm } from './plugin-config-form';
import { EnabledDot, SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace "Plugins": what is installed, and installing another.
 *
 * Installing is two steps on purpose. The preview lists every scope, event,
 * schedule, surface and tool the package asks for before anything is stored,
 * so an admin agrees to a list rather than to a URL.
 */
export default function PluginsSettings() {
   const router = useRouter();
   const { orgId } = useParams<{ orgId: string }>();
   const workspace = useSessionStore((state) => state.workspace);
   const workspaceId = workspace?.id ?? '';
   const plugins = useSettingsResource<PluginInstallation[]>(
      () =>
         workspaceId ? loadPlugins(workspaceId) : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );

   const [url, setUrl] = useState('');
   const [source, setSource] = useState<PluginSource | null>(null);
   const [preview, setPreview] = useState<PluginPreview | null>(null);
   const [config, setConfig] = useState<Record<string, PluginConfigValue>>({});
   const [busy, setBusy] = useState(false);
   const [signingSecret, setSigningSecret] = useState<string | null>(null);

   const runPreview = async (next: PluginSource) => {
      setBusy(true);
      try {
         setPreview(await previewPlugin(workspaceId, next));
         setSource(next);
         setConfig({});
      } catch (cause) {
         setPreview(null);
         toast.error(cause instanceof Error ? cause.message : 'The package could not be read.');
      } finally {
         setBusy(false);
      }
   };

   const onFile = async (file: File | undefined) => {
      if (!file) return;
      try {
         const parsed: unknown = JSON.parse(await file.text());
         await runPreview({ package: parsed });
      } catch {
         toast.error('That file is not a plugin package (berry-plugin.json).');
      }
   };

   const install = async () => {
      if (!source) return;
      setBusy(true);
      try {
         const created = await installPlugin(workspaceId, source, config);
         plugins.set([...(plugins.value ?? []), created.installation]);
         setSigningSecret(created.signingSecret);
         setPreview(null);
         setSource(null);
         setUrl('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The plugin could not be installed.');
      } finally {
         setBusy(false);
      }
   };

   return (
      <SettingsShell title="Plugins" description="Extend this workspace with hooks, pages and agent tools">
         <SettingsSection title="Installed" description={plugins.error ?? undefined}>
            <SettingsCard>
               {plugins.loading ? (
                  <SettingsRow title="Loading…" />
               ) : (plugins.value ?? []).length === 0 ? (
                  <SettingsRow title="No plugins yet" description="Install one below." />
               ) : (
                  (plugins.value ?? []).map((plugin) => (
                     <SettingsRow
                        key={plugin.id}
                        icon={<Puzzle className="size-4" />}
                        title={plugin.name}
                        description={`${plugin.key} · v${plugin.version}`}
                        trailing={plugin.enabled ? <EnabledDot>Enabled</EnabledDot> : 'Disabled'}
                        chevron
                        onClick={() => router.push(`/${orgId}/settings/plugins/${plugin.id}`)}
                     />
                  ))
               )}
            </SettingsCard>
            {signingSecret ? (
               <div className="mt-2 rounded-md border border-status-warning/40 bg-container px-4 py-3">
                  <p className="font-medium">
                     Signing secret — give it to the plugin now. It is not shown again.
                  </p>
                  <code className="mt-1.5 block break-all font-mono text-muted-foreground">
                     {signingSecret}
                  </code>
                  <Button
                     size="xs"
                     variant="ghost"
                     className="mt-2 -ml-2"
                     onClick={() => {
                        void navigator.clipboard?.writeText(signingSecret);
                        setSigningSecret(null);
                     }}
                  >
                     Copy and dismiss
                  </Button>
               </div>
            ) : null}
         </SettingsSection>

         <SettingsSection
            title="Install a plugin"
            description="From a URL that serves berry-plugin.json, or by uploading the file"
         >
            <SettingsCard>
               <SettingsRow
                  title="From a URL"
                  trailing={
                     <span className="flex items-center gap-2">
                        <Input
                           value={url}
                           placeholder="https://…/berry-plugin.json"
                           className="h-8 w-64"
                           onChange={(event) => setUrl(event.target.value)}
                        />
                        <Button
                           size="xs"
                           variant="ghost"
                           disabled={busy || url.trim() === ''}
                           onClick={() => void runPreview({ url: url.trim() })}
                        >
                           Preview
                        </Button>
                     </span>
                  }
               />
               <SettingsRow
                  title="Upload a package"
                  trailing={
                     <Input
                        type="file"
                        accept=".json,application/json"
                        className="h-8 w-64"
                        disabled={busy}
                        onChange={(event) => void onFile(event.target.files?.[0])}
                     />
                  }
               />
            </SettingsCard>
         </SettingsSection>

         {preview ? (
            <SettingsSection
               title={`${preview.name} v${preview.version}`}
               description={preview.description || preview.baseUrl}
               action={
                  <Button size="sm" disabled={busy} onClick={() => void install()}>
                     {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Install'}
                  </Button>
               }
            >
               <SettingsCard>
                  <SettingsRow title="Calls" description={preview.baseUrl} />
                  <SettingsRow
                     title="Access to this workspace"
                     description={preview.scopes.length ? preview.scopes.join(', ') : 'None'}
                  />
                  <SettingsRow
                     title="Notified about"
                     description={preview.events.length ? preview.events.join(', ') : 'No events'}
                  />
                  <SettingsRow
                     title="Runs on a schedule"
                     description={
                        preview.schedules.length
                           ? preview.schedules.map((s) => `${s.key} every ${s.everyMinutes} min`).join(', ')
                           : 'No'
                     }
                  />
                  <SettingsRow
                     title="Pages"
                     description={preview.surfaces.map((s) => s.title).join(', ') || 'None'}
                  />
                  <SettingsRow
                     title="Agent tools (each needs approval after install)"
                     description={preview.mcpTools.join(', ') || 'None'}
                  />
                  <SettingsRow
                     title="Secrets it will ask for"
                     description={preview.secrets.map((s) => s.name).join(', ') || 'None'}
                  />
                  <SettingsRow
                     title="Files"
                     description={preview.files.map((f) => f.path).join(', ') || 'None'}
                  />
               </SettingsCard>
               <PluginConfigForm fields={preview.config} value={config} onChange={setConfig} disabled={busy} />
            </SettingsSection>
         ) : null}
      </SettingsShell>
   );
}
```

- [ ] **Step 4: Add the page and the nav item**

`frontend/app/[orgId]/settings/plugins/page.tsx`:

```tsx
import PluginsSettings from '@/components/common/settings/plugins-settings';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function PluginsSettingsPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <PluginsSettings />
      </MainLayout>
   );
}
```

In `frontend/components/layout/sidebar/nav-settings.tsx`, add `Puzzle` to the `lucide-react` import. In the `settingsNav` group that contains `{ name: 'integrations', url: '/settings/integrations', … }` (the `workspace` group after workstream I's rewrite), append after the integrations item:

```ts
         { name: 'plugins', url: '/settings/plugins', icon: Puzzle },
```

- [ ] **Step 5: Lint and build**

Run: `cd /Users/secret/Code/berry-circle && pnpm --filter berry-frontend exec prettier --write lib/plugins.ts components/common/settings/plugin-config-form.tsx components/common/settings/plugins-settings.tsx 'app/[orgId]/settings/plugins/page.tsx' components/layout/sidebar/nav-settings.tsx && pnpm lint:frontend && pnpm build:frontend`
Expected: lint clean, build succeeds. If `Button` has no `size="sm"`, use `size="xs"` (both appear in `components/ui/button.tsx`; check its variants).

- [ ] **Step 6: Verify manually**

Run the stack (`pnpm dev:server`, `pnpm dev:frontend`) with `INTEGRATION_ENCRYPTION_KEY` set. Open `/{orgId}/settings/plugins`, upload `packages/plugin-sdk/examples/hello/berry-plugin.json`, check that the preview lists the scopes, events and tools, set Greeting, click Install, and confirm the signing secret appears once and the row appears in Installed.

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/plugins.ts frontend/components/common/settings/plugin-config-form.tsx frontend/components/common/settings/plugins-settings.tsx 'frontend/app/[orgId]/settings/plugins/page.tsx' frontend/components/layout/sidebar/nav-settings.tsx
git commit -m "feat(frontend): list and install workspace plugins with a preview"
```

---
### Task 13: Frontend: plugin detail page and surface launcher

**Files:**
- Create: `frontend/components/common/settings/plugin-detail.tsx`, `frontend/app/[orgId]/settings/plugins/[pluginId]/page.tsx`, `frontend/components/common/plugins/plugin-surface.tsx`, `frontend/app/[orgId]/plugins/[pluginId]/[surface]/page.tsx`

**Interfaces:**
- Consumes: T12 `lib/plugins.ts` (all functions and types) and `PluginConfigForm`; `useSettingsResource`, the shared settings components, `useSessionStore`.
- Produces:
  - Route `/{orgId}/settings/plugins/{pluginId}`, which shows status and an enable switch, config, secrets (set and clear, write-only), agent tool approvals, pages, the hooks list, recent invocations, stored keys, and uninstall.
  - Route `/{orgId}/plugins/{pluginId}/{surface}`, which renders the plugin page in a sandboxed iframe.

- [ ] **Step 1: Write `plugin-detail.tsx`**

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
   deletePluginSecret,
   loadPlugin,
   loadPluginInvocations,
   loadPluginStorage,
   setPluginSecret,
   setPluginTool,
   uninstallPlugin,
   updatePlugin,
   type PluginConfigValue,
   type PluginInstallation,
   type PluginInvocation,
   type PluginStoredValue,
} from '@/lib/plugins';
import { useSessionStore } from '@/store/session-store';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PluginConfigForm } from './plugin-config-form';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

type Detail = PluginInstallation & { files: { path: string; size: number }[] };

/** One installed plugin: everything an admin can change about it, and what it has been doing. */
export default function PluginDetail() {
   const router = useRouter();
   const { orgId, pluginId } = useParams<{ orgId: string; pluginId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const need = <T,>(work: () => Promise<T>) =>
      workspaceId ? work() : Promise.reject(new Error('No workspace is selected.'));

   const plugin = useSettingsResource<Detail>(() => need(() => loadPlugin(workspaceId, pluginId)), [
      workspaceId,
      pluginId,
   ]);
   const invocations = useSettingsResource<PluginInvocation[]>(
      () => need(() => loadPluginInvocations(workspaceId, pluginId)),
      [workspaceId, pluginId]
   );
   const storage = useSettingsResource<PluginStoredValue[]>(
      () => need(() => loadPluginStorage(workspaceId, pluginId)),
      [workspaceId, pluginId]
   );

   const [config, setConfig] = useState<Record<string, PluginConfigValue>>({});
   const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
   useEffect(() => {
      if (plugin.value) setConfig(plugin.value.config);
   }, [plugin.value]);

   const current = plugin.value;
   if (!current) {
      return <SettingsShell title="Plugin" description={plugin.error ?? 'Loading…'}>{null}</SettingsShell>;
   }

   const keep = (next: PluginInstallation): Detail => ({ ...next, files: current.files });

   const toggle = (enabled: boolean) =>
      plugin.mutate({ ...current, enabled }, async () => keep(await updatePlugin(workspaceId, pluginId, { enabled })));

   const saveConfig = () =>
      plugin.mutate({ ...current, config }, async () => keep(await updatePlugin(workspaceId, pluginId, { config })));

   const saveSecret = async (name: string) => {
      const value = secretDrafts[name]?.trim() ?? '';
      if (value === '') return;
      const secrets = current.secrets.map((s) => (s.name === name ? { ...s, set: true } : s));
      const ok = await plugin.mutate({ ...current, secrets }, () => setPluginSecret(workspaceId, pluginId, name, value));
      if (ok) setSecretDrafts((drafts) => ({ ...drafts, [name]: '' }));
   };

   const clearSecret = (name: string) => {
      const secrets = current.secrets.map((s) => (s.name === name ? { ...s, set: false } : s));
      return plugin.mutate({ ...current, secrets }, () => deletePluginSecret(workspaceId, pluginId, name));
   };

   const approve = (tool: string, approved: boolean) => {
      const mcpTools = current.mcpTools.map((t) => (t.name === tool ? { ...t, approved } : t));
      return plugin.mutate({ ...current, mcpTools }, async () =>
         keep(await setPluginTool(workspaceId, pluginId, tool, approved))
      );
   };

   const uninstall = async () => {
      if (!window.confirm(`Uninstall ${current.name}? Its settings, secrets and storage are deleted.`)) return;
      try {
         await uninstallPlugin(workspaceId, pluginId);
         router.push(`/${orgId}/settings/plugins`);
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The plugin could not be uninstalled.');
      }
   };

   return (
      <SettingsShell
         title={current.name}
         description={`${current.key} · v${current.version}${current.description ? ` · ${current.description}` : ''}`}
      >
         <SettingsSection title="Status">
            <SettingsCard>
               <SettingsRow
                  title="Enabled"
                  description="A disabled plugin receives no calls and its tokens stop working."
                  trailing={
                     <Switch checked={current.enabled} disabled={plugin.saving} onCheckedChange={(v) => void toggle(v)} />
                  }
               />
               <SettingsRow title="Access" description={current.scopes.join(', ') || 'None'} />
               <SettingsRow
                  title="Installed from"
                  description={current.source === 'url' ? current.sourceUrl : 'Uploaded package'}
               />
            </SettingsCard>
         </SettingsSection>

         {current.configFields.length > 0 ? (
            <SettingsSection
               title="Settings"
               action={
                  <Button size="xs" variant="ghost" disabled={plugin.saving} onClick={() => void saveConfig()}>
                     Save
                  </Button>
               }
            >
               <PluginConfigForm
                  fields={current.configFields}
                  value={config}
                  onChange={setConfig}
                  disabled={plugin.saving}
               />
            </SettingsSection>
         ) : null}

         {current.secrets.length > 0 ? (
            <SettingsSection title="Secrets" description="Stored encrypted and sent only to the plugin">
               <SettingsCard>
                  {current.secrets.map((secret) => (
                     <SettingsRow
                        key={secret.name}
                        title={secret.name}
                        description={secret.set ? 'Set' : secret.description || 'Not set'}
                        trailing={
                           <span className="flex items-center gap-2">
                              <Input
                                 type="password"
                                 autoComplete="off"
                                 className="h-8 w-44"
                                 placeholder={secret.set ? 'Replace…' : 'Value'}
                                 value={secretDrafts[secret.name] ?? ''}
                                 onChange={(event) =>
                                    setSecretDrafts((drafts) => ({ ...drafts, [secret.name]: event.target.value }))
                                 }
                              />
                              <Button size="xs" variant="ghost" onClick={() => void saveSecret(secret.name)}>
                                 Save
                              </Button>
                              {secret.set ? (
                                 <Button size="xs" variant="ghost" onClick={() => void clearSecret(secret.name)}>
                                    Clear
                                 </Button>
                              ) : null}
                           </span>
                        }
                     />
                  ))}
               </SettingsCard>
            </SettingsSection>
         ) : null}

         {current.mcpTools.length > 0 ? (
            <SettingsSection title="Agent tools" description="Agents can use only the tools approved here">
               <SettingsCard>
                  {current.mcpTools.map((tool) => (
                     <SettingsRow
                        key={tool.name}
                        title={tool.name}
                        description={tool.description || undefined}
                        trailing={
                           <Switch
                              checked={tool.approved}
                              disabled={plugin.saving}
                              onCheckedChange={(v) => void approve(tool.name, v)}
                           />
                        }
                     />
                  ))}
               </SettingsCard>
            </SettingsSection>
         ) : null}

         {current.surfaces.length > 0 ? (
            <SettingsSection title="Pages">
               <SettingsCard>
                  {current.surfaces.map((surface) => (
                     <SettingsRow
                        key={surface.key}
                        title={surface.title}
                        trailing={
                           <Link
                              href={`/${orgId}/plugins/${pluginId}/${surface.key}`}
                              className="inline-flex items-center gap-1 hover:underline"
                           >
                              Open <ExternalLink className="size-3.5" />
                           </Link>
                        }
                     />
                  ))}
               </SettingsCard>
            </SettingsSection>
         ) : null}

         <SettingsSection title="Hooks">
            <SettingsCard>
               {current.hooks.length === 0 ? (
                  <SettingsRow title="None" />
               ) : (
                  current.hooks.map((hook) => (
                     <SettingsRow
                        key={hook.key}
                        title={hook.key}
                        description={
                           hook.trigger === 'event'
                              ? `On ${(hook.events ?? []).join(', ')}`
                              : `Every ${hook.everyMinutes ?? 0} minutes`
                        }
                     />
                  ))
               )}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection
            title="Recent calls"
            description={invocations.error ?? undefined}
            action={
               <Button size="xs" variant="ghost" onClick={() => invocations.reload()}>
                  Refresh
               </Button>
            }
         >
            <SettingsCard>
               {(invocations.value ?? []).length === 0 ? (
                  <SettingsRow title={invocations.loading ? 'Loading…' : 'No calls yet'} />
               ) : (
                  (invocations.value ?? []).map((call) => (
                     <SettingsRow
                        key={call.id}
                        muted={call.status === 'error'}
                        title={`${call.kind} · ${call.trigger}`}
                        description={[
                           new Date(call.createdAt).toLocaleString(),
                           call.httpStatus === null ? null : `HTTP ${call.httpStatus}`,
                           `${call.durationMs} ms`,
                           call.error,
                        ]
                           .filter(Boolean)
                           .join(' · ')}
                        trailing={call.status === 'ok' ? 'OK' : 'Failed'}
                     />
                  ))
               )}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title="Stored data" description={storage.error ?? 'Keys this plugin has saved'}>
            <SettingsCard>
               {(storage.value ?? []).length === 0 ? (
                  <SettingsRow title={storage.loading ? 'Loading…' : 'Nothing stored'} />
               ) : (
                  (storage.value ?? []).map((entry) => (
                     <SettingsRow
                        key={entry.key}
                        title={<code className="font-mono">{entry.key}</code>}
                        description={JSON.stringify(entry.value).slice(0, 160)}
                     />
                  ))
               )}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title="Danger zone">
            <SettingsCard>
               <SettingsRow
                  title="Uninstall"
                  description="Deletes its settings, secrets, storage and history."
                  trailing={
                     <Button
                        size="xs"
                        variant="ghost"
                        className="text-status-danger hover:text-status-danger"
                        onClick={() => void uninstall()}
                     >
                        Uninstall
                     </Button>
                  }
               />
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
```

`current` is narrowed, so the closures that capture it are type-safe. If ESLint's `react-hooks/rules-of-hooks` flags the early return, it doesn't apply: every hook is called before the return.

- [ ] **Step 2: Write `plugin-surface.tsx`**

```tsx
'use client';

import { launchPluginSurface } from '@/lib/plugins';
import { useSessionStore } from '@/store/session-store';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * A plugin's page, in an iframe on the plugin's own origin.
 *
 * The launch URL carries a short-lived plugin token in its fragment, which the
 * plugin reads with the SDK's `readSurfaceLaunch`. The frame runs on another
 * origin, so `allow-same-origin` gives it its own origin's storage and never
 * Berry's. No referrer is sent, so the Berry URL does not leak to the plugin
 * host either.
 */
export default function PluginSurface() {
   const { pluginId, surface } = useParams<{ pluginId: string; surface: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [src, setSrc] = useState<string | null>(null);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      launchPluginSurface(workspaceId, pluginId, surface)
         .then((launched) => {
            if (!cancelled) setSrc(launched.url);
         })
         .catch((cause: unknown) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : 'This page could not be opened.');
         });
      return () => {
         cancelled = true;
      };
   }, [workspaceId, pluginId, surface]);

   if (error) return <p className="p-6 text-muted-foreground">{error}</p>;
   if (!src) return <p className="p-6 text-muted-foreground">Opening…</p>;
   return (
      <iframe
         title="Plugin page"
         src={src}
         className="h-full w-full border-0"
         sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
         referrerPolicy="no-referrer"
      />
   );
}
```

- [ ] **Step 3: Add the pages**

`frontend/app/[orgId]/settings/plugins/[pluginId]/page.tsx`:

```tsx
import PluginDetail from '@/components/common/settings/plugin-detail';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function PluginDetailPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <PluginDetail />
      </MainLayout>
   );
}
```

`frontend/app/[orgId]/plugins/[pluginId]/[surface]/page.tsx`:

```tsx
import PluginSurface from '@/components/common/plugins/plugin-surface';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function PluginSurfacePage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <div className="h-full min-h-0 overflow-hidden">
            <PluginSurface />
         </div>
      </MainLayout>
   );
}
```

- [ ] **Step 4: Lint and build**

Run: `cd /Users/secret/Code/berry-circle && pnpm --filter berry-frontend exec prettier --write components/common/settings/plugin-detail.tsx components/common/plugins/plugin-surface.tsx 'app/[orgId]/settings/plugins/[pluginId]/page.tsx' 'app/[orgId]/plugins/[pluginId]/[surface]/page.tsx' && pnpm lint:frontend && pnpm build:frontend`
Expected: lint clean, build succeeds.

- [ ] **Step 5: Verify manually**

With the plugin from T12 installed:
1. Open its row and toggle Enabled.
2. Save a Greeting, and set and clear `API_KEY`. The value never reappears.
3. Approve `say_hello`.
4. Click Open on "Hello panel". The iframe requests `https://hello.example.com/ui#token=…`; a failed load is expected for the example host.
5. Recent calls shows a `surface · panel` row.
6. Uninstall. You return to the list.

- [ ] **Step 6: Commit**

```bash
git add frontend/components/common/settings/plugin-detail.tsx frontend/components/common/plugins/plugin-surface.tsx 'frontend/app/[orgId]/settings/plugins/[pluginId]/page.tsx' 'frontend/app/[orgId]/plugins/[pluginId]/[surface]/page.tsx'
git commit -m "feat(frontend): manage a plugin and open its pages"
```

---
### Task 14: Frontend: scopes on personal API keys

**Files:**
- Modify: `frontend/lib/settings.ts` (`tokenSchema`, `createToken`), `frontend/components/common/settings/account-security.tsx`

**Interfaces:**
- Consumes: T6 `POST /api/v1/tokens` `scopes` field and the `scopes` response field.
- Produces:
  - `API_SCOPES` (frontend copy): `['issues:read', 'issues:write', 'comments:read', 'comments:write']`. Storage scopes are omitted because they are plugin-only.
  - `createToken(name: string, scopes: string[] | null)`
  - `PersonalToken.scopes: string[] | null`

- [ ] **Step 1: Extend `lib/settings.ts`**

In `tokenSchema`, add as the last field:

```ts
   /** Public API scopes; null means every scope (keys made before scopes existed). */
   scopes: z.array(z.string()).nullish(),
```

Directly above `export async function createToken`, add:

```ts
/** The public API scopes a personal key can hold. Storage belongs to plugins only. */
export const API_SCOPES = ['issues:read', 'issues:write', 'comments:read', 'comments:write'] as const;
```

Change the signature and body of `createToken`:

```ts
export async function createToken(
   name: string,
   scopes: string[] | null = null
): Promise<{ secret: string | null; record: PersonalToken }> {
   const json: unknown = await apiFetch('/api/v1/tokens', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(scopes === null ? { name } : { name, scopes }),
   });
```

Leave the rest of the function unchanged.

- [ ] **Step 2: Add scope choice to `account-security.tsx`**

1. Import `Checkbox` from `@/components/ui/checkbox` and `API_SCOPES` from `@/lib/settings`.
2. Add state `const [scopes, setScopes] = useState<string[] | null>(null);`. Here `null` means "full access".
3. In `create`, call `createToken(trimmed, scopes)`, and after success also call `setScopes(null)`.
4. In each token row, change `description` to append the scopes:

```tsx
                     description={`${token.prefix}… · ${
                        token.scopes ? token.scopes.join(', ') : 'full access'
                     } · ${token.lastUsedAt ? `last used ${when(token.lastUsedAt)}` : 'never used'}`}
```

5. After the "New key" `SettingsRow` and before `</SettingsCard>`, add:

```tsx
               <SettingsRow
                  title="Access"
                  description={
                     scopes === null
                        ? 'Full access, like signing in as you'
                        : 'Only the public API scopes ticked here'
                  }
                  trailing={
                     <span className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-1.5">
                           <Checkbox
                              checked={scopes === null}
                              onCheckedChange={(checked) => setScopes(checked === true ? null : [])}
                           />
                           full
                        </label>
                        {API_SCOPES.map((scope) => (
                           <label key={scope} className="flex items-center gap-1.5">
                              <Checkbox
                                 disabled={scopes === null}
                                 checked={scopes?.includes(scope) ?? false}
                                 onCheckedChange={(checked) =>
                                    setScopes((current) => {
                                       const list = (current ?? []).filter((entry) => entry !== scope);
                                       return checked === true ? [...list, scope] : list;
                                    })
                                 }
                              />
                              {scope}
                           </label>
                        ))}
                     </span>
                  }
               />
```

With an empty list the key can only call `/v1/context`. That is allowed and intended.

- [ ] **Step 3: Lint and build**

Run: `cd /Users/secret/Code/berry-circle && pnpm --filter berry-frontend exec prettier --write lib/settings.ts components/common/settings/account-security.tsx && pnpm lint:frontend && pnpm build:frontend`
Expected: lint clean, build succeeds.

- [ ] **Step 4: Verify manually**

In Settings → Security & access, untick "full", tick `issues:read`, and create a key. The row should read `issues:read`. Then check the key against the API: `curl -H "Authorization: Bearer <key>" http://127.0.0.1:4000/v1/issues/<IDENT>` → 200, and a `PATCH` → 403 `INSUFFICIENT_SCOPE`.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/settings.ts frontend/components/common/settings/account-security.tsx
git commit -m "feat(frontend): choose public API scopes for personal keys"
```

---

## Final verification (after all tasks)

```bash
cd /Users/secret/Code/berry-circle
pnpm typecheck:server && pnpm test:server          # with BERRY_TEST_DATABASE_URL exported
pnpm typecheck:plugin-sdk && pnpm test:plugin-sdk
pnpm lint:frontend && pnpm build:frontend
cd server-ts && grep -rhoE "prefix: '/[^']+'" src/mounts/*.ts | sort -u   # includes /v1 and /api/v1/plugins
```

## Self-review

**Spec §8 coverage**

| Spec requirement | Task(s) |
|---|---|
| `/v1/context` | T7 |
| `/v1/issues/:ref` GET, PATCH | T7 |
| `/v1/issues/:ref/comments` | T7 |
| `/v1/storage/*` scoped key/value | T5 (store), T7 (routes) |
| Personal access tokens with scopes | T1 (column), T6 (server), T14 (UI) |
| Plugin tokens with scopes | T2, T5, T6 |
| Install from a package, by remote URL or upload, with a preview | T3, T8, T12 |
| Config, enable, disable, uninstall | T4, T8, T12, T13 |
| Sealed secrets | T4 (`sealing.ts`), T8, T13 |
| Storage | T5, T7, T13 (admin view) |
| Invocations log | T5, T8, T9, T13 |
| Event-triggered and scheduled hooks | T9 |
| Surfaces: iframe launched with a signed token | T8 (launch), T13 (iframe), T11 (`readSurfaceLaunch`) |
| Remote MCP from a plugin, with an admin tool-approval list | T4 (approvals), T8/T13 (UI), T10 (`pluginMcpServers` for D). **Partially open:** delivery into the envelope and `allowedTools` enforcement need a D task (see T10) |
| Minimal TypeScript SDK in `packages/plugin-sdk` | T11 |

**§11 coverage**
- `workspace_id` is on every table (T1).
- Both mounts are gated and covered by `plugins.cross-tenant.test.ts` (T8).
- Secrets go only through `sealing.ts` and are never serialized (T4, T8 test asserts it).
- Realtime uses the `plugin.*` outbox topics (T4).
- `node --test` covers every repository and mount.
- The frontend is gated by lint and build.

**Type consistency.** These names are the same in every task:
- `PluginInstallation.grantedScopes`, `PluginPrincipal.installedBy`, `mintToken({ workspaceId, installationId, scopes, ttlMs })`
- `recordInvocation({ workspaceId, installationId, kind, trigger, status, httpStatus, durationMs, error })`
- `loadPackage(net, source)`, `readJson(context, schema, maxBytes?)`, `requireScope` / `requirePlugin` / `actorId`

`HELLO` lives in `fixture.test-support.ts` from T3 onward.

**Known limits, stated in code comments.**
- Event hooks are delivered at most once, with a 2-second read lag.
- A plugin writing on the event it was notified about sees its own write.
- DNS rebinding between check and connect is narrowed by the timeout, not closed.
- Surfaces are remote pages only. Berry never serves plugin files as HTML.
- A plugin acts as its installer and never beyond the installer's membership. A surface token is further narrowed to the launching member's role.
- An event hook's payload is shared only when the plugin holds the matching read scope (`issue.*` needs `issues:read`, `comment.*` needs `comments:read`). Otherwise the plugin gets only id, type and time.
- SSRF: resolved addresses are checked, including IPv4 hidden in IPv6 (mapped, compatible, NAT64, 6to4, in both dotted and hex form).

**Review fixes applied (adversarial pass, 2026-09-10).**
- `HELLO` is defined once, in the fixture.
- An SSRF bypass through `[::ffff:a00:1]` is closed.
- The flaky invocation-order test now uses an explicit clock.
- Credentials are J-compatible: `personalTokenResolver` and `testSessions`, replacing the removed `SessionService.resolvePersonalToken` and `sessionTtlMs`.
- `/v1` comment writes check `comments.write`.
- A viewer can no longer get write scopes through a surface launch.
- Event payloads are gated by scope.
- The MCP transport matches D.
- `outbox_events (occurred_at, id)` gained an index.
- Cross-tenant coverage now reaches storage, invocations, tools, secret delete, preview and install on a foreign workspace.

**Review fixes applied (second adversarial pass, 2026-09-10).**
- Every `createPersonalToken` call in the tests (T6, T7, T8 and the cross-tenant test) passed a fingerprint shorter than 32 bytes, which fails the table's `octet_length(request_fingerprint) = 32` CHECK. They now use `Buffer.alloc(32, …)`.
- The T7 storage test could never pass. Its plugin token asked for storage scopes, but HELLO was never granted any, and `resolveToken` intersects the two. T7 now installs HELLO with storage scopes granted.
- The hook runner read every `outbox_events` topic, including `run.output.delta`, 100 rows per 5 s tick. Under run traffic the cursor fell behind without bound. It now reads only subscribed topics and jumps to the lag horizon when a batch is not full.
- Cross-tenant test (e): U1 reading, patching and commenting on a W2 issue through `/v1` answers 404, and W2 is unchanged.
- `/v1` is proxied by `frontend/next.config.ts`, so it is reachable whichever origin `BERRY_PUBLIC_URL` names.
- The signing-secret one-time display is documented as the one bounded exception to "secrets never reach the browser".
- The SDK README is written out in full.
