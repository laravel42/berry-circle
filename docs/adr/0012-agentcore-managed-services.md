# ADR-0012: Operate agents on AgentCore Runtime, Gateway, Memory, and Policy

- **Status:** Proposed — not started. Only the Runtime *driver* exists
  (`agentcore-runtime.ts`, client-side, unit-tested against a mock, never run
  against a real runtime). No AWS resources are provisioned: no runtime ARN, no
  Gateway, no Memory store, no Policy. Phases 1–4 are deferred pending a
  decision to create billable AgentCore resources.
- **Date:** 2026-09-09
- **Deciders:** Berry platform
- **Related:** [ADR-0008](0008-adk-agent-runtime.md) (in-process Strands agent
  loop), [ADR-0011](0011-refresh-provider-credentials.md) (AgentCore Identity
  for GitHub credentials), `server-ts/src/execution/`, `server-ts/src/agentcore/`,
  `server-ts/src/scm/provider-factory.ts`.

## Context

Berry runs the agent loop itself — `AdkExecutor` on the Strands SDK, in
process (ADR-0008). That is not changing: the AgentCore **Harness** (a managed,
config-based loop) is explicitly out of scope, because adopting it would move
the loop, the run ledger, live event streaming, cancellation, and permission
enforcement out of Berry and into AWS configuration.

What is in scope is making that in-process loop *operate on* the AgentCore
managed services around it — the same posture as an AgentCore **Runtime**
deployment: Berry owns the loop, AWS provides the substrate. This ADR scopes
four pillars: **Runtime, Gateway, Memory, Policy**. (Identity, Tools, and
Observability are deferred to a follow-up; Identity already exists for GitHub
credentials via ADR-0011.)

Current state, per pillar, from the code as it stands:

- **Runtime** — only the *client* exists:
  `server-ts/src/execution/agentcore-runtime.ts` invokes a deployed runtime
  with `InvokeAgentRuntimeCommand` and satisfies the `ExecutionSession` seam. It
  is unit-tested against a mocked client and **never run against a real
  runtime** — there is no deployed runtime and no container image to deploy.
  Creating one is a build project (author a container that speaks the shell-
  execution contract with github.com egress → push to ECR → create an IAM
  execution role → `CreateAgentRuntime` → wire `BERRY_AGENTCORE_RUNTIME_ARN` →
  verify live), not a config change.
- **Gateway** — implemented and dormant: `agentcore-github-provider.ts`,
  `agentcore/bootstrap.ts`, and the `createScm` branch in `provider-factory.ts`
  select it when `config.agentCoreGateway` is set (both
  `AWS_AGENTCORE_GATEWAY_URL` and `AWS_AGENTCORE_GITHUB_PROVIDER`). Neither is
  set, so `createScm` falls through to the GitHub App / OAuth path. The Gateway
  provider powers agent-run SCM work (provision, sync, issues, PRs); it does
  **not** currently back the project repository picker, which uses the direct
  `GitHubClient`.
- **Memory** — not implemented. `AgentCoreConfig.memoryId` is parsed and read by
  nothing. Berry's durable record is the run ledger (Postgres); there is no
  short-term/long-term memory store.
- **Policy** — not implemented, and **dependent on Gateway**. AWS Policy
  enforces at the Gateway: Cedar rules are validated against the schema
  generated from the Gateway's tools' input schemas, and evaluated on each tool
  call as it passes through the Gateway. Policy without Gateway has nothing to
  enforce on.

The binding constraint on this whole effort: every pillar requires live,
provisioned AWS AgentCore resources to verify. Offline, only typecheck and
unit tests with mocked clients are possible. This ADR therefore sequences the
work so each phase is independently shippable and its verification prerequisite
is explicit.

## Decision drivers

- Berry keeps its in-process loop (ADR-0008); services wrap the loop, they do
  not replace it.
- Reuse what exists (Runtime driver, Gateway provider, Identity) before writing
  greenfield integrations (Memory, Policy).
- Each phase must be shippable and verifiable on its own, with its AWS resource
  prerequisite named up front, so no phase lands as unverifiable code.
- Preserve the wire contract and the `ExecutionSession` / `ScmProvider` seams so
  the ledger, tools, and executor stay unaware of the substrate.

## Considered options

1. **Adopt the Harness** — rejected by the user; would replace Berry's loop.
2. **All four pillars in one change** — rejected: three of four need live AWS to
   verify, and Memory and Policy are greenfield. One large unverifiable change.
3. **Phased, dependency-ordered, one pillar at a time** — chosen.

## Decision

Deliver the four pillars in four phases, in this order, each behind explicit
configuration and each verified against real AWS resources before the next
begins.

### Phase 1 — Runtime (closest to done)

- **Change:** wire the existing `agentcore-runtime` driver end to end. It is
  already selected by `BERRY_RUNTIME_DRIVER=agentcore-runtime` through
  `createExecutionDriver`, forwarding `agentCore.runtimeArn`.
- **Config:** `BERRY_RUNTIME_DRIVER=agentcore-runtime`,
  `BERRY_AGENTCORE_RUNTIME_ARN=<arn>`, region from the existing AgentCore config.
- **AWS prerequisite:** a deployed AgentCore Runtime whose container provides a
  shell and egress to github.com (a run clones and pushes through the same
  session — the same requirement the Code Interpreter path has).
- **Verify:** offline — typecheck, existing `agentcore-runtime.test.ts`. Live —
  a dispatched run executes `run_command` against the runtime, output streams to
  the ledger, exit code is recorded, the working tree clones and delivers.

### Phase 2 — Gateway (implemented, dormant; unblocks Policy)

- **Change:** none required to *activate* the agent-run SCM path — set the env
  and `createScm` takes the Gateway branch. To also route the **repository
  picker** through the Gateway (so listing/linking a repo uses the same managed
  path), add `listRepositories` to the `ScmProvider` interface and the Gateway
  provider, add its capability to the tool-map, and rewire the integrations list
  handler and the project repository resolver off the direct `GitHubClient`.
  This second part is a wire-affecting change and is optional to Phase 2.
- **Config:** `AWS_AGENTCORE_GATEWAY_URL`, `AWS_AGENTCORE_GITHUB_PROVIDER`,
  `AWS_AGENTCORE_WORKLOAD_NAME`, `GITHUB_PROVIDER=agentcore` (already the
  default).
- **AWS prerequisite:** a deployed AgentCore Gateway exposing the GitHub tools,
  and a GitHub credential provider registered in AgentCore Identity.
- **Verify:** offline — `bootstrap`/`tool-map`/`gateway-client` tests. Live — an
  agent run creates an issue/PR through the Gateway; `startGateway` resolves the
  required tools rather than returning a null provider.

### Phase 3 — Memory (greenfield; independent of Gateway)

- **Change:** introduce an AgentCore Memory client and wire it into the run /
  conversation path. Short-term: write conversational events per run with
  `CreateEvent` keyed by `memoryId` + an `actorId` (the agent) + a `sessionId`
  (the run or conversation). Optionally read prior events with `ListEvents` to
  enrich a run's opening context. Long-term: a semantic strategy on the memory
  resource extracts insights across sessions. The dead `memoryId` config field
  is the seam; nothing about the run ledger is removed — Memory augments it.
- **Config:** `BERRY_AGENTCORE_MEMORY_ID=<id>`.
- **AWS prerequisite:** a created AgentCore Memory resource (a semantic strategy
  if long-term recall is wanted).
- **Verify:** offline — unit tests with a mocked memory client. Live — events
  written for a run are retrievable by `actorId`/`sessionId`; a follow-up run
  reads prior context.

### Phase 4 — Policy (greenfield; requires Gateway from Phase 2)

- **Change:** author Cedar (or natural-language-generated) policies over the
  Gateway's tool schemas, and rely on the Gateway to intercept and evaluate each
  tool call. Berry's role is authoring/managing the policies and surfacing a
  denied call as a clear tool result, not a 500. No in-process enforcement is
  added — enforcement is the Gateway's.
- **Config:** policy resources created against the Phase 2 Gateway.
- **AWS prerequisite:** the Phase 2 Gateway, plus the AgentCore policy engine
  enabled for it.
- **Verify:** live only — a permitted tool call passes and a forbidden one is
  denied at the Gateway, with the denial surfaced to the run.

## Consequences

### Positive

- Berry gains managed execution isolation, a managed tool/credential boundary,
  cross-session memory, and deterministic tool-call authorization, while keeping
  its own loop and its durable run ledger.
- Two of four pillars reuse code that already exists; only Memory and Policy are
  new.
- Each phase is revertible by unsetting its configuration.

### Negative

- Deepens coupling to AWS AgentCore for four subsystems. Only the `docker`
  execution path and the App/OAuth GitHub path remain fully self-hostable.
- Memory and Policy are new surfaces to build, test, and operate.
- Routing the repository picker through the Gateway (Phase 2, optional part)
  changes a wire path and needs the `ScmProvider` interface extended.

### Risks and mitigations

- **Risk:** phases ship as unverifiable code because the AWS resources do not
  exist. **Mitigation:** each phase names its resource prerequisite; a phase
  does not merge as "done" until verified live against that resource. Offline,
  only typecheck and mocked-client unit tests are claimed.
- **Risk:** the Runtime driver's streaming/session/file-via-shell behavior
  diverges from real `InvokeAgentRuntimeCommand` behavior. **Mitigation:**
  Phase 1 live verification against a real runtime before relying on it.
- **Risk:** Policy is built before Gateway and has nothing to enforce on.
  **Mitigation:** the ordering here makes Gateway (Phase 2) a hard predecessor
  to Policy (Phase 4).

## Validation

Per phase, as above: offline typecheck plus mocked-client unit tests for every
phase; live verification against the named AWS resource before a phase is
considered delivered. `pnpm typecheck:server` and `pnpm test:server` stay green
throughout; the wire contract and the execution/SCM seams are preserved.

## Follow-up

- Confirm which AWS AgentCore resources exist (Runtime ARN, Gateway URL +
  Identity provider, Memory id) — this gates which phase can be verified first.
- Deferred pillars: Identity (broaden beyond GitHub), Tools (route through
  Gateway/registry), Observability (OTEL → CloudWatch/AgentCore Observability).
  A separate ADR when those are scoped.
