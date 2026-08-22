# Berry — Coding Playbook

*Release 1 · M0 Foundation · BERR-13*

The conventions every Berry contributor — human or agent — codes against.
Everything here is grounded in what is already in the repository; where a
convention is aspirational (a stack is installed but not yet exercised) it is
labelled as such. When code and this document disagree, fix the one that is
wrong and keep them in sync.

## Repository shape: one repo, two workspaces, two toolchains

Berry is a single Git repository holding two independently-tooled workspaces.
They do **not** share a formatter, lint config, or TypeScript target, and that
split is intentional — the frontend stays close to its upstream Circle template,
the gateway follows a clean Bun-native setup. Know which workspace you are in
before you write code.

| | `apps/gateway/` | `frontend/` |
| --- | --- | --- |
| What it is | Bun + Hono BFF adapting OpenFang into the Linear-shaped API | Next.js 15 App Router UI, vendored from Circle (MIT) |
| Runtime | Bun | Bun (tooling) / Node-compatible Next runtime |
| Language target | `ESNext`, strict | `ES2017`, strict |
| Path alias | `~/*` → `src/*` | `@/*` → repo root |
| Format + lint | **Biome** (`biome.json`) | **Prettier + ESLint** (`.prettierrc`, `eslint.config.mjs`) |
| Tests | `bun:test` | none yet (see [Testing](#testing)) |
| Package name | `@berry/gateway` | `berry-frontend` |

Because the two workspaces use different formatters with different settings,
**never run one workspace's formatter over the other.** Style rules below are
stated per workspace.

## TypeScript style

- **`strict` is on in both workspaces. Keep it on.** Do not weaken
  `tsconfig.json` to make a type error go away; fix the type.
- **No `any`.** The gateway's Biome config runs the `recommended` rule set;
  the frontend runs `next/typescript`. Prefer precise types, `unknown` at
  untyped boundaries, and narrowing. The one place `any` is tolerated is the
  vendored `components/data-table-filter/**` tree, which is explicitly exempted
  in `eslint.config.mjs` to stay close to upstream — do not copy that exemption
  elsewhere.
- **Avoid non-null assertions (`!`).** Narrow instead. The gateway's DB tests
  show the pattern: a small `must<T>(value)` helper that throws on
  `null`/`undefined` and returns the value narrowed
  (`apps/gateway/src/db/schema.constraints.test.ts`).
- **Import types as types.** The gateway sets `verbatimModuleSyntax`, so
  type-only imports must use `import type { … }` (or inline `type` specifiers,
  e.g. `import { type ClassValue, clsx } from "clsx"`). This is enforced by the
  compiler in the gateway and is the house style in the frontend too.
- **Use the path alias, not deep relative chains.** `~/logger` in the gateway,
  `@/lib/utils` in the frontend. Reserve `./` relative imports for siblings in
  the same directory.
- **Naming.** `camelCase` for variables and functions, `PascalCase` for types,
  React components, and Zod-derived types, `SCREAMING_SNAKE_CASE` for exported
  env-backed constants (`API_BASE_URL`, `WORKSPACE_SLUG` in `frontend/lib/config.ts`).
  Files are `kebab-case.ts` / `kebab-case.tsx`; React component files may be
  `PascalCase.tsx` where Circle already uses that.
- **Comment the *why*, not the *what*.** The existing modules comment intent
  and constraints (why the DB tests skip without a database, why the run
  resource is a gap). Match that density — sparse, purposeful doc comments over
  narration.

### Formatting & linting

Run the workspace's own tools; both target a 100-column line width but agree on
nothing else.

**Gateway** — Biome:

```sh
cd apps/gateway
bun run lint       # biome check .        (CI gate)
bun run lint:fix   # biome check --write . (autofix + organize imports)
bun run typecheck  # tsc --noEmit
```

Biome settings (`biome.json`): 2-space indent, double quotes, semicolons
always, trailing commas everywhere, imports auto-organized.

**Frontend** — Prettier + ESLint:

```sh
cd frontend
bun run lint       # next lint (ESLint, CI gate)
bun run format     # prettier --write .
```

Prettier settings (`.prettierrc`): **3-space `tabWidth`**, single quotes,
semicolons, `es5` trailing commas, `printWidth` 100. A Husky `pre-commit` hook
runs `lint-staged`, which Prettier-formats staged `*.{js,jsx,ts,tsx,json,css,md}`
files, so committed frontend code is formatted automatically.

## Zod validation pattern

Zod is the validation library across the repo. The rule: **parse untrusted
input into a typed value at the boundary, then trust the type inside.** Don't
hand-validate with `if` ladders, and don't re-check the same data downstream.

The canonical example is the gateway's env config (`apps/gateway/src/config.ts`):

```ts
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OPENFANG_BASE_URL: z.string().url().default("http://localhost:4200"),
  OPENFANG_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration for: ${fields}`);
  }
  return parsed.data;
}
```

Points to carry forward:

- **Derive the type from the schema** (`z.infer`), never maintain a parallel
  `interface` that can drift.
- **`safeParse` at boundaries you control the failure message for** (config,
  incoming HTTP bodies); surface *which fields* failed without dumping raw
  input or secrets.
- **Use `z.coerce` and `.default()`** to normalize env/query strings rather than
  parsing by hand.
- **Validate boundaries, then trust the parsed value.** The DB schema notes that
  the `boards.columns` JSON shape (`BoardColumn[]`) is guarded by a Postgres
  CHECK *and* "should also be validated with Zod on every write path"
  (`apps/gateway/src/db/schema.ts`) — validate JSON on the way in, don't
  re-validate it on the way out.

The frontend ships the form-validation stack — `zod`, `@hookform/resolvers`,
`react-hook-form` (the shadcn `components/ui/form.tsx` primitive) — but no form
wiring uses it yet (demo data was stripped from the Circle import). When form
validation lands, use `zodResolver` with a Zod schema per form; keep the schema
as the single source of truth for both validation and the inferred field type.

## Error handling

**Gateway — one error envelope, one central handler.** All errors leave the API
in the shape `{ error: { code, message } }` and are produced centrally in
`apps/gateway/src/app.ts`, not scattered through routes:

```ts
app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404),
);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    logger.warn({ err, status: err.status }, "request error");
    return err.getResponse();               // preserve the intended status
  }
  logger.error({ err }, "unhandled error");
  return c.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
});
```

Rules that follow from this:

- **Throw `HTTPException` for expected client errors** (bad input, not found,
  unauthorized) so the status is preserved. Never `throw new Error()` for a
  situation that should be a 4xx — that collapses to 500.
- **Never leak internals in a 5xx.** Unexpected errors return the generic
  `INTERNAL` envelope; the real error is logged, not returned. There is a
  regression test asserting a thrown internal detail does **not** appear in the
  response body — keep it passing.
- **Log with structure, and redact.** Pino is configured with a fixed `base`
  (`service`, `env`) and redaction of `authorization` and `cookie` headers
  (`apps/gateway/src/logger.ts`). Log objects (`logger.error({ err }, "msg")`),
  not string-concatenated messages, and never log secrets, tokens, or full env.
- **Error `code`s are stable, `SCREAMING_SNAKE_CASE` strings** (`NOT_FOUND`,
  `INTERNAL`). Treat them as part of the API contract; add new ones
  deliberately.

**Frontend — throw at the fetch seam, surface to the user.** `frontend/lib/api.ts`
centralizes gateway calls: `apiFetch` throws on non-2xx, and `apiUrl` throws
early when the gateway isn't configured (`isApiConfigured`). Call through
`apiFetch`, don't hand-roll `fetch`. `sonner` is available for user-facing toasts;
surface a friendly message and let the thrown error carry the detail for logging.

## Testing

**Gateway — `bun:test`, and test the real thing.**

```sh
cd apps/gateway
bun test
```

Conventions drawn from the existing suite:

- **Co-locate or use `tests/`.** Unit/regression tests sit next to the code as
  `*.test.ts` (`src/db/schema.constraints.test.ts`); endpoint tests live under
  `tests/` (`tests/health.test.ts`). Either is fine — match what's nearby.
- **Exercise the real app, not internals.** Endpoint tests build the actual app
  via `createApp()` and drive it with `app.request(...)`. The `onError`
  regression tests register throwing routes on a real `createApp()` instance
  rather than mocking the handler — that's deliberate (`test(gateway): exercise
  real createApp() in onError regression tests`).
- **Assert behavior *and* the negative.** The 500 test asserts the status *and*
  that the internal detail is absent from the body. When you fix a bug, add the
  test that would have caught it, and name it after the guarantee.
- **Skip cleanly when a dependency is absent.** DB integration tests use
  `const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;`
  so a plain `bun install && bun test` on a fresh checkout stays green with no
  Postgres. Any test needing external infrastructure must self-skip the same way.
- **Shared test helpers over `!` and clever casts** — e.g. `must<T>()` and
  `expectRejects()` for Drizzle's thenable query builders. Reuse them.

**Frontend — no automated test harness yet.** There is no test runner wired in
`frontend/package.json`; the current gates are `bun run lint` (ESLint) and a
successful `bun run build` (`next build`, which type-checks). Until a harness
lands, verify UI changes by running `bun run dev` and confirming the affected
view, and keep the build and lint green. Don't claim test coverage the repo
doesn't have.

## Commits

Use **Conventional Commits with a scope and the issue reference**, which is the
dominant style already in the history:

```
type(scope): imperative summary (BERR-NN)
```

- **Types in use:** `feat`, `fix`, `docs`, `test`. Add others from the
  Conventional Commits set (`chore`, `refactor`, `build`, `ci`) as needed.
- **Scope** is the workspace or area, e.g. `feat(gateway): …`. Docs-only commits
  are typically scope-less: `docs: add product brief (BERR-9)`.
- **Reference the issue** as `(BERR-NN)` in the subject. Merge commits append the
  PR number, e.g. `feat(gateway): Postgres schema + migrations (BERR-21) (#1)`.
- **Imperative mood, ~72-char subject.** Explain the *why* in the body when the
  change isn't self-evident (see `fix(gateway): backfill issue_counter …`).

One divergence exists in the history — the Circle import used a
`[BERR-28] summary` bracket prefix. **Standardize on the
`type(scope): summary (BERR-NN)` form going forward**; treat the bracket style
as legacy.

## Branches

- **Agent runtime branches are created for you** as `agent/<name>/<hash>`
  (e.g. `agent/scribe/788e3ec5c514`). Do your work on the branch the runtime
  checked out; don't rename it.
- **For hand-authored or follow-up branches**, use a type prefix and the issue
  slug: `fix/berr-NN-short-slug` (as in `fix/berr-28-review-findings`). Keep the
  issue number in the branch name so the branch, PR, and issue line up.
- **One issue per branch.** Don't stack unrelated work on a branch.

## Pull requests & the review gate

- **Small, single-concern PRs.** One issue, one focused change; keep the diff
  reviewable in one sitting. If a task naturally splits, split the PRs — the M0
  history is one PR per issue (`#1`, `#2`, `#4`, `#5`).
- **PR title mirrors the merge commit** (`type(scope): summary (BERR-NN)`). The
  body links the issue, states intent, and lists the verification you ran
  (typecheck / lint / tests, or the view you exercised for frontend work).
- **Review is the merge gate, and it's adversarial.** Each PR is checked by its
  assigned reviewer — **Sentinel** for frontend, **Backend PR Adversary** for
  backend. A review with **zero blocking findings** is merge authority.
- **Fix → re-review loop.** After addressing findings, request a **re-review from
  the same reviewer**, who re-checks the *full* PR (not just the delta). Repeat
  until a review returns zero blocking findings. Address review findings in
  follow-up commits on the same branch (`fix(gateway): address BERR-21 review
  findings …`).
- **Clean review means you merge and close out.** On a clean review the
  implementing agent merges the PR and moves the issue straight to **done** —
  the clean review *is* the completion signal, so skip `in_review`. The
  Release 1 human release gate is waived for this cycle.

### Definition of done

Before requesting review, confirm the workspace's gates are green:

- **Gateway:** `bun run typecheck` **and** `bun run lint` **and** `bun test` pass.
- **Frontend:** `bun run lint` **and** `bun run build` succeed; the changed view
  was exercised manually.
- The change is scoped to one issue, the branch/commit/PR reference `BERR-NN`,
  and no secrets or `.env` values are committed (`.gitignore` already excludes
  `.env*` except `.env.example`).
