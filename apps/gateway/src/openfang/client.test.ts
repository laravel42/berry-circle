import { describe, expect, it } from "bun:test";
import { OpenFangClient } from "~/openfang/client";
import type { OpenFangError } from "~/openfang/errors";
import type { OpenFangStreamEvent } from "~/openfang/sse";
import {
  type RecordedCall,
  jsonResponse,
  queue,
  recordingFetch,
  sseResponse,
  sseResponseWithCancelSpy,
} from "~/openfang/test-support";
import type {
  AgentDetail,
  AgentSummary,
  MessageStreamRequest,
  PatchAgentRequest,
  SpawnAgentRequest,
  WorkflowWriteRequest,
} from "~/openfang/types";

const BASE = "http://openfang.test";

function url(call: RecordedCall): URL {
  return new URL(call.url);
}

function body(call: RecordedCall): unknown {
  return JSON.parse(String(call.init.body));
}

async function captureError(action: () => Promise<unknown>): Promise<OpenFangError> {
  try {
    await action();
  } catch (error) {
    return error as OpenFangError;
  }
  throw new Error("expected the call to reject");
}

function agentSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "a1",
    name: "builder",
    state: "Running",
    mode: "full",
    created_at: "2026-08-22T06:30:00Z",
    last_active: "2026-08-22T06:31:00Z",
    model_provider: "vllm",
    model_name: "Qwen/Qwen3-Coder",
    model_tier: "unknown",
    auth_status: "ok",
    ready: true,
    is_inferencing: false,
    profile: null,
    identity: { emoji: null, avatar_url: null, color: null },
    ...overrides,
  };
}

function agentDetail(): AgentDetail {
  return {
    id: "a1",
    name: "builder",
    state: "Running",
    mode: "full",
    profile: null,
    created_at: "2026-08-22T06:30:00Z",
    session_id: "s1",
    model: { provider: "vllm", model: "Qwen/Qwen3-Coder" },
    capabilities: { tools: ["file_read"], network: [] },
    description: "Implements scoped changes",
    system_prompt: "Follow the repository conventions.",
    tags: ["engineering"],
    identity: {
      emoji: null,
      avatar_url: null,
      color: null,
      archetype: null,
      vibe: null,
      greeting_style: null,
    },
    skills: [],
    skills_mode: "all",
    mcp_servers: [],
    mcp_servers_mode: "all",
    fallback_models: [],
  };
}

describe("request construction", () => {
  it("builds the agent-detail GET path", async () => {
    const { fetch, calls } = recordingFetch(queue(jsonResponse(200, agentDetail())));
    await new OpenFangClient({ baseUrl: BASE, fetch }).getAgent("a1");
    expect(calls[0].init.method).toBe("GET");
    expect(url(calls[0]).pathname).toBe("/api/agents/a1");
  });

  it("encodes the audit count query and omits it when absent", async () => {
    const page = { entries: [], total: 0, tip_hash: null };
    const withCount = recordingFetch(queue(jsonResponse(200, page)));
    await new OpenFangClient({ baseUrl: BASE, fetch: withCount.fetch }).getRecentAudit(100);
    expect(url(withCount.calls[0]).search).toBe("?n=100");

    const noCount = recordingFetch(queue(jsonResponse(200, page)));
    await new OpenFangClient({ baseUrl: BASE, fetch: noCount.fetch }).getRecentAudit();
    expect(url(noCount.calls[0]).search).toBe("");
  });

  it("wraps memory writes in an explicit { value } envelope", async () => {
    const { fetch, calls } = recordingFetch(
      queue(jsonResponse(200, { status: "stored", key: "k" })),
    );
    await new OpenFangClient({ baseUrl: BASE, fetch }).putMemory("a1", "pref", { tone: "brief" });
    expect(calls[0].init.method).toBe("PUT");
    expect(body(calls[0])).toEqual({ value: { tone: "brief" } });
  });

  it("percent-encodes memory keys in the path", async () => {
    const key = "berry:ws:agent:pref 🍓";
    const { fetch, calls } = recordingFetch(queue(jsonResponse(200, { key, value: 1 })));
    await new OpenFangClient({ baseUrl: BASE, fetch }).getMemory("a1", key);
    expect(url(calls[0]).pathname).toBe(`/api/memory/agents/a1/kv/${encodeURIComponent(key)}`);
  });

  it("fills every documented workflow-step default before dispatch", async () => {
    const { fetch, calls } = recordingFetch(queue(jsonResponse(201, { workflow_id: "w1" })));
    await new OpenFangClient({ baseUrl: BASE, fetch }).createWorkflow({
      name: "wf",
      steps: [{ agent_id: "a1" }],
    });
    expect(body(calls[0])).toEqual({
      name: "wf",
      description: "",
      steps: [
        {
          name: "step",
          agent_id: "a1",
          prompt: "{{input}}",
          mode: "sequential",
          condition: "",
          max_iterations: 5,
          until: "",
          timeout_secs: 120,
          error_mode: "fail",
          max_retries: 3,
        },
      ],
    });
  });
});

describe("request validation (pre-flight, no dispatch)", () => {
  it("rejects unknown agent-patch fields via the allowlist", async () => {
    const { fetch, calls } = recordingFetch(queue());
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const err = await captureError(() =>
      client.patchAgent("a1", { bogus: "x" } as unknown as PatchAgentRequest),
    );
    expect(err.code).toBe("INVALID_REQUEST");
    expect(calls).toHaveLength(0);
  });

  it("rejects an agent patch with provider but no model", async () => {
    const { fetch } = recordingFetch(queue());
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const err = await captureError(() => client.patchAgent("a1", { provider: "vllm" }));
    expect(err.code).toBe("INVALID_REQUEST");
  });

  it("rejects an empty agent patch", async () => {
    const { fetch } = recordingFetch(queue());
    const err = await captureError(() =>
      new OpenFangClient({ baseUrl: BASE, fetch }).patchAgent("a1", {}),
    );
    expect(err.code).toBe("INVALID_REQUEST");
  });

  it("rejects a spawn with neither manifest nor template", async () => {
    const { fetch } = recordingFetch(queue());
    const err = await captureError(() =>
      new OpenFangClient({ baseUrl: BASE, fetch }).spawnAgent({} as SpawnAgentRequest),
    );
    expect(err.code).toBe("INVALID_REQUEST");
  });

  it("rejects a workflow with no steps", async () => {
    const { fetch } = recordingFetch(queue());
    const err = await captureError(() =>
      new OpenFangClient({ baseUrl: BASE, fetch }).createWorkflow({
        name: "wf",
        steps: [],
      } as WorkflowWriteRequest),
    );
    expect(err.code).toBe("INVALID_REQUEST");
  });

  it("rejects a stream message over 64 KiB before dispatch", async () => {
    const { fetch, calls } = recordingFetch(queue());
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const oversized: MessageStreamRequest = { message: "a".repeat(65 * 1024) };
    const err = await captureError(async () => {
      for await (const _ of client.streamAgentMessage("a1", oversized)) {
        // no-op; validation throws before any event is produced
      }
    });
    expect(err.code).toBe("INVALID_REQUEST");
    expect(calls).toHaveLength(0);
  });
});

describe("response validation", () => {
  it("preserves upstream state casing on a valid list", async () => {
    const { fetch } = recordingFetch(
      queue(jsonResponse(200, [agentSummary({ state: "Suspended" })])),
    );
    const agents = await new OpenFangClient({ baseUrl: BASE, fetch }).listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].state).toBe("Suspended");
  });

  it("rejects an upstream response that violates the contract shape", async () => {
    const { fetch } = recordingFetch(queue(jsonResponse(200, { id: "a1" })));
    const err = await captureError(() =>
      new OpenFangClient({ baseUrl: BASE, fetch }).getAgent("a1"),
    );
    expect(err.code).toBe("UPSTREAM_INVALID_RESPONSE");
  });
});

describe("streaming", () => {
  async function collect(client: OpenFangClient): Promise<OpenFangStreamEvent[]> {
    const events: OpenFangStreamEvent[] = [];
    for await (const event of client.streamAgentMessage("a1", { message: "hi" })) {
      events.push(event);
    }
    return events;
  }

  it("dispatches to the message/stream path and yields typed events", async () => {
    const { fetch, calls } = recordingFetch(
      queue(
        sseResponse([
          'event: chunk\ndata: {"content":"berry"}\n\n',
          'event: done\ndata: {"usage":{"input_tokens":4,"output_tokens":1}}\n\n',
        ]),
      ),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const events = await collect(client);
    expect(url(calls[0]).pathname).toBe("/api/agents/a1/message/stream");
    expect(new Headers(calls[0].init.headers).get("accept")).toBe("text/event-stream");
    expect(events).toEqual([
      { type: "chunk", content: "berry" },
      { type: "done", usage: { input_tokens: 4, output_tokens: 1 } },
    ]);
  });

  it("propagates STREAM_INTERRUPTED when the stream ends before done", async () => {
    const { fetch } = recordingFetch(
      queue(sseResponse(['event: chunk\ndata: {"content":"partial"}\n\n'])),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const err = await captureError(() => collect(client));
    expect(err.code).toBe("STREAM_INTERRUPTED");
  });

  it("cancels the upstream body when the consumer breaks early (downstream disconnect)", async () => {
    const spy = sseResponseWithCancelSpy(['event: chunk\ndata: {"content":"one"}\n\n']);
    const { fetch } = recordingFetch(queue(spy.response));
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    for await (const _event of client.streamAgentMessage("a1", { message: "hi" })) {
      break; // consumer hangs up mid-run
    }
    expect(spy.cancelled()).toBe(true);
  });

  it("cancels the upstream body on a mid-stream interruption", async () => {
    const spy = sseResponseWithCancelSpy([
      'event: chunk\ndata: {"content":"ok"}\n\nevent: chunk\ndata: {bad json}\n\n',
    ]);
    const { fetch } = recordingFetch(queue(spy.response));
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const err = await captureError(() => collect(client));
    expect(err.code).toBe("STREAM_INTERRUPTED");
    expect(spy.cancelled()).toBe(true);
  });
});

describe("workflow run reconciliation", () => {
  it("accepts an unknown run state instead of dropping the whole page", async () => {
    const { fetch } = recordingFetch(
      queue(
        jsonResponse(200, [
          {
            id: "r1",
            workflow_name: "wf",
            state: "cancelling", // not one of the four documented states
            steps_completed: 1,
            started_at: "2026-08-22T06:30:00Z",
            completed_at: null,
          },
        ]),
      ),
    );
    const runs = await new OpenFangClient({ baseUrl: BASE, fetch }).listWorkflowRuns("w1");
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("cancelling");
  });
});
