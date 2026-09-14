# Parity A: Control Plane and AgentCore Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Strands agent loop out of the Berry server into the AgentCore Runtime container. The dispatcher sends a task envelope with `InvokeAgentRuntime` and records the container's SSE lifecycle stream in the run ledger. Sessions persist per `(agent, issue)`, and the Berry server process imports no model SDK.

**Architecture:** Berry becomes a control plane. It queues tasks (`runs`), claims them as it does today (lease, heartbeat, sweep), builds a `TaskEnvelope` (agent config, prompt, transcript rebuilt from `run_events`, repo plan, task-scoped Berry token), and invokes a runtime through a `RuntimeTransport`. There are three transports: AgentCore, local HTTP (the same image under Docker), and an in-process fake for tests. The container (`src/agents/runtime/container/`, shipped by `server-ts/sandbox/agentcore/Dockerfile`) keeps a per-session map. A warm session appends to its live Strands conversation. A cold one restores from `transcript`. Tools run locally (shell, files, git), except Berry tools, which are fetched as a manifest from `/api/v1/agent-tools` and called with the task token. Short model calls (planner, triage, review gate, chat, editor) become `kind: 'completion'` tasks via `runCompletion`.

**Tech Stack:** Node 22 `--experimental-strip-types`, TypeScript strict (`erasableSyntaxOnly`), Hono, postgres.js, Zod v4 (server; `z.toJSONSchema` / `z.fromJSONSchema` available in the pinned 4.4.3), `@strands-agents/sdk` ~1.16 (container only), `@aws-sdk/client-bedrock-agentcore` (`InvokeAgentRuntimeCommand`, `StopRuntimeSessionCommand`), `@aws-sdk/client-bedrock-agentcore-control` (`LifecycleConfiguration`), Next.js 15 frontend with Zod v3.

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` — section 2 (2.1, 2.2, 2.2a, 2.3, 2.4, 2.5), section 11, section 12 day 1, section 13.

## Global Constraints

- Web only. Clean-room: never copy multica source, schema text, copy or UI; implement behaviour only. No new integrations.
- Bedrock, reached only from inside AgentCore Runtime, is the single LLM source. After this plan the Berry server process imports no model SDK (enforced by `scripts/check-no-model-in-server.py`).
- Server code style: no emitted TS syntax (no enums, namespaces, parameter properties), relative imports keep `.ts`, `import type` for types, 3-space indent, single quotes, no `any`, no `!` where narrowing works. Zod v4 on the server; Zod v3 on the frontend.
- Frontend: Prettier 3-space, single quotes, semicolons, es5 trailing commas, printWidth 100; gates are `pnpm lint` and `pnpm build:check` in `frontend/`.
- Tests: `node --test` co-located `*.test.ts`. DB tests skip when `BERRY_TEST_DATABASE_URL` is unset. Mount tests drive `createApp(registry)` with `app.request(...)`.
- Migrations: forward-only, workstream A owns numbers **053–059**. Every new table carries `workspace_id`.
- Secrets only through `integrations/sealing.ts`; never sent to the browser, never logged. Only the envelope carries decrypted env/credentials to the runtime.
- Realtime: new events go through `outbox_events` + the existing SSE hub; no WebSocket.
- `runtimeSessionId = "berry-" + sha256(agentId + ":" + issueId)`; chat uses `(agentId, chatSessionId)`; completion tasks use a fresh session per run.
- Runtime lifecycle: `idleRuntimeSessionTimeout` default **3600 s** (per runtime profile, maximum **28800**), `maxLifetime` **28800 s**.
- `/ping` returns `{"status":"HealthyBusy"}` while any loop is working, `{"status":"Healthy"}` otherwise.
- A stream that ends without `task.completed`/`task.failed` is recorded as `RUNTIME_STREAM_ENDED`, retryable.
- Commit messages: `type(scope): imperative summary`, ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

### Shared cross-plan contract (exact names, owned here)

- `server-ts/src/runtime/envelope.ts`: `type TaskEnvelope`, `taskEnvelopeSchema`.
- `server-ts/src/runtime/lifecycle.ts`: `type LifecycleEvent = {type:'task.started'} | {type:'task.message', message} | {type:'task.usage', usage: TaskUsage} | {type:'task.completed', result} | {type:'task.failed', failure:{code,message,retryable}}`.
- `server-ts/src/runs/queue.ts`: `enqueueTask(sql, input: { workspaceId: string; agentId: string; issueId?: string; kind: 'agent' | 'completion'; source: 'assignment' | 'mention' | 'chat' | 'autopilot' | 'squad' | 'quick_action' | 'builder' | 'completion'; prompt?: string; chatSessionId?: string; autopilotRunId?: string; priority?: number }): Promise<{ runId: string }>`.
- `server-ts/src/runtime/completion.ts`: `runCompletion<T>(deps, { workspaceId, purpose, system, prompt, schema }): Promise<T>`.
- `server-ts/src/runtime/agent-tools/registry.ts`: `registerAgentTool(name, def)`; mount `/api/v1/agent-tools/*`; table `task_tokens`.
- Tables `agent_runtimes`, `runtime_profiles` (A). A calls C's `recordTaskUsage(sql, {...})` from `server-ts/src/usage/record.ts` on `task.usage`.

---

## File Structure

**Server — control plane (new)**
| File | Responsibility |
|---|---|
| `server-ts/src/runtime/envelope.ts` | `taskEnvelopeSchema`, `TaskEnvelope`, `redactEnvelope` |
| `server-ts/src/runtime/lifecycle.ts` | `LifecycleEvent` schema + SSE `encodeLifecycle` / `parseLifecycleStream` |
| `server-ts/src/runtime/session-id.ts` | `sessionKeyFor`, `runtimeSessionIdFor` |
| `server-ts/src/runtime/transport.ts` | `RuntimeTransport`, `RuntimeTarget` interfaces |
| `server-ts/src/runtime/agentcore-transport.ts` | `InvokeAgentRuntime` / `StopRuntimeSession` |
| `server-ts/src/runtime/http-transport.ts` | local Docker: `POST {url}/invocations` |
| `server-ts/src/runtime/in-process-transport.ts` | test/dev: runs the container handler in process |
| `server-ts/src/runtime/transcript.ts` | prior conversation for a session from `run_events` |
| `server-ts/src/runtime/envelope-builder.ts` | `Dispatch` + agent + runtime → `TaskEnvelope` |
| `server-ts/src/runtime/task-executor.ts` | `RuntimeTaskExecutor` (dispatcher `Executor`): lifecycle → ledger |
| `server-ts/src/runtime/delivery.ts` | opens the PR for a container-pushed branch, writes `run.delivered` |
| `server-ts/src/runtime/completion.ts` | `runCompletion`, `RuntimeCompletion` adapter, `CompletionInvalid`, `CompletionFailed` |
| `server-ts/src/runtime/runtimes.ts` | `RuntimeRepository` (runtimes + profiles), `syncPlatformRuntime` |
| `server-ts/src/runtime/runtime-control.ts` | `lifecycleFor`, `applyLifecycle` (control plane) |
| `server-ts/src/runtime/agent-tools/tokens.ts` | mint/resolve/revoke task tokens |
| `server-ts/src/runtime/agent-tools/registry.ts` | `registerAgentTool`, `listAgentTools`, `getAgentTool` |
| `server-ts/src/runtime/agent-tools/core-tools.ts` | the built-in Berry tools |
| `server-ts/src/runtime/agent-tools/mount.ts` | `/api/v1/agent-tools` |
| `server-ts/src/runtime/test-fixture.ts` | DB fixture shared by runtime DB tests |
| `server-ts/src/runs/queue.ts` | `enqueueTask` |
| `server-ts/src/mounts/runtimes.ts` | `/api/v1/runtimes` |
| `server-ts/migrations/053_agentcore_runtime_control_plane.{up,down}.sql` | schema |

**Server — container (new, under `src/agents/runtime/` so the model-SDK rule allows it)**
| File | Responsibility |
|---|---|
| `server-ts/src/agents/runtime/utf8.ts` | `truncateUtf8` (moved out of `runs/result-comment.ts`) |
| `server-ts/src/agents/runtime/terminal.ts` | `RunTerminal` (moved out of `runs/ledger.ts`) |
| `server-ts/src/agents/runtime/container/local-session.ts` | `ExecutionSession` over `child_process` |
| `server-ts/src/agents/runtime/container/emitter.ts` | `LedgerSink` + command-ledger that emit `task.message` |
| `server-ts/src/agents/runtime/container/remote-tools.ts` | Berry tools from `/api/v1/agent-tools` manifest |
| `server-ts/src/agents/runtime/container/sessions.ts` | `SessionRegistry` (warm map, busy tracking) |
| `server-ts/src/agents/runtime/container/handler.ts` | `handleInvocation(envelope, emit, deps)` |
| `server-ts/src/agents/runtime/container/completion-task.ts` | the `kind:'completion'` path |
| `server-ts/src/agents/runtime/container/repository.ts` | checkout / verify / commit+push inside the container |
| `server-ts/src/agents/runtime/container/server.ts` | `/ping` + `/invocations` HTTP server |
| `server-ts/src/agents/runtime/container/main.ts` | image entrypoint |
| `server-ts/src/agents/runtime/tools/media.ts` | moved from `src/agents/media-tools.ts` |

**Modified:** `src/execution/agentcore-runtime.ts` (`runtimeSessionId`), `src/runs/dispatcher.ts` (claim order, runtime concurrency, `nudge`), `src/runs/result-comment.ts`, `src/runs/ledger.ts` (re-exports), `src/agents/command-tool.ts` (structural ledger type), `src/agents/runtime/failure.ts`, `src/agents/runtime/plugins/ledger.ts`, completion callers (`plans/triage.ts`, `plans/generator.ts`, `agents/review-gate.ts`, `conversations/responder.ts`, `editor/assist.ts`, `mounts/plans.ts`, `mounts/editor.ts`, `mounts/conversations.ts`), `src/index.ts`, `src/config/config.ts`, `sandbox/agentcore/Dockerfile`, `docker-compose.yml`, `scripts/check-compose-config.py`, `package.json` (test glob unchanged: new files are under `src/`).

**Deleted at cut-over (Task 17):** `src/llm/completion.ts`, `src/llm/completion.test.ts`, `src/llm/credential-plumbing.test.ts`, `src/agents/executor.ts`, `src/agents/executor.test.ts`, `src/agents/executor-loop.test.ts`, `src/agents/tools.ts`, `src/agents/media-tools.ts` (moved), `sandbox/agentcore/server.mjs`.

**Docs:** `docs/adr/0014-agentcore-runtime-control-plane.md`, `docs/adr/README.md`, `AGENTS.md`, `server-ts/SCOPE.md`.

**Frontend (new):** `frontend/lib/runtimes.ts`, `frontend/components/common/runtimes/runtimes-list.tsx`, `frontend/components/common/runtimes/runtime-detail.tsx`, `frontend/app/[orgId]/runtimes/page.tsx`, `frontend/app/[orgId]/runtimes/[runtimeId]/page.tsx`; modified `frontend/components/layout/sidebar/nav-settings.tsx`.

### Parallelisation

- Wave 1 (independent): Tasks 1, 2, 3, 4.
- Wave 2: 5, 6 (need 4); 7 (needs 2).
- Wave 3: 8, 9 (need 7); 13 (needs 2, 3); 14 (needs 4).
- Wave 4: 10, 11 (need 9); 12 (needs 9); 15 (needs 5, 6, 13, 14).
- Wave 5: 16 (needs 5, 15); 18 (needs 4); 19 (needs 18).
- Wave 6: 17 (cut-over, needs everything above; needs C's `recordTaskUsage` merged).
- Optional: 20.

---

### Task 1: ADR-0014 and the no-model-in-server check

**Files:**
- Create: `docs/adr/0014-agentcore-runtime-control-plane.md`
- Modify: `docs/adr/README.md` (index row)
- Create: `scripts/check-no-model-in-server.py`
- Create: `scripts/test_check_no_model_in_server.py`
- Modify: `AGENTS.md` (Commands block), `docs/coding-playbook.md` (Definition of done)
- Modify: root `package.json` (a `check:models` script). The repository has no CI workflow (`.github/workflows` does not exist), so the spec's "fails CI" is met by this script plus the Definition-of-done gate; whoever adds CI runs `pnpm check:models`.

**Interfaces:**
- Consumes: nothing.
- Produces: `python3 scripts/check-no-model-in-server.py [--root DIR]`. It exits 0 when clean and 1 with one line per offence (`path:line: forbidden import 'x'` or `package.json: provider SDK 'x'`). Task 17 makes it pass on the repo.

- [ ] **Step 1: Write the failing test**

`scripts/test_check_no_model_in_server.py`:

```python
#!/usr/bin/env python3
"""Self-test for check-no-model-in-server.py against throwaway trees."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-no-model-in-server.py"
spec = importlib.util.spec_from_file_location("check_no_model", SCRIPT)
assert spec and spec.loader
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def tree(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp())
    for rel, body in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return root


class CheckTest(unittest.TestCase):
    def test_runtime_modules_may_import_the_model_sdk(self) -> None:
        root = tree({
            "server-ts/src/agents/runtime/model.ts": "import { BedrockModel } from '@strands-agents/sdk';\n",
            "server-ts/package.json": json.dumps({"dependencies": {"zod": "^4"}}),
        })
        self.assertEqual(check.find_offences(root), [])

    def test_server_code_importing_the_model_sdk_is_refused(self) -> None:
        root = tree({
            "server-ts/src/plans/triage.ts": "import {\n   Agent,\n} from '@strands-agents/sdk';\n",
            "server-ts/src/x.ts": "const m = await import('@aws-sdk/client-bedrock-runtime');\n",
        })
        offences = check.find_offences(root)
        self.assertEqual(len(offences), 2)
        self.assertIn("server-ts/src/plans/triage.ts", offences[0])

    def test_type_only_imports_are_allowed(self) -> None:
        root = tree({"server-ts/src/a.ts": "import type { Message } from '@strands-agents/sdk';\n"})
        self.assertEqual(check.find_offences(root), [])

    def test_catalog_may_use_the_bedrock_control_plane_only(self) -> None:
        root = tree({
            "server-ts/src/agents/catalog.ts": "import { BedrockClient } from '@aws-sdk/client-bedrock';\n",
            "server-ts/src/b.ts": "import { BedrockClient } from '@aws-sdk/client-bedrock';\n",
        })
        offences = check.find_offences(root)
        self.assertEqual(len(offences), 1)
        self.assertIn("server-ts/src/b.ts", offences[0])

    def test_provider_sdk_in_any_package_json_is_refused(self) -> None:
        root = tree({
            "frontend/package.json": json.dumps({"dependencies": {"openai": "^4"}}),
            "server-ts/package.json": json.dumps({"devDependencies": {"@anthropic-ai/sdk": "^1"}}),
            "node_modules/x/package.json": json.dumps({"dependencies": {"openai": "^4"}}),
        })
        self.assertEqual(len(check.find_offences(root)), 2)

    def test_a_value_import_that_loads_the_sdk_through_the_runtime_tree_is_refused(self) -> None:
        root = tree({
            "server-ts/src/agents/runtime/agent.ts": (
                "import { Agent } from '@strands-agents/sdk';\nexport const toAgentName = (n: string) => n;\n"
            ),
            "server-ts/src/agents/runtime/utf8.ts": "export const truncateUtf8 = (s: string) => s;\n",
            "server-ts/src/conversations/responder.ts": "import { toAgentName } from '../agents/runtime/agent.ts';\n",
            "server-ts/src/agents/prompt.ts": "import { truncateUtf8 } from './runtime/utf8.ts';\n",
            "server-ts/src/runtime/x.test.ts": "import { toAgentName } from '../agents/runtime/agent.ts';\n",
        })
        offences = check.find_offences(root)
        self.assertEqual(len(offences), 1)
        self.assertIn("server-ts/src/conversations/responder.ts", offences[0])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 scripts/test_check_no_model_in_server.py`
Expected: FAIL. The script does not exist, so `FileNotFoundError` is raised at `exec_module`.

- [ ] **Step 3: Write the check**

`scripts/check-no-model-in-server.py`:

```python
#!/usr/bin/env python3
"""Fail when the Berry server process could reach a model provider.

Bedrock is reached only from inside AgentCore Runtime (ADR-0014). The loop and
its tools live under server-ts/src/agents/runtime/, which is what the runtime
image ships; nothing else in server-ts/src may import a model SDK, and no
package.json in the repository may depend on a provider SDK at all.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = "server-ts/src/agents/runtime/"
FORBIDDEN_IMPORTS = (
    "@strands-agents/sdk",
    "@aws-sdk/client-bedrock-runtime",
    "@aws-sdk/client-bedrock",
    "@anthropic-ai/",
    "openai",
    "@ai-sdk/",
    "@google/genai",
    "@google/generative-ai",
    "@mistralai/",
    "cohere-ai",
    "groq-sdk",
    "ollama",
)
# The model catalogue lists foundation models (a control-plane read); it never
# invokes one. Anything else under the bedrock control plane is refused.
CONTROL_PLANE_ALLOWED = {"server-ts/src/agents/catalog.ts": ("@aws-sdk/client-bedrock",)}
PROVIDER_PACKAGES = re.compile(
    r"^(openai|ai|@anthropic-ai/.*|@ai-sdk/.*|@google/genai|@google/generative-ai|"
    r"@mistralai/.*|cohere-ai|groq-sdk|ollama|@langchain/.*|langchain)$"
)
SKIP_DIRS = {"node_modules", ".next", ".next-verify", ".git"}
STATIC_IMPORT = re.compile(
    r"^\s*(?:import|export)\s+(type\s+)?(?:[^;'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]",
    re.MULTILINE | re.DOTALL,
)
DYNAMIC_IMPORT = re.compile(r"import\(\s*['\"]([^'\"]+)['\"]\s*\)")


def forbidden(specifier: str) -> bool:
    return any(
        specifier == name or (name.endswith("/") and specifier.startswith(name)) or specifier.startswith(name + "/")
        for name in FORBIDDEN_IMPORTS
    )


def skipped(path: Path, root: Path) -> bool:
    parts = path.relative_to(root).parts
    return any(part in SKIP_DIRS or part.startswith(".tmp") for part in parts)


def source_offences(root: Path) -> list[str]:
    offences: list[str] = []
    src = root / "server-ts" / "src"
    if not src.is_dir():
        return offences
    for path in sorted(src.rglob("*.ts")):
        rel = path.relative_to(root).as_posix()
        if rel.startswith(RUNTIME_DIR) or skipped(path, root):
            continue
        text = path.read_text(encoding="utf-8")
        found: list[tuple[int, str]] = []
        for match in STATIC_IMPORT.finditer(text):
            if match.group(1):  # `import type` emits nothing
                continue
            found.append((match.start(), match.group(2)))
        for match in DYNAMIC_IMPORT.finditer(text):
            found.append((match.start(), match.group(1)))
        for offset, specifier in found:
            if not forbidden(specifier):
                continue
            if specifier in CONTROL_PLANE_ALLOWED.get(rel, ()):
                continue
            line = text.count("\n", 0, offset) + 1
            offences.append(f"{rel}:{line}: forbidden import '{specifier}'")
    return offences


def package_offences(root: Path) -> list[str]:
    offences: list[str] = []
    for path in sorted(root.rglob("package.json")):
        if skipped(path, root):
            continue
        manifest = json.loads(path.read_text(encoding="utf-8"))
        for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            for name in sorted((manifest.get(field) or {}).keys()):
                if PROVIDER_PACKAGES.match(name):
                    rel = path.relative_to(root).as_posix()
                    offences.append(f"{rel}: provider SDK '{name}' in {field}")
    return offences


def value_imports(text: str) -> list[tuple[int, str]]:
    found = [(m.start(), m.group(2)) for m in STATIC_IMPORT.finditer(text) if not m.group(1)]
    found += [(m.start(), m.group(1)) for m in DYNAMIC_IMPORT.finditer(text)]
    return found


def transitive_offences(root: Path) -> list[str]:
    """Server modules that load a model SDK through a runtime module.

    The direct rule alone passes `import { toAgentName } from
    '../agents/runtime/agent.ts'`, yet that line loads @strands-agents/sdk into
    the server process. So every non-test module outside the runtime tree is
    followed through its relative value imports, and reaching a runtime module
    that imports a model SDK is an offence. Tests never run in the server
    process and are exempt.
    """
    offences: list[str] = []
    src = root / "server-ts" / "src"
    if not src.is_dir():
        return offences
    for entry in sorted(src.rglob("*.ts")):
        rel = entry.relative_to(root).as_posix()
        if rel.startswith(RUNTIME_DIR) or rel.endswith(".test.ts") or skipped(entry, root):
            continue
        seen: set[Path] = set()
        stack = [entry]
        hit: tuple[str, str] | None = None
        while stack and hit is None:
            current = stack.pop()
            if current in seen or not current.is_file():
                continue
            seen.add(current)
            try:
                current_rel = current.relative_to(root).as_posix()
            except ValueError:
                continue
            for _, specifier in value_imports(current.read_text(encoding="utf-8")):
                if specifier.startswith("."):
                    # normpath, not resolve(): a symlinked root (macOS /var) must stay comparable.
                    stack.append(Path(os.path.normpath(current.parent / specifier)))
                elif current != entry and current_rel.startswith(RUNTIME_DIR) and forbidden(specifier):
                    hit = (specifier, current_rel)
                    break
        if hit:
            offences.append(f"{rel}: reaches forbidden import '{hit[0]}' through {hit[1]}")
    return offences


def find_offences(root: Path) -> list[str]:
    return source_offences(root) + transitive_offences(root) + package_offences(root)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    offences = find_offences(args.root.resolve())
    for offence in offences:
        print(offence)
    if offences:
        print(f"{len(offences)} model-SDK offence(s); see ADR-0014", file=sys.stderr)
        return 1
    print("no model SDK outside server-ts/src/agents/runtime/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 scripts/test_check_no_model_in_server.py`
Expected: `Ran 6 tests ... OK`.

Run on the repo (expected to fail until Task 17): `python3 scripts/check-no-model-in-server.py; echo exit=$?`
Expected: `exit=1`. 20 offences (verified by running this script against today's tree). Direct: `server-ts/src/llm/completion.ts`, `llm/completion.test.ts`, `agents/command-tool.ts`, `agents/command-tool.test.ts`, `agents/tools.ts`, `agents/media-tools.ts` (two), `observability/telemetry.ts` (`@strands-agents/sdk/telemetry`) and `conversations/responder.ts`. Transitive, through `agents/runtime/*`: `agents/executor.ts`, `agents/review-gate.ts`, `conversations/responder.ts` (via `toAgentName` in `agents/runtime/agent.ts`), `editor/assist.ts`, `index.ts`, `llm/completion.ts`, `mounts/conversations.ts`, `mounts/editor.ts`, `mounts/plans.ts`, `plans/generator.ts`, `plans/triage.ts` (all but responder via `llm/completion.ts`). Record the list in the commit body; Task 17 must drive it to zero.

- [ ] **Step 5: Write ADR-0014**

`docs/adr/0014-agentcore-runtime-control-plane.md`:

```markdown
# ADR-0014: Berry is a control plane; the agent loop runs in AgentCore Runtime

- **Status:** Accepted
- **Date:** 2026-09-10
- **Deciders:** Berry platform
- **Related:** ADR-0008, ADR-0012, ADR-0013
- **Supersedes:** the "loop stays in Berry's process" parts of ADR-0008, ADR-0012 and ADR-0013.
  Their other decisions stand: Berry owns the ledger, the tools' product surface
  and the workspace; Strands is the loop; Bedrock is the model.

## Context

The loop ran in the API process and reached a runtime container one shell
command at a time through `InvokeAgentRuntimeCommand`. Every command was a
network round trip, and the API held Bedrock credentials and a model client.
The parity spec requires Bedrock to be reached only from inside AgentCore
Runtime, sessions to be resumable per `(agent, issue)`, and one runtime
concept that operators can register, bound and observe.

## Decision

1. The Strands loop, its plugins and its local tools run in the runtime image
   (`server-ts/sandbox/agentcore/`), from the same sources in
   `server-ts/src/agents/runtime/`, under `--experimental-strip-types`.
2. The server dispatches with `InvokeAgentRuntime`: a JSON `TaskEnvelope` in, an
   SSE stream of `LifecycleEvent`s out (`task.started`, `task.message`,
   `task.usage`, `task.completed`, `task.failed`). The ledger stays the only
   writer of run state. A stream ending without a terminal event is
   `RUNTIME_STREAM_ENDED`, retryable. Cancel aborts the stream and calls
   `StopRuntimeSession`.
3. `runtimeSessionId = "berry-" + sha256(agentId + ":" + issueId)` (chat:
   `(agentId, chatSessionId)`); completion tasks get a fresh session. The
   container keeps warm conversations per session; the envelope always carries
   a transcript rebuilt from `run_events` so a reaped microVM restores cold.
   Lifecycle: idle timeout 3600 s by default (per runtime profile, at most
   28800), `maxLifetime` 28800 s, `/ping` answers `HealthyBusy` while working.
4. Agents act on Berry through `/api/v1/agent-tools/*` with a task-scoped token
   (`task_tokens`), never through the database.
5. Single model calls (planner, triage, review gate, chat, editor) are
   `kind: 'completion'` tasks via `runCompletion`.
6. `scripts/check-no-model-in-server.py` fails when `server-ts/src` outside
   `agents/runtime/` imports a model SDK, or any `package.json` depends on a
   provider SDK. `agents/catalog.ts` may use the Bedrock *control plane* to list
   models.
7. The local `docker` driver runs the same image with the same `/invocations`
   contract.

## Consequences

- The API image no longer needs Bedrock credentials; the runtime's execution
  role (or, locally, the `agent-runtime` service's env) does.
- Every image change needs a redeploy of the runtime.
- `BERRY_PUBLIC_URL` must be reachable from AgentCore (a tunnel locally).
- `StopRuntimeSession` on cancel ends a session that later runs may reuse; the
  cold path restores it.
- A run past `maxLifetime` loses its lease, is re-queued retryable and resumes
  cold.
```

Add a row to `docs/adr/README.md` in the same format as the existing ADR-0013 row, naming `0014-agentcore-runtime-control-plane.md`. In `AGENTS.md`, under `# Repository checks` in the Commands block, add:

```bash
python3 scripts/check-no-model-in-server.py
```

In `docs/coding-playbook.md` under "Definition of done", **Server** bullet, append: `and python3 scripts/check-no-model-in-server.py passes`.

In the root `package.json` `scripts`, add `"check:models": "python3 scripts/test_check_no_model_in_server.py && python3 scripts/check-no-model-in-server.py"` (it exits 1 until Task 17, by design).

- [ ] **Step 6: Commit**

```bash
git add scripts/check-no-model-in-server.py scripts/test_check_no_model_in_server.py docs/adr/0014-agentcore-runtime-control-plane.md docs/adr/README.md AGENTS.md docs/coding-playbook.md package.json
git commit -m "docs: decide the agent loop runs in AgentCore Runtime (ADR-0014)

Adds the no-model-in-server repository check; it lists today's offences
and is driven to zero by the runtime cut-over.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Task envelope and lifecycle contracts

**Files:**
- Create: `server-ts/src/runtime/envelope.ts`, `server-ts/src/runtime/envelope.test.ts`
- Create: `server-ts/src/runtime/lifecycle.ts`, `server-ts/src/runtime/lifecycle.test.ts`

**Interfaces:**
- Consumes: `zod` only. Both files must import nothing else, because the container ships them.
- Produces:
  - `taskEnvelopeSchema`, `type TaskEnvelope`, `type TranscriptMessage = { role: 'user' | 'assistant'; text: string }`, `type RepoPlan`, `redactEnvelope(e: TaskEnvelope): unknown`.
  - `lifecycleEventSchema`, `type LifecycleEvent`, `type TaskUsage`, `type TaskMessage`, `type TaskResult`, `type TaskDelivery`, `type TaskFailure`.
  - `encodeLifecycle(e: LifecycleEvent): string`, `parseLifecycleStream(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<LifecycleEvent>`, `isTerminal(e): boolean`, `class LifecycleStreamError`.

- [ ] **Step 1: Write the failing tests**

`server-ts/src/runtime/lifecycle.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   LifecycleStreamError,
   encodeLifecycle,
   isTerminal,
   parseLifecycleStream,
   type LifecycleEvent,
} from './lifecycle.ts';

async function collect(chunks: Array<Uint8Array | string>): Promise<LifecycleEvent[]> {
   async function* source() {
      for (const chunk of chunks) yield chunk;
   }
   const out: LifecycleEvent[] = [];
   for await (const event of parseLifecycleStream(source())) out.push(event);
   return out;
}

const events: LifecycleEvent[] = [
   { type: 'task.started' },
   { type: 'task.message', message: { kind: 'output', channel: 'progress', text: 'héllo ✓' } },
   { type: 'task.message', message: { kind: 'tool.started', toolCallId: 'c1', name: 'run_command' } },
   {
      type: 'task.usage',
      usage: { model: 'm', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
   },
   { type: 'task.completed', result: { text: 'done', truncated: false, delivery: null } },
];

test('every lifecycle event survives the SSE round trip', async () => {
   const wire = events.map(encodeLifecycle).join('');
   assert.deepEqual(await collect([wire]), events);
});

test('a frame split mid-character across chunks still decodes', async () => {
   const bytes = new TextEncoder().encode(events.map(encodeLifecycle).join(''));
   const chunks = [];
   for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
   assert.deepEqual(await collect(chunks), events);
});

test('keepalive comments and CRLF framing are tolerated', async () => {
   const wire = `: ping\r\n\r\ndata: ${JSON.stringify({ type: 'task.started' })}\r\n\r\n`;
   assert.deepEqual(await collect([wire]), [{ type: 'task.started' }]);
});

test('a malformed frame is an error, not a silent skip', async () => {
   await assert.rejects(collect(['data: {not json\n\n']), LifecycleStreamError);
   await assert.rejects(collect([`data: ${JSON.stringify({ type: 'task.exploded' })}\n\n`]), LifecycleStreamError);
});

test('only completed and failed are terminal', () => {
   assert.equal(isTerminal({ type: 'task.started' }), false);
   assert.equal(isTerminal({ type: 'task.failed', failure: { code: 'X', message: 'm', retryable: true } }), true);
   assert.equal(isTerminal(events[4]!), true);
});
```

`server-ts/src/runtime/envelope.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactEnvelope, taskEnvelopeSchema, type TaskEnvelope } from './envelope.ts';

export function sampleEnvelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
   return {
      kind: 'agent',
      runId: '11111111-1111-4111-8111-111111111111',
      sessionKey: 'a:i',
      runtimeSessionId: `berry-${'0'.repeat(64)}`,
      agent: {
         name: 'Builder',
         instructions: 'Be brief.',
         model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
         skills: [],
         mcpServers: [],
         permissions: ['read_repository'],
         maxTokens: null,
         temperature: null,
      },
      task: {
         prompt: 'Fix the bug',
         issue: { id: 'i', identifier: 'BER-1', title: 'Bug', description: null },
         comments: [],
         dependencies: [],
         projectResources: [],
         priorWork: null,
      },
      transcript: [],
      repo: null,
      completion: null,
      env: { SECRET_ENV: 'hunter2' },
      berry: { apiUrl: 'https://berry.example', token: 'berry_task_secret' },
      ...overrides,
   };
}

test('a complete envelope parses', () => {
   const parsed = taskEnvelopeSchema.safeParse(sampleEnvelope());
   assert.equal(parsed.success, true);
});

test('a session id shorter than AgentCore accepts is refused', () => {
   const parsed = taskEnvelopeSchema.safeParse(sampleEnvelope({ runtimeSessionId: 'berry-short' }));
   assert.equal(parsed.success, false);
});

test('a completion envelope carries its system prompt and schema', () => {
   const parsed = taskEnvelopeSchema.safeParse(
      sampleEnvelope({
         kind: 'completion',
         completion: { system: 'Answer in JSON', jsonSchema: { type: 'object' } },
      })
   );
   assert.equal(parsed.success, true);
});

test('a redacted envelope names no secret', () => {
   const text = JSON.stringify(
      redactEnvelope(
         sampleEnvelope({
            repo: {
               fullName: 'o/r',
               branch: 'b',
               baseBranch: 'main',
               credential: { username: 'x-access-token', password: 'ghs_secret' },
               verifyCommands: [],
               issueReference: 'BER-1',
               issueTitle: 'Bug',
            },
         })
      )
   );
   for (const secret of ['hunter2', 'berry_task_secret', 'ghs_secret']) {
      assert.equal(text.includes(secret), false, secret);
   }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/lifecycle.test.ts src/runtime/envelope.test.ts`
Expected: FAIL with `Cannot find module '.../src/runtime/lifecycle.ts'`.

- [ ] **Step 3: Implement `lifecycle.ts`**

```ts
import { z } from 'zod';

/**
 * What a runtime says back about one task, as an SSE stream.
 *
 * Shipped in the runtime image beside the loop, so it imports nothing but zod:
 * the image carries `src/agents/runtime/**` and these two contract files, and a
 * wider import here would drag the server into the container.
 *
 * `task.message` carries exactly what the ledger records today — output text,
 * tool start/stop, command start/output/stop, repository readiness and the
 * verification report — so the server maps each kind onto one ledger method.
 */

export const taskUsageSchema = z.object({
   model: z.string(),
   inputTokens: z.number().int().nonnegative(),
   outputTokens: z.number().int().nonnegative(),
   cacheReadTokens: z.number().int().nonnegative(),
   cacheWriteTokens: z.number().int().nonnegative(),
});

export const taskMessageSchema = z.discriminatedUnion('kind', [
   z.object({ kind: z.literal('output'), channel: z.string(), text: z.string() }),
   z.object({ kind: z.literal('tool.started'), toolCallId: z.string(), name: z.string() }),
   z.object({ kind: z.literal('tool.completed'), toolCallId: z.string(), succeeded: z.boolean() }),
   z.object({
      kind: z.literal('command.started'),
      commandId: z.string(),
      command: z.string(),
      cwd: z.string().nullable(),
   }),
   z.object({
      kind: z.literal('command.output'),
      commandId: z.string(),
      stream: z.enum(['stdout', 'stderr']),
      text: z.string(),
   }),
   z.object({
      kind: z.literal('command.completed'),
      commandId: z.string(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative(),
      truncated: z.boolean(),
   }),
   z.object({
      kind: z.literal('repository.ready'),
      repository: z.string(),
      branch: z.string(),
      baseCommit: z.string(),
   }),
   z.object({
      kind: z.literal('verified'),
      passed: z.boolean(),
      complete: z.boolean(),
      durationMs: z.number().nonnegative(),
      results: z.array(
         z.object({
            command: z.string(),
            exitCode: z.number().int().nullable(),
            passed: z.boolean(),
            durationMs: z.number().nonnegative(),
            error: z.string().nullable(),
         })
      ),
   }),
]);

export const taskDeliverySchema = z.object({
   committed: z.boolean(),
   commit: z.string().nullable(),
   branch: z.string(),
   filesChanged: z.number().int().nonnegative(),
   insertions: z.number().int().nonnegative(),
   deletions: z.number().int().nonnegative(),
   files: z.array(z.string()),
});

export const taskResultSchema = z.object({
   text: z.string(),
   truncated: z.boolean(),
   /** The structured answer of a completion task, already validated by the model's schema. */
   structured: z.unknown().optional(),
   delivery: taskDeliverySchema.nullable(),
});

export const taskFailureSchema = z.object({
   code: z.string().min(1),
   message: z.string(),
   retryable: z.boolean(),
});

export const lifecycleEventSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('task.started') }),
   z.object({ type: z.literal('task.message'), message: taskMessageSchema }),
   z.object({ type: z.literal('task.usage'), usage: taskUsageSchema }),
   z.object({ type: z.literal('task.completed'), result: taskResultSchema }),
   z.object({ type: z.literal('task.failed'), failure: taskFailureSchema }),
]);

export type TaskUsage = z.infer<typeof taskUsageSchema>;
export type TaskMessage = z.infer<typeof taskMessageSchema>;
export type TaskDelivery = z.infer<typeof taskDeliverySchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskFailure = z.infer<typeof taskFailureSchema>;
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

export class LifecycleStreamError extends Error {
   override readonly name = 'LifecycleStreamError';
}

/** One SSE frame. The payload is the whole event, so a frame stands alone. */
export function encodeLifecycle(event: LifecycleEvent): string {
   return `data: ${JSON.stringify(event)}\n\n`;
}

export function isTerminal(event: LifecycleEvent): boolean {
   return event.type === 'task.completed' || event.type === 'task.failed';
}

/**
 * Frames out of a byte stream, in order.
 *
 * A malformed frame throws rather than being skipped: a lost `task.completed`
 * would turn a finished run into `RUNTIME_STREAM_ENDED`, and a lost usage frame
 * would under-bill quietly. Comment frames (`: ping`) are keepalives.
 */
export async function* parseLifecycleStream(
   chunks: AsyncIterable<Uint8Array | string>
): AsyncGenerator<LifecycleEvent> {
   const decoder = new TextDecoder();
   let buffer = '';
   for await (const chunk of chunks) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
         const frame = buffer.slice(0, boundary);
         buffer = buffer.slice(boundary + 2);
         const event = decodeFrame(frame);
         if (event) yield event;
         boundary = buffer.indexOf('\n\n');
      }
   }
   buffer = (buffer + decoder.decode()).replaceAll('\r\n', '\n');
   if (buffer.trim() !== '') {
      const event = decodeFrame(buffer);
      if (event) yield event;
   }
}

function decodeFrame(frame: string): LifecycleEvent | null {
   const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
   if (data === '') return null;
   let parsed: unknown;
   try {
      parsed = JSON.parse(data);
   } catch {
      throw new LifecycleStreamError('the runtime sent a lifecycle frame that is not JSON');
   }
   const result = lifecycleEventSchema.safeParse(parsed);
   if (!result.success) {
      throw new LifecycleStreamError(
         `the runtime sent an unrecognised lifecycle frame: ${result.error.issues
            .map((issue) => issue.path.join('.') || issue.message)
            .join(', ')}`
      );
   }
   return result.data;
}
```

- [ ] **Step 4: Implement `envelope.ts`**

```ts
import { z } from 'zod';

/**
 * Everything a runtime needs to work one task, in one JSON body.
 *
 * Shipped in the runtime image; imports nothing but zod. It carries secrets —
 * the task token, a git credential, sealed-then-opened profile env — which is
 * why it travels only over the AWS SDK (or the local runtime's loopback) and
 * why anything that logs it must log `redactEnvelope(envelope)` instead.
 */

export const transcriptMessageSchema = z.object({
   role: z.enum(['user', 'assistant']),
   text: z.string(),
});

export const repoPlanSchema = z.object({
   /** `owner/name` on GitHub. */
   fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
   branch: z.string().min(1),
   baseBranch: z.string().min(1),
   credential: z.object({ username: z.string(), password: z.string() }),
   verifyCommands: z.array(z.string()),
   issueReference: z.string(),
   issueTitle: z.string(),
});

export const skillRefSchema = z.object({
   name: z.string().min(1),
   files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});

export const mcpServerRefSchema = z.object({
   name: z.string().min(1),
   url: z.url(),
   transport: z.enum(['http', 'sse']),
   headers: z.record(z.string(), z.string()),
});

export const taskEnvelopeSchema = z.object({
   kind: z.enum(['agent', 'completion']),
   runId: z.string().min(1),
   /** Human-readable `(agent, issue)` / `(agent, chat)` / `completion:<run>` key. */
   sessionKey: z.string().min(1),
   /** AgentCore requires at least 33 characters. */
   runtimeSessionId: z.string().min(33).max(100),
   agent: z.object({
      name: z.string().min(1),
      instructions: z.string(),
      model: z.string().min(1),
      skills: z.array(skillRefSchema),
      mcpServers: z.array(mcpServerRefSchema),
      permissions: z.array(z.string()),
      maxTokens: z.number().int().positive().nullable(),
      temperature: z.number().nullable(),
   }),
   task: z.object({
      /** The full first user message, already built by the server. */
      prompt: z.string(),
      issue: z
         .object({
            id: z.string(),
            identifier: z.string(),
            title: z.string(),
            description: z.string().nullable(),
         })
         .nullable(),
      comments: z.array(z.object({ author: z.string(), body: z.string(), createdAt: z.string() })),
      dependencies: z.array(
         z.object({
            identifier: z.string(),
            title: z.string(),
            status: z.string(),
            direction: z.enum(['depends_on', 'blocks']),
         })
      ),
      projectResources: z.array(
         z.object({ title: z.string(), url: z.string().nullable(), content: z.string().nullable() })
      ),
      priorWork: z.string().nullable(),
   }),
   /** The prior conversation for this session, oldest first; used only on a cold start. */
   transcript: z.array(transcriptMessageSchema),
   repo: repoPlanSchema.nullable(),
   completion: z
      .object({
         system: z.string(),
         /** `z.toJSONSchema(schema)` of the answer, or null for free text. */
         jsonSchema: z.record(z.string(), z.unknown()).nullable(),
      })
      .nullable(),
   env: z.record(z.string(), z.string()),
   berry: z.object({ apiUrl: z.url(), token: z.string().min(1) }),
});

export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;
export type RepoPlan = z.infer<typeof repoPlanSchema>;
export type SkillRef = z.infer<typeof skillRefSchema>;
export type McpServerRef = z.infer<typeof mcpServerRefSchema>;

const REDACTED = '[redacted]';

/** The envelope as it may be logged: every secret replaced, shape kept. */
export function redactEnvelope(envelope: TaskEnvelope): unknown {
   return {
      ...envelope,
      env: Object.fromEntries(Object.keys(envelope.env).map((key) => [key, REDACTED])),
      berry: { apiUrl: envelope.berry.apiUrl, token: REDACTED },
      repo: envelope.repo
         ? { ...envelope.repo, credential: { username: envelope.repo.credential.username, password: REDACTED } }
         : null,
      agent: {
         ...envelope.agent,
         mcpServers: envelope.agent.mcpServers.map((server) => ({
            ...server,
            headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, REDACTED])),
         })),
      },
   };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/lifecycle.test.ts src/runtime/envelope.test.ts && pnpm typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/runtime/envelope.ts server-ts/src/runtime/envelope.test.ts server-ts/src/runtime/lifecycle.ts server-ts/src/runtime/lifecycle.test.ts
git commit -m "feat(server-ts): define the task envelope and lifecycle stream contract

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Session identity per (agent, issue)

**Files:**
- Create: `server-ts/src/runtime/session-id.ts`, `server-ts/src/runtime/session-id.test.ts`
- Modify: `server-ts/src/execution/agentcore-runtime.ts:343-355` (`runtimeSessionId`) and its `createSession` call at line 87
- Modify: `server-ts/src/execution/agentcore-runtime.test.ts` (any expectation built from `berry-runtime-`)

**Interfaces:**
- Consumes: `node:crypto`.
- Produces:
  - `sessionKeyFor(input: { kind: 'agent' | 'completion'; runId: string; agentId: string; issueId?: string | null; chatSessionId?: string | null }): string`
  - `runtimeSessionIdFor(sessionKey: string): string`
  - `runtimeSessionId(sessionKey: string): string`, exported from `execution/agentcore-runtime.ts` (delegates to `runtimeSessionIdFor`).

- [ ] **Step 1: Write the failing test**

`server-ts/src/runtime/session-id.test.ts`:

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runtimeSessionId } from '../execution/agentcore-runtime.ts';
import { runtimeSessionIdFor, sessionKeyFor } from './session-id.ts';

const agentId = 'a0000000-0000-4000-8000-000000000001';
const issueId = 'b0000000-0000-4000-8000-000000000002';

test('the session is the (agent, issue) pair, not the run', () => {
   const first = runtimeSessionIdFor(sessionKeyFor({ kind: 'agent', runId: 'r1', agentId, issueId }));
   const second = runtimeSessionIdFor(sessionKeyFor({ kind: 'agent', runId: 'r2', agentId, issueId }));
   assert.equal(first, second);
});

test('the id is berry- plus sha256(agentId:issueId), long enough for AgentCore', () => {
   const id = runtimeSessionIdFor(sessionKeyFor({ kind: 'agent', runId: 'r1', agentId, issueId }));
   const expected = `berry-${createHash('sha256').update(`${agentId}:${issueId}`).digest('hex')}`;
   assert.equal(id, expected);
   assert.ok(id.length >= 33);
});

test('another issue, another agent, or a chat is another session', () => {
   const base = sessionKeyFor({ kind: 'agent', runId: 'r', agentId, issueId });
   assert.notEqual(base, sessionKeyFor({ kind: 'agent', runId: 'r', agentId, issueId: 'other' }));
   assert.notEqual(base, sessionKeyFor({ kind: 'agent', runId: 'r', agentId: 'other', issueId }));
   assert.notEqual(
      base,
      sessionKeyFor({ kind: 'agent', runId: 'r', agentId, chatSessionId: issueId })
   );
});

test('completion tasks get a fresh session per run', () => {
   const one = sessionKeyFor({ kind: 'completion', runId: 'r1', agentId, issueId });
   const two = sessionKeyFor({ kind: 'completion', runId: 'r2', agentId, issueId });
   assert.notEqual(runtimeSessionIdFor(one), runtimeSessionIdFor(two));
});

test('an agent task with neither issue nor chat cannot name a session', () => {
   assert.throws(() => sessionKeyFor({ kind: 'agent', runId: 'r', agentId }), /issue or a chat/);
});

test('the AgentCore driver derives its id the same way', () => {
   assert.equal(runtimeSessionId('x:y'), runtimeSessionIdFor('x:y'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/session-id.test.ts`
Expected: FAIL with `Cannot find module './session-id.ts'`.

- [ ] **Step 3: Implement**

`server-ts/src/runtime/session-id.ts`:

```ts
import { createHash } from 'node:crypto';

/**
 * Which runtime session a task lands on.
 *
 * `(agent, issue)`, not the run: a follow-up run on the same issue reaches the
 * same warm microVM while it lives — same process, same checkout, same
 * in-memory conversation (spec 2.2a). A chat is `(agent, chat session)`. A
 * completion shares nothing with anything, so it is keyed by its own run.
 */
export function sessionKeyFor(input: {
   kind: 'agent' | 'completion';
   runId: string;
   agentId: string;
   issueId?: string | null;
   chatSessionId?: string | null;
}): string {
   if (input.kind === 'completion') return `completion:${input.runId}`;
   if (input.issueId) return `${input.agentId}:${input.issueId}`;
   if (input.chatSessionId) return `${input.agentId}:chat:${input.chatSessionId}`;
   throw new Error('an agent task needs an issue or a chat session to name its session');
}

/**
 * The AgentCore `runtimeSessionId` for a session key.
 *
 * Hashed so the id is always 70 characters — over AgentCore's 33 minimum —
 * and carries no identifier in the clear into AWS logs.
 */
export function runtimeSessionIdFor(sessionKey: string): string {
   return `berry-${createHash('sha256').update(sessionKey).digest('hex')}`;
}
```

In `server-ts/src/execution/agentcore-runtime.ts`, add `import { runtimeSessionIdFor } from '../runtime/session-id.ts';` and replace the whole `runtimeSessionId` function (lines 343-355, doc comment included) with:

```ts
/**
 * The runtime session id for a session key (see `runtime/session-id.ts`).
 *
 * Exported so the invoke transport and this command driver agree on one
 * derivation. The command driver addresses sessions per run (`run:<id>`),
 * because it is only used for health checks now that the loop runs inside the
 * runtime.
 */
export function runtimeSessionId(sessionKey: string): string {
   return runtimeSessionIdFor(sessionKey);
}
```

Change line 87 to `new AgentCoreRuntimeSession(client, options, runtimeSessionId(`run:${input.runId}`), input)` and line 96 to `const sessionId = runtimeSessionId(`health:${Date.now()}`);`.

- [ ] **Step 4: Update the driver test and run everything**

Run: `cd server-ts && grep -n "berry-runtime-\|padEnd" src/execution/agentcore-runtime.test.ts`
For each match, replace the literal expected id with `runtimeSessionId(`run:${runId}`)`, where `runId` is the id that test passes to `createSession`, and import `runtimeSessionId` from `./agentcore-runtime.ts`.

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/session-id.test.ts src/execution/agentcore-runtime.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/runtime/session-id.ts server-ts/src/runtime/session-id.test.ts server-ts/src/execution/agentcore-runtime.ts server-ts/src/execution/agentcore-runtime.test.ts
git commit -m "feat(server-ts): key runtime sessions by agent and issue, not by run

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: Migration 053 — runtimes, profiles, task tokens, task-shaped runs

**Files:**
- Create: `server-ts/migrations/053_agentcore_runtime_control_plane.up.sql`
- Create: `server-ts/migrations/053_agentcore_runtime_control_plane.down.sql`
- Create: `server-ts/src/runtime/test-fixture.ts`
- Create: `server-ts/src/runtime/schema.test.ts`

**Interfaces:**
- Consumes: existing tables `workspaces`, `users`, `agents`, `runs`, `run_events`, `issues`, `boards`.
- Produces:
  - Tables `agent_runtimes`, `runtime_profiles`, `task_tokens`.
  - `agents.runtime_id`, `agents.runtime_profile_id`.
  - On `runs`: `kind`, `source`, `prompt`, `chat_session_id`, `autopilot_run_id`, `priority`, `runtime_id`, `runtime_session_id`, `workspace_id` (filled by trigger), `completion_spec`, `result`. `runs.issue_id`, `runs.board_id`, `run_events.issue_id` and `run_events.board_id` become nullable.
  - `test-fixture.ts` exports `interface Fixture { workspaceId; boardId; agentId; userId; orchestratorId }`, `seedFixture(sql, label): Promise<Fixture>`, `createIssue(sql, f, title?): Promise<string>`, `cleanupFixture(sql, f): Promise<void>`.
- Chat guard: `chat_sessions` is workstream D's table (migrations 085-099). **D must add `chat_sessions.active_run_id uuid REFERENCES runs(id) ON DELETE SET NULL` and enforce it in `enqueueTask`'s chat branch** (see Task 5 note).

- [ ] **Step 1: Write the fixture and the failing schema test**

`server-ts/src/runtime/test-fixture.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';

/**
 * One workspace, board, agent and owner for the runtime DB tests.
 *
 * Mirrors the ledger suite's fixture (`runs/ledger.test.ts`), including the
 * teardown that briefly suspends the protected-agent guard: creating a
 * workspace provisions a protected Orchestrator by trigger, and without the
 * suspension every run of the suite would leak a workspace.
 */
export interface Fixture {
   workspaceId: string;
   boardId: string;
   agentId: string;
   userId: string;
   /** The workspace's protected Orchestrator, provisioned by trigger. */
   orchestratorId: string;
}

export async function seedFixture(sql: Sql, label: string): Promise<Fixture> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${label}-${suffix}@berry.test`}, ${`${label} test`})
      RETURNING id`;
   const userId = user!.id as string;
   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label}-${suffix}`},
              ${sql.json({ issuePrefix: 'RTM', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${userId})
      RETURNING id`;
   const workspaceId = workspace!.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Runtime board', ${`rtm-${suffix}`}, ${userId})
      RETURNING id`;
   const boardId = board!.id as string;
   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, instructions)
      VALUES (${randomUUID()}, ${workspaceId}, ${boardId}, 'Runtime Agent', 'Be brief.')
      RETURNING id`;
   const [orchestrator] = await sql`
      SELECT id FROM agents WHERE workspace_id = ${workspaceId} AND protected`;
   return {
      workspaceId,
      boardId,
      agentId: agent!.id as string,
      userId,
      orchestratorId: orchestrator!.id as string,
   };
}

export async function createIssue(sql: Sql, fixture: Fixture, title = 'Runtime task'): Promise<string> {
   const issueId = randomUUID();
   await sql.begin(async (tx) => {
      const [counter] = await tx`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${fixture.boardId} RETURNING issue_counter`;
      await tx`
         INSERT INTO issues (id, board_id, number, title, status, created_by)
         VALUES (${issueId}, ${fixture.boardId}, ${Number(counter!.issue_counter)},
                 ${title}, 'todo', ${fixture.userId})`;
   });
   return issueId;
}

export async function cleanupFixture(sql: Sql, fixture: Fixture | null): Promise<void> {
   if (!fixture) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM runs WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId}`;
   await sql`ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`;
   try {
      await sql`DELETE FROM agents WHERE workspace_id = ${fixture.workspaceId}`;
   } finally {
      await sql`ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`;
   }
   await sql`DELETE FROM agent_runtimes WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
}
```

`server-ts/src/runtime/schema.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from './test-fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('migration 053', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'schema');
   });
   after(async () => {
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   test('a completion task needs no issue, and its workspace is filled in', async () => {
      const f = fixture!;
      const id = randomUUID();
      await sql`
         INSERT INTO runs (id, workspace_id, agent_id, kind, source, prompt)
         VALUES (${id}, ${f.workspaceId}, ${f.orchestratorId}, 'completion', 'completion', 'hi')`;
      const [row] = await sql`SELECT issue_id, board_id, workspace_id, priority FROM runs WHERE id = ${id}`;
      assert.equal(row!.issue_id, null);
      assert.equal(row!.workspace_id, f.workspaceId);
      assert.equal(row!.priority, 0);
   });

   test('an issue run gets its workspace from its board', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      const id = randomUUID();
      await sql`
         INSERT INTO runs (id, issue_id, board_id, agent_id)
         VALUES (${id}, ${issueId}, ${f.boardId}, ${f.agentId})`;
      const [row] = await sql`SELECT workspace_id, kind, source FROM runs WHERE id = ${id}`;
      assert.deepEqual({ ...row }, { workspace_id: f.workspaceId, kind: 'agent', source: 'assignment' });
   });

   test('an agent task with neither issue nor chat is refused', async () => {
      const f = fixture!;
      await assert.rejects(
         sql`INSERT INTO runs (id, workspace_id, agent_id, kind, source)
             VALUES (${randomUUID()}, ${f.workspaceId}, ${f.agentId}, 'agent', 'mention')`,
         /runs_task_target_ck/
      );
   });

   test('a runtime idle timeout above eight hours is refused', async () => {
      const f = fixture!;
      await assert.rejects(
         // A valid ARN, so the only constraint this row can break is the idle timeout.
         sql`INSERT INTO agent_runtimes (workspace_id, name, kind, driver, arn, idle_timeout_s)
             VALUES (${f.workspaceId}, 'too long', 'custom', 'agentcore',
                     'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/too-long', 28801)`,
         /agent_runtimes_idle_timeout_ck/
      );
   });

   test('a workspace has at most one default runtime', async () => {
      const f = fixture!;
      await sql`INSERT INTO agent_runtimes (workspace_id, name, kind, driver, is_default)
                VALUES (${f.workspaceId}, 'one', 'custom', 'http', true)`;
      await assert.rejects(
         sql`INSERT INTO agent_runtimes (workspace_id, name, kind, driver, is_default)
             VALUES (${f.workspaceId}, 'two', 'custom', 'http', true)`,
         /agent_runtimes_one_default_key/
      );
   });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server-ts && BERRY_TEST_DATABASE_URL=$BERRY_TEST_DATABASE_URL node --test --experimental-strip-types src/runtime/schema.test.ts`
Expected (with a test DB, see `server-ts/ROUTING.md` "Running the database-backed tests"): FAIL on `column "kind" of relation "runs" does not exist`. Without a DB, the suite reports skipped.

- [ ] **Step 3: Write the migration**

`server-ts/migrations/053_agentcore_runtime_control_plane.up.sql`:

```sql
-- Berry migration 053: the AgentCore Runtime control plane (ADR-0014).
--
-- Runtimes a workspace may dispatch to, the profiles that configure them,
-- task-scoped tokens the runtime calls Berry back with, and runs that are
-- tasks: a task may target an issue, a chat session, or nothing at all (a
-- completion), and carries its own prompt, priority and runtime.

CREATE TABLE IF NOT EXISTS agent_runtimes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    -- `platform` is the deployment's own runtime, one per workspace, synced
    -- from config at boot; `custom` is an ARN an owner registered.
    kind text NOT NULL,
    -- `agentcore` is invoked by ARN; `http` is the same image on a URL (local).
    driver text NOT NULL,
    arn text,
    endpoint_url text,
    qualifier text NOT NULL DEFAULT 'DEFAULT',
    region text,
    status text NOT NULL DEFAULT 'active',
    last_health_at timestamptz,
    last_health_error text,
    concurrency_limit integer,
    visibility text NOT NULL DEFAULT 'workspace',
    owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
    idle_timeout_s integer NOT NULL DEFAULT 3600,
    max_lifetime_s integer NOT NULL DEFAULT 28800,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_runtimes_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT agent_runtimes_name_ck CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT agent_runtimes_kind_ck CHECK (kind IN ('platform', 'custom')),
    CONSTRAINT agent_runtimes_driver_ck CHECK (driver IN ('agentcore', 'http')),
    CONSTRAINT agent_runtimes_target_ck CHECK (
        (driver = 'agentcore' AND (arn IS NOT NULL OR kind = 'platform'))
        OR (driver = 'http' AND (endpoint_url IS NOT NULL OR kind = 'platform'))
    ),
    CONSTRAINT agent_runtimes_status_ck CHECK (status IN ('active', 'unreachable', 'disabled')),
    CONSTRAINT agent_runtimes_visibility_ck CHECK (visibility IN ('private', 'workspace')),
    CONSTRAINT agent_runtimes_concurrency_ck CHECK (concurrency_limit IS NULL OR concurrency_limit > 0),
    CONSTRAINT agent_runtimes_idle_timeout_ck CHECK (idle_timeout_s BETWEEN 60 AND 28800),
    CONSTRAINT agent_runtimes_max_lifetime_ck CHECK (max_lifetime_s BETWEEN 60 AND 28800)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runtimes_one_default_key
    ON agent_runtimes (workspace_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS agent_runtimes_one_platform_key
    ON agent_runtimes (workspace_id) WHERE kind = 'platform';

CREATE TABLE IF NOT EXISTS runtime_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    runtime_id uuid NOT NULL,
    name text NOT NULL,
    -- Sealed with integrations/sealing.ts; a JSON object of env vars.
    env_sealed bytea,
    env_keys text[] NOT NULL DEFAULT '{}',
    model_default text,
    timeout_s integer,
    max_concurrency integer,
    idle_timeout_s integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT runtime_profiles_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT runtime_profiles_name_key UNIQUE (workspace_id, name),
    CONSTRAINT runtime_profiles_runtime_fk FOREIGN KEY (workspace_id, runtime_id)
        REFERENCES agent_runtimes (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT runtime_profiles_name_ck CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT runtime_profiles_timeout_ck CHECK (timeout_s IS NULL OR timeout_s BETWEEN 30 AND 28800),
    CONSTRAINT runtime_profiles_concurrency_ck CHECK (max_concurrency IS NULL OR max_concurrency > 0),
    CONSTRAINT runtime_profiles_idle_timeout_ck
        CHECK (idle_timeout_s IS NULL OR idle_timeout_s BETWEEN 60 AND 28800)
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_id uuid
    REFERENCES agent_runtimes(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_profile_id uuid
    REFERENCES runtime_profiles(id) ON DELETE SET NULL;

-- Runs become tasks.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
UPDATE runs SET workspace_id = b.workspace_id FROM boards b WHERE b.id = runs.board_id AND runs.workspace_id IS NULL;
ALTER TABLE runs ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'agent';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'assignment';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS prompt text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS chat_session_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS autopilot_run_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_id uuid REFERENCES agent_runtimes(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_session_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS completion_spec jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE runs ALTER COLUMN issue_id DROP NOT NULL;
ALTER TABLE runs ALTER COLUMN board_id DROP NOT NULL;
ALTER TABLE run_events ALTER COLUMN issue_id DROP NOT NULL;
ALTER TABLE run_events ALTER COLUMN board_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_kind_ck') THEN
        ALTER TABLE runs ADD CONSTRAINT runs_kind_ck CHECK (kind IN ('agent', 'completion'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_source_ck') THEN
        ALTER TABLE runs ADD CONSTRAINT runs_source_ck CHECK (source IN (
            'assignment', 'mention', 'chat', 'autopilot', 'squad', 'quick_action', 'builder', 'completion'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_task_target_ck') THEN
        ALTER TABLE runs ADD CONSTRAINT runs_task_target_ck CHECK (
            kind = 'completion' OR issue_id IS NOT NULL OR chat_session_id IS NOT NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_issue_board_pair_ck') THEN
        ALTER TABLE runs ADD CONSTRAINT runs_issue_board_pair_ck CHECK ((issue_id IS NULL) = (board_id IS NULL));
    END IF;
END
$$;

-- Writers that predate this migration (RunRepository.admit) name a board but
-- not a workspace; the board decides it.
CREATE OR REPLACE FUNCTION berry_runs_fill_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.workspace_id IS NULL AND NEW.board_id IS NOT NULL THEN
        SELECT workspace_id INTO NEW.workspace_id FROM boards WHERE id = NEW.board_id;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS berry_runs_fill_workspace ON runs;
CREATE TRIGGER berry_runs_fill_workspace
    BEFORE INSERT ON runs
    FOR EACH ROW EXECUTE FUNCTION berry_runs_fill_workspace();

CREATE INDEX IF NOT EXISTS runs_claim_order_idx
    ON runs (priority DESC, created_at ASC)
    WHERE status = 'queued' AND dispatch_state = 'pending';
CREATE INDEX IF NOT EXISTS runs_runtime_active_idx
    ON runs (runtime_id)
    WHERE status IN ('queued', 'running') AND runtime_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_workspace_created_idx
    ON runs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL,
    token_hash text NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}',
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_tokens_hash_key UNIQUE (token_hash),
    CONSTRAINT task_tokens_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS task_tokens_run_idx ON task_tokens (run_id);
```

`server-ts/migrations/053_agentcore_runtime_control_plane.down.sql`:

```sql
-- Reverses 053 for a deployment rolling back ADR-0014. Tasks with no issue
-- cannot survive the NOT NULL restored below, so they are deleted first.
DROP TABLE IF EXISTS task_tokens;
DELETE FROM runs WHERE issue_id IS NULL;
DELETE FROM run_events WHERE issue_id IS NULL;
DROP TRIGGER IF EXISTS berry_runs_fill_workspace ON runs;
DROP FUNCTION IF EXISTS berry_runs_fill_workspace();
DROP INDEX IF EXISTS runs_claim_order_idx;
DROP INDEX IF EXISTS runs_runtime_active_idx;
DROP INDEX IF EXISTS runs_workspace_created_idx;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_ck;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_source_ck;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_task_target_ck;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_issue_board_pair_ck;
ALTER TABLE run_events ALTER COLUMN issue_id SET NOT NULL;
ALTER TABLE run_events ALTER COLUMN board_id SET NOT NULL;
ALTER TABLE runs ALTER COLUMN issue_id SET NOT NULL;
ALTER TABLE runs ALTER COLUMN board_id SET NOT NULL;
ALTER TABLE runs
    DROP COLUMN IF EXISTS result, DROP COLUMN IF EXISTS completion_spec,
    DROP COLUMN IF EXISTS runtime_session_id, DROP COLUMN IF EXISTS runtime_id,
    DROP COLUMN IF EXISTS priority, DROP COLUMN IF EXISTS autopilot_run_id,
    DROP COLUMN IF EXISTS chat_session_id, DROP COLUMN IF EXISTS prompt,
    DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE agents DROP COLUMN IF EXISTS runtime_profile_id, DROP COLUMN IF EXISTS runtime_id;
DROP TABLE IF EXISTS runtime_profiles;
DROP TABLE IF EXISTS agent_runtimes;
```

- [ ] **Step 4: Apply and run the test**

Run: `cd server-ts && DATABASE_URL=$BERRY_TEST_DATABASE_URL pnpm migrate && BERRY_TEST_DATABASE_URL=$BERRY_TEST_DATABASE_URL node --test --experimental-strip-types src/runtime/schema.test.ts src/runs/ledger.test.ts src/runs/dispatcher.test.ts && pnpm typecheck`
Expected: migrate prints `053_agentcore_runtime_control_plane` applied; all three suites PASS (the ledger and dispatcher suites prove existing issue runs are unaffected).

- [ ] **Step 5: Commit**

```bash
git add server-ts/migrations/053_agentcore_runtime_control_plane.up.sql server-ts/migrations/053_agentcore_runtime_control_plane.down.sql server-ts/src/runtime/test-fixture.ts server-ts/src/runtime/schema.test.ts
git commit -m "feat(server-ts): add runtimes, runtime profiles, task tokens and task-shaped runs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The task queue and runtime-aware claiming

**Files:**
- Create: `server-ts/src/runs/queue.ts`, `server-ts/src/runs/queue.test.ts`
- Modify: `server-ts/src/runs/dispatcher.ts` (`#claim` at lines 145-160; add `nudge()`)

**Interfaces:**
- Consumes: migration 053; `ActiveRunExists` from `server-ts/src/runs/repository.ts`; `NotFound` from `server-ts/src/identity/errors.ts`; `Fixture` helpers from Task 4.
- Produces:
  - `enqueueTask(sql: Sql, input: EnqueueTaskInput): Promise<{ runId: string }>`. The input type matches the shared contract exactly.
  - `class EnqueueRejected extends Error { code: 'TASK_TARGET_REQUIRED' | 'AGENT_NOT_IN_WORKSPACE' }`.
  - `type TaskSource`, `type TaskKind`.
  - `Dispatcher.nudge(): void`, which cuts the idle poll short.
  - Claim order becomes `priority DESC, created_at ASC`. A runtime's `concurrency_limit` bounds its in-flight runs, where in-flight means claimed and in `queued` or `running`.
- Note for D: the chat branch inserts `chat_session_id` and does not lock anything. D adds the `chat_sessions.active_run_id` guard (lock row, refuse when set, set it) in this function, inside the marked block.

- [ ] **Step 1: Write the failing test**

`server-ts/src/runs/queue.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from '../runtime/test-fixture.ts';
import { Dispatcher } from './dispatcher.ts';
import { EnqueueRejected, enqueueTask } from './queue.ts';
import { ActiveRunExists } from './repository.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const MANUAL = { pollMs: 3_600_000, heartbeatMs: 3_600_000 };
const quiet = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;

describe('task queue', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'queue');
   });
   afterEach(async () => {
      await sql`DELETE FROM runs WHERE workspace_id = ${fixture!.workspaceId}`;
      await sql`DELETE FROM agent_runtimes WHERE workspace_id = ${fixture!.workspaceId}`;
   });
   after(async () => {
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   test('an issue task is a queued run that holds the issue', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      const { runId } = await enqueueTask(sql, {
         workspaceId: f.workspaceId,
         agentId: f.agentId,
         issueId,
         kind: 'agent',
         source: 'mention',
         prompt: 'look at this',
         priority: 3,
      });
      const [run] = await sql`
         SELECT status, kind, source, prompt, priority, board_id, workspace_id FROM runs WHERE id = ${runId}`;
      assert.deepEqual(
         { ...run },
         {
            status: 'queued',
            kind: 'agent',
            source: 'mention',
            prompt: 'look at this',
            priority: 3,
            board_id: f.boardId,
            workspace_id: f.workspaceId,
         }
      );
      const [issue] = await sql`SELECT active_run_id FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.active_run_id, runId);
      const [created] = await sql`SELECT event_type FROM run_events WHERE run_id = ${runId} AND sequence = 0`;
      assert.equal(created!.event_type, 'run.created');
   });

   test('a second task on a busy issue is refused', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      const input = { workspaceId: f.workspaceId, agentId: f.agentId, issueId, kind: 'agent', source: 'assignment' } as const;
      await enqueueTask(sql, input);
      await assert.rejects(enqueueTask(sql, input), ActiveRunExists);
   });

   test('a completion task names no issue and writes no events', async () => {
      const f = fixture!;
      const { runId } = await enqueueTask(sql, {
         workspaceId: f.workspaceId,
         agentId: f.orchestratorId,
         kind: 'completion',
         source: 'completion',
         prompt: 'summarise',
      });
      const [run] = await sql`SELECT issue_id, kind FROM runs WHERE id = ${runId}`;
      assert.equal(run!.issue_id, null);
      const events = await sql`SELECT 1 FROM run_events WHERE run_id = ${runId}`;
      assert.equal(events.length, 0);
   });

   test('an agent task with no issue and no chat is refused by name', async () => {
      const f = fixture!;
      await assert.rejects(
         enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.agentId, kind: 'agent', source: 'mention' }),
         (error: unknown) => error instanceof EnqueueRejected && error.code === 'TASK_TARGET_REQUIRED'
      );
   });

   test('an agent from another workspace cannot be queued here', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      await assert.rejects(
         enqueueTask(sql, {
            workspaceId: f.workspaceId,
            agentId: randomUUID(),
            issueId,
            kind: 'agent',
            source: 'mention',
         }),
         (error: unknown) => error instanceof EnqueueRejected && error.code === 'AGENT_NOT_IN_WORKSPACE'
      );
   });

   test('enqueueTask joins a transaction it is handed', async () => {
      const f = fixture!;
      let runId = '';
      await sql
         .begin(async (tx) => {
            ({ runId } = await enqueueTask(tx as unknown as Sql, {
               workspaceId: f.workspaceId,
               agentId: f.orchestratorId,
               kind: 'completion',
               source: 'completion',
            }));
            throw new Error('roll back');
         })
         .catch(() => undefined);
      const rows = await sql`SELECT 1 FROM runs WHERE id = ${runId}`;
      assert.equal(rows.length, 0);
   });

   test('the dispatcher claims higher priority first', async () => {
      const f = fixture!;
      const low = await enqueueTask(sql, {
         workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
         kind: 'agent', source: 'assignment', priority: 100,
      });
      const high = await enqueueTask(sql, {
         workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
         kind: 'agent', source: 'assignment', priority: 200,
      });
      const executed: string[] = [];
      const dispatcher = new Dispatcher({
         sql, logger: quiet, concurrency: 1, ...MANUAL,
         executor: { execute: async (id) => void executed.push(id) },
      });
      await dispatcher.tick();
      assert.equal(executed[0], high.runId);
      assert.equal(executed.includes(low.runId), false);
   });

   test('a runtime at its concurrency limit gets no more work', async () => {
      const f = fixture!;
      const [runtime] = await sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url, concurrency_limit)
         VALUES (${f.workspaceId}, 'one-at-a-time', 'custom', 'http', 'http://rt:8080', 1)
         RETURNING id`;
      await sql`UPDATE agents SET runtime_id = ${runtime!.id} WHERE id = ${f.agentId}`;
      try {
         const busy = await enqueueTask(sql, {
            workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
            kind: 'agent', source: 'assignment', priority: 300,
         });
         await sql`UPDATE runs SET status = 'running', dispatch_state = 'dispatching', started_at = now(),
                          dispatch_lease_until = now() + interval '1 minute'
                    WHERE id = ${busy.runId}`;
         const waiting = await enqueueTask(sql, {
            workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
            kind: 'agent', source: 'assignment', priority: 300,
         });
         const executed: string[] = [];
         const dispatcher = new Dispatcher({
            sql, logger: quiet, concurrency: 5, ...MANUAL,
            executor: { execute: async (id) => void executed.push(id) },
         });
         await dispatcher.tick();
         assert.equal(executed.includes(waiting.runId), false);
      } finally {
         await sql`UPDATE agents SET runtime_id = NULL WHERE id = ${f.agentId}`;
      }
   });

   test('one tick never claims past a runtime limit', async () => {
      const f = fixture!;
      const [runtime] = await sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url, concurrency_limit)
         VALUES (${f.workspaceId}, 'single', 'custom', 'http', 'http://rt:8080', 1)
         RETURNING id`;
      await sql`UPDATE agents SET runtime_id = ${runtime!.id} WHERE id = ${f.agentId}`;
      try {
         const first = await enqueueTask(sql, {
            workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
            kind: 'agent', source: 'assignment', priority: 400,
         });
         const second = await enqueueTask(sql, {
            workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
            kind: 'agent', source: 'assignment', priority: 400,
         });
         const executed: string[] = [];
         const dispatcher = new Dispatcher({
            sql, logger: quiet, concurrency: 5, ...MANUAL,
            executor: { execute: async (id) => void executed.push(id) },
         });
         await dispatcher.tick();
         // Both are idle candidates for a limit-1 runtime; only one may be claimed.
         assert.equal(executed.filter((id) => id === first.runId || id === second.runId).length, 1);
      } finally {
         await sql`UPDATE agents SET runtime_id = NULL WHERE id = ${f.agentId}`;
      }
   });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/runs/queue.test.ts`
Expected (with a DB): FAIL with `Cannot find module './queue.ts'`.

- [ ] **Step 3: Implement `queue.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { ActiveRunExists } from './repository.ts';

/**
 * Admitting a task, from anywhere in Berry.
 *
 * Every trigger — assignment, a mention, a chat message, an autopilot tick, a
 * squad leader's delegation, a quick action, the agent builder, a completion —
 * writes the same durable row, and the dispatcher is the only thing that ever
 * starts one. That is what keeps "a runtime was down" a recorded failure
 * rather than an error on whatever request happened to trigger the work.
 */

export type TaskKind = 'agent' | 'completion';
export type TaskSource =
   | 'assignment'
   | 'mention'
   | 'chat'
   | 'autopilot'
   | 'squad'
   | 'quick_action'
   | 'builder'
   | 'completion';

export interface EnqueueTaskInput {
   workspaceId: string;
   agentId: string;
   issueId?: string;
   kind: TaskKind;
   source: TaskSource;
   prompt?: string;
   chatSessionId?: string;
   autopilotRunId?: string;
   priority?: number;
}

export class EnqueueRejected extends Error {
   override readonly name = 'EnqueueRejected';
   readonly code: 'TASK_TARGET_REQUIRED' | 'AGENT_NOT_IN_WORKSPACE';
   constructor(code: EnqueueRejected['code'], message: string) {
      super(message);
      this.code = code;
   }
}

export async function enqueueTask(sql: Sql, input: EnqueueTaskInput): Promise<{ runId: string }> {
   if (input.kind === 'agent' && !input.issueId && !input.chatSessionId) {
      throw new EnqueueRejected('TASK_TARGET_REQUIRED', 'an agent task needs an issue or a chat session');
   }
   const runId = randomUUID();
   await inTransaction(sql, async (tx) => {
      const [agent] = await tx`
         SELECT id, runtime_id FROM agents
          WHERE id = ${input.agentId} AND workspace_id = ${input.workspaceId} AND archived_at IS NULL`;
      if (!agent) {
         throw new EnqueueRejected('AGENT_NOT_IN_WORKSPACE', 'that agent is not in this workspace');
      }
      const runtimeId = await resolveRuntimeId(tx, input.workspaceId, (agent.runtime_id as string | null) ?? null);

      let boardId: string | null = null;
      const issueId = input.kind === 'agent' ? (input.issueId ?? null) : null;
      if (issueId) {
         // Locked first, so two triggers on one issue cannot both see it idle.
         const [issue] = await tx`
            SELECT i.id, i.board_id FROM issues i JOIN boards b ON b.id = i.board_id
             WHERE i.id = ${issueId} AND b.workspace_id = ${input.workspaceId} AND i.deleted_at IS NULL
             FOR UPDATE OF i`;
         if (!issue) throw new NotFound();
         boardId = issue.board_id as string;
         const [active] = await tx`
            SELECT id FROM runs WHERE issue_id = ${issueId} AND status IN ('queued', 'running') LIMIT 1`;
         if (active) throw new ActiveRunExists(active.id as string);
      }
      // Chat guard (workstream D): lock chat_sessions row, refuse when
      // active_run_id is set, and set it after the insert below.

      await tx`
         INSERT INTO runs (id, workspace_id, issue_id, board_id, agent_id, kind, source, prompt,
                           chat_session_id, autopilot_run_id, priority, runtime_id, instructions)
         VALUES (${runId}, ${input.workspaceId}, ${issueId}, ${boardId}, ${input.agentId},
                 ${input.kind}, ${input.source}, ${input.prompt ?? null},
                 ${input.chatSessionId ?? null}, ${input.autopilotRunId ?? null},
                 ${input.priority ?? 0}, ${runtimeId}, ${input.kind === 'agent' ? (input.prompt ?? null) : null})`;

      if (issueId && boardId) {
         await tx`UPDATE issues SET active_run_id = ${runId}, updated_at = now() WHERE id = ${issueId}`;
         await tx`
            INSERT INTO run_events (id, run_id, board_id, issue_id, sequence, event_type, payload, public)
            VALUES (${randomUUID()}, ${runId}, ${boardId}, ${issueId}, 0, 'run.created',
                    ${tx.json({ agentId: input.agentId, source: input.source } as never)}, true)`;
      }
   });
   return { runId };
}

/** The agent's runtime, else the workspace default, else its platform runtime, else none. */
async function resolveRuntimeId(tx: Sql, workspaceId: string, agentRuntimeId: string | null): Promise<string | null> {
   if (agentRuntimeId) return agentRuntimeId;
   const [row] = await tx`
      SELECT id FROM agent_runtimes
       WHERE workspace_id = ${workspaceId} AND status <> 'disabled'
       ORDER BY is_default DESC, (kind = 'platform') DESC, created_at ASC
       LIMIT 1`;
   return row ? (row.id as string) : null;
}

/**
 * Runs `work` in a transaction, or inside the caller's.
 *
 * postgres.js hands a transaction a handle with no `begin`; a caller that
 * needs the task and its own writes to commit together (runCompletion writes
 * the completion spec beside the row) passes that handle here.
 */
async function inTransaction(sql: Sql, work: (tx: Sql) => Promise<void>): Promise<void> {
   const begin = (sql as unknown as { begin?: unknown }).begin;
   if (typeof begin === 'function') {
      await sql.begin(async (transaction) => work(transaction as unknown as Sql));
      return;
   }
   await work(sql);
}
```

`instructions` carries the prompt for agent runs because `claimDispatch` and `buildMessage` already read `runs.instructions` as the per-run instructions.

- [ ] **Step 4: Update the dispatcher claim**

In `server-ts/src/runs/dispatcher.ts`, replace the body of `#claim` (the SQL at lines 146-159) with:

```ts
      // Priority first, then age. A runtime with a concurrency limit gets at
      // most `limit - busy` new claims per statement: `slot` numbers each
      // runtime's candidates in claim order, so one tick can never hand a
      // limit-1 runtime two runs (a plain `busy < limit` filter is evaluated
      // once for every candidate and would). The window lives in a CTE because
      // Postgres refuses FOR UPDATE beside a window function. Two dispatchers
      // claiming in the same instant can each read the same `busy`; that
      // overshoot is bounded by the number of dispatchers and ends at the
      // next tick.
      const rows = await this.#sql`
         WITH candidate AS (
            SELECT ranked.id, ranked.priority, ranked.created_at FROM (
               SELECT r.id, r.priority, r.created_at, rt.concurrency_limit,
                      row_number() OVER (PARTITION BY r.runtime_id
                                         ORDER BY r.priority DESC, r.created_at ASC) AS slot,
                      (SELECT count(*) FROM runs AS busy
                        WHERE busy.runtime_id = r.runtime_id
                          AND busy.status IN ('queued', 'running')
                          AND (busy.dispatch_state <> 'pending'
                               OR busy.dispatch_lease_until > now())) AS busy_count
                 FROM runs AS r
                 LEFT JOIN agent_runtimes AS rt ON rt.id = r.runtime_id
                WHERE r.status = 'queued'
                  AND r.dispatch_state = 'pending'
                  AND (r.dispatch_lease_until IS NULL OR r.dispatch_lease_until < now())
                  AND (rt.id IS NULL OR rt.status <> 'disabled')
            ) AS ranked
            WHERE ranked.concurrency_limit IS NULL
               OR ranked.busy_count + ranked.slot <= ranked.concurrency_limit
         )
         UPDATE runs
            SET dispatch_lease_until = now() + ${`${this.#leaseMs} milliseconds`}::interval
          WHERE id IN (
             SELECT r.id FROM runs AS r JOIN candidate AS c ON c.id = r.id
              WHERE r.status = 'queued'
                AND r.dispatch_state = 'pending'
                AND (r.dispatch_lease_until IS NULL OR r.dispatch_lease_until < now())
              ORDER BY c.priority DESC, c.created_at ASC
              LIMIT ${limit}
              FOR UPDATE OF r SKIP LOCKED
          )
          RETURNING id`;
      return rows.map((row) => row.id as string);
```

Add after the `inflight` getter:

```ts
   /**
    * Looks for work now rather than at the next poll.
    *
    * For a caller that just queued something it is waiting on — a completion
    * holds an HTTP request open until its task finishes.
    */
   nudge(): void {
      this.#wake?.();
   }
```

- [ ] **Step 5: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/runs/queue.test.ts src/runs/dispatcher.test.ts && pnpm typecheck`
Expected: PASS (with a DB), skipped without.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/runs/queue.ts server-ts/src/runs/queue.test.ts server-ts/src/runs/dispatcher.ts
git commit -m "feat(server-ts): queue tasks from any trigger and claim by priority within runtime limits

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: Task tokens and the Berry tool API

**Files:**
- Create: `server-ts/src/runtime/agent-tools/tokens.ts`
- Create: `server-ts/src/runtime/agent-tools/registry.ts`, `server-ts/src/runtime/agent-tools/registry.test.ts`
- Create: `server-ts/src/runtime/agent-tools/core-tools.ts`
- Create: `server-ts/src/runtime/agent-tools/mount.ts`, `server-ts/src/runtime/agent-tools/mount.test.ts`

**Interfaces:**
- Consumes:
  - `hashToken`, `generateToken` from `server-ts/src/auth/tokens.ts`.
  - `postRunResult` from `server-ts/src/runs/result-comment.ts`.
  - `IssueRepository['update']` from `server-ts/src/core/issues.ts`; it records its own outbox events.
  - `BerryArtifactService` from `server-ts/src/agents/artifact-service.ts`.
  - `Storage` from `server-ts/src/storage/storage.ts`.
  - `enqueueTask` (Task 5), `json` from `server-ts/src/http/app.ts`, `ApiError`, `Mount`.
- Produces:
  - `TASK_TOKEN_PREFIX = 'berry_task_'`.
  - `mintTaskToken(sql, { runId, workspaceId, agentId, scopes: TaskScope[], ttlSeconds }): Promise<string>`.
  - `resolveTaskToken(sql, token): Promise<TaskClaims | null>`.
  - `revokeTaskTokens(sql, runId): Promise<void>`.
  - `type TaskScope = 'task:read' | 'task:write'`.
  - `interface TaskClaims { tokenId; runId; workspaceId; agentId; issueId: string | null; boardId: string | null; scopes: TaskScope[] }`.
  - `registerAgentTool<S extends z.ZodObject>(name: string, def: AgentToolDefinition<S>): void`.
  - `listAgentTools(): RegisteredAgentTool[]`, `getAgentTool(name): RegisteredAgentTool | null`, `class AgentToolConflict`.
  - `interface AgentToolContext { sql: Sql; storage: Storage | null; issues: Pick<IssueRepository, 'update'>; task: TaskClaims }`.
  - `registerCoreAgentTools(): void`. It is idempotent and registers `read_task`, `list_dependencies`, `post_comment`, `set_status`, `list_files`, `read_file`, `write_file`, `attach_file`, `read_project_resources` and `mention_agent`.
  - `agentToolMounts({ sql, storage, issues }): Mount[]` at `/api/v1/agent-tools`:
    - `GET /` → `{ tools: [{ name, description, inputSchema }] }`, where `inputSchema` is JSON Schema.
    - `POST /:name` → `{ result }`.
- Handoff: sub-issue tools (`list_subtasks`, `create_subtask`) need B's parent/stage columns. B or D registers them with `registerAgentTool` once those land.

- [ ] **Step 1: Write the failing registry test**

`server-ts/src/runtime/agent-tools/registry.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { AgentToolConflict, getAgentTool, listAgentTools, registerAgentTool } from './registry.ts';

test('a registered tool is listed with a JSON schema for its input', () => {
   registerAgentTool('registry_probe', {
      description: 'probe',
      scope: 'task:read',
      inputSchema: z.object({ n: z.number() }),
      handler: async (_context, input) => ({ doubled: input.n * 2 }),
   });
   const listed = listAgentTools().find((tool) => tool.name === 'registry_probe');
   assert.ok(listed);
   assert.equal((listed.jsonSchema as { type?: string }).type, 'object');
});

test('a second tool with the same name is refused', () => {
   const def = { description: 'x', scope: 'task:read' as const, inputSchema: z.object({}), handler: async () => null };
   registerAgentTool('registry_dupe', def);
   assert.throws(() => registerAgentTool('registry_dupe', def), AgentToolConflict);
});

test('a tool name the model could not call is refused', () => {
   const def = { description: 'x', scope: 'task:read' as const, inputSchema: z.object({}), handler: async () => null };
   assert.throws(() => registerAgentTool('Bad Name', def), /tool name/);
});

test('input is validated before the handler sees it', async () => {
   registerAgentTool('registry_validate', {
      description: 'v',
      scope: 'task:read',
      inputSchema: z.object({ n: z.number() }),
      handler: async (_context, input) => input.n,
   });
   const tool = getAgentTool('registry_validate');
   assert.ok(tool);
   const refused = await tool.run({} as never, { n: 'x' });
   assert.equal(refused.ok, false);
   const ran = await tool.run({} as never, { n: 2 });
   assert.deepEqual(ran, { ok: true, result: 2 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/agent-tools/registry.test.ts`
Expected: FAIL, `Cannot find module './registry.ts'`.

- [ ] **Step 3: Implement `tokens.ts` and `registry.ts`**

`server-ts/src/runtime/agent-tools/tokens.ts`:

```ts
import type { Sql } from '../../db/pool.ts';
import { generateToken, hashToken } from '../../auth/tokens.ts';

/**
 * The credential a runtime calls Berry back with, for one run only.
 *
 * Stored as a SHA-256 like every other Berry token. Valid while the run is
 * queued or running and before its expiry; revoked on the run's terminal
 * state. The expiry is the runtime's own `maxLifetime` horizon: a run cannot
 * outlive its microVM, so neither can its token.
 */
export const TASK_TOKEN_PREFIX = 'berry_task_';

export type TaskScope = 'task:read' | 'task:write';

export interface TaskClaims {
   tokenId: string;
   runId: string;
   workspaceId: string;
   agentId: string;
   issueId: string | null;
   boardId: string | null;
   scopes: TaskScope[];
}

export async function mintTaskToken(
   sql: Sql,
   input: { runId: string; workspaceId: string; agentId: string; scopes: TaskScope[]; ttlSeconds: number }
): Promise<string> {
   const token = `${TASK_TOKEN_PREFIX}${generateToken()}`;
   await sql`
      INSERT INTO task_tokens (workspace_id, run_id, agent_id, token_hash, scopes, expires_at)
      VALUES (${input.workspaceId}, ${input.runId}, ${input.agentId}, ${hashToken(token)},
              ${input.scopes}, now() + ${`${input.ttlSeconds} seconds`}::interval)`;
   return token;
}

export async function resolveTaskToken(sql: Sql, token: string): Promise<TaskClaims | null> {
   if (!token.startsWith(TASK_TOKEN_PREFIX)) return null;
   const [row] = await sql`
      SELECT t.id, t.run_id, t.workspace_id, t.agent_id, t.scopes, r.issue_id, r.board_id
        FROM task_tokens AS t
        JOIN runs AS r ON r.id = t.run_id
       WHERE t.token_hash = ${hashToken(token)}
         AND t.revoked_at IS NULL
         AND t.expires_at > now()
         AND r.status IN ('queued', 'running')`;
   if (!row) return null;
   return {
      tokenId: row.id as string,
      runId: row.run_id as string,
      workspaceId: row.workspace_id as string,
      agentId: row.agent_id as string,
      issueId: (row.issue_id as string | null) ?? null,
      boardId: (row.board_id as string | null) ?? null,
      scopes: (row.scopes as string[]).filter(
         (scope): scope is TaskScope => scope === 'task:read' || scope === 'task:write'
      ),
   };
}

export async function revokeTaskTokens(sql: Sql, runId: string): Promise<void> {
   await sql`UPDATE task_tokens SET revoked_at = now() WHERE run_id = ${runId} AND revoked_at IS NULL`;
}
```

`generateToken` in `auth/tokens.ts` has the signature `generateToken(random?)` and returns an encoded random string (see line 45). If its output already carries a prefix, use it unchanged and adjust `TASK_TOKEN_PREFIX` so that `startsWith` still distinguishes task tokens. Check with `sed -n 40,50p server-ts/src/auth/tokens.ts`.

`server-ts/src/runtime/agent-tools/registry.ts`:

```ts
import { z } from 'zod';
import type { Sql } from '../../db/pool.ts';
import type { IssueRepository } from '../../core/issues.ts';
import type { Storage } from '../../storage/storage.ts';
import type { TaskClaims, TaskScope } from './tokens.ts';

/**
 * The tools an agent uses to act on Berry, registered by whichever module
 * owns the product surface they touch.
 *
 * The runtime fetches the manifest at the start of each task and turns every
 * entry into a Strands tool, so a workstream adds an agent capability here and
 * never touches the container image.
 */

export interface AgentToolContext {
   sql: Sql;
   storage: Storage | null;
   issues: Pick<IssueRepository, 'update'>;
   task: TaskClaims;
}

export interface AgentToolDefinition<S extends z.ZodObject> {
   description: string;
   scope: TaskScope;
   inputSchema: S;
   handler: (context: AgentToolContext, input: z.output<S>) => Promise<unknown>;
}

export type ToolRun =
   | { ok: true; result: unknown }
   | { ok: false; issues: Array<{ path: string; message: string }> };

export interface RegisteredAgentTool {
   name: string;
   description: string;
   scope: TaskScope;
   jsonSchema: Record<string, unknown>;
   run: (context: AgentToolContext, raw: unknown) => Promise<ToolRun>;
}

export class AgentToolConflict extends Error {
   override readonly name = 'AgentToolConflict';
}

const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const tools = new Map<string, RegisteredAgentTool>();

export function registerAgentTool<S extends z.ZodObject>(name: string, def: AgentToolDefinition<S>): void {
   if (!NAME.test(name)) throw new Error(`tool name '${name}' must match ${NAME}`);
   if (tools.has(name)) throw new AgentToolConflict(`an agent tool named '${name}' is already registered`);
   tools.set(name, {
      name,
      description: def.description,
      scope: def.scope,
      jsonSchema: z.toJSONSchema(def.inputSchema) as Record<string, unknown>,
      run: async (context, raw) => {
         const parsed = def.inputSchema.safeParse(raw ?? {});
         if (!parsed.success) {
            return {
               ok: false,
               issues: parsed.error.issues.map((issue) => ({
                  path: issue.path.join('.'),
                  message: issue.message,
               })),
            };
         }
         return { ok: true, result: await def.handler(context, parsed.data) };
      },
   });
}

export function listAgentTools(): RegisteredAgentTool[] {
   return [...tools.values()];
}

export function getAgentTool(name: string): RegisteredAgentTool | null {
   return tools.get(name) ?? null;
}
```

- [ ] **Step 4: Run the registry test**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/agent-tools/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing mount test**

`server-ts/src/runtime/agent-tools/mount.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../../db/pool.ts';
import { createApp, type BerryApp } from '../../http/app.ts';
import { Registry } from '../../http/registry.ts';
import { enqueueTask } from '../../runs/queue.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from '../test-fixture.ts';
import { agentToolMounts } from './mount.ts';
import { mintTaskToken, revokeTaskTokens } from './tokens.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent tool API', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let mine: Fixture | null = null;
   let theirs: Fixture | null = null;
   let token = '';
   let issueId = '';
   let runId = '';
   const statusCalls: unknown[] = [];

   before(async () => {
      sql = openDatabase({ url: url! });
      mine = await seedFixture(sql, 'tools-a');
      theirs = await seedFixture(sql, 'tools-b');
      issueId = await createIssue(sql, mine, 'Tool task');
      ({ runId } = await enqueueTask(sql, {
         workspaceId: mine.workspaceId, agentId: mine.agentId, issueId, kind: 'agent', source: 'assignment',
      }));
      token = await mintTaskToken(sql, {
         runId, workspaceId: mine.workspaceId, agentId: mine.agentId,
         scopes: ['task:read', 'task:write'], ttlSeconds: 600,
      });
      const registry = new Registry();
      registry.registerAll(
         agentToolMounts({
            sql,
            storage: null,
            issues: {
               update: async (params) => {
                  statusCalls.push(params);
                  return { issue: {} as never, events: [] };
               },
            },
         })
      );
      app = createApp(registry);
   });
   after(async () => {
      await cleanupFixture(sql, mine);
      await cleanupFixture(sql, theirs);
      await closeDatabase(sql);
   });

   const call = (path: string, init: RequestInit = {}, bearer = token) =>
      app.request(`/api/v1/agent-tools${path}`, {
         ...init,
         headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      });

   test('without a task token nothing answers', async () => {
      const response = await app.request('/api/v1/agent-tools');
      assert.equal(response.status, 401);
      assert.equal((await call('', {}, 'berry_pat_nope')).status, 401);
   });

   test('the manifest lists the core tools with JSON schemas', async () => {
      const body = (await (await call('')).json()) as { tools: Array<{ name: string; inputSchema: unknown }> };
      const names = body.tools.map((tool) => tool.name);
      for (const name of ['read_task', 'post_comment', 'set_status', 'mention_agent']) assert.ok(names.includes(name), name);
   });

   test('read_task reads the task this run is on, and only that one', async () => {
      const response = await call('/read_task', { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result: { title: string } };
      assert.equal(body.result.title, 'Tool task');
   });

   test('set_status moves the task as the agent', async () => {
      const response = await call('/set_status', { method: 'POST', body: JSON.stringify({ status: 'in_review' }) });
      assert.equal(response.status, 200);
      assert.deepEqual((statusCalls[0] as { actorType: string; issueId: string }).actorType, 'agent');
      assert.equal((statusCalls[0] as { issueId: string }).issueId, issueId);
   });

   test('invalid input is a 400 that names the field', async () => {
      const response = await call('/set_status', { method: 'POST', body: JSON.stringify({ status: 42 }) });
      assert.equal(response.status, 400);
   });

   test('mentioning an agent of another workspace is a 404', async () => {
      const response = await call('/mention_agent', {
         method: 'POST',
         body: JSON.stringify({ agentId: theirs!.agentId, message: 'help' }),
      });
      assert.equal(response.status, 404);
   });

   test('an unknown tool is a 404', async () => {
      assert.equal((await call(`/nope_${randomUUID().slice(0, 4)}`, { method: 'POST', body: '{}' })).status, 404);
   });

   test('a revoked token stops working', async () => {
      await revokeTaskTokens(sql, runId);
      assert.equal((await call('')).status, 401);
   });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/agent-tools/mount.test.ts`
Expected (with a DB): FAIL, `Cannot find module './mount.ts'`.

- [ ] **Step 7: Implement `core-tools.ts` and `mount.ts`**

`server-ts/src/runtime/agent-tools/core-tools.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BerryArtifactService } from '../../agents/artifact-service.ts';
import { postRunResult } from '../../runs/result-comment.ts';
import { enqueueTask } from '../../runs/queue.ts';
import { ApiError } from '../../http/errors.ts';
import { getAgentTool, registerAgentTool, type AgentToolContext } from './registry.ts';

/**
 * The Berry tools every agent has.
 *
 * Each is scoped by the token's claims — the run's issue, the run's workspace
 * — never by an id the model supplies, so an agent cannot point one at
 * another task even by trying.
 */

const MAX_READ_BYTES = 64 * 1024;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const AGENT_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked'] as const;

function issueOf(context: AgentToolContext): string {
   if (!context.task.issueId) throw ApiError.badRequest('this task is not on an issue');
   return context.task.issueId;
}

async function artifactsOf(context: AgentToolContext): Promise<BerryArtifactService> {
   if (!context.storage) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'this deployment has no file storage');
   const [agent] = await context.sql`SELECT name FROM agents WHERE id = ${context.task.agentId}`;
   return new BerryArtifactService({
      sql: context.sql,
      storage: context.storage,
      workspaceId: context.task.workspaceId,
      runId: context.task.runId,
      issueId: issueOf(context),
      agentId: context.task.agentId,
      agentName: (agent?.name as string | undefined) ?? 'agent',
      clock: () => new Date(),
      newId: randomUUID,
   });
}

export function registerCoreAgentTools(): void {
   if (getAgentTool('read_task')) return;

   registerAgentTool('read_task', {
      description: 'Read the task this run is working on: its title, description, status and priority.',
      scope: 'task:read',
      inputSchema: z.object({}),
      handler: async (context) => {
         const [row] = await context.sql`
            SELECT i.title, i.description, i.status::text AS status, i.priority::text AS priority,
                   berry_issue_identifier(b.workspace_id, i.number) AS identifier
              FROM issues AS i JOIN boards AS b ON b.id = i.board_id
             WHERE i.id = ${issueOf(context)} AND i.deleted_at IS NULL`;
         if (!row) return { found: false };
         return { found: true, ...row };
      },
   });

   registerAgentTool('list_dependencies', {
      description: 'List the tasks this task depends on and the tasks that depend on it.',
      scope: 'task:read',
      inputSchema: z.object({}),
      handler: async (context) => {
         const issueId = issueOf(context);
         const rows = await context.sql`
            SELECT CASE WHEN edge.issue_id = ${issueId} THEN 'depends_on' ELSE 'blocks' END AS direction,
                   other.title, other.status::text AS status,
                   berry_issue_identifier(ob.workspace_id, other.number) AS identifier
              FROM issue_dependencies AS edge
              JOIN issues AS other
                ON other.id = CASE WHEN edge.issue_id = ${issueId} THEN edge.depends_on_issue_id ELSE edge.issue_id END
               AND other.deleted_at IS NULL
              JOIN boards AS ob ON ob.id = other.board_id
             WHERE edge.issue_id = ${issueId} OR edge.depends_on_issue_id = ${issueId}
             ORDER BY direction, identifier`;
         const ref = (row: Record<string, unknown>) => ({ identifier: row.identifier, title: row.title, status: row.status });
         return {
            dependsOn: rows.filter((row) => row.direction === 'depends_on').map(ref),
            blocks: rows.filter((row) => row.direction === 'blocks').map(ref),
         };
      },
   });

   registerAgentTool('post_comment', {
      description: 'Post a comment on this task, as yourself. Use it to ask a question or report progress.',
      scope: 'task:write',
      inputSchema: z.object({ body: z.string().min(1).max(20_000) }),
      handler: async (context, input) => {
         const comment = await postRunResult(context.sql, {
            issueId: issueOf(context),
            agentId: context.task.agentId,
            text: input.body,
            cut: false,
            occurredAt: new Date().toISOString(),
         });
         return { posted: comment !== null };
      },
   });

   registerAgentTool('set_status', {
      description: 'Move this task to another status. A person always makes the final release decision.',
      scope: 'task:write',
      inputSchema: z.object({ status: z.enum(AGENT_STATUSES) }),
      handler: async (context, input) => {
         await context.issues.update({
            issueId: issueOf(context),
            patch: { status: input.status, descriptionSet: false, dueDateSet: false, assigneeSet: false, projectSet: false },
            actorId: context.task.agentId,
            actorType: 'agent',
         });
         return { status: input.status };
      },
   });

   registerAgentTool('list_files', {
      description: 'List the files saved on this task, including work other agents saved.',
      scope: 'task:read',
      inputSchema: z.object({}),
      handler: async (context) => ({ files: await (await artifactsOf(context)).listArtifactKeys() }),
   });

   registerAgentTool('read_file', {
      description: 'Read a file saved on this task, by path.',
      scope: 'task:read',
      inputSchema: z.object({ path: z.string().min(1), version: z.number().int().min(0).optional() }),
      handler: async (context, input) => {
         const part = await (await artifactsOf(context)).loadArtifact({
            filename: input.path,
            ...(input.version === undefined ? {} : { version: input.version }),
         });
         if (!part?.inlineData?.data) return { path: input.path, found: false };
         const bytes = Buffer.from(part.inlineData.data, 'base64');
         return {
            path: input.path,
            found: true,
            contentType: part.inlineData.mimeType,
            sizeBytes: bytes.byteLength,
            truncated: bytes.byteLength > MAX_READ_BYTES,
            content: bytes.subarray(0, MAX_READ_BYTES).toString('utf8'),
         };
      },
   });

   registerAgentTool('write_file', {
      description: 'Save a text file on this task. Other agents and people on the task can read it.',
      scope: 'task:write',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      handler: async (context, input) => {
         const version = await (await artifactsOf(context)).saveArtifact({
            filename: input.path,
            artifact: { text: input.content },
         });
         return { path: input.path, version, saved: true };
      },
   });

   registerAgentTool('attach_file', {
      description: 'Attach a binary file (base64) to this task, such as a rendered clip or an image.',
      scope: 'task:write',
      inputSchema: z.object({
         path: z.string().min(1),
         base64: z.string().max(Math.ceil((MAX_ATTACH_BYTES * 4) / 3) + 4),
         contentType: z.string().optional(),
      }),
      handler: async (context, input) => {
         const version = await (await artifactsOf(context)).saveArtifact({
            filename: input.path,
            artifact: {
               inlineData: {
                  data: input.base64,
                  ...(input.contentType ? { mimeType: input.contentType } : {}),
               },
            },
         });
         return { path: input.path, version, sizeBytes: Buffer.from(input.base64, 'base64').byteLength, saved: true };
      },
   });

   registerAgentTool('read_project_resources', {
      description: "Read the project this task belongs to: its name, description and repository.",
      scope: 'task:read',
      inputSchema: z.object({}),
      handler: async (context) => {
         const rows = await context.sql`
            SELECT p.name, p.description, p.status, p.github_repo_full_name AS repository
              FROM issue_project_links AS link
              JOIN projects AS p ON p.id = link.project_id AND p.deleted_at IS NULL
             WHERE link.issue_id = ${issueOf(context)} AND p.workspace_id = ${context.task.workspaceId}`;
         return { projects: rows.map((row) => ({ ...row })) };
      },
   });

   registerAgentTool('mention_agent', {
      description: 'Ask another agent in this workspace to work on this task, with a message.',
      scope: 'task:write',
      inputSchema: z.object({ agentId: z.uuid(), message: z.string().min(1).max(20_000) }),
      handler: async (context, input) => {
         const [agent] = await context.sql`
            SELECT id FROM agents
             WHERE id = ${input.agentId} AND workspace_id = ${context.task.workspaceId} AND archived_at IS NULL`;
         if (!agent) throw ApiError.notFound('Agent');
         await postRunResult(context.sql, {
            issueId: issueOf(context),
            agentId: context.task.agentId,
            text: input.message,
            cut: false,
            occurredAt: new Date().toISOString(),
         });
         // Queued behind this run: the issue holds one active run, so the
         // mention is recorded and picked up when this one ends. Workstream D
         // replaces this with its mention-trigger path.
         return { mentioned: input.agentId, queued: false };
      },
   });
}
```

`server-ts/src/runtime/agent-tools/mount.ts`:

```ts
import { Hono } from 'hono';
import type { Sql } from '../../db/pool.ts';
import type { IssueRepository } from '../../core/issues.ts';
import { json } from '../../http/app.ts';
import { ApiError } from '../../http/errors.ts';
import type { Mount } from '../../http/registry.ts';
import type { Storage } from '../../storage/storage.ts';
import { registerCoreAgentTools } from './core-tools.ts';
import { getAgentTool, listAgentTools } from './registry.ts';
import { resolveTaskToken, type TaskClaims } from './tokens.ts';

/**
 * `/api/v1/agent-tools`: the only way an agent in a runtime acts on Berry.
 *
 * Authenticated by a task token alone. A session or personal token is
 * refused here, and a task token is refused everywhere else, because
 * `requireSession` dispatches by prefix and has no `berry_task_` branch.
 */
export function agentToolMounts(options: {
   sql: Sql;
   storage: Storage | null;
   issues: Pick<IssueRepository, 'update'>;
}): Mount[] {
   registerCoreAgentTools();
   const route = new Hono<{ Variables: { task: TaskClaims } }>();

   route.use('*', async (context, next) => {
      const header = context.req.header('authorization') ?? '';
      const match = /^Bearer (\S+)$/.exec(header);
      const claims = match?.[1] ? await resolveTaskToken(options.sql, match[1]).catch(() => null) : null;
      if (!claims) throw ApiError.unauthorized();
      context.set('task', claims);
      await next();
   });

   route.get('/', (context) => {
      const scopes = context.get('task').scopes;
      return json({
         tools: listAgentTools()
            .filter((tool) => scopes.includes(tool.scope))
            .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.jsonSchema })),
      });
   });

   route.post('/:name', async (context) => {
      const task = context.get('task');
      const tool = getAgentTool(context.req.param('name'));
      if (!tool || !task.scopes.includes(tool.scope)) throw ApiError.notFound('Tool');
      let body: unknown;
      try {
         body = await context.req.json();
      } catch {
         throw ApiError.badRequest('the request body must be JSON');
      }
      const outcome = await tool.run({ sql: options.sql, storage: options.storage, issues: options.issues, task }, body);
      if (!outcome.ok) throw ApiError.badRequest('the tool input is not valid', { issues: outcome.issues });
      return json({ result: outcome.result });
   });

   return [{ prefix: '/api/v1/agent-tools', handler: route }];
}
```

Verify the `IssuePatch` keys `assigneeSet` and `projectSet` exist, since `agents/review-gate.ts:222` passes them. Also check that `BerryArtifactService.saveArtifact` accepts `inlineData.mimeType` as optional (`sed -n 13,45p server-ts/src/agents/artifact-service.ts`). If `mimeType` is required, pass `input.contentType ?? 'application/octet-stream'`.

- [ ] **Step 8: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/agent-tools/*.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server-ts/src/runtime/agent-tools
git commit -m "feat(server-ts): serve Berry tools to runtimes behind task-scoped tokens

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 7: Container foundations — a dependency-free loop, a local shell, an emitting sink

**Files:**
- Create: `server-ts/src/agents/runtime/utf8.ts` (moved `truncateUtf8`)
- Create: `server-ts/src/agents/runtime/terminal.ts` (moved `RunTerminal`)
- Modify: `server-ts/src/runs/result-comment.ts` (re-export `truncateUtf8`), `server-ts/src/runs/ledger.ts:37-42` (re-export `RunTerminal`)
- Modify: `server-ts/src/agents/runtime/failure.ts:3`, `server-ts/src/agents/runtime/plugins/ledger.ts:11`, `server-ts/src/agents/prompt.ts:3`
- Modify: `server-ts/src/agents/command-tool.ts` (`CommandLedger` structural type)
- Create: `server-ts/src/agents/runtime/container/local-session.ts`, `local-session.test.ts`
- Create: `server-ts/src/agents/runtime/container/emitter.ts`, `emitter.test.ts`
- Create: `server-ts/src/agents/runtime/container/closure.test.ts`

**Interfaces:**
- Consumes: `ExecutionSession`, `ExecEvent`, `ExecOptions`, `ExecResult` from `src/execution/driver.ts` (dependency-free); `LedgerSink` from `plugins/ledger.ts`; `TaskMessage`, `LifecycleEvent` (Task 2).
- Produces:
  - `export type CommandLedger = Pick<RunLedger, 'appendCommandStarted' | 'appendCommandOutput' | 'appendCommandCompleted'>` in `command-tool.ts`; `CommandToolScope.ledger: CommandLedger`.
  - `class LocalSession implements ExecutionSession` with `constructor(options: { id: string; root: string; env?: Record<string, string> })`; `readonly root: string`.
  - `type Emit = (event: LifecycleEvent) => void`; `emitterSink(emit: Emit): LedgerSink & CommandLedger & { appendRepositoryReady; appendVerified }`.
  - `CONTAINER_ALLOWED_FILES`, the allowlist later copied by the Dockerfile (Task 12), kept in `closure.test.ts`.

- [ ] **Step 1: Write the failing closure test**

`server-ts/src/agents/runtime/container/closure.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What the runtime image ships, proven from the imports.
 *
 * The image copies only the files below (see sandbox/agentcore/Dockerfile).
 * Every non-test module under src/agents/runtime/ must reach nothing else —
 * a stray value import of the ledger or the pool would crash the container
 * at boot, or quietly ship the server into it.
 */
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const CONTAINER_ALLOWED_FILES = [
   'src/agents/runtime/',
   'src/agents/permissions.ts',
   'src/agents/command-tool.ts',
   'src/agents/checkout.ts',
   'src/agents/delivery.ts',
   'src/agents/verification.ts',
   'src/agents/workspace-files.ts',
   'src/execution/driver.ts',
   'src/execution/bytes.ts',
   'src/runtime/envelope.ts',
   'src/runtime/lifecycle.ts',
];
const ALLOWED_PACKAGES = new Set([
   '@strands-agents/sdk',
   'zod',
   '@aws-sdk/client-bedrock-runtime',
   '@aws-sdk/client-polly',
   '@aws-sdk/client-s3',
]);
const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gms;

function entries(): string[] {
   const root = join(SERVER_ROOT, 'src/agents/runtime');
   return readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join(root, file));
}

test('the runtime modules reach only what the image ships', () => {
   const seen = new Set<string>();
   const problems: string[] = [];
   const queue = entries();
   while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const rel = relative(SERVER_ROOT, file);
      if (!CONTAINER_ALLOWED_FILES.some((allowed) => rel === allowed || (allowed.endsWith('/') && rel.startsWith(allowed)))) {
         problems.push(`${rel} is imported but not shipped`);
         continue;
      }
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
         if (match[1]) continue;
         const specifier = match[2]!;
         if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
         else if (!specifier.startsWith('node:') && !ALLOWED_PACKAGES.has(specifier)) {
            problems.push(`${rel} imports package ${specifier}`);
         }
      }
   }
   assert.deepEqual(problems, []);
});
```

The `!` on `queue.pop()` is safe because the loop condition guarantees it; if the reviewer objects, use `const file = queue.pop(); if (!file) break;`.

- [ ] **Step 2: Run it to see today's leaks**

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/closure.test.ts`
Expected: FAIL. The failure lists at least `src/runs/result-comment.ts is imported but not shipped` (from `failure.ts`) and `src/runs/ledger.ts is imported but not shipped` (from `plugins/ledger.ts`).

- [ ] **Step 3: Move `truncateUtf8` and `RunTerminal`**

Move `truncateUtf8` into its own dependency-free file:
1. Cut the whole `export function truncateUtf8(...) { ... }` (starting at `server-ts/src/runs/result-comment.ts:155`, with its doc comment) and paste it unchanged into the new `server-ts/src/agents/runtime/utf8.ts`.
2. In `result-comment.ts`, add at the top: `import { truncateUtf8 } from '../agents/runtime/utf8.ts';` and `export { truncateUtf8 };`.

Move `RunTerminal` the same way:
1. Cut the `export class RunTerminal extends Error { ... }` block (`server-ts/src/runs/ledger.ts:37-42`) unchanged into `server-ts/src/agents/runtime/terminal.ts`.
2. In `ledger.ts`, add `import { RunTerminal } from '../agents/runtime/terminal.ts';` and `export { RunTerminal };`.

Then repoint the importers:
- `server-ts/src/agents/runtime/failure.ts:3` → `import { truncateUtf8 } from './utf8.ts';`
- `server-ts/src/agents/runtime/plugins/ledger.ts:11` → `import { RunTerminal } from '../terminal.ts';`
- `server-ts/src/agents/prompt.ts:3` → `import { truncateUtf8 } from './runtime/utf8.ts';`

In `server-ts/src/agents/command-tool.ts`, replace `import type { RunLedger } from '../runs/ledger.ts';` with:

```ts
import type { RunLedger } from '../runs/ledger.ts';

/** The three ledger writes a command makes. The runtime passes an emitter instead. */
export type CommandLedger = Pick<
   RunLedger,
   'appendCommandStarted' | 'appendCommandOutput' | 'appendCommandCompleted'
>;
```

Then change `ledger: RunLedger;` in `CommandToolScope` (line 39) and `readonly #ledger: RunLedger;` in `OutputRecorder` (line 190), plus the `OutputRecorder` constructor parameter type, to `CommandLedger`.

- [ ] **Step 4: Run the closure test and the existing runtime tests**

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/closure.test.ts 'src/agents/runtime/**/*.test.ts' src/runs/ledger.test.ts src/agents/command-tool.test.ts && pnpm typecheck`
Expected: PASS. If the closure test still names a file, move only the value it needs into `src/agents/runtime/` and re-export it from its old home, as above.

- [ ] **Step 5: Write the failing LocalSession and emitter tests**

`server-ts/src/agents/runtime/container/local-session.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalSession } from './local-session.ts';

const session = () => new LocalSession({ id: 's', root: mkdtempSync(join(tmpdir(), 'berry-local-')) });

test('a command runs through a shell and reports its exit code', async () => {
   const result = await session().exec('echo one && echo two >&2; exit 3');
   assert.deepEqual(result, { stdout: 'one\n', stderr: 'two\n', exitCode: 3 });
});

test('the stream starts, carries output, and ends with exit', async () => {
   const types: string[] = [];
   for await (const event of session().stream('printf hi')) types.push(event.type);
   assert.deepEqual([types[0], types.at(-1)], ['start', 'exit']);
   assert.ok(types.includes('stdout'));
});

test('cwd is relative to the session root and env reaches the command', async () => {
   const s = session();
   await s.exec('mkdir -p sub');
   const result = await s.exec('pwd; echo $GREETING', { cwd: 'sub', env: { GREETING: 'hello' } });
   assert.match(result.stdout, /\/sub\nhello\n$/);
});

test('files written are read back byte for byte', async () => {
   const s = session();
   await s.writeFile('deep/dir/a.txt', 'EOF\nline\n');
   assert.equal(await s.readFile('deep/dir/a.txt'), 'EOF\nline\n');
});

test('an aborted command ends with an error and a non-zero exit', async () => {
   const controller = new AbortController();
   setTimeout(() => controller.abort(), 50);
   const result = await session().exec('sleep 5', { signal: controller.signal });
   assert.notEqual(result.exitCode, 0);
});
```

`server-ts/src/agents/runtime/container/emitter.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { emitterSink } from './emitter.ts';

test('every ledger write becomes one task.message', async () => {
   const events: LifecycleEvent[] = [];
   const sink = emitterSink((event) => events.push(event));
   await sink.appendOutput('run', 'progress', 'hello');
   await sink.appendToolStarted('run', 'c1', 'run_command');
   await sink.appendToolCompleted('run', 'c1', true);
   await sink.appendCommandStarted('run', { commandId: 'k', command: 'ls', cwd: null });
   await sink.appendCommandOutput('run', { commandId: 'k', stream: 'stdout', text: 'a' });
   await sink.appendCommandCompleted('run', { commandId: 'k', exitCode: 0, durationMs: 3, truncated: false });
   assert.deepEqual(
      events.map((event) => (event.type === 'task.message' ? event.message.kind : event.type)),
      ['output', 'tool.started', 'tool.completed', 'command.started', 'command.output', 'command.completed']
   );
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/local-session.test.ts src/agents/runtime/container/emitter.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 7: Implement**

`server-ts/src/agents/runtime/container/local-session.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
   ExecEvent,
   ExecOptions,
   ExecResult,
   ExecutionSession,
} from '../../../execution/driver.ts';

/**
 * The run's workspace, as the container's own shell.
 *
 * The loop now runs beside its tools, so a command is a child process rather
 * than an `InvokeAgentRuntimeCommand` round trip. It implements the same
 * `ExecutionSession` seam, which is why `checkout`, `commitAndPush`, `verify`
 * and `run_command` work here unchanged.
 */
export class LocalSession implements ExecutionSession {
   readonly id: string;
   readonly root: string;
   readonly #env: Record<string, string>;

   constructor(options: { id: string; root: string; env?: Record<string, string> }) {
      this.id = options.id;
      this.root = options.root;
      this.#env = options.env ?? {};
   }

   async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      for await (const event of this.stream(command, options)) {
         if (event.type === 'stdout') stdout += event.data;
         else if (event.type === 'stderr') stderr += event.data;
         else if (event.type === 'exit') exitCode = event.exitCode;
         else if (event.type === 'error') {
            stderr += event.message;
            exitCode = exitCode === 0 ? 1 : exitCode;
         }
      }
      return { stdout, stderr, exitCode };
   }

   async *stream(command: string, options: ExecOptions = {}): AsyncIterable<ExecEvent> {
      let seq = 0;
      yield { type: 'start', seq: seq++, command };
      const cwd = this.#path(options.cwd ?? '.');
      await mkdir(cwd, { recursive: true });

      const queue: ExecEvent[] = [];
      let done = false;
      let wake: (() => void) | null = null;
      const push = (event: ExecEvent) => {
         queue.push(event);
         wake?.();
         wake = null;
      };
      const finish = (exitCode: number) => {
         if (done) return;
         push({ type: 'exit', seq: seq++, exitCode });
         done = true;
      };

      const child = spawn('/bin/bash', ['-c', command], {
         cwd,
         env: { ...process.env, ...this.#env, ...(options.env ?? {}) },
         ...(options.signal ? { signal: options.signal } : {}),
         ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (data: string) => push({ type: 'stdout', seq: seq++, data }));
      child.stderr.on('data', (data: string) => push({ type: 'stderr', seq: seq++, data }));
      child.on('error', (error) => {
         push({ type: 'error', seq: seq++, message: error.message });
         // A process that never started emits no `close`.
         if (child.pid === undefined) finish(127);
      });
      child.on('close', (code, signal) => {
         if (code === null && signal) push({ type: 'error', seq: seq++, message: `command ended by ${signal}` });
         finish(code ?? 1);
      });

      while (true) {
         const next = queue.shift();
         if (next) {
            yield next;
            continue;
         }
         if (done) return;
         await new Promise<void>((resolveWake) => {
            wake = resolveWake;
         });
      }
   }

   async writeFile(path: string, content: string): Promise<void> {
      const target = this.#path(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
   }

   async readFile(path: string): Promise<string> {
      return readFile(this.#path(path), 'utf8');
   }

   async stop(): Promise<void> {}

   /** The workspace outlives a run on purpose: the next run on the session reuses it. */
   async destroy(): Promise<void> {}

   #path(path: string): string {
      return isAbsolute(path) ? path : resolve(this.root, path);
   }
}
```

`server-ts/src/agents/runtime/container/emitter.ts`:

```ts
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import type { CommandLedger } from '../../command-tool.ts';
import type { LedgerSink } from '../plugins/ledger.ts';

export type Emit = (event: LifecycleEvent) => void;

export interface RepositoryLedger {
   appendRepositoryReady(runId: string, params: { repository: string; branch: string; baseCommit: string }): Promise<void>;
   appendVerified(
      runId: string,
      params: {
         passed: boolean;
         complete: boolean;
         durationMs: number;
         results: Array<{ command: string; exitCode: number | null; passed: boolean; durationMs: number; error: string | null }>;
      }
   ): Promise<void>;
}

/**
 * The ledger, as the runtime sees it: every write becomes a `task.message`.
 *
 * The same `LedgerPlugin` and `run_command` the server used write here, so
 * the rows the server records from the stream are the rows it used to record
 * itself. The run id argument is ignored — the stream belongs to one run.
 */
export function emitterSink(emit: Emit): LedgerSink & CommandLedger & RepositoryLedger {
   const message = (value: Extract<LifecycleEvent, { type: 'task.message' }>['message']) => {
      emit({ type: 'task.message', message: value });
      return Promise.resolve();
   };
   return {
      appendOutput: (_runId, channel, text) => message({ kind: 'output', channel, text }),
      appendToolStarted: (_runId, toolCallId, name) => message({ kind: 'tool.started', toolCallId, name }),
      appendToolCompleted: (_runId, toolCallId, succeeded) => message({ kind: 'tool.completed', toolCallId, succeeded }),
      appendCommandStarted: (_runId, params) => message({ kind: 'command.started', ...params }),
      appendCommandOutput: (_runId, params) => message({ kind: 'command.output', ...params }),
      appendCommandCompleted: (_runId, params) => message({ kind: 'command.completed', ...params }),
      appendRepositoryReady: (_runId, params) => message({ kind: 'repository.ready', ...params }),
      appendVerified: (_runId, params) => message({ kind: 'verified', ...params }),
   };
}
```

- [ ] **Step 8: Run all container tests**

Run: `cd server-ts && node --test --experimental-strip-types 'src/agents/runtime/container/*.test.ts' && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server-ts/src/agents server-ts/src/runs/result-comment.ts server-ts/src/runs/ledger.ts
git commit -m "refactor(server-ts): make the agent runtime modules shippable on their own

Adds a local shell session and a ledger sink that emits lifecycle events,
and a closure test that pins what the runtime image may import.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Berry tools inside the container

**Files:**
- Create: `server-ts/src/agents/runtime/container/remote-tools.ts`, `remote-tools.test.ts`

**Interfaces:**
- Consumes: the manifest and call contract of Task 6 (`GET {apiUrl}/api/v1/agent-tools` → `{ tools: [{ name, description, inputSchema }] }`; `POST {apiUrl}/api/v1/agent-tools/:name` → `{ result }`); Strands `tool(config: FunctionToolConfig)` with a JSON-schema `inputSchema`; `getBytes`, `FileTooLarge` from `src/execution/bytes.ts`; `WORKDIR_KEY` from `src/agents/command-tool.ts`.
- Produces:
  - `interface BerryApi { apiUrl: string; token: string; fetch?: typeof fetch }`
  - `loadRemoteTools(api: BerryApi): Promise<Tool[]>`. It fetches once per task and throws `RemoteToolsUnavailable` if the manifest cannot be read.
  - `collectFileTool(api: BerryApi, session: () => Promise<ExecutionSession>): Tool`. It reads a workspace file and calls `attach_file`.

- [ ] **Step 1: Write the failing test**

`server-ts/src/agents/runtime/container/remote-tools.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '@strands-agents/sdk';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { LocalSession } from './local-session.ts';
import { RemoteToolsUnavailable, collectFileTool, loadRemoteTools } from './remote-tools.ts';

function fakeBerry(calls: Array<{ url: string; body: unknown; auth: string | null }>): typeof fetch {
   return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization');
      if (url.endsWith('/api/v1/agent-tools') && (!init?.method || init.method === 'GET')) {
         return Response.json({
            tools: [
               {
                  name: 'read_task',
                  description: 'Read the task',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
               },
               {
                  name: 'attach_file',
                  description: 'Attach',
                  inputSchema: { type: 'object', properties: { path: { type: 'string' }, base64: { type: 'string' } } },
               },
            ],
         });
      }
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')), auth });
      return Response.json({ result: { title: 'The task' } });
   }) as typeof fetch;
}

test('manifest tools are callable by the model and carry the task token', async () => {
   const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
   const api = { apiUrl: 'https://berry.test', token: 'berry_task_x', fetch: fakeBerry(calls) };
   const tools = await loadRemoteTools(api);
   const agent = new Agent({
      model: new ScriptedModel([call('read_task', {}), say('read it')]),
      tools,
      printer: false,
   });
   await agent.invoke('go');
   assert.equal(calls[0]!.url, 'https://berry.test/api/v1/agent-tools/read_task');
   assert.equal(calls[0]!.auth, 'Bearer berry_task_x');
});

test('an unreadable manifest is an error, not a toolless agent', async () => {
   const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
   await assert.rejects(loadRemoteTools({ apiUrl: 'https://b', token: 't', fetch: failing }), RemoteToolsUnavailable);
});

test('collect_file uploads a workspace file through attach_file', async () => {
   const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
   const api = { apiUrl: 'https://berry.test', token: 't', fetch: fakeBerry(calls) };
   const session = new LocalSession({ id: 's', root: mkdtempSync(join(tmpdir(), 'berry-collect-')) });
   await session.writeFile('out/a.txt', 'bytes');
   const agent = new Agent({
      model: new ScriptedModel([call('collect_file', { path: 'out/a.txt' }), say('saved')]),
      tools: [collectFileTool(api, async () => session)],
      printer: false,
   });
   await agent.invoke('go');
   const body = calls[0]!.body as { path: string; base64: string };
   assert.equal(body.path, 'out/a.txt');
   assert.equal(Buffer.from(body.base64, 'base64').toString(), 'bytes');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/remote-tools.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`server-ts/src/agents/runtime/container/remote-tools.ts`:

```ts
import { tool, type JSONSchema, type JSONValue, type Tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import type { ExecutionSession } from '../../../execution/driver.ts';
import { FileTooLarge, getBytes } from '../../../execution/bytes.ts';
import { WORKDIR_KEY } from '../../command-tool.ts';

/**
 * Berry's tools, as the server describes them at the start of each task.
 *
 * The container knows no tool by name: whatever `/api/v1/agent-tools` lists
 * for this token becomes a Strands tool whose call is one authenticated POST.
 * A workstream that adds a tool on the server adds it to every agent without
 * an image rebuild.
 */

export interface BerryApi {
   apiUrl: string;
   token: string;
   fetch?: typeof fetch;
}

export class RemoteToolsUnavailable extends Error {
   override readonly name = 'RemoteToolsUnavailable';
}

const manifestSchema = z.object({
   tools: z.array(
      z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) })
   ),
});

const MAX_COLLECT_BYTES = 10 * 1024 * 1024;

export async function loadRemoteTools(api: BerryApi): Promise<Tool[]> {
   const doFetch = api.fetch ?? fetch;
   const response = await doFetch(`${base(api)}/api/v1/agent-tools`, {
      headers: { authorization: `Bearer ${api.token}` },
   }).catch((cause: unknown) => {
      throw new RemoteToolsUnavailable(`could not reach Berry: ${message(cause)}`);
   });
   if (!response.ok) throw new RemoteToolsUnavailable(`Berry refused the tool manifest (${response.status})`);
   const parsed = manifestSchema.safeParse(await response.json());
   if (!parsed.success) throw new RemoteToolsUnavailable('Berry sent a tool manifest this runtime cannot read');
   return parsed.data.tools.map((entry) =>
      tool({
         name: entry.name,
         description: entry.description,
         inputSchema: entry.inputSchema as JSONSchema,
         callback: async (input: unknown) => callBerry(api, entry.name, input),
      })
   );
}

export function collectFileTool(api: BerryApi, session: () => Promise<ExecutionSession>): Tool {
   return tool({
      name: 'collect_file',
      description:
         'Save a file from your workspace onto the task, such as a clip ffmpeg wrote. ' +
         'Other agents and people on the task can then read or download it.',
      inputSchema: z.object({
         path: z.string().describe('The file in the workspace, relative to where run_command runs'),
         as: z.string().optional().describe('The path to save it under on the task. Defaults to the same path.'),
      }),
      callback: async ({ path, as }, context?: ToolContext) => {
         const workdir = context?.agent.appState.get(WORKDIR_KEY);
         const cwd = typeof workdir === 'string' ? workdir : undefined;
         try {
            const bytes = await getBytes(await session(), path, { maxBytes: MAX_COLLECT_BYTES, ...(cwd ? { cwd } : {}) });
            if (bytes === null) return { path, found: false, error: `no file at ${path} in the workspace` };
            return await callBerry(api, 'attach_file', {
               path: (as ?? path).trim() || path,
               base64: Buffer.from(bytes).toString('base64'),
            });
         } catch (error) {
            if (error instanceof FileTooLarge) return { path, error: error.message };
            throw error;
         }
      },
   });
}

async function callBerry(api: BerryApi, name: string, input: unknown): Promise<JSONValue> {
   const doFetch = api.fetch ?? fetch;
   const response = await doFetch(`${base(api)}/api/v1/agent-tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input ?? {}),
   });
   const body = (await response.json().catch(() => null)) as { result?: JSONValue; error?: { message?: string } } | null;
   // A refused call is a result the model reads and acts on, like a non-zero
   // exit code; throwing would end the tool as a failure it cannot see.
   if (!response.ok) return { error: body?.error?.message ?? `Berry answered ${response.status}` };
   return body?.result ?? null;
}

function base(api: BerryApi): string {
   return api.apiUrl.replace(/\/+$/, '');
}

function message(cause: unknown): string {
   return cause instanceof Error ? cause.message : String(cause);
}
```

`getBytes` in `src/execution/bytes.ts` returns `Uint8Array | null` and accepts `{ maxBytes, cwd }`, as the old `collect_file` in `src/agents/tools.ts` used it. Confirm with `grep -n "export async function getBytes" -A6 server-ts/src/execution/bytes.ts`.

- [ ] **Step 4: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types 'src/agents/runtime/container/*.test.ts' && pnpm typecheck`
Expected: PASS (the closure test included).

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/agents/runtime/container/remote-tools.ts server-ts/src/agents/runtime/container/remote-tools.test.ts
git commit -m "feat(server-ts): give the runtime Berry's tools from the server's manifest

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 9: Persistent sessions in the container — warm append, cold restore

**Files:**
- Modify: `server-ts/src/agents/runtime/agent.ts` (`RunAgentSpec.messages`)
- Create: `server-ts/src/agents/runtime/container/sessions.ts`
- Create: `server-ts/src/agents/runtime/container/handler.ts`
- Create: `server-ts/src/agents/runtime/container/handler.test.ts` (the ScriptedModel contract tests)

**Interfaces:**
- Consumes:
  - `buildRunAgent`, `ModelFactory`, `LedgerPlugin`, `AccountingPlugin`, `textOf`, `PermissionPlugin`, `TOOL_PERMISSIONS`, `ToolOutcomePlugin`, `classify`, `permissionsOf`, `runCommandTool`, `MAX_SUMMARY_BYTES`, `truncateUtf8` (all under `src/agents/`).
  - `LocalSession`, `emitterSink`, `Emit` (Task 7); `loadRemoteTools`, `collectFileTool`, `BerryApi` (Task 8); `TaskEnvelope`, `TranscriptMessage` (Task 2).
- Produces:
  - `RunAgentSpec.messages?: MessageData[] | Message[]`.
  - `class SessionRegistry`:
    - `get(key): WarmSession | undefined`, `set(entry: WarmSession): void`, `drop(key): void`.
    - `exclusive<T>(key, work: (signal: AbortSignal) => Promise<T>): Promise<T>`, which serialises per session.
    - `stop(key): boolean`, which aborts and drops.
    - `get busy(): boolean`, `get size(): number`.
  - `interface WarmSession { key: string; fingerprint: string; messages: Message[]; workspace: LocalSession; lastUsedAt: number }`.
  - `interface HandlerDeps { registry: SessionRegistry; modelFactory: ModelFactory; region: string; workRoot: string; fetch?: typeof fetch; loadTools?: (api: BerryApi) => Promise<Tool[]>; repository?: RepositoryStep }`.
  - `type RepositoryStep = { prepare(input): Promise<string | null>; deliver(input): Promise<TaskDelivery | null> }` (implemented in Task 11).
  - `handleInvocation(envelope: TaskEnvelope, emit: Emit, deps: HandlerDeps): Promise<void>`.
  - `toConversation(transcript: TranscriptMessage[]): MessageData[]`.
  - `agentFingerprint(envelope): string`.
- Never emits anything after `task.completed` or `task.failed`.

- [ ] **Step 1: Let the run agent start from an existing conversation**

In `server-ts/src/agents/runtime/agent.ts`, change the import to `import { Agent, SlidingWindowConversationManager, type Message, type MessageData, type Plugin, type Tool } from '@strands-agents/sdk';`, add to `RunAgentSpec`:

```ts
   /**
    * The conversation so far: the live messages of a warm session, or the
    * transcript a cold one was restored from. Absent is a fresh conversation.
    */
   messages?: Message[] | MessageData[] | undefined;
```

and inside `new Agent({...})` add `...(spec.messages ? { messages: spec.messages } : {}),` after `plugins: spec.plugins,`. `@strands-agents/sdk` exports `Message` and `MessageData` (`types/messages.d.ts`). If `MessageData` is not re-exported from the package root, import it as `type MessageData` from the same path the SDK's `index.d.ts` names (`grep -n "MessageData" node_modules/@strands-agents/sdk/dist/src/index.d.ts`).

- [ ] **Step 2: Write the failing contract tests**

`server-ts/src/agents/runtime/container/handler.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tool, type Message } from '@strands-agents/sdk';
import { z } from 'zod';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { textOf } from '../plugins/accounting.ts';
import { ScriptedModel, call, say, throwing, type ScriptedTurn } from '../scripted-model.ts';
import { handleInvocation, toConversation, type HandlerDeps } from './handler.ts';
import { SessionRegistry } from './sessions.ts';

const SESSION = `berry-${'a'.repeat(64)}`;

function envelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
   return {
      kind: 'agent',
      runId: 'run-1',
      sessionKey: 'agent:issue',
      runtimeSessionId: SESSION,
      agent: {
         name: 'Builder', instructions: 'Be brief.', model: 'scripted', skills: [], mcpServers: [],
         permissions: [], maxTokens: null, temperature: null,
      },
      task: { prompt: 'first', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
      transcript: [],
      repo: null,
      completion: null,
      env: {},
      berry: { apiUrl: 'https://berry.test', token: 'berry_task_t' },
      ...overrides,
   };
}

function harness(turns: ScriptedTurn[], extra: Partial<HandlerDeps> = {}) {
   const model = new ScriptedModel(turns);
   const registry = new SessionRegistry();
   const deps: HandlerDeps = {
      registry,
      modelFactory: () => model,
      region: 'us-east-1',
      workRoot: mkdtempSync(join(tmpdir(), 'berry-sessions-')),
      loadTools: async () => [],
      ...extra,
   };
   const run = async (e: TaskEnvelope) => {
      const events: LifecycleEvent[] = [];
      await handleInvocation(e, (event) => events.push(event), deps);
      return events;
   };
   return { model, registry, deps, run };
}

const texts = (messages: Message[] | undefined) => (messages ?? []).map(textOf);

test('a run emits started, its words, usage, then completed', async () => {
   const { run } = harness([say('all done')]);
   const events = await run(envelope());
   assert.equal(events[0]!.type, 'task.started');
   assert.equal(events.at(-1)!.type, 'task.completed');
   assert.ok(events.some((event) => event.type === 'task.usage'));
   const completed = events.at(-1);
   assert.ok(completed?.type === 'task.completed');
   assert.equal(completed.result.text, 'all done');
});

test('warm: a second task on a live session appends to the same conversation', async () => {
   const { model, run } = harness([say('one'), say('two')]);
   await run(envelope({ runId: 'run-1', task: { ...envelope().task, prompt: 'first' } }));
   await run(
      envelope({
         runId: 'run-2',
         task: { ...envelope().task, prompt: 'second' },
         // Ignored while warm: the live conversation is the better record.
         transcript: [{ role: 'user', text: 'STALE' }, { role: 'assistant', text: 'STALE' }],
      })
   );
   assert.deepEqual(texts(model.received[1]), ['first', 'one', 'second']);
});

test('cold: a session the runtime does not hold is restored from the transcript', async () => {
   const { model, run } = harness([say('answer')]);
   await run(
      envelope({
         task: { ...envelope().task, prompt: 'follow-up' },
         transcript: [
            { role: 'user', text: 'earlier question' },
            { role: 'assistant', text: 'earlier answer' },
         ],
      })
   );
   assert.deepEqual(texts(model.received[0]), ['earlier question', 'earlier answer', 'follow-up']);
});

test('a changed agent configuration restarts cold rather than reusing the old conversation', async () => {
   const { model, run } = harness([say('one'), say('two')]);
   await run(envelope());
   await run(
      envelope({
         runId: 'run-2',
         agent: { ...envelope().agent, instructions: 'Now be verbose.' },
         task: { ...envelope().task, prompt: 'second' },
         transcript: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'one' }],
      })
   );
   assert.deepEqual(texts(model.received[1]), ['first', 'one', 'second']);
});

test('the runtime reports busy while a loop works and idle after', async () => {
   const seen: boolean[] = [];
   const holder: { registry?: SessionRegistry } = {};
   const probe = tool({
      name: 'probe',
      description: 'probe',
      inputSchema: z.object({}),
      callback: () => {
         seen.push(holder.registry?.busy ?? false);
         return 'ok';
      },
   });
   const h = harness([call('probe', {}), say('done')], { loadTools: async () => [probe] });
   holder.registry = h.registry;
   await h.run(envelope());
   assert.deepEqual(seen, [true]);
   assert.equal(h.registry.busy, false);
});

test('a failed model call is task.failed, and the session is dropped for a cold retry', async () => {
   const { registry, run } = harness([throwing(new Error('boom'))]);
   const events = await run(envelope());
   assert.equal(events.at(-1)!.type, 'task.failed');
   assert.equal(registry.get(SESSION), undefined);
});

test('an unreadable tool manifest fails the task instead of running toolless', async () => {
   const { run } = harness([say('x')], {
      loadTools: async () => {
         throw new Error('manifest refused');
      },
   });
   const events = await run(envelope());
   const last = events.at(-1);
   assert.ok(last?.type === 'task.failed');
   assert.equal(last.failure.retryable, true);
});

test('a transcript is normalised to alternating turns that start with the user', () => {
   assert.deepEqual(
      toConversation([
         { role: 'assistant', text: 'orphan' },
         { role: 'user', text: 'a' },
         { role: 'user', text: 'b' },
         { role: 'assistant', text: 'c' },
         { role: 'user', text: 'unanswered' },
      ]),
      [
         { role: 'user', content: [{ text: 'a\n\nb' }] },
         { role: 'assistant', content: [{ text: 'c' }] },
      ]
   );
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/handler.test.ts`
Expected: FAIL, `Cannot find module './handler.ts'`.

- [ ] **Step 4: Implement `sessions.ts`**

```ts
import type { Message } from '@strands-agents/sdk';
import type { LocalSession } from './local-session.ts';

/**
 * The sessions this microVM holds warm.
 *
 * AgentCore routes every invoke carrying one `runtimeSessionId` to the same
 * microVM while it lives, so this map is what makes a follow-up run on an
 * issue continue the conversation instead of starting over. Work on one
 * session is serialised: two runs never share a session concurrently on the
 * server side (`issues.active_run_id`), but a retry can arrive while the loop
 * of the run it replaces is still finishing after its stream closed.
 */

export interface WarmSession {
   key: string;
   /** Changes when the agent's configuration does; a mismatch restarts cold. */
   fingerprint: string;
   messages: Message[];
   workspace: LocalSession;
   lastUsedAt: number;
}

export class SessionRegistry {
   readonly #sessions = new Map<string, WarmSession>();
   readonly #tails = new Map<string, Promise<unknown>>();
   readonly #controllers = new Map<string, AbortController>();
   #active = 0;

   /** True while any loop is working — `/ping` answers `HealthyBusy`. */
   get busy(): boolean {
      return this.#active > 0;
   }

   get size(): number {
      return this.#sessions.size;
   }

   get(key: string): WarmSession | undefined {
      return this.#sessions.get(key);
   }

   set(entry: WarmSession): void {
      this.#sessions.set(entry.key, entry);
   }

   drop(key: string): void {
      this.#sessions.delete(key);
   }

   async exclusive<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const previous = this.#tails.get(key) ?? Promise.resolve();
      const controller = new AbortController();
      const next = previous
         .catch(() => undefined)
         .then(async () => {
            this.#active += 1;
            this.#controllers.set(key, controller);
            try {
               return await work(controller.signal);
            } finally {
               this.#active -= 1;
               if (this.#controllers.get(key) === controller) this.#controllers.delete(key);
            }
         });
      this.#tails.set(key, next);
      try {
         return await next;
      } finally {
         if (this.#tails.get(key) === next) this.#tails.delete(key);
      }
   }

   /** The local stand-in for `StopRuntimeSession`: abort the loop and forget the session. */
   stop(key: string): boolean {
      const controller = this.#controllers.get(key);
      controller?.abort();
      const held = this.#sessions.delete(key);
      return held || controller !== undefined;
   }
}
```

- [ ] **Step 5: Implement `handler.ts`**

```ts
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MessageData, Tool } from '@strands-agents/sdk';
import type { TaskEnvelope, TranscriptMessage } from '../../../runtime/envelope.ts';
import type { TaskDelivery } from '../../../runtime/lifecycle.ts';
import type { ExecutionSession } from '../../../execution/driver.ts';
import { runCommandTool, WORKDIR_KEY } from '../../command-tool.ts';
import { permissionsOf } from '../../permissions.ts';
import { buildRunAgent } from '../agent.ts';
import { classify } from '../failure.ts';
import type { ModelFactory } from '../model.ts';
import { AccountingPlugin } from '../plugins/accounting.ts';
import { LedgerPlugin } from '../plugins/ledger.ts';
import { PermissionPlugin, TOOL_PERMISSIONS } from '../plugins/permissions.ts';
import { ToolOutcomePlugin } from '../plugins/tool-outcome.ts';
import { MAX_SUMMARY_BYTES } from '../result-text.ts';
import { truncateUtf8 } from '../utf8.ts';
import { emitterSink, type Emit } from './emitter.ts';
import { LocalSession } from './local-session.ts';
import { collectFileTool, loadRemoteTools, type BerryApi } from './remote-tools.ts';
import type { SessionRegistry } from './sessions.ts';

/**
 * One task envelope, worked to a terminal lifecycle event.
 *
 * Warm or cold is decided here and nowhere else. The same envelope works
 * either way — it always carries the transcript — and only speed differs: a
 * warm session keeps its full Strands messages (tool calls included), a cold
 * one restores the text of earlier turns from what Berry recorded.
 */

export interface RepositoryStep {
   /** Clones or refreshes the checkout; returns its directory, or null without a repo. */
   prepare(input: { envelope: TaskEnvelope; session: LocalSession; warm: boolean; emit: Emit }): Promise<string | null>;
   deliver(input: {
      envelope: TaskEnvelope;
      session: LocalSession;
      directory: string;
      summary: string | null;
      emit: Emit;
   }): Promise<TaskDelivery | null>;
}

export interface HandlerDeps {
   registry: SessionRegistry;
   modelFactory: ModelFactory;
   region: string;
   /** Where session workspaces live: `/mnt/workspace` in the image. */
   workRoot: string;
   fetch?: typeof fetch;
   loadTools?: (api: BerryApi) => Promise<Tool[]>;
   repository?: RepositoryStep;
}

export async function handleInvocation(envelope: TaskEnvelope, emit: Emit, deps: HandlerDeps): Promise<void> {
   let ended = false;
   const say: Emit = (event) => {
      if (ended) return;
      if (event.type === 'task.completed' || event.type === 'task.failed') ended = true;
      emit(event);
   };
   await deps.registry.exclusive(envelope.runtimeSessionId, (signal) => runAgentTask(envelope, say, deps, signal));
}

async function runAgentTask(envelope: TaskEnvelope, emit: Emit, deps: HandlerDeps, signal: AbortSignal): Promise<void> {
   emit({ type: 'task.started' });
   const key = envelope.runtimeSessionId;
   const fingerprint = agentFingerprint(envelope);
   const held = deps.registry.get(key);
   const warm = held !== undefined && held.fingerprint === fingerprint;
   const workspace =
      held?.workspace ?? new LocalSession({ id: key, root: join(deps.workRoot, key), env: envelope.env });
   const sink = emitterSink(emit);
   const accounting = new AccountingPlugin();
   const ledger = new LedgerPlugin({ ledger: sink, runId: envelope.runId });
   const outcome = new ToolOutcomePlugin();
   const api: BerryApi = { ...envelope.berry, ...(deps.fetch ? { fetch: deps.fetch } : {}) };

   try {
      const remote = await (deps.loadTools ?? loadRemoteTools)(api);
      const session = async (): Promise<ExecutionSession> => workspace;
      const tools: Tool[] = [
         runCommandTool({ ledger: sink, runId: envelope.runId, session, newId: randomUUID }),
         collectFileTool(api, session),
         ...remote,
      ];
      // Fail-closed stays: a name missing from the table is refused. Berry's
      // own tools are admitted by name, and Berry enforces their scope.
      const table = { ...TOOL_PERMISSIONS, ...Object.fromEntries(remote.map((t) => [t.name, null])) };

      const directory = deps.repository
         ? await deps.repository.prepare({ envelope, session: workspace, warm, emit })
         : null;

      const agent = buildRunAgent(
         {
            agentName: envelope.agent.name,
            model: envelope.agent.model,
            region: deps.region,
            // The runtime's execution role; there is no key in the envelope.
            credentials: null,
            systemPrompt: envelope.agent.instructions,
            tools,
            plugins: [
               ledger,
               accounting,
               new PermissionPlugin({
                  permissions: permissionsOf(envelope.agent.permissions, envelope.agent.name),
                  table,
               }),
               outcome,
            ],
            maxTokens: envelope.agent.maxTokens ?? undefined,
            temperature: envelope.agent.temperature ?? undefined,
            traceAttributes: { 'berry.run_id': envelope.runId, 'berry.session': envelope.sessionKey },
            messages: warm && held ? held.messages : toConversation(envelope.transcript),
         },
         deps.modelFactory
      );
      if (directory) agent.appState.set(WORKDIR_KEY, directory);

      const result = await agent.invoke(envelope.task.prompt, { cancelSignal: signal });
      await ledger.flush();
      emitUsage(emit, envelope, accounting);
      if (signal.aborted || result.stopReason === 'cancelled') {
         deps.registry.drop(key);
         emit({ type: 'task.failed', failure: { code: 'RUN_CANCELLED', message: 'The session was stopped.', retryable: false } });
         return;
      }
      const fatal = outcome.fatal();
      if (fatal) {
         deps.registry.drop(key);
         emit({ type: 'task.failed', failure: { code: fatal.code, message: fatal.message, retryable: false } });
         return;
      }

      deps.registry.set({ key, fingerprint, messages: agent.messages, workspace, lastUsedAt: Date.now() });
      const [text, cut] = accounting.snapshot().result.final();
      const delivery =
         deps.repository && directory
            ? await deps.repository.deliver({ envelope, session: workspace, directory, summary: text === '' ? null : text, emit })
            : null;
      emit({
         type: 'task.completed',
         result: { text: truncateUtf8(text, MAX_SUMMARY_BYTES), truncated: cut || Buffer.byteLength(text) > MAX_SUMMARY_BYTES, delivery },
      });
   } catch (error) {
      await ledger.flush().catch(() => undefined);
      emitUsage(emit, envelope, accounting);
      // A conversation that ended mid-turn may hold a tool call with no
      // result, which the model refuses on the next invoke. Cold is safe.
      deps.registry.drop(key);
      const failure =
         error instanceof Error && error.name === 'RemoteToolsUnavailable'
            ? { code: 'BERRY_UNREACHABLE', message: error.message, retryable: true }
            : classify(error);
      emit({ type: 'task.failed', failure });
   }
}

function emitUsage(emit: Emit, envelope: TaskEnvelope, accounting: AccountingPlugin): void {
   const { usage } = accounting.snapshot();
   if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
   emit({
      type: 'task.usage',
      usage: {
         model: envelope.agent.model,
         inputTokens: usage.inputTokens,
         outputTokens: usage.outputTokens,
         cacheReadTokens: 0,
         cacheWriteTokens: 0,
      },
   });
}

/** What makes a warm conversation the same agent's. */
export function agentFingerprint(envelope: TaskEnvelope): string {
   const { name, instructions, model, permissions, skills, mcpServers } = envelope.agent;
   return createHash('sha256')
      .update(
         JSON.stringify({
            name,
            instructions,
            model,
            permissions: [...permissions].sort(),
            skills: skills.map((skill) => skill.name).sort(),
            mcp: mcpServers.map((server) => server.url).sort(),
         })
      )
      .digest('hex');
}

/**
 * The transcript as Bedrock accepts it: alternating turns, user first, and
 * not ending on an unanswered user turn (the new prompt is the next one).
 */
export function toConversation(transcript: TranscriptMessage[]): MessageData[] {
   const merged: TranscriptMessage[] = [];
   for (const message of transcript) {
      if (message.text.trim() === '') continue;
      const last = merged.at(-1);
      if (last && last.role === message.role) last.text = `${last.text}\n\n${message.text}`;
      else merged.push({ ...message });
   }
   while (merged[0]?.role === 'assistant') merged.shift();
   if (merged.at(-1)?.role === 'user') merged.pop();
   return merged.map((message) => ({ role: message.role, content: [{ text: message.text }] }));
}
```

`ToolFailed` exposes `code` and `message`, since `executor.ts` reads `error.code`. `agent.messages` is the SDK's live `Message[]` (`agent.d.ts:256`).

- [ ] **Step 6: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types 'src/agents/runtime/**/*.test.ts' && pnpm typecheck`
Expected: PASS. That covers the warm-append, cold-restore, config-change, busy and failure contract tests, plus the closure test.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/agents/runtime
git commit -m "feat(server-ts): keep agent sessions warm in the runtime and restore them cold

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Completion tasks in the container

**Files:**
- Create: `server-ts/src/agents/runtime/container/completion-task.ts`, `completion-task.test.ts`
- Modify: `server-ts/src/agents/runtime/container/handler.ts` (route `kind: 'completion'`)

**Interfaces:**
- Consumes: `Agent`, `StructuredOutputError`, `JsonValidationError` from `@strands-agents/sdk`; `z.fromJSONSchema`; `BerryRetryStrategy`, `classify`; `textOf`; `ModelFactory`.
- Produces: `runCompletionTask(envelope: TaskEnvelope, emit: Emit, deps: { modelFactory: ModelFactory; region: string }): Promise<void>`.
  - Stateless, with no registry and no tools.
  - Uses the non-streaming model (`stream: false`).
  - `result.structured` holds the validated object when `completion.jsonSchema` is set.
  - A model that refuses the shape emits `task.failed` with code `COMPLETION_INVALID`, `retryable: false`, and the model's text as the message.

- [ ] **Step 1: Write the failing test**

`server-ts/src/agents/runtime/container/completion-task.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { runCompletionTask } from './completion-task.ts';

function completion(jsonSchema: Record<string, unknown> | null, transcript: TaskEnvelope['transcript'] = []): TaskEnvelope {
   return {
      kind: 'completion', runId: 'c1', sessionKey: 'completion:c1', runtimeSessionId: `berry-${'c'.repeat(64)}`,
      agent: { name: 'Orchestrator', instructions: '', model: 'scripted', skills: [], mcpServers: [], permissions: [], maxTokens: null, temperature: null },
      task: { prompt: 'Classify this', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
      transcript, repo: null,
      completion: { system: 'You classify.', jsonSchema },
      env: {}, berry: { apiUrl: 'https://berry.test', token: 't' },
   };
}

async function run(envelope: TaskEnvelope, model: ScriptedModel): Promise<LifecycleEvent[]> {
   const events: LifecycleEvent[] = [];
   await runCompletionTask(envelope, (event) => events.push(event), { modelFactory: () => model, region: 'us-east-1' });
   return events;
}

test('free text comes back as the result text', async () => {
   const events = await run(completion(null), new ScriptedModel([say('a tidy answer')]));
   const last = events.at(-1);
   assert.ok(last?.type === 'task.completed');
   assert.equal(last.result.text, 'a tidy answer');
});

test('a schema is enforced by the model and returned as structured', async () => {
   const schema = z.toJSONSchema(z.object({ label: z.enum(['bug', 'feature']) })) as Record<string, unknown>;
   // Strands asks for structured output through a tool call named for the schema.
   const model = new ScriptedModel([call('StructuredOutput', { label: 'bug' }), say('done')]);
   const events = await run(completion(schema), model);
   const last = events.at(-1);
   assert.ok(last?.type === 'task.completed', JSON.stringify(last));
   assert.deepEqual(last.result.structured, { label: 'bug' });
});

test('a conversation in the transcript is the history before the prompt', async () => {
   const model = new ScriptedModel([say('reply')]);
   await run(completion(null, [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }]), model);
   assert.equal(model.received[0]!.length, 3);
});
```

The `StructuredOutput` tool name is the Strands default for structured output. Confirm it with `grep -rn "StructuredOutput'" node_modules/@strands-agents/sdk/dist/src --include=*.js | head -3`, run in `server-ts`. If the name differs, use the one found in this test.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/completion-task.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`server-ts/src/agents/runtime/container/completion-task.ts`:

```ts
import { Agent, JsonValidationError, StructuredOutputError } from '@strands-agents/sdk';
import { z } from 'zod';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import { BerryRetryStrategy, classify } from '../failure.ts';
import type { ModelFactory } from '../model.ts';
import { textOf } from '../plugins/accounting.ts';
import type { Emit } from './emitter.ts';
import { toConversation } from './handler.ts';

/**
 * One model call for the parts of Berry that are not an agent — the planner,
 * triage, the review gate, a chat reply, the editor.
 *
 * What `llm/completion.ts` did in the server, moved here so the server holds
 * no model client. A fresh agent per call: completions share no session.
 */
export async function runCompletionTask(
   envelope: TaskEnvelope,
   emit: Emit,
   deps: { modelFactory: ModelFactory; region: string }
): Promise<void> {
   emit({ type: 'task.started' });
   const spec = envelope.completion ?? { system: '', jsonSchema: null };
   const schema = spec.jsonSchema ? z.fromJSONSchema(spec.jsonSchema) : undefined;
   const agent = new Agent({
      model: deps.modelFactory({
         model: envelope.agent.model,
         region: deps.region,
         credentials: null,
         stream: false,
         maxTokens: envelope.agent.maxTokens ?? undefined,
      }),
      systemPrompt: spec.system,
      retryStrategy: new BerryRetryStrategy(),
      printer: false,
      messages: toConversation(envelope.transcript),
      ...(schema ? { structuredOutputSchema: schema } : {}),
   });
   try {
      const result = await agent.invoke(envelope.task.prompt);
      const usage = result.metrics?.accumulatedUsage;
      emit({
         type: 'task.usage',
         usage: {
            model: envelope.agent.model,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
         },
      });
      if (schema && result.structuredOutput === undefined) {
         emit({ type: 'task.failed', failure: { code: 'COMPLETION_INVALID', message: textOf(result.lastMessage), retryable: false } });
         return;
      }
      emit({
         type: 'task.completed',
         result: {
            text: textOf(result.lastMessage),
            truncated: false,
            ...(schema ? { structured: result.structuredOutput } : {}),
            delivery: null,
         },
      });
   } catch (error) {
      if (error instanceof StructuredOutputError || error instanceof JsonValidationError) {
         emit({ type: 'task.failed', failure: { code: 'COMPLETION_INVALID', message: error.message, retryable: false } });
         return;
      }
      emit({ type: 'task.failed', failure: classify(error) });
   }
}
```

In `handler.ts`, add `import { runCompletionTask } from './completion-task.ts';` and, as the first statement of `handleInvocation`'s body (after defining `say`):

```ts
   if (envelope.kind === 'completion') {
      // Fresh by construction: no registry, so nothing warm is read or kept.
      await runCompletionTask(envelope, say, deps);
      return;
   }
```

Because `completion-task.ts` imports `toConversation` from `handler.ts` and `handler.ts` imports `runCompletionTask`, move `toConversation` into `server-ts/src/agents/runtime/container/conversation.ts`. Import it from there in both files, and re-export it from `handler.ts` (`export { toConversation } from './conversation.ts';`) so the Task 9 test keeps its import.

- [ ] **Step 4: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types 'src/agents/runtime/**/*.test.ts' && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/agents/runtime/container
git commit -m "feat(server-ts): answer completion tasks in the runtime

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 11: The repository inside the container

**Files:**
- Modify: `server-ts/src/agents/checkout.ts` (export `TOKEN_VARIABLE` and `CREDENTIAL_HELPER`, already defined at the top of the file)
- Create: `server-ts/src/agents/runtime/container/repository.ts`, `repository.test.ts`

**Interfaces:**
- Consumes:
  - `checkout`, `TOKEN_VARIABLE`, `CREDENTIAL_HELPER`, `shellQuote` from `src/agents/checkout.ts`.
  - `commitAndPush` from `src/agents/delivery.ts`; `verify` from `src/agents/verification.ts`.
  - `RepositoryStep`, `Emit`, `LocalSession`, `emitterSink`; `RepoPlan`, `TaskDelivery`.
- Produces: `containerRepository(): RepositoryStep`.
  - Warm: reuses `<session root>/repo` when it is on `repo.branch`.
  - Cold: shallow-clones `baseBranch`, creates `repo.branch`, then fast-forwards to `origin/<branch>` if an earlier run pushed it.
  - Deliver: runs the verify commands (emits `verified`), then commits and pushes (returns `TaskDelivery`).
  - Opening the pull request stays on the server (Task 15), which holds the GitHub App.
- Behaviour dropped on purpose: bridging `write_file` artifacts into the checkout (`materialise`). The agent now has the real checkout under `run_command`, so files it means to commit are written there directly.

- [ ] **Step 1: Export the credential-helper constants**

In `server-ts/src/agents/checkout.ts`, prefix the existing `const TOKEN_VARIABLE = ...` and `const CREDENTIAL_HELPER = ...` declarations with `export`. Confirm the names with `grep -n "TOKEN_VARIABLE\|CREDENTIAL_HELPER" server-ts/src/agents/checkout.ts | head -4`.

- [ ] **Step 2: Write the failing test**

`server-ts/src/agents/runtime/container/repository.test.ts`:

```ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { LocalSession } from './local-session.ts';
import { containerRepository } from './repository.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function withRepo(branch: string): { session: LocalSession; remote: string } {
   const root = mkdtempSync(join(tmpdir(), 'berry-repo-'));
   const remote = mkdtempSync(join(tmpdir(), 'berry-remote-'));
   git(remote, 'init', '--bare', '-q');
   git(root, 'init', '-q', 'repo');
   const repo = join(root, 'repo');
   git(repo, 'config', 'user.email', 't@berry.test');
   git(repo, 'config', 'user.name', 'T');
   git(repo, 'commit', '--allow-empty', '-q', '-m', 'base');
   git(repo, 'checkout', '-q', '-b', branch);
   git(repo, 'remote', 'add', 'origin', remote);
   return { session: new LocalSession({ id: 's', root }), remote };
}

function envelopeFor(branch: string): TaskEnvelope {
   return {
      kind: 'agent', runId: 'r', sessionKey: 'a:i', runtimeSessionId: `berry-${'r'.repeat(64)}`,
      agent: { name: 'A', instructions: '', model: 'm', skills: [], mcpServers: [], permissions: [], maxTokens: null, temperature: null },
      task: { prompt: 'p', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
      transcript: [],
      repo: {
         fullName: 'owner/name', branch, baseBranch: 'main',
         credential: { username: 'x-access-token', password: 'token' },
         verifyCommands: ['true'], issueReference: 'BER-1', issueTitle: 'Fix it',
      },
      completion: null, env: {}, berry: { apiUrl: 'https://b.test', token: 't' },
   };
}

test('no repository in the envelope means no checkout', async () => {
   const { session } = withRepo('b');
   const directory = await containerRepository().prepare({
      envelope: { ...envelopeFor('b'), repo: null }, session, warm: false, emit: () => {},
   });
   assert.equal(directory, null);
});

test('a warm session reuses its checkout on the issue branch without cloning', async () => {
   const { session } = withRepo('berry/ber-1');
   const events: LifecycleEvent[] = [];
   const directory = await containerRepository().prepare({
      envelope: envelopeFor('berry/ber-1'), session, warm: true, emit: (event) => events.push(event),
   });
   assert.equal(directory, join(session.root, 'repo'));
   const ready = events.find((event) => event.type === 'task.message' && event.message.kind === 'repository.ready');
   assert.ok(ready);
});

test('delivery verifies, commits and pushes the branch', async () => {
   const { session, remote } = withRepo('berry/ber-2');
   await session.writeFile('repo/new.txt', 'hello\n');
   const events: LifecycleEvent[] = [];
   const delivery = await containerRepository().deliver({
      envelope: envelopeFor('berry/ber-2'), session, directory: join(session.root, 'repo'),
      summary: 'Added a file', emit: (event) => events.push(event),
   });
   assert.equal(delivery?.committed, true);
   assert.equal(delivery?.branch, 'berry/ber-2');
   assert.ok(git(remote, 'rev-parse', 'berry/ber-2'));
   assert.ok(events.some((event) => event.type === 'task.message' && event.message.kind === 'verified'));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/repository.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`server-ts/src/agents/runtime/container/repository.ts`:

```ts
import { join } from 'node:path';
import { CREDENTIAL_HELPER, TOKEN_VARIABLE, checkout, shellQuote } from '../../checkout.ts';
import { commitAndPush } from '../../delivery.ts';
import { verify } from '../../verification.ts';
import { emitterSink } from './emitter.ts';
import type { RepositoryStep } from './handler.ts';

/**
 * The run's repository, cloned and pushed from inside the runtime.
 *
 * Warm, the checkout from the last run on this issue is still on disk on the
 * issue's branch and is reused as it stands. Cold, the microVM was reaped:
 * clone the base shallowly, then pick up whatever an earlier run pushed to
 * the issue's branch, so a reaped VM loses no delivered work.
 */
const DIRECTORY = 'repo';

export function containerRepository(): RepositoryStep {
   return {
      async prepare({ envelope, session, warm, emit }) {
         const repo = envelope.repo;
         if (!repo) return null;
         const directory = join(session.root, DIRECTORY);
         const sink = emitterSink(emit);

         if (warm) {
            const head = await session.exec('git rev-parse --abbrev-ref HEAD', { cwd: directory });
            if (head.exitCode === 0 && head.stdout.trim() === repo.branch) {
               const base = await session.exec('git rev-parse HEAD', { cwd: directory });
               await sink.appendRepositoryReady(envelope.runId, {
                  repository: repo.fullName, branch: repo.branch, baseCommit: base.stdout.trim(),
               });
               return directory;
            }
         }

         const result = await checkout({
            session,
            repository: repo.fullName,
            branch: repo.branch,
            token: repo.credential.password,
            baseBranch: repo.baseBranch,
            directory,
         });
         const env = { [TOKEN_VARIABLE]: repo.credential.password };
         const helper = `-c credential.helper=${shellQuote(CREDENTIAL_HELPER)}`;
         const pushed = await session.exec(
            `git ${helper} fetch --depth 50 origin ${shellQuote(repo.branch)}`,
            { cwd: directory, env }
         );
         if (pushed.exitCode === 0) {
            await session.exec('git reset --hard FETCH_HEAD', { cwd: directory });
         }
         await sink.appendRepositoryReady(envelope.runId, {
            repository: repo.fullName, branch: result.branch, baseCommit: result.baseCommit,
         });
         return directory;
      },

      async deliver({ envelope, session, directory, summary, emit }) {
         const repo = envelope.repo;
         if (!repo) return null;
         const sink = emitterSink(emit);
         const report = await verify({ session, directory, commands: repo.verifyCommands });
         if (report.results.length > 0) {
            await sink.appendVerified(envelope.runId, {
               passed: report.passed,
               complete: report.complete,
               durationMs: report.durationMs,
               results: report.results.map((r) => ({
                  command: r.command, exitCode: r.exitCode, passed: r.passed, durationMs: r.durationMs, error: r.error,
               })),
            });
         }
         const delivery = await commitAndPush({
            session,
            directory,
            branch: repo.branch,
            token: repo.credential.password,
            message: `${repo.issueReference}: ${repo.issueTitle}`,
            ...(summary ? { body: summary } : {}),
         });
         return { ...delivery, branch: repo.branch };
      },
   };
}
```

`VerificationResult` fields `command`, `exitCode`, `passed`, `durationMs` and `error` are the ones `repository-run.ts` already maps.

In `server-ts/src/agents/runtime/container/handler.ts`, nothing changes: `deps.repository` is optional and `main.ts` (Task 12) passes `containerRepository()`.

- [ ] **Step 5: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types 'src/agents/runtime/**/*.test.ts' src/agents/checkout.test.ts src/agents/delivery.test.ts && pnpm typecheck`
Expected: PASS. If `commitAndPush` pushes with an explicit `https://github.com` URL rather than `origin`, change the delivery test to assert `delivery.committed === true` and the local commit (`git -C repo log -1 --format=%s` equals `BER-1: Fix it`) instead of the remote ref.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/agents/checkout.ts server-ts/src/agents/runtime/container/repository.ts server-ts/src/agents/runtime/container/repository.test.ts
git commit -m "feat(server-ts): check out, verify and push the issue branch inside the runtime

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: The runtime HTTP contract, entrypoint and image

**Files:**
- Create: `server-ts/src/agents/runtime/container/server.ts`, `server.test.ts`
- Create: `server-ts/src/agents/runtime/container/main.ts`
- Modify: `server-ts/sandbox/agentcore/Dockerfile` (rewrite)
- Delete: `server-ts/sandbox/agentcore/server.mjs`
- Modify: `docker-compose.yml` (new `agent-runtime` service; `berry-api` env `BERRY_AGENT_RUNTIME_URL`)
- Modify: `scripts/check-compose-config.py` (`EXPECTED_SERVICES`, agent-runtime rules)

**Interfaces:**
- Consumes: `handleInvocation`, `HandlerDeps`, `SessionRegistry`, `containerRepository`, `bedrockModel`, `taskEnvelopeSchema`, `encodeLifecycle`.
- Produces:
  - `createRuntimeServer(deps: HandlerDeps & { localControl?: boolean }): import('node:http').Server`.
  - `GET /ping` → `{ status: 'Healthy' | 'HealthyBusy', time_of_last_update: number }`, where the time is in unix seconds.
  - `POST /invocations` → `text/event-stream` of lifecycle frames, with a `: keepalive` comment every 15 s. The session header `x-amzn-bedrock-agentcore-runtime-session-id`, when present, must equal `envelope.runtimeSessionId` or the answer is 400. A closed client does not stop the loop.
  - `DELETE /sessions/:runtimeSessionId`, only when `localControl`. It is the local stand-in for `StopRuntimeSession` and answers 204, or 404 when the session is unknown.
- Env read by `main.ts`:
  - `PORT` (8080); `BERRY_RUNTIME_WORK_ROOT` (`/mnt/workspace`).
  - `BERRY_BEDROCK_REGION`, else `AWS_REGION`.
  - `BERRY_BEDROCK_ACCESS_KEY_ID`, `BERRY_BEDROCK_SECRET_ACCESS_KEY`, `BERRY_BEDROCK_SESSION_TOKEN`, used locally only. In AgentCore they are absent and the execution role applies.
  - `BERRY_RUNTIME_LOCAL_CONTROL`.
- Compose: `berry-api` reaches the local runtime at `BERRY_AGENT_RUNTIME_URL=http://agent-runtime:8080`.

- [ ] **Step 1: Write the failing server test**

`server-ts/src/agents/runtime/container/server.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { sampleEnvelope } from '../../../runtime/envelope.test.ts';
import { parseLifecycleStream, type LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { createRuntimeServer } from './server.ts';
import { SessionRegistry } from './sessions.ts';

let release: () => void = () => {};
const gate = new Promise<void>((resolve) => {
   release = resolve;
});
const registry = new SessionRegistry();
const waitTool = tool({ name: 'wait', description: 'w', inputSchema: z.object({}), callback: async () => (await gate, 'ok') });
const server = createRuntimeServer({
   registry,
   // Each task builds its own model; the envelope's model id picks the script.
   modelFactory: (spec) =>
      new ScriptedModel(spec.model === 'wait' ? [call('wait', {}), say('late')] : [say('hello')]),
   region: 'us-east-1',
   workRoot: mkdtempSync(join(tmpdir(), 'berry-server-')),
   loadTools: async () => [waitTool],
   localControl: true,
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('ping answers Healthy when idle', async () => {
   const body = (await (await fetch(`${base}/ping`)).json()) as { status: string };
   assert.equal(body.status, 'Healthy');
});

test('an invocation streams lifecycle events to a terminal event', async () => {
   const envelope = sampleEnvelope({ runtimeSessionId: `berry-${'1'.repeat(64)}` });
   const response = await fetch(`${base}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': envelope.runtimeSessionId },
      body: JSON.stringify(envelope),
   });
   assert.equal(response.headers.get('content-type'), 'text/event-stream');
   const events: LifecycleEvent[] = [];
   for await (const event of parseLifecycleStream(response.body!)) events.push(event);
   assert.equal(events[0]!.type, 'task.started');
   assert.equal(events.at(-1)!.type, 'task.completed');
});

test('a session header that disagrees with the envelope is refused', async () => {
   const response = await fetch(`${base}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': `berry-${'x'.repeat(64)}` },
      body: JSON.stringify(sampleEnvelope()),
   });
   assert.equal(response.status, 400);
});

test('an envelope that does not parse is a 400', async () => {
   const response = await fetch(`${base}/invocations`, { method: 'POST', body: '{"kind":"agent"}' });
   assert.equal(response.status, 400);
});

test('the loop outlives a closed stream, and ping says HealthyBusy meanwhile', async () => {
   // Not `base`: that name is the server URL at module scope.
   const sample = sampleEnvelope();
   const envelope = sampleEnvelope({ runtimeSessionId: `berry-${'2'.repeat(64)}`, agent: { ...sample.agent, model: 'wait' } });
   const controller = new AbortController();
   const response = await fetch(`${base}/invocations`, {
      method: 'POST', body: JSON.stringify(envelope), signal: controller.signal,
   });
   const reader = response.body!.getReader();
   await reader.read();
   controller.abort();
   await new Promise((resolve) => setTimeout(resolve, 100));
   const busy = (await (await fetch(`${base}/ping`)).json()) as { status: string };
   assert.equal(busy.status, 'HealthyBusy');
   release();
   for (let i = 0; i < 50 && registry.busy; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
   assert.equal(registry.busy, false);
   assert.ok(registry.get(envelope.runtimeSessionId), 'the session is kept warm');
});

test('local stop forgets a session', async () => {
   const response = await fetch(`${base}/sessions/berry-${'2'.repeat(64)}`, { method: 'DELETE' });
   assert.equal(response.status, 204);
});
```

This test imports `sampleEnvelope` from `envelope.test.ts`, which Task 2 exported for that reason. `modelFactory` is called once per task, and the busy test selects the script that blocks on the `wait` tool by setting `agent.model` to `'wait'`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/server.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `server.ts` and `main.ts`**

`server-ts/src/agents/runtime/container/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { taskEnvelopeSchema } from '../../../runtime/envelope.ts';
import { encodeLifecycle } from '../../../runtime/lifecycle.ts';
import { handleInvocation, type HandlerDeps } from './handler.ts';

/**
 * The AgentCore Runtime service contract: `GET /ping` and `POST /invocations`
 * on 0.0.0.0:8080.
 *
 * `/ping` is how AgentCore decides whether the microVM is idle: `HealthyBusy`
 * while any loop works keeps it from being reaped after the invoke stream has
 * closed. `/invocations` answers with the lifecycle stream and keeps working
 * if the caller goes away — the work is committed and the conversation kept
 * warm, and the server records the broken stream as retryable.
 */

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;

export function createRuntimeServer(deps: HandlerDeps & { localControl?: boolean }): Server {
   let lastUpdate = Math.floor(Date.now() / 1000);
   const touch = () => {
      lastUpdate = Math.floor(Date.now() / 1000);
   };

   return createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const reply = (status: number, body: unknown) => {
         const payload = JSON.stringify(body);
         response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
         response.end(payload);
      };

      if (request.method === 'GET' && path === '/ping') {
         return reply(200, { status: deps.registry.busy ? 'HealthyBusy' : 'Healthy', time_of_last_update: lastUpdate });
      }

      if (deps.localControl && request.method === 'DELETE' && path.startsWith('/sessions/')) {
         const stopped = deps.registry.stop(decodeURIComponent(path.slice('/sessions/'.length)));
         response.writeHead(stopped ? 204 : 404).end();
         return;
      }

      if (request.method === 'POST' && path === '/invocations') {
         void readBody(request)
            .then((raw) => {
               let parsedJson: unknown;
               try {
                  parsedJson = JSON.parse(raw);
               } catch {
                  return reply(400, { error: 'the body is not JSON' });
               }
               const parsed = taskEnvelopeSchema.safeParse(parsedJson);
               if (!parsed.success) {
                  return reply(400, { error: 'the task envelope is not valid', fields: parsed.error.issues.map((i) => i.path.join('.')) });
               }
               const envelope = parsed.data;
               const header = request.headers[SESSION_HEADER];
               if (typeof header === 'string' && header !== envelope.runtimeSessionId) {
                  return reply(400, { error: 'the session header does not match the envelope' });
               }
               response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
               const keepalive = setInterval(() => {
                  if (!response.writableEnded && !response.destroyed) response.write(': keepalive\n\n');
               }, KEEPALIVE_MS);
               keepalive.unref();
               touch();
               void handleInvocation(
                  envelope,
                  (event) => {
                     touch();
                     if (!response.writableEnded && !response.destroyed) response.write(encodeLifecycle(event));
                  },
                  deps
               ).finally(() => {
                  clearInterval(keepalive);
                  touch();
                  if (!response.writableEnded && !response.destroyed) response.end();
               });
            })
            .catch(() => reply(413, { error: 'the body is too large' }));
         return;
      }

      reply(404, { error: `no route for ${request.method} ${path}` });
   });
}

function readBody(request: IncomingMessage): Promise<string> {
   return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
         size += chunk.byteLength;
         if (size > MAX_BODY_BYTES) {
            reject(new Error('too large'));
            request.destroy();
            return;
         }
         chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
   });
}
```

`server-ts/src/agents/runtime/container/main.ts`:

```ts
import { bedrockModel, type AwsCredentials } from '../model.ts';
import { containerRepository } from './repository.ts';
import { createRuntimeServer } from './server.ts';
import { SessionRegistry } from './sessions.ts';

/**
 * The runtime image's entrypoint.
 *
 * In AgentCore the credential is the runtime's execution role, so the
 * `BERRY_BEDROCK_*` pair is unset and Bedrock uses the default chain. Locally
 * (the `agent-runtime` Compose service) the pair is how the same image reaches
 * Bedrock; `AWS_ACCESS_KEY_ID` is never read, because in the stack it is MinIO's.
 */
const env = process.env;
const region = (env.BERRY_BEDROCK_REGION ?? env.AWS_REGION ?? 'us-east-1').trim();
const accessKeyId = (env.BERRY_BEDROCK_ACCESS_KEY_ID ?? '').trim();
const secretAccessKey = (env.BERRY_BEDROCK_SECRET_ACCESS_KEY ?? '').trim();
const sessionToken = (env.BERRY_BEDROCK_SESSION_TOKEN ?? '').trim();
const credentials: AwsCredentials | null =
   accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } : null;

const server = createRuntimeServer({
   registry: new SessionRegistry(),
   modelFactory: (spec) => bedrockModel({ ...spec, credentials: spec.credentials ?? credentials }),
   region,
   workRoot: env.BERRY_RUNTIME_WORK_ROOT ?? '/mnt/workspace',
   repository: containerRepository(),
   localControl: (env.BERRY_RUNTIME_LOCAL_CONTROL ?? '').trim().toLowerCase() === 'true',
});

// 0.0.0.0, not localhost: AgentCore's health checks come from outside the container.
server.listen(Number(env.PORT ?? 8080), '0.0.0.0', () => {
   console.log(JSON.stringify({ msg: 'berry agent runtime listening', port: Number(env.PORT ?? 8080) }));
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
   process.once(signal, () => server.close(() => process.exit(0)));
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types 'src/agents/runtime/**/*.test.ts' && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Rewrite the image**

Replace `server-ts/sandbox/agentcore/Dockerfile` in full:

```dockerfile
# Berry's AgentCore Runtime image: the agent loop and its tools (ADR-0014).
#
# Built from the server-ts context so it runs the same sources the server's
# tests exercise, under --experimental-strip-types, with no build step:
#   docker build -f sandbox/agentcore/Dockerfile -t berry-agent-runtime server-ts
# What it copies is pinned by src/agents/runtime/container/closure.test.ts.
#
# ARM64 is required by AgentCore Runtime. Local x86 hosts can build with
# --build-arg BERRY_RUNTIME_PLATFORM=linux/amd64 (Compose does via env).
ARG BERRY_RUNTIME_PLATFORM=linux/arm64
FROM --platform=${BERRY_RUNTIME_PLATFORM} node:22-slim

# The toolchain an agent's commands reach for: git to clone and push, ffmpeg for
# media, a compiler for native modules, python3 for common scripts.
RUN apt-get update \
   && apt-get install -y --no-install-recommends \
      git ffmpeg ca-certificates openssh-client curl tar unzip gcc g++ make python3 \
   && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /opt/berry
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-workspace
COPY tsconfig.json ./
COPY src/agents ./src/agents
COPY src/execution ./src/execution
COPY src/runtime/envelope.ts src/runtime/lifecycle.ts ./src/runtime/

# Session workspaces. A persistent filesystem can be mounted here through the
# runtime's filesystemConfigurations so a checkout survives a session stop.
RUN mkdir -p /mnt/workspace
WORKDIR /mnt/workspace

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "/opt/berry/src/agents/runtime/container/main.ts"]
```

Delete the old contract server: `git rm server-ts/sandbox/agentcore/server.mjs`.

- [ ] **Step 6: Add the local service to Compose and the Compose check**

In `docker-compose.yml`, add after the `sandbox-image` service:

```yaml
  agent-runtime:
    # The AgentCore Runtime image, run locally (ADR-0014): the agent loop and
    # its tools. The same /ping and /invocations contract AgentCore calls.
    # Bedrock credentials use the BERRY_BEDROCK_* names; AWS_* here is MinIO's.
    build:
      context: ./server-ts
      dockerfile: sandbox/agentcore/Dockerfile
      args:
         BERRY_RUNTIME_PLATFORM: "${BERRY_RUNTIME_PLATFORM:-linux/arm64}"
    image: berry-agent-runtime:local
    environment:
      BERRY_BEDROCK_REGION: "${BERRY_BEDROCK_REGION:-}"
      BERRY_BEDROCK_ACCESS_KEY_ID: "${BERRY_BEDROCK_ACCESS_KEY_ID:-}"
      BERRY_BEDROCK_SECRET_ACCESS_KEY: "${BERRY_BEDROCK_SECRET_ACCESS_KEY:-}"
      BERRY_BEDROCK_SESSION_TOKEN: "${BERRY_BEDROCK_SESSION_TOKEN:-}"
      BERRY_RUNTIME_LOCAL_CONTROL: "true"
    ports:
      - "127.0.0.1:${AGENT_RUNTIME_PORT:-8080}:8080"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      start_period: 10s
      retries: 6
    restart: unless-stopped
```

Add to `berry-api.environment`, beside `BERRY_RUNTIME_URL`:

```yaml
      # The agent runtime berry-api dispatches tasks to when no AgentCore
      # runtime ARN is configured: the same image, run by the service above.
      BERRY_AGENT_RUNTIME_URL: "${BERRY_AGENT_RUNTIME_URL:-http://agent-runtime:8080}"
```

In `scripts/check-compose-config.py`:
- change line 15 to `EXPECTED_SERVICES = {"berry-api", "runtime", "sandbox-image", "agent-runtime", "postgres", "minio", "minio-bucket"}`;
- add `"BERRY_AGENT_RUNTIME_URL",` to the tuple of required berry-api keys in `check_runtime`;
- append to `check_runtime`:

```python
    agent_runtime = object_value(services["agent-runtime"], "agent-runtime service")
    require_loopback_port(agent_runtime, "agent-runtime", 8080)
    agent_environment = object_value(agent_runtime.get("environment"), "agent-runtime environment")
    if str(agent_environment.get("BERRY_RUNTIME_LOCAL_CONTROL", "")).lower() != "true":
        fail("agent-runtime must enable local session control")
```

- [ ] **Step 7: Verify the image and Compose**

Run: `python3 scripts/check-compose-config.py && docker build -f server-ts/sandbox/agentcore/Dockerfile -t berry-agent-runtime:local server-ts && docker run --rm -d -p 127.0.0.1:18080:8080 --name berry-rt-smoke berry-agent-runtime:local && sleep 3 && curl -s 127.0.0.1:18080/ping; docker rm -f berry-rt-smoke`
Expected: the Compose check passes; the image builds; curl prints `{"status":"Healthy","time_of_last_update":...}`.

- [ ] **Step 8: Commit**

```bash
git add server-ts/src/agents/runtime/container/server.ts server-ts/src/agents/runtime/container/server.test.ts server-ts/src/agents/runtime/container/main.ts server-ts/sandbox/agentcore/Dockerfile docker-compose.yml scripts/check-compose-config.py
git rm --cached -q server-ts/sandbox/agentcore/server.mjs 2>/dev/null || true
git commit -m "feat(server-ts): serve the task lifecycle from the AgentCore Runtime image

The same image runs locally as the agent-runtime Compose service.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 13: Runtime transports — AgentCore, local HTTP, in-process

**Files:**
- Create: `server-ts/src/runtime/transport.ts`
- Create: `server-ts/src/runtime/agentcore-transport.ts`, `agentcore-transport.test.ts`
- Create: `server-ts/src/runtime/http-transport.ts`, `http-transport.test.ts`
- Create: `server-ts/src/agents/runtime/container/in-process-transport.ts` (test/dev only; lives under `agents/runtime/` because it loads the loop)

**Interfaces:**
- Consumes: `InvokeAgentRuntimeCommand`, `StopRuntimeSessionCommand`, `BedrockAgentCoreClient` from `@aws-sdk/client-bedrock-agentcore` (the request takes `payload: Uint8Array`; the response has `response` as a byte stream). Also `parseLifecycleStream` (Task 2) and `handleInvocation`/`HandlerDeps` (Task 9).
- Produces:
  - `interface RuntimeTarget { id: string | null; driver: 'agentcore' | 'http'; arn: string | null; qualifier: string; region: string | null; endpointUrl: string | null }`
  - `interface RuntimeTransport { invoke(input: { target: RuntimeTarget; envelope: TaskEnvelope; signal: AbortSignal }): AsyncIterable<LifecycleEvent>; stop(input: { target: RuntimeTarget; runtimeSessionId: string }): Promise<void> }`
  - `class RuntimeUnavailable extends Error`, always retryable
  - `agentCoreTransport(options: { region: string; credentials?: AwsCredentials | null; client?: Pick<BedrockAgentCoreClient, 'send'> }): RuntimeTransport`
  - `httpTransport(options?: { fetch?: typeof fetch }): RuntimeTransport`
  - `routingTransport({ agentcore, http }): RuntimeTransport`, which dispatches on `target.driver`
  - `inProcessTransport(deps: HandlerDeps): RuntimeTransport`

- [ ] **Step 1: Write the failing tests**

`server-ts/src/runtime/agentcore-transport.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { sampleEnvelope } from './envelope.test.ts';
import { encodeLifecycle, type LifecycleEvent } from './lifecycle.ts';
import { agentCoreTransport } from './agentcore-transport.ts';
import { RuntimeUnavailable, type RuntimeTarget } from './transport.ts';

const target: RuntimeTarget = {
   id: null, driver: 'agentcore', arn: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/berry-abc',
   qualifier: 'DEFAULT', region: 'us-east-1', endpointUrl: null,
};

function stream(events: LifecycleEvent[]): AsyncIterable<Uint8Array> {
   const bytes = new TextEncoder().encode(events.map(encodeLifecycle).join(''));
   return (async function* () {
      yield bytes.subarray(0, 10);
      yield bytes.subarray(10);
   })();
}

test('invoke sends the envelope as the payload on the (agent, issue) session and reads the stream', async () => {
   const sent: unknown[] = [];
   const client = {
      send: async (command: unknown) => {
         sent.push(command);
         return { response: stream([{ type: 'task.started' }, { type: 'task.completed', result: { text: 'ok', truncated: false, delivery: null } }]) };
      },
   };
   const transport = agentCoreTransport({ region: 'us-east-1', client: client as never });
   const envelope = sampleEnvelope();
   const events: LifecycleEvent[] = [];
   for await (const event of transport.invoke({ target, envelope, signal: new AbortController().signal })) events.push(event);
   assert.equal(events.length, 2);
   const command = sent[0];
   assert.ok(command instanceof InvokeAgentRuntimeCommand);
   assert.equal(command.input.runtimeSessionId, envelope.runtimeSessionId);
   assert.equal(command.input.agentRuntimeArn, target.arn);
   assert.deepEqual(JSON.parse(new TextDecoder().decode(command.input.payload)), envelope);
});

test('a refused invoke is RuntimeUnavailable', async () => {
   const client = { send: async () => { throw new Error('ThrottlingException'); } };
   const transport = agentCoreTransport({ region: 'us-east-1', client: client as never });
   const iterate = async () => {
      for await (const _ of transport.invoke({ target, envelope: sampleEnvelope(), signal: new AbortController().signal })) {
         // drain
      }
   };
   await assert.rejects(iterate, RuntimeUnavailable);
});

test('stop is StopRuntimeSession on the same session, and never throws', async () => {
   const sent: unknown[] = [];
   const client = { send: async (command: unknown) => { sent.push(command); throw new Error('gone'); } };
   await agentCoreTransport({ region: 'us-east-1', client: client as never }).stop({ target, runtimeSessionId: `berry-${'0'.repeat(64)}` });
   assert.ok(sent[0] instanceof StopRuntimeSessionCommand);
});
```

`server-ts/src/runtime/http-transport.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleEnvelope } from './envelope.test.ts';
import { encodeLifecycle, type LifecycleEvent } from './lifecycle.ts';
import { httpTransport } from './http-transport.ts';
import { RuntimeUnavailable, type RuntimeTarget } from './transport.ts';

const target: RuntimeTarget = { id: null, driver: 'http', arn: null, qualifier: 'DEFAULT', region: null, endpointUrl: 'http://agent-runtime:8080/' };

test('invoke posts to /invocations with the AgentCore session header', async () => {
   const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
   const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(encodeLifecycle({ type: 'task.started' }), { headers: { 'content-type': 'text/event-stream' } });
   }) as unknown as typeof fetch;
   const envelope = sampleEnvelope();
   const events: LifecycleEvent[] = [];
   for await (const e of httpTransport({ fetch: fakeFetch }).invoke({ target, envelope, signal: new AbortController().signal })) events.push(e);
   assert.equal(seen[0]!.url, 'http://agent-runtime:8080/invocations');
   assert.equal(new Headers(seen[0]!.init?.headers).get('x-amzn-bedrock-agentcore-runtime-session-id'), envelope.runtimeSessionId);
   assert.deepEqual(events, [{ type: 'task.started' }]);
});

test('a runtime that answers an error status is unavailable', async () => {
   const fakeFetch = (async () => new Response('down', { status: 502 })) as unknown as typeof fetch;
   const iterate = async () => {
      for await (const _ of httpTransport({ fetch: fakeFetch }).invoke({ target, envelope: sampleEnvelope(), signal: new AbortController().signal })) {
         // drain
      }
   };
   await assert.rejects(iterate, RuntimeUnavailable);
});

test('stop deletes the local session', async () => {
   const seen: string[] = [];
   const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url}`);
      return new Response(null, { status: 204 });
   }) as unknown as typeof fetch;
   await httpTransport({ fetch: fakeFetch }).stop({ target, runtimeSessionId: 'berry-x' });
   assert.deepEqual(seen, ['DELETE http://agent-runtime:8080/sessions/berry-x']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/agentcore-transport.test.ts src/runtime/http-transport.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`server-ts/src/runtime/transport.ts`:

```ts
import type { TaskEnvelope } from './envelope.ts';
import type { LifecycleEvent } from './lifecycle.ts';

/** Where a task runs: an AgentCore Runtime by ARN, or the same image on a URL. */
export interface RuntimeTarget {
   /** The `agent_runtimes` row, or null for the deployment's configured default. */
   id: string | null;
   driver: 'agentcore' | 'http';
   arn: string | null;
   qualifier: string;
   region: string | null;
   endpointUrl: string | null;
}

export interface RuntimeTransport {
   invoke(input: { target: RuntimeTarget; envelope: TaskEnvelope; signal: AbortSignal }): AsyncIterable<LifecycleEvent>;
   /** Ends the session. Never throws: a session already gone is the goal. */
   stop(input: { target: RuntimeTarget; runtimeSessionId: string }): Promise<void>;
}

/** The runtime could not be reached or refused the invoke. Always retryable. */
export class RuntimeUnavailable extends Error {
   override readonly name = 'RuntimeUnavailable';
   readonly retryable = true;
}

export function routingTransport(transports: { agentcore: RuntimeTransport | null; http: RuntimeTransport }): RuntimeTransport {
   const pick = (target: RuntimeTarget): RuntimeTransport => {
      if (target.driver === 'http') return transports.http;
      if (!transports.agentcore) throw new RuntimeUnavailable('no AgentCore credentials or region are configured');
      return transports.agentcore;
   };
   return {
      invoke: (input) => pick(input.target).invoke(input),
      stop: async (input) => {
         try {
            await pick(input.target).stop(input);
         } catch {
            // Nothing to stop through.
         }
      },
   };
}
```

`server-ts/src/runtime/agentcore-transport.ts`:

```ts
import {
   BedrockAgentCoreClient,
   InvokeAgentRuntimeCommand,
   StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { TaskEnvelope } from './envelope.ts';
import { parseLifecycleStream, type LifecycleEvent } from './lifecycle.ts';
import { RuntimeUnavailable, type RuntimeTarget, type RuntimeTransport } from './transport.ts';

/**
 * `InvokeAgentRuntime` with the task envelope; the response body is the
 * runtime's lifecycle SSE stream. Not `InvokeAgentRuntimeCommand`: the loop is
 * in the runtime now, so Berry sends it work rather than shell commands.
 */
export function agentCoreTransport(options: {
   region: string;
   credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
   client?: Pick<BedrockAgentCoreClient, 'send'>;
}): RuntimeTransport {
   const clients = new Map<string, Pick<BedrockAgentCoreClient, 'send'>>();
   const clientFor = (region: string | null) => {
      if (options.client) return options.client;
      const key = region ?? options.region;
      let client = clients.get(key);
      if (!client) {
         client = new BedrockAgentCoreClient({
            region: key,
            ...(options.credentials ? { credentials: options.credentials } : {}),
         });
         clients.set(key, client);
      }
      return client;
   };

   return {
      async *invoke({ target, envelope, signal }: { target: RuntimeTarget; envelope: TaskEnvelope; signal: AbortSignal }): AsyncIterable<LifecycleEvent> {
         if (!target.arn) throw new RuntimeUnavailable('this runtime has no ARN');
         let body: AsyncIterable<Uint8Array>;
         try {
            const response = await clientFor(target.region).send(
               new InvokeAgentRuntimeCommand({
                  agentRuntimeArn: target.arn,
                  qualifier: target.qualifier,
                  runtimeSessionId: envelope.runtimeSessionId,
                  contentType: 'application/json',
                  accept: 'text/event-stream',
                  payload: new TextEncoder().encode(JSON.stringify(envelope)),
               }),
               { abortSignal: signal as never }
            );
            if (!response.response) throw new Error('the runtime returned no body');
            body = response.response as unknown as AsyncIterable<Uint8Array>;
         } catch (cause) {
            throw new RuntimeUnavailable(`could not invoke the AgentCore Runtime: ${message(cause)}`, { cause });
         }
         yield* parseLifecycleStream(body);
      },

      async stop({ target, runtimeSessionId }) {
         if (!target.arn) return;
         await clientFor(target.region)
            .send(new StopRuntimeSessionCommand({ agentRuntimeArn: target.arn, qualifier: target.qualifier, runtimeSessionId }))
            .catch(() => undefined);
      },
   };
}

function message(cause: unknown): string {
   return cause instanceof Error ? cause.message : String(cause);
}
```

`server-ts/src/runtime/http-transport.ts`:

```ts
import { parseLifecycleStream, type LifecycleEvent } from './lifecycle.ts';
import { RuntimeUnavailable, type RuntimeTransport } from './transport.ts';

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

/** The runtime image on a URL (the local `agent-runtime` service): same contract, no SigV4. */
export function httpTransport(options: { fetch?: typeof fetch } = {}): RuntimeTransport {
   const doFetch = options.fetch ?? fetch;
   const base = (url: string | null) => {
      if (!url) throw new RuntimeUnavailable('this runtime has no endpoint URL');
      return url.replace(/\/+$/, '');
   };
   return {
      async *invoke({ target, envelope, signal }): AsyncIterable<LifecycleEvent> {
         let response: Response;
         try {
            response = await doFetch(`${base(target.endpointUrl)}/invocations`, {
               method: 'POST',
               headers: { 'content-type': 'application/json', accept: 'text/event-stream', [SESSION_HEADER]: envelope.runtimeSessionId },
               body: JSON.stringify(envelope),
               signal,
            });
         } catch (cause) {
            throw new RuntimeUnavailable(`could not reach the runtime: ${cause instanceof Error ? cause.message : String(cause)}`);
         }
         if (!response.ok || !response.body) throw new RuntimeUnavailable(`the runtime answered ${response.status}`);
         yield* parseLifecycleStream(response.body);
      },
      async stop({ target, runtimeSessionId }) {
         await doFetch(`${base(target.endpointUrl)}/sessions/${encodeURIComponent(runtimeSessionId)}`, { method: 'DELETE' }).catch(
            () => undefined
         );
      },
   };
}
```

`server-ts/src/agents/runtime/container/in-process-transport.ts`:

```ts
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import type { RuntimeTransport } from '../../../runtime/transport.ts';
import { handleInvocation, type HandlerDeps } from './handler.ts';

/**
 * The runtime, called as a function. For tests of the server-side executor
 * against the real container handler and a ScriptedModel; never wired in
 * production, because it would load the model SDK into the server process.
 */
export function inProcessTransport(deps: HandlerDeps): RuntimeTransport {
   return {
      async *invoke({ envelope }) {
         const queue: LifecycleEvent[] = [];
         let done = false;
         let wake: (() => void) | null = null;
         const running = handleInvocation(envelope, (event) => {
            queue.push(event);
            wake?.();
         }, deps).finally(() => {
            done = true;
            wake?.();
         });
         while (true) {
            const next = queue.shift();
            if (next) {
               yield next;
               continue;
            }
            if (done) break;
            await new Promise<void>((resolve) => {
               wake = resolve;
            });
         }
         await running;
      },
      async stop({ runtimeSessionId }) {
         deps.registry.stop(runtimeSessionId);
      },
   };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/*.test.ts 'src/agents/runtime/**/*.test.ts' && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/runtime/transport.ts server-ts/src/runtime/agentcore-transport.ts server-ts/src/runtime/agentcore-transport.test.ts server-ts/src/runtime/http-transport.ts server-ts/src/runtime/http-transport.test.ts server-ts/src/agents/runtime/container/in-process-transport.ts
git commit -m "feat(server-ts): invoke runtimes with the task envelope and read their lifecycle stream

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Transcript and envelope builder

**Files:**
- Create: `server-ts/src/runtime/transcript.ts`
- Create: `server-ts/src/runtime/envelope-builder.ts`
- Create: `server-ts/src/runtime/envelope-builder.test.ts` (DB-gated)

**Interfaces:**
- Consumes: `buildMessage`, `lastRejection` from `src/agents/prompt.ts`; `recallPrompt`, `RunMemory` from `src/agentcore/memory.ts`; `repositoryForIssue` (fields `fullName`, `verifyCommands`); `branchName`, `parseRepository` from `src/agents/checkout.ts`; `loadIssue` from `src/agents/repository-run.ts`; `GitHubClient` (`repository(owner, name) → { defaultBranch, canPush }`); `permissionsOf`; `Sealer`; `sessionKeyFor`, `runtimeSessionIdFor`; `Dispatch`; `WINDOW_SIZE` from `src/agents/runtime/agent.ts` (constant only — import it as a value is fine for the check, but to keep the server free of the SDK at runtime copy the number instead: `const TRANSCRIPT_MESSAGES = 60`).
- Produces:
  - `buildTranscript(sql, input: { agentId: string; issueId: string | null; chatSessionId: string | null; excludeRunId: string; maxMessages?: number; maxChars?: number }): Promise<TranscriptMessage[]>`. It takes prior *terminal* runs of the same agent on the same issue or chat, oldest first, with user text from `prompt ?? instructions ?? "Work on <identifier>: <title>"` and assistant text from `runs.output`. It keeps the newest 60 messages, capped at 200 000 characters.
  - `interface TaskRow { runId; workspaceId; agentId; issueId: string | null; boardId: string | null; chatSessionId: string | null; kind: 'agent' | 'completion'; source: string; prompt: string | null; completionSpec: CompletionSpec | null; runtimeId: string | null }`
  - `interface CompletionSpec { purpose: string; system: string; jsonSchema: Record<string, unknown> | null; model: string | null; transcript?: TranscriptMessage[] }`
  - `interface AgentConfig { id; name; instructions; model; permissions: string[]; runtimeProfileId: string | null }`
  - `interface DeliveryPlan { fullName; defaultBranch; branch; reference; title; mergeRequiresApproval: boolean; mayOpenPullRequest: boolean }`
  - `loadTask(sql, runId): Promise<TaskRow>`
  - `class EnvelopeBuilder` with `constructor(deps: EnvelopeDeps)` and `build(input: { task: TaskRow; dispatch: Dispatch | null; token: string }): Promise<{ envelope: TaskEnvelope; delivery: DeliveryPlan | null; model: string }>`
  - `interface EnvelopeDeps { sql: Sql; publicUrl: string; defaultModel: string; memory: RunMemory; sealer: Sealer | null; gitCredential?: (workspaceId: string) => Promise<{ username: string; password: string; canPush?: boolean }>; github: (token: string) => GitHubClient }`

- [ ] **Step 1: Write the failing DB test**

`server-ts/src/runtime/envelope-builder.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { nullRunMemory } from '../agentcore/memory.ts';
import { GitHubClient } from '../integrations/github.ts';
import { enqueueTask } from '../runs/queue.ts';
import { EnvelopeBuilder, loadTask } from './envelope-builder.ts';
import { runtimeSessionIdFor } from './session-id.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from './test-fixture.ts';
import { buildTranscript } from './transcript.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('envelope builder', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;
   let builder: EnvelopeBuilder;

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'envelope');
      builder = new EnvelopeBuilder({
         sql, publicUrl: 'https://berry.test', defaultModel: 'default-model', memory: nullRunMemory(), sealer: null,
         github: (token) => new GitHubClient({ token }),
      });
   });
   afterEach(async () => {
      await sql`DELETE FROM runs WHERE workspace_id = ${fixture!.workspaceId}`;
   });
   after(async () => {
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   async function finishedRun(issueId: string, prompt: string, output: string, agentId = fixture!.agentId): Promise<string> {
      const { runId } = await enqueueTask(sql, {
         workspaceId: fixture!.workspaceId, agentId, issueId, kind: 'agent', source: 'mention', prompt,
      });
      await sql`UPDATE runs SET status = 'succeeded', dispatch_state = 'succeeded', output = ${output},
                       completed_at = now() WHERE id = ${runId}`;
      await sql`UPDATE issues SET active_run_id = NULL WHERE id = ${issueId}`;
      return runId;
   }

   test('the transcript is this agent on this issue, oldest first, without the current run', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      await finishedRun(issueId, 'first ask', 'first answer');
      await finishedRun(issueId, 'second ask', 'second answer');
      await finishedRun(issueId, 'someone else', 'not mine', f.orchestratorId);
      const { runId } = await enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.agentId, issueId, kind: 'agent', source: 'mention', prompt: 'now' });
      const transcript = await buildTranscript(sql, { agentId: f.agentId, issueId, chatSessionId: null, excludeRunId: runId });
      assert.deepEqual(transcript.map((m) => m.text), ['first ask', 'first answer', 'second ask', 'second answer']);
   });

   test('the transcript keeps the newest messages within its budget', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      for (let i = 0; i < 5; i += 1) await finishedRun(issueId, `ask ${i}`, `answer ${i}`);
      const transcript = await buildTranscript(sql, { agentId: f.agentId, issueId, chatSessionId: null, excludeRunId: 'none', maxMessages: 4 });
      assert.deepEqual(transcript.map((m) => m.text), ['ask 3', 'answer 3', 'ask 4', 'answer 4']);
   });

   test('an issue task envelope is on the (agent, issue) session and carries the transcript and token', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f, 'Envelope task');
      await finishedRun(issueId, 'earlier', 'did a thing');
      const { runId } = await enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.agentId, issueId, kind: 'agent', source: 'mention', prompt: 'continue' });
      const task = await loadTask(sql, runId);
      const { envelope, delivery } = await builder.build({ task, dispatch: null, token: 'berry_task_x' });
      assert.equal(envelope.runtimeSessionId, runtimeSessionIdFor(`${f.agentId}:${issueId}`));
      assert.equal(envelope.kind, 'agent');
      assert.equal(envelope.agent.model, 'default-model');
      assert.equal(envelope.transcript.length, 2);
      assert.equal(envelope.berry.token, 'berry_task_x');
      assert.match(envelope.task.prompt, /Envelope task/);
      assert.equal(delivery, null, 'no git credential means no repository');
   });

   test('two completion tasks never share a session', async () => {
      const f = fixture!;
      const one = await enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.orchestratorId, kind: 'completion', source: 'completion', prompt: 'a' });
      const two = await enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.orchestratorId, kind: 'completion', source: 'completion', prompt: 'b' });
      await sql`UPDATE runs SET completion_spec = ${sql.json({ purpose: 't', system: 's', jsonSchema: null, model: null } as never)}
                 WHERE id IN (${one.runId}, ${two.runId})`;
      const a = await builder.build({ task: await loadTask(sql, one.runId), dispatch: null, token: 't' });
      const b = await builder.build({ task: await loadTask(sql, two.runId), dispatch: null, token: 't' });
      assert.notEqual(a.envelope.runtimeSessionId, b.envelope.runtimeSessionId);
      assert.equal(a.envelope.completion?.system, 's');
      assert.deepEqual(a.envelope.transcript, []);
   });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/envelope-builder.test.ts`
Expected (with a DB): FAIL, modules not found.

- [ ] **Step 3: Implement `transcript.ts`**

```ts
import type { Sql } from '../db/pool.ts';
import type { TranscriptMessage } from './envelope.ts';

/**
 * The conversation a cold runtime restores: earlier runs of this agent on
 * this issue (or chat), as the text Berry recorded — what was asked, and what
 * the agent said. Tool calls are not in it; the ledger never stored their
 * arguments, and the warm path keeps them when it can.
 */

/** Matches the runtime's SlidingWindowConversationManager window (`WINDOW_SIZE` in agents/runtime/agent.ts). */
const TRANSCRIPT_MESSAGES = 60;
const TRANSCRIPT_CHARS = 200_000;

export async function buildTranscript(
   sql: Sql,
   input: {
      agentId: string;
      issueId: string | null;
      chatSessionId: string | null;
      excludeRunId: string;
      maxMessages?: number;
      maxChars?: number;
   }
): Promise<TranscriptMessage[]> {
   if (!input.issueId && !input.chatSessionId) return [];
   const rows = await sql`
      SELECT r.prompt, r.instructions, r.output, i.title,
             CASE WHEN i.id IS NULL THEN NULL ELSE berry_issue_identifier(r.workspace_id, i.number) END AS identifier
        FROM runs AS r
        LEFT JOIN issues AS i ON i.id = r.issue_id
       WHERE r.agent_id = ${input.agentId}
         AND r.kind = 'agent'
         AND r.id::text <> ${input.excludeRunId}
         AND r.status IN ('succeeded', 'failed', 'cancelled')
         AND (${input.issueId}::uuid IS NULL OR r.issue_id = ${input.issueId}::uuid)
         AND (${input.chatSessionId}::uuid IS NULL OR r.chat_session_id = ${input.chatSessionId}::uuid)
       ORDER BY r.created_at ASC, r.id ASC`;

   const messages: TranscriptMessage[] = [];
   for (const row of rows) {
      const asked =
         (row.prompt as string | null) ??
         (row.instructions as string | null) ??
         `Work on ${(row.identifier as string | null) ?? 'the task'}: ${(row.title as string | null) ?? ''}`.trim();
      messages.push({ role: 'user', text: asked });
      const said = ((row.output as string | null) ?? '').trim();
      if (said !== '') messages.push({ role: 'assistant', text: said });
   }

   const maxMessages = input.maxMessages ?? TRANSCRIPT_MESSAGES;
   const maxChars = input.maxChars ?? TRANSCRIPT_CHARS;
   const kept: TranscriptMessage[] = [];
   let chars = 0;
   for (let i = messages.length - 1; i >= 0 && kept.length < maxMessages; i -= 1) {
      const message = messages[i];
      if (!message) continue;
      if (chars + message.text.length > maxChars) break;
      chars += message.text.length;
      kept.unshift(message);
   }
   return kept;
}
```

- [ ] **Step 4: Implement `envelope-builder.ts`**

```ts
import type { Sql } from '../db/pool.ts';
import type { RunMemory } from '../agentcore/memory.ts';
import { recallPrompt } from '../agentcore/memory.ts';
import type { GitHubClient } from '../integrations/github.ts';
import type { Sealer } from '../integrations/sealing.ts';
import { branchName, parseRepository } from '../agents/checkout.ts';
import { permissionsOf } from '../agents/permissions.ts';
import { buildMessage, lastRejection } from '../agents/prompt.ts';
import { repositoryForIssue } from '../agents/repository-context.ts';
import { loadIssue } from '../agents/repository-run.ts';
import type { Dispatch } from '../runs/ledger.ts';
import type { RepoPlan, TaskEnvelope, TranscriptMessage } from './envelope.ts';
import { runtimeSessionIdFor, sessionKeyFor } from './session-id.ts';
import { buildTranscript } from './transcript.ts';

export interface CompletionSpec {
   purpose: string;
   system: string;
   jsonSchema: Record<string, unknown> | null;
   model: string | null;
   /** A multi-turn exchange before the prompt (chat replies). */
   transcript?: TranscriptMessage[];
}

export interface TaskRow {
   runId: string;
   workspaceId: string;
   agentId: string;
   issueId: string | null;
   boardId: string | null;
   chatSessionId: string | null;
   kind: 'agent' | 'completion';
   source: string;
   prompt: string | null;
   completionSpec: CompletionSpec | null;
   runtimeId: string | null;
}

export interface AgentConfig {
   id: string;
   name: string;
   instructions: string;
   model: string;
   permissions: string[];
   runtimeProfileId: string | null;
}

/** What the server needs after the runtime pushed, to open the pull request. */
export interface DeliveryPlan {
   fullName: string;
   defaultBranch: string;
   branch: string;
   reference: string;
   title: string;
   mergeRequiresApproval: boolean;
   mayOpenPullRequest: boolean;
}

export interface EnvelopeDeps {
   sql: Sql;
   /** `BERRY_PUBLIC_URL`: where the runtime calls the Berry tool API. */
   publicUrl: string;
   defaultModel: string;
   memory: RunMemory;
   sealer: Sealer | null;
   gitCredential?: ((workspaceId: string) => Promise<{ username: string; password: string; canPush?: boolean }>) | undefined;
   github: (token: string) => GitHubClient;
}

export async function loadTask(sql: Sql, runId: string): Promise<TaskRow> {
   const [row] = await sql`
      SELECT id, workspace_id, agent_id, issue_id, board_id, chat_session_id, kind, source,
             prompt, completion_spec, runtime_id
        FROM runs WHERE id = ${runId}`;
   if (!row) throw new Error(`run ${runId} does not exist`);
   return {
      runId: row.id as string,
      workspaceId: row.workspace_id as string,
      agentId: row.agent_id as string,
      issueId: (row.issue_id as string | null) ?? null,
      boardId: (row.board_id as string | null) ?? null,
      chatSessionId: (row.chat_session_id as string | null) ?? null,
      kind: row.kind as TaskRow['kind'],
      source: row.source as string,
      prompt: (row.prompt as string | null) ?? null,
      completionSpec: (row.completion_spec as CompletionSpec | null) ?? null,
      runtimeId: (row.runtime_id as string | null) ?? null,
   };
}

export class EnvelopeBuilder {
   readonly #deps: EnvelopeDeps;

   constructor(deps: EnvelopeDeps) {
      this.#deps = deps;
   }

   async build(input: { task: TaskRow; dispatch: Dispatch | null; token: string }): Promise<{
      envelope: TaskEnvelope;
      delivery: DeliveryPlan | null;
      model: string;
   }> {
      const { task } = input;
      const agent = await this.#agent(task.agentId);
      const profile = await this.#profile(agent.runtimeProfileId, task.workspaceId);
      const model =
         (task.kind === 'completion' ? task.completionSpec?.model : null) ?? (agent.model || profile.model || this.#deps.defaultModel);
      const sessionKey = sessionKeyFor({
         kind: task.kind, runId: task.runId, agentId: task.agentId, issueId: task.issueId, chatSessionId: task.chatSessionId,
      });

      const base = {
         runId: task.runId,
         sessionKey,
         runtimeSessionId: runtimeSessionIdFor(sessionKey),
         agent: {
            name: agent.name,
            instructions: agent.instructions,
            model,
            skills: [],
            mcpServers: [],
            permissions: agent.permissions,
            maxTokens: null,
            temperature: null,
         },
         env: profile.env,
         berry: { apiUrl: this.#deps.publicUrl, token: input.token },
      };

      if (task.kind === 'completion') {
         const spec = task.completionSpec ?? { purpose: 'completion', system: '', jsonSchema: null, model: null };
         return {
            model,
            delivery: null,
            envelope: {
               ...base,
               kind: 'completion',
               task: { prompt: task.prompt ?? '', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
               transcript: spec.transcript ?? [],
               repo: null,
               completion: { system: spec.system, jsonSchema: spec.jsonSchema },
            },
         };
      }

      const transcript = await buildTranscript(this.#deps.sql, {
         agentId: task.agentId, issueId: task.issueId, chatSessionId: task.chatSessionId, excludeRunId: task.runId,
      });

      if (!task.issueId || !input.dispatch) {
         // A chat task: the prompt is the message; workstream D adds the chat context.
         return {
            model,
            delivery: null,
            envelope: {
               ...base,
               kind: 'agent',
               task: { prompt: task.prompt ?? '', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
               transcript,
               repo: null,
               completion: null,
            },
         };
      }

      const dispatch = input.dispatch;
      const [reviewFeedback, recalled, comments, dependencies, projectResources] = await Promise.all([
         lastRejection(this.#deps.sql, dispatch.issueId),
         this.#deps.memory.recall({ agentId: task.agentId, issueId: dispatch.issueId }),
         this.#comments(dispatch.issueId),
         this.#dependencies(dispatch.issueId),
         this.#projectResources(dispatch.issueId, task.workspaceId),
      ]);
      const priorWork = recallPrompt(recalled);
      const { repo, delivery } = await this.#repository(task, dispatch, agent);
      return {
         model,
         delivery,
         envelope: {
            ...base,
            kind: 'agent',
            task: {
               prompt: buildMessage({ ...dispatch, reviewFeedback, ...(priorWork ? { priorWork } : {}) }),
               issue: {
                  id: dispatch.issueId,
                  identifier: dispatch.issueIdentifier,
                  title: dispatch.issueTitle,
                  description: dispatch.issueDescription,
               },
               comments,
               dependencies,
               projectResources,
               priorWork,
            },
            transcript,
            repo,
            completion: null,
         },
      };
   }

   async #agent(agentId: string): Promise<AgentConfig> {
      const [row] = await this.#deps.sql`
         SELECT id, name, instructions, model_name, permissions, runtime_profile_id
           FROM agents WHERE id = ${agentId} AND archived_at IS NULL`;
      if (!row) throw new Error(`agent ${agentId} does not exist`);
      const name = row.name as string;
      return {
         id: row.id as string,
         name,
         instructions:
            ((row.instructions as string | null) ?? '').trim() ||
            `You are ${name}, an agent working a task in Berry. Do the task you are given and report what you did.`,
         model: (row.model_name as string | null) ?? '',
         permissions: (row.permissions as string[] | null) ?? [],
         runtimeProfileId: (row.runtime_profile_id as string | null) ?? null,
      };
   }

   async #profile(profileId: string | null, workspaceId: string): Promise<{ env: Record<string, string>; model: string | null }> {
      if (!profileId) return { env: {}, model: null };
      // Scoped to the task's workspace: `agents.runtime_profile_id` is a plain
      // FK, so without this a mis-bound agent would open another tenant's env.
      const [row] = await this.#deps.sql`
         SELECT env_sealed, model_default FROM runtime_profiles
          WHERE id = ${profileId} AND workspace_id = ${workspaceId}`;
      if (!row) return { env: {}, model: null };
      const sealed = row.env_sealed as Buffer | null;
      const env = sealed && this.#deps.sealer ? (JSON.parse(this.#deps.sealer.open(sealed)) as Record<string, string>) : {};
      return { env, model: (row.model_default as string | null) ?? null };
   }

   async #comments(issueId: string): Promise<TaskEnvelope['task']['comments']> {
      const rows = await this.#deps.sql`
         SELECT c.body, c.created_at, c.author_type::text AS author_type,
                COALESCE(u.name, a.name, 'someone') AS author
           FROM comments AS c
           LEFT JOIN users AS u ON c.author_type = 'user' AND u.id = c.author_id
           LEFT JOIN agents AS a ON c.author_type = 'agent' AND a.id = c.author_id
          WHERE c.issue_id = ${issueId}
          ORDER BY c.created_at DESC LIMIT 30`;
      return rows.reverse().map((row) => ({
         author: row.author as string,
         body: row.body as string,
         createdAt: new Date(row.created_at as string).toISOString(),
      }));
   }

   /** Spec 2.2: the envelope carries the issue's dependencies (same query as the `list_dependencies` tool). */
   async #dependencies(issueId: string): Promise<TaskEnvelope['task']['dependencies']> {
      const rows = await this.#deps.sql`
         SELECT CASE WHEN edge.issue_id = ${issueId} THEN 'depends_on' ELSE 'blocks' END AS direction,
                other.title, other.status::text AS status,
                berry_issue_identifier(ob.workspace_id, other.number) AS identifier
           FROM issue_dependencies AS edge
           JOIN issues AS other
             ON other.id = CASE WHEN edge.issue_id = ${issueId} THEN edge.depends_on_issue_id ELSE edge.issue_id END
            AND other.deleted_at IS NULL
           JOIN boards AS ob ON ob.id = other.board_id
          WHERE edge.issue_id = ${issueId} OR edge.depends_on_issue_id = ${issueId}
          ORDER BY direction, identifier`;
      return rows.map((row) => ({
         identifier: row.identifier as string,
         title: row.title as string,
         status: row.status as string,
         direction: row.direction as 'depends_on' | 'blocks',
      }));
   }

   /** Spec 2.2: the envelope carries the project resources (same rows as `read_project_resources`). */
   async #projectResources(issueId: string, workspaceId: string): Promise<TaskEnvelope['task']['projectResources']> {
      const rows = await this.#deps.sql`
         SELECT p.name, p.description, p.github_repo_full_name AS repository
           FROM issue_project_links AS link
           JOIN projects AS p ON p.id = link.project_id AND p.deleted_at IS NULL
          WHERE link.issue_id = ${issueId} AND p.workspace_id = ${workspaceId}`;
      return rows.map((row) => ({
         title: row.name as string,
         url: row.repository ? `https://github.com/${row.repository as string}` : null,
         content: (row.description as string | null) ?? null,
      }));
   }

   async #repository(task: TaskRow, dispatch: Dispatch, agent: AgentConfig): Promise<{ repo: RepoPlan | null; delivery: DeliveryPlan | null }> {
      if (!this.#deps.gitCredential) return { repo: null, delivery: null };
      const repository = await repositoryForIssue(this.#deps.sql, dispatch.issueId);
      if (!repository) return { repo: null, delivery: null };
      const permissions = permissionsOf(agent.permissions, agent.name);
      // Before a credential is opened: an agent that may not read the
      // repository never causes a token to be minted on its behalf.
      permissions.require('read_repository');
      permissions.require('create_branches');
      const credential = await this.#deps.gitCredential(task.workspaceId);
      const { owner, name } = parseRepository(repository.fullName);
      const remote = await this.#deps.github(credential.password).repository(owner, name);
      if (!(credential.canPush ?? remote.canPush)) {
         throw new Error(`the GitHub connection cannot push to ${repository.fullName}`);
      }
      const issue = await loadIssue(this.#deps.sql, dispatch.issueId);
      const branch = branchName(agent.name, issue.reference, issue.title);
      return {
         repo: {
            fullName: repository.fullName,
            branch,
            baseBranch: remote.defaultBranch,
            credential: { username: credential.username, password: credential.password },
            verifyCommands: repository.verifyCommands,
            issueReference: issue.reference,
            issueTitle: issue.title,
         },
         delivery: {
            fullName: repository.fullName,
            defaultBranch: remote.defaultBranch,
            branch,
            reference: issue.reference,
            title: issue.title,
            mergeRequiresApproval: !permissions.has('merge_without_approval'),
            mayOpenPullRequest: permissions.has('open_pull_requests'),
         },
      };
   }
}
```

`repositoryForIssue(sql, issueId)` takes the issue id, as in `repository-run.ts:106`, and `GitHubClient.repository` returns `{ defaultBranch, canPush }`, as used at `repository-run.ts:118-125`. Confirm the `canPush` field name with `sed -n 98,106p server-ts/src/integrations/github.ts`.

- [ ] **Step 5: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/envelope-builder.test.ts && pnpm typecheck`
Expected: PASS (with a DB).

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/runtime/transcript.ts server-ts/src/runtime/envelope-builder.ts server-ts/src/runtime/envelope-builder.test.ts
git commit -m "feat(server-ts): build task envelopes with the session's transcript

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 15: RuntimeTaskExecutor — the lifecycle stream into the ledger

**Files:**
- Create: `server-ts/src/runtime/recorders.ts` (ledger-backed and direct task recorders)
- Create: `server-ts/src/runtime/delivery.ts` (open the pull request for a pushed branch)
- Create: `server-ts/src/runtime/task-executor.ts`
- Create: `server-ts/src/runtime/task-executor.test.ts` (DB-gated; real container handler via `inProcessTransport` and `ScriptedModel`)
- Modify: `server-ts/src/runs/ledger.ts` `lockRun` (line 769): `COALESCE(r.workspace_id, (SELECT b.workspace_id FROM boards AS b WHERE b.id = r.board_id)) AS workspace_id`

**Interfaces:**
- Consumes:
  - `Executor` from `src/runs/dispatcher.ts`; `RunLedger`, `RunTerminal`, `Dispatch`, `Usage`, `Failure`.
  - `EnvelopeBuilder`, `loadTask`, `TaskRow`, `DeliveryPlan` (Task 14); `RuntimeTransport`, `RuntimeTarget`, `RuntimeUnavailable` (Task 13); `LifecycleStreamError`.
  - `mintTaskToken`, `revokeTaskTokens` (Task 6); `postRunResult`, `truncateUtf8`, `pullRequestBody`, `parseRepository`, `GitHubClient.openPullRequest`, `RunMemory`.
- Produces:
  - `type UsageRecorder = (sql: Sql, input: { runId: string; workspaceId: string; agentId: string; runtimeId?: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => Promise<void>`. This is exactly C's `recordTaskUsage` signature.
  - `interface TaskOutcome { runId; status: 'succeeded' | 'failed' | 'cancelled'; summary: string | null; usage: Usage; failure?: Failure; result?: TaskResult }`.
  - `class RuntimeTaskExecutor implements Executor`, constructed with `new RuntimeTaskExecutor(options: RuntimeTaskExecutorOptions)`; it exposes `execute(runId, signal?): Promise<TaskOutcome>`.
  - `interface RuntimeTaskExecutorOptions`:
    - `sql`, `transport`, `builder: EnvelopeBuilder`, `defaultTarget: RuntimeTarget | null`, `recordUsage: UsageRecorder`;
    - `ledger?`, `memory?`, `gitCredential?`, `github?`, `reviewGate?`, `onGateError?`, `onUsageError?`;
    - `tokenTtlSeconds?` (default 28800), `clock?`, `newId?`.
  - `resolveTarget(sql, workspaceId, runtimeId, fallback): Promise<RuntimeTarget | null>`. It only resolves a runtime row of the task's own workspace.
- Failure codes it writes:
  - `RUNTIME_STREAM_ENDED` (retryable)
  - `RUNTIME_UNAVAILABLE` (retryable)
  - `RUNTIME_PROTOCOL` (retryable)
  - `RUNTIME_UNCONFIGURED` (not retryable)
  - `TASK_PREPARATION_FAILED` (not retryable)
  - `DELIVERY_FAILED` (not retryable)
  - whatever the runtime sent in `task.failed`.
- Behaviour:
  - `task.usage` → `recordUsage` plus the run's accumulated totals.
  - `task.completed` → the delivery PR if any, then `completeSuccess` (issue runs) or a direct success (others), then the result comment, memory and review gate.
  - Abort (heartbeat saw `cancelled`) → `transport.stop` with `StopRuntimeSession`, then `markCancelled`.
  - Task tokens are revoked in `finally`.
  - The completion result is stored in `runs.result` (jsonb), where `runCompletion` reads it.

- [ ] **Step 1: Write the failing DB test**

`server-ts/src/runtime/task-executor.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { nullRunMemory } from '../agentcore/memory.ts';
import { ScriptedModel, say, type ScriptedTurn } from '../agents/runtime/scripted-model.ts';
import { inProcessTransport } from '../agents/runtime/container/in-process-transport.ts';
import { SessionRegistry } from '../agents/runtime/container/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { GitHubClient } from '../integrations/github.ts';
import { enqueueTask } from '../runs/queue.ts';
import { EnvelopeBuilder } from './envelope-builder.ts';
import type { LifecycleEvent } from './lifecycle.ts';
import { RuntimeTaskExecutor, type UsageRecorder } from './task-executor.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from './test-fixture.ts';
import type { RuntimeTarget, RuntimeTransport } from './transport.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const TARGET: RuntimeTarget = { id: null, driver: 'http', arn: null, qualifier: 'DEFAULT', region: null, endpointUrl: 'http://test' };

function scripted(events: LifecycleEvent[], stopped: string[] = []): RuntimeTransport {
   return {
      async *invoke() {
         for (const event of events) yield event;
      },
      async stop({ runtimeSessionId }) {
         stopped.push(runtimeSessionId);
      },
   };
}

describe('runtime task executor', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;
   const usage: Array<Parameters<UsageRecorder>[1]> = [];
   const recordUsage: UsageRecorder = async (_sql, input) => void usage.push(input);

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'executor');
   });
   afterEach(async () => {
      usage.length = 0;
      await sql`DELETE FROM runs WHERE workspace_id = ${fixture!.workspaceId}`;
   });
   after(async () => {
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   const builder = () =>
      new EnvelopeBuilder({
         sql, publicUrl: 'https://berry.test', defaultModel: 'scripted', memory: nullRunMemory(), sealer: null,
         github: (token) => new GitHubClient({ token }),
      });
   const executor = (transport: RuntimeTransport) =>
      new RuntimeTaskExecutor({ sql, transport, builder: builder(), defaultTarget: TARGET, recordUsage, memory: nullRunMemory() });

   async function issueTask(): Promise<{ runId: string; issueId: string }> {
      const issueId = await createIssue(sql, fixture!);
      const { runId } = await enqueueTask(sql, {
         workspaceId: fixture!.workspaceId, agentId: fixture!.agentId, issueId, kind: 'agent', source: 'assignment',
      });
      return { runId, issueId };
   }

   test('the real runtime handler drives an issue run to succeeded, with events and usage', async () => {
      const { runId, issueId } = await issueTask();
      const transport = inProcessTransport({
         registry: new SessionRegistry(),
         modelFactory: () => new ScriptedModel([say('The fix is in.')] as ScriptedTurn[]),
         region: 'us-east-1',
         workRoot: mkdtempSync(join(tmpdir(), 'berry-exec-')),
         loadTools: async () => [],
      });
      const outcome = await executor(transport).execute(runId);
      assert.equal(outcome.status, 'succeeded');
      const [run] = await sql`SELECT status, summary, input_tokens, runtime_session_id FROM runs WHERE id = ${runId}`;
      assert.equal(run!.status, 'succeeded');
      assert.equal(run!.summary, 'The fix is in.');
      assert.ok(Number(run!.input_tokens) > 0);
      assert.match(run!.runtime_session_id as string, /^berry-[0-9a-f]{64}$/);
      const types = (await sql`SELECT event_type FROM run_events WHERE run_id = ${runId} ORDER BY sequence`).map((r) => r.event_type);
      assert.ok(types.includes('run.started') && types.includes('run.output.delta') && types.includes('run.completed'));
      assert.equal(usage.length, 1);
      assert.equal(usage[0]!.agentId, fixture!.agentId);
      const [issue] = await sql`SELECT status, active_run_id FROM issues WHERE id = ${issueId}`;
      assert.deepEqual({ ...issue }, { status: 'in_review', active_run_id: null });
      const tokens = await sql`SELECT revoked_at FROM task_tokens WHERE run_id = ${runId}`;
      assert.ok(tokens.every((t) => t.revoked_at !== null));
   });

   test('a stream that ends without a verdict is RUNTIME_STREAM_ENDED, retryable', async () => {
      const { runId } = await issueTask();
      const outcome = await executor(scripted([{ type: 'task.started' }])).execute(runId);
      assert.equal(outcome.status, 'failed');
      assert.deepEqual(outcome.failure, {
         code: 'RUNTIME_STREAM_ENDED',
         message: 'The runtime stopped reporting before the task finished.',
         retryable: true,
      });
   });

   test('task.failed from the runtime is recorded as sent', async () => {
      const { runId } = await issueTask();
      const outcome = await executor(
         scripted([{ type: 'task.started' }, { type: 'task.failed', failure: { code: 'MODEL_REFUSED', message: 'no', retryable: false } }])
      ).execute(runId);
      assert.equal(outcome.failure?.code, 'MODEL_REFUSED');
   });

   test('a cancelled run stops the runtime session', async () => {
      const { runId } = await issueTask();
      const stopped: string[] = [];
      const controller = new AbortController();
      const hanging: RuntimeTransport = {
         async *invoke({ signal }) {
            yield { type: 'task.started' } as LifecycleEvent;
            controller.abort();
            // Aborted just above: a listener added to an already-aborted
            // signal never fires, so waiting unconditionally would hang the test.
            if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
         },
         async stop({ runtimeSessionId }) {
            stopped.push(runtimeSessionId);
         },
      };
      const outcome = await executor(hanging).execute(runId, controller.signal);
      assert.equal(outcome.status, 'cancelled');
      assert.equal(stopped.length, 1);
   });

   test('a completion task stores its result and writes no run events', async () => {
      const { runId } = await enqueueTask(sql, {
         workspaceId: fixture!.workspaceId, agentId: fixture!.orchestratorId, kind: 'completion', source: 'completion', prompt: 'x',
      });
      await sql`UPDATE runs SET completion_spec = ${sql.json({ purpose: 't', system: 's', jsonSchema: null, model: null } as never)} WHERE id = ${runId}`;
      const outcome = await executor(
         scripted([
            { type: 'task.started' },
            { type: 'task.usage', usage: { model: 'm', inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
            { type: 'task.completed', result: { text: 'hi', truncated: false, structured: { a: 1 }, delivery: null } },
         ])
      ).execute(runId);
      assert.equal(outcome.status, 'succeeded');
      const [run] = await sql`SELECT status, result, total_tokens FROM runs WHERE id = ${runId}`;
      assert.equal(run!.status, 'succeeded');
      assert.deepEqual((run!.result as { structured: unknown }).structured, { a: 1 });
      assert.equal(Number(run!.total_tokens), 5);
      const events = await sql`SELECT 1 FROM run_events WHERE run_id = ${runId}`;
      assert.equal(events.length, 0);
   });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/task-executor.test.ts`
Expected (with a DB): FAIL, modules not found.

- [ ] **Step 3: Implement `recorders.ts`**

```ts
import type { Sql } from '../db/pool.ts';
import { RunTerminal, type Failure, type RunLedger, type Usage } from '../runs/ledger.ts';
import type { TaskMessage, TaskResult } from './lifecycle.ts';

/**
 * Where a task's lifecycle is written.
 *
 * Issue runs go through the ledger, as they always have: the run stream, the
 * task timeline and the review gate read what it writes. A run with no issue
 * (a completion; a chat task until workstream D gives chats a stream) has no
 * board to publish on, so it writes its status on the row and nothing else.
 */
export interface TaskRecorder {
   started(): Promise<void>;
   message(message: TaskMessage): Promise<void>;
   succeeded(input: { summary: string | null; usage: Usage; result: TaskResult }): Promise<void>;
   failed(input: { failure: Failure; usage: Usage }): Promise<void>;
   cancelled(usage: Usage): Promise<void>;
}

export function ledgerRecorder(ledger: RunLedger, runId: string): TaskRecorder {
   let running = false;
   const ignoreTerminal = (cause: unknown) => {
      if (!(cause instanceof RunTerminal)) throw cause;
   };
   const ensureRunning = async () => {
      if (running) return;
      running = true;
      await ledger.markRunning(runId);
   };
   return {
      started: ensureRunning,
      async message(message) {
         await ensureRunning();
         const write = (() => {
            switch (message.kind) {
               case 'output':
                  return ledger.appendOutput(runId, message.channel, message.text);
               case 'tool.started':
                  return ledger.appendToolStarted(runId, message.toolCallId, message.name);
               case 'tool.completed':
                  return ledger.appendToolCompleted(runId, message.toolCallId, message.succeeded);
               case 'command.started':
                  return ledger.appendCommandStarted(runId, { commandId: message.commandId, command: message.command, cwd: message.cwd });
               case 'command.output':
                  return ledger.appendCommandOutput(runId, { commandId: message.commandId, stream: message.stream, text: message.text });
               case 'command.completed':
                  return ledger.appendCommandCompleted(runId, {
                     commandId: message.commandId, exitCode: message.exitCode, durationMs: message.durationMs, truncated: message.truncated,
                  });
               case 'repository.ready':
                  return ledger.appendRepositoryReady(runId, { repository: message.repository, branch: message.branch, baseCommit: message.baseCommit });
               case 'verified':
                  return ledger.appendVerified(runId, {
                     passed: message.passed, complete: message.complete, durationMs: message.durationMs, results: message.results,
                  });
            }
         })();
         await write.catch(ignoreTerminal);
      },
      // The issue run's result lives in the ledger (summary, result comment,
      // delivery events); only an issue-less task stores `result` on the row.
      async succeeded({ summary, usage }) {
         await ensureRunning();
         await ledger.completeSuccess({ runId, summary, usage });
      },
      async failed({ failure }) {
         await ledger.fail({ runId, failure }).catch(ignoreTerminal);
      },
      async cancelled() {
         await ledger.markCancelled(runId).catch(ignoreTerminal);
      },
   };
}

export function directRecorder(sql: Sql, runId: string): TaskRecorder {
   return {
      async started() {
         await sql`
            UPDATE runs SET status = 'running', dispatch_state = 'streaming',
                   started_at = COALESCE(started_at, now()), dispatch_accepted_at = now(), updated_at = now()
             WHERE id = ${runId} AND status = 'queued'`;
      },
      async message() {
         // No stream to publish on; the result is what the caller waits for.
      },
      async succeeded({ summary, usage, result }) {
         await sql`
            UPDATE runs SET status = 'succeeded', dispatch_state = 'succeeded', summary = ${summary},
                   result = ${sql.json(result as never)},
                   input_tokens = ${usage.inputTokens}, output_tokens = ${usage.outputTokens},
                   total_tokens = ${usage.totalTokens}, completed_at = now(), updated_at = now(),
                   started_at = COALESCE(started_at, now())
             WHERE id = ${runId} AND status IN ('queued', 'running')`;
      },
      async failed({ failure, usage }) {
         await sql`
            UPDATE runs SET status = 'failed', dispatch_state = 'failed',
                   failure_code = ${failure.code}, failure_message = ${failure.message},
                   failure_retryable = ${failure.retryable},
                   input_tokens = ${usage.inputTokens}, output_tokens = ${usage.outputTokens},
                   total_tokens = ${usage.totalTokens}, completed_at = now(), updated_at = now()
             WHERE id = ${runId} AND status IN ('queued', 'running')`;
      },
      async cancelled() {
         await sql`
            UPDATE runs SET status = 'cancelled', dispatch_state = 'cancelled',
                   cancel_completed_at = now(), completed_at = now(), updated_at = now()
             WHERE id = ${runId} AND status IN ('queued', 'running')`;
      },
   };
}
```

- [ ] **Step 4: Implement `delivery.ts`**

```ts
import type { Sql } from '../db/pool.ts';
import type { GitHubClient } from '../integrations/github.ts';
import { parseRepository } from '../agents/checkout.ts';
import { pullRequestBody } from '../agents/repository-run.ts';
import type { VerificationReport } from '../agents/verification.ts';
import type { RunLedger } from '../runs/ledger.ts';
import type { DeliveryPlan } from './envelope-builder.ts';
import type { TaskDelivery, TaskMessage } from './lifecycle.ts';

/**
 * The half of delivery that needs the GitHub App: the runtime committed and
 * pushed the branch; Berry opens the pull request and records the delivery.
 * Called before the run is marked succeeded, while the ledger still accepts
 * events for it.
 */
export async function recordDelivery(deps: {
   sql: Sql;
   ledger: RunLedger;
   github: GitHubClient | null;
   runId: string;
   plan: DeliveryPlan;
   delivery: TaskDelivery;
   summary: string | null;
   verified: Extract<TaskMessage, { kind: 'verified' }> | null;
}): Promise<void> {
   const { plan, delivery } = deps;
   let pullRequest: { number: number; url: string; created: boolean } | null = null;
   if (delivery.committed && plan.mayOpenPullRequest && deps.github) {
      const report: VerificationReport = deps.verified
         ? {
              // The runtime reports each check's verdict, not its output tail.
              results: deps.verified.results.map((r) => ({ ...r, output: '' })),
              passed: deps.verified.passed,
              complete: deps.verified.complete,
              durationMs: deps.verified.durationMs,
           }
         : { results: [], passed: true, complete: true, durationMs: 0 };
      const { owner, name } = parseRepository(plan.fullName);
      const opened = await deps.github.openPullRequest({
         owner,
         name,
         head: plan.branch,
         base: plan.defaultBranch,
         title: `${plan.reference}: ${plan.title}`,
         body: pullRequestBody(deps.summary, report, deps.runId, plan.reference, { mergeRequiresApproval: plan.mergeRequiresApproval }),
      });
      pullRequest = { number: opened.number, url: opened.url, created: opened.created };
   }
   await deps.sql`
      UPDATE runs SET branch = ${plan.branch}, head_commit = ${delivery.commit},
             pull_request_number = ${pullRequest ? pullRequest.number : null}, updated_at = now()
       WHERE id = ${deps.runId}`;
   await deps.ledger.appendDelivered(deps.runId, {
      committed: delivery.committed,
      commit: delivery.commit,
      branch: plan.branch,
      filesChanged: delivery.filesChanged,
      insertions: delivery.insertions,
      deletions: delivery.deletions,
      files: delivery.files,
      pullRequest,
      mergeRequiresApproval: plan.mergeRequiresApproval,
   });
}
```

`VerificationResult` is `{ command, exitCode, passed, durationMs, output, error }` (`server-ts/src/agents/verification.ts:25-36`), so the spread plus `output: ''` is the complete shape.

- [ ] **Step 5: Implement `task-executor.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { nullRunMemory, type RunMemory } from '../agentcore/memory.ts';
import type { GitHubClient } from '../integrations/github.ts';
import type { Executor } from '../runs/dispatcher.ts';
import { RunLedger, type Dispatch, type Failure, type Usage } from '../runs/ledger.ts';
import { postRunResult } from '../runs/result-comment.ts';
import { mintTaskToken, revokeTaskTokens } from './agent-tools/tokens.ts';
import { recordDelivery } from './delivery.ts';
import { loadTask, type EnvelopeBuilder, type TaskRow } from './envelope-builder.ts';
import { LifecycleStreamError, type TaskMessage, type TaskResult } from './lifecycle.ts';
import { directRecorder, ledgerRecorder, type TaskRecorder } from './recorders.ts';
import { RuntimeUnavailable, type RuntimeTarget, type RuntimeTransport } from './transport.ts';

export type UsageRecorder = (
   sql: Sql,
   input: {
      runId: string;
      workspaceId: string;
      agentId: string;
      runtimeId?: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
   }
) => Promise<void>;

export interface TaskOutcome {
   runId: string;
   status: 'succeeded' | 'failed' | 'cancelled';
   summary: string | null;
   usage: Usage;
   failure?: Failure;
   result?: TaskResult;
}

export interface RuntimeTaskExecutorOptions {
   sql: Sql;
   transport: RuntimeTransport;
   builder: EnvelopeBuilder;
   /** The deployment's runtime when a task names none. Null means tasks fail as unconfigured. */
   defaultTarget: RuntimeTarget | null;
   recordUsage: UsageRecorder;
   ledger?: RunLedger;
   memory?: RunMemory;
   gitCredential?: ((workspaceId: string) => Promise<{ username: string; password: string }>) | undefined;
   github?: (token: string) => GitHubClient;
   reviewGate?: { review(runId: string): Promise<unknown> };
   onGateError?: (error: unknown) => void;
   onUsageError?: (error: unknown) => void;
   /** The runtime's maxLifetime: a token never outlives the microVM it was minted for. */
   tokenTtlSeconds?: number;
   clock?: () => Date;
   newId?: () => string;
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: null, currency: null };
const STREAM_ENDED: Failure = {
   code: 'RUNTIME_STREAM_ENDED',
   message: 'The runtime stopped reporting before the task finished.',
   retryable: true,
};

/**
 * The dispatcher's executor, now that the loop is in the runtime.
 *
 * It claims, builds the envelope, invokes, and turns each lifecycle event
 * into the ledger write the in-process executor used to make itself. The
 * ledger stays the only writer of run state; this only reads a stream.
 */
export class RuntimeTaskExecutor implements Executor {
   readonly #o: RuntimeTaskExecutorOptions;
   readonly #ledger: RunLedger;
   readonly #memory: RunMemory;

   constructor(options: RuntimeTaskExecutorOptions) {
      this.#o = options;
      this.#ledger = options.ledger ?? new RunLedger({ sql: options.sql });
      this.#memory = options.memory ?? nullRunMemory();
   }

   async execute(runId: string, signal?: AbortSignal): Promise<TaskOutcome> {
      const { sql } = this.#o;
      const task = await loadTask(sql, runId);
      const dispatch = task.issueId ? await this.#ledger.claimDispatch(runId) : await claimDirect(sql, runId);
      const recorder: TaskRecorder = task.issueId ? ledgerRecorder(this.#ledger, runId) : directRecorder(sql, runId);
      const usage: Usage = { ...ZERO };
      const abort = signal ?? new AbortController().signal;

      const target = await resolveTarget(sql, task.workspaceId, task.runtimeId, this.#o.defaultTarget);
      if (!target) {
         return this.#fail(task, recorder, usage, { code: 'RUNTIME_UNCONFIGURED', message: 'No agent runtime is configured for this workspace.', retryable: false });
      }

      let envelopeSession = '';
      try {
         const token = await mintTaskToken(sql, {
            runId, workspaceId: task.workspaceId, agentId: task.agentId,
            scopes: task.kind === 'completion' ? [] : ['task:read', 'task:write'],
            ttlSeconds: this.#o.tokenTtlSeconds ?? 28_800,
         });
         let built: Awaited<ReturnType<EnvelopeBuilder['build']>>;
         try {
            built = await this.#o.builder.build({ task, dispatch: task.issueId ? (dispatch as Dispatch) : null, token });
         } catch (error) {
            return await this.#fail(task, recorder, usage, {
               code: 'TASK_PREPARATION_FAILED',
               message: error instanceof Error ? error.message : String(error),
               retryable: false,
            });
         }
         const { envelope, delivery, model } = built;
         envelopeSession = envelope.runtimeSessionId;
         await sql`UPDATE runs SET runtime_session_id = ${envelope.runtimeSessionId} WHERE id = ${runId}`;

         let verified: Extract<TaskMessage, { kind: 'verified' }> | null = null;
         for await (const event of this.#o.transport.invoke({ target, envelope, signal: abort })) {
            if (abort.aborted) break;
            if (event.type === 'task.started') await recorder.started();
            else if (event.type === 'task.message') {
               if (event.message.kind === 'verified') verified = event.message;
               await recorder.message(event.message);
            } else if (event.type === 'task.usage') {
               usage.inputTokens += event.usage.inputTokens;
               usage.outputTokens += event.usage.outputTokens;
               usage.totalTokens = usage.inputTokens + usage.outputTokens;
               await this.#o
                  .recordUsage(sql, {
                     runId, workspaceId: task.workspaceId, agentId: task.agentId,
                     ...(target.id ? { runtimeId: target.id } : {}),
                     model: event.usage.model || model,
                     inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens,
                     cacheReadTokens: event.usage.cacheReadTokens, cacheWriteTokens: event.usage.cacheWriteTokens,
                  })
                  .catch((error: unknown) => this.#o.onUsageError?.(error));
            } else if (event.type === 'task.failed') {
               return await this.#fail(task, recorder, usage, event.failure);
            } else if (event.type === 'task.completed') {
               return await this.#succeed(task, recorder, usage, event.result, delivery, verified);
            }
         }
         if (abort.aborted) return await this.#cancel(task, recorder, usage, target, envelopeSession);
         return await this.#fail(task, recorder, usage, STREAM_ENDED);
      } catch (error) {
         if (abort.aborted) return await this.#cancel(task, recorder, usage, target, envelopeSession);
         if (error instanceof RuntimeUnavailable) {
            return await this.#fail(task, recorder, usage, { code: 'RUNTIME_UNAVAILABLE', message: error.message, retryable: true });
         }
         if (error instanceof LifecycleStreamError) {
            return await this.#fail(task, recorder, usage, { code: 'RUNTIME_PROTOCOL', message: error.message, retryable: true });
         }
         throw error;
      } finally {
         await revokeTaskTokens(sql, runId).catch(() => undefined);
      }
   }

   async #succeed(
      task: TaskRow,
      recorder: TaskRecorder,
      usage: Usage,
      result: TaskResult,
      plan: Awaited<ReturnType<EnvelopeBuilder['build']>>['delivery'],
      verified: Extract<TaskMessage, { kind: 'verified' }> | null
   ): Promise<TaskOutcome> {
      const summary = result.text === '' ? null : result.text;
      if (plan && result.delivery) {
         try {
            const credential = this.#o.gitCredential ? await this.#o.gitCredential(task.workspaceId) : null;
            await recordDelivery({
               sql: this.#o.sql,
               ledger: this.#ledger,
               github: credential && this.#o.github ? this.#o.github(credential.password) : null,
               runId: task.runId,
               plan,
               delivery: result.delivery,
               summary,
               verified,
            });
         } catch (error) {
            return this.#fail(task, recorder, usage, {
               code: 'DELIVERY_FAILED',
               message: `The work was pushed but the pull request could not be opened: ${error instanceof Error ? error.message : String(error)}`,
               retryable: false,
            });
         }
      }
      await recorder.succeeded({ summary, usage, result });
      if (task.issueId) {
         if (summary) {
            await this.#memory.record({ agentId: task.agentId, issueId: task.issueId, role: 'ASSISTANT', text: summary, runId: task.runId });
            await postRunResult(this.#o.sql, {
               issueId: task.issueId, agentId: task.agentId, text: result.text, cut: result.truncated,
               occurredAt: (this.#o.clock ?? (() => new Date()))().toISOString(), newId: this.#o.newId ?? randomUUID,
            }).catch(() => null);
         }
         if (this.#o.reviewGate) {
            await this.#o.reviewGate.review(task.runId).catch((error: unknown) => this.#o.onGateError?.(error));
         }
      }
      return { runId: task.runId, status: 'succeeded', summary, usage, result };
   }

   async #fail(task: TaskRow, recorder: TaskRecorder, usage: Usage, failure: Failure): Promise<TaskOutcome> {
      await recorder.failed({ failure, usage });
      if (task.issueId) {
         if (!failure.retryable) {
            await postRunResult(this.#o.sql, {
               issueId: task.issueId, agentId: task.agentId,
               text: `This run failed (${failure.code}). ${failure.message}`, cut: false,
               occurredAt: new Date().toISOString(),
            }).catch(() => null);
         }
         await this.#memory.record({
            agentId: task.agentId, issueId: task.issueId, role: 'ASSISTANT',
            text: `An earlier run failed with ${failure.code}: ${failure.message}`, runId: task.runId,
         });
      }
      return { runId: task.runId, status: 'failed', summary: null, usage, failure };
   }

   async #cancel(task: TaskRow, recorder: TaskRecorder, usage: Usage, target: RuntimeTarget, session: string): Promise<TaskOutcome> {
      // StopRuntimeSession ends a session later runs may have reused; the
      // cold path restores it from the transcript (spec 2.2a).
      if (session) await this.#o.transport.stop({ target, runtimeSessionId: session });
      await recorder.cancelled(usage);
      return { runId: task.runId, status: 'cancelled', summary: null, usage };
   }
}

/** The claim for a task with no issue: the same one-shot transition the ledger makes. */
async function claimDirect(sql: Sql, runId: string): Promise<null> {
   const rows = await sql`
      UPDATE runs SET dispatch_state = 'dispatching', dispatch_version = dispatch_version + 1,
             dispatch_attempted_at = now(), updated_at = now()
       WHERE id = ${runId} AND status = 'queued' AND dispatch_state = 'pending'
       RETURNING id`;
   if (rows.length === 0) throw new Error(`run ${runId} is not claimable`);
   return null;
}

export async function resolveTarget(
   sql: Sql,
   workspaceId: string,
   runtimeId: string | null,
   fallback: RuntimeTarget | null
): Promise<RuntimeTarget | null> {
   if (!runtimeId) return fallback;
   // `agents.runtime_id` is a plain FK; a runtime of another workspace is never used.
   const [row] = await sql`
      SELECT id, kind, driver, arn, qualifier, region, endpoint_url, status FROM agent_runtimes
       WHERE id = ${runtimeId} AND workspace_id = ${workspaceId}`;
   if (!row || row.status === 'disabled') return fallback;
   // The platform row names no target of its own: it is the configured default.
   if (row.kind === 'platform' || (!row.arn && !row.endpoint_url)) {
      return fallback ? { ...fallback, id: row.id as string } : null;
   }
   return {
      id: row.id as string,
      driver: row.driver as RuntimeTarget['driver'],
      arn: (row.arn as string | null) ?? null,
      qualifier: (row.qualifier as string | null) ?? 'DEFAULT',
      region: (row.region as string | null) ?? null,
      endpointUrl: (row.endpoint_url as string | null) ?? null,
   };
}
```

Apply the `lockRun` change in `server-ts/src/runs/ledger.ts:769`. Replace `(SELECT b.workspace_id FROM boards AS b WHERE b.id = r.board_id) AS workspace_id` with `COALESCE(r.workspace_id, (SELECT b.workspace_id FROM boards AS b WHERE b.id = r.board_id)) AS workspace_id`.

- [ ] **Step 6: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/task-executor.test.ts src/runs/ledger.test.ts && pnpm typecheck`
Expected: PASS (with a DB).

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/runtime/recorders.ts server-ts/src/runtime/delivery.ts server-ts/src/runtime/task-executor.ts server-ts/src/runtime/task-executor.test.ts server-ts/src/runs/ledger.ts
git commit -m "feat(server-ts): record the runtime's lifecycle stream in the run ledger

Cancel stops the runtime session; a stream that ends without a verdict
is RUNTIME_STREAM_ENDED and retryable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 16: runCompletion — single model calls become completion tasks

**Files:**
- Create: `server-ts/src/runtime/completion.ts`, `server-ts/src/runtime/completion.test.ts` (DB-gated)
- Modify: `server-ts/src/plans/triage.ts`, `server-ts/src/plans/generator.ts`, `server-ts/src/plans/generator.test.ts`, `server-ts/src/mounts/plans.ts`
- Modify: `server-ts/src/agents/review-gate.ts`
- Modify: `server-ts/src/conversations/responder.ts`, `server-ts/src/conversations/responder.test.ts`, `server-ts/src/mounts/conversations.ts`
- Create: `server-ts/src/agents/runtime/agent-name.ts` (dependency-free `toAgentName`); Modify: `server-ts/src/agents/runtime/agent.ts` (re-export it)
- Modify: `server-ts/src/editor/assist.ts`, `server-ts/src/mounts/editor.ts`
- Delete: `server-ts/src/llm/completion.ts`, `server-ts/src/llm/completion.test.ts`

**Interfaces:**
- Consumes: `enqueueTask` (Task 5); `CompletionSpec`, `TranscriptMessage`; `z.toJSONSchema`.
- Produces:
  - `runCompletion<T>(deps: CompletionDeps, input: { workspaceId: string; purpose: string; system: string; prompt: string; schema: z.ZodType<T>; model?: string; transcript?: TranscriptMessage[]; signal?: AbortSignal }): Promise<T>`. This is the shared contract; the extra fields are optional.
  - `runCompletionTask(deps, input & { schema: z.ZodType | null }): Promise<CompletionResult<unknown>>`, the underlying call.
  - `interface CompletionDeps { sql: Sql; nudge?: () => void; timeoutMs?: number; pollMs?: number; defaultModel?: string }`.
  - `interface CompletionResult<T> { value: T; text: string; inputTokens: number; outputTokens: number; durationMs: number }`. It has the same shape as `llm/completion.ts` had.
  - `class CompletionFailed extends Error { code: string; retryable: boolean }`, `class CompletionInvalid extends Error { raw: string }`.
  - `class RuntimeCompletion` with the old method names:
    - `text(input: Call & { user: string })`
    - `json(input: Call & { user: string })`
    - `structured<S>(input: Call & { user: string; schema: S })`
    - `converse(input: Call & { messages: TranscriptMessage[] })`
    - where `type Call = { workspaceId: string; model: string; system: string; purpose?: string; signal?: AbortSignal }`.
- Callers now pass `workspaceId` (triage: in scope; generator: `generate({ workspaceId, ... })` from `record.workspaceId` in `mounts/plans.ts`; review gate: `material.workspaceId`; responder: `reply({ workspaceId, ... })` from `conversation.workspaceId`; editor: the user's `currentWorkspaceId`).
- Deploy note: completions queue tasks that only `RuntimeTaskExecutor` runs. Task 17 wires it; do not deploy between Task 16 and Task 17.

- [ ] **Step 1: Write the failing test**

`server-ts/src/runtime/completion.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { nullRunMemory } from '../agentcore/memory.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { GitHubClient } from '../integrations/github.ts';
import type { Logger } from '../observability/log.ts';
import { Dispatcher } from '../runs/dispatcher.ts';
import { CompletionFailed, CompletionInvalid, RuntimeCompletion, runCompletion } from './completion.ts';
import { EnvelopeBuilder } from './envelope-builder.ts';
import type { LifecycleEvent } from './lifecycle.ts';
import { RuntimeTaskExecutor } from './task-executor.ts';
import { cleanupFixture, seedFixture, type Fixture } from './test-fixture.ts';
import type { RuntimeTransport } from './transport.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const quiet = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;

describe('runCompletion', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;
   let dispatcher: Dispatcher;
   let reply: (envelopeSystem: string) => LifecycleEvent[] = () => [];
   const systems: string[] = [];

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'completion');
      const transport: RuntimeTransport = {
         async *invoke({ envelope }) {
            systems.push(envelope.completion?.system ?? '');
            for (const event of reply(envelope.completion?.system ?? '')) yield event;
         },
         async stop() {},
      };
      const executor = new RuntimeTaskExecutor({
         sql,
         transport,
         builder: new EnvelopeBuilder({
            sql, publicUrl: 'https://berry.test', defaultModel: 'm', memory: nullRunMemory(), sealer: null,
            github: (token) => new GitHubClient({ token }),
         }),
         defaultTarget: { id: null, driver: 'http', arn: null, qualifier: 'DEFAULT', region: null, endpointUrl: 'http://t' },
         recordUsage: async () => {},
      });
      dispatcher = new Dispatcher({ sql, executor, logger: quiet, concurrency: 4, pollMs: 50 });
      dispatcher.start();
   });
   after(async () => {
      await dispatcher.stop();
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   const deps = () => ({ sql, nudge: () => dispatcher.nudge(), pollMs: 25, timeoutMs: 10_000 });

   test('a structured answer comes back validated against the caller schema', async () => {
      reply = () => [
         { type: 'task.started' },
         { type: 'task.completed', result: { text: '', truncated: false, structured: { label: 'bug' }, delivery: null } },
      ];
      const value = await runCompletion(deps(), {
         workspaceId: fixture!.workspaceId, purpose: 'triage', system: 'Label it', prompt: 'crash on save',
         schema: z.object({ label: z.enum(['bug', 'feature']) }),
      });
      assert.deepEqual(value, { label: 'bug' });
      assert.equal(systems.at(-1), 'Label it');
   });

   test('an answer outside the schema is CompletionInvalid', async () => {
      reply = () => [
         { type: 'task.started' },
         { type: 'task.completed', result: { text: 'nope', truncated: false, structured: { label: 'other' }, delivery: null } },
      ];
      await assert.rejects(
         runCompletion(deps(), {
            workspaceId: fixture!.workspaceId, purpose: 't', system: 's', prompt: 'p',
            schema: z.object({ label: z.enum(['bug', 'feature']) }),
         }),
         CompletionInvalid
      );
   });

   test('a runtime failure is CompletionFailed with its code', async () => {
      reply = () => [{ type: 'task.failed', failure: { code: 'MODEL_THROTTLED', message: 'slow down', retryable: true } }];
      await assert.rejects(
         new RuntimeCompletion(deps()).text({ workspaceId: fixture!.workspaceId, model: 'm', system: 's', user: 'u' }),
         (error: unknown) => error instanceof CompletionFailed && error.code === 'MODEL_THROTTLED' && error.retryable
      );
   });

   test('text and usage come back through the adapter', async () => {
      reply = () => [
         { type: 'task.started' },
         { type: 'task.usage', usage: { model: 'm', inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } },
         { type: 'task.completed', result: { text: 'rewritten', truncated: false, delivery: null } },
      ];
      const result = await new RuntimeCompletion(deps()).text({ workspaceId: fixture!.workspaceId, model: 'm', system: 's', user: 'u' });
      assert.equal(result.value, 'rewritten');
      assert.equal(result.inputTokens, 7);
   });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/completion.test.ts`
Expected (with a DB): FAIL, module not found.

- [ ] **Step 3: Implement `completion.ts`**

```ts
import { z } from 'zod';
import type { Sql } from '../db/pool.ts';
import { enqueueTask } from '../runs/queue.ts';
import type { TranscriptMessage } from './envelope.ts';
import type { CompletionSpec } from './envelope-builder.ts';

/**
 * One model call for the parts of Berry that are not an agent, executed as a
 * `kind: 'completion'` task on the runtime — the only place Bedrock is called
 * from (ADR-0014). It runs as the workspace's protected Orchestrator, so its
 * usage is billed to the workspace like any other task.
 */

export interface CompletionDeps {
   sql: Sql;
   /** Asks the dispatcher to look now rather than at its next poll. */
   nudge?: () => void;
   timeoutMs?: number;
   pollMs?: number;
   defaultModel?: string;
}

export interface CompletionResult<T> {
   value: T;
   text: string;
   inputTokens: number;
   outputTokens: number;
   durationMs: number;
}

export class CompletionFailed extends Error {
   override readonly name = 'CompletionFailed';
   readonly code: string;
   readonly retryable: boolean;
   constructor(failure: { code: string; message: string; retryable: boolean }) {
      super(failure.message);
      this.code = failure.code;
      this.retryable = failure.retryable;
   }
}

export class CompletionInvalid extends Error {
   override readonly name = 'CompletionInvalid';
   readonly raw: string;
   constructor(message: string, raw: string) {
      super(message);
      this.raw = raw;
   }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 200;

export async function runCompletion<T>(
   deps: CompletionDeps,
   input: {
      workspaceId: string;
      purpose: string;
      system: string;
      prompt: string;
      schema: z.ZodType<T>;
      model?: string;
      transcript?: TranscriptMessage[];
      signal?: AbortSignal;
   }
): Promise<T> {
   const result = await runCompletionTask(deps, input);
   return result.value as T;
}

export async function runCompletionTask(
   deps: CompletionDeps,
   input: {
      workspaceId: string;
      purpose: string;
      system: string;
      prompt: string;
      schema: z.ZodType | null;
      model?: string;
      transcript?: TranscriptMessage[];
      signal?: AbortSignal;
   }
): Promise<CompletionResult<unknown>> {
   const started = Date.now();
   const [orchestrator] = await deps.sql`
      SELECT id FROM agents WHERE workspace_id = ${input.workspaceId} AND protected AND archived_at IS NULL`;
   if (!orchestrator) throw new CompletionFailed({ code: 'NO_ORCHESTRATOR', message: 'this workspace has no orchestrator', retryable: false });

   const spec: CompletionSpec = {
      purpose: input.purpose,
      system: input.system,
      jsonSchema: input.schema ? (z.toJSONSchema(input.schema) as Record<string, unknown>) : null,
      model: input.model ?? deps.defaultModel ?? null,
      ...(input.transcript ? { transcript: input.transcript } : {}),
   };
   let runId = '';
   await deps.sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      ({ runId } = await enqueueTask(tx, {
         workspaceId: input.workspaceId,
         agentId: orchestrator.id as string,
         kind: 'completion',
         source: 'completion',
         prompt: input.prompt,
         priority: 10,
      }));
      await tx`UPDATE runs SET completion_spec = ${tx.json(spec as never)} WHERE id = ${runId}`;
   });
   deps.nudge?.();

   const deadline = started + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
   while (true) {
      const [row] = await deps.sql`
         SELECT status::text AS status, result, input_tokens, output_tokens,
                failure_code, failure_message, failure_retryable
           FROM runs WHERE id = ${runId}`;
      const status = row?.status as string | undefined;
      if (status === 'succeeded') {
         const result = (row!.result ?? {}) as { text?: string; structured?: unknown };
         const text = result.text ?? '';
         let value: unknown = text;
         if (input.schema) {
            const parsed = input.schema.safeParse(result.structured);
            if (!parsed.success) throw new CompletionInvalid('the model did not answer in the shape it was asked for', text);
            value = parsed.data;
         }
         return {
            value,
            text,
            inputTokens: Number(row!.input_tokens),
            outputTokens: Number(row!.output_tokens),
            durationMs: Date.now() - started,
         };
      }
      if (status === 'failed') {
         const failure = {
            code: row!.failure_code as string,
            message: (row!.failure_message as string | null) ?? '',
            retryable: Boolean(row!.failure_retryable),
         };
         if (failure.code === 'COMPLETION_INVALID') throw new CompletionInvalid(failure.message, failure.message);
         throw new CompletionFailed(failure);
      }
      if (status === 'cancelled' || input.signal?.aborted || Date.now() > deadline) {
         // Cancelled on the row, so the dispatcher's heartbeat aborts the
         // invoke and stops the runtime session rather than paying for it.
         await deps.sql`
            UPDATE runs SET status = 'cancelled', dispatch_state = 'cancelled', completed_at = now(), updated_at = now()
             WHERE id = ${runId} AND status IN ('queued', 'running')`;
         throw new CompletionFailed({
            code: input.signal?.aborted ? 'COMPLETION_CANCELLED' : 'COMPLETION_TIMEOUT',
            message: 'the completion did not finish in time',
            retryable: !input.signal?.aborted,
         });
      }
      await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? DEFAULT_POLL_MS));
   }
}

type Call = { workspaceId: string; model: string; system: string; purpose?: string; signal?: AbortSignal | undefined };

/** The old `Completion` surface, so callers change their import and add a workspace. */
export class RuntimeCompletion {
   readonly #deps: CompletionDeps;

   constructor(deps: CompletionDeps) {
      this.#deps = deps;
   }

   async text(input: Call & { user: string }): Promise<CompletionResult<string>> {
      const result = await this.#run(input, input.user, null);
      return { ...result, value: result.text };
   }

   async json(input: Call & { user: string }): Promise<CompletionResult<unknown>> {
      return this.structured({ ...input, schema: z.looseObject({}) });
   }

   async structured<S extends z.ZodType>(input: Call & { user: string; schema: S }): Promise<CompletionResult<z.output<S>>> {
      const result = await this.#run(input, input.user, input.schema);
      return result as CompletionResult<z.output<S>>;
   }

   /** A multi-turn exchange ending on the user turn to answer. */
   async converse(input: Call & { messages: TranscriptMessage[] }): Promise<CompletionResult<string>> {
      const last = input.messages.at(-1);
      if (!last || last.role !== 'user') throw new CompletionInvalid('a conversation must end on the user turn to answer', '');
      const result = await this.#run(input, last.text, null, input.messages.slice(0, -1));
      return { ...result, value: result.text };
   }

   #run(input: Call, prompt: string, schema: z.ZodType | null, transcript?: TranscriptMessage[]) {
      return runCompletionTask(this.#deps, {
         workspaceId: input.workspaceId,
         purpose: input.purpose ?? 'completion',
         system: input.system,
         prompt,
         schema,
         model: input.model,
         ...(transcript ? { transcript } : {}),
         ...(input.signal ? { signal: input.signal } : {}),
      });
   }
}
```

- [ ] **Step 4: Migrate the callers**

For each caller, change `import { Completion, ... } from '../llm/completion.ts'` to `import { RuntimeCompletion, ... } from '../runtime/completion.ts'` (keep `CompletionInvalid` / `CompletionResult` names). Replace `Pick<Completion, 'x'>` with `Pick<RuntimeCompletion, 'x'>`, and remove each caller's fallback `new Completion({ region, ... })`. The `completion` option becomes required, and the `region` option is removed from each caller's options interface. Then add `workspaceId` at every call:

- `server-ts/src/plans/triage.ts:189-196`: add `workspaceId,` (already in scope as the method's parameter) and `purpose: 'triage',` to the `.structured({...})` argument.
- `server-ts/src/plans/generator.ts`:
  - add `workspaceId: string;` to `generate`'s input type (line 260);
  - add `workspaceId: string;` to `#call`'s input type (line 434) and pass `workspaceId: input.workspaceId, purpose: input.role,` into `.structured({...})`;
  - pass `workspaceId: input.workspaceId` from `generate` into every `this.#call({...})` (lines 278, and inside `#repair` / `#critique`, whose signatures gain a `workspaceId: string` first parameter).
  - In `server-ts/src/mounts/plans.ts:412` and `:480`, pass `workspaceId: record.workspaceId` to `options.generator!.generate({...})`. `PlanRecord.workspaceId` is defined in `plans/repository.ts`.
  - In `server-ts/src/plans/generator.test.ts`, change the import to `../runtime/completion.ts` and add `workspaceId: 'w'` to each `generate({...})` call.
- `server-ts/src/agents/review-gate.ts:173`: add `workspaceId: material.workspaceId, purpose: 'review_gate',`.
- `server-ts/src/conversations/responder.ts`: `reply(input)` gains `workspaceId: string`, passed to `.converse({...})` with `purpose: 'chat_reply'`. `toMessages` now returns `TranscriptMessage[]` (`{ role: 'user' | 'assistant', text }`), and the file no longer imports `@strands-agents/sdk`. It also value-imports `toAgentName` from `../agents/runtime/agent.ts` (line 5), which loads `@strands-agents/sdk` into the server process through `agent.ts`: move the `toAgentName` function unchanged (with its doc comment) into the new `server-ts/src/agents/runtime/agent-name.ts`, which imports nothing; in `agent.ts` replace it with `export { toAgentName } from './agent-name.ts';` and use it there via `import { toAgentName } from './agent-name.ts';`; import it in `responder.ts` from `../agents/runtime/agent-name.ts`. The transitive rule of `scripts/check-no-model-in-server.py` (Task 1) is what proves this in Task 17. Update `responder.test.ts` to assert on `.role` / `.text`. In `server-ts/src/mounts/conversations.ts:118`, pass `workspaceId: conversation.workspaceId`.
- `server-ts/src/editor/assist.ts`: `rewrite(input)` gains `workspaceId: string`, passed with `purpose: 'editor_assist'`. In `server-ts/src/mounts/editor.ts:57`, pass `workspaceId: currentWorkspace(context.get('user').currentWorkspaceId)`, where a missing workspace throws `ApiError.notFound('Workspace')` (add the same `currentWorkspace` helper that `mounts/agents.ts:331` defines).
- `server-ts/src/index.ts:229-236`: replace the `Completion` construction with:

```ts
const completion = new RuntimeCompletion({
   sql,
   // Declared further down; called only at request time, after boot.
   nudge: () => dispatcher?.nudge(),
   defaultModel: config.agents?.defaultModel ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
});
```

and remove the `region:` option from the `PlanGenerator`, `PlanTriage`, `ConversationResponder` and `EditorAssist` constructions.

Delete the old module: `git rm server-ts/src/llm/completion.ts server-ts/src/llm/completion.test.ts`.

- [ ] **Step 5: Run everything touched**

Run: `cd server-ts && pnpm typecheck && node --test --experimental-strip-types src/runtime/completion.test.ts src/plans/*.test.ts src/agents/review-gate.test.ts src/conversations/*.test.ts`
Expected: typecheck clean (except `src/llm/credential-plumbing.test.ts` if it imports the deleted file — delete it too now: `git rm server-ts/src/llm/credential-plumbing.test.ts`), tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A server-ts/src/runtime/completion.ts server-ts/src/runtime/completion.test.ts server-ts/src/plans server-ts/src/agents/review-gate.ts server-ts/src/conversations server-ts/src/editor server-ts/src/mounts/plans.ts server-ts/src/mounts/editor.ts server-ts/src/mounts/conversations.ts server-ts/src/index.ts server-ts/src/llm
git commit -m "feat(server-ts): run planner, triage, review, chat and editor calls as completion tasks

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Cut-over — the server dispatches to the runtime and holds no model client

**Files:**
- Modify: `server-ts/src/config/config.ts`, `server-ts/src/config/config.test.ts` (new `runtime` section)
- Modify: `server-ts/src/index.ts` (composition root)
- Move: `server-ts/src/agents/command-tool.ts` → `server-ts/src/agents/runtime/command-tool.ts` (+ `command-tool.test.ts`)
- Move: `server-ts/src/agents/media-tools.ts` → `server-ts/src/agents/runtime/tools/media.ts` (+ test)
- Move: `server-ts/src/observability/telemetry.ts` → `server-ts/src/agents/runtime/telemetry.ts`
- Modify: `server-ts/src/agents/runtime/container/handler.ts`, `main.ts`, `remote-tools.ts`, `emitter.ts`, `closure.test.ts`
- Delete: `server-ts/src/agents/executor.ts`, `executor.test.ts`, `executor-loop.test.ts`, `tools.ts`, `collect-file.test.ts`
- Modify: `server-ts/SCOPE.md`, `AGENTS.md` ("What Berry is", "Runs are dispatched in process")

**Interfaces:**
- Consumes: everything above; C's `recordTaskUsage` from `server-ts/src/usage/record.ts`. **C merges first on day 1.** If it has not merged when this task starts, rebase onto C's branch rather than stubbing it.
- Produces:
  - `Config.runtime: RuntimeConfig`, where `interface RuntimeConfig { agentRuntimeUrl: string | null; defaultModel: string; concurrency: number; tokenTtlSeconds: number }`, read from `BERRY_AGENT_RUNTIME_URL`, `BERRY_AGENT_DEFAULT_MODEL`, `BERRY_RUN_CONCURRENCY` and `BERRY_TASK_TOKEN_TTL_SECONDS` (default 28800).
  - `index.ts` builds `RuntimeTaskExecutor`. Its default target is the configured ARN (`BERRY_AGENTCORE_RUNTIME_ARN`), else `BERRY_AGENT_RUNTIME_URL`, else null. The dispatcher runs whenever a default target exists or any workspace registered a runtime.
  - `agentToolMounts` is registered.
  - `/api/v1/config`'s `agentExecution` becomes `executor !== null`, which is unchanged.
  - `python3 scripts/check-no-model-in-server.py` exits 0.

- [ ] **Step 1: Write the failing config test**

Append to `server-ts/src/config/config.test.ts`, which already imports `loadConfig` and defines the minimal valid env as `const base = {...}` at line 14:

```ts
test('the runtime section reads the local runtime URL and token lifetime', () => {
   const config = loadConfig({
      ...base,
      BERRY_AGENT_RUNTIME_URL: 'http://agent-runtime:8080/',
      BERRY_TASK_TOKEN_TTL_SECONDS: '3600',
   });
   assert.equal(config.runtime.agentRuntimeUrl, 'http://agent-runtime:8080');
   assert.equal(config.runtime.tokenTtlSeconds, 3600);
   assert.equal(config.runtime.concurrency, 2);
});

test('the runtime section needs no Bedrock region: the server calls no model', () => {
   const config = loadConfig({ ...base, BERRY_BEDROCK_REGION: '', AWS_REGION: '' });
   assert.equal(config.runtime.defaultModel, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
});
```

Run: `cd server-ts && node --test --experimental-strip-types src/config/config.test.ts`
Expected: FAIL (`config.runtime` undefined).

- [ ] **Step 2: Implement the config section**

In `server-ts/src/config/config.ts`: add `runtime: RuntimeConfig;` to `Config`, then add

```ts
/** Where tasks run and how they are bounded. Independent of Bedrock: the server calls no model. */
export interface RuntimeConfig {
   /** The runtime image on a URL (local Compose), used when no AgentCore runtime ARN is set. */
   agentRuntimeUrl: string | null;
   /** Used when an agent row and its profile name no model. */
   defaultModel: string;
   /** How many tasks this process dispatches at once. */
   concurrency: number;
   /** A task token's lifetime: the runtime's maxLifetime. */
   tokenTtlSeconds: number;
}

function runtime(env: NodeJS.ProcessEnv): RuntimeConfig {
   const url = (env.BERRY_AGENT_RUNTIME_URL ?? '').trim().replace(/\/+$/, '');
   return {
      agentRuntimeUrl: /^https?:\/\//.test(url) ? url : null,
      defaultModel: (env.BERRY_AGENT_DEFAULT_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0').trim(),
      concurrency: positive(env.BERRY_RUN_CONCURRENCY, 2),
      tokenTtlSeconds: Math.min(positive(env.BERRY_TASK_TOKEN_TTL_SECONDS, 28_800), 28_800),
   };
}
```

and `runtime: runtime(env),` in the object `loadConfig` returns (next to `agents: agents(env),`). `positive` is the existing helper used by `agents()`.

Run the config test: PASS.

- [ ] **Step 3: Move the remaining model-SDK modules into the runtime tree**

```bash
cd server-ts
git mv src/agents/command-tool.ts src/agents/runtime/command-tool.ts
git mv src/agents/command-tool.test.ts src/agents/runtime/command-tool.test.ts
mkdir -p src/agents/runtime/tools
git mv src/agents/media-tools.ts src/agents/runtime/tools/media.ts
git mv src/agents/media-tools.test.ts src/agents/runtime/tools/media.test.ts
git mv src/observability/telemetry.ts src/agents/runtime/telemetry.ts
git rm -q src/agents/executor.ts src/agents/executor.test.ts src/agents/executor-loop.test.ts src/agents/tools.ts src/agents/collect-file.test.ts
```

Fix relative imports in the moved files:
- `runtime/command-tool.ts`: `../execution/driver.ts` → `../../execution/driver.ts`, `../runs/ledger.ts` → `../../runs/ledger.ts`.
- `runtime/tools/media.ts`: `./runtime/model.ts` → `../model.ts`.
- `runtime/telemetry.ts`: `./log.ts` → `../../observability/log.ts`.

Then repoint the importers:
- `container/handler.ts`, `container/remote-tools.ts`, `container/emitter.ts`: `../../command-tool.ts` → `../command-tool.ts`.
- In `closure.test.ts`, drop `'src/agents/command-tool.ts'` from `CONTAINER_ALLOWED_FILES`.

Run `grep -rn "agents/command-tool\|media-tools\|observability/telemetry\|agents/tools.ts\|agents/executor" src` and fix every remaining hit.

Wire media tools into the container. In `container/handler.ts`, after `...remote`, add the media tools, saving through Berry:

```ts
         ...mediaTools({
            region: deps.region,
            credentials: null,
            runId: envelope.runId,
            video: deps.videoOutput,
            save: async ({ path, bytes, contentType }) => {
               await callAttach(api, { path, base64: Buffer.from(bytes).toString('base64'), contentType });
            },
         }),
```

with `import { mediaTools, type VideoOutput } from '../tools/media.ts';`, `videoOutput?: VideoOutput | undefined` added to `HandlerDeps`, and an exported helper in `remote-tools.ts`:

```ts
export async function callAttach(api: BerryApi, input: { path: string; base64: string; contentType: string }): Promise<void> {
   const response = await (api.fetch ?? fetch)(`${base(api)}/api/v1/agent-tools/attach_file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
   });
   if (!response.ok) throw new Error(`Berry refused the file (${response.status})`);
}
```

In `container/main.ts`, add `videoOutput: /^s3:\/\//.test(env.BERRY_MEDIA_VIDEO_S3_URI ?? '') ? { s3Uri: (env.BERRY_MEDIA_VIDEO_S3_URI ?? '').trim() } : undefined,` to the deps, and call `await setupTelemetry(logger)` from `../telemetry.ts` before `listen`. Use a console-backed logger: `const logger = { info: console.log, error: console.error, warn: console.warn, debug: () => {} } as unknown as Logger;` with `import type { Logger } from '../../../observability/log.ts';`, since the type import is erased. The closure test must still pass. If `observability/log.ts` is value-imported anywhere in the closure, keep the logger local.

- [ ] **Step 4: Rewire the composition root**

In `server-ts/src/index.ts`:
- remove the imports of `RunExecutor`, `setupTelemetry` and `createExecutionDriver` (keep `createExecutionDriver` only if something else still uses `execution`; the boot log's `executionDriver` line is replaced below).
- add:

```ts
import { agentToolMounts } from './runtime/agent-tools/mount.ts';
import { agentCoreTransport } from './runtime/agentcore-transport.ts';
import { EnvelopeBuilder } from './runtime/envelope-builder.ts';
import { httpTransport } from './runtime/http-transport.ts';
import { RuntimeTaskExecutor } from './runtime/task-executor.ts';
import { routingTransport, type RuntimeTarget } from './runtime/transport.ts';
import { RuntimeCompletion } from './runtime/completion.ts';
import { recordTaskUsage } from './usage/record.ts';
import { nullRunMemory } from './agentcore/memory.ts';
```

- delete the `await setupTelemetry(logger);` line (tracing of model calls now happens in the runtime image).
- replace the whole `const executor = config.agents && storage ? new RunExecutor({...}) : null;` block with:

```ts
/**
 * Where tasks run (ADR-0014). The configured AgentCore Runtime by ARN when
 * there is one, else the same image on a URL (the local agent-runtime
 * service). A workspace's registered runtimes override it per agent.
 */
const defaultTarget: RuntimeTarget | null = config.agentCore?.runtimeArn
   ? {
        id: null,
        driver: 'agentcore',
        arn: config.agentCore.runtimeArn,
        qualifier: 'DEFAULT',
        region: config.agentCore.region,
        endpointUrl: null,
     }
   : config.runtime.agentRuntimeUrl
     ? { id: null, driver: 'http', arn: null, qualifier: 'DEFAULT', region: null, endpointUrl: config.runtime.agentRuntimeUrl }
     : null;

const transport = routingTransport({
   agentcore: config.agentCore
      ? agentCoreTransport({
           region: config.agentCore.region,
           ...(config.agentCore.credentials ? { credentials: config.agentCore.credentials } : {}),
        })
      : null,
   http: httpTransport(),
});

const executor = defaultTarget
   ? new RuntimeTaskExecutor({
        sql,
        transport,
        defaultTarget,
        recordUsage: recordTaskUsage,
        builder: new EnvelopeBuilder({
           sql,
           publicUrl: config.integrations.publicUrl ?? `http://${config.apiAddr.host}:${config.apiAddr.port}`,
           defaultModel: config.runtime.defaultModel,
           memory: runMemory ?? nullRunMemory(),
           sealer: config.integrationKey ? sealerFromKey(config.integrationKey) : null,
           ...(scm.provisioning ? { gitCredential: scm.gitCredential } : {}),
           github: (token) => new GitHubClient({ token }),
        }),
        memory: runMemory ?? nullRunMemory(),
        ...(scm.provisioning ? { gitCredential: scm.gitCredential } : {}),
        github: (token) => new GitHubClient({ token }),
        ...(reviewGate ? { reviewGate } : {}),
        onGateError: (error) =>
           logger.error('peer review failed', { error: error instanceof Error ? error.message : String(error) }),
        onUsageError: (error) =>
           logger.error('usage was not recorded', { error: error instanceof Error ? error.message : String(error) }),
        tokenTtlSeconds: config.runtime.tokenTtlSeconds,
     })
   : null;
```

- change the `reviewGate` guard from `config.agents && completion` to `completion` and its `defaultModel: config.agents.defaultModel` to `config.runtime.defaultModel`. Apply the same change to the planner, triage, responder and editor constructions: gate on `executor` (a completion needs something to run it) and read `config.runtime.defaultModel`. The planner's `maxRepairs` / `maxCriticRounds` and the gate's `maxAttempts` stay on `config.agents` when present, with fallbacks `2`, `1` and `2`.
- `const dispatcher = executor ? new Dispatcher({ sql, executor, logger, concurrency: config.runtime.concurrency }) : null;`
- register the tool API next to the other mounts: `registry.registerAll(agentToolMounts({ sql, storage, issues }));`
- in the boot log replace `executionDriver: execution.name,` with `agentRuntime: defaultTarget ? (defaultTarget.driver === 'agentcore' ? defaultTarget.arn : defaultTarget.endpointUrl) : 'none',` and `runDispatch` with `dispatcher ? `${config.runtime.concurrency} at a time` : 'off'`.
- `ModelCatalog` stays (Bedrock control plane, allowlisted in the check).

- [ ] **Step 5: Prove the server holds no model client**

Run:
```bash
python3 scripts/check-no-model-in-server.py
cd server-ts && pnpm typecheck && pnpm test
grep -rn "@strands-agents\|client-bedrock-runtime" src --include=*.ts -l | grep -v "^src/agents/runtime/" || echo "no model SDK outside agents/runtime"
```
Expected: the check prints `no model SDK outside server-ts/src/agents/runtime/` and exits 0; typecheck and the full suite pass; the grep prints the "no model SDK" line.

Update docs:
- `AGENTS.md`, "What Berry is": replace "agents run in-process on the Strands Agents SDK (...)" with "agents run in an AgentCore Runtime container on the Strands Agents SDK; Berry is the control plane ([ADR-0014](docs/adr/0014-agentcore-runtime-control-plane.md))". Rewrite the "Runs are dispatched in process" paragraph to say that the dispatcher claims queued tasks and invokes the runtime with a task envelope via `InvokeAgentRuntime` (or the local `agent-runtime` service), and that the runtime's lifecycle stream is written to the ledger.
- `server-ts/SCOPE.md`: add `/api/v1/agent-tools` to the Served block, noting that it is task-token auth only.

- [ ] **Step 6: Local end-to-end smoke (docker)**

Run: `docker compose up -d --build agent-runtime berry-api` then assign an issue to an agent in the UI (or `POST /api/v1/issues/{ref}/runs`) and watch `docker compose logs -f agent-runtime berry-api`.
Expected: berry-api logs `run finished { status: 'succeeded' }`; the run stream in the UI shows output and tool rows; `docker compose exec agent-runtime curl -s localhost:8080/ping` returns `Healthy` afterwards; a second run on the same issue continues the conversation (the model is told what it said in the first run).

- [ ] **Step 7: Commit**

```bash
git add -A server-ts/src server-ts/SCOPE.md AGENTS.md
git commit -m "feat(server-ts): dispatch runs to the AgentCore Runtime; the server holds no model client

The in-process executor, its tools and the completion client are gone;
scripts/check-no-model-in-server.py now passes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 18: Runtimes and runtime profiles — API, platform sync, health, lifecycle

**Files:**
- Create: `server-ts/src/runtime/runtimes.ts` (`RuntimeRepository`, `syncPlatformRuntime`)
- Create: `server-ts/src/runtime/runtime-control.ts`, `runtime-control.test.ts`
- Create: `server-ts/src/mounts/runtimes.ts`, `server-ts/src/mounts/runtimes.test.ts` (DB-gated, includes cross-tenant cases)
- Modify: `server-ts/src/index.ts` (register the mount, call `syncPlatformRuntime` at boot)
- Modify: `server-ts/SCOPE.md` (add `/api/v1/runtimes` to Served)

**Interfaces:**
- Consumes: `resolveScoped` from `src/mounts/shared.ts`; `requireSession`; `Sealer`; `GetAgentRuntimeCommand` and `UpdateAgentRuntimeCommand` from `@aws-sdk/client-bedrock-agentcore-control`. `UpdateAgentRuntimeRequest` requires `agentRuntimeId`, `agentRuntimeArtifact` and `roleArn`, and accepts `networkConfiguration` and `lifecycleConfiguration`; `GetAgentRuntimeResponse` returns all of them.
- Produces:
  - `syncPlatformRuntime(sql, target: RuntimeTarget | null): Promise<void>`, run at boot. It upserts one `kind='platform'` row per workspace naming the configured target, and new workspaces receive theirs lazily via `enqueueTask`'s fallback: `resolveRuntimeId` returns null, so tasks use the `defaultTarget`.
  - `lifecycleFor(runtime: { idleTimeoutS: number; maxLifetimeS: number }, profile: { idleTimeoutS: number | null } | null): { idleRuntimeSessionTimeout: number; maxLifetime: number }`, clamped to 60..28800 with the idle timeout at most `maxLifetime`.
  - `applyLifecycle(client, arn, lifecycle): Promise<void>` (Get then Update, copying the required fields).
  - `interface RuntimeView { id; name; kind; driver; arn; endpointUrl; qualifier; region; status; lastHealthAt; lastHealthError; concurrencyLimit; visibility; idleTimeoutS; maxLifetimeS; isDefault; activeRuns: number }`.
  - `interface ProfileView { id; runtimeId; name; envKeys: string[]; modelDefault; timeoutS; maxConcurrency; idleTimeoutS }`. Env values are never returned.
  - `runtimeMounts({ sessions, sql, sealer, health }): Mount[]` at `/api/v1/runtimes`, scoped to the caller's current workspace:
    - `GET /` → `{ nodes: RuntimeView[] }`.
    - `POST /` → create a custom runtime `{ name, driver, arn?, endpointUrl?, qualifier?, region?, concurrencyLimit?, visibility?, idleTimeoutS? }`; requires `settings.write` (owner and admin; `workspace.admin` is not a `Permission` in `identity/roles.ts`).
    - `GET /:id` → `RuntimeView & { activity: Array<{ day: string; runs: number; failed: number }> }`, covering 30 days.
    - `PATCH /:id` → the same fields plus `isDefault` and `status: 'active' | 'disabled'`.
    - `DELETE /:id` → 409 `RUNTIME_PROTECTED` for a platform row.
    - `POST /:id/health` → runs `health(target)` and stores `last_health_at` / `status` / `last_health_error`.
    - `GET /:id/profiles`, `POST /:id/profiles` (`{ name, env?: Record<string,string>, modelDefault?, timeoutS?, maxConcurrency?, idleTimeoutS? }`), `PATCH /:id/profiles/:profileId`, `DELETE /:id/profiles/:profileId`.
    - `PUT /:id/agents/:agentId` → bind an agent (and optionally `{ profileId }`); `DELETE /:id/agents/:agentId` unbinds.
  - A `health` dependency, `(target: RuntimeTarget) => Promise<void>`. In production it is `agentCoreRuntimeDriver({...}).health()` for AgentCore targets and `fetch(`${endpointUrl}/ping`)` for http targets.
  - Usage panels (daily, by agent, by hour) are C's endpoints. The detail page embeds them when C's routes exist (Task 19).

- [ ] **Step 1: Write the failing lifecycle test**

`server-ts/src/runtime/runtime-control.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetAgentRuntimeCommand, UpdateAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { applyLifecycle, lifecycleFor } from './runtime-control.ts';

test('the default lifecycle is one idle hour inside an eight-hour life', () => {
   assert.deepEqual(lifecycleFor({ idleTimeoutS: 3600, maxLifetimeS: 28800 }, null), {
      idleRuntimeSessionTimeout: 3600,
      maxLifetime: 28800,
   });
});

test('a profile may change the idle timeout, never past the life or 28800 s', () => {
   assert.equal(lifecycleFor({ idleTimeoutS: 3600, maxLifetimeS: 28800 }, { idleTimeoutS: 7200 }).idleRuntimeSessionTimeout, 7200);
   assert.equal(lifecycleFor({ idleTimeoutS: 3600, maxLifetimeS: 1800 }, { idleTimeoutS: 7200 }).idleRuntimeSessionTimeout, 1800);
   assert.equal(lifecycleFor({ idleTimeoutS: 3600, maxLifetimeS: 99999 }, null).maxLifetime, 28800);
});

test('applying a lifecycle reads the runtime and writes it back with only the lifecycle changed', async () => {
   const sent: unknown[] = [];
   const client = {
      send: async (command: unknown) => {
         sent.push(command);
         if (command instanceof GetAgentRuntimeCommand) {
            return {
               agentRuntimeId: 'berry-abc',
               agentRuntimeArtifact: { containerConfiguration: { containerUri: 'x' } },
               roleArn: 'arn:aws:iam::1:role/r',
               networkConfiguration: { networkMode: 'PUBLIC' },
               lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
            };
         }
         return {};
      },
   };
   await applyLifecycle(client as never, 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/berry-abc', {
      idleRuntimeSessionTimeout: 3600,
      maxLifetime: 28800,
   });
   const update = sent[1];
   assert.ok(update instanceof UpdateAgentRuntimeCommand);
   assert.equal(update.input.agentRuntimeId, 'berry-abc');
   assert.equal(update.input.roleArn, 'arn:aws:iam::1:role/r');
   assert.deepEqual(update.input.lifecycleConfiguration, { idleRuntimeSessionTimeout: 3600, maxLifetime: 28800 });
});
```

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/runtime-control.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement `runtime-control.ts`**

```ts
import {
   BedrockAgentCoreControlClient,
   GetAgentRuntimeCommand,
   UpdateAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

/**
 * A runtime's session lifecycle (spec 2.2a): idle sessions reaped after an
 * hour by default, no session older than eight hours. AgentCore sets this per
 * runtime, not per session, so a profile's idle timeout is applied to the
 * runtime the profile belongs to.
 */
const MIN_S = 60;
const MAX_S = 28_800;

export function lifecycleFor(
   runtime: { idleTimeoutS: number; maxLifetimeS: number },
   profile: { idleTimeoutS: number | null } | null
): { idleRuntimeSessionTimeout: number; maxLifetime: number } {
   const clamp = (value: number) => Math.min(MAX_S, Math.max(MIN_S, Math.round(value)));
   const maxLifetime = clamp(runtime.maxLifetimeS);
   const idle = clamp(profile?.idleTimeoutS ?? runtime.idleTimeoutS);
   return { idleRuntimeSessionTimeout: Math.min(idle, maxLifetime), maxLifetime };
}

/** `…:runtime/<id>` → `<id>`. */
function runtimeIdOf(arn: string): string {
   const id = arn.split('/').at(-1);
   if (!id) throw new Error(`not an AgentCore runtime ARN: ${arn}`);
   return id;
}

/**
 * Writes the lifecycle onto a deployed runtime. `UpdateAgentRuntime` replaces
 * the definition, so the required fields are read back first and sent
 * unchanged; only the lifecycle differs.
 */
export async function applyLifecycle(
   client: Pick<BedrockAgentCoreControlClient, 'send'>,
   arn: string,
   lifecycle: { idleRuntimeSessionTimeout: number; maxLifetime: number }
): Promise<void> {
   const agentRuntimeId = runtimeIdOf(arn);
   const current = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
   await client.send(
      new UpdateAgentRuntimeCommand({
         agentRuntimeId,
         agentRuntimeArtifact: current.agentRuntimeArtifact,
         roleArn: current.roleArn,
         ...(current.networkConfiguration ? { networkConfiguration: current.networkConfiguration } : {}),
         ...(current.protocolConfiguration ? { protocolConfiguration: current.protocolConfiguration } : {}),
         ...(current.environmentVariables ? { environmentVariables: current.environmentVariables } : {}),
         ...(current.requestHeaderConfiguration ? { requestHeaderConfiguration: current.requestHeaderConfiguration } : {}),
         ...(current.authorizerConfiguration ? { authorizerConfiguration: current.authorizerConfiguration } : {}),
         ...(current.filesystemConfigurations ? { filesystemConfigurations: current.filesystemConfigurations } : {}),
         lifecycleConfiguration: lifecycle,
      })
   );
}
```

Run the test → PASS.

- [ ] **Step 3: Write the failing mount test**

`server-ts/src/mounts/runtimes.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { cleanupFixture, seedFixture, type Fixture } from '../runtime/test-fixture.ts';
import { runtimeMounts } from './runtimes.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 7).toString('base64');

describe('/api/v1/runtimes', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let mine: Fixture | null = null;
   let theirs: Fixture | null = null;
   let token = '';
   let theirRuntime = '';
   const healthChecked: string[] = [];

   before(async () => {
      sql = openDatabase({ url: url! });
      mine = await seedFixture(sql, 'rt-a');
      theirs = await seedFixture(sql, 'rt-b');
      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      await sql`UPDATE users SET current_workspace_id = ${mine.workspaceId} WHERE id = ${mine.userId}`;
      ({ token } = await sessions.issueForUser(mine.userId));
      const [row] = await sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url)
         VALUES (${theirs.workspaceId}, 'theirs', 'custom', 'http', 'http://x') RETURNING id`;
      theirRuntime = row!.id as string;
      const registry = new Registry();
      registry.registerAll(
         runtimeMounts({
            sessions, sql, sealer: sealerFromKey(KEY),
            health: async (target) => void healthChecked.push(target.endpointUrl ?? target.arn ?? ''),
         })
      );
      app = createApp(registry);
   });
   after(async () => {
      await cleanupFixture(sql, mine);
      await cleanupFixture(sql, theirs);
      await closeDatabase(sql);
   });

   const call = (path: string, init: RequestInit = {}) =>
      app.request(`/api/v1/runtimes${path}`, {
         ...init,
         headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });

   test('an owner registers a runtime and sees it listed', async () => {
      const created = await call('', {
         method: 'POST',
         body: JSON.stringify({ name: 'Team runtime', driver: 'agentcore', arn: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/team-x', concurrencyLimit: 2 }),
      });
      assert.equal(created.status, 201);
      const list = (await (await call('')).json()) as { nodes: Array<{ name: string; idleTimeoutS: number; maxLifetimeS: number }> };
      const found = list.nodes.find((node) => node.name === 'Team runtime');
      assert.ok(found);
      assert.equal(found.idleTimeoutS, 3600);
      assert.equal(found.maxLifetimeS, 28800);
   });

   test('profile env is sealed at rest and never returned', async () => {
      const list = (await (await call('')).json()) as { nodes: Array<{ id: string }> };
      const runtimeId = list.nodes[0]!.id;
      const created = await call(`/${runtimeId}/profiles`, {
         method: 'POST',
         body: JSON.stringify({ name: 'default', env: { API_KEY: 'hunter2' }, idleTimeoutS: 7200 }),
      });
      assert.equal(created.status, 201);
      const text = await (await call(`/${runtimeId}/profiles`)).text();
      assert.equal(text.includes('hunter2'), false);
      assert.ok(text.includes('API_KEY'));
      const [row] = await sql`SELECT env_sealed FROM runtime_profiles WHERE name = 'default' AND workspace_id = ${mine!.workspaceId}`;
      assert.equal(Buffer.from(row!.env_sealed as Buffer).toString('utf8').includes('hunter2'), false);
   });

   test('an idle timeout past eight hours is refused', async () => {
      const response = await call('', { method: 'POST', body: JSON.stringify({ name: 'x', driver: 'http', endpointUrl: 'http://y', idleTimeoutS: 28801 }) });
      assert.equal(response.status, 400);
   });

   test('a health check records its outcome', async () => {
      const list = (await (await call('')).json()) as { nodes: Array<{ id: string }> };
      const response = await call(`/${list.nodes[0]!.id}/health`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      assert.equal(healthChecked.length, 1);
   });

   test("another workspace's runtime is a 404 to read, change or delete", async () => {
      assert.equal((await call(`/${theirRuntime}`)).status, 404);
      assert.equal((await call(`/${theirRuntime}`, { method: 'PATCH', body: JSON.stringify({ name: 'mine now' }) })).status, 404);
      assert.equal((await call(`/${theirRuntime}`, { method: 'DELETE' })).status, 404);
      const [row] = await sql`SELECT name FROM agent_runtimes WHERE id = ${theirRuntime}`;
      assert.equal(row!.name, 'theirs');
   });

   test('binding an agent from another workspace is a 404', async () => {
      const list = (await (await call('')).json()) as { nodes: Array<{ id: string }> };
      const response = await call(`/${list.nodes[0]!.id}/agents/${theirs!.agentId}`, { method: 'PUT', body: '{}' });
      assert.equal(response.status, 404);
   });

   test("binding my agent to another workspace's profile is a 404 and binds nothing", async () => {
      const [profile] = await sql`
         INSERT INTO runtime_profiles (workspace_id, runtime_id, name)
         VALUES (${theirs!.workspaceId}, ${theirRuntime}, 'their profile') RETURNING id`;
      const list = (await (await call('')).json()) as { nodes: Array<{ id: string }> };
      const response = await call(`/${list.nodes[0]!.id}/agents/${mine!.agentId}`, {
         method: 'PUT',
         body: JSON.stringify({ profileId: profile!.id }),
      });
      assert.equal(response.status, 404);
      const [agent] = await sql`SELECT runtime_profile_id FROM agents WHERE id = ${mine!.agentId}`;
      assert.equal(agent!.runtime_profile_id, null);
   });

   test('without a session nothing answers', async () => {
      assert.equal((await app.request('/api/v1/runtimes')).status, 401);
   });
});
```

`SessionService.issueForUser(userId)` is the helper `cross-tenant-leakage.test.ts:180` uses to mint `u1Token`; `AuthUser.currentWorkspaceId` (`auth/sessions.ts:39`) is read from `users.current_workspace_id`. Confirm the column once with `grep -n "current_workspace_id" server-ts/src/auth/sessions.ts`.

- [ ] **Step 4: Implement `runtimes.ts` and the mount**

`server-ts/src/runtime/runtimes.ts`:

```ts
import type { Sql } from '../db/pool.ts';
import type { Sealer } from '../integrations/sealing.ts';
import type { RuntimeTarget } from './transport.ts';

export interface RuntimeView {
   id: string;
   name: string;
   kind: 'platform' | 'custom';
   driver: 'agentcore' | 'http';
   arn: string | null;
   endpointUrl: string | null;
   qualifier: string;
   region: string | null;
   status: 'active' | 'unreachable' | 'disabled';
   lastHealthAt: string | null;
   lastHealthError: string | null;
   concurrencyLimit: number | null;
   visibility: 'private' | 'workspace';
   idleTimeoutS: number;
   maxLifetimeS: number;
   isDefault: boolean;
   activeRuns: number;
}

export interface ProfileView {
   id: string;
   runtimeId: string;
   name: string;
   envKeys: string[];
   modelDefault: string | null;
   timeoutS: number | null;
   maxConcurrency: number | null;
   idleTimeoutS: number | null;
}

export interface RuntimeInput {
   name?: string;
   driver?: 'agentcore' | 'http';
   arn?: string | null;
   endpointUrl?: string | null;
   qualifier?: string;
   region?: string | null;
   concurrencyLimit?: number | null;
   visibility?: 'private' | 'workspace';
   idleTimeoutS?: number;
   isDefault?: boolean;
   status?: 'active' | 'disabled';
}

export interface ProfileInput {
   name?: string;
   env?: Record<string, string>;
   modelDefault?: string | null;
   timeoutS?: number | null;
   maxConcurrency?: number | null;
   idleTimeoutS?: number | null;
}

export class RuntimeNotFound extends Error {}
export class RuntimeProtected extends Error {}

const COLUMNS = `r.id, r.name, r.kind, r.driver, r.arn, r.endpoint_url, r.qualifier, r.region, r.status,
   r.last_health_at, r.last_health_error, r.concurrency_limit, r.visibility, r.idle_timeout_s,
   r.max_lifetime_s, r.is_default,
   (SELECT count(*) FROM runs AS x WHERE x.runtime_id = r.id AND x.status IN ('queued', 'running'))::int AS active_runs`;

function toView(row: Record<string, unknown>): RuntimeView {
   return {
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as RuntimeView['kind'],
      driver: row.driver as RuntimeView['driver'],
      arn: (row.arn as string | null) ?? null,
      endpointUrl: (row.endpoint_url as string | null) ?? null,
      qualifier: row.qualifier as string,
      region: (row.region as string | null) ?? null,
      status: row.status as RuntimeView['status'],
      lastHealthAt: row.last_health_at ? new Date(row.last_health_at as string).toISOString() : null,
      lastHealthError: (row.last_health_error as string | null) ?? null,
      concurrencyLimit: (row.concurrency_limit as number | null) ?? null,
      visibility: row.visibility as RuntimeView['visibility'],
      idleTimeoutS: Number(row.idle_timeout_s),
      maxLifetimeS: Number(row.max_lifetime_s),
      isDefault: Boolean(row.is_default),
      activeRuns: Number(row.active_runs),
   };
}

export class RuntimeRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer | null;

   constructor(sql: Sql, sealer: Sealer | null) {
      this.#sql = sql;
      this.#sealer = sealer;
   }

   async list(workspaceId: string, viewerId: string): Promise<RuntimeView[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM agent_runtimes AS r
          WHERE r.workspace_id = ${workspaceId}
            AND (r.visibility = 'workspace' OR r.owner_id = ${viewerId})
          ORDER BY r.kind DESC, r.created_at ASC`;
      return rows.map(toView);
   }

   async get(workspaceId: string, id: string): Promise<RuntimeView> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM agent_runtimes AS r WHERE r.id = ${id} AND r.workspace_id = ${workspaceId}`;
      if (!row) throw new RuntimeNotFound();
      return toView(row);
   }

   async activity(workspaceId: string, id: string): Promise<Array<{ day: string; runs: number; failed: number }>> {
      const rows = await this.#sql`
         SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                count(*)::int AS runs, count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM runs WHERE workspace_id = ${workspaceId} AND runtime_id = ${id}
            AND created_at > now() - interval '30 days'
          GROUP BY 1 ORDER BY 1`;
      return rows.map((row) => ({ day: row.day as string, runs: Number(row.runs), failed: Number(row.failed) }));
   }

   async create(workspaceId: string, ownerId: string, input: RuntimeInput): Promise<RuntimeView> {
      const [row] = await this.#sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, arn, endpoint_url, qualifier, region,
                                     concurrency_limit, visibility, owner_id, idle_timeout_s)
         VALUES (${workspaceId}, ${input.name ?? 'Runtime'}, 'custom', ${input.driver ?? 'agentcore'},
                 ${input.arn ?? null}, ${input.endpointUrl ?? null}, ${input.qualifier ?? 'DEFAULT'},
                 ${input.region ?? null}, ${input.concurrencyLimit ?? null}, ${input.visibility ?? 'workspace'},
                 ${ownerId}, ${input.idleTimeoutS ?? 3600})
         RETURNING id`;
      return this.get(workspaceId, row!.id as string);
   }

   async update(workspaceId: string, id: string, input: RuntimeInput): Promise<RuntimeView> {
      await this.get(workspaceId, id);
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         if (input.isDefault) await tx`UPDATE agent_runtimes SET is_default = false WHERE workspace_id = ${workspaceId}`;
         await tx`
            UPDATE agent_runtimes SET
               name = COALESCE(${input.name ?? null}, name),
               arn = CASE WHEN ${input.arn !== undefined} THEN ${input.arn ?? null} ELSE arn END,
               endpoint_url = CASE WHEN ${input.endpointUrl !== undefined} THEN ${input.endpointUrl ?? null} ELSE endpoint_url END,
               qualifier = COALESCE(${input.qualifier ?? null}, qualifier),
               region = CASE WHEN ${input.region !== undefined} THEN ${input.region ?? null} ELSE region END,
               concurrency_limit = CASE WHEN ${input.concurrencyLimit !== undefined} THEN ${input.concurrencyLimit ?? null}::int ELSE concurrency_limit END,
               visibility = COALESCE(${input.visibility ?? null}, visibility),
               idle_timeout_s = COALESCE(${input.idleTimeoutS ?? null}::int, idle_timeout_s),
               is_default = COALESCE(${input.isDefault ?? null}::boolean, is_default),
               status = COALESCE(${input.status ?? null}, status),
               updated_at = now()
             WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      });
      return this.get(workspaceId, id);
   }

   async remove(workspaceId: string, id: string): Promise<void> {
      const runtime = await this.get(workspaceId, id);
      if (runtime.kind === 'platform') throw new RuntimeProtected();
      await this.#sql`DELETE FROM agent_runtimes WHERE id = ${id} AND workspace_id = ${workspaceId}`;
   }

   async recordHealth(id: string, error: string | null): Promise<void> {
      await this.#sql`
         UPDATE agent_runtimes
            SET last_health_at = now(), last_health_error = ${error},
                status = CASE WHEN status = 'disabled' THEN status WHEN ${error === null} THEN 'active' ELSE 'unreachable' END,
                updated_at = now()
          WHERE id = ${id}`;
   }

   async profiles(workspaceId: string, runtimeId: string): Promise<ProfileView[]> {
      const rows = await this.#sql`
         SELECT id, runtime_id, name, env_keys, model_default, timeout_s, max_concurrency, idle_timeout_s
           FROM runtime_profiles WHERE workspace_id = ${workspaceId} AND runtime_id = ${runtimeId} ORDER BY name`;
      return rows.map((row) => ({
         id: row.id as string,
         runtimeId: row.runtime_id as string,
         name: row.name as string,
         envKeys: (row.env_keys as string[]) ?? [],
         modelDefault: (row.model_default as string | null) ?? null,
         timeoutS: (row.timeout_s as number | null) ?? null,
         maxConcurrency: (row.max_concurrency as number | null) ?? null,
         idleTimeoutS: (row.idle_timeout_s as number | null) ?? null,
      }));
   }

   async saveProfile(workspaceId: string, runtimeId: string, profileId: string | null, input: ProfileInput): Promise<ProfileView> {
      await this.get(workspaceId, runtimeId);
      if (input.env && !this.#sealer) throw new Error('profile env needs INTEGRATION_ENCRYPTION_KEY');
      const sealed = input.env && this.#sealer ? this.#sealer.seal(JSON.stringify(input.env)) : null;
      const keys = input.env ? Object.keys(input.env).sort() : null;
      const [row] = profileId
         ? await this.#sql`
              UPDATE runtime_profiles SET
                 name = COALESCE(${input.name ?? null}, name),
                 env_sealed = CASE WHEN ${sealed !== null} THEN ${sealed} ELSE env_sealed END,
                 env_keys = COALESCE(${keys}, env_keys),
                 model_default = CASE WHEN ${input.modelDefault !== undefined} THEN ${input.modelDefault ?? null} ELSE model_default END,
                 timeout_s = CASE WHEN ${input.timeoutS !== undefined} THEN ${input.timeoutS ?? null}::int ELSE timeout_s END,
                 max_concurrency = CASE WHEN ${input.maxConcurrency !== undefined} THEN ${input.maxConcurrency ?? null}::int ELSE max_concurrency END,
                 idle_timeout_s = CASE WHEN ${input.idleTimeoutS !== undefined} THEN ${input.idleTimeoutS ?? null}::int ELSE idle_timeout_s END,
                 updated_at = now()
               WHERE id = ${profileId} AND workspace_id = ${workspaceId} AND runtime_id = ${runtimeId}
               RETURNING id`
         : await this.#sql`
              INSERT INTO runtime_profiles (workspace_id, runtime_id, name, env_sealed, env_keys, model_default,
                                            timeout_s, max_concurrency, idle_timeout_s)
              VALUES (${workspaceId}, ${runtimeId}, ${input.name ?? 'default'}, ${sealed}, ${keys ?? []},
                      ${input.modelDefault ?? null}, ${input.timeoutS ?? null}, ${input.maxConcurrency ?? null},
                      ${input.idleTimeoutS ?? null})
              RETURNING id`;
      if (!row) throw new RuntimeNotFound();
      const found = (await this.profiles(workspaceId, runtimeId)).find((profile) => profile.id === row.id);
      if (!found) throw new RuntimeNotFound();
      return found;
   }

   async removeProfile(workspaceId: string, runtimeId: string, profileId: string): Promise<void> {
      const rows = await this.#sql`
         DELETE FROM runtime_profiles WHERE id = ${profileId} AND workspace_id = ${workspaceId} AND runtime_id = ${runtimeId}
         RETURNING id`;
      if (rows.length === 0) throw new RuntimeNotFound();
   }

   async bind(workspaceId: string, runtimeId: string | null, agentId: string, profileId: string | null): Promise<void> {
      if (runtimeId) await this.get(workspaceId, runtimeId);
      if (profileId) {
         // `agents.runtime_profile_id` is a plain FK: without this check an
         // agent could be bound to another workspace's profile, and its sealed
         // env would be opened into this workspace's envelope.
         if (!runtimeId) throw new RuntimeNotFound();
         const [profile] = await this.#sql`
            SELECT 1 FROM runtime_profiles
             WHERE id = ${profileId} AND workspace_id = ${workspaceId} AND runtime_id = ${runtimeId}`;
         if (!profile) throw new RuntimeNotFound();
      }
      const rows = await this.#sql`
         UPDATE agents SET runtime_id = ${runtimeId}, runtime_profile_id = ${profileId}, updated_at = now()
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
          RETURNING id`;
      if (rows.length === 0) throw new RuntimeNotFound();
   }

   target(view: RuntimeView, fallback: RuntimeTarget | null): RuntimeTarget | null {
      if (view.kind === 'platform') return fallback ? { ...fallback, id: view.id } : null;
      return { id: view.id, driver: view.driver, arn: view.arn, qualifier: view.qualifier, region: view.region, endpointUrl: view.endpointUrl };
   }
}

/**
 * One platform runtime row per workspace, naming the deployment's own runtime.
 * Idempotent; run at boot. The row carries no target of its own — the
 * executor resolves `kind='platform'` to the configured default.
 */
export async function syncPlatformRuntime(sql: Sql, target: RuntimeTarget | null): Promise<void> {
   if (!target) return;
   await sql`
      INSERT INTO agent_runtimes (workspace_id, name, kind, driver, qualifier, region, is_default)
      SELECT w.id, 'Berry platform', 'platform', ${target.driver}, ${target.qualifier}, ${target.region},
             NOT EXISTS (SELECT 1 FROM agent_runtimes d WHERE d.workspace_id = w.id AND d.is_default)
        FROM workspaces AS w
       WHERE NOT EXISTS (SELECT 1 FROM agent_runtimes p WHERE p.workspace_id = w.id AND p.kind = 'platform')`;
}
```

`server-ts/src/mounts/runtimes.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { Sealer } from '../integrations/sealing.ts';
import { RuntimeNotFound, RuntimeProtected, RuntimeRepository } from '../runtime/runtimes.ts';
import type { RuntimeTarget } from '../runtime/transport.ts';
import { pathId, resolveScoped } from './shared.ts';

const seconds = z.number().int().min(60).max(28_800);
const runtimeBody = z.object({
   name: z.string().min(1).max(100).optional(),
   driver: z.enum(['agentcore', 'http']).optional(),
   arn: z.string().regex(/^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z0-9_-]+$/).nullable().optional(),
   endpointUrl: z.url().nullable().optional(),
   qualifier: z.string().min(1).max(100).optional(),
   region: z.string().min(1).max(40).nullable().optional(),
   concurrencyLimit: z.number().int().positive().max(1000).nullable().optional(),
   visibility: z.enum(['private', 'workspace']).optional(),
   idleTimeoutS: seconds.optional(),
   isDefault: z.boolean().optional(),
   status: z.enum(['active', 'disabled']).optional(),
});
const profileBody = z.object({
   name: z.string().min(1).max(100).optional(),
   env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(8192)).optional(),
   modelDefault: z.string().min(1).max(200).nullable().optional(),
   timeoutS: z.number().int().min(30).max(28_800).nullable().optional(),
   maxConcurrency: z.number().int().positive().max(1000).nullable().optional(),
   idleTimeoutS: seconds.nullable().optional(),
});

/** `/api/v1/runtimes`: where a workspace's agents run, and how. */
export function runtimeMounts(options: {
   sessions: SessionService;
   sql: Sql;
   sealer: Sealer | null;
   health: (target: RuntimeTarget) => Promise<void>;
   defaultTarget?: RuntimeTarget | null;
}): Mount[] {
   const repository = new RuntimeRepository(options.sql, options.sealer);
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const scope = async (userId: string, workspaceId: string | null, write: boolean) => {
      if (!workspaceId) throw ApiError.notFound('Workspace');
      return resolveScoped(options.sql, userId, workspaceId, write ? 'settings.write' : 'product.read');
   };
   const parse = async <S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> => {
      const parsed = schema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
         throw ApiError.badRequest('the request is not valid', {
            fields: parsed.error.issues.map((issue) => ({ path: `/${issue.path.join('/')}`, message: issue.message })),
         });
      }
      return parsed.data;
   };
   const guard = <T>(work: Promise<T>): Promise<T> =>
      work.catch((error: unknown) => {
         if (error instanceof RuntimeNotFound) throw ApiError.notFound('Runtime');
         if (error instanceof RuntimeProtected) throw new ApiError(409, 'RUNTIME_PROTECTED', 'the platform runtime cannot be removed');
         throw error;
      });

   route.get('/', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, false);
      return json({ nodes: await repository.list(scoped.ctx.workspaceId, user.id) });
   });

   route.post('/', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, true);
      const body = await parse(context.req.raw, runtimeBody);
      if ((body.driver ?? 'agentcore') === 'agentcore' ? !body.arn : !body.endpointUrl) {
         throw ApiError.badRequest('an agentcore runtime needs an ARN; an http runtime needs an endpoint URL');
      }
      return json(await repository.create(scoped.ctx.workspaceId, user.id, body), 201);
   });

   route.get('/:id', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, false);
      const id = pathId(context.req.param('id'), 'Runtime');
      const view = await guard(repository.get(scoped.ctx.workspaceId, id));
      return json({ ...view, activity: await repository.activity(scoped.ctx.workspaceId, id) });
   });

   route.patch('/:id', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, true);
      const id = pathId(context.req.param('id'), 'Runtime');
      return json(await guard(repository.update(scoped.ctx.workspaceId, id, await parse(context.req.raw, runtimeBody))));
   });

   route.delete('/:id', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, true);
      await guard(repository.remove(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Runtime')));
      return new Response(null, { status: 204 });
   });

   route.post('/:id/health', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, false);
      const view = await guard(repository.get(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Runtime')));
      const target = repository.target(view, options.defaultTarget ?? null);
      let error: string | null = target ? null : 'no runtime is configured behind this entry';
      if (target) {
         await options.health(target).catch((cause: unknown) => {
            error = cause instanceof Error ? cause.message : String(cause);
         });
      }
      await repository.recordHealth(view.id, error);
      return json(await repository.get(scoped.ctx.workspaceId, view.id));
   });

   route.get('/:id/profiles', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, false);
      const id = pathId(context.req.param('id'), 'Runtime');
      await guard(repository.get(scoped.ctx.workspaceId, id));
      return json({ nodes: await repository.profiles(scoped.ctx.workspaceId, id) });
   });

   route.post('/:id/profiles', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, true);
      const id = pathId(context.req.param('id'), 'Runtime');
      return json(await guard(repository.saveProfile(scoped.ctx.workspaceId, id, null, await parse(context.req.raw, profileBody))), 201);
   });

   route.patch('/:id/profiles/:profileId', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, true);
      return json(
         await guard(
            repository.saveProfile(
               scoped.ctx.workspaceId,
               pathId(context.req.param('id'), 'Runtime'),
               pathId(context.req.param('profileId'), 'Profile'),
               await parse(context.req.raw, profileBody)
            )
         )
      );
   });

   route.delete('/:id/profiles/:profileId', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, true);
      await guard(
         repository.removeProfile(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Runtime'), pathId(context.req.param('profileId'), 'Profile'))
      );
      return new Response(null, { status: 204 });
   });

   route.put('/:id/agents/:agentId', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, true);
      const body = await parse(context.req.raw, z.object({ profileId: z.uuid().nullable().optional() }));
      await guard(
         repository.bind(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Runtime'), pathId(context.req.param('agentId'), 'Agent'), body.profileId ?? null)
      );
      return new Response(null, { status: 204 });
   });

   route.delete('/:id/agents/:agentId', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user.id, user.currentWorkspaceId, true);
      await guard(repository.bind(scoped.ctx.workspaceId, null, pathId(context.req.param('agentId'), 'Agent'), null));
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/runtimes', handler: route }];
}
```

Writes require `'settings.write'`, which `identity/roles.ts` grants to owners and admins only (members and viewers get 403 from `resolveScoped`). Reads require `'product.read'`.

- [ ] **Step 5: Wire it and apply lifecycles at boot**

In `server-ts/src/index.ts`, after the executor block, add:

```ts
await syncPlatformRuntime(sql, defaultTarget).catch((error: unknown) =>
   logger.error('could not sync the platform runtime', { error: error instanceof Error ? error.message : String(error) })
);
```

and register the mount:

```ts
registry.registerAll(
   runtimeMounts({
      sessions,
      sql,
      sealer: config.integrationKey ? sealerFromKey(config.integrationKey) : null,
      defaultTarget,
      health: async (target) => {
         if (target.driver === 'http') {
            const response = await fetch(`${(target.endpointUrl ?? '').replace(/\/+$/, '')}/ping`);
            if (!response.ok) throw new Error(`the runtime answered ${response.status}`);
            return;
         }
         if (!target.arn || !config.agentCore) throw new Error('AgentCore is not configured');
         await agentCoreRuntimeDriver({
            region: target.region ?? config.agentCore.region,
            runtimeArn: target.arn,
            qualifier: target.qualifier,
            ...(config.agentCore.credentials ? { credentials: config.agentCore.credentials } : {}),
         }).health();
      },
   })
);
```

with imports `import { runtimeMounts } from './mounts/runtimes.ts';`, `import { syncPlatformRuntime } from './runtime/runtimes.ts';` and `import { agentCoreRuntimeDriver } from './execution/agentcore-runtime.ts';`. The configured default runtime's lifecycle is applied by the operator's deploy (see Step 6), not at every boot. That is because `UpdateAgentRuntime` creates a new runtime version, and doing it on each boot would churn versions.

- [ ] **Step 6: Document applying the lifecycle**

Add to `server-ts/sandbox/agentcore/Dockerfile`'s header comment, and to ADR-0014 Consequences, the command that applies the default lifecycle once per deploy:

```bash
aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id <id> \
  --lifecycle-configuration idleRuntimeSessionTimeout=3600,maxLifetime=28800 \
  --agent-runtime-artifact file://artifact.json --role-arn <role> --network-configuration networkMode=PUBLIC
```

A profile's `idleTimeoutS` is applied through `applyLifecycle` when the profile is saved on a `custom` AgentCore runtime. Wire it in `mounts/runtimes.ts`: after `saveProfile` for a runtime with `driver === 'agentcore' && arn`, call an injected `applyLifecycle?: (arn, lifecycle) => Promise<void>` option. Its failure is reported in the response as `lifecycleApplied: false` with `lifecycleError`, and it does not fail the save. In `index.ts`, pass `applyLifecycle: (arn, lifecycle) => applyLifecycle(new BedrockAgentCoreControlClient({ region: config.agentCore!.region, ...creds }), arn, lifecycle)` only when `config.agentCore` is set.

- [ ] **Step 6b: Add the mount to the cross-tenant leakage suite (spec 11)**

In `server-ts/src/mounts/cross-tenant-leakage.test.ts`:
- add `w2RuntimeId: string;` to `interface World`;
- import `runtimeMounts` from `./runtimes.ts` and register it beside the existing mount: `registry.registerAll(runtimeMounts({ sessions, sql, sealer: null, health: async () => {} }));`;
- after `world.w2Id` is set (line 120), seed W2's runtime:

```ts
         const [w2Runtime] = await sql`
            INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url)
            VALUES (${world.w2Id}, 'W2 runtime', 'custom', 'http', 'http://w2-runtime:8080')
            RETURNING id`;
         world.w2RuntimeId = w2Runtime!.id as string;
```

- add a case next to the others (rows cascade with the workspace, so the teardown needs nothing new):

```ts
      test('runtimes: W1 lists none of W2 and cannot open or change W2 runtime', async () => {
         const list = await getAsU1('/api/v1/runtimes');
         assert.equal(list.status, 200);
         assert.equal((await list.text()).includes(world.w2RuntimeId), false);
         assert.equal((await getAsU1(`/api/v1/runtimes/${world.w2RuntimeId}`)).status, 404);
         assert.equal((await patchAsU1(`/api/v1/runtimes/${world.w2RuntimeId}`, { name: 'mine' })).status, 404);
      });
```

The agent tool API (`/api/v1/agent-tools`) is task-token authenticated, not session-scoped, so its cross-tenant cases live in `runtime/agent-tools/mount.test.ts` (another workspace's agent is a 404; every tool is bound to the token's run, never to a model-supplied id).

- [ ] **Step 7: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/runtime/runtime-control.test.ts src/mounts/runtimes.test.ts src/mounts/cross-tenant-leakage.test.ts && pnpm typecheck && python3 ../scripts/check-no-model-in-server.py`
Expected: PASS; the check still exits 0 (`client-bedrock-agentcore-control` is not a model SDK).

- [ ] **Step 8: Commit**

```bash
git add server-ts/src/runtime/runtimes.ts server-ts/src/runtime/runtime-control.ts server-ts/src/runtime/runtime-control.test.ts server-ts/src/mounts/runtimes.ts server-ts/src/mounts/runtimes.test.ts server-ts/src/mounts/cross-tenant-leakage.test.ts server-ts/src/index.ts server-ts/SCOPE.md server-ts/sandbox/agentcore/Dockerfile docs/adr/0014-agentcore-runtime-control-plane.md
git commit -m "feat(server-ts): let a workspace register runtimes, profiles and agent bindings

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Frontend — Runtimes list and detail

**Files:**
- Create: `frontend/lib/runtimes.ts`
- Create: `frontend/components/common/runtimes/runtimes-list.tsx`
- Create: `frontend/components/common/runtimes/runtime-detail.tsx`
- Create: `frontend/app/[orgId]/runtimes/page.tsx`, `frontend/app/[orgId]/runtimes/[runtimeId]/page.tsx`
- Modify: `frontend/components/layout/sidebar/nav-settings.tsx` (a `runtimes` entry in the workspace group)

**Interfaces:**
- Consumes: `/api/v1/runtimes` (Task 18); `apiFetch` from `@/lib/api`; `SettingsShell`, `SettingsSection`, `SettingsCard`, `SettingsRow`, `EnabledDot` from `@/components/common/settings/shared`; `useSettingsResource` from `@/components/common/settings/use-settings-resource`; `MainLayout`; the settings `Header` from `@/components/layout/headers/settings/header`; shadcn `Button`, `Input`, `Badge`.
- Produces (Zod v3):
  - `runtimeSchema`, `type Runtime`, `type RuntimeDetail`, `type RuntimeProfile`
  - `listRuntimes(): Promise<Runtime[]>`, `getRuntime(id): Promise<RuntimeDetail>`
  - `createRuntime(input)`, `updateRuntime(id, input)`, `checkRuntimeHealth(id)`
  - `listProfiles(runtimeId)`, `createProfile(runtimeId, input)`
  - Pages at `/{orgId}/runtimes` and `/{orgId}/runtimes/{runtimeId}`.
- Usage panels (daily, by agent, by hour) belong to workstream C. The detail page renders C's `RuntimeUsagePanel` from `@/components/common/usage/runtime-usage-panel` if it exists at merge time. Otherwise it leaves the "Usage" section out; it never shows a placeholder.

- [ ] **Step 1: Write the API client**

`frontend/lib/runtimes.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';

const runtimeSchema = z.object({
   id: z.string(),
   name: z.string(),
   kind: z.enum(['platform', 'custom']),
   driver: z.enum(['agentcore', 'http']),
   arn: z.string().nullable(),
   endpointUrl: z.string().nullable(),
   qualifier: z.string(),
   region: z.string().nullable(),
   status: z.enum(['active', 'unreachable', 'disabled']),
   lastHealthAt: z.string().nullable(),
   lastHealthError: z.string().nullable(),
   concurrencyLimit: z.number().nullable(),
   visibility: z.enum(['private', 'workspace']),
   idleTimeoutS: z.number(),
   maxLifetimeS: z.number(),
   isDefault: z.boolean(),
   activeRuns: z.number(),
});

const runtimeDetailSchema = runtimeSchema.extend({
   activity: z.array(z.object({ day: z.string(), runs: z.number(), failed: z.number() })),
});

const profileSchema = z.object({
   id: z.string(),
   runtimeId: z.string(),
   name: z.string(),
   envKeys: z.array(z.string()),
   modelDefault: z.string().nullable(),
   timeoutS: z.number().nullable(),
   maxConcurrency: z.number().nullable(),
   idleTimeoutS: z.number().nullable(),
});

export type Runtime = z.infer<typeof runtimeSchema>;
export type RuntimeDetail = z.infer<typeof runtimeDetailSchema>;
export type RuntimeProfile = z.infer<typeof profileSchema>;

export interface RuntimeInput {
   name?: string;
   driver?: 'agentcore' | 'http';
   arn?: string | null;
   endpointUrl?: string | null;
   concurrencyLimit?: number | null;
   idleTimeoutS?: number;
   isDefault?: boolean;
   status?: 'active' | 'disabled';
}

export interface ProfileInput {
   name: string;
   env?: Record<string, string>;
   modelDefault?: string | null;
   idleTimeoutS?: number | null;
}

function parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} response was not recognized`);
   return parsed.data;
}

const send = (method: string, body: unknown): RequestInit => ({
   method,
   headers: { 'content-type': 'application/json' },
   body: JSON.stringify(body),
});

export async function listRuntimes(): Promise<Runtime[]> {
   return parse(z.object({ nodes: z.array(runtimeSchema) }), await apiFetch('/api/v1/runtimes'), 'Runtime list').nodes;
}

export async function getRuntime(id: string): Promise<RuntimeDetail> {
   return parse(runtimeDetailSchema, await apiFetch(`/api/v1/runtimes/${encodeURIComponent(id)}`), 'Runtime');
}

export async function createRuntime(input: RuntimeInput): Promise<Runtime> {
   return parse(runtimeSchema, await apiFetch('/api/v1/runtimes', send('POST', input)), 'Runtime');
}

export async function updateRuntime(id: string, input: RuntimeInput): Promise<Runtime> {
   return parse(runtimeSchema, await apiFetch(`/api/v1/runtimes/${encodeURIComponent(id)}`, send('PATCH', input)), 'Runtime');
}

export async function checkRuntimeHealth(id: string): Promise<Runtime> {
   return parse(runtimeSchema, await apiFetch(`/api/v1/runtimes/${encodeURIComponent(id)}/health`, send('POST', {})), 'Runtime');
}

export async function listProfiles(runtimeId: string): Promise<RuntimeProfile[]> {
   const json = await apiFetch(`/api/v1/runtimes/${encodeURIComponent(runtimeId)}/profiles`);
   return parse(z.object({ nodes: z.array(profileSchema) }), json, 'Profile list').nodes;
}

export async function createProfile(runtimeId: string, input: ProfileInput): Promise<RuntimeProfile> {
   const json = await apiFetch(`/api/v1/runtimes/${encodeURIComponent(runtimeId)}/profiles`, send('POST', input));
   return parse(profileSchema, json, 'Profile');
}

/** "1 h", "8 h", "45 min" — how the lifecycle reads to a person. */
export function formatSeconds(seconds: number): string {
   if (seconds % 3600 === 0) return `${seconds / 3600} h`;
   return `${Math.round(seconds / 60)} min`;
}
```

- [ ] **Step 2: Write the list component**

`frontend/components/common/runtimes/runtimes-list.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   SettingsCard,
   SettingsRow,
   SettingsSection,
   SettingsShell,
} from '@/components/common/settings/shared';
import { useSettingsResource } from '@/components/common/settings/use-settings-resource';
import { createRuntime, formatSeconds, listRuntimes, type Runtime } from '@/lib/runtimes';
import { Server } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Where this workspace's agents run. The platform runtime is the deployment's
 * own; an owner can register another AgentCore Runtime by ARN and bind agents
 * to it. Health is a real probe, not a cached badge.
 */
export default function RuntimesList() {
   const runtimes = useSettingsResource<Runtime[]>(listRuntimes);
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const [name, setName] = useState('');
   const [arn, setArn] = useState('');
   const [adding, setAdding] = useState(false);

   async function add() {
      setAdding(true);
      try {
         await createRuntime({ name: name.trim(), driver: 'agentcore', arn: arn.trim() });
         setName('');
         setArn('');
         runtimes.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The runtime could not be added.');
      } finally {
         setAdding(false);
      }
   }

   return (
      <SettingsShell
         title="Runtimes"
         description="Where agents run. Every task runs in an AgentCore Runtime; follow-up runs on an issue resume the same session while it is warm."
      >
         <SettingsSection title="Registered runtimes">
            <SettingsCard>
               {runtimes.error && (
                  <p className="p-4 text-sm text-destructive">{runtimes.error}</p>
               )}
               {runtimes.loading && !runtimes.value && (
                  <p className="p-4 text-sm text-muted-foreground">Loading…</p>
               )}
               {runtimes.value?.length === 0 && (
                  <p className="p-4 text-sm text-muted-foreground">
                     No runtime is configured for this deployment yet.
                  </p>
               )}
               {runtimes.value?.map((runtime) => (
                  <SettingsRow
                     key={runtime.id}
                     icon={<Server className="size-4" />}
                     title={
                        <span className="flex items-center gap-2">
                           {runtime.name}
                           {runtime.isDefault && (
                              <span className="text-xs text-muted-foreground">default</span>
                           )}
                        </span>
                     }
                     description={`${runtime.status} · ${runtime.activeRuns} active · idle ${formatSeconds(runtime.idleTimeoutS)} · life ${formatSeconds(runtime.maxLifetimeS)}`}
                     chevron
                     onClick={() => router.push(`/${orgId}/runtimes/${runtime.id}`)}
                  />
               ))}
            </SettingsCard>
         </SettingsSection>
         <SettingsSection
            title="Register an AgentCore Runtime"
            description="The runtime must run Berry's agent image. Its ARN is shown in the AgentCore console."
         >
            <SettingsCard className="flex flex-col gap-3 p-4">
               <Input
                  placeholder="Name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
               />
               <Input
                  placeholder="arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/…"
                  value={arn}
                  onChange={(event) => setArn(event.target.value)}
               />
               <div>
                  <Button
                     disabled={adding || name.trim() === '' || arn.trim() === ''}
                     onClick={() => void add()}
                  >
                     Register runtime
                  </Button>
               </div>
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
```

- [ ] **Step 3: Write the detail component**

`frontend/components/common/runtimes/runtime-detail.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   SettingsCard,
   SettingsRow,
   SettingsSection,
   SettingsShell,
} from '@/components/common/settings/shared';
import { useSettingsResource } from '@/components/common/settings/use-settings-resource';
import {
   checkRuntimeHealth,
   createProfile,
   formatSeconds,
   getRuntime,
   listProfiles,
   updateRuntime,
   type RuntimeDetail as Detail,
   type RuntimeProfile,
} from '@/lib/runtimes';
import { useState } from 'react';
import { toast } from 'sonner';

export default function RuntimeDetail({ runtimeId }: { runtimeId: string }) {
   const runtime = useSettingsResource<Detail>(() => getRuntime(runtimeId), [runtimeId]);
   const profiles = useSettingsResource<RuntimeProfile[]>(() => listProfiles(runtimeId), [runtimeId]);
   const [checking, setChecking] = useState(false);
   const [profileName, setProfileName] = useState('');
   const [idleHours, setIdleHours] = useState('1');

   async function probe() {
      setChecking(true);
      try {
         await checkRuntimeHealth(runtimeId);
         runtime.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The health check could not run.');
      } finally {
         setChecking(false);
      }
   }

   async function makeDefault() {
      try {
         await updateRuntime(runtimeId, { isDefault: true });
         runtime.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The runtime could not be updated.');
      }
   }

   async function addProfile() {
      const hours = Number(idleHours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 8) {
         toast.error('The idle timeout is between a minute and eight hours.');
         return;
      }
      try {
         await createProfile(runtimeId, {
            name: profileName.trim(),
            idleTimeoutS: Math.round(hours * 3600),
         });
         setProfileName('');
         profiles.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The profile could not be saved.');
      }
   }

   const value = runtime.value;
   const busiest = Math.max(1, ...(value?.activity ?? []).map((day) => day.runs));

   return (
      <SettingsShell
         title={value?.name ?? 'Runtime'}
         description={value?.arn ?? value?.endpointUrl ?? undefined}
      >
         {runtime.error && <p className="text-sm text-destructive">{runtime.error}</p>}
         {value && (
            <>
               <SettingsSection
                  title="Health"
                  action={
                     <Button size="sm" variant="outline" disabled={checking} onClick={() => void probe()}>
                        Check now
                     </Button>
                  }
               >
                  <SettingsCard>
                     <SettingsRow
                        title={value.status}
                        description={
                           value.lastHealthAt
                              ? `Last checked ${new Date(value.lastHealthAt).toLocaleString()}${value.lastHealthError ? ` — ${value.lastHealthError}` : ''}`
                              : 'Never checked'
                        }
                     />
                     <SettingsRow
                        title="Sessions"
                        description={`Idle sessions end after ${formatSeconds(value.idleTimeoutS)}; no session lives longer than ${formatSeconds(value.maxLifetimeS)}.`}
                     />
                     <SettingsRow
                        title="Concurrency"
                        description={`${value.activeRuns} running or claimed${value.concurrencyLimit ? ` of ${value.concurrencyLimit}` : ''}`}
                        trailing={
                           value.isDefault ? undefined : (
                              <Button size="sm" variant="ghost" onClick={() => void makeDefault()}>
                                 Make default
                              </Button>
                           )
                        }
                     />
                  </SettingsCard>
               </SettingsSection>
               <SettingsSection title="Activity" description="Tasks started on this runtime, last 30 days.">
                  <SettingsCard className="p-4">
                     {value.activity.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No tasks in the last 30 days.</p>
                     ) : (
                        <div className="flex h-24 items-end gap-1" role="img" aria-label="Tasks per day">
                           {value.activity.map((day) => (
                              <div
                                 key={day.day}
                                 title={`${day.day}: ${day.runs} tasks, ${day.failed} failed`}
                                 className="flex-1 rounded-sm bg-primary/70"
                                 style={{ height: `${(day.runs / busiest) * 100}%` }}
                              />
                           ))}
                        </div>
                     )}
                  </SettingsCard>
               </SettingsSection>
            </>
         )}
         <SettingsSection
            title="Profiles"
            description="Environment, model default and session idle timeout for agents bound to this runtime. Values are sealed and never shown again."
         >
            <SettingsCard>
               {profiles.value?.map((profile) => (
                  <SettingsRow
                     key={profile.id}
                     title={profile.name}
                     description={`${profile.envKeys.length} env vars${profile.idleTimeoutS ? ` · idle ${formatSeconds(profile.idleTimeoutS)}` : ''}${profile.modelDefault ? ` · ${profile.modelDefault}` : ''}`}
                  />
               ))}
               <div className="flex flex-wrap items-center gap-2 p-4">
                  <Input
                     className="max-w-48"
                     placeholder="Profile name"
                     value={profileName}
                     onChange={(event) => setProfileName(event.target.value)}
                  />
                  <Input
                     className="max-w-28"
                     type="number"
                     min={0.1}
                     max={8}
                     step={0.5}
                     aria-label="Idle timeout in hours"
                     value={idleHours}
                     onChange={(event) => setIdleHours(event.target.value)}
                  />
                  <Button disabled={profileName.trim() === ''} onClick={() => void addProfile()}>
                     Add profile
                  </Button>
               </div>
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
```

- [ ] **Step 4: Pages and navigation**

`frontend/app/[orgId]/runtimes/page.tsx`:

```tsx
import RuntimesList from '@/components/common/runtimes/runtimes-list';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function Page() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <RuntimesList />
      </MainLayout>
   );
}
```

`frontend/app/[orgId]/runtimes/[runtimeId]/page.tsx`:

```tsx
import RuntimeDetail from '@/components/common/runtimes/runtime-detail';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default async function Page({ params }: { params: Promise<{ runtimeId: string }> }) {
   const { runtimeId } = await params;
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <RuntimeDetail runtimeId={runtimeId} />
      </MainLayout>
   );
}
```

Check how other dynamic pages in this app take `params`. Run `sed -n 1,20p "frontend/app/[orgId]/agents/[agentId]/page.tsx"` and match its signature (a `Promise` of params in Next 15, or a plain object).

In `frontend/components/layout/sidebar/nav-settings.tsx`, add `Server` to the `lucide-react` import and this item to the `workspace` group after `agent personalization`:

```ts
         { name: 'runtimes', url: '/runtimes', icon: Server },
```

- [ ] **Step 5: Verify**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: lint clean, build succeeds. Then `pnpm dev:frontend` with the stack up, open `/{orgId}/runtimes`, confirm the platform runtime is listed, open it, press "Check now", and add a profile with an idle timeout of 2 hours.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/runtimes.ts frontend/components/common/runtimes frontend/app/\[orgId\]/runtimes frontend/components/layout/sidebar/nav-settings.tsx
git commit -m "feat(frontend): show where agents run, with health, activity and profiles

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20 (OPTIONAL — only if Tasks 1–19 are merged by day 1 noon): Claude Code on Bedrock as an agent engine

**Files:**
- Modify: `server-ts/src/runtime/envelope.ts` (`agent.engine: 'strands' | 'claude-code'`, default `'strands'`)
- Create: `server-ts/src/agents/runtime/container/claude-code-task.ts`, `claude-code-task.test.ts`
- Modify: `server-ts/src/agents/runtime/container/handler.ts` (route on `engine`)
- Modify: `server-ts/sandbox/agentcore/Dockerfile` (install the CLI)
- Create: `server-ts/migrations/054_agent_engine.up.sql`, `.down.sql`
- Modify: `server-ts/src/runtime/envelope-builder.ts` (read `agents.engine`), `server-ts/src/mounts/agents.ts` (`PUT /:agentId/config` accepts `engine`), `frontend/lib/agents.ts` + the agent config form (a select)

**Interfaces:**
- Consumes: the CLI's non-interactive mode (`claude -p <prompt> --output-format stream-json --verbose`) with `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION` set. It spends Bedrock tokens only, and the runtime's execution role supplies credentials. Run `npx -y @anthropic-ai/claude-code --help` locally before starting. Context7 or the CLI's `--help` is the source of truth for flag names.
- Produces: `runClaudeCodeTask(envelope, emit, deps: { session: LocalSession; directory: string | null; spawnCli?: (args: string[], env: Record<string,string>, cwd: string) => AsyncIterable<string> })`. It maps each stream-json line to lifecycle events:
  - `assistant` text → `task.message {kind:'output'}`
  - `tool_use` → `tool.started`
  - `tool_result` → `tool.completed`
  - the final `result` → `task.usage` (from its `usage`) plus `task.completed`, or `task.failed` when `is_error` is set.
- Constraints:
  - The CLI is installed **only in the runtime image**, never as a server dependency. `scripts/check-no-model-in-server.py` matches `package.json` deps, and the CLI is installed with `npm i -g` in the Dockerfile, not in `package.json`.
  - Warm sessions: pass `--resume <cli-session-id>`, keeping the CLI's session id in `WarmSession` (add `cliSessionId?: string`). Cold sessions: prepend the transcript to the prompt as a fenced "Earlier in this task" block.

- [ ] **Step 1: Failing test with a fake CLI stream**

`server-ts/src/agents/runtime/container/claude-code-task.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sampleEnvelope } from '../../../runtime/envelope.test.ts';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { runClaudeCodeTask } from './claude-code-task.ts';
import { LocalSession } from './local-session.ts';

const lines = [
   { type: 'system', subtype: 'init', session_id: 'cli-1' },
   { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
   { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
   { type: 'result', subtype: 'success', is_error: false, result: 'Fixed.', usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
].map((line) => JSON.stringify(line));

test('the CLI stream becomes lifecycle events, usage included', async () => {
   const events: LifecycleEvent[] = [];
   const seenEnv: Record<string, string>[] = [];
   await runClaudeCodeTask(sampleEnvelope(), (event) => events.push(event), {
      session: new LocalSession({ id: 's', root: mkdtempSync(join(tmpdir(), 'berry-cc-')) }),
      directory: null,
      region: 'us-east-1',
      spawnCli: async function* (_args, env) {
         seenEnv.push(env);
         yield* lines;
      },
   });
   assert.equal(seenEnv[0]!.CLAUDE_CODE_USE_BEDROCK, '1');
   assert.deepEqual(
      events.map((e) => (e.type === 'task.message' ? e.message.kind : e.type)),
      ['task.started', 'output', 'tool.started', 'tool.completed', 'task.usage', 'task.completed']
   );
   const usage = events.find((e) => e.type === 'task.usage');
   assert.ok(usage?.type === 'task.usage');
   assert.equal(usage.usage.cacheReadTokens, 2);
});
```

Run: `cd server-ts && node --test --experimental-strip-types src/agents/runtime/container/claude-code-task.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement `claude-code-task.ts`**

```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { Emit } from './emitter.ts';
import type { LocalSession } from './local-session.ts';

interface Deps {
   session: LocalSession;
   directory: string | null;
   region: string;
   resume?: string | undefined;
   spawnCli?: (args: string[], env: Record<string, string>, cwd: string) => AsyncIterable<string>;
}

/** Claude Code as the engine, on Bedrock through the runtime's role. Returns the CLI session id for warm resume. */
export async function runClaudeCodeTask(envelope: TaskEnvelope, emit: Emit, deps: Deps): Promise<string | null> {
   emit({ type: 'task.started' });
   const env = { ...envelope.env, CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: deps.region, ANTHROPIC_MODEL: envelope.agent.model };
   const prompt = deps.resume || envelope.transcript.length === 0
      ? envelope.task.prompt
      : `Earlier in this task:\n\n${envelope.transcript.map((m) => `${m.role}: ${m.text}`).join('\n\n')}\n\n---\n\n${envelope.task.prompt}`;
   const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--append-system-prompt', envelope.agent.instructions,
      ...(deps.resume ? ['--resume', deps.resume] : [])];
   const lines = (deps.spawnCli ?? spawnCli)(args, env, deps.directory ?? deps.session.root);
   let cliSession: string | null = null;
   let finished = false;
   try {
      for await (const line of lines) {
         let event: Record<string, unknown>;
         try {
            event = JSON.parse(line) as Record<string, unknown>;
         } catch {
            continue;
         }
         if (event.type === 'system' && typeof event.session_id === 'string') cliSession = event.session_id;
         const content = ((event.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
         for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') emit({ type: 'task.message', message: { kind: 'output', channel: 'progress', text: block.text } });
            if (block.type === 'tool_use') emit({ type: 'task.message', message: { kind: 'tool.started', toolCallId: String(block.id), name: String(block.name) } });
            if (block.type === 'tool_result') emit({ type: 'task.message', message: { kind: 'tool.completed', toolCallId: String(block.tool_use_id), succeeded: block.is_error !== true } });
         }
         if (event.type === 'result') {
            const usage = (event.usage ?? {}) as Record<string, number | undefined>;
            emit({
               type: 'task.usage',
               usage: {
                  model: envelope.agent.model,
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
               },
            });
            finished = true;
            if (event.is_error === true) {
               emit({ type: 'task.failed', failure: { code: 'ENGINE_FAILED', message: String(event.result ?? 'Claude Code reported an error'), retryable: false } });
            } else {
               emit({ type: 'task.completed', result: { text: String(event.result ?? ''), truncated: false, delivery: null } });
            }
         }
      }
      if (!finished) emit({ type: 'task.failed', failure: { code: 'ENGINE_STREAM_ENDED', message: 'Claude Code exited without a result.', retryable: true } });
   } catch (error) {
      emit({ type: 'task.failed', failure: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true } });
   }
   return cliSession;
}

async function* spawnCli(args: string[], env: Record<string, string>, cwd: string): AsyncIterable<string> {
   const child = spawn('claude', args, { cwd, env: { ...process.env, ...env } });
   yield* createInterface({ input: child.stdout });
}
```

In `handler.ts`, when `envelope.agent.engine === 'claude-code'`, call `runClaudeCodeTask` inside `registry.exclusive`. Run the repository `prepare` and `deliver` around it exactly as for Strands, and store the returned id as `cliSessionId` on the `WarmSession`. The warm case passes `resume: held.cliSessionId`.

- [ ] **Step 3: Schema, envelope, API, image, UI**

- `054_agent_engine.up.sql`: `ALTER TABLE agents ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'strands'` plus `CHECK (engine IN ('strands', 'claude-code'))` as `agents_engine_ck`. The `.down.sql` drops the column.
- `envelope.ts`: add `engine: z.enum(['strands', 'claude-code']).default('strands')` in `agent`. `envelope-builder.ts` selects `engine` in `#agent` and passes it through.
- `mounts/agents.ts` `PUT /:agentId/config`: accept an optional `engine` validated against the same enum, and store it through the existing `setConfig` (add the column to its `UPDATE`).
- `sandbox/agentcore/Dockerfile`: after the corepack line, add `RUN npm install -g @anthropic-ai/claude-code@<pinned version from npm view @anthropic-ai/claude-code version>`.
- Frontend: in `frontend/lib/agents.ts`, add `engine: z.enum(['strands', 'claude-code']).default('strands')` to `agentSchema` and `engine?: 'strands' | 'claude-code'` to `updateAgentConfig`'s input. In the agent config form, add a two-option select labelled "Engine" ("Berry agent (Strands)" / "Claude Code on Bedrock").

- [ ] **Step 4: Verify and commit**

Run: `cd server-ts && pnpm test && pnpm typecheck && python3 ../scripts/check-no-model-in-server.py && cd ../frontend && pnpm lint && pnpm build:check`
Expected: all pass.

```bash
git add -A server-ts/migrations/054_agent_engine.up.sql server-ts/migrations/054_agent_engine.down.sql server-ts/src server-ts/sandbox/agentcore/Dockerfile frontend/lib/agents.ts frontend/components
git commit -m "feat: offer Claude Code on Bedrock as an agent engine in the runtime

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (section 2 + CI check + ADR-0014):**

| Spec requirement | Task |
|---|---|
| 2.1 Strands loop in the container image from shared `src/agents/runtime` modules under strip-types | 7, 9, 12, 17 |
| 2.1 Shell/file tools local in the container (no per-command round trip) | 7 (`LocalSession`), 9, 11 |
| 2.1 No model client in the server; completion callers become `kind:'completion'` tasks | 10, 16, 17 |
| 2.1 CI check: no model SDK outside `agents/runtime/`, no provider SDK in any `package.json` | 1, 17 |
| 2.2 Envelope shape, `InvokeAgentRuntime` (not `...Command`) on the `(agent, issue)` session | 2, 13, 14 |
| 2.2 SSE lifecycle → ledger mapping; ledger stays sole writer | 2, 15 |
| 2.2 `RUNTIME_STREAM_ENDED` retryable; cancel via heartbeat → abort + `StopRuntimeSession` | 15 (dispatcher heartbeat unchanged) |
| 2.2a session id = `berry-` + sha256(agentId:issueId), chat = (agent, chatSessionId); `runtimeSessionId()` changed | 3 |
| 2.2a warm map, append to live conversation | 9 (test: warm-append) |
| 2.2a cold restore from transcript rebuilt from `run_events`/runs, window-trimmed | 9 (test: cold-restore), 14 |
| 2.2a workspace kept warm; cold re-clone + issue branch; work committed each run | 11 |
| 2.2a idle 3600 s default, per profile, max 28800; maxLifetime 28800 | 4 (CHECKs/defaults), 18 (`lifecycleFor`, `applyLifecycle`) |
| 2.2a `/ping` HealthyBusy while the loop works after the stream closed | 9 (`busy`), 12 (test) |
| 2.2a completion tasks fresh session | 3, 10, 14 (tests) |
| 2.2a `chat_sessions.active_run_id` guard | Not in A's block → handed to D (Task 5 note, open question) |
| 2.3 Berry tool API, `task_tokens` (hash, run, scopes, expiry, revoked on terminal) | 4, 6, 15 |
| 2.3 tools: read issue, sub-issues, comment, set status, attach file, project resources, mention | 6 (sub-issue tools handed to B/D) |
| 2.4 `agent_runtimes`, `runtime_profiles` (sealed env), agent binding, runtime concurrency | 4, 5, 18 |
| 2.4 Runtimes UI: list/detail, health, activity; usage by day/agent/hour | 19 (usage panels from C) |
| 2.4 optional Claude Code engine | 20 |
| 2.5 local driver runs the same image with the same contract; ScriptedModel in container tests; fake driver server-side | 12, 13, 9, 15 |
| 2.2 envelope `task.dependencies` / `task.projectResources` filled for issue tasks | 14 |
| 2.1 CI check also catches a server module loading the SDK transitively through `agents/runtime/*` | 1 (transitive rule + test), 16 (`toAgentName` moved), 17 |
| 11 isolation: `workspace_id` on new tables, cross-tenant tests for new mounts | 4, 6, 18 (runtimes.test.ts + Step 6b in cross-tenant-leakage.test.ts); profile/runtime lookups scoped by workspace in 14, 15, 18 |

**Known deviations and handoffs (not A-block gaps):**
- `chat_sessions.active_run_id` guard: D (its table, migrations 085–099), inside `enqueueTask`'s marked block.
- Sub-issue tools (`list_subtasks`, `create_subtask`): registered by B/D via `registerAgentTool` once B's parent/stage columns land. `mention_agent` records the mention but queues nothing until D's mention trigger replaces it.
- Transcript is rebuilt from `runs.prompt`/`runs.output` (the text `run_events` produced), not by replaying `run_events` rows.
- `task_tokens` expiry is the runtime's `maxLifetime` (28800 s), revoked on terminal state; the spec's "lease horizon" is read as the run's lifetime, since the 60 s dispatch lease is renewed.
- `task.usage` cache-token counts are 0 from the Strands path (the AccountingPlugin does not track them); C's cost will under-count cached tokens until it does.
- `runtime_profiles.timeout_s` / `max_concurrency` are stored and shown but not enforced; runtime-level `concurrency_limit` is.
- A run past `maxLifetime` is failed retryable by the existing sweep; nothing re-queues it automatically.
- The repository has no CI workflow; the check is enforced by `pnpm check:models` and the Definition of done.

**Placeholder scan:** the placeholder lines in Task 15 have been removed. The remaining "check with grep/sed" instructions are verification steps, each naming the exact command and the fallback to apply.

**Type consistency:**
- `LifecycleEvent`, `TaskMessage`, `TaskResult`, `TaskUsage` (Task 2) are used unchanged in 7, 9, 10, 12, 13 and 15.
- `RuntimeTarget` and `RuntimeTransport` (13) are used in 15, 16 and 18.
- `EnvelopeBuilder.build` returns `{ envelope, delivery, model }` (14), which is what 15 consumes.
- `UsageRecorder` matches C's `recordTaskUsage`.
- `enqueueTask` input matches the shared contract.
- `HandlerDeps` gains `repository` (9) and `videoOutput` (17).
- The `toConversation` move to `conversation.ts` is re-exported from `handler.ts` (Task 10 note).
