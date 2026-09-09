# What the server answers, and how it was verified

The frontend reaches the API through `frontend/next.config.ts`, which proxies
`/api/*`, `/health` and `/ready` to `BERRY_API_ORIGIN`. There is one server, so
routing is no longer a decision — but what each mount was checked against still
is, and this file is that record.

See `SCOPE.md` for what was deliberately not reimplemented.

## Verified

These were compared response by response against captured baselines — bodies,
status codes and headers — for the same database.

| Prefix | Verified |
|---|---|
| `/health` | byte-identical |
| `/api/v1/me` | 33 probes — reads, writes, validation edges — body, status and headers |
| `/api/v1/workspaces` | 35 probes, including pagination, authorization and the last-owner rule |
| `/api/v1/tokens` | create/replay/conflict; issued secrets authenticate |
| `/api/v1/invitations` | 44 probes, plus 17 addresses at the email-validation boundary |
| `/api/v1/boards` | 31 probes, including the column-in-use guard in both directions |
| `/api/v1/projects` | 45 probes plus a full lifecycle; see the caveat below |
| `/api/v1/issues` | 38 probes on the read paths; cursors verified in both directions |
| `/api/v1/events` | 4,090 board frames and 196 workspace frames, byte-identical |
| the error envelope | byte-identical for 401 and 404, request id aside |

Timestamps written here carry millisecond precision where the previous
implementation carried microseconds, because Node's clock stops there. Ordering
is unaffected — the `(created_at, id)` cursor breaks ties on the id — but two
rows created in the same millisecond share a `created_at` where they would once
have been separated.

## Known gaps

| Prefix | State |
|---|---|
| `/ready` | probes `database` only. A deployment that also runs Valkey or an external dispatcher gets a narrower readiness report than it has. |
| `/metrics` | answers 404, and `capabilities.metrics` is false to match. Lands with the observability port. |
| `/api/v1/config` | honest but narrow: `planner`, `workflows` and `valkey` are reported false because this process does not provide them. |

## Linking a GitHub repository

Berry stores a repository's id beside its name, and resolves that id through
GitHub rather than trusting the caller — a supplied id could name a repository
the connection cannot see, and the stored pair would then disagree about where
the project delivers. A database constraint keeps the two columns together.

The resolver is implemented (`resolveRepository` in `mounts/projects.ts`). On
create and PATCH, a `githubRepo` (`owner/name`) is resolved through the same
credential the picker lists with — `githubToken()` + `GitHubClient`, App token
first, else the OAuth connection — and the id and name are written together.
The status codes are meaningful and distinct:

- **412 INTEGRATIONS_NOT_CONFIGURED** — no encryption key, so no credential can
  be held; nothing can resolve a repository here.
- **409 NOT_CONNECTED / CONNECTION_UNUSABLE** — a provider exists but has no
  usable credential (no App installed, or an absent/expired OAuth connection).
- **422 REPOSITORY_UNAVAILABLE** — the credential is fine but the repository
  cannot be resolved (missing, or unseen by this credential).
- **502 PROVIDER_ERROR** — a transient GitHub failure, worth retrying.

None of these writes a half-link, so a project never ends up in a broken state.
Clearing the link (`githubRepo: null`) needs no resolver and always succeeds.

## Agents: rows, not a projection

`GET /api/v1/agents` used to reconcile against an external runtime on **every**
request — a workspace sync before the listing was read, erroring rather than
degrading when the runtime was absent. The agent list was a live projection of
another process's state, not a table. It is a table now.

`GET /`, `GET /{id}` and `GET /capabilities` are identical to what they were,
verified against the same rows. Two routes are new, because a rows-only agent
needs them and a projected one never did:

| route | why it is new |
|---|---|
| `POST /` | agents used to be spawned in the runtime and discovered by sync, so Berry had no way to author one |
| `DELETE /{id}` | archives; the protected orchestrator refuses with 409 `AGENT_PROTECTED` |

`PUT /{id}/config` keeps its request and response, and changes what it does.
The configuration used to be pushed to the runtime **before** being stored, so
a save meant the runtime had accepted it. There is no upstream now, so storing
it *is* the operation — and the model is written to the row, which never used
to happen: it was read back from the runtime after being pushed. A save that
did not store it would silently do nothing.

`POST /{id}/ask` is absent. It was a chat completion passed through to that
runtime, nothing in the product calls it, and what it should mean now is its
own decision.

### `GET /models` is smaller on purpose

| | |
|---|---|
| before | 458 models: 417 from OpenRouter, plus 41 compiled into the runtime for `anthropic`, `codex`, `groq`, `ollama`, `openai`, `lmstudio`, `vllm` |
| now | 417 models, all OpenRouter's |

Berry has exactly one model client and it talks to OpenRouter. An agent pointed
at `anthropic/claude-sonnet-4-6` — a real entry in the old list — would fail on
its next task, because OpenRouter has never heard of that id. The old catalogue
offered models that could not run. Every stored pairing in the database is
already `openrouter/…`, so nothing depends on the dropped providers.

The prefix-stripping quirk is kept (`openrouter/anthropic/claude-sonnet-4` →
`anthropic/claude-sonnet-4`), because stored pairings still carry it and
dropping it would make every one of them read as unavailable.

## What issues still needs

| | |
|---|---|
| goal linking | `applyGoalChange` when a create or patch names a goal |
| assignee validation | that the actor exists *in this workspace* |
| the approval boundary | `ErrApprovalRequired` on a gated board |

## The event streams

`GET /api/v1/events` is one stream per board and one per workspace, and the
split matters: a board stream carries what happens on that board, while a
workspace stream carries facts belonging to no board at all — goals, workflows,
approvals, plans.

It replays from `outbox_events` and is only *woken* by Valkey. That is why it
can carry events for lanes this server does not otherwise implement: those are
rows in a table it can read, not state in a process it would have to talk to.
It is also why the relay being unwired costs latency rather than facts — the
500ms poll finds everything, just later.

Verified by comparing whole streams: 4,090 board frames and 196 workspace
frames byte-identical, resume from `after` and from `Last-Event-ID` identical,
and the heartbeat cadence the same over a 25-second idle window.

## Goals reach across the unimplemented line, deliberately

`GET /goals/:id/workflows`, `/approvals` and `/plans` read tables no mount here
owns — automations and approvals belong to AUTOMATE, plans to the planner. They
are served for the same reason the event stream is: they depend on those
**tables**, not on that code. A goal has to be able to say what points at it
without owning any of it.

The same argument does not extend to writing any of them. Nothing here creates
an automation, decides an approval or compiles a plan.

## The presigned download URL that did not work

`GET /api/v1/attachments/:id/download-url` returns a URL the browser can fetch
the bytes from directly, so a download does not stream through Berry. The
previous implementation's URL was rejected:

```
400 AccessDenied — There were headers present in the request which were not signed
```

Verified against the same object, from inside the compose network, with a
minimal client sending no headers of its own. The difference is visible in the
query itself — the AWS SDK signs `X-Amz-Content-Sha256`, and the old URL
carried no equivalent.

Nothing had hit it because the product does not use this route: a listing's
`downloadUrl` points at `/download`, which streams through Berry. So it was a
latent fault on a route only an API client would reach, and it is fixed here
rather than reproduced.

## The escaping every mount was getting wrong

Go's `encoding/json` escapes `<`, `>` and `&` — for callers embedding JSON in
HTML — and escapes U+2028/U+2029, which `JSON.stringify` leaves literal. Every
ported mount had been emitting subtly different bytes since the first one
landed, and the fingerprints and captured baselines all assume the escaped
form.

Nothing caught it, because a contract diff only compares the data it is given
and none of that data happened to contain an ampersand. It surfaced when the
event stream was compared: 4,090 board frames, of which **three** differed, all
because an agent had written `Node 20 & 22` in a comment.

`goJSON` in `src/http/app.ts` applies the escaping to the finished text, which
is safe because none of those characters is JSON syntax — wherever one appears
in the output it is already inside a string literal. `json()` uses it, so every
mount was fixed at once.

Worth remembering as a method: a contract diff over a hand-picked path proves
less than one over a stream of four thousand real events.

## Running the database-backed tests

The ledger and artifact tests need a real PostgreSQL, because everything they
are for happens in the database: the sequence is allocated by a SQL function,
the ordering guarantee is microsecond arithmetic PostgreSQL performs, and the
jsonb column is where a wrongly-encoded envelope stops looking wrong.

They run against their own database rather than the development one. Not
fastidiousness: creating a workspace fires a trigger that provisions a
**protected** Orchestrator agent, and a protected agent refuses both deletion
and unprotection — so a fixture in the development database leaks a workspace
on every run and cannot tidy up after itself.

```
docker compose exec -T postgres sh -c \
  'createdb -U berry berry_test; pg_dump -U berry --schema-only --no-owner \
     --no-privileges berry | psql -U berry -d berry_test -q'

docker run -d --rm --name berry-pg-bridge --network berry-stack_default \
  -p 15432:15432 alpine/socat tcp-listen:15432,fork,reuseaddr tcp:postgres:5432

BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' \
  pnpm test:server
```

Without the variable the suite skips them and still passes, so `pnpm
test:server` works on a machine with no stack running.

Note that a host PostgreSQL on 5432 shadows the container's published port, and
a host Redis shadows 6379 the same way. A client pointed at either from the
host may not be talking to the container — hence the socat bridge above.
