# ADR-0013: Run agents natively on the Strands Agents SDK

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Berry platform
- **Related:** [ADR-0008](0008-adk-agent-runtime.md) (in-process agent loop;
  the library named there was replaced), [ADR-0012](0012-agentcore-managed-services.md)
  (AgentCore Runtime/Gateway/Memory/Policy).
- **Supersedes:** the implementation section of ADR-0008. Its decision —
  agents run in Berry's process, Berry owns the ledger, the tools and the
  workspace — stands.

## Context

ADR-0008 chose an in-process agent library over a separate runtime service.
The library it named, Google ADK, was replaced by `@strands-agents/sdk` when
the server moved to TypeScript and the model to Bedrock; the replacement was
done behind a translation seam so the executor did not have to change. By
September 2026 that seam re-described the SDK's typed events as five Berry
events by string matching, the executor re-implemented what the SDK ships as
plugins, retry strategies and conversation managers, and a second Bedrock
client served the single-completion callers with a "reply in JSON" prompt and
a regex to recover it. Eleven findings in the agent-runtime hardening review
traced back to that shape: permissions checked inside one tool and fail-open,
retry classification reading a field AWS never sets, a thrown tool unable to
fail a run, credentials and inference parameters dropped between the
composition root and the model, and an orchestration loop with no test
because it constructed its own Bedrock client.

## Decision

Use the SDK natively. Berry's concerns are plugins on the SDK's lifecycle
hooks — `LedgerPlugin`, `PermissionPlugin`, `AccountingPlugin`,
`ToolOutcomePlugin`, and `BerryRetryStrategy` as the agent's retry strategy —
constructed per run with the ledger and the permission set in scope
(`server-ts/src/agents/runtime/`). The executor builds one `Agent` through
`buildRunAgent()` and calls `invoke()`; it reads no events. Single completions
(planner, triage, chat reply, editor) run on a toolless agent with
`structuredOutputSchema` (`server-ts/src/llm/completion.ts`). One
`bedrockModel()` factory serves everything, and a `ScriptedModel` drives the
real loop in tests.

Adopted from the SDK: `Plugin` and the hook events, `DefaultModelRetryStrategy`,
`SlidingWindowConversationManager`, `structuredOutputSchema`,
`traceAttributes`, `ToolContext.cancelSignal` and `agent.appState`.

Declined, with the condition under which each would be revisited:

- **`SessionManager` and snapshots.** A resumable run is a product feature;
  the ledger is the record. Revisit when a run must resume after a server
  restart mid-turn.
- **`sandbox/docker`.** Covers one of three execution substrates and does not
  write the ledger or scope a credential to one exec. Revisit if the AgentCore
  drivers go and the SDK's vended `bash`/`file-editor` tools are wanted.
- **`multiagent` Graph/Swarm.** Orchestration across a board belongs to the
  dispatcher (ADR-0008). Revisit if planner → triage → run is ever meant to
  run inside one invocation.
- **The Cedar intervention.** ADR-0012 Phase 4's territory; `PermissionPlugin`
  is the hook it would replace, and is shaped so a handler can take its place
  in `interventions:` without touching tools.
- **`memoryManager`.** AgentCore Memory recall is a prompt fragment by design
  (a story, oldest first); per-turn retrieval is a different product behaviour.

## Consequences

The ledger, the execution drivers, the repository half, the dispatcher, the
`/api/v1` contract and the schema are unchanged. Permissions fail closed for
every tool, from one table. A Bedrock throttle is retried inside the SDK and
classified from `$metadata.httpStatusCode`. A thrown `write_file` fails the
run rather than reporting a file that was never saved. Untrusted prompt
content is fenced and named as data. The loop has offline tests. The SDK is
pinned to `~1.16` and only main-export symbols are depended on.

Decisions taken along the way, recorded so they read as decisions: artifact
writes stay ungated (a permission would need a migration granting it to
existing agents, and an artifact is the run's own output); a thrown
`run_command` is reported to the model and does not fail the run, because a
substrate fault is something the agent can say so about.
