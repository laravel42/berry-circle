# Plans decompose into milestones

Status: **implemented** (2026-09-09), branch `refactor/strands-native-runtime`.

## Problem

Every AI-led project produced exactly one goal, and that goal was the project
restated: `plans.open()` minted a goal from the prompt's first line, the plan
IR carried a single `goal`, and compile grouped every task under it. The
planner was never asked to decompose, so a goal on the board said nothing a
project did not already say.

## Design

- **IR.** `Plan.milestones[]` (`tempId`, `title`, `description`) in delivery
  order, and `PlanIssue.milestone` naming the one a task belongs to. The
  reader synthesises one milestone from the goal when a model sends none, so
  older answers and stored plans still read. It also unwraps a plan handed
  over inside a single wrapper key.
- **Validation.** A task naming a milestone the plan lacks is
  `unknown_milestone`; a milestone with no tasks is `empty_milestone`. Both
  are repairable by the repair role. Checked only when the plan has
  milestones, so hand-built fixtures without any make no claim.
- **Planner.** The prompt asks for 2 to 6 milestones that are outcomes rather
  than layers, 3 to 8 single-responsibility tasks each, dependencies kept
  inside a milestone where possible. The critic sends back a multi-part
  request squeezed into one milestone, or a task doing two things.
- **Structured output.** The planner and repair roles answer through a named
  top-level schema (`goal`, `milestones`, `issues`, `assumptions`,
  `approvals`; loose inside) so the model's tool advertises the shape. An
  open object let Haiku wrap the whole plan under a key of its own, which
  read as an empty plan and exhausted the repair loop.
- **Compile.** One goal per milestone, in the plan's project. The goal minted
  when the plan opened becomes the first milestone, retitled, so no empty goal
  is left beside the real ones and `plans.goal_id` keeps pointing at a goal
  with tasks. `compile.goalIds` lists them in delivery order, first the plan's
  own goal. No migration.
- **Frontend.** The preview groups work under milestone headings, counts say
  "N milestones" when there is more than one, and the schemas accept the new
  fields with defaults.

## Verified

Server: 542 tests, typecheck clean; a DB-backed test compiles a two-milestone
plan into two goals with the right membership and no leftover goal. Live: the
real planner produced 4 milestones and 17 tasks for a support-desk prompt,
every task in exactly one milestone.

## Left alone

ADR-0010's stated validation "compiling a plan produces exactly one goal" is
now "one per milestone"; its decision — goals are derived groups of a plan's
tasks inside one project, created at compile, read-only after — stands and is
what this builds on. `plans.open()` still mints the anchor goal at generation
time rather than at compile; moving that needs `plans_scope_ck` to change and
is a separate piece of work.
