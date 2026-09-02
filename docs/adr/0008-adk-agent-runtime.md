# ADR-0008: Run agents in-process with the Google Agent Development Kit

- **Status:** Accepted — implemented. The runtime this record replaces was
  removed from the repository on 2026-08-28, along with the server that adapted
  it; the detail below is retained because it is the evidence for the
  decision, not a description of anything that still runs.
- **Date:** 2026-08-27
- **Deciders:** Berry platform
- **Related:** [ADR-0006](0006-agent-run-artifacts.md) (agent run artifacts),
  [ADR-0009](0009-typescript-product-server.md) (TypeScript product server).
  ADR-0003 (pin the runtime by commit), ADR-0004 (Go product server) and ADR-0005
  (Temporal run orchestration) were withdrawn with their subjects.

## Context

Berry does not run agents. A separate runtime service does, and Berry
projects what it reports into product identities. That division has shaped
every agent feature Berry has, and most of the defects.

A runtime agent is a long-lived named process with its own lifecycle, its own
heartbeat, and a directory on a volume Berry does not own. Berry creates one by
spawning it and then discovering it again through a sync. The consequences are
not incidental:

- **Idle reads as broken.** The runtime marks an agent Crashed after 180 seconds
  without activity and auto-recovers it. An agent that finished its work and
  waited is indistinguishable, in the runtime, from one that died. Recovery
  leaves `is_inferencing` set, which Berry faithfully reports as *busy* — an
  agent doing nothing, shown as working, indefinitely.
- **Agents cannot hand each other anything.** Every file tool is scoped to the
  agent's own workspace. One agent cannot read what another wrote, so a task
  that depends on finished work receives it as text pasted into a prompt
  (`internal/priorwork`) because there is no other channel.
- **A runtime agent belongs to one workspace.** the agents table's runtime-agent id is
  globally unique and the projection only applies within the owning workspace,
  so a second Berry workspace inherits nothing and falls back to its built-in
  orchestrator.
- **Removal does not stick without help.** The runtime keeps listing an agent
  Berry archived, and the reconcile used to un-archive it.
- **There is no credential seam.** The runtime accepts `mcp_servers` and ignores
  them, and has no per-workspace credential store, so Berry cannot give an
  agent a tool that acts as the workspace. This is why agents cannot touch
  GitHub directly and why delivery is Berry's job rather than theirs.
- **Files reach Berry by sweep.** Artifacts exist because a worker mounts the
  runtime volume read-only and copies out of `output/`. The mount is read-only
  by decision, so the reverse direction — Berry placing a file where an agent
  can read it — is not available at all.

None of these are bugs in that runtime. They follow from agents living somewhere
else.

The Google Agent Development Kit inverts that. ADK is a library, not a service:
an agent is `llmagent.New(...)` constructed per run, composed with sequential,
parallel and loop workflow agents, executed by a `Runner` against pluggable
`SessionService`, `ArtifactService` and `MemoryService` implementations. There
is no daemon, no heartbeat, no filesystem workspace, and no second system that
owns agent identity.

### What was verified before proposing this

Three risks would each have made the migration a different project. All were
tested against `google.golang.org/adk/v2 v2.2.0` on Go 1.26:

- **Models.** Berry runs on OpenRouter, and ADK Go is Gemini-first; its OpenAI
  model is documented against the Responses API, which OpenRouter does not
  serve. `openaimodel.NewModel` with `BaseURL` pointed at OpenRouter drove a
  completion on `openai/gpt-5.4-nano` successfully.
- **Tools.** An agent with no tools is not an agent. A `functiontool` handler
  round-tripped a call through OpenRouter on the first attempt.
- **Artifacts.** An agent saved a file through `ctx.Artifacts().Save` and it
  came back from `List`. This is the replacement for the workspace volume.

### What changed when the server became TypeScript

ADR-0009 moved the product server to TypeScript, so the runtime is
`@google/adk` v2 rather than the Go SDK. One of the three findings above does
not survive the move:

**ADK JS has no OpenAI-compatible model.** It ships exactly two — `ApigeeLlm`
and `RoutedLlm` — over an extensible `BaseLlm`. The Go SDK's `model/openaimodel`
has no counterpart, so Berry writes one: `server-ts/src/agents/openrouter-llm.ts`
translates between ADK's Google GenAI types and OpenAI chat completions in both
directions.

Verified against live OpenRouter on `openai/gpt-5.4-nano`: a completion with
usage accounting, a streamed completion reassembled from deltas, a tool call
round trip, and a real `LlmAgent` driven by `InMemoryRunner` that called a
Berry-shaped `FunctionTool` with the workspace closed over and answered from
its result.

Two details cost real time and are worth naming:

- ADK emits Google's `Schema`, whose `type` is an **uppercase** enum
  (`"OBJECT"`, `"STRING"`). OpenRouter answers `400 Provider returned error`
  and says nothing about casing. Lowering `type` recursively is the whole fix.
- Streamed tool call arguments arrive as fragments keyed by index. They are
  accumulated rather than forwarded: half a JSON object is not a tool call.

## Decision

Replace that runtime with ADK as Berry's agent runtime. Agents become configuration
Berry owns rather than processes Berry discovers.

Berry keeps what it already does well and does not hand it to ADK:

- **Temporal keeps durable orchestration.** ADK's workflow agents compose an
  agent's own turn; they run in one process and do not survive a restart. Run
  orchestration, retries and cancellation stay in Temporal (ADR-0005). ADK is
  used for the agent's execution and tool loop, not for orchestrating tasks
  across a board.
- **The planner keeps planning.** Berry's planner produces a validated plan a
  person approves. That is a product decision surface, not an agent-delegation
  problem.
- **`run_artifacts` becomes the ArtifactService.** ADK's own artifact filenames
  may not contain a path separator — the same constraint that made Berry give
  agent output its own table in the first place. `ArtifactService` is an
  interface, so Berry implements it over MinIO and `run_artifacts`, and the
  tree survives.

## Consequences

### What improves

Every failure listed in the context stops being possible rather than being
fixed: there is no heartbeat to misread, no per-agent volume to be sandboxed
by, no upstream list to reconcile against, and no second owner of identity.
Two things become available that were not:

- **Real handoff.** A shared `ArtifactService` means one agent can read what
  another produced, instead of receiving a bounded excerpt in its prompt.
- **Workspace-scoped tools.** Tools are Go functions constructed in Berry's
  process with the calling workspace in scope, so an agent can act as the
  workspace — the blocker behind native integrations.

### What this costs

Three areas are rewritten rather than adapted:

- `internal/artifacts` — `output/` discovery, promotion and the recovery sweep
  are replaced by an `ArtifactService` implementation. The `run_artifacts`
  schema and the tree UI stay.
- `internal/service/runadmission` — stream consumption and event mapping move
  from the runtime's SSE to ADK's event iterator.
- `internal/handlers/agents` — the sync loop mostly disappears; agent rows stop
  being a projection and become the source.

Twenty-six files across fifteen packages import the runtime client package. The
interfaces are narrow, which is what makes this tractable.

### What is deliberately not decided here

Whether that runtime remains for anything. This ADR proposes replacement; the
migration is staged so the answer can be *not yet* for as long as necessary.

## Migration

Staged so Berry stays usable throughout. Each stage is shippable.

1. **Model seam.** ✅ `server-ts/src/agents/openrouter-llm.ts`. ADK JS ships no
   OpenAI-compatible model, so Berry owns one: streaming, tool-call
   translation and usage accounting against `BaseLlm`.
2. **Runtime adapter.** ✅ `server-ts/src/agents/executor.ts`, over the run
   ledger ported to `server-ts/src/runs/ledger.ts`. Selected by
   `BERRY_AGENT_RUNTIME` rather than per agent — a whole-deployment switch
   turned out to be simpler to reason about than a per-agent one, because the
   two runtimes disagree about what an agent *is*, not merely about how to run
   one.
3. **ArtifactService.** ✅ `server-ts/src/agents/artifact-service.ts` over
   `run_artifacts` and object storage, with `SessionService` beside it.
4. **Tools.** ✅ `server-ts/src/agents/tools.ts`, constructed per run with the
   workspace closed over. An agent cannot name another workspace because there
   is no parameter for it.
5. **Agent creation.** ✅ Reconciliation is off under the ADK runtime, and the
   agents mount is served from `server-ts/src/mounts/agents.ts` — Berry
   authors agents now, and the built-in orchestrator is made runnable without
   spawning anything (`EnsureLocalOrchestrators`). Spawn and sync still exist
   for the external-runtime setting and go with the rest of that client
   package at stage 6.
6. **Retire the external runtime.** Not yet, and the reason is no longer technical.

   Every WORK surface is off it: intake, dispatch, runs, artifacts, peer
   review (`internal/autogate` → `internal/openrouter`), the planner's model
   roles (`modelgateway.DirectGateway`) and the model catalogue
   (`modelcatalog` with no runtime half). Verified by stopping the container
   and running both loops — an auto-gated task through dispatch, artifacts and
   a peer verdict, and a plan through classifier, planner, validation, repair
   and critic.

   What still calls it:

   | surface | why it is still there |
   |---|---|
   | `handlers/conversations` | chat with an agent — AUTOMATE, excluded from the migration |
   | `service/automationrun` | the workflow engine's agent step — AUTOMATE, excluded |
   | `service/projectplanning` | `POST /projects/:id/generated-issues`, deferred in server-ts/SCOPE.md |
   | `handlers/agents/ask.go` | `POST /agents/:id/ask` — nothing in the product calls it |
   | `handlers/runtime` | an operator probe *of the external runtime*, which has nothing to move to |

   Everything else that imports the package is either compiled-in and never
   called under ADK — `runadmission`'s stream loop, `agents/sync.go`,
   `orchestration/bootstrap.go`'s spawn path, `modelgateway/provisioning.go` —
   or uses it only for a type (`AgentLimits`, `CatalogModel`).

   So the blocker is a product decision, not an engineering one: AUTOMATE is
   to be rebuilt rather than migrated, and the runtime goes when it is.

### How this differed from the plan

Two assumptions in this ADR were wrong, and both were wrong in the same
direction — they assumed the work stayed in Go.

The runtime is TypeScript, because ADR-0008 was written the same day the server
migration started and the two decisions met. Everything above lives in
`server-ts/`, and the Go worker reaches it over one HTTP call
(`internal/service/adkruntime`) until the orchestration moves too.

The chat route was the other. This ADR treats that service as an agent runtime,
and it is, but four of Berry's callers only ever used its OpenAI-compatible
chat endpoint — which forwarded the request to OpenRouter and returned what
came back. For those the migration is not a replacement at all; it is deleting
a hop. Naming an agent instead of a model was the only thing it added, and
Berry held the pairing the whole time.

"The sync loop mostly disappears" understated it. Sync does not merely become
redundant under ADK — it is destructive: an agent the runtime has never heard of
is marked offline on every listing, and the model Berry gave it is overwritten
with whatever the runtime last said. Turning reconciliation off is a correctness
requirement of running under ADK at all, not a cleanup that can follow it.

## Alternatives considered

- **ADK alongside the old runtime indefinitely.** Two agent models, two artifact
  paths, two lifecycles. Rejected as an end state, accepted as the shape of the
  migration.
- **ADK for orchestration only.** Overlaps Temporal, which already does this
  durably, and leaves every defect above in place.
- **Fix the old runtime.** The defects follow from agents living in another service
  with their own filesystem. Fixing them means changing that, which is what
  this ADR does.
