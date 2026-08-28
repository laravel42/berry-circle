# The execution wire contract

What Berry sends this worker, and what comes back. This file is normative:
`server-ts/src/execution/` and `runtime-worker/src/` each carry their own copy
of these types because the two packages deploy separately, and this is the
description they both have to match.

A second driver — the local container runtime for self-hosted Berry — speaks
this same contract. Nothing here mentions Cloudflare, and nothing should.

## Transport

HTTPS, JSON in and out, one shared secret.

```
Authorization: Bearer <BERRY_RUNTIME_TOKEN>
```

Berry always calls the worker; the worker never calls Berry. That direction is
not incidental. A self-hosted Berry sits behind NAT and could not receive a
callback, so keeping the caller on Berry's side means one code path for both
drivers instead of a hosted-only inversion.

`/health` is the only unauthenticated route, and it reports reachability
without saying anything about the caller. Every other route answers `401`
without a valid token, and `503` if the worker has no token configured — an
unconfigured secret fails closed, because the alternative is an open remote
shell.

## Routes

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | — | `{ "status": "ok" }` |
| `POST` | `/sessions` | `{ runId, cwd?, env? }` | `{ sessionId }` |
| `POST` | `/sessions/:id/exec` | `{ command, cwd?, env?, timeoutMs? }` | `{ stdout, stderr, exitCode }` |
| `POST` | `/sessions/:id/exec/stream` | same as `exec` | `text/event-stream` |
| `PUT` | `/sessions/:id/files` | `{ path, content }` | `{ written: true }` |
| `GET` | `/sessions/:id/files?path=` | — | `{ content }` |
| `POST` | `/sessions/:id/stop` | — | `{ stopped: true }` |
| `DELETE` | `/sessions/:id` | — | `{ destroyed: true }` |

`sessionId` is Berry's run id. One run, one workspace: a retried request
reaches the workspace the run was already using rather than a fresh one.

`cwd` may be relative. A substrate resolves it against its own workspace root,
so a caller can say `repo/packages/api` without knowing where that root is —
and Docker rejects a relative working directory outright, so resolving is what
keeps the two substrates interchangeable rather than subtly different.

`timeoutMs` bounds a single command. A substrate applies its own default when
one is not given: an unbounded command holds a container open until something
else reaps it, so "no ceiling" is not a state either substrate offers. A
command stopped this way reports a non-zero exit like any other failure.

`env` is scoped to the single command and does not persist into the container.
That is load-bearing: it is how a credential reaches `git` without becoming
readable by the commands an agent runs afterwards.

`stop` kills what is running and leaves the workspace intact, so a stopped
run's output can still be read. `DELETE` is what destroys it, and Berry calls
it on the failure path too.

## Status codes

| Code | Meaning to Berry |
|---|---|
| `2xx` | The substrate did what was asked. A command that exited non-zero is still a `200` — a failing test suite is a result, not an error. |
| `400` | Berry sent something wrong. Not retryable. |
| `401` / `503` | Credential missing or wrong. Not retryable without an operator. |
| `404` | Unknown session. Tolerated on `DELETE` so cleanup cannot mask the real reason a run failed. |
| `429` / `5xx` | The substrate is having a bad time. Retryable. |

Berry raises `ExecutionUnavailable` for the retryable set and `ExecutionFailed`
for the rest, because "the run failed" and "the run could not start" are
different facts and only one of them belongs on an agent's record.

## The event stream

`text/event-stream`, one JSON object per frame, the whole event in `data`:

```
data: {"type":"start","seq":0,"command":"pnpm test"}

data: {"type":"stdout","seq":1,"data":"84 passed\n"}

data: {"type":"exit","seq":2,"exitCode":0}

```

Self-describing frames rather than an `event:` line: a frame stays readable
after being logged, replayed, or pasted into a bug report, and there is only
one thing to parse.

| `type` | Fields | Notes |
|---|---|---|
| `start` | `seq`, `command` | The command as the substrate received it. |
| `stdout` | `seq`, `data` | Never empty — an empty chunk is not a ledger row. |
| `stderr` | `seq`, `data` | |
| `exit` | `seq`, `exitCode` | Terminal. |
| `error` | `seq`, `message` | Terminal. |

`seq` is monotonic from `0` within one stream. Today Berry writes events
straight to `run_events`; when the buffering session lands, the same number is
the resume cursor. Emitting it now costs nothing and means the format does not
have to change later.

**A stream must end with `exit` or `error`.** If it does not, the worker emits
an `error` frame saying so, and Berry raises rather than accepting the run as
finished. A truncated stream read as a success would record a run as complete
with an exit code nobody sent — which is how a failing change gets approved.

Unknown `type` values are ignored by both sides, so the format can gain one
without breaking an older reader.

## Constraints worth knowing

- **The container image is fixed at deploy time.** Cloudflare binds the image
  to the Worker, not to the request, so an agent's "runtime image" can only be
  chosen from images declared in `wrangler.jsonc`. Supporting a second
  toolchain means a second container class and a second binding.
- **No nested containers.** `docker` cannot run inside the sandbox.
- **Every call is one subrequest**, and a Worker request is capped at 1,000 on
  the paid plan. Prefer one streamed command over many small `exec` calls.
- **Instance size matters.** The SDK's default `lite` is 1/16 vCPU and 256 MiB,
  which cannot install a dependency tree. `wrangler.jsonc` asks for
  `standard-2`; a Playwright suite wants `standard-3`.
