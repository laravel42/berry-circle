# Parity H — Locales Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Berry's web UI renders in en, zh-Hans, ja or ko through `next-intl` message catalogues, and each user's choice is stored as a locale preference in their account settings.

**Architecture:** The locale is one more key in the existing `users.settings` jsonb, which `GET/PATCH /api/v1/me/settings` and `/me/bootstrap` already serve. No migration is needed, so H's migration block (140–149) stays unused. The frontend uses `next-intl` **without locale routing**: `frontend/i18n/request.ts` resolves the locale from a `berry_locale` cookie, falling back to `Accept-Language` and then `en`. Messages are split into one JSON file per namespace per locale, so parallel tasks never edit the same file. After bootstrap, the client copies the account's locale into the cookie and calls `router.refresh()` so a second device opens in the same language.

**Tech Stack:** Server: Node 22 `--experimental-strip-types`, Hono, postgres.js, `node --test`. Frontend: Next.js 15.2 App Router, React 19, `next-intl` ^4.14.3, Zod v3, zustand, Prettier (3-space, single quotes).

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` §9 (Locales only). §11 and §13 hold the cross-cutting gates.

## Global Constraints

- Scope is **locales only**. Billing and payments are out of scope by user decision: no Stripe, no seats, no credits, no entitlements, no billing page. Ignore any contract line about credit drawdown or `task_usage`.
- The locales are exactly `en`, `zh-Hans`, `ja`, `ko`, and `en` is the default and fallback.
- Library: `next-intl` message catalogues. The locale preference lives in settings.
- Server: no emitted TS syntax (no enums, namespaces or parameter properties), `.ts` import extensions, relative imports, 3-space indent, single quotes, Zod v4 if Zod is used. Tests are `node --test`, co-located as `*.test.ts`. DB tests skip without `BERRY_TEST_DATABASE_URL`.
- Frontend: Prettier 3-space, single quotes, `@/*` alias, Zod v3 (`^3.24.2`), no `any`, no `!`. Gates are `pnpm lint:frontend` and `pnpm build:frontend`. No `text-*` font-size utilities (ESLint rule).
- Migration block for H is 140–149. This plan uses **none**, because `users.settings` is already jsonb.
- Clean-room: never copy multica source, schema text, copy or UI. All strings below are Berry's own wording. Web only. No new integrations.
- Realtime: none is needed. If an event were added it would go through `outbox_events` + SSE, never WebSocket.
- Wire shape: `/api/v1/me/settings` gains one additive field `locale`. Existing fields keep their order: `theme`, `timezone`, `reducedMotion`, then `locale`.
- Commits: `type(scope): imperative summary`, with scope `server-ts` or `frontend`. Do not commit in this planning session. Executors commit per task.
- Ownership: each catalogue namespace file is owned by exactly one task (see File Structure). Never edit another task's namespace.

---

## File Structure

**Server (`server-ts/`)**
- Modify `src/http/validation.ts`: add `LOCALES` and `validLocale()`.
- Modify `src/http/validation.test.ts`: add the locale validation test.
- Modify `src/identity/repository.ts`: add `locale` to `UserSettings`, default it in `toSettings`.
- Modify `src/mounts/me.ts`: `PATCH /settings` accepts `locale`, and `serializeSettings` emits it.
- Create `src/mounts/me.settings.test.ts`: a DB-gated mount test for the locale round trip.

**Frontend (`frontend/`)**
- Create `lib/i18n/locales.ts`: locale list, cookie name, namespaces, `resolveLocale` (pure, importable from server and client).
- Create `lib/i18n/client-locale.ts`: browser cookie read and write.
- Create `i18n/request.ts`: next-intl request config, which merges the namespace files.
- Create `i18n/messages-en.ts`: the typed English message tree, the type source for `AppConfig`.
- Create `global.d.ts`: the `next-intl` `AppConfig` augmentation (compile-time key checking in `next build`).
- Modify `next.config.ts`: wrap with `createNextIntlPlugin('./i18n/request.ts')`.
- Modify `app/layout.tsx`: async, `NextIntlClientProvider`, `<html lang={locale}>`.
- Create `messages/{en,zh-Hans,ja,ko}/{common,shell,settings,tasks,projects,goals,reviews,agents,runtimes}.json`.
- Create `../scripts/check-locale-catalogues.py`: a parity check that runs as a repository check.
- Modify `lib/settings.ts` and `lib/auth.ts`: add `locale` to the Zod schemas.
- Modify `store/session-store.ts`: add `preferredLocale` and `setPreferredLocale`.
- Create `components/layout/locale-sync.tsx`: aligns the cookie with the account after bootstrap.
- Modify `components/layout/session-gate.tsx`: mount `LocaleSync`.
- Modify `components/common/settings/shared.tsx`: `SelectMenu` gains an optional `labels` prop.
- Modify `components/common/settings/preferences.tsx`: Language row, and strings extracted.
- Modify `components/layout/headers/settings/header-nav.tsx`.
- Modify `components/layout/shell/shell-routes.ts`, `shell-rail.tsx`, `shell-tabs.tsx`.
- Modify the rail page chrome and list bodies: `headers/my-issues/header.tsx`, `headers/projects/header-nav.tsx`, `common/projects/projects.tsx`, `headers/goals/header.tsx`, `common/goals/goals.tsx`, `common/reviews/reviews.tsx`, `headers/agents/header-nav.tsx`, `headers/agents/header-options.tsx`, `common/agents/agents.tsx`, `headers/runs/header.tsx`, `common/runs/run-overview.tsx`.

**Namespace ownership** (one task per file, all four locales):

| Namespace | Owner |
|---|---|
| `common` | Task 3 |
| `settings` | Task 4 |
| `shell` | Task 5 |
| `tasks`, `projects`, `goals`, `reviews` | Task 6 |
| `agents`, `runtimes` | Task 7 |

**Extraction scope.** The "shipped rail pages" are what `shell-routes.ts` links: tasks (`/my-issues`), reviews, goals, projects, runtimes (`/runs`), agents, plus the rail, the tab strip and Settings › Preferences. For each one this plan extracts the page chrome (header, tabs, column heads) and the list body states (loading, empty, errors the client authors). Detail drawers, dialogs and per-row components stay English for now. That is listed as an open question, not a silent gap.

**Parallelism.** Tasks 1→2 are the server line. Task 3 must land before Tasks 4–7. Tasks 4, 5, 6 and 7 are mutually independent, because each owns disjoint components and namespace files. Task 4 reads the server field from Task 2, and its schema defaults `locale` to `'en'`, so it builds before Task 2 merges.

---

### Task 1: Server — locale validation

**Files:**
- Modify: `server-ts/src/http/validation.ts` (next to `THEMES`, line 85)
- Test: `server-ts/src/http/validation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const LOCALES = ['en', 'zh-Hans', 'ja', 'ko'] as const;`, `export type Locale = (typeof LOCALES)[number];` and `export function validLocale(value: string): value is Locale` in `server-ts/src/http/validation.ts`.

- [ ] **Step 1: Write the failing test**

Add `validLocale` to the import list at the top of `server-ts/src/http/validation.test.ts`:

```ts
import {
   boundedLength,
   validAvatar,
   validEmail,
   validIssuePrefix,
   validLocale,
   validTimezone,
   validWorkspaceSlug,
} from './validation.ts';
```

Append at the end of the file:

```ts
test('a locale must be one Berry ships a catalogue for, spelled exactly', () => {
   for (const locale of ['en', 'zh-Hans', 'ja', 'ko']) assert.ok(validLocale(locale), locale);
   // Case and region variants are refused rather than normalised: the stored
   // value is also the catalogue directory name the frontend loads.
   for (const locale of ['EN', 'zh', 'zh-hans', 'zh-CN', 'zh-Hant', 'ja-JP', 'fr', '', ' en'])
      assert.ok(!validLocale(locale), locale);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/http/validation.test.ts`
Expected: FAIL with `SyntaxError: The requested module './validation.ts' does not provide an export named 'validLocale'`

- [ ] **Step 3: Write the minimal implementation**

In `server-ts/src/http/validation.ts`, directly after `export const THEMES = ['system', 'light', 'dark'] as const;`:

```ts
/**
 * The interface languages the web app ships catalogues for. Stored verbatim,
 * because the frontend uses the value as the catalogue directory name.
 */
export const LOCALES = ['en', 'zh-Hans', 'ja', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

export function validLocale(value: string): value is Locale {
   return (LOCALES as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server-ts && node --test --experimental-strip-types src/http/validation.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck:server
git add server-ts/src/http/validation.ts server-ts/src/http/validation.test.ts
git commit -m "feat(server-ts): know which interface locales Berry ships"
```

---

### Task 2: Server — persist the locale preference in user settings

**Files:**
- Modify: `server-ts/src/identity/repository.ts:14-18` (`UserSettings`) and `:85-92` (`toSettings`)
- Modify: `server-ts/src/mounts/me.ts` (imports, `PATCH /settings`, `UserSettingsPatchBody`, `serializeSettings`)
- Test: `server-ts/src/mounts/me.settings.test.ts` (create)

**Interfaces:**
- Consumes: `validLocale` from Task 1.
- Produces: the wire contract `GET /api/v1/me/settings` → `{ theme, timezone, reducedMotion, locale }`, with `locale ∈ 'en'|'zh-Hans'|'ja'|'ko'` and default `'en'`. `PATCH /api/v1/me/settings` accepts `{ locale }` alone or with the other fields. An invalid value gives 422 with field `/locale`, code `invalid_enum_value`. `GET /api/v1/me` and `GET /api/v1/me/bootstrap` carry the same `settings.locale`. Repository: `UserSettings = { theme: string; timezone: string; reducedMotion: boolean; locale: string }`.

- [ ] **Step 1: Write the failing DB-gated mount test**

Create `server-ts/src/mounts/me.settings.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { IdentityRepository } from '../identity/repository.ts';
import { meMounts } from './me.ts';

/**
 * The interface language is an account setting: it is stored beside theme and
 * timezone, so a second device opens in the language the first one chose.
 * Database-backed, so it skips without BERRY_TEST_DATABASE_URL.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe(
   '/api/v1/me/settings carries the interface locale',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let userId: string;
      let otherUserId: string;
      let token: string;
      let otherToken: string;
      let app: ReturnType<typeof createApp>;

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);
         const [row] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`locale-${suffix}@berry.test`}, 'Locale Test')
            RETURNING id`;
         const [other] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`locale-other-${suffix}@berry.test`}, 'Locale Other')
            RETURNING id`;
         userId = (row as { id: string }).id;
         otherUserId = (other as { id: string }).id;
         const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
         token = (await sessions.issueForUser(userId)).token;
         otherToken = (await sessions.issueForUser(otherUserId)).token;
         const registry = new Registry();
         registry.registerAll(meMounts({ sessions, identity: new IdentityRepository(sql) }));
         app = createApp(registry);
      });

      after(async () => {
         if (!sql) return;
         for (const id of [userId, otherUserId]) {
            if (!id) continue;
            await sql`DELETE FROM sessions WHERE user_id = ${id}`;
            await sql`DELETE FROM users WHERE id = ${id}`;
         }
         await closeDatabase(sql);
      });

      const callAs = (bearer: string, path: string, init: RequestInit = {}) =>
         Promise.resolve(
            app.request(path, {
               ...init,
               headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
            })
         );
      const call = (path: string, init: RequestInit = {}) => callAs(token, path, init);

      test('a user who never chose a language reads en, after the existing fields', async () => {
         const response = await call('/api/v1/me/settings');
         assert.equal(response.status, 200);
         const body = (await response.json()) as Record<string, unknown>;
         assert.deepEqual(Object.keys(body), ['theme', 'timezone', 'reducedMotion', 'locale']);
         assert.equal(body.locale, 'en');
      });

      test('a chosen locale is stored and survives an unrelated settings patch', async () => {
         const patched = await call('/api/v1/me/settings', {
            method: 'PATCH',
            body: JSON.stringify({ locale: 'zh-Hans' }),
         });
         assert.equal(patched.status, 200);
         assert.equal(((await patched.json()) as { locale: string }).locale, 'zh-Hans');

         await call('/api/v1/me/settings', {
            method: 'PATCH',
            body: JSON.stringify({ reducedMotion: true }),
         });
         const bootstrap = await call('/api/v1/me/bootstrap');
         const user = ((await bootstrap.json()) as { user: { settings: { locale: string } } }).user;
         assert.equal(user.settings.locale, 'zh-Hans');
      });

      test('a locale Berry ships no catalogue for is refused on /locale and not stored', async () => {
         const refused = await call('/api/v1/me/settings', {
            method: 'PATCH',
            body: JSON.stringify({ locale: 'fr' }),
         });
         assert.equal(refused.status, 422);
         assert.match(await refused.text(), /"\/locale"/);
         const after = await call('/api/v1/me/settings');
         assert.equal(((await after.json()) as { locale: string }).locale, 'zh-Hans');
      });

      test("one user's locale never reaches another user's settings", async () => {
         // The first user chose zh-Hans above. The second never chose.
         const other = await callAs(otherToken, '/api/v1/me/settings');
         assert.equal(other.status, 200);
         assert.equal(((await other.json()) as { locale: string }).locale, 'en');

         await callAs(otherToken, '/api/v1/me/settings', {
            method: 'PATCH',
            body: JSON.stringify({ locale: 'ko' }),
         });
         const mine = await call('/api/v1/me/settings');
         assert.equal(((await mine.json()) as { locale: string }).locale, 'zh-Hans');
      });
   }
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run (DB bridge per `server-ts/ROUTING.md` § "Running the database-backed tests"):
`cd server-ts && BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' node --test --experimental-strip-types src/mounts/me.settings.test.ts`
Expected: FAIL. The first test's `Object.keys` deepEqual fails, missing `'locale'`.
Without the env var the suite reports `skipped` and still exits 0. Also confirm that: `cd server-ts && node --test --experimental-strip-types src/mounts/me.settings.test.ts`.

- [ ] **Step 3: Implement — repository**

In `server-ts/src/identity/repository.ts`, replace the `UserSettings` type:

```ts
export type UserSettings = {
   theme: string;
   timezone: string;
   reducedMotion: boolean;
   /** Interface language; one of `LOCALES` in http/validation.ts. */
   locale: string;
}
```

Replace the body of `toSettings`:

```ts
function toSettings(value: unknown): UserSettings {
   const raw = (value ?? {}) as Partial<UserSettings>;
   return {
      theme: raw.theme ?? 'system',
      timezone: raw.timezone ?? 'UTC',
      reducedMotion: raw.reducedMotion ?? false,
      // Rows written before the preference existed have no key; they read as
      // the default rather than as a partial object.
      locale: typeof raw.locale === 'string' ? raw.locale : 'en',
   };
}
```

- [ ] **Step 4: Implement — mount**

In `server-ts/src/mounts/me.ts`, add `validLocale` to the `../http/validation.ts` import:

```ts
import {
   ONBOARDING_ANSWER_KEYS,
   ONBOARDING_STEPS,
   THEMES,
   boundedLength,
   validAvatar,
   validLocale,
   validTimezone,
} from '../http/validation.ts';
```

In `route.patch('/settings', …)`, replace everything from the `decodeBody` call through the `return json(...)` line with:

```ts
      const { value } = await decodeBody<UserSettingsPatchBody>(context, {
         theme: 'string',
         timezone: 'string',
         reducedMotion: 'boolean',
         locale: 'string',
      });
      const fields: FieldError[] = [];

      if (value.theme !== undefined && !THEMES.includes(value.theme as (typeof THEMES)[number])) {
         fields.push(
            fieldError('/theme', 'invalid_enum_value', 'Theme must be system, light, or dark.')
         );
      }
      if (value.timezone !== undefined && !validTimezone(value.timezone)) {
         fields.push(
            fieldError('/timezone', 'invalid_timezone', 'Timezone must be a valid IANA timezone.')
         );
      }
      if (value.locale !== undefined && !validLocale(value.locale)) {
         fields.push(
            fieldError('/locale', 'invalid_enum_value', 'Locale must be en, zh-Hans, ja, or ko.')
         );
      }
      if (
         value.theme === undefined &&
         value.timezone === undefined &&
         value.reducedMotion === undefined &&
         value.locale === undefined
      ) {
         fields.push(fieldError('/', 'empty_patch', 'At least one setting is required.'));
      }
      assertValid(fields);

      // Read, merge, write: Go patches onto the stored value rather than
      // replacing it, so an absent field keeps what is already there.
      const current = await profileOf(identity, userId);
      const next: UserSettings = {
         theme: value.theme ?? current.settings.theme,
         timezone: value.timezone ?? current.settings.timezone,
         reducedMotion: value.reducedMotion ?? current.settings.reducedMotion,
         locale: value.locale ?? current.settings.locale,
      };
      return json(serializeSettings(await notFoundAsUser(() => identity.updateUserSettings(userId, next))));
```

Replace `UserSettingsPatchBody`:

```ts
interface UserSettingsPatchBody {
   theme?: string;
   timezone?: string;
   reducedMotion?: boolean;
   locale?: string;
}
```

Replace `serializeSettings`:

```ts
function serializeSettings(settings: UserSettings): Record<string, unknown> {
   return {
      theme: settings.theme,
      timezone: settings.timezone,
      reducedMotion: settings.reducedMotion,
      // Appended, so the fields verified against the Go baselines keep their order.
      locale: settings.locale,
   };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server-ts && BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' node --test --experimental-strip-types src/mounts/me.settings.test.ts`
Expected: PASS, 4 tests.
Then: `pnpm typecheck:server && pnpm test:server`
Expected: all pass. The DB suites skip if the variable is unset.

- [ ] **Step 6: Record the additive wire change and commit**

Append to `server-ts/ROUTING.md`, after the "Known gaps" table:

```markdown
## `/api/v1/me/settings` gained `locale`

The Go baselines predate it. The settings object now ends with `locale`
(`en` | `zh-Hans` | `ja` | `ko`, default `en`), appended after the verified
fields so their order is unchanged; `/me` and `/me/bootstrap` carry it inside
`settings` the same way.
```

```bash
git add server-ts/src/identity/repository.ts server-ts/src/mounts/me.ts server-ts/src/mounts/me.settings.test.ts server-ts/ROUTING.md
git commit -m "feat(server-ts): remember each user's interface language"
```

---

### Task 3: Frontend — next-intl wiring, catalogue layout and parity check

**Files:**
- Create: `scripts/check-locale-catalogues.py`
- Create: `frontend/lib/i18n/locales.ts`, `frontend/i18n/request.ts`, `frontend/i18n/messages-en.ts`, `frontend/global.d.ts`
- Create: `frontend/messages/<locale>/<namespace>.json` for 4 locales × 9 namespaces
- Modify: `frontend/package.json` (dependency), `frontend/next.config.ts`, `frontend/app/layout.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces (in `@/lib/i18n/locales`):
  - `LOCALES: readonly ['en','zh-Hans','ja','ko']`, `type Locale`, `DEFAULT_LOCALE: Locale = 'en'`, `LOCALE_COOKIE = 'berry_locale'`
  - `LOCALE_NAMES: Record<Locale, string>`
  - `NAMESPACES: readonly ['common','settings','shell','tasks','projects','goals','reviews','agents','runtimes']`
  - `isLocale(value: unknown): value is Locale`
  - `resolveLocale(cookie: string | null | undefined, acceptLanguage: string | null | undefined): Locale`
- Produces (catalogue): `common` namespace keys `learnMore`, `loading`, `retry`. All other namespace files exist as `{}`, and their owner tasks fill them.
- Produces: `useTranslations`/`getTranslations` are type-checked against `messages/en/*` through `AppConfig`.
- Produces: `python3 scripts/check-locale-catalogues.py`, which exits non-zero on key or placeholder drift between locales.

- [ ] **Step 1: Write the failing parity check**

Create `scripts/check-locale-catalogues.py`:

```python
#!/usr/bin/env python3
"""Assert every locale ships the same message catalogue as English.

Each locale is a directory under frontend/messages holding one JSON file per
namespace. A key present in English but missing elsewhere would render as the
raw key; a placeholder that differs ({count} vs {n}) would throw at format
time. Both are caught here rather than by a user.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MESSAGES = ROOT / "frontend" / "messages"
LOCALES = ("en", "zh-Hans", "ja", "ko")
NAMESPACES = (
    "common", "settings", "shell", "tasks", "projects", "goals", "reviews", "agents", "runtimes",
)
PLACEHOLDER = re.compile(r"\{\s*([A-Za-z_][A-Za-z0-9_]*)")


def flatten(value: object, prefix: str, out: dict[str, str], where: str) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            flatten(child, f"{prefix}.{key}" if prefix else key, out, where)
    elif isinstance(value, str):
        if not value.strip():
            raise ValueError(f"{where}: {prefix} is empty")
        out[prefix] = value
    else:
        raise ValueError(f"{where}: {prefix} must be a string or an object")


def load(locale: str, namespace: str) -> dict[str, str]:
    path = MESSAGES / locale / f"{namespace}.json"
    if not path.is_file():
        raise ValueError(f"missing catalogue {path.relative_to(ROOT)}")
    out: dict[str, str] = {}
    flatten(json.loads(path.read_text(encoding="utf-8")), "", out, str(path.relative_to(ROOT)))
    return out


def main() -> int:
    problems: list[str] = []
    for namespace in NAMESPACES:
        try:
            english = load("en", namespace)
        except ValueError as error:
            problems.append(str(error))
            continue
        for locale in LOCALES[1:]:
            try:
                other = load(locale, namespace)
            except ValueError as error:
                problems.append(str(error))
                continue
            for key in sorted(english.keys() - other.keys()):
                problems.append(f"{locale}/{namespace}: missing {key}")
            for key in sorted(other.keys() - english.keys()):
                problems.append(f"{locale}/{namespace}: unexpected {key}")
            for key in sorted(english.keys() & other.keys()):
                want = set(PLACEHOLDER.findall(english[key]))
                got = set(PLACEHOLDER.findall(other[key]))
                if want != got:
                    problems.append(
                        f"{locale}/{namespace}: {key} placeholders {sorted(got)} != {sorted(want)}"
                    )
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print(f"locale catalogues agree: {len(LOCALES)} locales x {len(NAMESPACES)} namespaces")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 scripts/check-locale-catalogues.py`
Expected: exit 1, with lines like `missing catalogue frontend/messages/en/common.json`

- [ ] **Step 3: Add the dependency**

Run: `pnpm --filter berry-frontend add next-intl@^4.14.3`
Expected: `frontend/package.json` gains `"next-intl": "^4.14.3"`, and `pnpm-lock.yaml` updates. next-intl is MIT licensed, and its peer ranges cover next 15 and react 19.

- [ ] **Step 4: Create the locale module**

Create `frontend/lib/i18n/locales.ts`:

```ts
/**
 * The interface languages Berry ships, and how a request picks one.
 *
 * Pure on purpose: `i18n/request.ts` imports it on the server and the settings
 * page imports it in the browser. The list must match `LOCALES` in
 * `server-ts/src/http/validation.ts`, which refuses anything else.
 */

export const LOCALES = ['en', 'zh-Hans', 'ja', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Cookie the request config reads; mirrors the account setting. */
export const LOCALE_COOKIE = 'berry_locale';

/** Each language named in itself, so a reader can find their own. */
export const LOCALE_NAMES: Record<Locale, string> = {
   en: 'English',
   'zh-Hans': '简体中文',
   ja: '日本語',
   ko: '한국어',
};

/** One JSON file per namespace per locale under `messages/<locale>/`. */
export const NAMESPACES = [
   'common',
   'settings',
   'shell',
   'tasks',
   'projects',
   'goals',
   'reviews',
   'agents',
   'runtimes',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export function isLocale(value: unknown): value is Locale {
   return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Cookie first (it mirrors the account), then the browser's languages in
 * order, then English. Traditional Chinese is not mapped to zh-Hans: showing
 * the wrong script is worse than showing English.
 */
export function resolveLocale(
   cookie: string | null | undefined,
   acceptLanguage: string | null | undefined
): Locale {
   if (isLocale(cookie)) return cookie;
   for (const part of (acceptLanguage ?? '').split(',')) {
      const tag = (part.split(';')[0] ?? '').trim().toLowerCase();
      if (tag === 'en' || tag.startsWith('en-')) return 'en';
      if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';
      if (tag === 'ko' || tag.startsWith('ko-')) return 'ko';
      if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-sg' || tag.startsWith('zh-hans')) {
         return 'zh-Hans';
      }
   }
   return DEFAULT_LOCALE;
}
```

- [ ] **Step 5: Create the catalogues**

`frontend/messages/en/common.json`:

```json
{
   "learnMore": "Learn more",
   "loading": "Loading…",
   "retry": "Try again"
}
```

`frontend/messages/zh-Hans/common.json`:

```json
{
   "learnMore": "了解更多",
   "loading": "加载中…",
   "retry": "重试"
}
```

`frontend/messages/ja/common.json`:

```json
{
   "learnMore": "詳しく見る",
   "loading": "読み込み中…",
   "retry": "もう一度試す"
}
```

`frontend/messages/ko/common.json`:

```json
{
   "learnMore": "자세히 알아보기",
   "loading": "불러오는 중…",
   "retry": "다시 시도"
}
```

Create the other 32 files with the content `{}`, then a trailing newline:

```bash
cd frontend
for l in en zh-Hans ja ko; do
   for n in settings shell tasks projects goals reviews agents runtimes; do
      printf '{}\n' > "messages/$l/$n.json"
   done
done
```

- [ ] **Step 6: Create the request config and the typed English tree**

Create `frontend/i18n/request.ts`:

```ts
import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

import { LOCALE_COOKIE, NAMESPACES, resolveLocale } from '@/lib/i18n/locales';

/**
 * No locale in the URL: Berry's routes are workspace-scoped already, and a
 * language prefix would split every tab and bookmark in two. The cookie mirrors
 * the account setting (see LocaleSync), so the server renders the right
 * language on the first byte.
 */
export default getRequestConfig(async () => {
   const cookieStore = await cookies();
   const headerStore = await headers();
   const locale = resolveLocale(
      cookieStore.get(LOCALE_COOKIE)?.value,
      headerStore.get('accept-language')
   );
   const entries = await Promise.all(
      NAMESPACES.map(
         async (namespace) =>
            [namespace, (await import(`../messages/${locale}/${namespace}.json`)).default] as const
      )
   );
   return { locale, messages: Object.fromEntries(entries) };
});
```

Create `frontend/i18n/messages-en.ts`:

```ts
import agents from '@/messages/en/agents.json';
import common from '@/messages/en/common.json';
import goals from '@/messages/en/goals.json';
import projects from '@/messages/en/projects.json';
import reviews from '@/messages/en/reviews.json';
import runtimes from '@/messages/en/runtimes.json';
import settings from '@/messages/en/settings.json';
import shell from '@/messages/en/shell.json';
import tasks from '@/messages/en/tasks.json';

/**
 * English is the source catalogue. Its shape types every `t()` call through
 * `AppConfig` in global.d.ts, so a missing key fails `next build` rather than
 * rendering as a raw key.
 */
const messages = { agents, common, goals, projects, reviews, runtimes, settings, shell, tasks };

export default messages;
```

Create `frontend/global.d.ts`:

```ts
import type messages from '@/i18n/messages-en';
import type { Locale } from '@/lib/i18n/locales';

declare module 'next-intl' {
   interface AppConfig {
      Locale: Locale;
      Messages: typeof messages;
   }
}
```

- [ ] **Step 7: Wire the plugin and the root layout**

In `frontend/next.config.ts`, add at the top with the other imports:

```ts
import createNextIntlPlugin from 'next-intl/plugin';
```

Replace the final `export default nextConfig;` with:

```ts
const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

export default withNextIntl(nextConfig);
```

In `frontend/app/layout.tsx`, add these imports beside the existing ones:

```tsx
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
```

Replace the `RootLayout` function:

```tsx
export default async function RootLayout({
   children,
}: Readonly<{
   children: React.ReactNode;
}>) {
   const locale = await getLocale();
   return (
      <html lang={locale} suppressHydrationWarning>
         <body
            className={`${dmSerifDisplay.variable} ${geistMono.variable} bg-background antialiased`}
            suppressHydrationWarning
         >
            <NextIntlClientProvider>
               <NuqsAdapter>
                  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
                     <SessionGate>
                        {children}
                        <Toaster />
                     </SessionGate>
                  </ThemeProvider>
               </NuqsAdapter>
            </NextIntlClientProvider>
         </body>
      </html>
   );
}
```

In next-intl 4, `NextIntlClientProvider` rendered from a server component inherits `locale` and `messages` from `i18n/request.ts`. No props are needed.

- [ ] **Step 8: Verify**

Run: `python3 scripts/check-locale-catalogues.py`
Expected: `locale catalogues agree: 4 locales x 9 namespaces`, exit 0.
Run: `pnpm lint:frontend && pnpm build:frontend`
Expected: both succeed. Because the request config reads cookies, routes render dynamically. The build output lists routes as `ƒ (Dynamic)`, which is expected: the app is already session-gated on the client.
Manual: `pnpm dev:frontend`, sign in, then run `document.cookie = 'berry_locale=ja; path=/'` in devtools and reload. `<html lang="ja">` appears in the Elements panel.

In `AGENTS.md` § Commands, under `# Repository checks`, add the line `python3 scripts/check-locale-catalogues.py` directly after `python3 scripts/check-compose-config.py`. That makes it a listed repository check rather than a script nobody runs.

- [ ] **Step 9: Commit**

```bash
git add AGENTS.md scripts/check-locale-catalogues.py frontend/package.json pnpm-lock.yaml frontend/lib/i18n/locales.ts frontend/i18n frontend/global.d.ts frontend/messages frontend/next.config.ts frontend/app/layout.tsx
git commit -m "feat(frontend): load interface strings from per-locale catalogues"
```

---

### Task 4: Frontend — locale preference in Settings › Preferences, synced to the account

**Files:**
- Create: `frontend/lib/i18n/client-locale.ts`, `frontend/components/layout/locale-sync.tsx`
- Modify: `frontend/lib/settings.ts` (`userSettingsSchema`), `frontend/lib/auth.ts` (`bootstrapSchema` settings)
- Modify: `frontend/store/session-store.ts`, `frontend/components/layout/session-gate.tsx`
- Modify: `frontend/components/common/settings/shared.tsx` (`SelectMenu`), `frontend/components/common/settings/preferences.tsx`, `frontend/components/layout/headers/settings/header-nav.tsx`
- Modify: `frontend/messages/{en,zh-Hans,ja,ko}/settings.json`

**Interfaces:**
- Consumes: `LOCALES`, `Locale`, `LOCALE_NAMES`, `LOCALE_COOKIE`, `isLocale`, `DEFAULT_LOCALE` (Task 3). The server field `settings.locale` (Task 2). On a server without Task 2 the schemas default to `'en'`.
- Produces:
  - `writeLocaleCookie(locale: Locale): void` and `readLocaleCookie(): string | undefined` in `@/lib/i18n/client-locale`
  - `UserSettings` (frontend) gains `locale: string`
  - `SessionState.preferredLocale: Locale | null` and `SessionState.setPreferredLocale(locale: Locale): void`
  - `SelectMenu` gains an optional prop `labels?: Record<string, string>`
  - `<LocaleSync />`
  - The `settings` namespace keys used below

- [ ] **Step 1: Write the catalogue (it drives the type check that fails first)**

`frontend/messages/en/settings.json`:

```json
{
   "header": { "title": "Settings" },
   "preferences": {
      "title": "Preferences",
      "general": "General",
      "language": "Language",
      "languageDescription": "The language Berry's interface is shown in. Saved to your account.",
      "timezone": "Time zone",
      "timezoneDescription": "Dates and times across Berry are shown in this zone.",
      "interface": "Interface and theme",
      "sidebar": "App sidebar",
      "sidebarDescription": "Pin, hide and reorder rail items. Stored in this browser.",
      "customize": "Customize",
      "reduceMotion": "Reduce motion",
      "reduceMotionDescription": "Turn off the animations Berry uses to show work moving."
   }
}
```

`frontend/messages/zh-Hans/settings.json`:

```json
{
   "header": { "title": "设置" },
   "preferences": {
      "title": "偏好设置",
      "general": "通用",
      "language": "语言",
      "languageDescription": "Berry 界面使用的语言，会保存到你的账户。",
      "timezone": "时区",
      "timezoneDescription": "Berry 中的日期和时间按此时区显示。",
      "interface": "界面与主题",
      "sidebar": "应用侧边栏",
      "sidebarDescription": "固定、隐藏和排列侧边栏项目。保存在此浏览器中。",
      "customize": "自定义",
      "reduceMotion": "减少动态效果",
      "reduceMotionDescription": "关闭 Berry 用来展示工作进展的动画。"
   }
}
```

`frontend/messages/ja/settings.json`:

```json
{
   "header": { "title": "設定" },
   "preferences": {
      "title": "環境設定",
      "general": "一般",
      "language": "言語",
      "languageDescription": "Berry の画面に表示する言語です。アカウントに保存されます。",
      "timezone": "タイムゾーン",
      "timezoneDescription": "Berry 全体の日時はこのタイムゾーンで表示されます。",
      "interface": "インターフェースとテーマ",
      "sidebar": "アプリのサイドバー",
      "sidebarDescription": "サイドバー項目の固定・非表示・並べ替え。このブラウザに保存されます。",
      "customize": "カスタマイズ",
      "reduceMotion": "動きを減らす",
      "reduceMotionDescription": "作業の進行を示すアニメーションをオフにします。"
   }
}
```

`frontend/messages/ko/settings.json`:

```json
{
   "header": { "title": "설정" },
   "preferences": {
      "title": "환경설정",
      "general": "일반",
      "language": "언어",
      "languageDescription": "Berry 화면에 표시할 언어입니다. 계정에 저장됩니다.",
      "timezone": "시간대",
      "timezoneDescription": "Berry 전체의 날짜와 시간이 이 시간대로 표시됩니다.",
      "interface": "인터페이스 및 테마",
      "sidebar": "앱 사이드바",
      "sidebarDescription": "사이드바 항목을 고정, 숨기기, 재정렬합니다. 이 브라우저에 저장됩니다.",
      "customize": "사용자 지정",
      "reduceMotion": "동작 줄이기",
      "reduceMotionDescription": "작업 진행을 보여 주는 애니메이션을 끕니다."
   }
}
```

Run: `python3 scripts/check-locale-catalogues.py`
Expected: exit 0.

- [ ] **Step 2: Write the failing consumer, then run the build to see it fail**

Replace `frontend/components/layout/headers/settings/header-nav.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';

export default function HeaderNav() {
   const t = useTranslations('settings.header');
   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
         <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
               <span className="font-medium">{t('title')}</span>
            </div>
         </div>
      </div>
   );
}
```

Add `import { writeLocaleCookie } from '@/lib/i18n/client-locale';` at the top of `preferences.tsx`. The module does not exist yet.
Run: `pnpm build:frontend`
Expected: FAIL with `Module not found: Can't resolve '@/lib/i18n/client-locale'`

- [ ] **Step 3: Cookie helpers and schemas**

Create `frontend/lib/i18n/client-locale.ts`:

```ts
import { LOCALE_COOKIE, type Locale } from './locales';

/** A year: the account is authoritative, the cookie only saves a round trip. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function writeLocaleCookie(locale: Locale): void {
   document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax`;
}

export function readLocaleCookie(): string | undefined {
   for (const part of document.cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === LOCALE_COOKIE) return rest.join('=');
   }
   return undefined;
}
```

In `frontend/lib/settings.ts`, replace `userSettingsSchema`:

```ts
const userSettingsSchema = z.object({
   theme: z.string(),
   timezone: z.string(),
   reducedMotion: z.boolean(),
   // Defaulted so a server without the field still parses.
   locale: z.string().default('en'),
});
```

In `frontend/lib/auth.ts`, replace the `settings` object in `bootstrapSchema`:

```ts
      settings: z.object({
         theme: z.string(),
         timezone: z.string(),
         reducedMotion: z.boolean(),
         locale: z.string().default('en'),
      }),
```

- [ ] **Step 4: Session store carries the account's locale**

In `frontend/store/session-store.ts`:

Add the import:

```ts
import { isLocale, type Locale } from '@/lib/i18n/locales';
```

In `interface SessionState`, after `boardId: string | null;`:

```ts
   /** The account's interface language, from bootstrap; null when anonymous. */
   preferredLocale: Locale | null;
   /** Settings calls this after saving, so LocaleSync does not revert the choice. */
   setPreferredLocale: (locale: Locale) => void;
```

Change `loadReadyState`'s return type to `Pick<SessionState, 'user' | 'workspace' | 'workspaces' | 'boardId' | 'preferredLocale'>` and add this to its returned object:

```ts
      preferredLocale: isLocale(bootstrap.user.settings.locale)
         ? bootstrap.user.settings.locale
         : null,
```

Add `preferredLocale: null,` to the `ANONYMOUS` object and to the store's initial state object (the one with `status: 'booting'`). Add this action next to the other actions in the store creator:

```ts
   setPreferredLocale: (locale) => set({ preferredLocale: locale }),
```

- [ ] **Step 5: LocaleSync**

Create `frontend/components/layout/locale-sync.tsx`:

```tsx
'use client';

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { readLocaleCookie, writeLocaleCookie } from '@/lib/i18n/client-locale';
import { useSessionStore } from '@/store/session-store';

/**
 * The account is authoritative; the cookie is what the server can read.
 * When they disagree after sign-in (a new device, a cleared cookie), copy
 * the account's choice into the cookie and re-render from the server once.
 */
export function LocaleSync() {
   const rendered = useLocale();
   const preferred = useSessionStore((state) => state.preferredLocale);
   const router = useRouter();

   useEffect(() => {
      if (!preferred || preferred === rendered) return;
      // Already written: a refresh is in flight (Preferences starts its own), or
      // the browser refuses the cookie. Refreshing again would loop forever.
      if (readLocaleCookie() === preferred) return;
      writeLocaleCookie(preferred);
      router.refresh();
   }, [preferred, rendered, router]);

   return null;
}
```

In `frontend/components/layout/session-gate.tsx`, import it with `import { LocaleSync } from './locale-sync';` and replace the final `return children;` with:

```tsx
   return (
      <>
         <LocaleSync />
         {children}
      </>
   );
```

- [ ] **Step 6: SelectMenu labels**

In `frontend/components/common/settings/shared.tsx`, change the `SelectMenu` props and rendering:

```tsx
export function SelectMenu({
   options,
   labels,
   defaultValue,
   value: controlledValue,
   onChange,
   disabled,
}: {
   options: string[];
   /** Display text per option; the option value is shown when absent. */
   labels?: Record<string, string>;
   defaultValue?: string;
   /** Optional controlled value (e.g. wired to next-themes). */
   value?: string;
   onChange?: (value: string) => void;
   /** While a write is in flight, so a second click cannot race the first. */
   disabled?: boolean;
}) {
```

Replace the trigger's `{value}` with `{labels?.[value] ?? value}`, and the item's `<span className="flex-1">{option}</span>` with `<span className="flex-1">{labels?.[option] ?? option}</span>`.

- [ ] **Step 7: Preferences page**

Replace `frontend/components/common/settings/preferences.tsx`:

```tsx
'use client';

import { CustomizeSidebarDialog } from '@/components/layout/sidebar/customize-sidebar-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { writeLocaleCookie } from '@/lib/i18n/client-locale';
import { LOCALE_NAMES, LOCALES, isLocale } from '@/lib/i18n/locales';
import { loadUserSettings, saveUserSettings, type UserSettings } from '@/lib/settings';
import { useSessionStore } from '@/store/session-store';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { SelectMenu, SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { ThemePreferences } from './theme-preferences';
import { useSettingsResource } from './use-settings-resource';

/**
 * Personal "Preferences" settings.
 *
 * Four settings, because four is what the server stores: language, theme,
 * timezone and reduced motion. Anything the server does not store is not
 * offered — a switch that accepts a click and forgets it teaches people that
 * the settings page does not work.
 *
 * Sidebar customisation stays because it is real: it is stored in the browser
 * by `sidebar-prefs-store`, and it says so.
 */
export default function Preferences() {
   const t = useTranslations('settings.preferences');
   const rendered = useLocale();
   const router = useRouter();
   const setPreferredLocale = useSessionStore((state) => state.setPreferredLocale);
   const [customizeOpen, setCustomizeOpen] = useState(false);
   const settings = useSettingsResource<UserSettings>(loadUserSettings);

   // The browser's own list, which is the only list guaranteed to match what
   // the server will accept — it validates against the same IANA database.
   const zones = useMemo(() => {
      const supported =
         typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
      const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const current = settings.value?.timezone;
      return [...new Set([current, here, 'UTC', ...supported].filter(Boolean))] as string[];
   }, [settings.value?.timezone]);

   const change = (patch: Partial<UserSettings>) => {
      if (!settings.value) return;
      void settings.mutate({ ...settings.value, ...patch }, () => saveUserSettings(patch));
   };

   const changeLocale = (locale: string) => {
      if (!isLocale(locale)) return;
      change({ locale });
      // The store first, or LocaleSync would see the old account value and
      // switch straight back.
      setPreferredLocale(locale);
      writeLocaleCookie(locale);
      router.refresh();
   };

   return (
      <SettingsShell title={t('title')}>
         <SettingsSection title={t('general')} description={settings.error ?? undefined}>
            <SettingsCard>
               <SettingsRow
                  title={t('language')}
                  description={t('languageDescription')}
                  trailing={
                     <SelectMenu
                        options={[...LOCALES]}
                        labels={LOCALE_NAMES}
                        value={settings.value?.locale ?? rendered}
                        disabled={settings.loading || settings.saving}
                        onChange={changeLocale}
                     />
                  }
               />
               <SettingsRow
                  title={t('timezone')}
                  description={t('timezoneDescription')}
                  trailing={
                     <SelectMenu
                        options={zones}
                        value={settings.value?.timezone ?? 'UTC'}
                        disabled={settings.loading || settings.saving}
                        onChange={(timezone) => change({ timezone })}
                     />
                  }
               />
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title={t('interface')}>
            <SettingsCard>
               <SettingsRow
                  title={t('sidebar')}
                  description={t('sidebarDescription')}
                  trailing={
                     <Button size="xs" variant="ghost" onClick={() => setCustomizeOpen(true)}>
                        {t('customize')}
                     </Button>
                  }
               />
               <SettingsRow
                  title={t('reduceMotion')}
                  description={t('reduceMotionDescription')}
                  trailing={
                     <Switch
                        checked={settings.value?.reducedMotion ?? false}
                        disabled={settings.loading || settings.saving}
                        onCheckedChange={(reducedMotion) => change({ reducedMotion })}
                     />
                  }
               />
            </SettingsCard>
            <ThemePreferences
               // Kept on the account as well as in the browser, so a second
               // device opens in the theme this one chose.
               onChange={(theme) => change({ theme })}
            />
         </SettingsSection>
         <CustomizeSidebarDialog open={customizeOpen} onOpenChange={setCustomizeOpen} />
      </SettingsShell>
   );
}
```

- [ ] **Step 8: Verify**

Run: `python3 scripts/check-locale-catalogues.py && pnpm lint:frontend && pnpm build:frontend`
Expected: all succeed.
Manual, with the stack running on Task 2's server:
1. Open Settings › Preferences and pick 日本語. The page re-renders with 環境設定 and 言語, and the Network tab shows `PATCH /api/v1/me/settings` with body `{"locale":"ja"}`.
2. Delete the `berry_locale` cookie in devtools and reload. After boot the page re-renders in Japanese, which is LocaleSync at work.
3. Pick English and confirm it reverts and stays after reload.

- [ ] **Step 9: Commit**

```bash
git add frontend/lib/i18n/client-locale.ts frontend/components/layout/locale-sync.tsx frontend/components/layout/session-gate.tsx frontend/lib/settings.ts frontend/lib/auth.ts frontend/store/session-store.ts frontend/components/common/settings/shared.tsx frontend/components/common/settings/preferences.tsx frontend/components/layout/headers/settings/header-nav.tsx frontend/messages/*/settings.json
git commit -m "feat(frontend): choose the interface language in preferences"
```

---

### Task 5: Frontend — translate the rail and the tab strip

**Files:**
- Modify: `frontend/components/layout/shell/shell-routes.ts`, `shell-rail.tsx`, `shell-tabs.tsx`
- Modify: `frontend/messages/{en,zh-Hans,ja,ko}/shell.json`

**Interfaces:**
- Consumes: the Task 3 wiring.
- Produces: `ShellRouteDef.labelKey: ShellLabelKey`, where `export type ShellLabelKey = 'tasks' | 'reviews' | 'goals' | 'projects' | 'runtimes' | 'agents' | 'analytics'`. The `SHELL_SECTIONS` entries gain `headingKey: 'work' | 'manage' | null`. The English `label` and `heading` stay, because the persisted tab model (`shell-tab-model.ts`, non-React) still uses them. Workstream I owns rail contents: a route it adds must carry a `labelKey` plus a `shell.nav.<key>` entry in all four locales.

- [ ] **Step 1: Write the catalogue**

`frontend/messages/en/shell.json`:

```json
{
   "sections": { "work": "Work", "manage": "Manage" },
   "nav": {
      "tasks": "tasks",
      "reviews": "reviews",
      "goals": "goals",
      "projects": "projects",
      "runtimes": "runtimes",
      "agents": "agents",
      "analytics": "analytics"
   },
   "rail": {
      "workspace": "Workspace",
      "workspaceMenu": "Workspace menu",
      "runsInProgress": "Runs in progress",
      "customizeSidebar": "Customize sidebar",
      "collapseSidebar": "Collapse sidebar"
   },
   "tabs": {
      "openViews": "Open views",
      "newTab": "New tab",
      "close": "Close {label}"
   }
}
```

`frontend/messages/zh-Hans/shell.json`:

```json
{
   "sections": { "work": "工作", "manage": "管理" },
   "nav": {
      "tasks": "任务",
      "reviews": "评审",
      "goals": "目标",
      "projects": "项目",
      "runtimes": "运行",
      "agents": "智能体",
      "analytics": "分析"
   },
   "rail": {
      "workspace": "工作区",
      "workspaceMenu": "工作区菜单",
      "runsInProgress": "有运行正在进行",
      "customizeSidebar": "自定义侧边栏",
      "collapseSidebar": "收起侧边栏"
   },
   "tabs": {
      "openViews": "已打开的视图",
      "newTab": "新标签页",
      "close": "关闭 {label}"
   }
}
```

`frontend/messages/ja/shell.json`:

```json
{
   "sections": { "work": "作業", "manage": "管理" },
   "nav": {
      "tasks": "タスク",
      "reviews": "レビュー",
      "goals": "ゴール",
      "projects": "プロジェクト",
      "runtimes": "ランタイム",
      "agents": "エージェント",
      "analytics": "分析"
   },
   "rail": {
      "workspace": "ワークスペース",
      "workspaceMenu": "ワークスペースメニュー",
      "runsInProgress": "実行中の処理があります",
      "customizeSidebar": "サイドバーをカスタマイズ",
      "collapseSidebar": "サイドバーを折りたたむ"
   },
   "tabs": {
      "openViews": "開いているビュー",
      "newTab": "新しいタブ",
      "close": "{label} を閉じる"
   }
}
```

`frontend/messages/ko/shell.json`:

```json
{
   "sections": { "work": "작업", "manage": "관리" },
   "nav": {
      "tasks": "작업 항목",
      "reviews": "리뷰",
      "goals": "목표",
      "projects": "프로젝트",
      "runtimes": "런타임",
      "agents": "에이전트",
      "analytics": "분석"
   },
   "rail": {
      "workspace": "워크스페이스",
      "workspaceMenu": "워크스페이스 메뉴",
      "runsInProgress": "진행 중인 실행이 있습니다",
      "customizeSidebar": "사이드바 사용자 지정",
      "collapseSidebar": "사이드바 접기"
   },
   "tabs": {
      "openViews": "열린 보기",
      "newTab": "새 탭",
      "close": "{label} 닫기"
   }
}
```

Run: `python3 scripts/check-locale-catalogues.py`
Expected: exit 0.

- [ ] **Step 2: Write the failing consumer**

In `shell-rail.tsx`, replace `{route.label}` with `{t(\`nav.${route.labelKey}\`)}` and add `const t = useTranslations('shell');` at the top of the component body.
Run: `pnpm build:frontend`
Expected: FAIL. The type error says `Property 'labelKey' does not exist on type 'ShellRouteDef'`, and `useTranslations` is not imported.

- [ ] **Step 3: Implement the route keys**

In `frontend/components/layout/shell/shell-routes.ts`, after the `ShellRoute` type, add:

```ts
/** Key under `shell.nav` in the message catalogues. */
export type ShellLabelKey =
   | 'tasks'
   | 'reviews'
   | 'goals'
   | 'projects'
   | 'runtimes'
   | 'agents'
   | 'analytics';
```

In `ShellRouteDef`, after `label: string;`:

```ts
   /**
    * Catalogue key the rail and tabs render. `label` stays as the English
    * form for the persisted tab model, which runs outside React.
    */
   labelKey: ShellLabelKey;
```

Add `labelKey` to each route entry, matching its label:

```ts
   // WORK
   { id: 'issues', label: 'tasks', labelKey: 'tasks', /* …unchanged… */ },
   { id: 'reviews', label: 'reviews', labelKey: 'reviews', /* … */ },
   { id: 'goals', label: 'goals', labelKey: 'goals', /* … */ },
   { id: 'projects', label: 'projects', labelKey: 'projects', /* … */ },
   // MANAGE
   { id: 'runs', label: 'runtimes', labelKey: 'runtimes', /* … */ },
   { id: 'members', label: 'agents', labelKey: 'agents', /* … */ },
   { id: 'analytics', label: 'analytics', labelKey: 'analytics', /* … */ },
```

That is: in each existing object literal, insert the line `labelKey: '<same as label>',` directly after its `label:` line. Leave every other property untouched.

Replace the `SHELL_SECTIONS` declaration:

```ts
export const SHELL_SECTIONS: {
   heading: string | null;
   /** Key under `shell.sections`; null when the section has no heading. */
   headingKey: 'work' | 'manage' | null;
   routes: ShellRouteDef[];
   prefsSection?: SidebarSection;
}[] = [
   { heading: 'Work', headingKey: 'work', routes: WORK, prefsSection: 'workspace' },
   { heading: 'Manage', headingKey: 'manage', routes: MANAGE, prefsSection: 'configure' },
];

/** Every rail destination, for surfaces that label a path by its rail entry. */
export const SHELL_ROUTES: ShellRouteDef[] = [...WORK, ...MANAGE];
```

- [ ] **Step 4: Implement the rail**

In `frontend/components/layout/shell/shell-rail.tsx`:
- Add `import { useTranslations } from 'next-intl';`.
- Keep the `const t = useTranslations('shell');` that Step 2 added as the first line of the `ShellRail` body. Do not add a second one (a duplicate `const t` is a compile error).
- Replace `aria-label="Workspace"` on `<nav>` with `aria-label={t('rail.workspace')}`.
- Replace `aria-label="Workspace menu"` with `aria-label={t('rail.workspaceMenu')}`.
- Replace `{section.heading}` with `{section.headingKey ? t(\`sections.${section.headingKey}\`) : null}`, keeping the surrounding `section.heading ?` condition.
- Replace `{route.label}` with `{t(\`nav.${route.labelKey}\`)}`.
- Replace both `aria-label="Runs in progress"` and `title="Runs in progress"` with `{t('rail.runsInProgress')}` expressions.
- Replace both `"Customize sidebar"` attributes with `{t('rail.customizeSidebar')}`.
- Replace both `"Collapse sidebar"` attributes with `{t('rail.collapseSidebar')}`.

- [ ] **Step 5: Implement the tabs**

In `frontend/components/layout/shell/shell-tabs.tsx`:

```tsx
import { useTranslations } from 'next-intl';
import { SHELL_ROUTES } from './shell-routes';
```

Inside `ShellTabs`, before `return`:

```tsx
   const t = useTranslations('shell');
   // Tabs persist their English label; a rail destination is re-labelled at
   // render so switching language renames open tabs too. Detail tabs (an issue
   // key, "projects / abc") keep what they stored.
   const labelOf = (tab: ShellTab) => {
      const route = SHELL_ROUTES.find((candidate) => candidate.href === tab.href);
      return route ? t(`nav.${route.labelKey}`) : tab.label;
   };
```

Inside the `tabs.map`, add `const label = labelOf(tab);` after `const on = …`, then replace `title={tab.label}` with `title={label}`, `{tab.label}` in the span with `{label}`, and ``aria-label={`Close ${tab.label}`}`` with `aria-label={t('tabs.close', { label })}`. Replace `aria-label="Open views"` with `aria-label={t('tabs.openViews')}` and `aria-label="New tab"` with `aria-label={t('tabs.newTab')}`.

- [ ] **Step 6: Verify**

Run: `python3 scripts/check-locale-catalogues.py && pnpm lint:frontend && pnpm build:frontend`
Expected: all succeed.
Manual: with the cookie set to `zh-Hans`, the rail reads 工作 / 任务 / 评审 …, and an open "tasks" tab reads 任务. An issue-key tab still reads `BER-…`.

- [ ] **Step 7: Commit**

```bash
git add frontend/components/layout/shell/shell-routes.ts frontend/components/layout/shell/shell-rail.tsx frontend/components/layout/shell/shell-tabs.tsx frontend/messages/*/shell.json
git commit -m "feat(frontend): show the rail and tabs in the chosen language"
```

---

### Task 6: Frontend — translate the Tasks, Projects, Goals and Reviews pages

**Files:**
- Modify: `frontend/components/layout/headers/my-issues/header.tsx`, `frontend/components/layout/headers/projects/header-nav.tsx`, `frontend/components/common/projects/projects.tsx:184`, `frontend/components/layout/headers/goals/header.tsx`, `frontend/components/common/goals/goals.tsx`, `frontend/components/common/reviews/reviews.tsx`
- Modify: `frontend/messages/{en,zh-Hans,ja,ko}/{tasks,projects,goals,reviews}.json`

**Interfaces:**
- Consumes: the Task 3 wiring. It reads `common.learnMore`.
- Produces: the `tasks`, `projects`, `goals` and `reviews` namespaces (keys below). `MY_ISSUES_TAB_ITEMS[].label` stays as English data. The header renders `t(\`tabs.${item.value}\`)`, keyed by the stable `MyIssuesTab` value.

- [ ] **Step 1: Write the catalogues**

`frontend/messages/en/tasks.json`:

```json
{
   "header": {
      "title": "Tasks",
      "description": "Work starts here. Assign to a human or an agent, then track it through review.",
      "toggleInsights": "Toggle insights panel",
      "toggleBreakdown": "Toggle breakdown panel"
   },
   "tabs": { "all": "All", "members": "Members", "agent": "Agent" }
}
```

`frontend/messages/zh-Hans/tasks.json`:

```json
{
   "header": {
      "title": "任务",
      "description": "工作从这里开始。分配给成员或智能体，然后一路跟踪到评审。",
      "toggleInsights": "切换洞察面板",
      "toggleBreakdown": "切换细分面板"
   },
   "tabs": { "all": "全部", "members": "成员", "agent": "智能体" }
}
```

`frontend/messages/ja/tasks.json`:

```json
{
   "header": {
      "title": "タスク",
      "description": "作業はここから始まります。人またはエージェントに割り当て、レビューまで追跡します。",
      "toggleInsights": "インサイトパネルを切り替え",
      "toggleBreakdown": "内訳パネルを切り替え"
   },
   "tabs": { "all": "すべて", "members": "メンバー", "agent": "エージェント" }
}
```

`frontend/messages/ko/tasks.json`:

```json
{
   "header": {
      "title": "작업 항목",
      "description": "작업은 여기서 시작됩니다. 사람이나 에이전트에게 배정하고 리뷰까지 추적하세요.",
      "toggleInsights": "인사이트 패널 전환",
      "toggleBreakdown": "세부 패널 전환"
   },
   "tabs": { "all": "전체", "members": "멤버", "agent": "에이전트" }
}
```

`frontend/messages/en/projects.json`:

```json
{
   "header": {
      "title": "Projects",
      "description": "Group related tasks into a shared plan with status, health, and a target date."
   },
   "toggleInsights": "Toggle projects insights panel"
}
```

`frontend/messages/zh-Hans/projects.json`:

```json
{
   "header": {
      "title": "项目",
      "description": "把相关任务归入同一计划，并跟踪状态、健康度和目标日期。"
   },
   "toggleInsights": "切换项目洞察面板"
}
```

`frontend/messages/ja/projects.json`:

```json
{
   "header": {
      "title": "プロジェクト",
      "description": "関連するタスクをひとつの計画にまとめ、状態・健全性・目標日を管理します。"
   },
   "toggleInsights": "プロジェクトのインサイトパネルを切り替え"
}
```

`frontend/messages/ko/projects.json`:

```json
{
   "header": {
      "title": "프로젝트",
      "description": "관련 작업을 하나의 계획으로 묶고 상태, 건강도, 목표일을 관리하세요."
   },
   "toggleInsights": "프로젝트 인사이트 패널 전환"
}
```

`frontend/messages/en/goals.json`:

```json
{
   "header": {
      "title": "Goals",
      "description": "The tasks one plan produced, grouped inside their project. Berry makes a goal when you plan work in a project — there is nothing to start or write here."
   },
   "list": {
      "goal": "Goal",
      "status": "Status",
      "progress": "Progress",
      "updated": "Updated",
      "loading": "Loading goals…"
   },
   "empty": {
      "mark": "No goals",
      "title": "No goals yet.",
      "body": "A goal is the group of tasks one plan produced. Plan work in a project and the goal arrives with the tasks.",
      "cta": "go to projects"
   }
}
```

`frontend/messages/zh-Hans/goals.json`:

```json
{
   "header": {
      "title": "目标",
      "description": "一次计划生成的任务，归在所属项目下。在项目中规划工作时 Berry 会创建目标——这里无需新建或填写。"
   },
   "list": {
      "goal": "目标",
      "status": "状态",
      "progress": "进度",
      "updated": "更新时间",
      "loading": "正在加载目标…"
   },
   "empty": {
      "mark": "暂无目标",
      "title": "还没有目标。",
      "body": "目标就是一次计划生成的一组任务。在项目中规划工作，目标会随任务一起出现。",
      "cta": "前往项目"
   }
}
```

`frontend/messages/ja/goals.json`:

```json
{
   "header": {
      "title": "ゴール",
      "description": "ひとつの計画から生まれたタスクを、そのプロジェクトの中でまとめたものです。プロジェクトで作業を計画すると Berry がゴールを作成します。ここで始めたり書いたりするものはありません。"
   },
   "list": {
      "goal": "ゴール",
      "status": "状態",
      "progress": "進捗",
      "updated": "更新",
      "loading": "ゴールを読み込み中…"
   },
   "empty": {
      "mark": "ゴールなし",
      "title": "まだゴールがありません。",
      "body": "ゴールは、ひとつの計画から生まれたタスクのまとまりです。プロジェクトで作業を計画すると、タスクと一緒にゴールが作られます。",
      "cta": "プロジェクトへ"
   }
}
```

`frontend/messages/ko/goals.json`:

```json
{
   "header": {
      "title": "목표",
      "description": "하나의 계획에서 나온 작업을 해당 프로젝트 안에 묶은 것입니다. 프로젝트에서 작업을 계획하면 Berry가 목표를 만듭니다. 여기서 시작하거나 작성할 것은 없습니다."
   },
   "list": {
      "goal": "목표",
      "status": "상태",
      "progress": "진행률",
      "updated": "업데이트",
      "loading": "목표를 불러오는 중…"
   },
   "empty": {
      "mark": "목표 없음",
      "title": "아직 목표가 없습니다.",
      "body": "목표는 하나의 계획에서 나온 작업 묶음입니다. 프로젝트에서 작업을 계획하면 작업과 함께 목표가 생깁니다.",
      "cta": "프로젝트로 이동"
   }
}
```

`frontend/messages/en/reviews.json`:

```json
{
   "title": "Reviews",
   "tabs": { "waiting": "Waiting", "decided": "Decided" },
   "groups": {
      "waiting": "Waiting for a decision",
      "approved": "Approved",
      "sentBack": "Sent back"
   },
   "loading": "Loading reviews…",
   "empty": {
      "open": "Nothing is waiting for review.",
      "decided": "Nothing has been decided yet."
   },
   "count": { "open": "{count} waiting", "decided": "{count} decided" }
}
```

`frontend/messages/zh-Hans/reviews.json`:

```json
{
   "title": "评审",
   "tabs": { "waiting": "待处理", "decided": "已决定" },
   "groups": {
      "waiting": "等待决定",
      "approved": "已批准",
      "sentBack": "已退回"
   },
   "loading": "正在加载评审…",
   "empty": {
      "open": "没有等待评审的内容。",
      "decided": "还没有任何决定。"
   },
   "count": { "open": "{count} 项待处理", "decided": "{count} 项已决定" }
}
```

`frontend/messages/ja/reviews.json`:

```json
{
   "title": "レビュー",
   "tabs": { "waiting": "待機中", "decided": "決定済み" },
   "groups": {
      "waiting": "判断待ち",
      "approved": "承認済み",
      "sentBack": "差し戻し"
   },
   "loading": "レビューを読み込み中…",
   "empty": {
      "open": "レビュー待ちのものはありません。",
      "decided": "まだ決定されたものはありません。"
   },
   "count": { "open": "{count} 件待機中", "decided": "{count} 件決定済み" }
}
```

`frontend/messages/ko/reviews.json`:

```json
{
   "title": "리뷰",
   "tabs": { "waiting": "대기 중", "decided": "결정됨" },
   "groups": {
      "waiting": "결정 대기",
      "approved": "승인됨",
      "sentBack": "반려됨"
   },
   "loading": "리뷰를 불러오는 중…",
   "empty": {
      "open": "리뷰를 기다리는 항목이 없습니다.",
      "decided": "아직 결정된 항목이 없습니다."
   },
   "count": { "open": "{count}개 대기 중", "decided": "{count}개 결정됨" }
}
```

Run: `python3 scripts/check-locale-catalogues.py`
Expected: exit 0.

- [ ] **Step 2: Write the failing consumer**

In `frontend/components/layout/headers/goals/header.tsx`, replace `<span className="font-medium">Goals</span>` with `<span className="font-medium">{t('title')}</span>`, without adding the hook yet.
Run: `pnpm build:frontend`
Expected: FAIL with `Cannot find name 't'`.

- [ ] **Step 3: Implement the Goals header and list**

Replace `frontend/components/layout/headers/goals/header.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';

/**
 * Goals list header. No action, deliberately: planning is what makes a goal and
 * it starts in a project, so the button lives there. Offering it here would
 * invite a goal with no project to hang off.
 */
export default function Header() {
   const t = useTranslations('goals.header');
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">{t('title')}</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">{t('description')}</p>
         </div>
      </header>
   );
}
```

In `frontend/components/common/goals/goals.tsx`, add `import { useTranslations } from 'next-intl';`, then:
- In `EmptyGoals`, add `const t = useTranslations('goals.empty');`. Replace `label="No goals"` with `label={t('mark')}`, `No goals yet.` with `{t('title')}`, the paragraph text with `{t('body')}`, and `go to projects` with `{t('cta')}`.
- In `Goals`, add `const t = useTranslations('goals.list');`. Replace `Goal`, `Status`, `Progress` and `Updated` in the header cells with `{t('goal')}`, `{t('status')}`, `{t('progress')}` and `{t('updated')}`, and `Loading goals…` with `{t('loading')}`.

- [ ] **Step 4: Implement Tasks and Projects**

In `frontend/components/layout/headers/my-issues/header.tsx`, add `import { useTranslations } from 'next-intl';`.
In `HeaderNav` add `const t = useTranslations('tasks.header'); const common = useTranslations('common');`, and replace the title and description block with:

```tsx
               <span className="font-medium">{t('title')}</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  {t('description')}{' '}
                  <a href="" className="text-foreground underline-offset-2 hover:underline">
                     {common('learnMore')}
                  </a>
               </p>
```

In `HeaderOptions` add `const t = useTranslations('tasks');`. Replace `{item.label}` with `{t(\`tabs.${item.value}\`)}`, `aria-label="Toggle insights panel"` with `aria-label={t('header.toggleInsights')}`, and `aria-label="Toggle breakdown panel"` with `aria-label={t('header.toggleBreakdown')}`.

In `frontend/components/layout/headers/projects/header-nav.tsx`, add `import { useTranslations } from 'next-intl';`, and inside `HeaderNav` add `const t = useTranslations('projects.header'); const common = useTranslations('common');`. Replace `Projects` with `{t('title')}`, the description text with `{t('description')}`, and `Learn more` with `{common('learnMore')}`.

In `frontend/components/common/projects/projects.tsx`, add `import { useTranslations } from 'next-intl';` and `const t = useTranslations('projects');` at the top of the component that renders line 184. Replace `aria-label="Toggle projects insights panel"` with `aria-label={t('toggleInsights')}`.

- [ ] **Step 5: Implement Reviews**

In `frontend/components/common/reviews/reviews.tsx`, add `import { useTranslations } from 'next-intl';`, and in the component holding the `groups` array add `const t = useTranslations('reviews');`. Replace the `groups` literal with:

```tsx
   const groups = [
      {
         label: state === 'open' ? t('groups.waiting') : t('groups.approved'),
         status: state === 'open' ? 'open' : 'merged',
      },
      { label: t('groups.sentBack'), status: 'closed' },
   ]
```

The existing `.map(...).filter(...)` chain after it stays unchanged. Then replace:
- `<span className="font-medium">Reviews</span>` → `<span className="font-medium">{t('title')}</span>`
- `Waiting` (link text) → `{t('tabs.waiting')}`; `Decided` → `{t('tabs.decided')}`
- `Loading reviews…` → `{t('loading')}`
- `{state === 'open' ? 'Nothing is waiting for review.' : 'Nothing has been decided yet.'}` → `{state === 'open' ? t('empty.open') : t('empty.decided')}`
- ``{items ? `${items.length} ${state === 'open' ? 'waiting' : 'decided'}` : ''}`` → `{items ? t(state === 'open' ? 'count.open' : 'count.decided', { count: items.length }) : ''}`

- [ ] **Step 6: Verify**

Run: `python3 scripts/check-locale-catalogues.py && pnpm lint:frontend && pnpm build:frontend`
Expected: all succeed.
Manual: with the cookie set to `ko`, open tasks, projects, goals and reviews. The headers, tabs, column heads and empty states are Korean. Row data (issue titles, names) is unchanged.

- [ ] **Step 7: Commit**

```bash
git add frontend/components/layout/headers/my-issues/header.tsx frontend/components/layout/headers/projects/header-nav.tsx frontend/components/common/projects/projects.tsx frontend/components/layout/headers/goals/header.tsx frontend/components/common/goals/goals.tsx frontend/components/common/reviews/reviews.tsx frontend/messages/*/tasks.json frontend/messages/*/projects.json frontend/messages/*/goals.json frontend/messages/*/reviews.json
git commit -m "feat(frontend): translate the tasks, projects, goals and reviews pages"
```

---

### Task 7: Frontend — translate the Agents and Runtimes pages

**Files:**
- Modify: `frontend/components/layout/headers/agents/header-nav.tsx`, `frontend/components/layout/headers/agents/header-options.tsx`, `frontend/components/common/agents/agents.tsx`, `frontend/components/layout/headers/runs/header.tsx`, `frontend/components/common/runs/run-overview.tsx`
- Modify: `frontend/messages/{en,zh-Hans,ja,ko}/{agents,runtimes}.json`

**Interfaces:**
- Consumes: the Task 3 wiring. It reads `common.learnMore`.
- Produces: the `agents` and `runtimes` namespaces (keys below).

- [ ] **Step 1: Write the catalogues**

`frontend/messages/en/agents.json`:

```json
{
   "header": {
      "title": "Agents",
      "description": "AI teammates that pick up issues, comment, and update status.",
      "newAgent": "New agent"
   },
   "options": {
      "searchPlaceholder": "Search agents…",
      "searchLabel": "Search agents",
      "filter": "Filter",
      "sortLastActive": "Last active",
      "sortName": "Name"
   },
   "list": {
      "agent": "Agent",
      "status": "Status",
      "access": "Access",
      "model": "Model",
      "price": "Price",
      "priceHint": "Input / output, per million tokens",
      "runtimes": "Runtimes",
      "loading": "Loading agents…",
      "noMatch": "No agents match your search.",
      "none": "No agents are registered for this workspace yet."
   }
}
```

`frontend/messages/zh-Hans/agents.json`:

```json
{
   "header": {
      "title": "智能体",
      "description": "能领取任务、发表评论并更新状态的 AI 队友。",
      "newAgent": "新建智能体"
   },
   "options": {
      "searchPlaceholder": "搜索智能体…",
      "searchLabel": "搜索智能体",
      "filter": "筛选",
      "sortLastActive": "最近活跃",
      "sortName": "名称"
   },
   "list": {
      "agent": "智能体",
      "status": "状态",
      "access": "访问权限",
      "model": "模型",
      "price": "价格",
      "priceHint": "输入 / 输出，每百万 token",
      "runtimes": "运行",
      "loading": "正在加载智能体…",
      "noMatch": "没有符合搜索条件的智能体。",
      "none": "此工作区还没有注册任何智能体。"
   }
}
```

`frontend/messages/ja/agents.json`:

```json
{
   "header": {
      "title": "エージェント",
      "description": "タスクを引き受け、コメントし、状態を更新する AI のチームメイトです。",
      "newAgent": "新しいエージェント"
   },
   "options": {
      "searchPlaceholder": "エージェントを検索…",
      "searchLabel": "エージェントを検索",
      "filter": "フィルター",
      "sortLastActive": "最終アクティブ",
      "sortName": "名前"
   },
   "list": {
      "agent": "エージェント",
      "status": "状態",
      "access": "アクセス",
      "model": "モデル",
      "price": "料金",
      "priceHint": "入力 / 出力、100 万トークンあたり",
      "runtimes": "ランタイム",
      "loading": "エージェントを読み込み中…",
      "noMatch": "検索に一致するエージェントはありません。",
      "none": "このワークスペースにはまだエージェントが登録されていません。"
   }
}
```

`frontend/messages/ko/agents.json`:

```json
{
   "header": {
      "title": "에이전트",
      "description": "작업을 맡고, 댓글을 달고, 상태를 업데이트하는 AI 팀원입니다.",
      "newAgent": "새 에이전트"
   },
   "options": {
      "searchPlaceholder": "에이전트 검색…",
      "searchLabel": "에이전트 검색",
      "filter": "필터",
      "sortLastActive": "최근 활동",
      "sortName": "이름"
   },
   "list": {
      "agent": "에이전트",
      "status": "상태",
      "access": "접근 권한",
      "model": "모델",
      "price": "가격",
      "priceHint": "입력 / 출력, 100만 토큰당",
      "runtimes": "런타임",
      "loading": "에이전트를 불러오는 중…",
      "noMatch": "검색과 일치하는 에이전트가 없습니다.",
      "none": "이 워크스페이스에 등록된 에이전트가 아직 없습니다."
   }
}
```

`frontend/messages/en/runtimes.json`:

```json
{
   "header": {
      "title": "Runtimes",
      "description": "Execution ledger for agent work — status, events, usage, and cost per run."
   },
   "overview": {
      "label": "Runtimes",
      "caption": "Delegated runtimes",
      "agentFallback": "agent",
      "cancel": "Cancel run",
      "cancelling": "Cancelling…",
      "cancelled": "Run cancelled",
      "cancelFailed": "Could not cancel run",
      "waiting": "Waiting for output…"
   }
}
```

`frontend/messages/zh-Hans/runtimes.json`:

```json
{
   "header": {
      "title": "运行",
      "description": "智能体工作的执行台账——每次运行的状态、事件、用量和成本。"
   },
   "overview": {
      "label": "运行",
      "caption": "已委派的运行",
      "agentFallback": "智能体",
      "cancel": "取消运行",
      "cancelling": "正在取消…",
      "cancelled": "运行已取消",
      "cancelFailed": "无法取消运行",
      "waiting": "等待输出…"
   }
}
```

`frontend/messages/ja/runtimes.json`:

```json
{
   "header": {
      "title": "ランタイム",
      "description": "エージェント作業の実行台帳。実行ごとの状態、イベント、使用量、コストを表示します。"
   },
   "overview": {
      "label": "ランタイム",
      "caption": "委任されたランタイム",
      "agentFallback": "エージェント",
      "cancel": "実行をキャンセル",
      "cancelling": "キャンセル中…",
      "cancelled": "実行をキャンセルしました",
      "cancelFailed": "実行をキャンセルできませんでした",
      "waiting": "出力を待っています…"
   }
}
```

`frontend/messages/ko/runtimes.json`:

```json
{
   "header": {
      "title": "런타임",
      "description": "에이전트 작업의 실행 기록입니다. 실행별 상태, 이벤트, 사용량, 비용을 보여 줍니다."
   },
   "overview": {
      "label": "런타임",
      "caption": "위임된 런타임",
      "agentFallback": "에이전트",
      "cancel": "실행 취소",
      "cancelling": "취소하는 중…",
      "cancelled": "실행이 취소되었습니다",
      "cancelFailed": "실행을 취소할 수 없습니다",
      "waiting": "출력을 기다리는 중…"
   }
}
```

Run: `python3 scripts/check-locale-catalogues.py`
Expected: exit 0.

- [ ] **Step 2: Write the failing consumer**

In `frontend/components/layout/headers/runs/header.tsx`, replace `Runtimes` with `{t('title')}` without adding the hook.
Run: `pnpm build:frontend`
Expected: FAIL with `Cannot find name 't'`.

- [ ] **Step 3: Implement the Runtimes header and overview**

Replace `frontend/components/layout/headers/runs/header.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';

export default function Header() {
   const t = useTranslations('runtimes.header');
   const common = useTranslations('common');
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">{t('title')}</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               {t('description')}{' '}
               <a href="" className="text-foreground underline-offset-2 hover:underline">
                  {common('learnMore')}
               </a>
            </p>
         </div>
      </header>
   );
}
```

In `frontend/components/common/runs/run-overview.tsx`, add `import { useTranslations } from 'next-intl';`, and in the component that defines `onCancelSelected` add `const t = useTranslations('runtimes.overview');`. Replace:
- `toast.success('Run cancelled')` → `toast.success(t('cancelled'))`
- `'Could not cancel run'` → `t('cancelFailed')`
- `aria-label="Runtimes"` on the `<section>` → `aria-label={t('label')}`
- `?? 'agent'` → `?? t('agentFallback')`, at both occurrences (the selected-run line near line 219 and the table row near line 331). Both are inside `RunOverview`.
- `{cancelling ? 'Cancelling…' : 'Cancel run'}` → `{cancelling ? t('cancelling') : t('cancel')}`
- `'Waiting for output…'` → `t('waiting')`
- `<caption className="sr-only">Delegated runtimes</caption>` → `<caption className="sr-only">{t('caption')}</caption>`

- [ ] **Step 4: Implement Agents**

In `frontend/components/layout/headers/agents/header-nav.tsx`, add `import { useTranslations } from 'next-intl';` and in `HeaderNav` add `const t = useTranslations('agents.header'); const common = useTranslations('common');`. Replace `Agents` with `{t('title')}`, the description text with `{t('description')}`, `Learn more` with `{common('learnMore')}`, and `New agent` with `{t('newAgent')}`.

In `frontend/components/layout/headers/agents/header-options.tsx`, add `import { useTranslations } from 'next-intl';` and `const t = useTranslations('agents.options');`. Replace:
- `placeholder="Search agents…"` → `placeholder={t('searchPlaceholder')}`
- `aria-label="Search agents"` → `aria-label={t('searchLabel')}`
- `Filter` → `{t('filter')}`
- `{sort === 'last-active-desc' ? 'Last active' : 'Name'}` → `{sort === 'last-active-desc' ? t('sortLastActive') : t('sortName')}`

In `frontend/components/common/agents/agents.tsx`, add `import { useTranslations } from 'next-intl';`, and in the component that renders the header row add `const t = useTranslations('agents.list');`. Replace the header cells `Agent`, `Status`, `Access`, `Model`, `Price` and `Runtimes` with `{t('agent')}`, `{t('status')}`, `{t('access')}`, `{t('model')}`, `{t('price')}` and `{t('runtimes')}`, and `title="Input / output, per million tokens"` with `title={t('priceHint')}`. Replace `Loading agents…` with `{t('loading')}`, and the empty-state ternary with:

```tsx
               {search.trim() ? t('noMatch') : t('none')}
```

- [ ] **Step 5: Verify**

Run: `python3 scripts/check-locale-catalogues.py && pnpm lint:frontend && pnpm build:frontend`
Expected: all succeed.
Manual: with the cookie set to `ja`, the agents page reads エージェント with a search placeholder of エージェントを検索…. On runtimes, the header reads ランタイム, and cancelling a queued run toasts 実行をキャンセルしました.

- [ ] **Step 6: Commit**

```bash
git add frontend/components/layout/headers/agents/header-nav.tsx frontend/components/layout/headers/agents/header-options.tsx frontend/components/common/agents/agents.tsx frontend/components/layout/headers/runs/header.tsx frontend/components/common/runs/run-overview.tsx frontend/messages/*/agents.json frontend/messages/*/runtimes.json
git commit -m "feat(frontend): translate the agents and runtimes pages"
```

---

## Self-Review

**Spec coverage (§9, locales only).**
- The four locales en, zh-Hans, ja and ko are covered by Task 1 on the server and Task 3 on the frontend, with the same list in both places.
- `next-intl` message catalogues are wired in Task 3 and filled in Tasks 4–7.
- The locale preference in settings is stored by Task 2 and shown in the UI and synced by Task 4.
- Billing, Stripe, seats, credits, entitlements and the billing page are excluded, as the user decided.
- §11 isolation: no new table and no new mount. `/me` is user-scoped behind `requireSession`, and Task 2's test proves that one user's locale neither reads as nor overwrites another user's.
- §11 tests: `node --test` covers the validation (Task 1) and the mount (Task 2). The frontend gates are lint, `next build` with typed message keys, and the catalogue parity script.
- §13: every rail page ships translated chrome. Deeper surfaces are named as an open question.

**Placeholder scan.** No TBD or TODO markers remain. Every code step shows its code, and for mechanical string swaps the before and after literals are shown verbatim.

**Type consistency.**
- `Locale`, `LOCALES` and `isLocale` come from `@/lib/i18n/locales` everywhere.
- The server exports `validLocale` and `LOCALES` from `src/http/validation.ts`.
- `preferredLocale` and `setPreferredLocale` are used identically in the store, `LocaleSync` and Preferences.
- `labelKey` and `SHELL_ROUTES` are defined in Task 5 and used only there.
- The namespace names match `NAMESPACES`, `messages-en.ts` and the Python `NAMESPACES`.

## Open questions (not silent gaps)

- **Deeper surfaces stay English.** That covers detail drawers, dialogs, per-row components, the sign-in and sign-up pages, the `BootScreen` "Loading Berry" text, the page `<title>`/metadata, and server-authored error messages (for example the 422 `message` text). Each needs its own namespace and owner before it is extracted.
- **Dates and numbers** still format through the existing helpers, not through the chosen locale (`useFormatter`). Should relative times and counts follow the interface language or the browser?
- **`resolveLocale` has no automated test.** The frontend has no test runner (`frontend/package.json` only has dev, build, lint and format scripts), and the frontend tsconfig lacks `allowImportingTsExtensions`, so a `node --test` file next to it would break `next build`. Its `Accept-Language` mapping (zh-TW is not mapped to zh-Hans, region tags collapse) is checked only by the manual steps in Tasks 3 and 4. Add a unit test once a frontend runner exists.
- **Rail entries added by workstream I** must add a `labelKey` and a `shell.nav.<key>` entry in all four locales (see Task 5). The parity script catches a missing locale, and `next build` catches a missing English key.

## Verification before merge

```bash
pnpm typecheck:server && pnpm test:server
python3 scripts/check-locale-catalogues.py
pnpm lint:frontend && pnpm build:frontend
```
