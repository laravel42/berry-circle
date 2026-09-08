# Answering the planner's questions

- **Status:** Implemented 2026-09-06 on `goals-as-derived-task-groups`, uncommitted.
- **Date:** 2026-09-06
- **Related:** `server-ts/src/plans/{schema,generator,answers,repository}.ts`,
  `server-ts/src/mounts/plans.ts`, `server-ts/migrations/043_plan_answers.up.sql`,
  `frontend/components/common/plans/plan-questions-wizard.tsx`,
  [ADR-0009](../../adr/0009-typescript-product-server.md)

## Context

Berry's planner may decline to plan. When a request is too vague, the generate
prompt tells it to raise a **blocking assumption** whose description is the
question it needs answered, and to propose no tasks. The validator then ranks
the plan `blocked` — above `invalid`, deliberately, because a plan waiting on
an answer is not a wrong plan.

Every part of that worked. The part that did not exist was answering.

Observed on project `99a8cdc5` ("Email classification"), created 18:16:14 on
2026-09-06. One planner call produced a goal, zero tasks, and three
assumptions, one blocking:

> What email volume and latency requirements do you have (e.g., <500ms for
> real-time vs batch processing)?

The plan sat at `validation_status = blocked`, `current_version = 1`, with no
way forward. Three layers each stopped short of the same thing:

1. **No route.** The plans mount offered `generate`, `:planId`, `versions`,
   `events`, `validate`, `approve`/`compile` and `reject`. `ValidationReport`
   computed `ambiguities` and nothing consumed them but the page.
2. **No control.** `PlanBlockedQuestions` rendered the questions as a static
   list and said so in its own docstring — *"answering arrives with
   conversational editing"* — advising the reader to reject the plan and ask
   again with the details filled in.
3. **A dead field.** `PlanAssumption.userEditable` was parsed by the server and
   by the frontend's zod schema, and read by neither.

The advised workaround worked but cost the whole prompt: the blocked panel had
no button, unlike the generation-failure panel beside it, which offers "Plan
again" pre-filled from `sourcePrompt`. The prompt in question was 284 words,
and `sourcePrompt` was on the record the whole time.

## Decisions

Four, each taken deliberately over a named alternative.

### 1. The planner emits the options

A picker needs concrete options; the planner emitted only prose. The options
now come from the same model call that raises the question, carried in the IR:

```json
{ "id": "a1", "blocking": true, "description": "What email volume?",
  "options": [ { "id": "a1-o1", "label": "Nightly batch",
                 "detail": "Throughput over latency" } ] }
```

*Over a second clarifier call*, which would have worked on already-blocked
plans without touching the prompt, but costs a round-trip on every blocked plan
and adds a failure mode of its own. The planner is the only party that knows
why it is asking, so it is the party that should say what it would accept.

The cost is that plans generated before this change carry no options. That is
handled rather than migrated: see *Backward compatibility*.

### 2. Regeneration in place, as a new version

Answering re-runs the whole pipeline on the same plan row. `recordGeneration`
already bumps `current_version` and writes the prior document to
`plan_versions`, so v1 stays readable and the URL never changes.

*Over a targeted repair pass*, which would keep the goal and fill in tasks
more cheaply. Rejected because the question was blocking precisely when the
answer could change the plan's shape — "nightly batch" and "real-time under
500ms" are not the same goal, and a repair pass would under-react to the
difference. Confirmed in practice: answering plan `a3632cab` rewrote its goal
from "Design and implement a complete email classification system" to "…a
**batch** email classification system … with **OpenRouter** LLM integration,
processing **50k emails nightly**".

*Over rejecting and generating afresh*, which needs no version handling but
changes the URL, leaves the blocked plan as clutter, and severs the link
between the question and the answer that resolved it.

### 3. The continuation runs on the server

Once the answers produce a valid plan, the server compiles it and routes the
tasks — regenerate → compile → triage → auto-run — without waiting to be asked
again.

*Over the browser orchestrating it*, which would have reused the existing
`useAutoStartPlan` effect and written less server code. Rejected on a specific
defect: that effect lives in a React `useEffect`, so closing the tab after
answering would silently cancel everything, with no error because nothing
failed. Answering three questions is a commitment, and a commitment a closed
laptop revokes is not one.

*Over a synchronous request*, which would simplify the client but hold a
connection open through several model calls. Measured on the two plans below:
the first generation took 3.7 s, a regeneration 15-18 s, its critic pass 1-3 s,
and compile-plus-routing another 22-25 s — roughly 40-50 s from submitting
answers to agents running. It would also discard the staged progress UI that
already works.

### 4. Blocking questions required, the rest optional

The wizard asks blocking questions first and requires them; non-blocking
assumptions follow as skippable steps.

A blocking question left unanswered would regenerate into the same blocked
plan, which reads as the wizard having done nothing — so the route refuses it.
A skipped optional question is a legitimate outcome: the assumption stands, and
the plan already says so. The plan that prompted this work carried two
non-blocking questions — about LLM providers and about privacy — whose answers
would have changed it, and which the old UI never offered.

## Architecture

### Data

`plan_answers` (migration `043`), one row per question per round:

| Column | Why |
|---|---|
| `assumption_id` | The IR id (`a1`). Not a foreign key — the IR is a document. |
| `question` | Snapshotted. The version that asked is replaced by the regeneration this answer causes; an answer whose question cannot be recovered is not an audit record. |
| `answer` | The option's label and detail, or the typed text. |
| `chosen_option` | The option id, or null when typed. |
| `answered_by` | Answering starts agents, so this is an authorisation record. |
| `for_version` | The version answered, not the one produced — that does not exist yet. |

**The rows live outside `plans.ir` for a load-bearing reason:** answering
regenerates the plan, and regeneration replaces the IR. Answers stored in the
document they produce would be destroyed by the act that caused them.

Append-only, with `plan_answers_round_key` unique on
`(plan_id, for_version, assumption_id)`. A resubmitted round — a double-clicked
wizard, a retried request — is the same answers arriving twice and must not
become two rows the planner reads as contradicting itself.

`plan_versions.origin` stays `'generated'`: this *is* a generation, and the
existing check constraint already permits it. No constraint migration.

### Flow

```
POST /api/v1/plans/:planId/answers        202 + Location
  │
  ├─ resolveAnswers(plan, submitted)      words come from the plan, not the client
  ├─ unansweredBlockers(...)              refuse if a blocking question was skipped
  ├─ answers.record(...)                  durable before anything acts on it
  ├─ plans.reopenForGeneration(planId)    claims the work; false → 409 PLAN_BUSY
  │
  └─ (background) regenerate
       ├─ generator.generate({ prompt, answers })
       ├─ plans.recordGeneration(...)      → v2, prior version kept
       ├─ not valid? stop — the planner asked something new
       ├─ plans.compile(...)               → tasks, approvals, gates
       └─ routeCompiled(...)               → triage assigns, unblocked tasks run
```

### Boundaries

- **`plans/schema.ts`** — what an option is and how one is read. Pure, offline,
  deterministic.
- **`plans/answers.ts`** — turning a submission into a record. Pure resolution
  (`resolveAnswers`, `unansweredBlockers`) separated from storage
  (`PlanAnswerRepository`), so the rules are testable without a database.
- **`plans/generator.ts`** — `withAnswers(prompt, answers)` composes the
  request. Exported and tested on its own.
- **`mounts/plans.ts`** — the route and the `regenerate` continuation.
- **`plan-questions-wizard.tsx`** — one component, driven entirely by
  `record.plan.assumptions`.

The wizard reads `plan.assumptions`, not `validation.ambiguities`: the latter
is filtered to blocking questions and is the validator's summary, not a UI
feed. One list, carrying both kinds, with `blocking` distinguishing them.

### Trust

An answer's words come from the plan whenever an option was picked. The client
sends `optionId`; the server looks up the label and detail in the document. A
client cannot record that someone chose "nightly batch" while the planner is
told "real-time". Typed text is the only answer whose words come from outside,
and the only one where they should.

### Error handling

| Case | Behaviour |
|---|---|
| Blocking question skipped | `422` naming each unanswered question |
| Unknown assumption or option | `422` |
| Same question answered twice in one submission | `422` — taking the last would silently discard the other |
| More than 20 answers in one submission | `422` |
| Plan already compiled | `409 PLAN_NOT_OPEN` — regenerating under running agents |
| Regeneration already running | `409 PLAN_BUSY`, from `reopenForGeneration` |
| No model credential | `412 PLANNER_UNAVAILABLE` |
| Regeneration fails | `recordGenerationFailure`; plan keeps its previous version |
| Still blocked after answers | Recorded normally; the wizard reopens. A new question is a legitimate outcome, not a failure |
| Compile fails after a good generation | `recordCompileFailure`, logged separately — a plan that planned and failed to start is a different thing to fix |

The compile is outside the generation `try` for that last reason: reporting a
compile failure as a generation failure sends someone to the wrong place.

### Backward compatibility

Options are read leniently, and their absence is not a defect:

- No `options` key, or a non-array, yields `[]` — which is what every plan
  generated before this change reports. Those render as free-text steps.
- A bare string is read as a label.
- Unlabelled entries and duplicate ids are dropped rather than failing the
  document. *A plan is not invalid for being asked badly.*
- A single option is discarded: offering one asks a person to confirm the
  planner's guess, which the blocking question already declined to do.
- Capped at six options, 120-character labels, 300-character details. The count
  is a UI promise as much as a limit — a picker is a picker at four options and
  a form at forty.

Verified live: plan `a3632cab`, generated before this work, opened its wizard
with three free-text questions and completed the full chain.

## Testing

Twenty-one new unit tests, all offline; 363 pass in total.

- `schema.test.ts` — nine on reading options: bare strings, missing keys, lone
  options, unlabelled entries, duplicate ids, generated ids, the cap, non-lists.
- `answers.test.ts` — twelve on resolution: an option's words come from the
  plan, detail travels with label, a client cannot override a picked option's
  text, typed answers, unknown question, unknown option, empty answer, double
  answer, optional skipping, blocking skipping, and prompt composition.

End-to-end against the running stack, twice:

| | `a3632cab` (pre-options) | `d8c13451` (with options) |
|---|---|---|
| v1 | blocked, 0 tasks | blocked, 0 tasks |
| Answers | 2 typed, 1 skipped | 1 picked, 1 typed, 1 picked |
| v2 | valid, 13 tasks | valid, 12 tasks |
| Routed | assigned 13, started 3 | assigned 12, started 1 |

Both goals were visibly reshaped by the answers. `chosen_option` was recorded
for picked options and null for typed ones. `BER-115`, gated by
`requiresApproval`, was created in `backlog` and not started.

## Two corrections to what was believed

**There is no plan-level approval gate.** The auto-compile decision was taken
partly on my statement that high-risk plans divert to `pendingApproval`.
Nothing in the server sets `pending_approval`. `compile` checks only that the
plan is not generating, is open, has an IR, validates, and has a board.
`startPlanBlocker` is browser-side and duplicates those checks. The gate that
does exist is per-task: `requiresApproval` creates a task as `backlog` rather
than `todo`, so triage will not run it. That is a real gate and it fired in
testing — but it is narrower than described when the decision was made.

**No `plan.*` event has ever been emitted.** `plan.generated`, `plan.updated`
and `plan.blocked` appear in `realtime/replay.ts`'s list of known topics and
are published by nothing; the plans repository never writes to `outbox_events`.
`use-plan.ts` polled only while the stream was *down* — connected, it read once
and waited for events that never came. Plan pages therefore went stale on any
generation, not only this one. Observed directly: the page sat on "v1 · 0
tasks" while the database held v2 with 13 tasks and a succeeded compile.

Fixed narrowly: `use-plan.ts` now polls whenever the plan is live, connected or
not, and its comment says why. **The proper fix is to emit plan events from the
repository**, which would also serve the goals and projects pages; it is not
done here because it touches shared realtime plumbing beyond this feature.

## Deliberately not done

- **Plan events in the outbox.** See above. This is the recommended follow-up.
- **Answering a plan that has already started.** Refused with `409`.
  Regenerating under running agents needs a story for the work already done.
- **Editing an assumption's text.** `userEditable` remains parsed and unread;
  the wizard answers questions rather than rewriting the planner's statements.
- **A per-workspace cap on rounds.** Nothing bounds how many times a plan may
  be answered and regenerated. Each round is a person's deliberate action, so
  this is a cost question rather than a loop risk.

## Open question

Berry records consequential decisions as ADRs. Decision 3 — that answering
carries through to running agents without a further click — sits against the
principle stated in the plans mount's own docstring, that *"nothing is created
until a person presses Start Plan"*, and is worth an ADR rather than only a
spec. Not written, because adding to the decision log is a decision of its own.
