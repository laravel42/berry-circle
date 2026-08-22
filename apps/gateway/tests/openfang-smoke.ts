type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type CheckResult = {
  name: string;
  status: "pass" | "fail";
  durationMs: number;
  detail: string;
};

const baseUrl = (process.env.OPENFANG_BASE_URL ?? "http://127.0.0.1:4200").replace(/\/$/, "");
const apiKey = process.env.OPENFANG_API_KEY;
const timeoutMs = Number(process.env.OPENFANG_SMOKE_TIMEOUT_MS ?? 30_000);
const llmTimeoutMs = Number(process.env.OPENFANG_SMOKE_LLM_TIMEOUT_MS ?? 120_000);
const runId = crypto.randomUUID().slice(0, 8);
const agentName = `berry-smoke-${runId}`;
const modelProvider = process.env.OPENFANG_SMOKE_PROVIDER ?? "lmstudio";
const modelName = process.env.OPENFANG_SMOKE_MODEL ?? "lmstudio-local";

let agentId: string | undefined;
let workflowId: string | undefined;
const results: CheckResult[] = [];

function record(name: string, startedAt: number, error?: unknown) {
  const result: CheckResult = {
    name,
    status: error ? "fail" : "pass",
    durationMs: Date.now() - startedAt,
    detail: error instanceof Error ? error.message : error ? String(error) : "contract satisfied",
  };
  results.push(result);
  console.log(
    `${result.status === "pass" ? "PASS" : "FAIL"} ${name} (${result.durationMs} ms)${error ? `: ${result.detail}` : ""}`,
  );
}

async function check(name: string, action: () => Promise<void>) {
  const startedAt = Date.now();
  try {
    await action();
    record(name, startedAt);
  } catch (error) {
    record(name, startedAt, error);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: Json, label: string): Record<string, Json> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function stringField(value: Json, field: string, label: string) {
  const candidate = object(value, label)[field];
  assert(
    typeof candidate === "string" && candidate.length > 0,
    `${label}.${field} must be a non-empty string`,
  );
  return candidate;
}

async function request(
  method: string,
  path: string,
  options: { body?: Json; expected?: number; timeout?: number; accept?: string } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? timeoutMs);
  try {
    const headers = new Headers({ Accept: options.accept ?? "application/json" });
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const expected = options.expected ?? 200;
    if (response.status !== expected) {
      const responseBody = (await response.text()).slice(0, 500);
      throw new Error(
        `${method} ${path} returned ${response.status}, expected ${expected}: ${responseBody}`,
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function json(method: string, path: string, options: Parameters<typeof request>[2] = {}) {
  const response = await request(method, path, options);
  try {
    return (await response.json()) as Json;
  } catch {
    throw new Error(`${method} ${path} did not return valid JSON`);
  }
}

async function isHealthy() {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function bootStack() {
  if (await isHealthy()) {
    console.log(`Using healthy stack at ${baseUrl}`);
    return;
  }

  const composeFile = process.env.OPENFANG_SMOKE_COMPOSE_FILE;
  assert(
    composeFile,
    `OpenFang is unavailable at ${baseUrl}; set OPENFANG_SMOKE_COMPOSE_FILE to boot the pinned stack`,
  );
  const command = Bun.spawn(["docker", "compose", "-f", composeFile, "up", "-d", "--wait"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await command.exited;
  assert(exitCode === 0, `docker compose exited with status ${exitCode}`);
  assert(await isHealthy(), `stack booted but ${baseUrl}/api/health is not healthy`);
}

function manifest() {
  return [
    `name = "${agentName}"`,
    'version = "0.1.0"',
    'description = "Disposable Berry integration smoke-test agent"',
    'author = "Berry"',
    'module = "builtin:chat"',
    "",
    "[model]",
    `provider = "${modelProvider}"`,
    `model = "${modelName}"`,
    "",
    "[capabilities]",
    "tools = []",
    'memory_read = ["*"]',
    'memory_write = ["*"]',
  ].join("\n");
}

async function parseSse(response: Response) {
  assert(
    response.headers.get("content-type")?.includes("text/event-stream"),
    "stream must use text/event-stream",
  );
  const raw = await response.text();
  const events = raw
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1];
      const data = block.match(/^data:\s*(.+)$/m)?.[1];
      if (!event || !data) return undefined;
      try {
        return { event, data: JSON.parse(data) as Json };
      } catch {
        throw new Error(`SSE ${event} event contains malformed JSON`);
      }
    })
    .filter((event): event is { event: string; data: Json } => event !== undefined);
  assert(events.length > 0, "stream must contain at least one SSE event");
  const done = events.findLast((event) => event.event === "done");
  assert(
    done,
    `stream ended without done event (received: ${events.map((event) => event.event).join(", ")})`,
  );
  assert(object(done.data, "done event").done === true, "done event must contain done=true");
}

await bootStack();

await check("health", async () => {
  const body = await json("GET", "/api/health");
  assert(object(body, "health").status === "ok", "health.status must equal ok");
});

await check("agent create/list/get/update", async () => {
  const created = await json("POST", "/api/agents", {
    expected: 201,
    body: { manifest_toml: manifest() },
  });
  agentId = stringField(created, "agent_id", "created agent");
  assert(
    stringField(created, "name", "created agent") === agentName,
    "created agent name must match manifest",
  );

  const listed = await json("GET", "/api/agents");
  assert(Array.isArray(listed), "agent list must be an array");
  assert(
    listed.some((agent) => object(agent, "listed agent").id === agentId),
    "created agent must appear in list",
  );

  const fetched = await json("GET", `/api/agents/${agentId}`);
  assert(stringField(fetched, "id", "fetched agent") === agentId, "fetched agent id must match");

  const updated = await json("PUT", `/api/agents/${agentId}/update`, {
    body: { description: "Berry smoke update", tags: ["berry-smoke"] },
  });
  assert(
    object(updated, "updated agent").status === "updated",
    "agent update status must equal updated",
  );
  assert(object(updated, "updated agent").agent_id === agentId, "updated agent id must match");
});

await check("agent memory lifecycle", async () => {
  assert(agentId, "agent create check failed");
  const key = encodeURIComponent(`berry.smoke.${runId}.unicode-🍓`);
  const value = { nested: [0, false, null, "🍓"] };
  const stored = await json("PUT", `/api/memory/agents/${agentId}/kv/${key}`, { body: { value } });
  assert(
    object(stored, "stored memory").status === "stored",
    "memory store status must equal stored",
  );

  const fetched = await json("GET", `/api/memory/agents/${agentId}/kv/${key}`);
  assert(
    JSON.stringify(object(fetched, "fetched memory").value) === JSON.stringify(value),
    "memory value must round-trip exactly",
  );

  const listed = await json("GET", `/api/memory/agents/${agentId}/kv`);
  assert(
    Array.isArray(object(listed, "memory list").kv_pairs),
    "memory list.kv_pairs must be an array",
  );

  const removed = await json("DELETE", `/api/memory/agents/${agentId}/kv/${key}`);
  assert(
    object(removed, "deleted memory").status === "deleted",
    "memory delete status must equal deleted",
  );
});

await check("workflow create/list/get/update", async () => {
  assert(agentId, "agent create check failed");
  const workflow = {
    name: `berry-smoke-${runId}`,
    description: "Disposable Berry smoke workflow",
    steps: [
      {
        name: "echo",
        agent_id: agentId,
        prompt: "Reply with only: {{input}}",
        mode: "sequential",
        timeout_secs: 30,
        error_mode: "fail",
      },
    ],
  };
  const created = await json("POST", "/api/workflows", { expected: 201, body: workflow });
  workflowId = stringField(created, "workflow_id", "created workflow");

  const listed = await json("GET", "/api/workflows");
  assert(Array.isArray(listed), "workflow list must be an array");
  assert(
    listed.some((item) => object(item, "listed workflow").id === workflowId),
    "created workflow must appear in list",
  );

  const fetched = await json("GET", `/api/workflows/${workflowId}`);
  assert(object(fetched, "fetched workflow").id === workflowId, "fetched workflow id must match");

  const updated = await json("PUT", `/api/workflows/${workflowId}`, {
    body: { ...workflow, description: "Updated by Berry smoke test" },
  });
  assert(
    object(updated, "updated workflow").status === "updated",
    "workflow update status must equal updated",
  );
});

await check("models", async () => {
  const body = await json("GET", "/v1/models");
  const models = object(body, "models").data;
  assert(Array.isArray(models) && models.length > 0, "models.data must be a non-empty array");
  assert(
    models.every((model) => typeof object(model, "model").id === "string"),
    "every model must have an id",
  );
});

await check("chat completion", async () => {
  assert(agentId, "agent create check failed");
  const body = await json("POST", "/v1/chat/completions", {
    timeout: llmTimeoutMs,
    body: {
      model: agentId,
      messages: [{ role: "user", content: "Reply with the single word berry." }],
      stream: false,
    },
  });
  const root = object(body, "chat completion");
  assert(root.object === "chat.completion", "chat completion object must equal chat.completion");
  assert(
    Array.isArray(root.choices) && root.choices.length > 0,
    "chat completion choices must be non-empty",
  );
  assert(
    typeof object(object(root.choices[0], "choice").message as Json, "message").content ===
      "string",
    "assistant content must be a string",
  );
});

await check("agent SSE stream", async () => {
  assert(agentId, "agent create check failed");
  const response = await request("POST", `/api/agents/${agentId}/message/stream`, {
    timeout: llmTimeoutMs,
    accept: "text/event-stream",
    body: { message: "Reply with the single word berry." },
  });
  await parseSse(response);
});

await check("agent stop", async () => {
  assert(agentId, "agent create check failed");
  const stopped = await json("POST", `/api/agents/${agentId}/stop`);
  assert(object(stopped, "stopped agent").status === "ok", "agent stop status must equal ok");
  assert(
    typeof object(stopped, "stopped agent").message === "string",
    "agent stop message must be a string",
  );
});

await check("workflow run/history", async () => {
  assert(workflowId, "workflow create check failed");
  const run = await json("POST", `/api/workflows/${workflowId}/run`, {
    timeout: llmTimeoutMs,
    body: { input: "berry" },
  });
  stringField(run, "run_id", "workflow run");
  stringField(run, "status", "workflow run");
  const history = await json("GET", `/api/workflows/${workflowId}/runs`);
  assert(Array.isArray(history), "workflow run history must be an array");
});

await check("session/audit/usage", async () => {
  assert(agentId, "agent create check failed");
  const session = await json("GET", `/api/agents/${agentId}/session`);
  assert(
    typeof object(session, "session").message_count === "number",
    "session.message_count must be a number",
  );
  const audit = await json("GET", "/api/audit/recent");
  assert(Array.isArray(object(audit, "audit").entries), "audit.entries must be an array");
  const usage = await json("GET", "/api/usage");
  assert(Array.isArray(object(usage, "usage").agents), "usage.agents must be an array");
});

await check("cleanup", async () => {
  if (workflowId) {
    const removed = await json("DELETE", `/api/workflows/${workflowId}`);
    assert(
      object(removed, "deleted workflow").status === "removed",
      "workflow cleanup status must equal removed",
    );
    workflowId = undefined;
  }
  if (agentId) {
    const removed = await json("DELETE", `/api/agents/${agentId}`);
    assert(
      object(removed, "deleted agent").status === "killed",
      "agent cleanup status must equal killed",
    );
    agentId = undefined;
  }
});

const passed = results.filter((result) => result.status === "pass").length;
const failed = results.length - passed;
console.log(`\nOpenFang smoke result: ${passed} passed, ${failed} failed`);
console.log(JSON.stringify({ baseUrl, passed, failed, results }, null, 2));
process.exitCode = failed === 0 ? 0 : 1;
