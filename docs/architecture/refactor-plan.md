# Architecture Refactor Plan

Status: **proposal, awaiting review.** Nothing structural has been moved. This
document is the output of a discovery pass on branch
`refactor/architecture-clarity`. It exists to be argued with before any code
moves.

The engagement brief asked for "a complete architecture refactor using only
best practices." The brief's own rules also say: stop after producing the plan
and inspect it critically; do not mechanically move everything; ADRs and
documented conventions take precedence unless clearly obsolete; preserve
behavior, the public API, the database, migrations, environment contract, and
Docker. This plan honors the second set of instructions over the first. Where
the brief's generic advice collides with something this repository decided on
purpose, the collision is written down rather than silently resolved.

The short version: **the server architecture is already sound.** The layering
the brief flags as a "smell" (`mounts/` over domain repositories) is the
layering the coding playbook explicitly prescribes. Infra dependency direction
is clean. There are no runtime import cycles. What is actually worth changing
is small, local, and mostly type-only. The frontend has more genuine
scatter, but even there the fix is consolidation within the existing scheme,
not a folder reorg.

---

## 1. Current architecture, from the source

### 1.1 Repository shape

One Git repository, four independent packages, no shared toolchain and — this
matters for everything below — **no cross-package workspace dependency today.**

| Package | Path | Role | Imports |
| --- | --- | --- | --- |
| `berry-frontend` | `frontend/` | Next.js App Router UI | `@/*` alias, Zod v3 |
| `@berry/server` | `server-ts/` | Product server, migrations, agent runtime | relative `.ts`, no aliases, no barrels, Zod v4 |
| `@berry/runtime` | `runtime/` | Local container execution driver (Docker socket) | relative `.ts` |
| `@berry/runtime-worker` | `runtime-worker/` | Cloudflare Worker execution driver | relative `.ts` |

The server runs its `.ts` sources directly under
`--experimental-strip-types`. There is no build step, so nothing that emits
runtime code is allowed (`erasableSyntaxOnly`): no enums, no namespaces, no
parameter properties. `strict` is on, `any` is banned except in the vendored
`frontend/components/data-table-filter/**`.

Docker Compose builds `berry-api` from `./server-ts` and `runtime` from
`./runtime`. `runtime-worker` and the orphaned `apps/gateway` are not in the
Compose stack.

### 1.2 Server layers (`server-ts/src/`)

The server is layered, and the layers hold. Read top to bottom is the request
direction:

```
HTTP entry     mounts/ ──────────────► parse & serialize, one disjoint prefix each
                  │  (uses http/ kernel: registry, body, cursor, errors, idempotency)
                  ▼
domain         core/ + runs/ plans/ approvals/ inbox/ conversations/ agents/ …
                  │  product rules; repositories guarded by identity/roles + identity/errors
                  ▼
infra          db/pool.ts (the Sql substrate) · storage/ · realtime/ · observability/
```

- **`http/` is a coherent HTTP kernel**, not a grab-bag: `registry.ts` (the
  `Mount` type), `body.ts`, `cursor.ts` (pagination contract), `errors.ts`
  (error envelope contract), `canonical-json.ts`, `idempotency.ts`,
  `idempotent.ts`, `validation.ts`, `request-id.ts`, `app.ts`. Nearly every
  mount depends on it; that is correct.
- **`core/` is the product-entity domain**: `boards`, `issues`, `comments`,
  `dependencies`, `goals`, `projects`, `reviews`, `attachments`,
  `goal-linker`. Each is a repository over `db/pool.ts`, permission-guarded
  through `identity/`. Coherent, with one exception noted in §2.
- **Infra dependency direction is clean.** `db/`, `storage/`, `realtime/`,
  `observability/` import no domain code. A targeted search for infra importing
  any domain folder returned nothing. Domains reach `db/pool.ts` directly and
  pervasively — this is *by design*: `pool.ts` is the tagged-template `Sql`
  substrate, the domain repositories are the repository layer, and there is no
  ORM by decision. The direction is uniformly domain → infra, never the
  reverse.

### 1.3 Frontend layers (`frontend/`)

- `app/` — App Router routes and layouts.
- `components/` — mixed scheme: by-type at the top (`ui/`, `layout/`, `auth/`,
  `brand/`, `onboarding/`, vendored `data-table-filter/`), by-feature under
  `common/` (`issues/`, `runs/`, `projects/`, `plans/`, …). Feature folders
  also hold colocated hooks.
- `lib/` — the API seam. `lib/api.ts` exposes `apiUrl` / `apiFetch` /
  `apiStream` / `BerryApiError`; the session token lives only in a JS closure,
  never in storage, logs, or URLs. Every other `lib/*` module is a per-domain
  client over `apiFetch`.
- `store/` — ~34 Zustand stores; each store *is* its own hook.
- `hooks/` — cross-cutting hooks (workspace hydration, board event stream).
- `data/` — domain **types** and **pure helpers**. The demo *collection arrays*
  are emptied on purpose (`export const issues: Issue[] = []`); the modules
  themselves still carry live types and helper logic and are actively imported.

---

## 2. Problems worth fixing (grounded in paths)

Ranked by severity. "Direction" is the dependency arrow that is wrong.

| # | Location | Direction / issue | Severity | Correction |
| --- | --- | --- | --- | --- |
| P1 | `server-ts/src/core/goal-linker.ts:3` imports `type GoalLinker` from `../mounts/issues.ts` (interface defined at `mounts/issues.ts:66`) | domain → HTTP mount (layer inversion) | **Medium** | Move the `GoalLinker` interface into `core/` (e.g. beside `createGoalLinker`, or in `core/goals.ts`). `mounts/issues.ts` then imports it from `core/`. Type-only change, no runtime behavior. |
| P2 | `server-ts/src/agents/bedrock-chat.ts` imported by `plans/generator.ts`, `plans/triage.ts`, `editor/assist.ts`, `conversations/responder.ts` | shared LLM client living inside one domain but consumed by four | **Medium** | Relocate the Bedrock client to a shared home (`agents/` is the odd owner; a neutral module such as `llm/bedrock-chat.ts` or keeping it but documenting it as shared). Update 4 import sites + tests. Type/const-preserving. |
| P3 | Frontend filter logic duplicated: pure versions in `data/issues.ts` (`filterIssuesByCycle`, `filterIssuesByCategories`, …) and near-identical logic re-implemented in `store/issues-store.ts` (`filterByStatus`, `searchIssues`, `filterIssues`) | duplication / drift risk | **Medium** | Have the store call the pure helpers in `data/`; delete the store-local copies. Same output, one source of truth. |
| P4 | Frontend feature logic spread across `data/` + `lib/` + `store/` + `hooks/` + `components/common/<feature>/`; some components bypass the store and call `lib/` directly | scatter / unclear ownership | **Low–Medium** | Do *not* reorganize folders. Document the intended per-feature ownership (see §4) and, opportunistically, route reads through the store rather than direct `lib/` calls where it clarifies ownership. |
| P5 | `frontend/lib/projects.ts` → `generateProjectIssues` (plus `GeneratedIssue`, `generatedIssueSchema`) | dead code, zero importers | **Low** | Delete after a final reference check. (Note: `loadGitHubRepositories` in the same file is **live** — one importer, `repository-selector.tsx` — leave it.) |
| P6 | `mounts/account.ts`, `mounts/auth.ts`, `mounts/conversations.ts`, `mounts/plans.ts`, `mounts/workspace-reads.ts` hold a raw `Sql` / `toRFC3339` | possible business logic in the HTTP layer | **Low / audit-only** | Audit each for inline queries that belong behind a repository. Move only where a real query lives in the mount. Do not move mounts that legitimately compose reads. |
| P7 | `teamId` / `teamIds` on `Project` / `User` types (frontend `data/`, and server vestiges) | dead fields from the removed Crew module | **Low** | Type cleanup, out of scope for this pass unless requested — flagged for a separate typed-cleanup change. |
| P8 | `circular-deps.txt` at repo root is a crashed `madge` run (a `TypeError`, no data) | misleading artifact | **Trivial** | Delete it. It is noise, not a dependency report. |

Deliberately **not** on this list: the `agents ⇄ runs` and `agentcore ⇄ scm`
folder-level couplings. Both were checked and neither is a runtime import
cycle — the reverse edges resolve to different files that terminate. They are
cohesion observations, not defects, and untangling them is churn with no
correctness payoff.

---

## 3. Where the brief and the repository disagree

These are the load-bearing contradictions. Each is a case where following the
brief literally would break something the repository decided on purpose. They
are the reason this is a plan and not a commit.

### C1 — `mounts/` is not a smell; it is the prescribed layering

The brief treats the `mounts/` + domain-repository split as an anti-pattern to
collapse into feature modules. The coding playbook prescribes exactly this
split: keep HTTP parsing and serialization in `mounts/`, product rules in the
domain modules, persistence behind explicit repository boundaries, mounts
registered on disjoint prefixes. Discovery confirms the code follows the
playbook: mounts are thin adapters over `http/` + a repository.

**Recommendation: do not collapse `mounts/`.** Overriding a documented,
implemented convention on generic advice would be the opposite of "people must
understand the code logic" — it would make the code disagree with its own
playbook. If ownership is the concern, the lighter move is to keep the
disjoint-prefix registry and only colocate a route with its domain where doing
so demonstrably improves ownership. No such case rose to necessary in
discovery.

### C2 — The runtime protocol duplication is deliberate

`runtime-worker/src/protocol.ts` (`ExecEvent`, `CreateSessionRequest`,
`ExecRequest`, `WriteFileRequest`, `encodeFrame`) and `runtime-worker/src/auth.ts`
(bearer-token `authorize`, `constantTimeEqual`) mirror the server's
`execution/driver.ts` + `execution/events.ts` types. `runtime-worker/PROTOCOL.md`
states this is intentional: each package carries its own copy because the two
deploy separately and must not share a build. The server pins the shapes in a
test so a drift on one side fails the other.

The brief's "extract `packages/runtime-protocol`" would create the **first
cross-package dependency in the repository** and a shared build where there is
currently none — trading a documented, test-guarded duplication for new
coupling and a publish step.

**Recommendation: keep the duplication.** Preserve the drift-guard test. Do not
introduce a shared protocol package.

### C3 — `runtime` and `runtime-worker` are genuinely separate deployables

`runtime` drives a local Docker socket; `runtime-worker` is a Cloudflare
Worker. They are different substrates with different auth surfaces. The brief
agrees they stay separate; recorded here so a later reader does not "merge the
two runtimes."

### C4 — ADR-0008 / ADR-0009 have drifted from the code

The ADRs reference Temporal and OpenRouter. The current code has neither: runs
are dispatched **in process** by `runs/dispatcher.ts` with `SKIP LOCKED` and a
renewed lease, and the model provider is **Bedrock**. The ADRs are partly
historical.

**Recommendation:** this refactor does not change runtime behavior, so it must
not pretend to reconcile the ADRs by changing code. Flag the drift for a
docs-only ADR follow-up (a superseding ADR or an amendment), separate from this
work.

### C5 — The `/api/v1` wire contract is frozen

Cursors, idempotency fingerprints, the error envelope, opaque session tokens,
and `berry_pat_` tokens keep their exact shapes; `ROUTING.md` verifies mounts
byte-for-byte against captured baselines. Nothing in this plan touches the wire.
Every proposed change is internal (type location, module location, dead-code
removal, frontend dedupe). The mount **registration** (prefix → handler) is
unchanged.

---

## 4. Target architecture

The target is the current architecture, made explicit and with the four local
corrections applied. It is deliberately close to today's tree.

### Server dependency rules (unchanged intent, now written down)

1. `mounts/` may import `http/`, `auth/`, `identity/`, and a domain
   repository/service. Mounts do **not** contain product rules or raw
   multi-statement queries (P6 audit enforces this).
2. Domain folders (`core/`, `runs/`, `plans/`, …) may import `db/pool.ts`,
   `identity/`, `observability/`, and their own siblings. A domain folder must
   **not** import from `mounts/` (P1 fixes the one violation).
3. Infra (`db/`, `storage/`, `realtime/`, `observability/`) imports no domain
   code. (Already true.)
4. A shared cross-domain utility (e.g. the Bedrock client) lives in a neutral
   module, not inside one domain that happens to have been first (P2).
5. No path aliases, no barrels, relative `.ts` imports only. (Hard constraint.)

### Frontend ownership rules (written down, folders unchanged)

- `data/` owns types + pure helpers (single source of filter/sort logic).
- `lib/` owns API calls through `apiFetch`; business helpers may live here but
  should not be re-implemented in stores.
- `store/` owns state and calls `data/` helpers rather than re-implementing
  them (P3).
- Components prefer reading through the store over direct `lib/` calls where it
  clarifies ownership (P4, opportunistic).

---

## 5. Migration map

Every row is internal. No wire shape, DB schema, migration, env var, or Docker
context changes.

| Current path | Target | Reason | Risk | Deps affected |
| --- | --- | --- | --- | --- |
| `server-ts/src/mounts/issues.ts` (`GoalLinker` interface, line 66) | Move interface to `core/` (beside `createGoalLinker` or in `core/goals.ts`) | P1 — remove domain→mount inversion | Low (type-only, erased at runtime) | `core/goal-linker.ts`, `mounts/issues.ts`, `index.ts` (no logic change) |
| `server-ts/src/agents/bedrock-chat.ts` | Relocate to a neutral shared module (proposed `server-ts/src/llm/bedrock-chat.ts`) | P2 — shared client misplaced in a domain | Low–Medium (4 import sites + 1 test) | `plans/generator.ts`, `plans/triage.ts`, `editor/assist.ts`, `conversations/responder.ts`, `plans/generator.test.ts` |
| `frontend/store/issues-store.ts` local `filterByStatus`/`searchIssues`/`filterIssues` | Delete; call `data/issues.ts` helpers | P3 — duplicate filter logic | Low | `store/issues-store.ts` only (output identical) |
| `frontend/lib/projects.ts` `generateProjectIssues` (+ `GeneratedIssue`, `generatedIssueSchema`) | Delete | P5 — dead, zero importers | Low | none (verified) |
| `mounts/account.ts`, `mounts/auth.ts`, `mounts/conversations.ts`, `mounts/plans.ts`, `mounts/workspace-reads.ts` | Audit; move inline queries behind a repository only where found | P6 — possible logic in HTTP layer | Low, per-file | per-file; some may need no change |
| `circular-deps.txt` (repo root) | Delete | P8 — crashed madge output, misleading | Trivial | none |
| `apps/gateway/` (orphan, source already deleted, gitignored node_modules only) | Delete directory | cleanup — not in workspace or Compose | Trivial | none |

---

## 6. Explicitly NOT changing

- The `mounts/` layer and the disjoint-prefix mount registry (C1).
- Any `/api/v1` shape: cursors, idempotency, error envelope, tokens (C5).
- Database schema, `server-ts/migrations/*` (forward-only, immutable).
- The environment contract, including `INTEGRATION_ENCRYPTION_KEY` handling.
- Docker Compose contexts and Dockerfiles.
- The runtime ↔ runtime-worker protocol duplication and its drift-guard test
  (C2).
- The separation of `runtime` (Docker) and `runtime-worker` (Cloudflare) (C3).
- Server import style: relative `.ts`, no aliases, no barrels.
- Frontend folder layout (`data`/`lib`/`store`/`hooks`/`components`) — rules are
  documented, folders stay.
- The `teamId`/`teamIds` vestiges (P7) — deferred to a dedicated type cleanup.
- ADR reconciliation — deferred to a docs-only ADR follow-up (C4).

---

## 7. Phased plan

Each phase is independently verifiable and independently revertible. Verify the
server with `pnpm typecheck:server` + `pnpm test:server` (baseline: 446 pass, 1
skip) and, when it touches wiring, a local boot + `/health` + `/config`. Verify
the frontend with `cd frontend && pnpm lint && pnpm build:check`. Run
`python3 scripts/check-compose-config.py` if anything near Compose moves
(nothing here should).

- **Phase 0 — this document.** Discovery + plan. **Stop for review.** ← current
- **Phase 1 — trivial cleanup.** Delete `circular-deps.txt`, the `apps/gateway`
  orphan, and the dead `generateProjectIssues`. Zero behavior risk.
- **Phase 2 — server P1.** Move the `GoalLinker` interface into `core/`.
  Type-only. Verify server typecheck + tests.
- **Phase 3 — server P2.** Relocate the Bedrock client to a neutral module,
  update the 4 consumers + test. Verify server typecheck + tests + boot.
- **Phase 4 — frontend P3.** Point the issues store at the `data/` filter
  helpers, delete the duplicates. Verify lint + build:check + manual view.
- **Phase 5 — server P6 audit.** Per-mount audit; move inline queries behind a
  repository only where a real query exists. Verify per file.
- **Phase 6 (optional) — frontend P4.** Opportunistic ownership tidy-ups only
  where they clarify, no folder moves.

Commits follow `type(scope): summary (BERR-NN)`, one concern per commit,
scoped `server-ts` or `frontend`.

---

## 8. Recommendation

Approve Phases 1–4 as the substance of this refactor. They remove the one real
layering inversion, relocate the one misplaced shared client, delete confirmed
dead code, and collapse a genuine duplication in the frontend — all without
touching the wire, the schema, or the documented `mounts/` convention. Phase 5
is a bounded audit. Phase 6 is optional polish.

The larger moves the brief suggested (collapse `mounts/`, extract a shared
runtime-protocol package) are **not recommended**: they contradict the coding
playbook and the runtime deployment model respectively, and would add coupling
in the name of removing it. Documenting why is the more honest outcome for an
MIT project meant to be understood.

---

## 9. Execution outcomes

Recorded as the phases ran, including where the source contradicted the plan's
own assumptions. Each phase was verified and committed separately on
`refactor/architecture-clarity`.

- **Phase 1 — done.** Removed the dead `generateProjectIssues` (+ `GeneratedIssue`,
  `generatedIssueSchema`) from `frontend/lib/projects.ts` and the orphaned
  `apps/gateway/` (which held only gitignored `node_modules`). `circular-deps.txt`
  did not exist in the tree — it was an uncommitted artifact from an earlier
  discovery run, so P8 was moot. Frontend lint + build:check green.

- **Phase 2 — done.** Moved the `GoalLinker` interface from `mounts/issues.ts`
  into `core/goal-linker.ts`, beside the adapter that implements it. The
  dependency now runs mount → core. Type-only; typecheck clean, 446 pass / 1
  skip.

- **Phase 3 — done.** Moved the shared Bedrock client from `agents/bedrock-chat.ts`
  to `llm/bedrock-chat.ts` (with its test) and repointed all importers (plans,
  editor, conversations, and the two agents modules that use `AwsCredentials`).
  Git recorded both as 100% renames. Typecheck clean, 446 pass / 1 skip.

- **Phase 4 — done, but the plan's premise was wrong.** P3 assumed the issues
  store duplicated the pure filter helpers in `data/issues.ts` and could
  delegate to them. The source showed the opposite: the store's *live* filters
  (`filterByStatus`/`Priority`/`Assignee`/`Label`/`Project`, `searchIssues`) have
  component consumers and no `data/` counterpart, while the overlapping helpers
  were **dead on both sides**. Corrected action: deleted the confirmed
  zero-importer exports — `filterByCycle` + `filterIssues` (+ `FilterOptions`)
  from the store, and `filterIssuesByCycle` + `filterIssuesByCategories`
  (+ the now-unused `StatusCategory` import) from `data/issues.ts`.
  `sortIssuesByPriority` turned out to be live (used by `grouped-issues-view.tsx`)
  and was kept. Lint + build:check green.

- **Phase 5 — audited, no code change (by design).** The plan scoped this as
  "move inline queries behind a repository *only where a real query lives in the
  mount*", at low, per-file risk. The audit found:
  - `mounts/auth.ts` — the `sql.begin` wraps a call to
    `identity.createUserWithPassword(tx, …)`. The query is already behind the
    identity repository; the mount only owns the transaction boundary. **Not a
    violation.**
  - `mounts/workspace-reads.ts` — uses the scoped tenant-isolation query builder
    (`context.get('scoped')`, `q.scope` = a bound `workspace_id` predicate). This
    is a deliberate, security-critical read pattern tied to the
    `auth-and-tenant-isolation` work. **Left untouched** — moving it would risk
    the isolation guarantee for no clarity gain.
  - `mounts/plans.ts`, `mounts/conversations.ts` — small inline reads (a settings
    SELECT, an `oldestBoard` helper, an agent lookup). Real but minor.
  - `mounts/account.ts` — the one substantive violation: ~7 statements plus a
    transaction and conflict semantics (sessions, notification preferences,
    channels) living in the mount.

  **Decision: do not extract in this pass.** `account.ts` has no dedicated test
  coverage, there is no existing account repository to move it behind (extraction
  means a net-new persistence module, not relocating to a boundary that already
  exists), and it sits next to tenant-isolation code. Autonomously rewriting
  untested, security-adjacent persistence trades a documented cohesion smell for
  real regression risk — against the brief's rule on risky mechanical moves. The
  right sequencing is: add wire-level tests for `/api/v1/me/*` first, then extract
  an `AccountRepository` under test as its own reviewed change. Logged as
  **follow-up F1**.

- **Phase 6 — optional; see below.**

### Follow-ups (not done here)

- **F1** — Extract an `AccountRepository` from `mounts/account.ts` (and,
  optionally, fold the small reads in `plans.ts`/`conversations.ts` behind their
  repositories) once `/api/v1/me/*` has wire-level test coverage.
- **F2 (was C4)** — Reconcile ADR-0008 / ADR-0009 (Temporal + OpenRouter) with
  the implemented in-process dispatcher + Bedrock via a docs-only superseding or
  amending ADR.
- **F3 (was P7)** — Remove the `teamId`/`teamIds` Crew vestiges in a dedicated
  typed cleanup.
