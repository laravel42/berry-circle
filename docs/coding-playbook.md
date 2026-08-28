# Berry — Coding Playbook

*Expanded web direction · migration conventions*

The conventions every Berry contributor — human or agent — codes against.
Everything here is grounded in what is already in the repository; where a
convention is aspirational (a stack is installed but not yet exercised) it is
labelled as such. When code and this document disagree, fix the one that is
wrong and keep them in sync.

## Repository shape: one repo, two workspaces, two toolchains

Berry is a single Git repository with two independently tooled pnpm workspaces.
They do **not** share a formatter, lint config, or language target. The frontend
stays close to its upstream Circle template; the server is plain Node with no
build step. Know which workspace you are in before you write code.

| | `server-ts/` | `frontend/` |
| --- | --- | --- |
| What it is | Product server selected by [ADR-0009](adr/0009-typescript-product-server.md) | Next.js 15 App Router UI, vendored from Circle (MIT) |
| Runtime | Node 22, `--experimental-strip-types` | Node-compatible Next runtime |
| Language target | `ES2023`, strict, `erasableSyntaxOnly` | `ES2017`, strict |
| Imports | relative, `.ts` extensions kept | `@/*` → repo root |
| Format + lint | none configured; match surrounding style | **Prettier + ESLint** (`.prettierrc`, `eslint.config.mjs`) |
| Tests | `node --test` | none yet (see [Testing](#testing)) |
| Package | `@berry/server` | `berry-frontend` |

Because the workspaces use different formatters with different settings,
**never run one workspace's formatter over the other.** Style rules below are
stated per workspace.

## Server style

- The server runs its `.ts` sources directly, so nothing that emits code —
  enums, namespaces, parameter properties — is allowed. `erasableSyntaxOnly`
  enforces it; do not turn it off.
- Keep HTTP parsing and serialization in mounts, product rules in the domain
  modules, and persistence behind explicit repository boundaries.
- Mounts are registered on disjoint prefixes. The registry refuses two that
  could match the same path, checked at startup rather than discovered at
  request time.
- Map failures once at the HTTP boundary into Berry's stable error envelope;
  never return a raw database error to a client.
- Use explicit transactions for multi-row invariants and pass the transaction
  handle through the call — `withinTx` exists so a query cannot escape onto a
  different connection. PostgreSQL remains authoritative; Valkey loss must not
  change durable product facts.
- Migrations are forward-only and immutable. Never edit an applied migration;
  add a new one.
- Reused Multica material must cite the pinned source path and satisfy
  [the provenance audit](provenance/multica-server-reuse.md). Do not port daemon,
  launcher, provider, sandbox, or filesystem-execution code.

## TypeScript style

- **`strict` is on in both TypeScript workspaces. Keep it on.** Do not weaken
  `tsconfig.json` to make a type error go away; fix the type.
- **No `any`.** The frontend runs `next/typescript` and the server runs `tsc`
  under `strict` with `noUncheckedIndexedAccess`. Prefer precise types,
  `unknown` at untyped boundaries, and narrowing. The one place `any` is tolerated is the
  vendored `components/data-table-filter/**` tree, which is explicitly exempted
  in `eslint.config.mjs` to stay close to upstream — do not copy that exemption
  elsewhere.
- **Avoid non-null assertions (`!`).** Narrow instead. `noUncheckedIndexedAccess`
  is on in the server, so an indexed read is `T | undefined` and has to be
  handled rather than asserted away.
- **Import types as types.** The server sets `verbatimModuleSyntax`, so
  type-only imports must use `import type { … }` (or inline `type` specifiers,
  e.g. `import { type ClassValue, clsx } from "clsx"`). This is enforced by the
  compiler there and is the house style in the frontend too.
- **Use the path alias in the frontend** (`@/lib/utils`) rather than deep
  relative chains. The server uses relative imports throughout and keeps the
  `.ts` extension, because Node resolves the file that is actually there.
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

Run each workspace's own tools. Both target a 100-column line width but
otherwise keep their existing, different settings.

**Server** — no formatter is configured. Match the surrounding style (3-space
indent, single quotes) and rely on the type gate:

```sh
pnpm typecheck:server   # tsc --noEmit
pnpm test:server        # node --test
```

**Frontend** — Prettier + ESLint:

```sh
cd frontend
pnpm lint       # next lint (ESLint)
pnpm format     # prettier --write .
```

Prettier settings (`.prettierrc`): **3-space `tabWidth`**, single quotes,
semicolons, `es5` trailing commas, `printWidth` 100. A Husky `pre-commit` hook
runs `lint-staged`, which Prettier-formats staged `*.{js,jsx,ts,tsx,json,css,md}`
files, so committed frontend code is formatted automatically.

## Zod validation pattern

Zod is the validation library across the repo. The rule: **parse untrusted
input into a typed value at the boundary, then trust the type inside.** Don't
hand-validate with `if` ladders, and don't re-check the same data downstream.

The server's env config (`server-ts/src/config/config.ts`) reads the same
principle without Zod, because it must report *every* problem at once rather
than the first. The pattern below is the one to follow at request boundaries:

```ts
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  BERRY_OPENROUTER_API_KEY: z.string().optional(),
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
  CHECK *and* should also be validated on every write path — validate JSON on
  the way in, don't re-validate it on the way out.

The frontend ships the form-validation stack — `zod`, `@hookform/resolvers`,
`react-hook-form` (the shadcn `components/ui/form.tsx` primitive) — but no form
wiring uses it yet (demo data was stripped from the Circle import). When form
validation lands, use `zodResolver` with a Zod schema per form; keep the schema
as the single source of truth for both validation and the inferred field type.

## Error handling

**Server — one error envelope, one central handler.** All errors leave the API
in the shape `{ error: { code, message, requestId, details } }` and are produced
centrally in `server-ts/src/http/errors.ts` and `app.ts`, not scattered through
mounts.

Rules that follow from this:

- **Throw `ApiError` for expected client errors** (bad input, not found,
  unauthorized) so the status and code are preserved. Never throw a bare
  `Error` for a situation that should be a 4xx — that collapses to 500.
- **Never leak internals in a 5xx.** Unexpected errors return the generic
  envelope; the real error is logged, not returned.
- **Log with structure, and redact.** Log objects, not string-concatenated
  messages, and never log secrets, tokens, or a full environment.
- **Error `code`s are stable, `SCREAMING_SNAKE_CASE` strings** (`NOT_FOUND`,
  `INTERNAL`). Treat them as part of the API contract; add new ones
  deliberately. A code that does not match the status is downgraded rather than
  reported as given, so do not invent pairings.
- **The envelope is byte-stable.** Key order, the trailing newline, and
  `details: null` rather than an omitted field are all part of it.

**Frontend — throw at the fetch seam, surface to the user.** `frontend/lib/api.ts`
centralizes API calls: `apiFetch` throws on non-2xx, and `apiUrl` throws
early when the API isn't configured (`isApiConfigured`). Call through
`apiFetch`, don't hand-roll `fetch`. `sonner` is available for user-facing toasts;
surface a friendly message and let the thrown error carry the detail for logging.

## Testing

**Server.** `pnpm test:server` runs `node --test` over `src/**/*.test.ts`.
Database-backed tests must isolate their data and make their external
requirement explicit: they are gated on `BERRY_TEST_DATABASE_URL` and skip
without it, so the default suite stays offline and green. Mount tests drive the
real app through `app.request(...)` rather than calling handlers directly.
Assertions about the wire shape are pinned against captured responses, not
transcribed from the code that produces them.

Conventions drawn from the existing suite:

- **Co-locate.** Tests sit next to the code as `*.test.ts`.
- **Exercise the real app, not internals.** Mount tests build the actual app
  and drive it with `app.request(...)` rather than calling a handler directly.
- **Assert behavior *and* the negative.** The 500 test asserts the status *and*
  that the internal detail is absent from the body. When you fix a bug, add the
  test that would have caught it, and name it after the guarantee.
- **Skip cleanly when a dependency is absent.** Database tests self-skip on a
  missing `BERRY_TEST_DATABASE_URL` so a fresh checkout stays green with no
  Postgres. Any test needing external infrastructure must do the same.
- **Name the test after the guarantee**, not the function. The existing titles
  read as sentences — "a cursor minted for another collection is refused".

**Frontend — no automated test harness yet.** There is no test runner wired in
`frontend/package.json`; the current gates are `pnpm lint` (ESLint) and a
successful `pnpm build` (`next build`, which type-checks). Until a harness
lands, verify UI changes by running `pnpm dev:frontend` and confirming the
affected view, and keep the build and lint green. Don't claim test coverage the
repo doesn't have.

## Commits

Use **Conventional Commits with a scope and the issue reference**, which is the
dominant style already in the history:

```
type(scope): imperative summary (BERR-NN)
```

- **Types in use:** `feat`, `fix`, `docs`, `test`. Add others from the
  Conventional Commits set (`chore`, `refactor`, `build`, `ci`) as needed.
- **Scope** is the workspace or area, e.g. `feat(server-ts): …` or
  `feat(frontend): …`. Docs-only commits are typically scope-less:
  `docs: add product brief (BERR-9)`.
- **Reference the issue** as `(BERR-NN)` in the subject. Merge commits append the
  PR number, e.g. `feat(server-ts): serve goals (BERR-21) (#1)`.
- **Imperative mood, ~72-char subject.** Explain the *why* in the body when the
  change isn't self-evident.

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
  follow-up commits on the same branch (`fix(server-ts): address BERR-21 review
  findings …`).
- **Clean review means you merge and close out.** On a clean review the
  implementing agent merges the PR and moves the issue straight to **done** —
  the clean repository review *is* the contribution completion signal. This
  does not waive Berry's product rule that agent-delivered work requires human
  acceptance before release.

### Definition of done

Before requesting review, confirm the workspace's gates are green:

- **Server:** `pnpm typecheck:server` **and** `pnpm test:server` pass. If the
  change touches Compose or a deployment pin, `python3
  scripts/check-compose-config.py` and `python3 scripts/check-deploy-pins.py`
  pass too.
- **Frontend:** `pnpm lint` **and** `pnpm build` succeed; the changed view
  was exercised manually.
- The change is scoped to one issue, the branch/commit/PR reference `BERR-NN`,
  and no secrets or `.env` values are committed (`.gitignore` already excludes
  `.env*` except `.env.example`).
