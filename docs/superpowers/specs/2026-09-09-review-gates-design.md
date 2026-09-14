# Review gates: AutoGate and the human review page

Status: **implemented** (2026-09-09), branch `refactor/strands-native-runtime`.

## Problem

A successful run moved its task to `in_review` and nothing happened next. The
AutoGate peer reviewer that did this in the Go server was never ported; the
`issue_auto_reviews` table was read but never written. The Reviews page
rendered a hard-coded empty array and no `/api/v1/reviews` endpoint existed.
Compile did not carry a plan's AutoGate choice onto its tasks, so even a plan
that opted in produced tasks with `auto_gate = false`.

## AutoGate (`server-ts/src/agents/review-gate.ts`)

- **When.** After a run succeeds, the executor asks the gate. The gate
  decides for itself: the task must have opted in (or a person forced it),
  the run must have delivered a pull request, the task must still be in
  review, and the rejection budget must not be spent.
- **Who.** A peer: an agent in the workspace that is not the author and not
  the protected orchestrator, preferring one whose name or capabilities say
  "review". The database refuses author-as-reviewer (`issue_auto_reviews_peer_ck`).
- **What it reads.** The task, the author's summary, the checks that ran, the
  file list, and the pull request diff (tail-bounded at 120 KB), every
  untrusted block fenced and named as data.
- **Verdict.** Structured output: `approved`, `reason`, `findings[]`. Written
  to `issue_auto_reviews` (opened when the reviewer is picked, decided when it
  answers) and posted as a comment in the reviewer's name.
- **Outcome.** Approved moves the task to `done` through the issue's own
  transition, recorded with an agent actor. Rejected moves it to `todo` and
  re-admits the author, up to `BERRY_AUTOGATE_MAX_ATTEMPTS` (default 2)
  rejections; after that a person decides. The rejection reason reaches the
  next run through the prompt's existing review-feedback path.
- **On request.** `POST /api/v1/issues/:ref/reviews` reviews the latest
  delivered run now, opt-in or not.
- **Never merges.** Done means reviewed. The human release gate stands.

Verified live: four pull requests reviewed by `code-reviewer`; three approved
and moved to done, one correctly sent back because its first-attempt pull
request held only a lockfile, with the author re-admitted automatically.

## Human review page

- **API.** `GET /api/v1/reviews?workspaceId&state=open|completed` lists
  tasks at the gate with the run that delivered each: pull request, branch,
  the author's account, the checks, the changed files and every peer verdict.
  `GET /api/v1/reviews/:runId/diff` serves the pull request diff as text,
  cut at 1 MiB.
- **Decisions** are the task's own status transition: approve is `done`, send
  back is `todo`, with the note posted as a comment first so the timeline
  reads in order. No new write route.
- **UI.** `frontend/lib/reviews.ts` replaces the demo module; the page shows
  Waiting and Decided lists, an overview with the evidence, the verdicts, and
  the diff rendered per file through the existing `DiffView`. The sidebar
  badge counts what waits.

## Found along the way

A retried run's push was refused with "stale info": `--force-with-lease`
compares against a remote-tracking ref a fresh shallow clone does not have.
The branch is fetched before the push (`agents/delivery.ts`).

## Left for later

- Verdict findings are stored only in the comment; a structured findings
  table would let the page show them per file.
- The review list is read on demand; a board-stream topic for verdicts
  would update it live.
- `ReviewQueue` has no DB-backed test of its own; the endpoint was verified
  live and the gate's tests cover the rows it reads.
