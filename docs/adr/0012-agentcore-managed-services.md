# ADR-0012: Operate agents on AgentCore Runtime, Gateway, Memory, and Policy

- **Status:** Partially accepted. **Phase 1 (Runtime) is delivered and live** —
  a runtime is provisioned in us-east-1 from Berry's own image and is the
  active execution substrate (`BERRY_RUNTIME_DRIVER=agentcore-runtime`),
  verified end to end against the live service. Phase 2 (Gateway), Phase 3
  (Memory) and Phase 4 (Policy) are not started: no Gateway, no Memory store,
  no Policy resources exist.
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

- **Runtime** — **delivered.** `server-ts/src/execution/agentcore-runtime.ts`
  invokes a deployed runtime with `InvokeAgentRuntimeCommand` and satisfies the
  `ExecutionSession` seam. The runtime image is Berry's own
  (`server-ts/sandbox/agentcore/`): ARM64 `node:22-slim` carrying git, pnpm,
  node, python3 and a C toolchain, serving the required `/ping` and
  `/invocations` on `0.0.0.0:8080`. It is provisioned in us-east-1 and is the
  active substrate. Two defects that only live testing could surface were fixed
  in the process — see Validation.
- **Gateway** — implemented and dormant: `agentcore-github-provider.ts`,
  `agentcore/bootstrap.ts`, and the `createScm` branch in `provider-factory.ts`
  select it when `config.agentCoreGateway` is set (both
  `AWS_AGENTCORE_GATEWAY_URL` and `AWS_AGENTCORE_GITHUB_PROVIDER`). Neither is
  set, so `createScm` falls through to the GitHub App / OAuth path. The Gateway
  provider powers agent-run SCM work (provision, sync, issues, PRs); it does
  **not** currently back the project repository picker, which uses the direct
  `GitHubClient`.
- **Memory** — implemented for short-term run recall: `agentcore/memory.ts`
  writes a run's outcome with `CreateEvent` and reads earlier ones with
  `ListEvents`, keyed `actorId` = agent, `sessionId` = issue. `executor.ts`
  recalls before the run is marked running and folds the result into the first
  message as `PromptContext.priorWork`; it records on both success and failure.
  The store is provisioned in us-east-1 with no `memoryStrategies`, so there is
  no extraction role and no lag between writing an event and reading it. The run
  ledger is unchanged and still authoritative — Memory augments it, and a
  memory failure degrades recall rather than failing a run. Long-term semantic
  extraction is still unimplemented; it is a strategy added to the same
  resource, producing derived records alongside these events.
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

### Phase 3 — Memory (delivered; short-term recall)

- **Delivered:** `agentcore/memory.ts` — a `RunMemory` seam with an AgentCore
  implementation and a `nullRunMemory()` no-op, so the executor's recall path has
  no branch in it. `recall` reads with `ListEvents`; `record` writes with
  `CreateEvent`. `recallPrompt` renders the result, returning null for a first
  run rather than an empty heading that would read as "you did nothing".
- **Keying:** `actorId` = `agent-<id>`, `sessionId` = `issue-<id>`. An actor is
  the entity that participates across sessions and a session is the thread of
  work, so "this agent, on this issue" is one query. `ListEvents` requires both.
- **Wiring:** `executor.ts` recalls concurrently with the review-feedback read,
  before the run is marked running, and passes `priorWork` to `buildMessage`. It
  records the summary on success and the failure code on failure — a failure
  being the most valuable thing to recall, and the one a rejected review never
  captures because the run produced nothing to review.
- **What is recorded:** the outcome, not the transcript. The ledger already holds
  every command; what the next run needs is the conclusion.
- **Bounds:** 30 events recalled, 4000 bytes per event keeping the tail (a
  command's failure is at the end). The prompt is a bill.
- **Config:** `BERRY_AGENTCORE_MEMORY_ID=<id>`; unset disables recall. Also
  `BERRY_AGENTCORE_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`, falling back to the
  Bedrock pair — see Validation for why the default chain is not usable.
- **Not delivered:** long-term semantic extraction, and conversation recall
  (`conversations/responder.ts` still replays its own Postgres rows, which is
  correct for a chat thread and needs no store).
- **Verify:** offline — `agentcore/memory.test.ts` (11 tests, mocked client) plus
  prompt tests in `executor.test.ts`. Live — verified against the provisioned
  store, including from inside the `berry-api` container.

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

Per phase: offline typecheck plus mocked-client unit tests for every phase; live
verification against the named AWS resource before a phase is considered
delivered. `pnpm typecheck:server` and `pnpm test:server` stay green throughout;
the wire contract and the execution/SCM seams are preserved.

### Phase 1 evidence

The managed Code Interpreter was tested first and **rejected on evidence**: it
ships no `git`, no `pnpm`, and has no route to github.com (`curl` returned 000).
A run clones and pushes through its session, so none of those is optional. That
is what made owning the image necessary.

Against the provisioned runtime, using the server's own credential rather than
an administrator's: `health()` reachable; `git 2.39.5`, `pnpm 10.12.1`, node,
python3, gcc, make all present; **egress to github.com returns 200**; a real
shallow `git clone` of a public repository succeeds; a non-zero exit is
propagated as a result (`exit 42`), not raised; `writeFile`/`readFile` round-trip
byte-exact across plain text, embedded single and double quotes, multi-line
content, shell metacharacters and nested heredoc markers; nested directories are
created. The server boots reporting `executionDriver: agentcore-runtime`.

Two defects were found only by running against the live service, and both are
now fixed and pinned by tests:

1. **`body.command` is not run through a shell.** AgentCore tokenizes the string
   and execs it, so `echo a && echo b` printed a literal `&&`, `for` was looked
   up as a binary, and a pipeline passed every word to the first command. The
   driver now wraps the script as `/bin/bash -c "echo <base64> | base64 -d |
   /bin/bash"`. Base64 rather than quoting because Berry sends whatever an agent
   wrote, which routinely contains quotes and newlines; the encoded payload
   leaves the tokenizer nothing to split on.
2. **`writeFile` appended a blank line** to any content already ending in a
   newline, because the heredoc terminator was always preceded by an added `\n`.
   Fixed in both AgentCore drivers.

### Phase 3 evidence

A Memory store was created in us-east-1 (`eventExpiryDuration` 90 days, no
strategies) and reached `ACTIVE`. Against it, verified directly: a fresh issue
recalls nothing and yields a null prompt; two events written are recalled
oldest-first; a blank event is not sent; a different issue sees nothing; a 20 000
character event is stored truncated to 4001; and an invalid `memoryId` degrades
with `ValidationException` returning no events instead of throwing. The IAM grant
is `CreateEvent` + `ListEvents` scoped to that one memory ARN.

A third defect surfaced here, and it is the reason this phase carries a config
change rather than only new code:

3. **AgentCore clients on the AWS default credential chain authenticate as
   MinIO.** In the Compose stack `AWS_ACCESS_KEY_ID` is `berryminio` — the object
   store's credential, which the stack has always set under that name. Any
   AgentCore SDK client constructed without explicit credentials therefore
   presents it to AWS and is refused. Confirmed from inside the running
   `berry-api` container: with explicit credentials a recall round-trips, and on
   the default chain the same call fails `UnrecognizedClientException`. Fixed by
   adding `AgentCoreConfig.credentials`
   (`BERRY_AGENTCORE_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_SESSION_TOKEN`,
   falling back to the `BERRY_BEDROCK_*` pair), mirroring the reason Bedrock
   already had its own pair. Both execution drivers were passing no credentials
   too, so the same fix was applied in `execution/factory.ts` — meaning the
   `agentcore` and `agentcore-runtime` substrates were also relying on ambient
   credentials that are wrong inside the container.

The boot line now reports `runMemory: agentcore | off`, because recall is
otherwise invisible from outside: an agent with no store and an agent whose store
is misconfigured both simply start fresh.

## Follow-up

- **A runtime image per toolchain.** The image a run needs is decided by the
  repository it works in: this one carries Node and pnpm because that is Berry's
  own stack, and a PHP, Python or Go repository wants its own. Keep
  `server.mjs` shared and vary only the toolchain layer. This makes a single
  `BERRY_AGENTCORE_RUNTIME_ARN` insufficient — the deployment will need a
  toolchain-to-ARN mapping, chosen per project, and that is a config-shape
  decision this ADR does not settle.
- **Persistent filesystem.** `CreateAgentRuntime` accepts
  `filesystemConfigurations`, and the image already works in `/mnt/workspace`.
  Mounting one there would let a checkout, its installed packages and its build
  artifacts survive a session stop instead of being cloned again.
- **`docker` remains the self-hosted path.** A deployment with no AWS still runs
  the local runtime service; this ADR adds a substrate, it does not remove one.
- Phase 2 (Gateway) gates Phase 4 (Policy); neither is started.
- Deferred pillars: Identity (broaden beyond GitHub), Tools (route through
  Gateway/registry), Observability (OTEL → CloudWatch/AgentCore Observability).
  A separate ADR when those are scoped.
