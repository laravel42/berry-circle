# Strands-native agent runtime: design and refactor plan

Status: **implemented** on `refactor/strands-native-runtime` (see §11). The
analysis below describes the tree as it was before; it is the output of reading the run path in `server-ts/src/agents/`, `src/llm/`,
`src/execution/`, `src/agentcore/` and `src/runs/` against
`@strands-agents/sdk` 1.16.0 as installed, and against the pending
`.kiro/specs/agent-runtime-hardening/tasks.md`.

Date: 2026-09-09. Branched from `refactor/architecture-clarity`.

## 1. Summary

Berry already runs its agent loop on Strands. What it does not do is *use*
Strands: the SDK sits behind a 160-line translation seam
(`agents/strands-runtime.ts`) that re-describes its events as five Berry
events by string-matching untyped payloads, and an 800-line executor
(`agents/executor.ts`, still named `AdkExecutor`) hand-rolls everything the SDK
now provides as a plugin, a hook, a retry strategy, a conversation manager or
a structured-output schema. A second, unrelated Bedrock client
(`llm/bedrock-chat.ts`) serves the four single-completion callers with a
"please answer in JSON" prompt and a regex to dig the JSON back out.

The proposal is to make the run **Strands-native**: the ledger, permissions,
cancellation, retry classification, usage accounting and result tracking each
become a small Berry plugin on the SDK's typed hook events; the executor
shrinks to the orchestration Berry actually owns (claim, prepare repository,
invoke, deliver, record); the single-completion callers move onto a toolless
Strands agent with `structuredOutputSchema`; and the ADK-era names, comments
and dead code go. What stays exactly as it is: the run ledger and its wire
events, the `ExecutionDriver` seam and all three drivers, the repository
half (`checkout`, `delivery`, `verification`, `repository-run`), the
dispatcher, the `/api/v1` contract, and the database schema. **No migration
is needed.**

Eleven of the forty findings in the hardening spec are either fixed
structurally by this refactor or become one-line changes inside a plugin
(§7). That is the main reason to do this before the hardening work rather
than after it.

## 2. What exists today

### 2.1 The run path, file by file

| File | Lines | What it does | Assessment |
| --- | --- | --- | --- |
| `agents/executor.ts` | 791 | `AdkExecutor`: claims the run, builds tools, recalls memory, prepares the repository, drives `runAgent()`, translates events into ledger rows, buffers output, tracks the result text, sums usage, closes open tools, delivers, records the outcome. Also hosts `OutputBuffer`, `ResultText`, `splitUtf8`, `toAgentName`, `failureCode`, `isRetryable`, `lazyWorkspace`. | Seven responsibilities in one class. The parts that are *Berry* (claim, prepare, deliver, record) are ~250 lines; the rest re-implements the SDK. |
| `agents/strands-runtime.ts` | 160 | `bedrockModel()` and `runAgent()`, a generator that casts every SDK event to `Record<string, unknown>` and matches `event.type` strings to emit `AgentEvent`. | The seam was justified when the SDK was being swapped. It now hides typed classes (`ModelStreamUpdateEvent`, `ToolResultEvent`, `AfterModelCallEvent`…) behind string matching, drops `stopReason`, and drops `AgentResult` entirely. `stillOpen()` is exported with no caller. |
| `agents/tools.ts` | 207 | Five Berry tools via `tool()` + Zod: `list_files`, `read_file`, `write_file`, `read_task`, `list_dependencies`. | Good shape. Ignores `ToolContext` (`cancelSignal`, `invocationState`), so cancellation and the checkout directory are threaded through closures instead. `artifactKey()` still carries an ADK triple. |
| `agents/command-tool.ts` | 299 | `run_command`: permission check, lazy session, ledger recording, output tail for the model. | Good shape. `permissions?:` is optional and fail-open (F-10); no `timeoutMs` (F-12); `cwd` unvalidated (F-13); `MAX_*_BYTES` measured in UTF-16 units (noted in hardening 6.1). |
| `agents/prompt.ts` | 130 | `buildMessage()` with reporting and delivery contracts; `lastRejection()`. | Fine. Contract text is stale (F-01, hardening 1.3). Untrusted content is undelimited (F-32). |
| `llm/bedrock-chat.ts` | 160 | Raw `ConverseCommand` client for planner, triage, responder, editor. `readJson()` recovers JSON from prose. | Duplicates the model client, the credential plumbing and the error mapping that Strands' `BedrockModel` already has. JSON is a prompt instruction, not a schema (its own comment says so). |
| `agentcore/memory.ts` | 227 | AgentCore Memory `CreateEvent`/`ListEvents`, `recallPrompt()`. | Keep. Strands has no AgentCore Memory store in TS; its `memoryManager` is a different abstraction. |
| `execution/*` | ~1,200 | `ExecutionDriver` seam; docker, Code Interpreter, AgentCore Runtime drivers. | Keep. Strands' `sandbox/docker` covers only the local case and knows nothing about the ledger or AgentCore Runtime. |
| `runs/ledger.ts`, `runs/dispatcher.ts` | 1,206 | The durable record and the lease/claim loop. | Keep untouched. |

### 2.2 Specific problems this refactor removes

1. **Untyped event handling.** `translate()` reads `event.type` as a string
   and `event.delta`, `event.start`, `event.toolResult`, `event.usage` as
   `Record<string, unknown>`. The SDK exports the classes; an `instanceof`
   check is both safer and shorter. The comment defends this as protection
   against a young SDK, but a renamed field today produces a *silent* missing
   delta, which is the failure mode the ledger exists to prevent.
2. **The loop is not testable.** `executor.test.ts` covers `ResultText`,
   `splitUtf8` and `toAgentName`. The orchestration, cancellation, delivery
   ordering and permission enforcement have no test (F-31) because
   `runAgent()` constructs a real `BedrockModel` internally. Strands'
   `Agent` accepts any `Model` subclass, so a scripted model makes the whole
   loop unit-testable.
3. **Permission checks live in tool bodies, and only one tool has one.**
   Five of six tools are unchecked (F-09); the one check is fail-open (F-10).
   Strands' `BeforeToolCallEvent` (or an `InterventionHandler` returning
   `Deny`) is a single enforcement point the model cannot route around, with
   the denial delivered as a tool result the model can read — exactly what
   `command-tool.ts` does by hand today.
4. **Retry classification reads a field AWS does not set.** `failureCode`
   and `isRetryable` read `.status`; AWS SDK v3 errors carry
   `$metadata.httpStatusCode` (F-22). Strands ships
   `DefaultModelRetryStrategy` with an overridable `isRetryable(error)`,
   and Berry's classification belongs there, once.
5. **A failed tool cannot fail a run** (F-23). `tool_completed(ok:false)` is
   recorded and forgotten. `AfterToolCallEvent` carries `error`, `result`,
   and `retry`; a policy plugin can distinguish "the tool threw" from "the
   command exited non-zero" and act.
6. **No context management.** A long run has no conversation manager, so a
   run that reads many files or runs many commands overflows the context
   window and fails with a provider error. `SlidingWindowConversationManager`
   with proactive compression is a one-line fix once the agent is built in
   one place.
7. **Credentials and inference parameters leak or vanish.** `index.ts`
   spreads `credentials` into an options type that only recently declared it;
   `maxTokens`/`temperature` are declared and never populated (F-25). A
   single model factory used by every caller closes this class of bug.
8. **Two Bedrock clients, two error taxonomies.** `BedrockUnavailable`
   (chat) and the executor's `failureCode` (run) classify the same
   `ThrottlingException` differently. One `Model`, one retry strategy, one
   error map.
9. **ADK residue.** `AdkExecutor`, "ADK ends its iterator…", `artifactKey()`'s
   `{appName, userId, sessionId}`, `let streamed` (never read), and
   `AGENTS.md` still say Google ADK (F-26).

### 2.3 What is good and stays

- **Tools are closures over the workspace.** "An agent cannot name another
  workspace because there is no parameter for it" is the right security
  model and is unchanged.
- **The ledger is the record.** No Strands `SessionManager`; the SDK's
  conversation is in memory for the life of the call and the ledger is what
  survives. This is the position ADR-0012 already takes on the Harness.
- **The `ExecutionDriver` seam.** Three substrates, one interface, Berry's
  vocabulary. Strands' sandbox is not a replacement (§9).
- **`ResultText`, `OutputBuffer`, `splitUtf8`, `Tail`, `OutputRecorder`.**
  These encode real product lessons (the "I'll write that to a file" sign-off,
  the token-per-row ledger). They move; they do not change.
- **The repository half** (`repository-run.ts`, `checkout.ts`,
  `delivery.ts`, `verification.ts`) and its 20 tests. Untouched by this
  refactor; the hardening spec owns its fixes.

## 3. What Strands 1.16.0 provides that Berry re-implements

Verified against `node_modules/@strands-agents/sdk/dist/src/*.d.ts`.

| Berry today | Strands 1.16 | Notes |
| --- | --- | --- |
| `translate()` string-matching on `event.type` | Typed stream events: `ModelStreamUpdateEvent` (wrapping `ModelContentBlockDeltaEvent` etc.), `ToolResultEvent`, `ModelMessageEvent`, `AgentResultEvent` | `agent.stream()` yields these; `instanceof` narrows them. |
| `recordEvent()` writing ledger rows from the stream | Hooks via `Plugin.initAgent(agent)` → `agent.addHook(BeforeToolCallEvent, …)`, `AfterToolCallEvent`, `AfterModelCallEvent`, `MessageAddedEvent`, `AfterInvocationEvent` | `hooks:` on the config is gone in 1.16; `plugins:` is the mechanism. |
| `scope.permissions?.require()` inside one tool | `BeforeToolCallEvent.cancel: boolean \| string` — or `interventions: [handler]` returning `Deny(reason)` | Cancel string becomes the tool result error the model reads. |
| `signal` threaded into `CommandToolScope` | `InvokeOptions.cancelSignal` + `ToolContext.cancelSignal` per tool call; `agent.cancel()` | Tools receive the signal as their second argument. |
| `workdirAt: () => string` closure | `ToolContext.invocationState` (mutable, per invocation) or `agent.appState` | The checkout directory is invocation state. |
| `failureCode` / `isRetryable` on `.status` | `DefaultModelRetryStrategy` with `protected isRetryable(error)` and `computeRetryDecision(AfterModelCallEvent)`; `retryStrategy: null` to opt out | Bedrock throttling retried in the SDK with backoff; Berry classifies the *final* failure. |
| Nothing (context overflow is a failure) | `SlidingWindowConversationManager({ windowSize, threshold })`, `SummarizingConversationManager`, `ContextOffloader` plugin | Sliding window with proactive threshold is the safe default. |
| `BedrockChat.chat({ json: true })` + `readJson()` | `Agent({ structuredOutputSchema: zodSchema })` → `AgentResult.structuredOutput` | Implemented as a tool spec, so it works on Bedrock Converse across families. Requires Zod ≥ 4.1.12 as a peer; the server is on Zod 4.2. |
| `ConversationResponder` replaying history into one prompt | `Agent({ messages: history })` | Real multi-turn messages instead of a transcript pasted into a user turn. |
| `usage` summed from `modelMetadataEvent` | `ModelStreamUpdateEvent` wrapping a typed `ModelMetadataEvent` per model call; `AgentResult.metrics` aggregates the loop | `AfterModelCallEvent` carries `stopData.message`/`stopReason` and `error`, not usage, so usage still comes from the stream, now typed. |
| `BedrockModel` constructed inside `runAgent()` | `BedrockModel({ modelId, region, clientConfig: { credentials }, maxTokens, temperature, cacheConfig })` | One factory, shared by runs and completions. Prompt caching is available via `cacheConfig`. |
| `console.error` in memory | `traceAttributes: { runId, issueId, workspaceId }` + `@strands-agents/sdk/telemetry` | Optional; OTel is a peer dependency, not installed. |

Not available in the TS SDK and therefore not part of this plan: an AgentCore
Memory store (Berry's `agentcore/memory.ts` stays), and an AgentCore Runtime
sandbox (Berry's driver stays).

## 4. Approaches

**A. Type the seam, rename, stop.** Replace `translate()`'s string matching
with `instanceof` on SDK classes; rename `AdkExecutor`; delete dead code.
Two days. Removes problem 1 and 9 and nothing else. The executor stays 800
lines and untestable. Not recommended: it spends the effort without buying
the structure.

**B. Strands-native run (recommended).** Build the agent in one factory with
Berry plugins for ledger, permissions, accounting and result; give the
executor only the orchestration Berry owns; move single completions onto
structured output; delete `strands-runtime.ts` and `bedrock-chat.ts`. Keeps
every seam and contract listed in §1. Removes problems 1–9. Estimated at two
to three weeks in five shippable phases (§6). This is the approach the rest
of the document designs.

**C. B plus Strands' sandbox, sessions and multi-agent.** Replace the docker
driver with `DockerSandbox`, persist `Snapshot`s for resumable runs, and
express planner → triage → run as a Strands `Graph`. Rejected for now:
`DockerSandbox` covers one of three substrates and does not write the ledger;
snapshots duplicate the ledger as the record, which ADR-0012 already declined;
and orchestration across a board is the dispatcher's job by ADR-0008. Each is
listed as a possible follow-up in §9 with the condition under which it would
become worth doing.

## 5. Target design (approach B)

### 5.1 Module map

New files live under `server-ts/src/agents/runtime/`. Nothing in `mounts/`,
`runs/`, `execution/`, `scm/` or the frontend changes.

```
src/agents/
  executor.ts                 RunExecutor — claim · agent row · prepare · invoke · deliver · record   (~300 lines)
  tools.ts                    Berry tools (unchanged surface; use ToolContext)
  command-tool.ts             run_command (unchanged surface; permissions required; ToolContext)
  prompt.ts                   unchanged
  runtime/
    model.ts                  bedrockModel(spec): the ONE BedrockModel factory
    agent.ts                  buildRunAgent(spec): Agent + plugins + conversation manager + retry
    events.ts                 (test-only helpers) narrowing over SDK event classes
    result-text.ts            ResultText, SUBSTANTIVE_RESULT_BYTES   (moved, unchanged)
    output-buffer.ts          OutputBuffer, splitUtf8                (moved, unchanged)
    failure.ts                classify(error) → { code, retryable } reading $metadata.httpStatusCode
    plugins/
      ledger.ts               LedgerPlugin     — tool started/completed, output deltas, turn boundaries
      permissions.ts          PermissionPlugin — BeforeToolCallEvent → deny by tool→permission map
      accounting.ts           AccountingPlugin — usage per model call, tool-call count, result text
      tool-outcome.ts         ToolOutcomePlugin — policy for AfterToolCallEvent.error (F-23)
    testing/
      scripted-model.ts       ScriptedModel extends Model: replays a script of stream events
src/llm/
  completion.ts               Completion — text() and structured(schema) on a toolless Agent
  (bedrock-chat.ts deleted; readJson deleted)
```

`agents/strands-runtime.ts` is deleted. Its `bedrockModel()` moves to
`runtime/model.ts`; `runAgent()` and `translate()` have no successor because
the executor consumes `agent.stream()` directly and the plugins consume hooks.

### 5.2 Building the agent: `runtime/agent.ts`

```ts
export interface RunAgentSpec {
   model: string;                 // Bedrock inference profile id
   region: string;
   credentials: AwsCredentials | null;
   systemPrompt: string;
   tools: Tool[];
   plugins: Plugin[];             // Berry's, built by the executor with the ledger in scope
   maxTokens?: number;
   temperature?: number;
   traceAttributes: { runId: string; issueId: string; workspaceId: string; agentId: string };
}

export function buildRunAgent(spec: RunAgentSpec, modelFactory = bedrockModel): Agent {
   return new Agent({
      model: modelFactory(spec),
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      plugins: [...spec.plugins, new BerryRetryStrategy()],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 60, threshold: 0.7 }),
      traceAttributes: spec.traceAttributes,
      printer: false,
      name: toAgentName(spec.agentName),
   });
}
```

`modelFactory` is injectable so tests pass a `ScriptedModel`. No other
injection point is needed: everything else is a plugin, and plugins are
plain objects.

### 5.3 Plugins

Each plugin is a class implementing `Plugin` (`name`, `initAgent(agent)`),
registers its hooks with `agent.addHook`, and holds only what it needs. They
are constructed per run by the executor because they close over the ledger
and the run id, the same way tools close over the workspace.

**`LedgerPlugin`** (replaces `recordEvent`, `closeOpenTools`, the
`turn_complete` flush):

| Hook | Ledger call |
| --- | --- |
| `BeforeToolCallEvent` | `output.flush()` then `appendToolStarted(runId, toolUse.toolUseId, toolUse.name)`; remember the id as open |
| `AfterToolCallEvent` | `appendToolCompleted(runId, id, ok)` where `ok = !event.error && event.result.status !== 'error'`; forget the id |
| `ModelStreamUpdateEvent` whose inner event is a text `ModelContentBlockDeltaEvent` | `output.add(text)` |
| `MessageAddedEvent` with `role === 'assistant'` | `output.flush()` — the turn boundary |
| `AfterInvocationEvent` | `output.flush()`; every still-open tool id → `appendToolCompleted(runId, id, false)` |

The plugin reads deltas from the *stream*, not a hook, because there is no
hook for deltas; the executor forwards `ModelStreamUpdateEvent`s to it from
its `for await`. That is the one place the executor still touches events, and
it is one `instanceof`.

**`PermissionPlugin`** (replaces the in-tool check; closes F-09, F-10):

```ts
const REQUIRES: Record<string, Permission | null> = {
   run_command: 'run_commands',
   write_file: null,          // D3: decide 'write_artifacts' or leave ungated — see §8
   read_file: null, list_files: null, read_task: null, list_dependencies: null,
};
```

On `BeforeToolCallEvent`: unknown tool name → `event.cancel = 'this tool is not
available'`; mapped permission not held → `event.cancel = new
PermissionDenied(p, agentName).message`. The model receives the sentence as
the tool result, which is the behaviour `command-tool.ts` produces by hand
today, now for every tool and fail-closed. `permissions` becomes a required
field on `CommandToolScope` and the in-tool check is removed (hardening 9.1
done by construction).

**`AccountingPlugin`** (replaces the `usage` object, `toolCalls`, and the
`ResultText` bookkeeping):

- `ModelStreamUpdateEvent` whose inner event is a `ModelMetadataEvent` →
  add `usage.inputTokens/outputTokens` (forwarded from the executor's
  `for await`, the same way text deltas reach the ledger plugin).
- `AfterModelCallEvent` → `modelCalls += 1`; on `error` with no retry, keep
  the error for `failure.ts`.
- `AgentResult.metrics` at the end is compared against the summed usage in
  a test, so the two cannot drift silently.
- `BeforeToolCallEvent` → `toolCalls += 1`.
- `MessageAddedEvent` (assistant) → `result.append(text of message)`;
  `result.endTurn()`.
- Exposes `snapshot(): { usage: Usage; toolCalls: number; result: ResultText }`.

**`ToolOutcomePlugin`** (F-23, new policy point): on `AfterToolCallEvent`
with `event.error` set (the tool *threw*, as opposed to returning `exitCode
≠ 0`), record `run.tool.failed` reasons in a list the executor consults at the
end. Default policy: a thrown `write_file` (durable state lost) marks the run
`failed` with code `TOOL_FAILED`; a thrown `run_command` is reported to the
model and does not fail the run. The policy is a table in this file, not
spread across tools.

**`BerryRetryStrategy extends DefaultModelRetryStrategy`**: overrides
`isRetryable(error)` to read `$metadata.httpStatusCode` and the AWS error
`name` (`ThrottlingException`, `ModelTimeoutException`,
`ServiceUnavailableException`, `InternalServerException`), bounded attempts
with backoff. `runtime/failure.ts` uses the same predicate to classify the
final error into `RATE_LIMITED` / `UPSTREAM_UNAVAILABLE` /
`UPSTREAM_REJECTED` / `RUNTIME_ERROR`, so retry and reporting cannot disagree
(F-22).

### 5.4 The executor after the change

`RunExecutor.run()` becomes a straight line:

1. `claimDispatch`; `loadAgent` (unchanged).
2. Build `BerryArtifactService`, the lazy workspace, the tools.
3. `Promise.all([lastRejection, memory.recall])` (unchanged).
4. `markRunning` **inside** the try (hardening 2.3).
5. `prepareRepository` (unchanged); set `invocationState.workdir` rather
   than a closure.
6. Construct `LedgerPlugin`, `PermissionPlugin`, `AccountingPlugin`,
   `ToolOutcomePlugin`; `buildRunAgent(...)`.
7. `for await (const event of agent.stream(message, { cancelSignal: signal }))`
   forwarding `ModelStreamUpdateEvent` to the ledger plugin. The generator's
   return value is the `AgentResult`; its `stopReason` is checked
   (`'endTurn'` is success; anything else is recorded).
8. `deliverRepository` if prepared (unchanged).
9. `succeed` / `fail` / `cancel` using `accounting.snapshot()`; all three
   guard `RunTerminal` (hardening 2.1).
10. `finally { workspace.close() }`.

Cancellation: `cancelSignal` reaches the model call and every tool via
`ToolContext.cancelSignal`; `command-tool.ts` passes that to
`session.stream()` instead of a scope-level `signal`. The
`if (signal?.aborted) throw new RunCancelled()` checks stay because a signal
that fires between events must still end the run as cancelled rather than as
whatever `stopReason` the SDK reports.

### 5.5 Single completions: `llm/completion.ts`

```ts
export class Completion {
   constructor(options: { region; credentials; timeoutMs?; modelFactory? })
   async text(input: { model; system; user; signal? }): Promise<{ text; usage; durationMs }>
   async structured<T>(input: { model; system; user; schema: z.ZodType<T>; signal? }): Promise<{ value: T; usage; durationMs }>
   async converse(input: { model; system; messages: Message[]; signal? }): Promise<{ text; usage }>
}
```

Each method builds a toolless `Agent` with `retryStrategy: new
BerryRetryStrategy()`, `printer: false`, and — for `structured` —
`structuredOutputSchema: input.schema`; then `agent.invoke(...)`. Zod parse
failures surface as a typed `CompletionInvalid` with the model's raw text
attached for the caller's repair loop. `BedrockUnavailable` is replaced by
the same `classify()` the run path uses.

Callers:

- `plans/generator.ts` and `plans/triage.ts` call `structured()` with the
  schemas that already exist in `plans/schema.ts`; their `readJson` + manual
  `safeParse` blocks are removed. The generator's repair loop keeps its shape;
  it now repairs on `CompletionInvalid` rather than on `null`.
- `conversations/responder.ts` calls `converse()` with its
  `conversation_messages` mapped to `Message[]` instead of flattened into one
  user turn. `MAX_HISTORY` stays.
- `editor/assist.ts` calls `text()`.

### 5.6 Prompt hygiene (F-32, small and in scope)

`buildMessage()` wraps each untrusted block — description, run instructions,
review feedback, recalled memory — in labelled fences
(`<issue_description>…</issue_description>`) and the reporting contract says
they are data. The system prompt refuses to be empty: an agent row with no
instructions gets a one-line default naming it and its task. This is a text
change with a test, not a structural one, and it rides along because the
prompt is being touched anyway.

### 5.7 Testing strategy

- **`ScriptedModel`** (`runtime/testing/scripted-model.ts`) extends the SDK's
  abstract `Model` and yields a scripted sequence of `ModelStreamEvent`s per
  call, including tool-use blocks, so a test can say "the model calls
  `run_command`, then answers". This is the fixture that makes the loop
  testable at all (F-31).
- **Per plugin**: construct `new Agent({ model: scripted, tools, plugins:
  [plugin] })`, invoke, assert on a fake ledger. No database.
- **Executor**: DB-backed and self-skipping like `repository-run.test.ts`,
  using `ScriptedModel` through `modelFactory`. Cases: success records the
  substantive turn; a thrown tool with the strict policy fails the run; a
  denied tool produces a readable result and no side effect; cancellation
  between events records `cancelled`; a swept run does not throw out of
  `execute()`; the workspace is closed on every path.
- **Completion**: `structured()` returns a parsed value; a malformed answer
  raises `CompletionInvalid` with the raw text; a throttled call is retried
  then classified `RATE_LIMITED`.
- **Existing tests** for `ResultText`, `splitUtf8`, `toAgentName`, `prompt`,
  `command-tool`, `repository-run` keep passing with import paths updated.

### 5.8 Error handling

| Where | Behaviour |
| --- | --- |
| Model call throws after retries | `classify()` → `fail()` with the code; `retryable` only for 429/5xx |
| Tool throws | `ToolOutcomePlugin` policy; the model always receives a result |
| Tool denied | `BeforeToolCallEvent.cancel` string → tool result; no side effect |
| Context overflow | `SlidingWindowConversationManager.reduce()` on `ContextWindowOverflowError`; if it cannot reduce, the error reaches `fail()` as `RUNTIME_ERROR` with the SDK's message |
| Cancel signal | model call aborted; tools see `cancelSignal`; run recorded `cancelled`; `RunTerminal` swallowed |
| Ledger refuses (run went terminal) | plugins catch `RunTerminal` on append and stop writing; the executor's terminal recording is guarded |

## 6. Phased plan

Each phase is shippable and leaves `pnpm typecheck` and `pnpm test` green in
`server-ts/`. Branches follow `refactor/berr-NN-slug`; commits
`refactor(server-ts): … (BERR-NN)`. Issue numbers: the hardening spec
allocated BERR-66 onward, but BERR-66 and BERR-67 have since been used in
`git log` for other fixes, so **both specs need renumbering from BERR-68**
before work starts. Numbers below are placeholders `R1…R5`.

### Phase 0 — Spike (half a day, throwaway)

Confirm against the installed SDK, in a scratch test:

- `agent.stream()` with `plugins: [p]` calls `p.initAgent` and delivers
  `BeforeToolCallEvent`/`AfterToolCallEvent`/`AfterModelCallEvent`/
  `MessageAddedEvent` in the expected order for a two-turn tool script.
- `BeforeToolCallEvent.cancel = 'reason'` reaches the model as a tool result
  with `status: 'error'` and skips the callback.
- `structuredOutputSchema` returns `structuredOutput` on `BedrockModel`
  against a Claude inference profile (one live call).
- `ToolContext.cancelSignal` fires when `InvokeOptions.cancelSignal` aborts
  mid-tool.

Any of these failing changes Phase 1's design and is cheaper to learn now.

### Phase 1 — R1: typed events, one model factory, a testable loop

- Add `runtime/model.ts` (`bedrockModel`), `runtime/testing/scripted-model.ts`.
- Move `ResultText`, `OutputBuffer`, `splitUtf8` to `runtime/`; re-export
  nothing (no barrels); update imports and tests.
- Add `runtime/agent.ts` (`buildRunAgent` with injectable `modelFactory`),
  `plugins/ledger.ts`, `plugins/accounting.ts`.
- Executor consumes `agent.stream()` directly; `strands-runtime.ts` deleted.
- Wire `maxTokens`/`temperature` from config through the spec (F-25).
- Tests: plugin tests on `ScriptedModel`; first DB-backed executor test
  (success path).
- Docs: `AGENTS.md` and `server-ts/ARCHITECTURE.md` stop saying ADK;
  `executor.ts` header rewritten.

### Phase 2 — R2: permissions, cancellation, tool outcomes, retry

- `plugins/permissions.ts` with the tool→permission table; `permissions`
  required on `CommandToolScope`; in-tool check removed (F-09, F-10).
- Tools read `ToolContext.cancelSignal` and `invocationState.workdir`;
  `signal`/`workdirAt` removed from scopes.
- `plugins/tool-outcome.ts` with the default policy (F-23).
- `BerryRetryStrategy` and `runtime/failure.ts` on
  `$metadata.httpStatusCode`; `failureCode`/`isRetryable` deleted from the
  executor (F-22). Test pins against a captured `ThrottlingException` shape.
- `markRunning` inside the try; `succeed()` guards `RunTerminal` (hardening
  2.1, 2.3 — take them here because the surrounding code is being rewritten).
- Tests: denial produces a readable result and no side effect; a thrown
  `write_file` fails the run; cancel between events records `cancelled`; a
  swept run returns a `RunOutcome`.

### Phase 3 — R3: rename, prune, record the decision

- `AdkExecutor` → `RunExecutor`; ADK comments rewritten; `let streamed`,
  `stillOpen`, the `artifactKey()` triple (make `BerryArtifactService` take
  a run-scoped key) removed (F-26).
- Prompt hygiene per §5.6 (F-32) with tests.
- **ADR-0013: "Run agents on the Strands Agents SDK, natively"** — records
  that ADR-0008's decision (in-process agent loop, Berry owns the ledger and
  the tools) stands, that the library is Strands rather than ADK, and which
  SDK facilities Berry adopts (plugins, retry, conversation manager,
  structured output) and declines (sessions, sandbox, harness, graph) and
  why. ADR-0008 marked **Superseded** in its implementation details with a
  link both ways; `docs/adr/README.md` updated.
- `.kiro/specs/agent-runtime-hardening/tasks.md` updated: findings closed
  here are marked with the phase that closed them (§7).

### Phase 4 — R4: single completions on Strands

- Add `llm/completion.ts`; migrate `plans/generator.ts`, `plans/triage.ts`,
  `conversations/responder.ts`, `editor/assist.ts`.
- Delete `llm/bedrock-chat.ts`, `readJson`, `BedrockUnavailable`; update the
  three test files that construct `BedrockChat` to construct `Completion`
  with a `ScriptedModel`.
- `index.ts`: one `bedrockModel`-backed factory passed to all four and to the
  executor, so credentials are plumbed once (`credential-plumbing.test.ts`
  updated to assert this).
- Refactor-plan P2 (the shared LLM client's home) is closed by this phase.

### Phase 5 — R5: context management and traces

- `SlidingWindowConversationManager` with a proactive threshold on run
  agents; a test that a scripted 200-message run does not overflow.
- `traceAttributes` on every agent; `@strands-agents/sdk/telemetry` wired
  only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (peer packages added as
  optional dependencies). Reported in `GET /api/v1/config` only if actually
  configured, per the config rule in `AGENTS.md`.
- Evaluate `ContextOffloader` for `run_command` output once real runs show
  the sliding window truncating command results the model still needed;
  not adopted by default.

### Verification at every checkpoint

```
cd server-ts && pnpm typecheck && pnpm test
BERRY_TEST_DATABASE_URL=… pnpm migrate && pnpm test        # DB-backed suites
```

Plus one live run under `BERRY_RUNTIME_DRIVER=agentcore-runtime` at the end
of Phases 2 and 4, because the scripted model cannot exercise Bedrock's
actual event shapes.

## 7. Relationship to the hardening spec

| Finding | Effect of this refactor |
| --- | --- |
| F-09, F-10 (permissions unchecked / fail-open) | Closed by `PermissionPlugin` (Phase 2). Hardening 9.1 and 9.4 become its tests. D3 still needs an answer for `write_file`. |
| F-22 (retry reads `.status`) | Closed by `BerryRetryStrategy` + `failure.ts` (Phase 2). Hardening 16.1/16.3 become its tests. |
| F-23 (failed tool cannot fail a run) | Closed by `ToolOutcomePlugin` (Phase 2). Hardening 17.1's decision is the policy table. |
| F-25 (credentials/maxTokens dropped) | Closed by one model factory (Phase 1, Phase 4). |
| F-26 (ADK residue) | Closed (Phase 3). |
| F-31 (loop untested) | Closed by `ScriptedModel` and the executor tests (Phases 1–2). |
| F-32 (undelimited untrusted content) | Closed (Phase 3). |
| F-38 (`markRunning` outside try), F-02 (`succeed` unguarded) | Taken in Phase 2 because the executor is being rewritten there; hardening 2.1/2.3/2.5 reference this. |
| F-37 (`lazyWorkspace` memoises rejection) | Trivial in Phase 1 while moving the helper. |
| F-12, F-13 (command timeout, `cwd`) | Unchanged in scope but the tool now has `ToolContext`; hardening 10.x proceeds after Phase 2 on the new shape. |
| Everything else (ledger indexes, retention, replay topics, drivers, delivery ordering, cancel dispatch state) | Untouched. Those tasks proceed independently; none conflicts with this plan. |

Recommended sequencing: hardening **Phase 1** (BERR work-loss fixes in
`repository-run.ts`/`delivery.ts`) can land before or in parallel with this
refactor because it touches files this plan does not. Hardening Phases 3
(permissions) and 5 (classification) should **wait** for this plan's Phase 2,
or they will be rewritten twice.

## 8. Assumptions and open decisions

Stated because they could not be asked. Each is a default the plan proceeds
on; overriding any of them changes one phase, not the design.

1. **Bedrock remains the only provider.** Strands' `OpenAIModel`/
   `AnthropicModel` exist, but ADR-0008's "no model credential in the
   deployment" argument still holds and the model catalog is Bedrock's.
2. **The ledger stays the record; no `SessionManager`.** A resumable run is
   a product feature, not a refactor.
3. **`write_file` gating (D3).** Default in the permission table is
   *ungated, stated in `permissions.ts`*, because adding a permission needs
   a `034`-shaped migration and existing agents would lose the tool on
   deploy. Flip to `'write_artifacts'` plus migration 052 if the answer is
   otherwise.
4. **Tool-throw policy.** Default: a thrown `write_file` fails the run;
   other throws are reported to the model only. This is the narrowest rule
   that closes the false-success case.
5. **Sliding window over summarising.** Summarising costs a model call and
   changes what the model remembers; the window is predictable and the run
   ledger already holds everything that fell out of it.
6. **No OTel packages by default.** They are SDK peers; installing seven
   packages for a feature nobody has switched on is churn.
7. **Issue numbering.** Both specs renumber from BERR-68 once (§6).

## 9. Not adopted, and the condition under which it would be

- **`sandbox/docker` as the local `ExecutionDriver`.** It offers
  `executeStreaming` and `getTools()` but no ledger recording, no per-exec
  env (the credential rule in `checkout.ts` depends on it), and nothing for
  AgentCore Runtime. Revisit if Berry drops the AgentCore drivers and wants
  the SDK's vended `bash`/`file-editor` tools in the local case.
- **`SessionManager` / snapshots.** Revisit when a product decision asks for
  a run that resumes after a server restart mid-turn.
- **`multiagent` `Graph`/`Swarm`.** Revisit if the planner → triage → run
  pipeline is ever meant to run inside one invocation rather than across
  the dispatcher; today it is three product surfaces with human gates
  between them.
- **`vended-interventions/cedar`.** A Cedar policy for tool authorisation is
  ADR-0012 Phase 4's territory; the `PermissionPlugin` here is the hook it
  would replace, and is deliberately shaped so a Cedar handler can take its
  place in `interventions:` without touching tools.
- **`memoryManager`.** Berry's AgentCore Memory recall is a prompt fragment
  by design (recall as a story, oldest first); the SDK's memory manager
  would re-retrieve per turn, which is a different product behaviour.

## 10. Risks

- **SDK churn.** 1.16.0 marks `hooks:` removed and `plugins:` current;
  `interventions` and `memoryManager` are new. Mitigation: only `Plugin`,
  hook event classes, `Model`, `tool()`, `structuredOutputSchema`,
  `conversationManager` and `retryStrategy` are depended on, all in the
  main export; a pin to `~1.16` in `package.json` until Phase 5 lands.
- **Structured output on Bedrock.** Implemented as a forced tool call; a
  model that answers in prose instead raises. Mitigation: `CompletionInvalid`
  carries the raw text and the generator's repair loop already exists.
- **Behavioural drift in the ledger.** The event order the frontend's run
  stream expects (text, then tool started, then completed) must be
  preserved. Mitigation: the `LedgerPlugin` test asserts order against a
  scripted two-tool run, and the live run at the Phase 2 checkpoint is
  watched in the UI.

## 11. Outcome (2026-09-09)

Implemented on branch `refactor/strands-native-runtime` in fourteen commits;
`pnpm typecheck` clean and 534 tests passing (baseline 502). Phase 0's spike
confirmed every hook assumption; two findings changed the code from what §5
described:

- `ModelStreamUpdateEvent` is hookable, so the plugins see text deltas and
  usage themselves and the executor forwards nothing — it calls `invoke()`
  once.
- Usage is not on `AfterModelCallEvent`; it comes from the stream's
  `ModelMetadataEvent`, and `AgentResult.metrics` agrees with the sum.

Live checkpoint: `Completion.structured()` and `Completion.text()` verified
against Bedrock on the deployment's credentials. The first attempt failed with
`AccessDeniedException` on `bedrock:InvokeModelWithResponseStream`: the SDK
streams by default, the old raw client used non-streaming `Converse`, and the
documented policy (`docs/aws/berry-agent-bedrock-policy.json`) grants
`bedrock:InvokeModel` alone. Completions now ask for the non-streaming API
(`stream: false`) and keep the old permission footprint; runs stream by
design and the policy document now lists both actions — **a deployment on the
old policy cannot run agents until it is updated**, and that predates this
refactor (the run path was already on the SDK). A full repository run under
the live driver was not exercised in this session; §10's ledger-order risk is
covered by the offline loop tests and remains to be watched once in the UI.
