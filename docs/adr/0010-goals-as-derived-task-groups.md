# ADR-0010: Goals are derived groups of a project's tasks

- **Status:** Proposed
- **Date:** 2026-09-01
- **Deciders:** Berry platform
- **Related:** [ADR-0009](0009-typescript-product-server.md) (TypeScript product
  server), `server-ts/migrations/038_goals_as_derived_groups.up.sql`

## Context

Berry has two things that look alike and are authored the same way. A project is
a long-lived container that names a GitHub repository. A goal is an outcome with
a title, a description and a lifecycle. Asked to start work, a person cannot tell
which one they are supposed to make, and the answer has never been written down.

The confusion is not only conceptual. Goals are mostly not authored at all — they
accumulate. A goal is minted when a plan is **generated**, and the duplicate
guard in `PlanRepository.create` sits inside `if (input.goalId)`, so a generation
that names no goal mints a fresh one every time. Reword a prompt and try again
and you have two goals. Abandon the plan and the goal stays.

The database shows the result. Every goal in it — all eight, across `draft`,
`planned` and one `completed` — groups **zero tasks**. The entire table is
residue from planning attempts. No goal has ever been re-planned, and no plan has
ever been compiled into tasks, so nothing has ever used the lifecycle those rows
carry.

Two further gaps follow from the same root. Nothing constrains a task's project
to match its goal's project — no constraint exists, and two code paths ask
different questions for "which repository": `agents/repository-context.ts` reads
the task's own project link, while plan compile reads `goals.project_id`. They
agree today only by construction. And a goal's status is moved only by a person
calling `PATCH`; nothing derives it, so a goal whose tasks all finish stays
wherever it was left.

## Decision drivers

- A concept whose instances arrive by accident cannot be reasoned about.
- Berry's owner should have one authored container, not two that overlap.
- "Which repository does this task belong to" must have one answer.
- A status nobody maintains is worse than no status.

## Considered options

1. **Keep both authored, write down the distinction.** Cheapest, changes no
   code. Rejected: the distinction would still have to be taught, and the
   accumulation problem is untouched.
2. **Merge goals into plans.** A plan already carries the intent and the
   versions; the goal adds a title and a lifecycle. Rejected: it removes the
   grouping that makes a board of generated tasks legible.
3. **Goals become derived groupings of a project's tasks.** Chosen.

## Decision

**A goal is not authored. It is the group of tasks one plan compile produced,
inside one project.**

Four consequences define it.

**Created at compile, not at generate.** The goal comes into existence with the
tasks it groups. A generation that is never compiled leaves nothing behind, which
removes the accumulation path entirely and, with it, the `draft` state — there is
no moment when a goal exists without tasks.

**It belongs to a project.** `project_id` is required for every live goal, and a
goal's tasks must all sit in that same project. This is the constraint that makes
"which repository" have one answer, whichever path asks.

**It is read-only.** Nothing writes a goal's title, description or membership
after compile. `POST /api/v1/goals`, `PATCH /api/v1/goals/:id` and the two
`:goalId/issues/:issueRef` routes go. `source` and `source_prompt` go with them:
every goal is now made the same way, and the prompt belongs to the plan.
`DELETE` stays — an obsolete grouping should be retirable.

**Its status is derived from its tasks**, over four states:

| Shown | Stored | When |
|---|---|---|
| Planned | `planned` | every task still in `backlog` or `todo` |
| In Progress | `active` | any task `in_progress`/`in_review`, or some task finished while others remain |
| Blocked | `blocked` | at least one task `blocked` and none left in `backlog`/`todo` — the goal cannot advance |
| Done | `completed` | every task `done` or `cancelled` |

`draft` and `cancelled` are removed. `draft` was an artifact of minting the goal
too early. `cancelled` was reachable only by hand; a grouping whose tasks are all
cancelled reads as `completed`, and a grouping that should not have existed is
retired with `DELETE`.

The rule has one definition, the SQL function `berry_goal_derived_status`, so the
wire, the database and any future reader cannot disagree about it.

**Where the recomputation runs.** In application code, inside the same
transaction that changes a task's status or a goal's membership — not in a
trigger. A trigger would have to rebuild the goal event envelope in PL/pgSQL,
duplicating `serializeGoal`; calling the function from the transaction keeps
event emission on the existing path and still means no caller *authors* a status.

## Consequences

### Positive

- One authored container. "Project or goal?" stops being a question.
- Abandoned generations leave no rows.
- A goal's project and its tasks' project cannot diverge.
- A finished goal shows as finished without anyone saying so.
- Four states instead of six, and every one of them is observable.

### Negative

- The goal write routes and their tests are deleted; any client calling them
  breaks. The frontend's `goalStatusSchema` narrows from six values to four.
- Every goal currently in the database is retired. Nothing is lost — all eight
  group zero tasks — but the rows disappear from the UI.
- A goal can no longer be renamed. If a compile produces a poor title, the fix
  is at generation, not after.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Derived status is wrong for a shape not considered | The rule is one SQL function with a table of cases; change it in one place |
| Recomputation missed on some task-transition path | Every path routes through the issue transition; the constraint below fails loudly if a goal's tasks leave its project |
| Retiring live goals in another database | The migration soft-deletes (`deleted_at`), so the rows survive and can be restored |
| Losing the ability to abandon a goal | `DELETE` is kept for exactly this |

## Validation

- The migration retires only goals grouping zero tasks; a goal with tasks keeps
  its identity and takes the project its tasks are in.
- `berry_goal_derived_status` returns each of the four states for a constructed
  set of tasks, including the two ordering cases: blocked-plus-todo is `planned`,
  blocked-plus-done is `blocked`.
- Compiling a plan produces exactly one goal, and generating without compiling
  produces none.
- Completing every task in a goal moves it to Done and sets `completed_at`,
  emitting `goal.completed` on the workspace stream.

## Follow-up

- Delete the goal write routes and their handlers.
- Move goal creation from `PlanRepository.create` to compile.
- Narrow the frontend's `goalStatusSchema` and remove the status-transition
  controls in `frontend/lib/goals.ts`.
- Record the goals/projects distinction in `PRODUCT.md`, which does not yet
  state it.
